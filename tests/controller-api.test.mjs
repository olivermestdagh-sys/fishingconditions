// The Fishing Controller API (/api/controller/*), run against a real SQLite engine behind a small D1-style adapter:
// device tokens, the config the phone app pushes to the controller, and the events it sends back (idempotent, turned into the
// same marks the Live page makes).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const tmp = path.join(os.tmpdir(), `ub-controller-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const schema = fs.readFileSync(new URL("../schema-v2.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const table = (name) => {
  const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\)[^;]*;`).exec(schema);
  assert.ok(m, `table ${name} not in schema-v2.sql`);
  return m[0];
};

const SITE = "https://site.example";
const NOW = Date.now();

function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, email TEXT, name TEXT);");
  sqlite.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER);");
  for (const t of ["user_prefs", "user_mark_lists", "user_rod_setups", "user_trip_setups", "user_trip_actions", "marks", "controller_tokens", "controller_events"]) sqlite.exec(table(t));
  sqlite.prepare("INSERT INTO users VALUES ('u1', 'basic', 'a@x', 'A'), ('u2', 'basic', 'b@x', 'B'), ('public', 'public', 'p@x', 'Public')").run();
  sqlite.prepare("INSERT INTO sessions VALUES ('s-u1', 'u1', ?), ('s-u2', 'u2', ?)").run(NOW + 3600000, NOW + 3600000);
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
          return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } };
        },
        _run: () => sqlite.prepare(sql).run(...args),
      };
      return stmt;
    },
    async batch(stmts) {
      sqlite.exec("BEGIN");
      try {
        const out = stmts.map((s) => ({ meta: { changes: Number(s._run().changes) } }));
        sqlite.exec("COMMIT");
        return out;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
  };
  return { sqlite, env: { ALLOWED_ORIGIN: SITE, DB: d1 } };
}

/** A user with a trip "Estuary" (actions Drift and Anchor), two rod setups, species lists (one Public) and a device token. */
async function seeded() {
  const { sqlite, env } = makeDb();
  const ins = (sql, ...a) => sqlite.prepare(sql).run(...a);
  ins("INSERT INTO user_rod_setups (id, user_id, name, rod, rig, sub_list_items, created_at) VALUES ('r1', 'u1', 'Light', 'L Wilson', 'Paternoster', NULL, 1), ('r2', 'u1', 'Lure', 'L Raider', 'Jig Head', '[\"Vibe\"]', 1)");
  ins("INSERT INTO user_trip_setups (id, user_id, name, created_at) VALUES ('t1', 'u1', 'Estuary', 1), ('t2', 'u1', 'Offshore', 1), ('tx', 'u2', 'Someone else', 1)");
  ins(
    "INSERT INTO user_trip_actions (id, user_id, trip_id, name, fishing_method, berley, bait, rod_setup_ids, species, created_at) VALUES " +
      "('a1', 'u1', 't1', 'Drift', '[\"Drifting\"]', 'Pilchard Mix', '[\"Prawn\"]', '[\"r1\",\"r2\"]', '[\"Bream\"]', 1)," +
      "('a2', 'u1', 't1', 'Anchor', '[]', NULL, '[]', '[\"r1\"]', '[\"Flathead\"]', 1)," +
      "('ax', 'u2', 'tx', 'Not mine', '[]', NULL, '[]', '[]', '[]', 1)"
  );
  ins("INSERT INTO user_mark_lists (id, user_id, field, value, created_at, min_size) VALUES ('s1', 'u1', 'Species', 'Bream', 1, 25), ('s2', 'public', 'Species', 'Flathead', 1, NULL), ('s3', 'public', 'Species', 'Snapper', 1, NULL), ('b1', 'public', 'Berley', 'Pilchard Mix', 1, NULL), ('x1', 'u2', 'Species', 'Secret', 1, NULL)");
  const created = await worker.fetch(
    new Request("https://worker.example/api/controller/tokens", { method: "POST", headers: { "Content-Type": "application/json", Origin: SITE, Cookie: "session=s-u1" }, body: JSON.stringify({ name: "Test controller" }) }),
    env
  );
  assert.equal(created.status, 201);
  const { token } = await created.json();
  return { sqlite, env, token };
}

const api = (env, token, method, p, body, headers = {}) =>
  worker.fetch(
    new Request(`https://worker.example${p}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env
  );
