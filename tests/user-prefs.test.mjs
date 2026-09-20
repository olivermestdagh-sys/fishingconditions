// The per-user saved preferences endpoint (/api/prefs), run against a real SQLite engine behind a small D1-style adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const tmp = path.join(os.tmpdir(), `ub-prefs-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const schema = fs.readFileSync(new URL("../schema-v2.sql", import.meta.url), "utf8");
const prefsTable = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS user_prefs"));

const SITE = "https://site.example";

function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, email TEXT);");
  sqlite.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER);");
  sqlite.exec(prefsTable);
  sqlite.prepare("INSERT INTO users VALUES ('u1', 'basic', 'a@x'), ('u2', 'basic', 'b@x'), ('admin1', 'admin', 'o@x'), ('public', 'public', 'p@x')").run();
  const future = Date.now() + 3600000;
  sqlite.prepare("INSERT INTO sessions VALUES ('s-u1', 'u1', ?), ('s-u2', 'u2', ?), ('s-admin', 'admin1', ?), ('s-old', 'u1', ?)").run(future, future, future, Date.now() - 1000);
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
      return stmts.map((s) => ({ meta: { changes: Number(s._run().changes) } }));
    },
  };
  return { sqlite, env: { ALLOWED_ORIGIN: SITE, DB: d1 } };
}

const call = (env, method, session, body) =>
  worker.fetch(
    new Request("https://worker.example/api/prefs", {
      method,
      headers: { "Content-Type": "application/json", Origin: SITE, ...(session ? { Cookie: `session=${session}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env
  );

test("signed-out visitors can neither read nor write preferences", async () => {
  const { env } = makeDb();
  assert.equal((await call(env, "GET", null)).status, 401);
  assert.equal((await call(env, "PUT", null, { changes: { selectedLocation: "x" } })).status, 401);
  assert.equal((await call(env, "GET", "s-old")).status, 401); // an expired session
});

test("a cross-site write is blocked before it reaches the endpoint", async () => {
  const { env } = makeDb();
  const r = await worker.fetch(
    new Request("https://worker.example/api/prefs", { method: "PUT", headers: { "Content-Type": "text/plain", Origin: "https://evil.example", Cookie: "session=s-u1" }, body: "{}" }),
    env
  );
  assert.equal(r.status, 403);
});

test("saved values come back for the same user", async () => {
  const { env } = makeDb();
  const put = await call(env, "PUT", "s-u1", { changes: { goodConditionsPinnedLocationsNew: '["Flinders"]', selectedLocation: "Rye|Kayak" } });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).saved, 2);
  const got = await (await call(env, "GET", "s-u1")).json();
  assert.equal(got.userId, "u1");
  assert.equal(got.prefs.goodConditionsPinnedLocationsNew.value, '["Flinders"]');
  assert.equal(got.prefs.selectedLocation.value, "Rye|Kayak");
  assert.equal(typeof got.prefs.selectedLocation.updatedAt, "number");
});

test("preferences are private to each user, and an admin keeps their own (not the Public account's)", async () => {
  const { env, sqlite } = makeDb();
  await call(env, "PUT", "s-u1", { changes: { liveHomeTimings: '{"homeByStr":"18:00"}' } });
  await call(env, "PUT", "s-admin", { changes: { liveHomeTimings: '{"homeByStr":"20:30"}' } });
  assert.deepEqual((await (await call(env, "GET", "s-u2")).json()).prefs, {}); // another user sees none of it
  assert.equal((await (await call(env, "GET", "s-u1")).json()).prefs.liveHomeTimings.value, '{"homeByStr":"18:00"}');
  const admin = await (await call(env, "GET", "s-admin")).json();
  assert.equal(admin.userId, "admin1");
  assert.equal(admin.prefs.liveHomeTimings.value, '{"homeByStr":"20:30"}');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user_prefs WHERE user_id = 'public'").get().n, 0);
});

test("a later save replaces the value; null removes it", async () => {
  const { env } = makeDb();
  await call(env, "PUT", "s-u1", { changes: { selectedLocation: "A|Kayak", markViewSettings: '{"groupByKey":"bait"}' } });
  await call(env, "PUT", "s-u1", { changes: { selectedLocation: "B|Kayak", markViewSettings: null } });
  const prefs = (await (await call(env, "GET", "s-u1")).json()).prefs;
  assert.equal(prefs.selectedLocation.value, "B|Kayak");
  assert.equal(prefs.markViewSettings, undefined);
});

test("only allowlisted settings, only text values within the size limit", async () => {
  const { env, sqlite } = makeDb();
  assert.equal((await call(env, "PUT", "s-u1", { changes: { somethingElse: "x" } })).status, 400);
  assert.equal((await call(env, "PUT", "s-u1", { changes: { selectedLocation: { nested: true } } })).status, 400);
  assert.equal((await call(env, "PUT", "s-u1", { changes: { selectedLocation: 5 } })).status, 400);
  assert.equal((await call(env, "PUT", "s-u1", { changes: { selectedLocation: "x".repeat(64 * 1024 + 1) } })).status, 400);
  assert.equal((await call(env, "PUT", "s-u1", { changes: {} })).status, 400);
  assert.equal((await call(env, "PUT", "s-u1", { changes: [1] })).status, 400);
  assert.equal((await call(env, "PUT", "s-u1", { changes: { selectedLocation: "x".repeat(64 * 1024) } })).status, 200); // exactly at the limit
  // a bad entry rejects the whole request: nothing else in it is saved
  const before = sqlite.prepare("SELECT COUNT(*) AS n FROM user_prefs").get().n;
  assert.equal((await call(env, "PUT", "s-u1", { changes: { liveHomeTimings: "ok", nope: "x" } })).status, 400);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user_prefs").get().n, before);
});

test("responses are never cached", async () => {
  const { env } = makeDb();
  assert.equal((await call(env, "GET", "s-u1")).headers.get("cache-control"), "private, no-store");
});
