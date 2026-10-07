// USER_BACKEND_URL (js/backend.js) follows the page's hostname: fish2catch.app -> api.fish2catch.app, everything else
// (yepyepyep.app, github.io, localhost, file://) -> api.yepyepyep.app. Also pins the CORS / CSRF behaviour of the Worker
// for both sites with the origin list as wrangler.toml configures it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

const src = fs.readFileSync(new URL("../js/backend.js", import.meta.url), "utf8");
const m = /const USER_BACKEND_URL =[\s\S]*?;\n/.exec(src);
assert.ok(m, "USER_BACKEND_URL declaration found");
const urlFor = (location) => vm.runInNewContext(`${m[0]}; USER_BACKEND_URL`, location === undefined ? {} : { location });

test("API host follows the page hostname", () => {
  for (const h of ["fish2catch.app", "www.fish2catch.app", "FISH2CATCH.APP"]) assert.equal(urlFor({ hostname: h }), "https://api.fish2catch.app", h);
  for (const h of ["yepyepyep.app", "olivermestdagh-sys.github.io", "localhost", "127.0.0.1", "", "evilfish2catch.app", "fish2catch.app.evil.com"])
    assert.equal(urlFor({ hostname: h }), "https://api.yepyepyep.app", h || "file:// (empty hostname)");
  assert.equal(urlFor(undefined), "https://api.yepyepyep.app", "no location at all");
});

const tmp = path.join(os.tmpdir(), `ub-apihost-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;
const toml = fs.readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const ALLOWED = /ALLOWED_ORIGIN = "([^"]*)"/.exec(toml)[1];
const env = { ALLOWED_ORIGIN: ALLOWED, FRONTEND_ACCOUNT_URL: "https://x.example/l.html", DB: { prepare: () => ({ bind() { return this; }, async first() { return null; }, async run() { return {}; } }) } };
const call = (host, method, headers) => worker.fetch(new Request(host + "/auth/logout", { method, headers }), env);

test("wrangler.toml allows both sites", () => {
  assert.ok(ALLOWED.split(",").includes("https://fish2catch.app"));
  assert.ok(ALLOWED.split(",").includes("https://yepyepyep.app"));
});

test("CORS preflight and CSRF guard work for both sites on both API hosts", async () => {
  for (const origin of ["https://yepyepyep.app", "https://fish2catch.app"]) {
    for (const api of ["https://api.yepyepyep.app", "https://api.fish2catch.app"]) {
      const pre = await call(api, "OPTIONS", { Origin: origin, "Access-Control-Request-Method": "POST" });
      assert.equal(pre.headers.get("access-control-allow-origin"), origin, `${origin} -> ${api} preflight`);
      assert.equal(pre.headers.get("access-control-allow-credentials"), "true");
      assert.equal((await call(api, "POST", { Origin: origin })).status, 204, `${origin} -> ${api} POST allowed`);
    }
  }
  assert.equal((await call("https://api.fish2catch.app", "POST", { Origin: "https://evil.example" })).status, 403);
  assert.equal((await call("https://api.fish2catch.app", "POST", {})).status, 403);
});
