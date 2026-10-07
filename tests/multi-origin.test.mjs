// ALLOWED_ORIGIN may be one origin (today) or a comma/space-separated list; CORS, the CSRF guard and the sign-in
// redirect all follow the request's own origin.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = path.join(os.tmpdir(), `ub-multiorigin-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const A = "https://a.example";
const B = "https://b.example";
const HOME = "https://a.example/site/locations.html";

function makeEnv(allowed, sessions = new Map()) {
  return {
    ALLOWED_ORIGIN: allowed,
    FRONTEND_ACCOUNT_URL: HOME,
    GOOGLE_CLIENT_ID: "cid",
    GOOGLE_CLIENT_SECRET: "sec",
    GOOGLE_REDIRECT_URI: "https://worker.example/auth/callback",
    DB: {
      prepare(sql) {
        let args = [];
        return {
          bind(...a) { args = a; return this; },
          async first() { return null; },
          async run() {
            if (/INSERT INTO sessions/.test(sql)) sessions.set(args[0], { user_id: args[1] });
            return {};
          },
        };
      },
    },
  };
}
const req = (env, method, p, headers = {}) =>
  worker.fetch(new Request("https://worker.example" + p, { method, headers }), env);

test("a single value still works exactly as before", async () => {
  const env = makeEnv(A);
  const ok = await req(env, "POST", "/auth/logout", { Origin: A });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), A);
  assert.equal((await req(env, "POST", "/auth/logout", { Origin: B })).status, 403);
  assert.equal((await req(env, "POST", "/auth/logout")).status, 403, "no Origin is still refused");
});

test("a list: each listed origin is allowed and echoed back; others are refused", async () => {
  for (const value of [`${A},${B}`, `${A}, ${B}/`, `${A} ${B}`]) {
    const env = makeEnv(value);
    for (const o of [A, B]) {
      const r = await req(env, "POST", "/auth/logout", { Origin: o });
      assert.equal(r.status, 204, value);
      assert.equal(r.headers.get("access-control-allow-origin"), o);
      assert.equal(r.headers.get("access-control-allow-credentials"), "true");
    }
    assert.equal((await req(env, "POST", "/auth/logout", { Origin: "https://evil.example" })).status, 403);
    const pre = await req(env, "OPTIONS", "/api/marks", { Origin: B });
    assert.equal(pre.headers.get("access-control-allow-origin"), B);
    const evilPre = await req(env, "OPTIONS", "/api/marks", { Origin: "https://evil.example" });
    assert.equal(evilPre.headers.get("access-control-allow-origin"), A, "an unlisted origin only ever sees the first one");
  }
});

test("an empty ALLOWED_ORIGIN allows nothing", async () => {
  const r = await req(makeEnv(""), "POST", "/auth/logout", { Origin: A });
  assert.equal(r.status, 403);
});

test("sign-in returns to the allowed site that started it, and ignores anything else", async () => {
  const env = makeEnv(`${A},${B}`);
  const none = await req(env, "GET", "/auth/login");
  assert.equal(none.status, 302);
  assert.equal(none.headers.get("set-cookie").includes("oauth_return"), false);

  const fromB = await req(env, "GET", "/auth/login?return=" + encodeURIComponent(B + "/locations.html?x=1#h"));
  const cookies = fromB.headers.get("set-cookie");
  assert.match(cookies, /oauth_return=/);
  const state = /oauth_state=([0-9a-f]+)/.exec(cookies)[1];
  assert.ok(state);

  // The callback needs Google; stub the token exchange.
  const realFetch = globalThis.fetch;
  const payload = Buffer.from(JSON.stringify({ sub: "s1", email: "a@example.com", name: "A" })).toString("base64url");
  globalThis.fetch = async () => new Response(JSON.stringify({ id_token: `x.${payload}.y` }), { status: 200 });
  const db = env.DB;
  env.DB = {
    prepare(sql) {
      const st = db.prepare(sql);
      const first = st.first;
      st.first = async () => (/users/i.test(sql) ? { id: "u-1", email: "a@example.com", name: "A", role: "basic" } : first());
      return st;
    },
  };
  try {
    const cb = (ret) =>
      req(env, "GET", `/auth/callback?code=c&state=${state}`, { Cookie: `oauth_state=${state}` + (ret ? `; oauth_return=${encodeURIComponent(ret)}` : "") });
    const good = await cb(B + "/locations.html");
    assert.equal(good.status, 302);
    {
      assert.ok(good.headers.get("location").startsWith(B + "/locations.html#login=lc_"));
      const evil = await cb("https://evil.example/phish.html");
      assert.ok(evil.headers.get("location").startsWith(HOME + "#login=lc_"), "an unlisted return falls back to FRONTEND_ACCOUNT_URL");
      const dflt = await cb(null);
      assert.ok(dflt.headers.get("location").startsWith(HOME + "#login=lc_"));
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