const site = (env, method, p, body, session = "s-u1") => api(env, null, method, p, body, { Origin: SITE, Cookie: `session=${session}` });

// 2026-10-02 00:00:00 UTC; with a UTC+10 clock that is 10:00:00 local
const T0 = Date.UTC(2026, 9, 2, 0, 0, 0) / 1000;
const ev = (seq, type, extra = {}) => ({ deviceId: "fishctl-01", seq, type, ts: T0 + seq * 60, tzOffsetMin: 600, lat: -38.1, lng: 145.2, ...extra });
const send = async (env, token, events) => {
  const res = await api(env, token, "POST", "/api/controller/events", { events });
  assert.equal(res.status, 200);
  return (await res.json()).results;
};
const marks = (sqlite, where = "1=1") => sqlite.prepare(`SELECT * FROM marks WHERE ${where} ORDER BY date_time, type DESC`).all();
const stateOf = (sqlite) => JSON.parse(sqlite.prepare("SELECT value FROM user_prefs WHERE user_id = 'u1' AND key = 'liveActiveTrip'").get().value);

test("tokens: created from Settings, shown once, listed without the secret, revocable", async () => {
  const { sqlite, env, token } = await seeded();
  assert.match(token, /^fc_[A-Za-z0-9_-]{40,}$/);
  const stored = sqlite.prepare("SELECT token_hash FROM controller_tokens").get().token_hash;
  assert.notEqual(stored, token, "only a hash is stored");
  assert.match(stored, /^[0-9a-f]{64}$/);

  const list = await (await site(env, "GET", "/api/controller/tokens")).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "Test controller");
  assert.equal(JSON.stringify(list).includes(token), false);
  assert.equal((await site(env, "GET", "/api/controller/tokens", undefined, "s-u2").then((r) => r.json())).length, 0, "someone else's tokens are not yours");

  assert.equal((await api(env, token, "GET", "/api/controller/state")).status, 200);
  assert.equal((await site(env, "DELETE", `/api/controller/tokens/${list[0].id}`)).status, 204);
  assert.equal((await api(env, token, "GET", "/api/controller/state")).status, 401, "revoked");
  assert.ok((await site(env, "GET", "/api/controller/tokens").then((r) => r.json()))[0].revokedAt);
});

test("tokens: only valid on /api/controller/*, never as a session; token management needs the site's own origin and a name", async () => {
  const { env, token } = await seeded();
  assert.equal((await api(env, token, "GET", "/api/prefs")).status, 401, "a device token is not a session");
  assert.equal((await api(env, "fc_nonsense", "GET", "/api/controller/config")).status, 401);
  assert.equal((await api(env, null, "GET", "/api/controller/config")).status, 401);
  assert.equal((await api(env, null, "POST", "/api/controller/tokens", { name: "x" }, { Cookie: "session=s-u1" })).status, 403, "no Origin: blocked by the CSRF guard");
  assert.equal((await site(env, "POST", "/api/controller/tokens", { name: "  " })).status, 400);
  assert.equal((await api(env, null, "GET", "/api/controller/tokens")).status, 401);
});

