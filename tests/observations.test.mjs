// The observed-conditions archive: the pipeline write endpoint, the retention (prune) rules and the
// public reads, run against a real SQLite engine behind a small D1-style adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const tmp = path.join(os.tmpdir(), `ub-obs-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const schema = fs.readFileSync(new URL("../schema-v2.sql", import.meta.url), "utf8");
const archiveTables = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS observations"));

/** A fresh in-memory database with the archive tables and a minimal marks table. */
function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE marks (id TEXT PRIMARY KEY, type TEXT, date_time TEXT);");
  sqlite.exec(archiveTables);
  const d1 = {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) {
          args = a;
          return stmt;
        },
        async first() {
          return sqlite.prepare(sql).get(...args) || null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...args) };
        },
        async run() {
          const r = sqlite.prepare(sql).run(...args);
          return { meta: { changes: Number(r.changes) } };
        },
        _run: () => sqlite.prepare(sql).run(...args),
      };
      return stmt;
    },
    async batch(stmts) {
      return stmts.map((s) => ({ meta: { changes: Number(s._run().changes) } }));
    },
  };
  return { sqlite, env: { ALLOWED_ORIGIN: "https://site.example", PIPELINE_API_TOKEN: "secret", DB: d1 } };
}

const call = (env, method, p, { token = "secret", body } = {}) =>
  worker.fetch(
    new Request("https://worker.example" + p, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { "X-Pipeline-Token": token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env
  );

const ASOF = "2026-09-21 10:20:00";
const post = (env, body, opts) => call(env, "POST", "/api/pipeline/observations", { body: { location: "Flinders", asOf: ASOF, ...body }, ...opts });

test("writes need the pipeline token", async () => {
  const { env } = makeDb();
  assert.equal((await post(env, { observations: [] }, { token: "wrong" })).status, 401);
  assert.equal((await post(env, { observations: [] }, { token: null })).status, 401);
  assert.equal((await call(env, "POST", "/api/pipeline/observations/prune", { token: "wrong", body: { asOf: ASOF } })).status, 401);
});

test("completed hours are stored; the current, partial hour is not", async () => {
  const { env, sqlite } = makeDb();
  const r = await post(env, {
    observations: [
      { hour: "2026-09-21 08:00", tempC: 12.5, windKmh: 14, windDir: "SSW" },
      { hour: "2026-09-21 09:00", tempC: 13, windKmh: 16, windDir: "SW" },
      { hour: "2026-09-21 10:00", tempC: 14, windKmh: 18, windDir: "W" }, // the hour still in progress at 10:20
    ],
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.observationsWritten, 2);
  assert.equal(body.skipped, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM observations").get().n, 2);
});

test("bad rows are skipped: wrong hour format, out-of-range values, hours with nothing in them", async () => {
  const { env, sqlite } = makeDb();
  const r = await (
    await post(env, {
      observations: [
        { hour: "2026-09-21 08:30", tempC: 12 }, // not on the hour
        { hour: "2026-09-21 07:00", tempC: 999 }, // impossible, and nothing else in the row
        { hour: "2026-09-21 06:00", windDir: "up" }, // not a compass point
        { hour: "2026-09-21 05:00", tempC: 11 }, // fine
      ],
      tideEvents: [
        { time: "2026-09-21 03:10:00", type: "sideways", heightM: 1 },
        { time: "2026-09-21 03:10:00", type: "high", heightM: 1.8 },
      ],
    })
  ).json();
  assert.equal(r.observationsWritten, 1);
  assert.equal(r.tideEventsWritten, 1);
  assert.equal(r.skipped, 4);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM observations").get().n, 1);
});

test("re-sending the same run writes nothing new", async () => {
  const { env } = makeDb();
  const payload = {
    observations: [{ hour: "2026-09-21 08:00", tempC: 12, windKmh: 10, windDir: "N", pressureHpa: 1015 }],
    tideEvents: [{ time: "2026-09-21 14:30:00", type: "high", heightM: 1.7 }],
  };
  const first = await (await post(env, payload)).json();
  assert.equal(first.observationsWritten + first.tideEventsWritten, 2);
  const again = await (await post(env, payload)).json();
  assert.equal(again.observationsWritten, 0);
  assert.equal(again.tideEventsWritten, 0);
});

test("an existing hour is only filled in where a column is empty, never overwritten", async () => {
  const { env, sqlite } = makeDb();
  await post(env, { observations: [{ hour: "2026-09-21 08:00", tempC: 12, windKmh: 10, windDir: "N" }] });
  const later = await (
    await post(env, { observations: [{ hour: "2026-09-21 08:00", tempC: 39, windKmh: 30, pressureHpa: 1013, waterTempC: 14.1 }] })
  ).json();
  assert.equal(later.observationsWritten, 1); // the pressure and sea temperature arrived late
  const row = sqlite.prepare("SELECT * FROM observations").get();
  assert.equal(row.temp_c, 12); // the station's own reading is kept
  assert.equal(row.wind_kmh, 10);
  assert.equal(row.pressure_hpa, 1013);
  assert.equal(row.water_temp_c, 14.1);
});

test("a tide event still ahead follows the latest prediction; one that has passed is frozen", async () => {
  const { env, sqlite } = makeDb();
  await post(env, { tideEvents: [{ time: "2026-09-21 08:05:00", type: "low", heightM: 0.4 }, { time: "2026-09-21 14:30:00", type: "high", heightM: 1.7 }] });
  const r = await (
    await post(env, { tideEvents: [{ time: "2026-09-21 08:05:00", type: "low", heightM: 0.5 }, { time: "2026-09-21 14:30:00", type: "high", heightM: 1.75 }] })
  ).json();
  assert.equal(r.tideEventsWritten, 1); // only the 14:30 event is after "now" (10:20)
  const rows = Object.fromEntries(sqlite.prepare("SELECT event_time, height_m FROM tide_events").all().map((x) => [x.event_time, x.height_m]));
  assert.equal(rows["2026-09-21 08:05:00"], 0.4);
  assert.equal(rows["2026-09-21 14:30:00"], 1.75);
});

// --- retention -----------------------------------------------------------

/** Fills the archive with an hourly row every 6 hours from 2026-08-01 to 2026-09-20 and a tide event each, for one location. */
function seedHistory(sqlite) {
  const ins = sqlite.prepare("INSERT INTO observations (location_name, hour, temp_c) VALUES ('Flinders', ?, 10)");
  const ev = sqlite.prepare("INSERT INTO tide_events (location_name, event_time, type, height_m) VALUES ('Flinders', ?, 'high', 1.5)");
  for (let t = Date.UTC(2026, 7, 1); t < Date.UTC(2026, 8, 21); t += 6 * 3600000) {
    const iso = new Date(t).toISOString();
    ins.run(iso.slice(0, 10) + " " + iso.slice(11, 13) + ":00");
    ev.run(iso.slice(0, 10) + " " + iso.slice(11, 13) + ":30:00");
  }
}
const prune = (env, body) => call(env, "POST", "/api/pipeline/observations/prune", { body: { asOf: ASOF, ...body } });

test("prune keeps the last month, and only the 12 hours around a session before that", async () => {
  const { env, sqlite } = makeDb();
  seedHistory(sqlite);
  // a session on 2026-08-10, 09:00-11:00 (start and end marks); a much newer one that changes nothing
  sqlite.prepare("INSERT INTO marks VALUES ('s', 'Session', '2026-08-10 09:00:00'), ('e', 'Session', '2026-08-10 11:00:00'), ('c', 'Catch', '2026-08-03 12:00:00')").run();
  const total = sqlite.prepare("SELECT COUNT(*) AS n FROM observations").get().n;
  const dry = await (await prune(env, { mode: "dry" })).json();
  assert.equal(dry.mode, "dry");
  assert.ok(dry.observations > 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM observations").get().n, total, "a dry run deletes nothing");

  const ran = await (await prune(env, { mode: "run" })).json();
  assert.equal(ran.observations, dry.observations);
  const kept = sqlite.prepare("SELECT hour FROM observations ORDER BY hour").all().map((r) => r.hour);
  // cutoff is 2026-08-22 10:20: everything from then on stays
  assert.ok(kept.includes("2026-08-25 00:00"));
  assert.ok(kept.includes("2026-09-20 18:00"));
  // older rows survive only within 12 h of the session's start (09:00) or end (11:00): 08-09 21:00 .. 08-10 23:00
  const oldKept = kept.filter((h) => h < "2026-08-22");
  assert.deepEqual(oldKept, ["2026-08-10 00:00", "2026-08-10 06:00", "2026-08-10 12:00", "2026-08-10 18:00"]);
  assert.ok(!kept.includes("2026-08-03 12:00"), "a catch is not a session");
  const tideKept = sqlite.prepare("SELECT event_time FROM tide_events WHERE event_time < '2026-08-22' ORDER BY event_time").all().map((r) => r.event_time);
  assert.deepEqual(tideKept, ["2026-08-10 00:30:00", "2026-08-10 06:30:00", "2026-08-10 12:30:00", "2026-08-10 18:30:00"]);
});

test("prune with no sessions keeps the last month and removes older rows; dry mode is the default", async () => {
  const { env, sqlite } = makeDb();
  seedHistory(sqlite);
  const total = sqlite.prepare("SELECT COUNT(*) AS n FROM observations").get().n;
  const result = await (await prune(env, {})).json(); // no mode given
  assert.equal(result.mode, "dry");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM observations").get().n, total);
  await prune(env, { mode: "run" });
  const minKept = sqlite.prepare("SELECT MIN(hour) AS h FROM observations").get().h;
  assert.ok(minKept >= "2026-08-22", `oldest kept is ${minKept}`);
});

test("prune needs a valid asOf and a sane retention", async () => {
  const { env } = makeDb();
  assert.equal((await call(env, "POST", "/api/pipeline/observations/prune", { body: {} })).status, 400);
  const odd = await (await prune(env, { keepDays: 1, windowHours: 1 })).json(); // too small: falls back to 30 days / 12 hours
  assert.equal(odd.keepDays, 30);
  assert.equal(odd.windowHours, 12);
});

// --- public reads ---------------------------------------------------------

test("stored observations and tide events are readable by anyone, by location and date range", async () => {
  const { env } = makeDb();
  await post(env, {
    observations: [
      { hour: "2026-09-21 06:00", tempC: 11, windKmh: 12, windDir: "SW", pressureHpa: 1012, currentKmh: 1.2, currentDir: 90 },
      { hour: "2026-09-21 07:00", tempC: 12, windKmh: 15, windDir: "SW" },
      { hour: "2026-09-21 08:00", tempC: 13, windKmh: 20, windDir: "W" },
    ],
    tideEvents: [
      { time: "2026-09-21 05:10:00", type: "low", heightM: 0.3 },
      { time: "2026-09-21 11:20:00", type: "high", heightM: 1.9 },
    ],
  });
  const obs = await call(env, "GET", "/api/public/observations?location=Flinders&from=2026-09-21T06:30:00&to=2026-09-21T08:00:00", { token: null });
  assert.equal(obs.status, 200);
  assert.equal(obs.headers.get("access-control-allow-origin"), "*");
  const rows = await obs.json();
  assert.deepEqual(rows.map((r) => r.hour), ["2026-09-21 06:00", "2026-09-21 07:00", "2026-09-21 08:00"]); // from is rounded down to its hour
  assert.equal(rows[0].windDir, "SW");
  assert.equal(rows[0].currentKmh, 1.2);
  const tides = await (await call(env, "GET", "/api/public/tide-events?location=Flinders&from=2026-09-21&to=2026-09-21T12:00:00", { token: null })).json();
  assert.deepEqual(tides, [
    { time: "2026-09-21 05:10:00", type: "low", heightM: 0.3 },
    { time: "2026-09-21 11:20:00", type: "high", heightM: 1.9 },
  ]);
  const other = await (await call(env, "GET", "/api/public/observations?location=Rye&from=2026-09-21&to=2026-09-22", { token: null })).json();
  assert.deepEqual(other, []);
  assert.equal((await call(env, "GET", "/api/public/observations?location=Flinders", { token: null })).status, 400);
});

// --- the admin's Session Ribbon saving what it looked up live (POST /api/archive/lookups) ---
const SITE = "https://site.example";
function withUsers(env, sqlite) {
  sqlite.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, email TEXT); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER);");
  const future = Date.now() + 3600000;
  sqlite.prepare("INSERT INTO users VALUES ('u1', 'basic', 'a@x'), ('admin1', 'admin', 'o@x')").run();
  sqlite.prepare("INSERT INTO sessions VALUES ('s-u1', 'u1', ?), ('s-admin', 'admin1', ?)").run(future, future);
  return env;
}
const lookup = (env, session, body, origin = SITE) =>
  worker.fetch(
    new Request("https://worker.example/api/archive/lookups", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...(session ? { Cookie: `session=${session}` } : {}) },
      body: JSON.stringify(body),
    }),
    env
  );
const oldHours = [{ hour: "2026-08-01 08:00", tempC: 11, windKmh: 12, windDir: "SW" }];

test("only a signed-in admin can save ribbon lookups; the pipeline token is not accepted there", async () => {
  const { env, sqlite } = makeDb();
  withUsers(env, sqlite);
  const body = { location: "Flinders", observations: oldHours };
  assert.equal((await lookup(env, null, body)).status, 401);
  assert.equal((await lookup(env, "s-u1", body)).status, 403);
  assert.equal((await lookup(env, "s-admin", body, "https://evil.example")).status, 403); // cross-site
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM observations").get().n, 0);
  const ok = await lookup(env, "s-admin", body);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).observationsWritten, 1);
});

