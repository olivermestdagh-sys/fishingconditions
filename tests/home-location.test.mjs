// Homes (user_homes): a signed-in user can have as many as they like, only ever their own — run against a real
// SQLite engine with the real schema behind a small D1-style adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const tmp = path.join(os.tmpdir(), `ub-home-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;
const schema = fs.readFileSync(new URL("../schema-v2.sql", import.meta.url), "utf8");
const SITE = "https://site.example";

function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  const now = Date.now();
  const user = sqlite.prepare("INSERT INTO users (id, google_sub, email, role, created_at) VALUES (?, ?, ?, ?, ?)");
  user.run("public", "g-public", "p@x", "public", now);
  user.run("admin1", "g-admin", "o@x", "admin", now);
  user.run("basic1", "g-basic", "c@x", "basic", now);
  sqlite.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run("s-admin", "admin1", now + 3600000);
  sqlite.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run("s-basic", "basic1", now + 3600000);
  sqlite.prepare("INSERT INTO site_settings (key, value, updated_at) VALUES ('google_routes_api_key', 'SITE-KEY', 0)").run();
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

test("a user can add several homes, list them and delete one; the settings response carries them all", async () => {
  const { env } = makeDb();
  const a = await (await req(env, "s-basic", "POST", "/api/homes", { lat: -38.1, lng: 145.3 })).json();
  const b = await (await req(env, "s-basic", "POST", "/api/homes", { lat: -37.5, lng: 144.9 })).json();
  assert.deepEqual((await (await req(env, "s-basic", "GET", "/api/homes")).json()).map((h) => h.id), [a.id, b.id]);
  const settings = await (await req(env, "s-basic", "GET", "/api/public/settings")).json();
  assert.deepEqual(settings.homes, [a, b]);
  assert.equal(settings.homeLat, -38.1); // the first, for older pages
  assert.equal(settings.googleRoutesApiKey, "SITE-KEY");
  assert.equal((await req(env, "s-basic", "DELETE", `/api/homes/${a.id}`)).status, 204);
  assert.deepEqual(await (await req(env, "s-basic", "GET", "/api/homes")).json(), [b]);
});

test("homes are only ever the signed-in user's own", async () => {
  const { env } = makeDb();
  const mine = await (await req(env, "s-basic", "POST", "/api/homes", { lat: -38.1, lng: 145.3 })).json();
  assert.deepEqual(await (await req(env, "s-admin", "GET", "/api/homes")).json(), []); // Admin sees only their own
  assert.equal((await req(env, "s-admin", "DELETE", `/api/homes/${mine.id}`)).status, 404); // and can't delete someone else's
  assert.equal((await (await req(env, "s-basic", "GET", "/api/homes")).json()).length, 1);
});

test("adding a home needs a sign-in and valid numbers", async () => {
  const { env } = makeDb();
  assert.equal((await req(env, null, "POST", "/api/homes", { lat: -38.1, lng: 145.3 })).status, 401);
  assert.equal((await req(env, "s-basic", "POST", "/api/homes", { lat: "x", lng: 145.3 })).status, 400);
});

test("the old set-home paths now add another home", async () => {
  const { env } = makeDb();
  assert.equal((await req(env, "s-basic", "PUT", "/api/home-location", { lat: -38.1, lng: 145.3 })).status, 200);
  assert.equal((await req(env, "s-basic", "PUT", "/api/admin/home-location", { lat: -37.5, lng: 144.9 })).status, 200);
  assert.equal((await (await req(env, "s-basic", "GET", "/api/homes")).json()).length, 2);
});

test("a home keeps a name (its closest town): given when added, or set later on your own homes only", async () => {
  const { env } = makeDb();
  const named = await (await req(env, "s-basic", "POST", "/api/homes", { lat: -38.1, lng: 145.3, name: "  Narre Warren  " })).json();
  assert.equal(named.name, "Narre Warren"); // trimmed
  const unnamed = await (await req(env, "s-basic", "POST", "/api/homes", { lat: -38.4, lng: 144.8 })).json();
  assert.equal(unnamed.name, null);
  assert.equal((await req(env, "s-basic", "PATCH", `/api/homes/${unnamed.id}`, { name: "Sorrento" })).status, 200);
  assert.equal((await req(env, "s-admin", "PATCH", `/api/homes/${unnamed.id}`, { name: "Hijacked" })).status, 404); // not theirs
  assert.deepEqual((await (await req(env, "s-basic", "GET", "/api/homes")).json()).map((h) => h.name), ["Narre Warren", "Sorrento"]);
});

test("a signed-out visitor gets no homes and no Routes key", async () => {
  const { env } = makeDb();
  assert.deepEqual(await (await req(env, null, "GET", "/api/public/settings")).json(), { homes: [], homeLat: null, homeLng: null, googleRoutesApiKey: null });
});
