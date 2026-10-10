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
  for (const t of ["user_prefs", "user_mark_lists", "user_rod_setups", "user_trip_setups", "user_trip_actions", "marks", "controller_tokens", "controller_events", "controller_track", "user_rig_sublist_overrides", "trip_log", "trip_log_rods"]) sqlite.exec(table(t));
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
  ins("INSERT INTO user_rod_setups (id, user_id, name, rod, rig, sub_list_items, bait, created_at) VALUES ('r1', 'u1', 'Light', 'L Wilson', 'Paternoster', NULL, '[\"Prawn\"]', 1), ('r2', 'u1', 'Lure', 'L Raider', 'Jig Head', '[\"Vibe\"]', NULL, 1)");
  ins("INSERT INTO user_trip_setups (id, user_id, name, created_at) VALUES ('t1', 'u1', 'Estuary', 1), ('t2', 'u1', 'Offshore', 1), ('tx', 'u2', 'Someone else', 1)");
  ins(
    "INSERT INTO user_trip_actions (id, user_id, trip_id, name, fishing_method, berley, bait, rod_setup_ids, species, created_at) VALUES " +
      "('a1', 'u1', 't1', 'Drift', '[\"Drifting\"]', 'Pilchard Mix', '[]', '[\"r1\",\"r2\"]', '[\"Bream\"]', 1)," +
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

test("events: a whole trip — start, action, catch, another action, end — makes the catches the Live page would make, and the trip log; no Session marks", async () => {
  const { sqlite, env, token } = await seeded();
  // Three requests: one request only takes a limited number of events (see the query budget test below; the trip log adds a few queries each).
  const results = [
    ...(await send(env, token, [ev(1, "trip_start", { tripId: "t1" }), ev(2, "action_start", { actionId: "a1" }), ev(3, "catch", { actionId: "a1", species: "Bream", size: 31, fate: "keep", depth: 4, rodSetupId: "r2" })])),
    ...(await send(env, token, [ev(4, "catch", { actionId: "a1", species: "Flathead", size: 40, fate: "release", depth: 4.5 }), ev(5, "action_start", { actionId: "a2", lat: -38.15, lng: 145.25 })])),
    ...(await send(env, token, [ev(6, "trip_end", { lat: -38.2, lng: 145.3 })])),
  ];
  assert.deepEqual(results.map((r) => r.status), Array(6).fill("created"));

  const all = marks(sqlite);
  const byName = Object.fromEntries(all.map((m) => [m.name, m]));
  assert.deepEqual(Object.keys(byName).sort(), ["Bream Estuary Drift 1", "Flathead Estuary Drift 1"], "only the catches are marks: Session Start / End are not made any more");

  const bream = byName["Bream Estuary Drift 1"];
  assert.equal(bream.type, "Catch");
  assert.equal(bream.date_time, "2026-10-02 10:03:00", "UTC+10 clock, converted to the site's local time");
  assert.equal(bream.source, "Controller");
  assert.equal(bream.user_id, "u1");
  assert.equal(bream.size, 31);
  assert.equal(bream.released, 0);
  assert.equal(bream.water_depth, 4);
  assert.equal(bream.rod, "L Raider", "the chosen rod setup's rod");
  assert.equal(bream.rig, "Jig Head");
  assert.equal(bream.berley, "Pilchard Mix");
  assert.equal(bream.source_uuid, "fc:fishctl-01:3");
  assert.equal(byName["Flathead Estuary Drift 1"].released, 1);
  assert.equal(byName["Flathead Estuary Drift 1"].rod, null, "two rod setups and none chosen: no rod guessed");

  // what the actions did is in the trip log: the second action started where the controller was, and ending the trip logged its end
  const log = sqlite.prepare("SELECT event_type, action_name, date_time, lat FROM trip_log ORDER BY ts, rowid").all();
  assert.deepEqual(log.map((r) => [r.event_type, r.action_name]), [
    ["trip_start", null], ["action_start", "Drift"], ["change", "Drift"], ["catch", "Drift"], ["change", "Drift"], ["catch", "Drift"], ["action_start", "Anchor"], ["trip_end", "Anchor"],
  ]);
  assert.equal(log[1].date_time, "2026-10-02 10:02:00");
  assert.equal(log[6].lat, -38.15);
  assert.deepEqual(stateOf(sqlite), { tripId: null });
});

test("events: the running trip/action is what the Live page reads — action_start sets it (and numbers it), action_end keeps just the trip and the count", async () => {
  const { sqlite, env, token } = await seeded();
  await send(env, token, [ev(1, "trip_start", { tripId: "t1" })]);
  const runId = stateOf(sqlite).runId;
  assert.match(runId, /^run_/);
  assert.deepEqual(stateOf(sqlite), { tripId: "t1", runId });
  await send(env, token, [ev(2, "action_start", { actionId: "a1" })]);
  const group = sqlite.prepare("SELECT session_group_id FROM trip_log WHERE event_type = 'action_start'").get().session_group_id;
  assert.ok(group);
  assert.deepEqual(stateOf(sqlite), { tripId: "t1", actionId: "a1", sessionGroupId: group, runId, sessionNumber: 1 });
  await send(env, token, [ev(3, "action_end")]);
  assert.deepEqual(stateOf(sqlite), { tripId: "t1", runId, sessionNumber: 1 });
  assert.equal((await send(env, token, [ev(4, "action_end")]))[0].status, "created", "ending with nothing running is harmless");
  await send(env, token, [ev(5, "action_start", { actionId: "a2" })]);
  assert.equal(stateOf(sqlite).sessionNumber, 2, "the trip's actions are numbered from 1");
  assert.equal(marks(sqlite, "type IN ('Session Start', 'Session End')").length, 0);
});

test("events: the action_start log entry takes the water condition and depth the controller has set; a catch's own are on the catch", async () => {
  const { sqlite, env, token } = await seeded();
  await send(env, token, [ev(1, "trip_start", { tripId: "t1" })]);
  await send(env, token, [ev(2, "action_start", { actionId: "a1", water: "Clear", depth: 2 })]);
  await send(env, token, [ev(3, "catch", { actionId: "a1", species: "Bream", size: 30, fate: "keep", water: "Dirty", depth: 3 })]);
  await send(env, token, [ev(4, "action_start", { actionId: "a2", water: "Dirty", depth: 3 })]);
  await send(env, token, [ev(5, "trip_end", { water: "Muddy", depth: 5 })]);
  const log = sqlite.prepare("SELECT event_type, action_name, water_condition, water_depth FROM trip_log ORDER BY ts, rowid").all();
  const pick = (type, action) => log.find((r) => r.event_type === type && (action === undefined || r.action_name === action));
  assert.deepEqual([pick("action_start", "Drift").water_condition, pick("action_start", "Drift").water_depth], ["Clear", 2]);
  assert.deepEqual([pick("catch").water_condition, pick("catch").water_depth], ["Dirty", 3]);
  assert.equal(pick("action_start", "Anchor").water_depth, 3);
  assert.deepEqual([pick("trip_end").water_condition, pick("trip_end").water_depth], ["Muddy", 5]);
  const bream = marks(sqlite, "type = 'Catch'")[0];
  assert.deepEqual([bream.water_condition, bream.water_depth], ["Dirty", 3]);
});

test("events: a Too small catch has no size, is released and carries the Too small note — like the Live +Catch", async () => {
  const { sqlite, env, token } = await seeded();
  await send(env, token, [ev(1, "trip_start", { tripId: "t1" }), ev(2, "action_start", { actionId: "a1" })]);
  const out = await send(env, token, [ev(3, "catch", { actionId: "a1", species: "Bream", tooSmall: true, fate: "release" })]);
  assert.equal(out[0].status, "created");
  const m = marks(sqlite, "type = 'Catch'")[0];
  assert.equal(m.size, null);
  assert.equal(m.released, 1);
  assert.equal(m.notes, "Too small");
});

test("events: the Bait answer on a catch is the mark's bait; [] means none; leaving it out takes the chosen rod setup's (none when several and none chosen)", async () => {
  const { sqlite, env, token } = await seeded();
  await send(env, token, [ev(1, "trip_start", { tripId: "t1" }), ev(2, "action_start", { actionId: "a1" })]);
  await send(env, token, [
    ev(3, "catch", { actionId: "a1", species: "Bream", size: 30, fate: "keep" }),
    ev(4, "catch", { actionId: "a1", species: "Bream", size: 31, fate: "keep", bait: ["Pipi"] }),
    ev(5, "catch", { actionId: "a1", species: "Bream", size: 32, fate: "keep", bait: [] }),
  ]);
  const by = Object.fromEntries(marks(sqlite, "type = 'Catch'").map((m) => [m.size, m]));
  assert.equal(by[30].bait, null, "no answer, two rod setups and none chosen: no bait guessed");
  assert.equal(by[31].bait, "Pipi");
  assert.equal(by[32].bait, null, "answered none");
  const bad = await send(env, token, [ev(6, "catch", { actionId: "a1", species: "Bream", size: 33, bait: "Pipi" })]);
  assert.equal(bad[0].status, "rejected");
});

test("events: a catch's Bait options (the bait's sub list) become the mark's bait options and the log line's; others are rejected", async () => {
  const { sqlite, env, token } = await seeded();
  sqlite.prepare("UPDATE user_mark_lists SET has_sublist = 1, sub_list = ? WHERE id = 'ba2'").run(JSON.stringify(["Wing Strip", "Whole"]));
  await send(env, token, [ev(1, "trip_start", { tripId: "t1" }), ev(2, "action_start", { actionId: "a1" })]);
  const res = await send(env, token, [
    ev(3, "catch", { actionId: "a1", species: "Bream", size: 30, fate: "keep", rodSetupId: "r1", bait: ["Squid"], baitOptions: ["Wing Strip"] }),
    ev(4, "catch", { actionId: "a1", species: "Bream", size: 31, fate: "keep", rodSetupId: "r1", bait: ["Squid"], baitOptions: [] }),
    ev(5, "catch", { actionId: "a1", species: "Bream", size: 32, fate: "keep", rodSetupId: "r1", bait: ["Squid"], baitOptions: ["Nonsense"] }),
  ]);
  assert.deepEqual(res.map((r) => r.status), ["created", "created", "rejected"]);
  const by = Object.fromEntries(marks(sqlite, "type = 'Catch'").map((m) => [m.size, m]));
  assert.equal(by[30].bait, "Squid");
  assert.equal(by[30].bait_options, "Wing Strip");
  assert.equal(by[31].bait_options, null, "answered no options");
  const log = sqlite.prepare("SELECT l.size, r.bait, r.bait_options FROM trip_log l JOIN trip_log_rods r ON r.log_id = l.id WHERE l.event_type = 'catch' ORDER BY l.size").all();
  assert.deepEqual(log.map((x) => [x.size, x.bait, x.bait_options]), [[30, '["Squid"]', '["Wing Strip"]'], [31, '["Squid"]', null]]);
});

test("config: carries the first picture of each value that has one, and of a rig's options (your private override wins)", async () => {
  const { sqlite, env, token } = await seeded();
  sqlite.prepare("UPDATE user_mark_lists SET image_index = ? WHERE id = 's1'").run(JSON.stringify([{ id: "img-bream-1", v: 11 }, { id: "img-bream-2", v: 12 }]));
  sqlite.prepare("UPDATE user_mark_lists SET image_index = ? WHERE id = 'ba1'").run(JSON.stringify([{ id: "img-prawn", v: 5 }]));
  sqlite.prepare("UPDATE user_mark_lists SET option_images = ? WHERE id = 'ri2'").run(JSON.stringify({ Vibe: [{ id: "img-vibe", v: 7 }], "Paddle Tail": [{ id: "img-paddle", v: 8 }] }));
  sqlite.prepare("UPDATE user_rig_sublist_overrides SET option_images = ? WHERE id = 'ov1'").run(JSON.stringify({ Cranka: [{ id: "img-cranka", v: 9 }] }));
  const config = await (await api(env, token, "GET", "/api/controller/config")).json();
  assert.deepEqual(config.images.Species, { Bream: { id: "img-bream-1", v: 11 } }, "only the first picture, and only values that have one");
  assert.deepEqual(config.images.Bait, { Prawn: { id: "img-prawn", v: 5 } });
  assert.equal(config.images.Rod, undefined);
  const rig = (name) => config.rigs.find((r) => r.name === name);
  assert.deepEqual(rig("Jig Head").optionImages, { Vibe: { id: "img-vibe", v: 7 }, "Paddle Tail": { id: "img-paddle", v: 8 } });
  assert.deepEqual(rig("Lure").optionImages, { Cranka: { id: "img-cranka", v: 9 } }, "a Public rig takes your private override's pictures");
  assert.deepEqual(rig("Paternoster").optionImages, {});
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

test("events: a catch with no running action is just what the controller sent; a trip's actions are numbered from 1", async () => {
  const { sqlite, env, token } = await seeded();
  await send(env, token, [ev(1, "catch", { species: "Squid", size: 18, fate: "keep", depth: 6 })]);
  const squid = marks(sqlite, "name = 'Squid'")[0];
  assert.equal(squid.rod, null);
  assert.equal(squid.berley, null);
  assert.equal(squid.water_depth, 6);
  await send(env, token, [ev(2, "action_start", { actionId: "a1" }), ev(3, "action_start", { actionId: "a2" }), ev(4, "action_start", { actionId: "a1" })]);
  assert.equal(stateOf(sqlite).sessionNumber, 3);
  await send(env, token, [ev(5, "catch", { actionId: "a1", species: "Bream", size: 30, fate: "keep" })]);
  assert.ok(marks(sqlite, "name = 'Bream Estuary Drift 3'").length, "the running action's number is in the catch's default name");
  assert.equal(marks(sqlite, "type IN ('Session Start', 'Session End')").length, 0);
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
  assert.deepEqual(cfg.rodSetups.find((r) => r.id === "r1").bait, ["Prawn"], "bait is chosen on the rod setup");
  assert.deepEqual(drift.targets, ["Bream"], "its own targets, apart from the catch-card order in 'species'");
  assert.equal(cfg.actions.find((a) => a.name === "Anchor").berley, "");
  assert.deepEqual(cfg.rodSetups.find((r) => r.id === "r2").subListItems, ["Vibe"]);
  assert.deepEqual(cfg.rods, ["L Raider", "L Wilson"]);
  assert.deepEqual(cfg.rigs, [
    { name: "Jig Head", options: ["Vibe", "Paddle Tail"], optionImages: {} },
    { name: "Lure", options: ["Cranka"], optionImages: {} }, // a Public rig: your private sub list
    { name: "Paternoster", options: [], optionImages: {} },
  ]);
  assert.deepEqual(cfg.fishingMethod, ["Anchored", "Drifting"]);
});

const update = (env, token, type, seq, extra) => send(env, token, [{ deviceId: "fishctl-01", seq, type, ts: T0 + seq, tzOffsetMin: 600, ...extra }]);
const actionRow = (sqlite, id) => sqlite.prepare("SELECT * FROM user_trip_actions WHERE id = ?").get(id);
const setupRow = (sqlite, id) => sqlite.prepare("SELECT * FROM user_rod_setups WHERE id = ?").get(id);

test("action_update: changes an action's choices, from existing values only, idempotently", async () => {
  const { sqlite, env, token } = await seeded();
  const v1 = (await (await api(env, token, "GET", "/api/controller/config")).json()).configVersion;

  let r = await update(env, token, "action_update", 1, { actionId: "a1", fishingMethod: ["Anchored", "Drifting"], targets: ["Flathead", "Bream"], berley: "" });
  assert.equal(r[0].status, "created");
  const row = actionRow(sqlite, "a1");
  assert.deepEqual(JSON.parse(row.fishing_method), ["Anchored", "Drifting"]);
  assert.deepEqual(JSON.parse(row.species), ["Flathead", "Bream"]);
  assert.equal(row.berley, null, "an empty berley clears it");
  assert.deepEqual(JSON.parse(row.rod_setup_ids), ["r1", "r2"], "fields not sent are untouched");

  r = await update(env, token, "action_update", 1, { actionId: "a1", targets: ["Bream"] });
  assert.equal(r[0].status, "duplicate", "a replay changes nothing");
  assert.deepEqual(JSON.parse(actionRow(sqlite, "a1").species), ["Flathead", "Bream"]);

  r = await update(env, token, "action_update", 2, { actionId: "a1", berley: "Pilchard Mix", rodSetupIds: ["r2"] });
  assert.equal(r[0].status, "created");
  const after = actionRow(sqlite, "a1");
  assert.equal(after.berley, "Pilchard Mix");
  assert.deepEqual(JSON.parse(after.rod_setup_ids), ["r2"]);
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

test("trip log: marks of a trip run are listed for the controller, and mark_update edits them from existing values only", async () => {
  const { sqlite, env, token } = await seeded();
  sqlite.prepare("INSERT INTO user_mark_lists (id, user_id, field, value, created_at) VALUES ('w1', 'u1', 'Weather Condition', 'Overcast', 1), ('wa1', 'u1', 'Water Condition', 'Clear', 1)").run();
  await send(env, token, [ev(1, "trip_start", { tripId: "t1" }), ev(2, "action_start", { actionId: "a1" }), ev(3, "catch", { actionId: "a1", species: "Bream", size: 31, fate: "keep" })]);
  const runId = stateOf(sqlite).runId;
  assert.ok(runId, "the trip has a run id");
  assert.equal(marks(sqlite, `trip_run_id = '${runId}'`).length, 1, "the Catch carries it");

  // other trips' marks and other users' don't list
  sqlite.prepare("INSERT INTO marks (id, user_id, lat, lng, type, date_time, source, created_at, trip_run_id) VALUES ('old', 'u1', 0, 0, 'Catch', '2026-01-01 10:00:00', 'Controller', 1, 'run_other')").run();
  const listed = await (await api(env, token, "GET", "/api/controller/marks")).json();
  assert.equal(listed.runId, runId);
  assert.deepEqual(listed.marks.map((m) => m.type), ["Catch"]);
  assert.equal((await api(env, null, "GET", "/api/controller/marks")).status, 401);

  const catchId = listed.marks[0].id;
  let r = await update(env, token, "mark_update", 10, { markId: catchId, changes: { species: "Flathead", size: 42, released: true, weatherCondition: "Overcast", windDirection: "NE", notes: "  nice  " } });
  assert.equal(r[0].status, "created");
  const row = sqlite.prepare("SELECT * FROM marks WHERE id = ?").get(catchId);
  assert.equal(row.species, "Flathead");
  assert.equal(row.name, "Flathead", "a Catch is named after its species");
  assert.equal(row.size, 42);
  assert.equal(row.released, 1);
  assert.equal(row.weather_condition, "Overcast");
  assert.equal(row.wind_direction, "NE");
  assert.equal(row.notes, "nice");

  r = await update(env, token, "mark_update", 10, { markId: catchId, changes: { size: 1 } });
  assert.equal(r[0].status, "duplicate");

  // a rig change clears rig options; options must belong to the rig
  r = await update(env, token, "mark_update", 11, { markId: catchId, changes: { rig: "Jig Head", rigOptions: ["Vibe"] } });
  assert.equal(r[0].status, "created");
  assert.equal(sqlite.prepare("SELECT rig_options FROM marks WHERE id = ?").get(catchId).rig_options, "Vibe");
  r = await update(env, token, "mark_update", 12, { markId: catchId, changes: { rig: "Paternoster" } });
  assert.equal(sqlite.prepare("SELECT rig_options FROM marks WHERE id = ?").get(catchId).rig_options, null);

  const bad = [
    { markId: catchId, changes: { species: "Secret" } },
    { markId: catchId, changes: { size: -1 } },
    { markId: catchId, changes: { lat: 1 } },
    { markId: catchId, changes: { type: "POI" } },
    { markId: catchId, changes: { windDirection: "Up" } },
    { markId: catchId, changes: { rigOptions: ["Vibe"] } }, // not Paternoster's
    { markId: catchId, changes: {} },
    { markId: "old2", changes: { size: 3 } },
  ];
  const out = [];
  for (const [i, extra] of bad.entries()) out.push((await update(env, token, "mark_update", 20 + i, extra))[0]);
  assert.deepEqual(out.map((x) => x.status), Array(bad.length).fill("rejected"));

  // someone else's (or a hand-made) mark can't be edited
  sqlite.prepare("INSERT INTO marks (id, user_id, lat, lng, type, date_time, source, created_at) VALUES ('hand', 'u1', 0, 0, 'Catch', '2026-01-01 10:00:00', 'Manual', 1)").run();
  assert.equal((await update(env, token, "mark_update", 40, { markId: "hand", changes: { size: 3 } }))[0].status, "rejected");
});

test("mark_update also edits the catch's trip log line and rod row (the Trip Logs tab reads those, not the mark)", async () => {
  const { sqlite, env, token } = await seeded();
  sqlite.prepare("INSERT INTO user_mark_lists (id, user_id, field, value, created_at) VALUES ('w1', 'u1', 'Weather Condition', 'Overcast', 1)").run();
  await send(env, token, [ev(1, "trip_start", { tripId: "t1" }), ev(2, "action_start", { actionId: "a1" }), ev(3, "catch", { actionId: "a1", species: "Bream", size: 31, fate: "keep", rodSetupId: "r1" })]);
  const id = sqlite.prepare("SELECT id FROM marks WHERE type = 'Catch'").get().id;
  const logLine = () => sqlite.prepare("SELECT * FROM trip_log WHERE mark_id = ? AND event_type = 'catch'").get(id);
  const rodRow = () => sqlite.prepare("SELECT r.* FROM trip_log_rods r JOIN trip_log l ON l.id = r.log_id WHERE l.mark_id = ? AND l.event_type = 'catch'").get(id);
  assert.equal(logLine().size, 31);
  assert.equal(logLine().edited_at, null);

  let r = await update(env, token, "mark_update", 10, { markId: id, changes: { species: "Flathead", size: 42, released: true, weatherCondition: "Overcast", windDirection: "NE", waterDepth: 3.5, temperature: 21 } });
  assert.equal(r[0].status, "created");
  let l = logLine();
  assert.equal(l.species, "Flathead");
  assert.equal(l.size, 42);
  assert.equal(l.released, 1);
  assert.equal(l.weather_condition, "Overcast");
  assert.equal(l.wind_direction, "NE");
  assert.equal(l.water_depth, 3.5);
  assert.equal(l.temperature, 21);
  assert.ok(l.edited_at > 0, "stamped as hand-edited so no backfill rebuilds over it");
  assert.equal(sqlite.prepare("SELECT size FROM marks WHERE id = ?").get(id).size, 42, "the mark still takes it too");

  // clearing a value clears it on the log line too
  await update(env, token, "mark_update", 11, { markId: id, changes: { windDirection: null } });
  assert.equal(logLine().wind_direction, null);

  // the time moves the log line's own date_time and its real UTC time (naive = real + the zone offset)
  assert.equal((await update(env, token, "mark_update", 12, { markId: id, changes: { dateTime: "2026-10-02 10:25:00" } }))[0].status, "created");
  l = logLine();
  assert.equal(l.date_time, "2026-10-02 10:25:00");
  assert.equal(l.ts, Date.parse("2026-10-02T10:25:00Z") - l.tz_offset_min * 60000);

  // gear goes to the rod row (text for rod and rig, JSON arrays for the option lists)
  assert.equal((await update(env, token, "mark_update", 13, { markId: id, changes: { rod: "L Wilson", rig: "Jig Head", rigOptions: ["Vibe"] } }))[0].status, "created");
  const g = rodRow();
  assert.equal(g.rod, "L Wilson");
  assert.equal(g.rig, "Jig Head");
  assert.deepEqual(JSON.parse(g.rig_options), ["Vibe"]);

  // a line the user deleted stays hidden and untouched, other users' lines are never reached
  sqlite.prepare("UPDATE trip_log SET deleted_at = 1 WHERE mark_id = ?").run(id);
  assert.equal((await update(env, token, "mark_update", 14, { markId: id, changes: { size: 50 } }))[0].status, "created");
  assert.equal(sqlite.prepare("SELECT size FROM marks WHERE id = ?").get(id).size, 50);
  assert.equal(logLine().size, 42, "a deleted line is left as it was");
});

test("trip log: the run id survives actions starting and ending, and a trip started elsewhere gets one at its first action", async () => {
  const { sqlite, env, token } = await seeded();
  await send(env, token, [ev(1, "trip_start", { tripId: "t1" })]);
  const runId = stateOf(sqlite).runId;
  await send(env, token, [ev(2, "action_start", { actionId: "a1" }), ev(3, "action_end"), ev(4, "action_start", { actionId: "a2" })]);
  assert.equal(stateOf(sqlite).runId, runId);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log WHERE run_id = ?").get(runId).n, 4, "trip start, action start, action end, action start");

  sqlite.prepare("UPDATE user_prefs SET value = '{\"tripId\":\"t1\"}' WHERE user_id = 'u1' AND key = 'liveActiveTrip'").run();
  await send(env, token, [ev(5, "action_start", { actionId: "a1" })]);
  assert.ok(stateOf(sqlite).runId && stateOf(sqlite).runId !== runId);
});

test("trip and action names: stamped on Catch marks, editable from the controller from existing names only", async () => {
  const { sqlite, env, token } = await seeded();
  await send(env, token, [ev(1, "trip_start", { tripId: "t1" }), ev(2, "action_start", { actionId: "a1" }), ev(3, "catch", { actionId: "a1", species: "Bream", size: 31, fate: "keep" }), ev(4, "action_end")]);
  for (const m of marks(sqlite)) {
    assert.equal(m.trip_name, "Estuary", m.type);
    assert.equal(m.action_name, "Drift", m.type);
  }
  assert.equal(marks(sqlite).length, 1, "the catch is the only mark");
  // the catch with no running action carries neither
  await send(env, token, [ev(5, "catch", { species: "Bream", size: 30, fate: "keep" })]);
  const loose = sqlite.prepare("SELECT * FROM marks ORDER BY created_at DESC, rowid DESC LIMIT 1").get();
  assert.equal(loose.trip_name, null);

  const catchId = sqlite.prepare("SELECT id FROM marks WHERE type = 'Catch' AND action_name = 'Drift'").get().id;
  assert.equal((await update(env, token, "mark_update", 10, { markId: catchId, changes: { actionName: "Anchor", tripName: "Estuary" } }))[0].status, "created");
  const row = sqlite.prepare("SELECT * FROM marks WHERE id = ?").get(catchId);
  assert.equal(row.action_name, "Anchor");
  assert.equal((await update(env, token, "mark_update", 11, { markId: catchId, changes: { actionName: null } }))[0].status, "created");
  assert.equal(sqlite.prepare("SELECT action_name FROM marks WHERE id = ?").get(catchId).action_name, null);
  for (const [i, changes] of [{ tripName: "Nope" }, { actionName: "Not mine" }, { tripName: 5 }].entries()) {
    assert.equal((await update(env, token, "mark_update", 20 + i, { markId: catchId, changes }))[0].status, "rejected", JSON.stringify(changes));
  }

  // the site's own edit (PUT /api/marks) carries them too, as free text
  const put = await site(env, "PUT", `/api/marks/${catchId}`, { tripName: "Weekend away", actionName: "Anchor" });
  assert.equal(put.status, 200);
  const body = await put.json();
  assert.equal(body.tripName, "Weekend away");
  assert.equal(sqlite.prepare("SELECT trip_name FROM marks WHERE id = ?").get(catchId).trip_name, "Weekend away");
  assert.equal((await site(env, "PUT", `/api/marks/${catchId}`, { tripName: 7 })).status, 400);
});

test("mark_update: the date and time can be edited (and a bad one is refused)", async () => {
  const { sqlite, env, token } = await seeded();
  await send(env, token, [ev(1, "trip_start", { tripId: "t1" }), ev(2, "action_start", { actionId: "a1" }), ev(3, "catch", { actionId: "a1", species: "Bream", size: 30, fate: "keep" })]);
  const id = sqlite.prepare("SELECT id FROM marks WHERE type = 'Catch'").get().id;
  assert.equal((await update(env, token, "mark_update", 10, { markId: id, changes: { dateTime: "2026-10-02 10:25:00" } }))[0].status, "created");
  assert.equal(sqlite.prepare("SELECT date_time FROM marks WHERE id = ?").get(id).date_time, "2026-10-02 10:25:00");
  assert.equal((await update(env, token, "mark_update", 11, { markId: id, changes: { dateTime: "yesterday" } }))[0].status, "rejected");
});

test("action_update: rodSlots moves or swaps rod setups between the four positions; the config reports them", async () => {
  const { sqlite, env, token } = await seeded();
  let cfg = await (await api(env, token, "GET", "/api/controller/config")).json();
  assert.deepEqual(cfg.actions.find((a) => a.id === "a1").rodSlots, ["r1", "r2", null, null], "an action saved without positions is laid out from the first");
  const r = await update(env, token, "action_update", 1, { actionId: "a1", rodSlots: ["r2", null, null, "r1"] });
  assert.equal(r[0].status, "created");
  const row = actionRow(sqlite, "a1");
  assert.deepEqual(JSON.parse(row.rod_slots), ["r2", null, null, "r1"]);
  assert.deepEqual(JSON.parse(row.rod_setup_ids), ["r2", "r1"], "the plain list follows, in position order");
  cfg = await (await api(env, token, "GET", "/api/controller/config")).json();
  assert.deepEqual(cfg.actions.find((a) => a.id === "a1").rodSlots, ["r2", null, null, "r1"]);
  assert.deepEqual(cfg.actions.find((a) => a.id === "a1").rodSetupIds, ["r2", "r1"]);
  for (const [i, rodSlots] of [["r9", null, null, null], ["r1", "r1", "r1", "r1", "r1"], "r1", [5]].entries()) {
    assert.equal((await update(env, token, "action_update", 10 + i, { actionId: "a1", rodSlots }))[0].status, "rejected", JSON.stringify(rodSlots));
  }
});

// --- trip log (trip_log / trip_log_rods) -----------------------------------------------------------------------------

const logRows = (sqlite) => sqlite.prepare("SELECT * FROM trip_log ORDER BY ts, rowid").all();

test("trip log: a controller trip is logged with full states, and the data answers 'hours fished with a bait'", async () => {
  const { sqlite, env, token } = await seeded();
  await send(env, token, [
    ev(1, "trip_start", { tripId: "t1" }),
    ev(2, "action_start", { actionId: "a1", water: "Clear", depth: 3 }), // Drift: r1 (Prawn) + r2
  ]);
  await send(env, token, [
    ev(10, "catch", { actionId: "a1", species: "Bream", size: 31, fate: "keep", water: "Murky", depth: 3, rodSetupId: "r1" }), // water changed
    ev(20, "rodsetup_update", { rodSetupId: "r1", bait: ["Squid"] }),
    ev(30, "action_end", {}),
  ]);
  await send(env, token, [ev(40, "trip_end", { lat: null, lng: null })]);
  const rows = logRows(sqlite);
  assert.deepEqual(rows.map((r) => [r.event_type, r.change_field]), [
    ["trip_start", null], ["action_start", null], ["change", "water"], ["catch", null], ["change", "rod_setups"], ["action_end", null], ["trip_end", null],
  ]);
  assert.equal(new Set(rows.map((r) => r.run_id)).size, 1, "one run");
  assert.equal(rows[0].trip_name, "Estuary");
  assert.equal(rows[1].action_name, "Drift");
  assert.equal(rows[1].date_time, "2026-10-02 10:02:00");
  assert.equal(rows[1].water_condition, "Clear");
  assert.equal(rows[1].water_depth, 3);
  assert.equal(rows[1].berley, "Pilchard Mix");
  assert.deepEqual(JSON.parse(rows[1].targets), ["Bream"]);
  assert.equal(rows[1].mark_id, null, "an action has no mark of its own");
  assert.equal(rows[1].conditions_at, null, "weather/tide are backfilled later");
  assert.equal(rows[2].water_condition, "Murky");
  const catchRow = rows[3];
  assert.equal(catchRow.mark_id, sqlite.prepare("SELECT id FROM marks WHERE type = 'Catch'").get().id);
  assert.equal(catchRow.rod_setup_id, "r1");
  assert.equal(catchRow.species, "Bream");
  assert.equal(rows[5].lat, -38.1, "action_end: time and place only");
  assert.equal(rows[6].lat, null);

  const rods = (id) => sqlite.prepare("SELECT * FROM trip_log_rods WHERE log_id = ? ORDER BY slot").all(id);
  assert.deepEqual(rods(rows[1].id).map((r) => [r.slot, r.rod_setup_name, r.bait]), [[1, "Light", '["Prawn"]'], [2, "Lure", null]]);
  assert.deepEqual(rods(catchRow.id).map((r) => r.rod_setup_id), ["r1"], "a catch logs the setup it used");
  assert.deepEqual(rods(rows[4].id).map((r) => [r.rod_setup_id, r.bait]), [["r1", '["Squid"]'], ["r2", null]], "a change carries the whole new state");

  // hours with Squid: each state-carrying row lasts until the next row of the run
  const hours = sqlite.prepare(
    `SELECT SUM(next_ts - ts) / 3600000.0 AS h FROM (
       SELECT l.id, l.ts, LEAD(l.ts) OVER (PARTITION BY l.run_id ORDER BY l.ts, l.rowid) AS next_ts, l.event_type
       FROM trip_log l WHERE l.event_type NOT IN ('catch', 'trip_start')
     ) s WHERE next_ts IS NOT NULL AND event_type IN ('action_start', 'change')
       AND EXISTS (SELECT 1 FROM trip_log_rods r, json_each(r.bait) b WHERE r.log_id = s.id AND b.value = 'Squid')`
  ).get().h;
  assert.equal(hours, (30 - 20) / 60, "Squid was in force from the rod change (t+20 min) to the action end (t+30 min)");
});

test("trip log: a resent event is not logged twice; a catch with no trip running logs nothing", async () => {
  const { sqlite, env, token } = await seeded();
  await send(env, token, [ev(1, "catch", { actionId: "a1", species: "Bream", size: 31, fate: "keep" })]);
  assert.equal(logRows(sqlite).length, 0);
  await send(env, token, [ev(2, "trip_start", { tripId: "t1" })]);
  await send(env, token, [ev(2, "trip_start", { tripId: "t1" })]);
  assert.equal(logRows(sqlite).length, 1);
});

test("trip log: a trip started on the site (no run id) gets one at its first logged event, and keeps it", async () => {
  const { sqlite, env, token } = await seeded();
  sqlite.prepare("INSERT INTO user_prefs (user_id, key, value, updated_at) VALUES ('u1', 'liveActiveTrip', '{\"tripId\":\"t1\"}', 1)").run();
  await send(env, token, [ev(1, "action_start", { actionId: "a1" })]);
  await send(env, token, [ev(2, "catch", { actionId: "a1", species: "Bream", size: 31, fate: "keep" })]);
  assert.equal(new Set(logRows(sqlite).map((r) => r.run_id)).size, 1);
  assert.equal(stateOf(sqlite).runId, logRows(sqlite)[0].run_id);
});

test("/api/triplog: the site posts entries (idempotent), reads a run by mark, and backfills conditions", async () => {
  const { sqlite, env, token } = await seeded();
  await send(env, token, [ev(1, "trip_start", { tripId: "t1" }), ev(2, "action_start", { actionId: "a1" }), ev(3, "catch", { actionId: "a1", species: "Bream", size: 31, fate: "keep" })]);
  const startMark = sqlite.prepare("SELECT id FROM marks WHERE type = 'Catch'").get().id;
  const run = logRows(sqlite)[0].run_id;

  const entry = {
    uuid: "site-1", runId: run, type: "change", changeField: "depth", ts: NOW - 3600000, dateTime: "2026-10-02 11:00:00", tzOffsetMin: 600, lat: -38.3, lng: 145.4,
    tripId: "t1", tripName: "Estuary", actionId: "a1", actionName: "Drift", water: "Clear", depth: 6,
    rods: [{ slot: 1, rodSetupId: "r1", name: "Light", rod: "L Wilson", rig: "Paternoster", bait: ["Prawn"] }],
  };
  const post = (events) => site(env, "POST", "/api/triplog", { events });
  assert.equal((await post([entry])).status, 200);
  assert.equal((await post([entry])).status, 200);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log WHERE source = 'Site'").get().n, 1, "idempotent on uuid");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log_rods WHERE rod_setup_id = 'r1' AND bait = '[\"Prawn\"]'").get().n >= 1, true);
  const bad = await (await post([{ ...entry, uuid: "site-2", type: "nope" }])).json();
  assert.equal(bad.results[0].status, "rejected");

  const read = await (await site(env, "GET", `/api/triplog?markId=${startMark}`)).json();
  assert.equal(read.runId, run);
  assert.deepEqual(read.entries.map((e) => e.type), ["trip_start", "action_start", "catch", "change"]);
  assert.equal(read.entries.find((e) => e.type === "change").rods[0].bait[0], "Prawn");
  assert.equal((await (await site(env, "GET", `/api/triplog?markId=${startMark}`, undefined, "s-u2")).json()).runId, null, "not someone else's");

  // backfill: rows older than 20 min with no conditions yet; the controller's position-less trip_start borrows a neighbour's
  const todo = await (await site(env, "GET", "/api/triplog?needsConditions=1")).json();
  assert.ok(todo.some((r) => r.dateTime === "2026-10-02 11:00:00"));
  const id = todo.find((r) => r.dateTime === "2026-10-02 11:00:00").id;
  assert.equal((await site(env, "PUT", `/api/triplog/${id}`, { tideCondition: "Rising" })).status, 405);
  assert.equal((await site(env, "PATCH", `/api/triplog/${id}`, { tideCondition: "Rising", windSpeed: 12, barometer: "x" })).status, 400);
  assert.equal((await site(env, "PATCH", `/api/triplog/${id}`, { tideCondition: "Rising", windSpeed: 12 })).status, 200);
  const done = sqlite.prepare("SELECT tide_condition, wind_speed, conditions_at FROM trip_log WHERE id = ?").get(id);
  assert.deepEqual([done.tide_condition, done.wind_speed], ["Rising", 12]);
  assert.ok(done.conditions_at);
  assert.equal((await site(env, "PATCH", `/api/triplog/${id}`, { tideCondition: "Falling" }, "s-u2")).status, 404);
  assert.equal((await (await site(env, "GET", "/api/triplog?needsConditions=1")).json()).some((r) => r.id === id), false);
});

// --- trip log backfill (past trips; the phone's events list) -------------------------------------------------------------

const tripLogViewSrc = fs.readFileSync(new URL("../js/trip-log-view.js", import.meta.url), "utf8");
const tripLogView = new Function(tripLogViewSrc + "\nreturn { tripLogDurations };")();
const BF_DEV = "bf-dev";
const BF_RUN = "run_1791066700234_abcde";
/** A trip like a real one on the daylight-saving change day (Melbourne: UTC+10 until 02:00 on 2026-10-04, UTC+11 after): trip start, Drift
 * (edited mid-way, one catch), Anchor, trip end, with the marks the Worker made and the events it got — some uploaded late. */
async function bfSeeded() {
  const base = await seeded();
  const { sqlite } = base;
  const mark = (id, type, local, seq, suffix, f) =>
    sqlite
      .prepare(
        "INSERT INTO marks (id, user_id, lat, lng, name, type, date_time, source, source_uuid, species, bait, rig, rod, berley, size, released, fishing_method, water_condition, water_depth, trip_name, action_name, trip_run_id, session_group_id, created_at) VALUES (?, 'u1', -38.1, 145.2, ?, ?, ?, 'Controller', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Estuary', ?, ?, ?, 1)"
      )
      .run(id, id, type, local, `fc:${BF_DEV}:${seq}${suffix}`, f.species ?? null, f.bait ?? null, f.rig ?? null, f.rod ?? null, f.berley ?? null, f.size ?? null, f.released ?? null, f.method ?? null, f.water ?? null, f.depth ?? null, f.action, BF_RUN, f.group ?? null);
  const drift = { action: "Drift", species: "Bream", bait: "Prawn, Squid", rig: "Paternoster, Jig Head", rod: "L Wilson, L Raider", berley: "Pilchard Mix", method: "Drifting", water: "Clear", depth: 4, group: "g1" };
  mark("mS1", "Session Start", "2026-10-04 09:37:45", 2, ":start", drift);
  mark("mC1", "Catch", "2026-10-04 10:54:05", 4, "", { action: "Drift", species: "Bream", size: 31, bait: "Squid", rig: "Paternoster", rod: "L Wilson", water: "Murky", depth: 3 });
  mark("mE1", "Session End", "2026-10-04 11:30:00", 5, ":end", { ...drift, water: "Murky", depth: 3 });
  mark("mS2", "Session Start", "2026-10-04 11:40:00", 6, ":start", { action: "Anchor", species: "Flathead", bait: "Prawn", rig: "Paternoster", rod: "L Wilson", water: "Murky", depth: 3, group: "g2" });
  mark("mE2", "Session End", "2026-10-04 12:10:00", 7, ":end", { action: "Anchor", species: "Flathead", bait: "Prawn", rig: "Paternoster", rod: "L Wilson", water: "Murky", depth: 2, group: "g2" });
  const event = (seq, type, receivedIso) => sqlite.prepare("INSERT INTO controller_events (user_id, device_id, seq, type, received_at) VALUES ('u1', ?, ?, ?, ?)").run(BF_DEV, seq, type, Date.parse(receivedIso));
  event(1, "trip_start", "2026-10-03T22:31:40Z");
  event(2, "action_start", "2026-10-03T22:50:38Z"); // uploaded 13 minutes after the 22:37:45Z mark
  event(3, "action_update", "2026-10-03T23:27:13Z");
  event(4, "catch", "2026-10-03T23:54:05Z");
  event(5, "action_end", "2026-10-04T00:30:00Z");
  event(6, "action_start", "2026-10-04T00:40:00Z");
  event(7, "trip_end", "2026-10-04T01:10:00Z"); // closed the running Anchor session: that Session End is its mark
  sqlite.prepare("INSERT INTO controller_track (user_id, device_id, ts, lat, lng, acc, trip_id) VALUES ('u1', ?, ?, -38.5, 145.9, 5, 't1')").run(BF_DEV, Date.parse("2026-10-03T22:31:00Z") / 1000);
  return base;
}
const tlog = (sqlite) => sqlite.prepare("SELECT * FROM trip_log WHERE run_id = ? ORDER BY ts, rowid").all(BF_RUN);
const tlogTypes = (rows) => rows.map((r) => r.event_type + (r.change_field ? `:${r.change_field}` : ""));

test("trip log backfill: a past run is rebuilt from its marks and events, flagged, repeatable, and never over live rows", async () => {
  const { sqlite, env } = await bfSeeded();
  const res = await site(env, "POST", "/api/triplog/backfill", {});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { runs: 1, rows: 7, skipped: 0, remaining: 0 });

  const rows = tlog(sqlite);
  assert.deepEqual(tlogTypes(rows), ["trip_start", "action_start", "change:water+depth", "catch", "action_end", "action_start", "trip_end"]);
  assert.ok(rows.every((r) => r.source === "Backfill" && r.source_uuid.startsWith(`bf:${BF_DEV}:`)));

  const start = rows[1];
  assert.equal(start.ts, Date.UTC(2026, 9, 3, 22, 37, 45), "09:37:45 local on the daylight-saving change day is UTC+11");
  assert.equal(start.tz_offset_min, 660);
  assert.equal(start.date_time, "2026-10-04 09:37:45");
  assert.equal(start.mark_id, "mS1");
  assert.equal(start.action_id, "a1");
  assert.equal(start.trip_id, "t1");
  assert.equal(start.berley, "Pilchard Mix");
  assert.deepEqual([start.water_condition, start.water_depth], ["Clear", 4]);
  const rods = sqlite.prepare("SELECT * FROM trip_log_rods WHERE log_id = ? ORDER BY slot").all(start.id);
  assert.deepEqual(rods.map((r) => [r.rod_setup_id, r.rod, r.rig]), [["r1", "L Wilson", "Paternoster"], ["r2", "L Raider", "Jig Head"]]);
  assert.ok(rods.every((r) => r.bait === '["Prawn","Squid"]'), "each rod row carries the mark's whole bait list");

  assert.equal(rows[0].ts, Date.parse("2026-10-03T22:31:40Z"), "no mark: when the Worker received it");
  assert.deepEqual([rows[0].lat, rows[0].lng], [-38.5, 145.9], "position from the nearest track fix");
  assert.deepEqual([rows[2].water_condition, rows[2].water_depth], ["Murky", 3], "the catch's water/depth differs from the Start's, as the live log would note");
  assert.equal(rows[3].mark_id, "mC1");
  assert.equal(rows[3].rod_setup_id, "r1");
  assert.equal(rows[6].ts, Date.UTC(2026, 9, 4, 1, 10, 0), "its time is the Session End it made");
  assert.equal(rows[6].date_time, "2026-10-04 12:10:00");

  const again = await (await site(env, "POST", "/api/triplog/backfill", {})).json();
  assert.equal(again.rows, 7);
  assert.equal(tlog(sqlite).length, 7, "repeating replaces, never doubles");

  sqlite.prepare("UPDATE trip_log SET source = 'Controller' WHERE id = ?").run(rows[0].id);
  const skipped = await (await site(env, "POST", "/api/triplog/backfill", {})).json();
  assert.deepEqual([skipped.runs, skipped.skipped], [0, 1], "a run the live log already has is left alone");
  assert.equal((await site(env, "POST", "/api/triplog/backfill", {}, "s-u2").then((r) => r.json())).runs, 0, "not someone else's");
});

test("trip log history: the phone's events list gives exact times and the edit made mid-action; replaying is harmless", async () => {
  const { sqlite, env, token } = await bfSeeded();
  const T = (iso) => Date.parse(iso) / 1000;
  const dto = (seq, type, iso, extra = {}) => ({ deviceId: BF_DEV, seq, type, ts: T(iso), tzOffsetMin: 660, lat: -38.2, lng: 145.3, ...extra });
  const events = [
    dto(1, "trip_start", "2026-10-03T22:30:10Z", { tripId: "t1", water: "Clear", depth: 4 }),
    dto(2, "action_start", "2026-10-03T22:37:45Z", { actionId: "a1" }),
    dto(3, "action_update", "2026-10-03T23:27:00Z", { actionId: "a1", berley: "Bread", rodSlots: ["r2", "r1", null, null] }),
    dto(4, "catch", "2026-10-03T23:54:05Z", { actionId: "a1", species: "Bream" }),
    dto(5, "action_end", "2026-10-04T00:30:00Z"),
    dto(6, "action_start", "2026-10-04T00:40:00Z", { actionId: "a2" }),
    dto(7, "trip_end", "2026-10-04T01:10:00Z"),
    { deviceId: BF_DEV, seq: -1, type: "nope", ts: 1 },
  ];
  await site(env, "POST", "/api/triplog/backfill", {}); // the approximations first, as the user would have
  const marksBefore = sqlite.prepare("SELECT COUNT(*) AS n FROM marks").get().n;
  const stateBefore = sqlite.prepare("SELECT value FROM user_prefs WHERE user_id = 'u1' AND key = 'liveActiveTrip'").get();

  const res = await api(env, token, "POST", "/api/controller/history", { deviceId: BF_DEV, events });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.runs, 1);
  assert.deepEqual(out.skipped.map((s) => s.seq), [-1]);

  const rows = tlog(sqlite);
  assert.ok(rows.every((r) => r.source === "Controller" && r.source_uuid.startsWith(`fc:${BF_DEV}:`)), "the ids the live log uses; the approximations are gone");
  assert.deepEqual(tlogTypes(rows), ["trip_start", "action_start", "change:action", "change:water+depth", "catch", "action_end", "action_start", "trip_end"]);
  assert.equal(rows[0].ts, T("2026-10-03T22:30:10Z") * 1000, "the trip really started 90 s before the Worker heard of it");
  assert.equal(rows[0].water_condition, "Clear");
  const edit = rows[2];
  assert.equal(edit.ts, T("2026-10-03T23:27:00Z") * 1000);
  assert.equal(edit.berley, "Bread");
  assert.deepEqual(sqlite.prepare("SELECT slot, rod_setup_id FROM trip_log_rods WHERE log_id = ? ORDER BY slot").all(edit.id).map((r) => [r.slot, r.rod_setup_id]), [[1, "r2"], [2, "r1"]], "the new rod positions");
  assert.equal(rows[7].lat, -38.2, "the phone's position");

  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM marks").get().n, marksBefore, "no marks");
  assert.deepEqual(sqlite.prepare("SELECT value FROM user_prefs WHERE user_id = 'u1' AND key = 'liveActiveTrip'").get(), stateBefore, "no trip state change");
  const n = rows.length;
  await api(env, token, "POST", "/api/controller/history", { deviceId: BF_DEV, events });
  assert.equal(tlog(sqlite).length, n, "a second upload changes nothing");
  assert.equal((await api(env, token, "POST", "/api/controller/history", { deviceId: BF_DEV, events: [] })).status, 400);
  assert.ok([401, 403].includes((await api(env, null, "POST", "/api/controller/history", { deviceId: BF_DEV, events })).status), "no token: refused");
});

test("trip log headers (GET /api/triplog?list=1): one row per run with counts, times, the fished time the lines add up to, and the flags", async () => {
  const { sqlite, env } = await bfSeeded();
  await site(env, "POST", "/api/triplog/backfill", {});

  const list = await (await site(env, "GET", "/api/triplog?list=1")).json();
  assert.equal(list.length, 1);
  const h = list[0];
  assert.equal(h.runId, BF_RUN);
  assert.equal(h.tripName, "Estuary");
  assert.deepEqual([h.entries, h.actions, h.catches, h.hasTripEnd], [7, 2, 1, true]);
  assert.equal(h.startDateTime, "2026-10-04 09:31:40");
  assert.equal(h.endDateTime, "2026-10-04 12:10:00", "ends at its last row");
  assert.equal(h.approximate, true, "the trip start/end came from when the Worker heard of them");
  assert.equal(h.pending, true, "weather/tide still to come");

  // the header's fished time is what the lines add up to (same rule in the SQL and in js/trip-log-view.js)
  const lines = await (await site(env, "GET", `/api/triplog?runId=${BF_RUN}`)).json();
  const fromLines = [...tripLogView.tripLogDurations(lines.entries).values()].reduce((a, b) => a + b, 0);
  assert.ok(h.fishedMs > 0);
  assert.equal(h.fishedMs, fromLines);

  // exact (history) rows are no longer approximate, and once the cron has filled the conditions nothing is pending
  sqlite.prepare("UPDATE trip_log SET source = 'Controller', conditions_at = 1").run();
  const exact = (await (await site(env, "GET", "/api/triplog?list=1")).json())[0];
  assert.deepEqual([exact.approximate, exact.pending], [false, false]);

  // filtering on the run's start date, and nobody else's runs
  assert.equal((await (await site(env, "GET", "/api/triplog?list=1&from=2026-10-04&to=2026-10-04")).json()).length, 1);
  assert.equal((await (await site(env, "GET", "/api/triplog?list=1&from=2026-10-05")).json()).length, 0);
  assert.equal((await (await site(env, "GET", "/api/triplog?list=1&to=2026-10-03")).json()).length, 0);
  assert.equal((await (await site(env, "GET", "/api/triplog?list=1", undefined, "s-u2")).json()).length, 0, "not someone else's");
  assert.equal((await site(env, "GET", "/api/triplog?list=1", undefined, "nobody")).status, 401);
});

// --- editing the log by hand (the Trip Logs tab) ------------------------------------------------------------------------------

test("trip log edit (PATCH /api/triplog/<id>): fields, the time, the rod rows; clearing; validation; only your own lines", async () => {
  const { sqlite, env } = await bfSeeded();
  await site(env, "POST", "/api/triplog/backfill", {});
  const line = tlog(sqlite).find((r) => r.event_type === "action_start" && r.action_name === "Drift");
  const patch = (id, body, session) => site(env, "PATCH", `/api/triplog/${id}`, { manual: true, ...body }, session);

  const res = await patch(line.id, {
    dateTime: "2026-10-04 09:40:00", type: "change", changeField: "rod_setups", actionName: "Drift 2", waterCondition: "Murky", waterDepth: 5.5, berley: "Bread",
    fishingMethod: ["Drifting", "Anchored"], targets: ["Bream"], lat: -38.3, lng: 145.4, tideCondition: "Slack High", tideExtreme: "HHW", weatherCondition: "Rain",
    windSpeed: 20, windDirection: "N", barometer: 1010.5, temperature: 11, waterTemperature: 14,
    rods: [
      { slot: 2, rodSetupId: "r1", name: "Light", rod: "L Wilson", rig: "Paternoster", rigOptions: ["Octopus 3/0"], bait: ["Squid"], baitOptions: ["Wing Strip"] },
      { rod: "L Raider", rig: "Jig Head", bait: ["Prawn"] },
    ],
  });
  assert.equal(res.status, 200);
  const edited = sqlite.prepare("SELECT * FROM trip_log WHERE id = ?").get(line.id);
  assert.deepEqual([edited.event_type, edited.change_field, edited.action_name, edited.water_condition, edited.water_depth, edited.berley], ["change", "rod_setups", "Drift 2", "Murky", 5.5, "Bread"]);
  assert.deepEqual([JSON.parse(edited.fishing_method), JSON.parse(edited.targets)], [["Drifting", "Anchored"], ["Bream"]]);
  assert.deepEqual([edited.lat, edited.lng, edited.tide_condition, edited.tide_extreme, edited.weather_condition, edited.wind_speed, edited.wind_direction, edited.barometer, edited.temperature, edited.water_temperature],
    [-38.3, 145.4, "Slack High", "HHW", "Rain", 20, "N", 1010.5, 11, 14]);
  assert.equal(edited.date_time, "2026-10-04 09:40:00");
  assert.equal(edited.ts, Date.UTC(2026, 9, 3, 22, 40, 0), "09:40 local on the daylight-saving change day is UTC+11");
  assert.equal(edited.tz_offset_min, 660);
  assert.ok(edited.edited_at, "marked as edited by hand");
  assert.ok(edited.conditions_at, "its conditions are now yours: the backfills leave them");
  const rods = sqlite.prepare("SELECT * FROM trip_log_rods WHERE log_id = ? ORDER BY slot").all(line.id);
  assert.deepEqual(rods.map((r) => [r.slot, r.rod_setup_id, r.rod, r.rig, r.rig_options, r.bait, r.bait_options]), [
    [1, null, "L Raider", "Jig Head", null, '["Prawn"]', null],
    [2, "r1", "L Wilson", "Paternoster", '["Octopus 3/0"]', '["Squid"]', '["Wing Strip"]'],
  ], "the whole list replaces the old rows; a rod with no position takes the first free one");

  // the page sends the id percent-encoded (it holds colons), which must find the same line
  assert.ok(line.id.includes(":"));
  assert.equal((await patch(encodeURIComponent(line.id), { actionName: "Drift 3" })).status, 200);
  assert.equal(sqlite.prepare("SELECT action_name FROM trip_log WHERE id = ?").get(line.id).action_name, "Drift 3");

  // clearing, with the manual flag (the browser's weather backfill never clears)
  await patch(line.id, { berley: "", waterDepth: null, tideCondition: null, targets: [], released: null, rods: [] });
  const cleared = sqlite.prepare("SELECT * FROM trip_log WHERE id = ?").get(line.id);
  assert.deepEqual([cleared.berley, cleared.water_depth, cleared.tide_condition, cleared.targets, cleared.water_condition], [null, null, null, null, "Murky"], "only what was named");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log_rods WHERE log_id = ?").get(line.id).n, 0);

  // the weather/tide backfill's own use of PATCH is unchanged: no manual flag, blanks skipped, never marks a line as edited
  const other = tlog(sqlite).find((r) => r.event_type === "catch");
  await site(env, "PATCH", `/api/triplog/${other.id}`, { tideCondition: "Rising", windSpeed: 12, weatherCondition: "" });
  const fromBackfill = sqlite.prepare("SELECT * FROM trip_log WHERE id = ?").get(other.id);
  assert.deepEqual([fromBackfill.tide_condition, fromBackfill.wind_speed, fromBackfill.weather_condition], ["Rising", 12, null]);
  assert.equal(fromBackfill.edited_at, null);
  assert.ok(fromBackfill.conditions_at);

  for (const bad of [{ dateTime: "yesterday" }, { type: "nope" }, { waterDepth: 5000 }, { waterDepth: "deep" }, { lat: 120 }, { targets: "Bream" }, { rods: "x" }, { rods: [{ bait: "Squid" }] }, { actionName: "x".repeat(500) }]) {
    assert.equal((await patch(line.id, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await patch("tl_nope", { berley: "x" })).status, 404);
  assert.equal((await patch(line.id, { berley: "x" }, "s-u2")).status, 404, "not someone else's line");
  assert.equal(sqlite.prepare("SELECT berley FROM trip_log WHERE id = ?").get(line.id).berley, null);
});

test("trip log lines: add one by hand (POST /api/triplog/lines), delete one; a hand-edited run is never rebuilt over", async () => {
  const { sqlite, env, token } = await bfSeeded();
  await site(env, "POST", "/api/triplog/backfill", {});
  const before = tlog(sqlite).length;

  const add = await site(env, "POST", "/api/triplog/lines", {
    runId: BF_RUN, type: "catch", dateTime: "2026-10-04T11:05", species: "Bream", size: 28, released: true, waterCondition: "Murky",
    rods: [{ rodSetupId: "r1", name: "Light", rod: "L Wilson", rig: "Paternoster", bait: ["Squid"] }],
  });
  assert.equal(add.status, 201);
  const { id } = await add.json();
  const row = sqlite.prepare("SELECT * FROM trip_log WHERE id = ?").get(id);
  assert.deepEqual([row.run_id, row.trip_name, row.event_type, row.species, row.size, row.released, row.source], [BF_RUN, "Estuary", "catch", "Bream", 28, 1, "Manual"]);
  assert.equal(row.date_time, "2026-10-04 11:05:00");
  assert.ok(row.edited_at);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log_rods WHERE log_id = ?").get(id).n, 1);
  assert.equal(tlog(sqlite).length, before + 1);
  const lines = await (await site(env, "GET", `/api/triplog?runId=${BF_RUN}`)).json();
  const mine = lines.entries.find((e) => e.id === id);
  assert.deepEqual([mine.species, mine.rods[0].bait, mine.editedAt > 0], ["Bream", ["Squid"], true]);
  assert.equal(lines.entries.indexOf(mine) > 0 && lines.entries[lines.entries.indexOf(mine) - 1].ts <= mine.ts, true, "in time order");
  assert.equal((await (await site(env, "GET", "/api/triplog?list=1")).json())[0].edited, true);

  assert.equal((await site(env, "POST", "/api/triplog/lines", { runId: "nope", type: "catch", dateTime: "2026-10-04 11:05:00" })).status, 404);
  assert.equal((await site(env, "POST", "/api/triplog/lines", { runId: BF_RUN, type: "catch" })).status, 400, "a time is required");
  assert.equal((await site(env, "POST", "/api/triplog/lines", { runId: BF_RUN, type: "wrong", dateTime: "2026-10-04 11:05:00" })).status, 400);
  assert.equal((await site(env, "POST", "/api/triplog/lines", { runId: BF_RUN, type: "catch", dateTime: "2026-10-04 11:05:00" }, "s-u2")).status, 404, "not someone else's trip");

  // the automatic rebuilds leave an edited run alone: the Settings backfill, and the phone's history upload
  const again = await (await site(env, "POST", "/api/triplog/backfill", {})).json();
  assert.deepEqual([again.runs, again.skipped], [0, 1]);
  assert.equal(tlog(sqlite).length, before + 1, "nothing was replaced");
  const hist = await api(env, token, "POST", "/api/controller/history", { deviceId: BF_DEV, events: [{ deviceId: BF_DEV, seq: 1, type: "trip_start", ts: Date.parse("2026-10-03T22:30:10Z") / 1000, tzOffsetMin: 660, tripId: "t1" }] });
  assert.equal((await hist.json()).runs, 0);
  assert.equal(tlog(sqlite).length, before + 1);

  // delete
  assert.equal((await site(env, "DELETE", `/api/triplog/${id}`, undefined, "s-u2")).status, 404);
  assert.equal((await site(env, "DELETE", `/api/triplog/${id}`)).status, 204);
  // deleting only marks the line: it is hidden at once but kept (with its rod rows) until it is 30 days old
  assert.ok(sqlite.prepare("SELECT deleted_at FROM trip_log WHERE id = ?").get(id).deleted_at > 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log_rods WHERE log_id = ?").get(id).n, 1, "its rod rows stay until the purge");
  const after = await (await site(env, "GET", `/api/triplog?runId=${BF_RUN}`)).json();
  assert.equal(after.entries.some((e) => e.id === id), false, "hidden from the trip");
  assert.equal((await site(env, "DELETE", `/api/triplog/${id}`)).status, 404, "already deleted");
  assert.equal((await site(env, "PATCH", `/api/triplog/${id}`, { species: "Bass", manual: true })).status, 404, "and not editable");
  await runPurge(env, sqlite, id);
});

/** The hourly cron: a line deleted less than 30 days ago stays, one deleted longer ago goes with its rod rows. */
async function runPurge(env, sqlite, id) {
  await worker.scheduled({}, env, { waitUntil: () => {} });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log WHERE id = ?").get(id).n, 1, "just deleted: still there");
  sqlite.prepare("UPDATE trip_log SET deleted_at = ? WHERE id = ?").run(Date.now() - 31 * 86400000, id);
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log WHERE id = ?").get(id).n, 0, "removed once 30 days old");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log_rods WHERE log_id = ?").get(id).n, 0, "with its rod rows");
}

test("the trash: deleted trips and lines are listed, restorable, and a restored trip is never rebuilt over", async () => {
  const { sqlite, env } = await legacySeeded();
  await site(env, "POST", "/api/triplog/backfill-legacy", {});
  const live = sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log WHERE run_id = 'legacy:a1S'").get().n;
  assert.deepEqual(await (await site(env, "GET", "/api/triplog?deleted=1")).json(), [], "nothing deleted yet");

  // a single line of a trip
  const line = sqlite.prepare("SELECT id FROM trip_log WHERE run_id = 'legacy:a1S' AND event_type = 'catch' LIMIT 1").get();
  assert.equal((await site(env, "DELETE", `/api/triplog/${encodeURIComponent(line.id)}`)).status, 204);
  let trash = await (await site(env, "GET", "/api/triplog?deleted=1")).json();
  assert.equal(trash.length, 1);
  assert.deepEqual([trash[0].runId, trash[0].lines, trash[0].keptLines], ["legacy:a1S", 1, live - 1], "a deleted line of a trip that is otherwise kept");
  assert.ok(trash[0].purgeAt > Date.now() + 29 * 86400000 && trash[0].purgeAt < Date.now() + 31 * 86400000, "removed for good 30 days after deleting");
  assert.equal((await (await site(env, "GET", "/api/triplog?deleted=1", undefined, "s-u2")).json()).length, 0, "only your own trash");

  // the whole trip
  assert.equal((await site(env, "DELETE", "/api/triplog/run?runId=legacy%3Aa1S")).status, 200);
  trash = await (await site(env, "GET", "/api/triplog?deleted=1")).json();
  assert.deepEqual([trash[0].lines, trash[0].keptLines], [live, 0], "the whole trip");

  assert.equal((await site(env, "POST", "/api/triplog/restore", { runId: "nope" })).status, 404);
  assert.equal((await site(env, "POST", "/api/triplog/restore", {})).status, 400);
  assert.equal((await site(env, "POST", "/api/triplog/restore", { runId: "legacy:a1S" }, "s-u2")).status, 404, "not someone else's");
  assert.equal((await site(env, "POST", "/api/triplog/restore", { runId: "legacy:a1S" })).status, 200);
  assert.deepEqual(await (await site(env, "GET", "/api/triplog?deleted=1")).json(), []);
  assert.equal((await (await site(env, "GET", "/api/triplog?runId=legacy%3Aa1S")).json()).entries.length, live, "all lines are back");
  assert.ok((await (await site(env, "GET", "/api/triplog?list=1")).json()).some((r) => r.runId === "legacy:a1S"), "and the trip is in the list");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log WHERE run_id = 'legacy:a1S' AND edited_at IS NULL").get().n, 0, "marked edited so no backfill rebuilds it");
  assert.equal((await site(env, "POST", "/api/triplog/restore", { runId: "legacy:a1S" })).status, 404, "nothing left to restore");
});

// --- Legacy sessions (made before trips existed) -> trip log -------------------------------------------------------------------------
async function legacySeeded() {
  const base = await seeded();
  const { sqlite } = base;
  const mark = (id, type, local, f = {}) =>
    sqlite
      .prepare(
        "INSERT INTO marks (id, user_id, lat, lng, name, type, date_time, source, species, bait, rig, rod, berley, size, released, fishing_method, water_condition, water_depth, session_group_id, created_at) VALUES (?, 'u1', ?, 145.2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)"
      )
      .run(id, f.lat ?? -38.1, id, type, local, f.source ?? "Manual", f.species ?? null, f.bait ?? null, f.rig ?? null, f.rod ?? null, f.berley ?? null, f.size ?? null, f.released ?? null, f.method ?? null, f.water ?? null, f.depth ?? null, f.group ?? null);
  // trip 1 (2026-03-07): two sessions an hour apart (one trip), a catch in each, a catch after the day's last End (left alone)
  mark("a1S", "Session Start", "2026-03-07 07:00:00", { group: "ga", species: "Bream", bait: "Prawn", rod: "L Wilson", rig: "Paternoster", water: "Clear", depth: 3 });
  mark("a1C", "Catch", "2026-03-07 07:40:00", { species: "Bream", size: 30, bait: "Prawn", rod: "L Wilson", water: "Murky", depth: 3 });
  mark("a1E", "Session End", "2026-03-07 08:30:00", { group: "ga", water: "Murky", depth: 3 });
  mark("a2S", "Session Start", "2026-03-07 09:30:00", { group: "gb", species: "Flathead", bait: "Squid", rod: "L Wilson", water: "Murky", depth: 3, source: "trail-import" });
  mark("a2C", "Catch", "2026-03-07 10:00:00", { species: "Flathead", size: 41, released: 1, water: "Murky", depth: 3 });
  mark("a2E", "Session End", "2026-03-07 11:00:00", { group: "gb", water: "Murky", depth: 3, source: "trail-import" });
  mark("zC", "Catch", "2026-03-07 20:00:00", { species: "Bream", size: 25 });
  // trip 2 (next day): an orphan Start whose catch falls within 12 h of it
  mark("b1S", "Session Start", "2026-03-08 07:00:00", { group: "gc", species: "Bream" });
  mark("b1C", "Catch", "2026-03-08 09:00:00", { species: "Bream", size: 28 });
  // a Controller-made session is not legacy
  mark("cS", "Session Start", "2026-03-09 07:00:00", { group: "gd", source: "Controller" });
  return base;
}
const legacyRows = (sqlite, runId) => sqlite.prepare("SELECT * FROM trip_log WHERE run_id = ? ORDER BY ts, rowid").all(runId);

test("legacy backfill: sessions chain into trips, catches join the session holding them, rows are flagged, repeatable", async () => {
  const { sqlite, env } = await legacySeeded();
  const res = await site(env, "POST", "/api/triplog/backfill-legacy", {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual({ runs: body.runs, remaining: body.remaining, unassignedCatches: body.unassignedCatches }, { runs: 2, remaining: 0, unassignedCatches: 1 });

  const t1 = legacyRows(sqlite, "legacy:a1S");
  assert.deepEqual(t1.map((r) => r.event_type + (r.change_field ? ":" + r.change_field : "")), [
    "trip_start", "action_start", "change:water", "catch", "action_end", "action_start", "catch", "action_end", "trip_end",
  ]);
  assert.ok(t1.every((r) => r.source === "Backfill" && r.source_uuid.startsWith("bf:legacy:")));
  assert.equal(t1[0].mark_id, null); // synthesized: flagged approximate
  assert.equal(t1[1].mark_id, "a1S");
  assert.equal(t1[1].date_time, "2026-03-07 07:00:00");
  assert.equal(t1[1].tz_offset_min, 660); // Melbourne daylight saving in March
  assert.equal(t1[3].mark_id, "a1C");
  assert.equal(t1[3].species, "Bream");
  assert.equal(t1[6].released, 1);
  assert.equal(t1[8].date_time, "2026-03-07 11:00:00");
  const rods = sqlite.prepare("SELECT rod, rig, bait FROM trip_log_rods WHERE log_id = ?").all(t1[1].id);
  assert.deepEqual(rods.map((r) => [r.rod, r.rig, JSON.parse(r.bait)]), [["L Wilson", "Paternoster", ["Prawn"]]]);

  const t2 = legacyRows(sqlite, "legacy:b1S");
  assert.deepEqual(t2.map((r) => r.event_type), ["trip_start", "action_start", "catch", "trip_end"]);
  assert.equal(t2[3].date_time, "2026-03-08 09:00:00"); // an orphan Start has no End mark: the trip ends at its last Catch
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log WHERE run_id LIKE 'legacy:c%'").get().n, 0); // Controller session untouched
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log WHERE mark_id = 'zC'").get().n, 0);

  const again = await (await site(env, "POST", "/api/triplog/backfill-legacy", {})).json();
  assert.equal(again.runs, 0);
  assert.equal(again.rows, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log").get().n, t1.length + t2.length);
});

test("legacy backfill: marks that already have a log row (and their session) are left alone", async () => {
  const { sqlite, env } = await legacySeeded();
  sqlite
    .prepare("INSERT INTO trip_log (id, user_id, run_id, event_type, ts, date_time, mark_id, source, source_uuid, created_at) VALUES ('tl_x', 'u1', 'live-1', 'action_start', 1, '2026-03-07 07:00:00', 'a1S', 'Site', 'x1', 1)")
    .run();
  const body = await (await site(env, "POST", "/api/triplog/backfill-legacy", {})).json();
  assert.equal(body.runs, 2); // session ga is skipped whole (its Start has a row); gb and gc still become trips
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log WHERE mark_id IN ('a1S', 'a1E', 'a1C')").get().n, 1);
});

test("legacy backfill: signed-out is refused and another user's marks are not touched", async () => {
  const { sqlite, env } = await legacySeeded();
  const res = await api(env, null, "POST", "/api/triplog/backfill-legacy", {}, { Origin: SITE });
  assert.equal(res.status, 401);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log").get().n, 0);
});

test("naming a trip: every line of the run takes the name and is marked edited; blank clears; only your own trips", async () => {
  const { sqlite, env } = await legacySeeded();
  await site(env, "POST", "/api/triplog/backfill-legacy", {});
  const res = await site(env, "PATCH", "/api/triplog/run", { runId: "legacy:a1S", tripName: "  Lang Lang flathead day  " });
  assert.equal(res.status, 200);
  const rows = legacyRows(sqlite, "legacy:a1S");
  assert.ok(rows.length > 3);
  assert.ok(rows.every((r) => r.trip_name === "Lang Lang flathead day" && r.edited_at));
  assert.equal(legacyRows(sqlite, "legacy:b1S").some((r) => r.trip_name), false); // another run untouched
  const list = await (await site(env, "GET", "/api/triplog?list=1")).json();
  assert.equal(list.find((r) => r.runId === "legacy:a1S").tripName, "Lang Lang flathead day");
  assert.equal((await site(env, "PATCH", "/api/triplog/run", { runId: "legacy:a1S", tripName: "" })).status, 200);
  assert.ok(legacyRows(sqlite, "legacy:a1S").every((r) => r.trip_name === null));
  assert.equal((await site(env, "PATCH", "/api/triplog/run", { runId: "nope", tripName: "x" })).status, 404);
  assert.equal((await site(env, "PATCH", "/api/triplog/run", { runId: "legacy:a1S", tripName: "x".repeat(81) })).status, 400);
  assert.equal((await site(env, "PATCH", "/api/triplog/run", { runId: "legacy:a1S", tripName: "Mine" }, "s-u2")).status, 404);
});

test("reports read: GET /api/triplog?report=1 gives only your catch / action / trip-end rows, catches with their rods", async () => {
  const { sqlite, env } = await legacySeeded();
  await site(env, "POST", "/api/triplog/backfill-legacy", {});
  sqlite.prepare("INSERT INTO trip_log (id, user_id, run_id, event_type, ts, date_time, source, source_uuid, created_at) VALUES ('tl_other', 'u2', 'x', 'catch', 1, '2026-03-07 07:00:00', 'Site', 'o1', 1)").run();
  const res = await site(env, "GET", "/api/triplog?report=1");
  assert.equal(res.status, 200);
  const { entries } = await res.json();
  assert.ok(entries.length > 0);
  assert.ok(entries.every((e) => ["catch", "action_start", "action_end", "trip_end"].includes(e.type)));
  assert.ok(entries.every((e) => e.id !== "tl_other"));
  const c = entries.find((e) => e.markId === "a1C");
  assert.equal(c.species, "Bream");
  assert.deepEqual(c.rods.map((r) => r.rod), ["L Wilson"]);
  assert.deepEqual(entries.map((e) => e.ts), [...entries.map((e) => e.ts)].sort((a, b) => a - b));
  assert.equal((await api(env, null, "GET", "/api/triplog?report=1", undefined, { Origin: SITE })).status, 401);
});

test("trail import: the sessions and the catches saved with them become trip-log entries (no Session marks), idempotently", async () => {
  const { sqlite, env } = await seeded();
  const ins = sqlite.prepare("INSERT INTO marks (id, user_id, lat, lng, name, type, date_time, source, species, size, created_at) VALUES (?, 'u1', -38.1, 145.2, 'x', 'Catch', ?, 'trail-import', 'Bream', 30, 1)");
  ins.run("c1", "2026-09-12 10:00:00");
  const mk = (id, type, dateTime, extra = {}) => ({ id, type, dateTime, lat: -38.1, lng: 145.2, sessionGroupId: "g1", ...extra });
  const marks = [
    mk("s1", "Session Start", "2026-09-12 09:30:00", { species: "Bream", bait: "Prawn", rod: "L Wilson" }),
    { id: "c1", type: "Catch", dateTime: "2026-09-12 10:00:00", lat: -38.1, lng: 145.2, species: "Bream", size: 30 },
    mk("e1", "Session End", "2026-09-12 11:00:00"),
    mk("s2", "Session Start", "2026-09-13 09:30:00", { sessionGroupId: "g2" }),
  ];
  const res = await site(env, "POST", "/api/triplog/import", { marks });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.runs, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM marks WHERE type IN ('Session Start', 'Session End')").get().n, 0, "no Session marks are saved");
  const rows = sqlite.prepare("SELECT event_type, mark_id, date_time FROM trip_log WHERE run_id = 'legacy:s1' ORDER BY ts, rowid").all();
  assert.deepEqual(rows.map((r) => r.event_type), ["trip_start", "action_start", "catch", "action_end", "trip_end"]);
  assert.deepEqual(rows.map((r) => r.mark_id), [null, null, "c1", null, null], "only the saved catch is linked");
  const again = await (await site(env, "POST", "/api/triplog/import", { marks })).json();
  assert.equal(again.runs, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log WHERE run_id = 'legacy:s1'").get().n, 5);
  assert.equal((await site(env, "POST", "/api/triplog/import", { marks: [{ id: "x", type: "POI", dateTime: "d", lat: 0, lng: 0 }] })).status, 400);
  assert.equal((await api(env, null, "POST", "/api/triplog/import", { marks }, { Origin: SITE })).status, 401);
});

test("deleting a trip: its lines and rod rows go, the catches stay, only your own trips", async () => {
  const { sqlite, env } = await legacySeeded();
  await site(env, "POST", "/api/triplog/backfill-legacy", {});
  const before = sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log").get().n;
  const n = legacyRows(sqlite, "legacy:a1S").length;
  assert.ok(n > 3);
  assert.equal((await site(env, "DELETE", "/api/triplog/run?runId=legacy%3Aa1S", undefined, "s-u2")).status, 404, "not someone else's");
  assert.equal((await site(env, "DELETE", "/api/triplog/run")).status, 400);
  assert.equal((await site(env, "DELETE", "/api/triplog/run?runId=legacy%3Aa1S")).status, 200);
  assert.equal((await (await site(env, "GET", "/api/triplog?list=1")).json()).some((r) => r.runId === "legacy:a1S"), false, "hidden from the trips list");
  assert.equal((await (await site(env, "GET", "/api/triplog?runId=legacy%3Aa1S")).json()).entries.length, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log WHERE run_id = 'legacy:a1S' AND deleted_at IS NOT NULL").get().n, n, "kept, marked for deletion");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log").get().n, before, "nothing removed yet");
  // the Settings backfill does not bring it back
  await site(env, "POST", "/api/triplog/backfill-legacy", {});
  assert.equal(legacyRows(sqlite, "legacy:a1S").filter((r) => r.deleted_at == null).length, 0, "still deleted after a rebuild");
  // after 30 days the cron removes the lines and their rod rows for good
  sqlite.prepare("UPDATE trip_log SET deleted_at = ? WHERE run_id = 'legacy:a1S'").run(Date.now() - 31 * 86400000);
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.equal(legacyRows(sqlite, "legacy:a1S").length, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log WHERE run_id = 'legacy:a1S'").get().n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_log_rods WHERE log_id LIKE '%a1S%' OR log_id LIKE '%a1C%'").get().n, 0, "its rod rows went too");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM marks WHERE id = 'a1C'").get().n, 1, "the catch mark stays");
  assert.equal((await site(env, "DELETE", "/api/triplog/run?runId=legacy%3Aa1S")).status, 404);
});
