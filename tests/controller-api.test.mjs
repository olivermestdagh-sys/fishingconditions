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
  for (const t of ["user_prefs", "user_mark_lists", "user_rod_setups", "user_trip_setups", "user_trip_actions", "marks", "controller_tokens", "controller_events", "controller_track", "user_rig_sublist_overrides"]) sqlite.exec(table(t));
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
  // pick-list values the defaults editor may choose from (Public's and your own), a rig with its own Sub List and a Public rig with your private one
  ins(
    "INSERT INTO user_mark_lists (id, user_id, field, value, created_at, has_sublist, sub_list) VALUES " +
      "('f1', 'public', 'Fishing Method', 'Drifting', 1, NULL, NULL), ('f2', 'public', 'Fishing Method', 'Anchored', 1, NULL, NULL)," +
      "('ba1', 'u1', 'Bait', 'Prawn', 1, NULL, NULL), ('ba2', 'u1', 'Bait', 'Squid', 1, NULL, NULL)," +
      "('ro1', 'u1', 'Rod', 'L Wilson', 1, NULL, NULL), ('ro2', 'u1', 'Rod', 'L Raider', 1, NULL, NULL)," +
      "('ri1', 'u1', 'Rig', 'Paternoster', 1, 0, NULL), ('ri2', 'u1', 'Rig', 'Jig Head', 1, 1, '[\"Vibe\",\"Paddle Tail\"]'), ('ri3', 'public', 'Rig', 'Lure', 1, 0, NULL)"
  );
  ins("INSERT INTO user_rig_sublist_overrides (id, user_id, rig_id, sub_list, created_at) VALUES ('ov1', 'u1', 'ri3', '[\"Cranka\"]', 1)");
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
  // Two requests: one request only takes a limited number of events (see the query budget test below).
  const results = [
    ...(await send(env, token, [
      ev(1, "trip_start", { tripId: "t1" }),
      ev(2, "action_start", { actionId: "a1" }),
      ev(3, "catch", { actionId: "a1", species: "Bream", size: 31, fate: "keep", depth: 4, rodSetupId: "r2" }),
      ev(4, "catch", { actionId: "a1", species: "Flathead", size: 40, fate: "release", depth: 4.5 }),
    ])),
    ...(await send(env, token, [ev(5, "action_start", { actionId: "a2", lat: -38.15, lng: 145.25 }), ev(6, "trip_end", { lat: -38.2, lng: 145.3 })])),
  ];
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

test("events: Session Start, Session End and Catch all take the water condition and depth the controller has set", async () => {
  const { sqlite, env, token } = await seeded();
  await send(env, token, [ev(1, "trip_start", { tripId: "t1" })]);
  await send(env, token, [ev(2, "action_start", { actionId: "a1", water: "Clear", depth: 2 })]);
  await send(env, token, [ev(3, "catch", { actionId: "a1", species: "Bream", size: 30, fate: "keep", water: "Dirty", depth: 3 })]);
  // switching action: both the End of the first and the Start of the second get the values in force at that moment
  await send(env, token, [ev(4, "action_start", { actionId: "a2", water: "Dirty", depth: 3 })]);
  await send(env, token, [ev(5, "trip_end", { water: "Muddy", depth: 5 })]);
  const by = Object.fromEntries(marks(sqlite).map((m) => [m.name, m]));
  assert.equal(by["Session 1 Start"].water_condition, "Clear");
  assert.equal(by["Session 1 Start"].water_depth, 2);
  assert.equal(by.Bream.water_condition, "Dirty");
  assert.equal(by.Bream.water_depth, 3);
  assert.equal(by["Session 1 End"].water_condition, "Dirty", "the End records the conditions when it ended, not the Start's");
  assert.equal(by["Session 1 End"].water_depth, 3);
  assert.equal(by["Session 2 Start"].water_depth, 3);
  assert.equal(by["Session 2 End"].water_condition, "Muddy");
  assert.equal(by["Session 2 End"].water_depth, 5);
});

