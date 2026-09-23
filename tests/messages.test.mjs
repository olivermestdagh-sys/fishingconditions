// Messages to the site's owner (Settings' Contact card / Admin Messages card) — run against a real SQLite engine with the
// real schema behind a small D1-style adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const tmp = path.join(os.tmpdir(), `ub-messages-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;
const schema = fs.readFileSync(new URL("../schema-v2.sql", import.meta.url), "utf8");
const SITE = "https://site.example";
const ADMIN_EMAIL = "owner@secret.example";

function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  const now = Date.now();
  const user = sqlite.prepare("INSERT INTO users (id, google_sub, email, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  user.run("admin1", "g-admin", ADMIN_EMAIL, "Oliver", "admin", now);
  user.run("basic1", "g-basic", "chelsea@x.example", "Chelsea", "basic", now);
  user.run("basic2", "g-basic2", "sam@x.example", "Sam", "basic", now);
  for (const [s, u] of [["s-admin", "admin1"], ["s-basic", "basic1"], ["s-basic2", "basic2"]]) sqlite.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(s, u, now + 3600000);
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
      };
      return stmt;
    },
  };
  return { sqlite, env: { ALLOWED_ORIGIN: SITE, DB: d1 } };
}

const req = (env, session, method, p, body) =>
  worker.fetch(
    new Request(`https://worker.example${p}`, {
      method,
      headers: { "Content-Type": "application/json", Origin: SITE, ...(session ? { Cookie: `session=${session}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env
  );
const json = async (res) => res.json();

test("sending needs a sign-in and a real message of at most 2000 characters", async () => {
  const { env } = makeDb();
  assert.equal((await req(env, null, "POST", "/api/messages", { body: "hi" })).status, 401);
  assert.equal((await req(env, "s-basic", "POST", "/api/messages", { body: "   " })).status, 400);
  assert.equal((await req(env, "s-basic", "POST", "/api/messages", { body: "x".repeat(2001) })).status, 400);
  assert.equal((await req(env, "s-basic", "POST", "/api/messages", { body: "  Hello there  " })).status, 201);
});

test("at most 5 messages an hour per person", async () => {
  const { env } = makeDb();
  for (let i = 0; i < 5; i++) assert.equal((await req(env, "s-basic", "POST", "/api/messages", { body: `m${i}` })).status, 201);
  assert.equal((await req(env, "s-basic", "POST", "/api/messages", { body: "one too many" })).status, 429);
  assert.equal((await req(env, "s-basic2", "POST", "/api/messages", { body: "someone else" })).status, 201); // per person
});

test("each person sees only their own messages, and never the admin's details", async () => {
  const { env } = makeDb();
  await req(env, "s-basic", "POST", "/api/messages", { body: "from Chelsea" });
  await req(env, "s-basic2", "POST", "/api/messages", { body: "from Sam" });
  const mine = await json(await req(env, "s-basic", "GET", "/api/messages"));
  assert.deepEqual(mine.map((m) => m.body), ["from Chelsea"]);
  assert.ok(!JSON.stringify(mine).includes(ADMIN_EMAIL));
  assert.equal((await req(env, "s-basic", "GET", "/api/admin/messages")).status, 403);
  assert.equal((await req(env, "s-basic", "PATCH", `/api/admin/messages/${mine[0].id}`, { reply: "x" })).status, 403);
  assert.equal((await req(env, "s-basic", "DELETE", `/api/admin/messages/${mine[0].id}`)).status, 403);
});

test("Admin reads, replies and deletes; the unread counts follow on both sides", async () => {
  const { env } = makeDb();
  const sent = await json(await req(env, "s-basic", "POST", "/api/messages", { body: "Is Balnarring good in a westerly?" }));
  assert.equal((await json(await req(env, "s-admin", "GET", "/api/messages/unread"))).count, 1);
  const inbox = await json(await req(env, "s-admin", "GET", "/api/admin/messages"));
  assert.equal(inbox[0].senderName, "Chelsea");
  assert.equal(inbox[0].senderEmail, "chelsea@x.example");
  assert.equal(inbox[0].readAt, null);

  assert.equal((await req(env, "s-admin", "PATCH", `/api/admin/messages/${sent.id}`, { read: true })).status, 200);
  assert.equal((await json(await req(env, "s-admin", "GET", "/api/messages/unread"))).count, 0);

  assert.equal((await json(await req(env, "s-basic", "GET", "/api/messages/unread"))).count, 0);
  assert.equal((await req(env, "s-admin", "PATCH", `/api/admin/messages/${sent.id}`, { reply: "Best in a light easterly." })).status, 200);
  assert.equal((await json(await req(env, "s-basic", "GET", "/api/messages/unread"))).count, 1); // a new reply
  const mine = await json(await req(env, "s-basic", "GET", "/api/messages"));
  assert.equal(mine[0].reply, "Best in a light easterly.");
  assert.ok(!JSON.stringify(mine).includes(ADMIN_EMAIL));
  assert.equal((await json(await req(env, "s-basic", "GET", "/api/messages/unread"))).count, 0); // seen now

  assert.equal((await req(env, "s-admin", "DELETE", `/api/admin/messages/${sent.id}`)).status, 204);
  assert.deepEqual(await json(await req(env, "s-admin", "GET", "/api/admin/messages")), []);
  assert.equal((await req(env, "s-admin", "DELETE", `/api/admin/messages/${sent.id}`)).status, 404);
});
