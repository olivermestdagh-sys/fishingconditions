// PUT /api/admin/locations/:id/owner — handing a location to another account (the Map's location editor), run
// against a real SQLite engine with the real schema behind a small D1-style adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const tmp = path.join(os.tmpdir(), `ub-locowner-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;
const schema = fs.readFileSync(new URL("../schema-v2.sql", import.meta.url), "utf8");
const SITE = "https://site.example";

function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  const now = Date.now();
  const user = sqlite.prepare("INSERT INTO users (id, google_sub, email, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  user.run("public", "g-public", "p@x", "Public", "public", now);
  user.run("admin1", "g-admin", "o@x", "Oliver", "admin", now);
  user.run("basic1", "g-basic", "c@x", "Chelsea", "basic", now);
  sqlite.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run("s-admin", "admin1", now + 3600000);
  sqlite.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run("s-basic", "basic1", now + 3600000);
  // Public's place, tracked by Public as Kayak and Land based, in Public's "Western Port" group.
  sqlite.prepare("INSERT INTO locations (id, created_by_user_id, name, display_name, lat, lng, created_at) VALUES ('L1', 'public', 'Balnarring Beach, VIC 3926', 'Balnarring', -38, 145, ?)").run(now);
  const type = sqlite.prepare("INSERT INTO user_types (id, user_id, name, behaves_like, created_at) VALUES (?, ?, ?, ?, ?)");
  type.run("pt-kayak", "public", "Kayak", "Kayak", now);
  type.run("pt-land", "public", "Land based", "Land based", now);
  type.run("at-kayak", "admin1", "Kayak", "Kayak", now); // Admin already has Kayak but not Land based
  const access = sqlite.prepare("INSERT INTO user_location_access (id, user_id, location_id, type_id, set_up, created_at) VALUES (?, ?, 'L1', ?, ?, ?)");
  access.run("a1", "public", "pt-kayak", "00:30", now);
  access.run("a2", "public", "pt-land", "00:20", now);
  sqlite.prepare("INSERT INTO user_location_groups (id, user_id, name, created_at) VALUES ('pg-wp', 'public', 'Western Port', ?)").run(now);
  sqlite.prepare("INSERT INTO user_location_group_members VALUES ('public', 'L1', 'pg-wp')").run();
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

const put = (env, session, id, body) =>
  worker.fetch(
    new Request(`https://worker.example/api/admin/locations/${id}/owner`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: SITE, Cookie: `session=${session}` },
      body: JSON.stringify(body),
    }),
    env
  );

test("Admin hands Public's location to their own account: place, type entries and groups all move", async () => {
  const { sqlite, env } = makeDb();
  const res = await put(env, "s-admin", "L1", { ownerUserId: "admin1" });
  assert.equal(res.status, 200);
  assert.equal(sqlite.prepare("SELECT created_by_user_id AS o FROM locations WHERE id = 'L1'").get().o, "admin1");
  const rows = sqlite
    .prepare("SELECT a.id, a.user_id, a.set_up, t.name, t.user_id AS type_owner FROM user_location_access a JOIN user_types t ON t.id = a.type_id ORDER BY a.id")
    .all()
    .map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { id: "a1", user_id: "admin1", set_up: "00:30", name: "Kayak", type_owner: "admin1" }, // re-pointed at Admin's existing Kayak
    { id: "a2", user_id: "admin1", set_up: "00:20", name: "Land based", type_owner: "admin1" }, // Admin's new Land based type
  ]);
  assert.equal(sqlite.prepare("SELECT behaves_like AS b FROM user_types WHERE user_id = 'admin1' AND name = 'Land based'").get().b, "Land based");
  const groups = sqlite.prepare("SELECT m.user_id, g.name, g.user_id AS group_owner FROM user_location_group_members m JOIN user_location_groups g ON g.id = m.group_id").all().map((r) => ({ ...r }));
  assert.deepEqual(groups, [{ user_id: "admin1", name: "Western Port", group_owner: "admin1" }]);
});

test("if the new owner already tracks the place with a type, theirs is kept and the duplicate dropped", async () => {
  const { sqlite, env } = makeDb();
  sqlite.prepare("INSERT INTO user_location_access (id, user_id, location_id, type_id, set_up, created_at) VALUES ('a3', 'admin1', 'L1', 'at-kayak', '00:45', 0)").run();
  assert.equal((await put(env, "s-admin", "L1", { ownerUserId: "admin1" })).status, 200);
  const kayak = sqlite.prepare("SELECT id, set_up FROM user_location_access WHERE type_id = 'at-kayak'").all().map((r) => ({ ...r }));
  assert.deepEqual(kayak, [{ id: "a3", set_up: "00:45" }]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user_location_access WHERE user_id = 'public'").get().n, 0);
});

test("moving to the owner it already has changes nothing", async () => {
  const { sqlite, env } = makeDb();
  assert.equal((await put(env, "s-admin", "L1", { ownerUserId: "public" })).status, 200);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user_location_access WHERE user_id = 'public'").get().n, 2);
});

test("only Admin can move a location, only to a real account, and only an existing location", async () => {
  const { sqlite, env } = makeDb();
  assert.equal((await put(env, "s-basic", "L1", { ownerUserId: "basic1" })).status, 403);
  assert.equal((await put(env, "s-admin", "L1", { ownerUserId: "nobody" })).status, 400);
  assert.equal((await put(env, "s-admin", "L1", {})).status, 400);
  assert.equal((await put(env, "s-admin", "nope", { ownerUserId: "admin1" })).status, 404);
  assert.equal(sqlite.prepare("SELECT created_by_user_id AS o FROM locations WHERE id = 'L1'").get().o, "public");
});