test("events: a Session End with no water/depth in the event keeps the Start's values", async () => {
  const { sqlite, env, token } = await seeded();
  await send(env, token, [ev(1, "action_start", { actionId: "a1", water: "Clear", depth: 2 })]);
  await send(env, token, [ev(2, "action_end")]);
  const end = marks(sqlite, "type = 'Session End'")[0];
  assert.equal(end.water_condition, "Clear");
  assert.equal(end.water_depth, 2);
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

test("events: a long backlog is taken in slices — the rest come back 'deferred' and are accepted on the next request", async () => {
  const { sqlite, env, token } = await seeded();
  const backlog = Array.from({ length: 14 }, (_, i) => ev(i + 1, "catch", { species: "Bream", size: 20 + i, fate: "keep" }));
  const first = await send(env, token, backlog);
  const created = first.filter((r) => r.status === "created").length;
  const deferred = first.filter((r) => r.status === "deferred");
  assert.ok(created >= 1 && created < 14, "some are taken");
  assert.equal(created + deferred.length, 14);
  assert.deepEqual(first.slice(0, created).map((r) => r.status), Array(created).fill("created"), "taken in order, deferred ones are the tail");
  assert.deepEqual(deferred.map((r) => r.seq), backlog.slice(created).map((e) => e.seq));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM marks").get().n, created, "a deferred event leaves no trace");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM controller_events").get().n, created);
  // The app sends what is still pending until nothing is.
  let left = backlog.slice(created);
  for (let round = 0; left.length && round < 10; round++) {
    const answers = await send(env, token, left);
    left = left.filter((_, i) => answers[i].status === "deferred");
  }
  assert.equal(left.length, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM marks").get().n, 14);
});

test("events: an action started with a water condition and depth carries them on its Session Start", async () => {
  const { sqlite, env, token } = await seeded();
  await send(env, token, [ev(1, "action_start", { actionId: "a1", water: "Murky", depth: 3.5 })]);
  const start = marks(sqlite, "type = 'Session Start'")[0];
  assert.equal(start.water_condition, "Murky");
  assert.equal(start.water_depth, 3.5);
});

const trackPoint = (n, extra = {}) => ({ ts: T0 + n * 20, lat: -38.1 + n * 0.0001, lng: 145.2, acc: 8, ...extra });
const trackCall = (env, token, body) => api(env, token, "POST", "/api/controller/track", body);

test("track: points are stored, idempotent on (device, time), and readable by the signed-in owner", async () => {
  const { sqlite, env, token } = await seeded();
  const points = Array.from({ length: 30 }, (_, i) => trackPoint(i));
  const res = await trackCall(env, token, { deviceId: "phone-1", tripId: "t1", points });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { saved: 30, duplicates: 0 });
    // 20 points seen before (10..29) plus 2 new ones
  assert.deepEqual(await (await trackCall(env, token, { deviceId: "phone-1", tripId: "t1", points: points.slice(10).concat([trackPoint(30), trackPoint(31)]) })).json(), { saved: 2, duplicates: 20 });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM controller_track").get().n, 32);
  assert.equal((await (await trackCall(env, token, { deviceId: "phone-2", points: [trackPoint(0)] })).json()).saved, 1, "another device is its own stream");

  const read = await site(env, "GET", `/api/controller/track?from=${T0}&to=${T0 + 100}`);
  assert.equal(read.status, 200);
  const rows = await read.json();
  assert.ok(rows.length >= 6 && rows[0].ts <= rows[1].ts, "oldest first");
  assert.equal(rows[0].tripId, "t1");
  assert.equal((await site(env, "GET", `/api/controller/track?from=${T0}&to=${T0 + 100}&tripId=nope`).then((r) => r.json())).length, 0);
  assert.equal((await site(env, "GET", `/api/controller/track?from=${T0}&to=${T0 + 100}`, undefined, "s-u2").then((r) => r.json())).length, 0, "someone else's track is not yours");
});

