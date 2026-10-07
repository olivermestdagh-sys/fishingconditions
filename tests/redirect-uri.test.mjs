// The Worker answers on two addresses (api.yepyepyep.app and its workers.dev one). Google needs the token exchange's
// redirect_uri to equal the sign-in's, so it is derived from the host the request arrived on, from an allow-list.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = path.join(os.tmpdir(), `ub-redirect-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const NEW = "https://api.yepyepyep.app";
const OLD = "https://fishingconditions-users.olies-fishing.workers.dev";
const F2C = "https://api.fish2catch.app";
const LIST = `${NEW}/auth/callback,${F2C}/auth/callback,${OLD}/auth/callback`;

function makeEnv(redirect) {
  return {
    ALLOWED_ORIGIN: "https://yepyepyep.app",
    FRONTEND_ACCOUNT_URL: "https://yepyepyep.app/locations.html",
    GOOGLE_CLIENT_ID: "cid",
    GOOGLE_CLIENT_SECRET: "sec",
    GOOGLE_REDIRECT_URI: redirect,
    DB: {
      prepare(sql) {
        return {
          bind() { return this; },
          async first() { return /users/i.test(sql) ? { id: "u-1", email: "a@example.com", name: "A", role: "basic" } : null; },
          async run() { return {}; },
        };
      },
    },
  };
}
const get = (env, host, p, headers = {}) => worker.fetch(new Request(host + p, { headers }), env);
const redirectParam = (res) => new URL(res.headers.get("location")).searchParams.get("redirect_uri");

test("login on either host sends Google that host's callback", async () => {
  const env = makeEnv(LIST);
  assert.equal(redirectParam(await get(env, NEW, "/auth/login")), `${NEW}/auth/callback`);
  assert.equal(redirectParam(await get(env, OLD, "/auth/login")), `${OLD}/auth/callback`);
});

test("login on api.fish2catch.app sends Google its own callback", async () => {
  const env = makeEnv(LIST);
  assert.equal(redirectParam(await get(env, F2C, "/auth/login")), `${F2C}/auth/callback`);
});

test("login on a host that isn't listed is refused", async () => {
  const env = makeEnv(LIST);
  const res = await get(env, "https://evil.example", "/auth/login");
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("location"), null);
});

test("a single configured value is used whatever the host, as before the list existed", async () => {
  const env = makeEnv(`${OLD}/auth/callback`);
  assert.equal(redirectParam(await get(env, OLD, "/auth/login")), `${OLD}/auth/callback`);
  assert.equal(redirectParam(await get(env, NEW, "/auth/login")), `${OLD}/auth/callback`);
});

test("the callback's token exchange uses the redirect_uri of the host it landed on (= the one the login started with)", async () => {
  const env = makeEnv(LIST);
  const payload = Buffer.from(JSON.stringify({ sub: "s1", email: "a@example.com", name: "A" })).toString("base64url");
  const realFetch = globalThis.fetch;
  try {
    for (const host of [NEW, F2C, OLD]) {
      const login = await get(env, host, "/auth/login");
      const state = /oauth_state=([0-9a-f]+)/.exec(login.headers.get("set-cookie"))[1];
      let sent;
      globalThis.fetch = async (_u, init) => {
        sent = new URLSearchParams(init.body);
        return new Response(JSON.stringify({ id_token: `x.${payload}.y` }), { status: 200 });
      };
      const cb = await get(env, host, `/auth/callback?code=c&state=${state}`, { Cookie: `oauth_state=${state}` });
      assert.equal(cb.status, 302, host);
      assert.equal(sent.get("redirect_uri"), redirectParam(login), `exchange matches the login on ${host}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a callback on an unlisted host is refused before anything is exchanged", async () => {
  const env = makeEnv(LIST);
  let called = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return new Response("{}"); };
  try {
    const res = await get(env, "https://evil.example", "/auth/callback?code=c&state=s", { Cookie: "oauth_state=s" });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("wrangler.toml lists all callbacks and both custom domains, and keeps workers.dev on", () => {
  const toml = fs.readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const uri = /GOOGLE_REDIRECT_URI = "([^"]*)"/.exec(toml)[1];
  assert.deepEqual(uri.split(","), [`${NEW}/auth/callback`, `${F2C}/auth/callback`, `${OLD}/auth/callback`]);
  assert.match(toml, /pattern = "api.yepyepyep.app", custom_domain = true/);
  assert.match(toml, /pattern = "api.fish2catch.app", custom_domain = true/);
  assert.match(toml, /^workers_dev = true/m);
});