test("config: your trips, the trip's actions with species in catch-card order, rod setups, lists, limits and the running trip", async () => {
  const { env, token } = await seeded();
  const res = await api(env, token, "GET", "/api/controller/config");
  assert.equal(res.status, 200);
  const cfg = await res.json();
  assert.deepEqual(cfg.trips.map((t) => t.name), ["Estuary", "Offshore"], "only your trips");
  const drift = cfg.actions.find((a) => a.name === "Drift");
  assert.deepEqual(drift.species, ["Bream", "Flathead", "Snapper"], "own targets, then the trip's other targets, then the rest");
  assert.deepEqual(cfg.actions.find((a) => a.name === "Anchor").species, ["Flathead", "Bream", "Snapper"]);
  assert.equal(cfg.actions.some((a) => a.name === "Not mine"), false);
  assert.deepEqual(cfg.rodSetups.map((r) => r.name), ["Light", "Lure"]);
  assert.deepEqual(cfg.species.sort(), ["Bream", "Flathead", "Snapper"], "yours plus Public's, never another user's");
  assert.equal(cfg.limits.Bream.minSize, 25);
  assert.deepEqual(cfg.berley, ["Pilchard Mix"]);
  assert.ok(cfg.depthValues.length > 3 && cfg.sizeDial.max > cfg.sizeDial.min);
  assert.deepEqual(cfg.state, { tripId: null });
  assert.match(cfg.configVersion, /^[0-9a-f]{16}$/);
});

test("config version is stable until something it lists changes — the running trip is not part of it", async () => {
  const { sqlite, env, token } = await seeded();
  const get = async () => (await (await api(env, token, "GET", "/api/controller/config")).json());
  const v1 = (await get()).configVersion;
  assert.equal((await get()).configVersion, v1);
  await api(env, token, "PUT", "/api/controller/state", { tripId: "t1" });
  assert.equal((await get()).configVersion, v1, "state is separate");
  sqlite.prepare("INSERT INTO user_mark_lists (id, user_id, field, value, created_at) VALUES ('s9', 'u1', 'Species', 'Tailor', 1)").run();
  assert.notEqual((await get()).configVersion, v1);
});

test("state: set the running trip, clear it, and refuse a trip that isn't yours", async () => {
  const { sqlite, env, token } = await seeded();
  assert.equal((await api(env, token, "PUT", "/api/controller/state", { tripId: "tx" })).status, 404);
  assert.equal((await api(env, token, "PUT", "/api/controller/state", { tripId: "t1" })).status, 200);
  assert.deepEqual(stateOf(sqlite), { tripId: "t1" });
  assert.deepEqual(await (await api(env, token, "GET", "/api/controller/state")).json(), { tripId: "t1" });
  await api(env, token, "PUT", "/api/controller/state", { tripId: null });
  assert.deepEqual(stateOf(sqlite), { tripId: null }, "a value, not a removal, so other devices can't resurrect the old trip");
});