test("track: bad requests are refused and store nothing", async () => {
  const { sqlite, env, token } = await seeded();
  const cases = [
    { points: [trackPoint(1)] },
    { deviceId: "d", points: [] },
    { deviceId: "d", points: Array.from({ length: 201 }, (_, i) => trackPoint(i)) },
    { deviceId: "d", points: [trackPoint(1, { lat: 91 })] },
    { deviceId: "d", points: [trackPoint(1, { lng: -181 })] },
    { deviceId: "d", points: [trackPoint(1, { ts: 0 })] },
    { deviceId: "d", points: [trackPoint(1, { ts: 1.5 })] },
    { deviceId: "d", points: [trackPoint(1, { acc: -1 })] },
    { deviceId: "d", tripId: 5, points: [trackPoint(1)] },
    { deviceId: "d", points: [trackPoint(1), { ts: T0 }] },
  ];
  for (const body of cases) assert.equal((await trackCall(env, token, body)).status, 400, JSON.stringify(body).slice(0, 80));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM controller_track").get().n, 0);
  assert.equal((await trackCall(env, "fc_nonsense", { deviceId: "d", points: [trackPoint(1)] })).status, 401);
  assert.equal((await site(env, "GET", "/api/controller/track?from=5&to=1")).status, 400);
  assert.equal((await api(env, null, "GET", "/api/controller/track?from=1&to=2")).status, 401, "reading needs a signed-in visitor");
  assert.equal((await api(env, token, "GET", "/api/controller/track?from=1&to=2")).status, 401, "a device token can write a track but not read it back");
});

test("config: carries what the defaults editor needs — each action's own choices, rod setup options, rods and rigs with their options", async () => {
  const { env, token } = await seeded();
  const cfg = await (await api(env, token, "GET", "/api/controller/config")).json();
  const drift = cfg.actions.find((a) => a.name === "Drift");
  assert.deepEqual(drift.fishingMethod, ["Drifting"]);
  assert.equal(drift.berley, "Pilchard Mix");
  assert.deepEqual(drift.bait, ["Prawn"]);
  assert.deepEqual(drift.targets, ["Bream"], "its own targets, apart from the catch-card order in 'species'");
  assert.equal(cfg.actions.find((a) => a.name === "Anchor").berley, "");
  assert.deepEqual(cfg.rodSetups.find((r) => r.id === "r2").subListItems, ["Vibe"]);
  assert.deepEqual(cfg.rods, ["L Raider", "L Wilson"]);
  assert.deepEqual(cfg.rigs, [
    { name: "Jig Head", options: ["Vibe", "Paddle Tail"] },
    { name: "Lure", options: ["Cranka"] }, // a Public rig: your private sub list
    { name: "Paternoster", options: [] },
  ]);
  assert.deepEqual(cfg.fishingMethod, ["Anchored", "Drifting"]);
});

const update = (env, token, type, seq, extra) => send(env, token, [{ deviceId: "fishctl-01", seq, type, ts: T0 + seq, tzOffsetMin: 600, ...extra }]);
const actionRow = (sqlite, id) => sqlite.prepare("SELECT * FROM user_trip_actions WHERE id = ?").get(id);
const setupRow = (sqlite, id) => sqlite.prepare("SELECT * FROM user_rod_setups WHERE id = ?").get(id);

test("action_update: changes an action's choices, from existing values only, idempotently", async () => {
  const { sqlite, env, token } = await seeded();
  const v1 = (await (await api(env, token, "GET", "/api/controller/config")).json()).configVersion;

  let r = await update(env, token, "action_update", 1, { actionId: "a1", fishingMethod: ["Anchored", "Drifting"], bait: ["Squid"], targets: ["Flathead", "Bream"], berley: "" });
  assert.equal(r[0].status, "created");
  const row = actionRow(sqlite, "a1");
  assert.deepEqual(JSON.parse(row.fishing_method), ["Anchored", "Drifting"]);
  assert.deepEqual(JSON.parse(row.bait), ["Squid"]);
  assert.deepEqual(JSON.parse(row.species), ["Flathead", "Bream"]);
  assert.equal(row.berley, null, "an empty berley clears it");
  assert.deepEqual(JSON.parse(row.rod_setup_ids), ["r1", "r2"], "fields not sent are untouched");

  r = await update(env, token, "action_update", 1, { actionId: "a1", bait: ["Prawn"] });
  assert.equal(r[0].status, "duplicate", "a replay changes nothing");
  assert.deepEqual(JSON.parse(actionRow(sqlite, "a1").bait), ["Squid"]);

  r = await update(env, token, "action_update", 2, { actionId: "a1", berley: "Pilchard Mix", rodSetupIds: ["r2"], bait: [] });
  assert.equal(r[0].status, "created");
  const after = actionRow(sqlite, "a1");
  assert.equal(after.berley, "Pilchard Mix");
  assert.deepEqual(JSON.parse(after.rod_setup_ids), ["r2"]);
  assert.equal(after.bait, null, "an empty list clears it");
  assert.notEqual((await (await api(env, token, "GET", "/api/controller/config")).json()).configVersion, v1, "the config the controller reads changed");
});

