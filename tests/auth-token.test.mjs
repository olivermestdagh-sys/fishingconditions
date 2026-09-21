// Sign-in that survives blocked third-party cookies: the Google callback hands the site a one-time login code,
// POST /auth/exchange swaps it for a token, and `Authorization: Bearer <token>` authenticates like the cookie does.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = path.join(os.tmpdir(), `ub-auth-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const SITE = "https://site.example";
const USER = { id: "u-1", email: "a@example.com", name: "A", role: "basic" };

// An in-memory sessions table behind the D1 interface the Worker uses.
function makeEnv(sessions) {
  return {
    ALLOWED_ORIGIN: SITE,
    DB: {
      prepare(sql) {
        let args = [];
        return {
          bind(...a) { args = a; return this; },
          async first() {
            if (/SELECT users\.\* FROM sessions/.test(sql)) {
              const s = sessions.get(args[0]);
              return s && s.expires_at > args[1] ? { ...USER, id: s.user_id } : null;
            }
            if (/SELECT user_id FROM sessions WHERE id = \? AND expires_at > \?/.test(sql)) {
              const s = sessions.get(args[0]);
              return s && s.expires_at > args[1] ? { user_id: s.user_id } : null;
            }
            return null;
          },
          async run() {
            if (/INSERT INTO sessions/.test(sql)) sessions.set(args[0], { user_id: args[1], expires_at: args[2] });
            if (/DELETE FROM sessions/.test(sql)) sessions.delete(args[0]);
            return {};
          },
        };
      },
    },
  };
}
const call = (env, method, p, { headers = {}, body } = {}) =>
  worker.fetch(new Request("https://worker.example" + p, { method, headers: { Origin: SITE, "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined }), env);

test("a valid one-time code is exchanged for a token that signs you in", async () => {
  const sessions = new Map([["lc_abc", { user_id: "u-1", expires_at: Date.now() + 60000 }]]);
  const env = makeEnv(sessions);
  const res = await call(env, "POST", "/auth/exchange", { body: { code: "lc_abc" } });
  assert.equal(res.status, 200);
  const { token } = await res.json();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(sessions.has("lc_abc"), false, "the code is single-use");
  const me = await call(env, "GET", "/auth/me", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).email, USER.email);
});

test("a code can only be used once, and expired or unknown codes are refused", async () => {
  const sessions = new Map([
    ["lc_once", { user_id: "u-1", expires_at: Date.now() + 60000 }],
    ["lc_old", { user_id: "u-1", expires_at: Date.now() - 1000 }],
  ]);
  const env = makeEnv(sessions);
  assert.equal((await call(env, "POST", "/auth/exchange", { body: { code: "lc_once" } })).status, 200);
  assert.equal((await call(env, "POST", "/auth/exchange", { body: { code: "lc_once" } })).status, 400);
  assert.equal((await call(env, "POST", "/auth/exchange", { body: { code: "lc_old" } })).status, 400);
  assert.equal((await call(env, "POST", "/auth/exchange", { body: { code: "lc_nope" } })).status, 400);
  assert.equal((await call(env, "POST", "/auth/exchange", { body: {} })).status, 400);
});

test("a real session id can't be used as a login code, and a login code can't act as a session", async () => {
  const sessions = new Map([
    ["realsession", { user_id: "u-1", expires_at: Date.now() + 60000 }],
    ["lc_x", { user_id: "u-1", expires_at: Date.now() + 60000 }],
  ]);
  const env = makeEnv(sessions);
  assert.equal((await call(env, "POST", "/auth/exchange", { body: { code: "realsession" } })).status, 400);
  assert.equal((await call(env, "GET", "/auth/me", { headers: { Authorization: "Bearer lc_x" } })).status, 401);
});

test("the token and the cookie both work; neither means signed out; the exchange needs the site's Origin", async () => {
  const sessions = new Map([["tok", { user_id: "u-1", expires_at: Date.now() + 60000 }]]);
  const env = makeEnv(sessions);
  assert.equal((await call(env, "GET", "/auth/me", { headers: { Authorization: "Bearer tok" } })).status, 200);
  assert.equal((await call(env, "GET", "/auth/me", { headers: { Cookie: "session=tok" } })).status, 200);
  assert.equal((await call(env, "GET", "/auth/me")).status, 401);
  assert.equal((await call(env, "GET", "/auth/me", { headers: { Authorization: "Bearer wrong" } })).status, 401);
  const evil = await call(env, "POST", "/auth/exchange", { headers: { Origin: "https://evil.example" }, body: { code: "lc_x" } });
  assert.equal(evil.status, 403);
});

test("logging out with the token ends that session", async () => {
  const sessions = new Map([["tok", { user_id: "u-1", expires_at: Date.now() + 60000 }]]);
  const env = makeEnv(sessions);
  assert.equal((await call(env, "POST", "/auth/logout", { headers: { Authorization: "Bearer tok" } })).status, 204);
  assert.equal(sessions.has("tok"), false);
  assert.equal((await call(env, "GET", "/auth/me", { headers: { Authorization: "Bearer tok" } })).status, 401);
});

test("cross-origin requests may send the Authorization header", async () => {
  const res = await worker.fetch(new Request("https://worker.example/auth/me", { method: "OPTIONS", headers: { Origin: SITE } }), makeEnv(new Map()));
  assert.match(res.headers.get("access-control-allow-headers"), /Authorization/);
});