test("saved lookups are readable through the public archive, never overwrite, and follow the same rules as the pipeline", async () => {
  const { env, sqlite } = makeDb();
  withUsers(env, sqlite);
  sqlite.prepare("INSERT INTO observations (location_name, hour, wind_kmh) VALUES ('Flinders', '2026-08-01 08:00', 30)").run();
  const future = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 13).replace("T", " ") + ":00";
  const r = await (
    await lookup(env, "s-admin", {
      location: "Flinders",
      observations: [...oldHours, { hour: future, tempC: 20 }], // an hour that hasn't happened: refused
      tideEvents: [{ time: "2026-08-01 05:10:00", type: "high", heightM: 1.9 }],
    })
  ).json();
  assert.equal(r.observationsWritten, 1); // the empty temp/dir columns filled in ...
  assert.equal(sqlite.prepare("SELECT wind_kmh, temp_c, wind_dir FROM observations WHERE hour = '2026-08-01 08:00'").get().wind_kmh, 30); // ... the existing wind not replaced
  assert.equal(sqlite.prepare("SELECT temp_c FROM observations WHERE hour = '2026-08-01 08:00'").get().temp_c, 11);
  assert.equal(r.skipped, 1);
  assert.equal(r.tideEventsWritten, 1);
  const pub = await (await worker.fetch(new Request("https://worker.example/api/public/tide-events?location=Flinders&from=2026-08-01%2000:00:00&to=2026-08-02%2000:00:00"), env)).json();
  assert.equal(JSON.stringify(pub).includes("1.9"), true);
  // sending the same lookup again changes nothing
  const again = await (await lookup(env, "s-admin", { location: "Flinders", observations: oldHours, tideEvents: [{ time: "2026-08-01 05:10:00", type: "high", heightM: 1.9 }] })).json();
  assert.equal(again.observationsWritten + again.tideEventsWritten, 0);
});