test("action_update: a value that doesn't exist, someone else's action or rod setup, or nothing at all is rejected and changes nothing", async () => {
  const { sqlite, env, token } = await seeded();
  const before = JSON.stringify(actionRow(sqlite, "a1"));
  const bad = [
    { actionId: "a1", fishingMethod: ["Trawling"] },
    { actionId: "a1", bait: ["Pipi"] },
    { actionId: "a1", targets: ["Secret"] }, // another user's species
    { actionId: "a1", berley: "Nope" },
    { actionId: "a1", rodSetupIds: ["r9"] },
    { actionId: "a1", bait: "Prawn" },
    { actionId: "a1" },
    { actionId: "ax", bait: ["Prawn"] }, // another user's action
    { bait: ["Prawn"] },
  ];
  const results = [];
  for (const [i, extra] of bad.entries()) results.push((await update(env, token, "action_update", 10 + i, extra))[0]);
  assert.deepEqual(results.map((x) => x.status), Array(bad.length).fill("rejected"));
  assert.ok(results.every((x) => typeof x.error === "string" && x.error));
  assert.match(results[0].error, /Trawling/);
  assert.equal(JSON.stringify(actionRow(sqlite, "a1")), before);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM controller_events").get().n, 0, "rejected events leave no trace");
});

test("rodsetup_update: rod, rig and rig options — changing the rig clears its options, and options must belong to the rig", async () => {
  const { sqlite, env, token } = await seeded();
  let r = await update(env, token, "rodsetup_update", 1, { rodSetupId: "r1", rod: "L Raider" });
  assert.equal(r[0].status, "created");
  assert.equal(setupRow(sqlite, "r1").rod, "L Raider");
  assert.equal(setupRow(sqlite, "r1").rig, "Paternoster");

  // r2 is on Jig Head with option Vibe: another rig drops the options
  r = await update(env, token, "rodsetup_update", 2, { rodSetupId: "r2", rig: "Paternoster" });
  assert.equal(r[0].status, "created");
  assert.equal(setupRow(sqlite, "r2").rig, "Paternoster");
  assert.equal(setupRow(sqlite, "r2").sub_list_items, null);

  // options of the (new) rig only
  assert.equal((await update(env, token, "rodsetup_update", 3, { rodSetupId: "r2", subListItems: ["Vibe"] }))[0].status, "rejected", "Paternoster has no options");
  r = await update(env, token, "rodsetup_update", 4, { rodSetupId: "r2", rig: "Jig Head", subListItems: ["Paddle Tail", "Vibe"] });
  assert.equal(r[0].status, "created");
  assert.deepEqual(JSON.parse(setupRow(sqlite, "r2").sub_list_items), ["Paddle Tail", "Vibe"]);
  // your private options on a Public rig count
  r = await update(env, token, "rodsetup_update", 5, { rodSetupId: "r1", rig: "Lure", subListItems: ["Cranka"] });
  assert.equal(r[0].status, "created");
  assert.deepEqual(JSON.parse(setupRow(sqlite, "r1").sub_list_items), ["Cranka"]);
  // clearing
  r = await update(env, token, "rodsetup_update", 6, { rodSetupId: "r1", rod: "", subListItems: [] });
  assert.equal(setupRow(sqlite, "r1").rod, null);
  assert.equal(setupRow(sqlite, "r1").sub_list_items, null);
});

test("rodsetup_update: unknown rods and rigs, someone else's setup and empty edits are rejected", async () => {
  const { sqlite, env, token } = await seeded();
  const before = JSON.stringify(setupRow(sqlite, "r1"));
  const bad = [
    { rodSetupId: "r1", rod: "Mystery" },
    { rodSetupId: "r1", rig: "Mystery" },
    { rodSetupId: "r1", subListItems: ["Vibe"] }, // r1 is on Paternoster
    { rodSetupId: "r1", subListItems: "Vibe" },
    { rodSetupId: "r1" },
    { rodSetupId: "nope", rod: "L Wilson" },
  ];
  const results = [];
  for (const [i, extra] of bad.entries()) results.push((await update(env, token, "rodsetup_update", 30 + i, extra))[0]);
  assert.deepEqual(results.map((x) => x.status), Array(bad.length).fill("rejected"));
  assert.equal(JSON.stringify(setupRow(sqlite, "r1")), before);
});