test("events: a whole trip — start, action, catch, another action, end — becomes the marks the Live page would make", async () => {
  const { sqlite, env, token } = await seeded();
  const results = await send(env, token, [
    ev(1, "trip_start", { tripId: "t1" }),
    ev(2, "action_start", { actionId: "a1" }),
    ev(3, "catch", { actionId: "a1", species: "Bream", size: 31, fate: "keep", depth: 4, rodSetupId: "r2" }),
    ev(4, "catch", { actionId: "a1", species: "Flathead", size: 40, fate: "release", depth: 4.5 }),
    ev(5, "action_start", { actionId: "a2", lat: -38.15, lng: 145.25 }),
    ev(6, "trip_end", { lat: -38.2, lng: 145.3 }),
  ]);
  assert.deepEqual(results.map((r) => r.status), Array(6).fill("created"));

  const all = marks(sqlite);
  const byName = Object.fromEntries(all.map((m) => [m.name, m]));
  assert.deepEqual(Object.keys(byName).sort(), ["Bream", "Flathead", "Session 1 End", "Session 1 Start", "Session 2 End", "Session 2 Start"]);

  const start1 = byName["Session 1 Start"];
  assert.equal(start1.type, "Session Start");
  assert.equal(start1.date_time, "2026-10-02 10:02:00", "UTC+10 clock, converted to the site's local time");
  assert.equal(start1.source, "Controller");
  assert.equal(start1.source_uuid, "fc:fishctl-01:2:start");
  assert.equal(start1.user_id, "u1");
  assert.equal(start1.species, "Bream");
  assert.equal(start1.fishing_method, "Drifting");
  assert.equal(start1.berley, "Pilchard Mix");
  assert.equal(start1.bait, "Prawn");
  assert.equal(start1.rod, "L Wilson, L Raider");
  assert.equal(start1.rig_options, "Vibe");

  const bream = byName.Bream;
  assert.equal(bream.type, "Catch");
  assert.equal(bream.size, 31);
  assert.equal(bream.released, 0);
  assert.equal(bream.water_depth, 4);
  assert.equal(bream.rod, "L Raider", "the chosen rod setup's rod");
  assert.equal(bream.rig, "Jig Head");
  assert.equal(bream.berley, "Pilchard Mix");
  assert.equal(bream.source_uuid, "fc:fishctl-01:3");
  assert.equal(byName.Flathead.released, 1);
  assert.equal(byName.Flathead.rod, null, "two rod setups and none chosen: no rod guessed");

  // Starting the second action closed the first session at that moment and place; ending the trip closed the second.
  const end1 = byName["Session 1 End"];
  assert.equal(end1.session_group_id, start1.session_group_id);
  assert.equal(end1.date_time, "2026-10-02 10:05:00");
  assert.equal(end1.lat, -38.15);
  assert.equal(end1.source_uuid, "fc:fishctl-01:5:end");
  assert.equal(byName["Session 2 Start"].session_group_id, byName["Session 2 End"].session_group_id);
  assert.notEqual(byName["Session 2 Start"].session_group_id, start1.session_group_id);
  assert.deepEqual(stateOf(sqlite), { tripId: null });
});

test("events: the running trip/action is what the Live page reads — action_start sets it, action_end keeps just the trip", async () => {
  const { sqlite, env, token } = await seeded();
  await send(env, token, [ev(1, "trip_start", { tripId: "t1" })]);
  assert.deepEqual(stateOf(sqlite), { tripId: "t1" });
  await send(env, token, [ev(2, "action_start", { actionId: "a1" })]);
  const group = marks(sqlite, "type = 'Session Start'")[0].session_group_id;
  assert.deepEqual(stateOf(sqlite), { tripId: "t1", actionId: "a1", sessionGroupId: group });
  await send(env, token, [ev(3, "action_end")]);
  assert.deepEqual(stateOf(sqlite), { tripId: "t1" });
  assert.equal(marks(sqlite, "type = 'Session End'").length, 1);
  assert.equal((await send(env, token, [ev(4, "action_end")]))[0].status, "created", "ending with nothing running is harmless");
  assert.equal(marks(sqlite, "type = 'Session End'").length, 1);
});

test("events: starting an action with no trip running adopts that action's trip", async () => {
  const { sqlite, env, token } = await seeded();
  await send(env, token, [ev(1, "action_start", { actionId: "a2" })]);
  assert.equal(stateOf(sqlite).tripId, "t1");
});

test("events: replaying a batch is safe — duplicates are reported and nothing is created twice", async () => {
  const { sqlite, env, token } = await seeded();
  const batch = [ev(1, "trip_start", { tripId: "t1" }), ev(2, "action_start", { actionId: "a1" }), ev(3, "catch", { actionId: "a1", species: "Bream", size: 30, fate: "keep" })];
  assert.deepEqual((await send(env, token, batch)).map((r) => r.status), ["created", "created", "created"]);
  const before = marks(sqlite).length;
  const again = await send(env, token, batch);
  assert.deepEqual(again.map((r) => r.status), ["duplicate", "duplicate", "duplicate"]);
  assert.equal(marks(sqlite).length, before);
  // A replayed old trip_start must not undo what happened since.
  await send(env, token, [ev(4, "trip_end", { lat: -38.1, lng: 145.2 })]);
  await send(env, token, [batch[0]]);
  assert.deepEqual(stateOf(sqlite), { tripId: null });
  // Another device with the same sequence numbers is a different stream.
  const other = await send(env, token, [{ ...ev(1, "trip_start", { tripId: "t1" }), deviceId: "fishctl-02" }]);
  assert.equal(other[0].status, "created");
});

test("events: bad events are rejected one by one without stopping the rest, and leave no trace", async () => {
  const { sqlite, env, token } = await seeded();
  const results = await send(env, token, [
    ev(1, "trip_start", { tripId: "nope" }),
    ev(2, "action_start", { actionId: "ax" }),
    ev(3, "action_start", { actionId: "a1", lat: undefined }),
    ev(4, "catch", { species: "", fate: "keep" }),
    ev(5, "catch", { species: "Bream", size: -3 }),
    { ...ev(6, "dance") },
    { ...ev(7, "trip_start", { tripId: "t1" }), tzOffsetMin: 5000 },
    { deviceId: "", seq: 8, type: "trip_start", ts: T0 },
    ev(9, "trip_start", { tripId: "t1" }),
  ]);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected", "rejected", "rejected", "rejected", "rejected", "rejected", "rejected", "created"]);
  assert.ok(results.slice(0, 8).every((r) => typeof r.error === "string" && r.error));
  assert.equal(marks(sqlite).length, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM controller_events").get().n, 1, "only the processed event is recorded");
  assert.equal((await api(env, token, "POST", "/api/controller/events", { events: [] })).status, 400);
  assert.equal((await api(env, token, "POST", "/api/controller/events", { events: Array(101).fill(ev(1, "trip_end")) })).status, 400);
  assert.equal((await api(env, token, "POST", "/api/controller/events", { nope: true })).status, 400);
});

test("events: a catch with no running action is just what the controller sent; session numbers follow the day's chain", async () => {
  const { sqlite, env, token } = await seeded();
  await send(env, token, [ev(1, "catch", { species: "Squid", size: 18, fate: "keep", depth: 6 })]);
  const squid = marks(sqlite, "name = 'Squid'")[0];
  assert.equal(squid.rod, null);
  assert.equal(squid.berley, null);
  assert.equal(squid.water_depth, 6);
  await send(env, token, [ev(2, "action_start", { actionId: "a1" }), ev(3, "action_start", { actionId: "a2" }), ev(4, "action_start", { actionId: "a1" })]);
  assert.deepEqual(marks(sqlite, "type = 'Session Start'").map((m) => m.name), ["Session 1 Start", "Session 2 Start", "Session 3 Start"]);
});

test("events: one user's token can't touch another user's trips or actions", async () => {
  const { env, token } = await seeded();
  const results = await send(env, token, [ev(1, "trip_start", { tripId: "tx" }), ev(2, "action_start", { actionId: "ax" })]);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
});

test("marks since: only marks created after that moment are returned, so an open Live page can pick up new ones cheaply", async () => {
  const { sqlite, env, token } = await seeded();
  sqlite.prepare("INSERT INTO marks (id, user_id, lat, lng, name, type, date_time, created_at) VALUES ('old', 'u1', 1, 1, 'Old', 'Catch', '2026-10-01 10:00:00', ?)").run(NOW - 3600000);
  await send(env, token, [ev(1, "catch", { species: "Bream", size: 30, fate: "keep" })]);
  const all = await (await site(env, "GET", "/api/public/marks")).json();
  assert.deepEqual(all.map((m) => m.name).sort(), ["Bream", "Old"]);
  const recent = await (await site(env, "GET", `/api/public/marks?since=${NOW - 60000}`)).json();
  assert.deepEqual(recent.map((m) => m.name), ["Bream"]);
  assert.equal(recent[0].sourceUuid, "fc:fishctl-01:1");
});
