// Tests for the Worker's security rules: the cross-site (Origin) guard and the
// "only the signed-in owner sees their marks / home location" endpoints.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// user-backend.js uses `export default` but has a .js name; import a .mjs copy.
const tmp = path.join(os.tmpdir(), `ub-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const SITE = "https://site.example";
function makeEnv(role, id) {
  return {
    ALLOWED_ORIGIN: SITE,
    PIPELINE_API_TOKEN: "secret",
    DB: {
      prepare(sql) {
        let args = [];
        return {
          bind(...a) { args = a; return this; },
          async first() {
            if (/FROM sessions/.test(sql)) return role ? { id, role } : null;
            if (/FROM site_settings/.test(sql)) return { value: "SITE-KEY" };
            if (/home_lat/.test(sql)) return { home_lat: -37.9, home_lng: 145.2 };
            return null;
          },
          async all() {
            return { results: [{ id: "m1", user_id: args[0], lat: 1, lng: 2, type: "Catch", date_time: "2026-01-01 00:00:00" }] };
          },
        };
      },
    },
  };
}
const call = (env, method, p, headers = {}, body) =>
  worker.fetch(new Request("https://worker.example" + p, { method, headers, body }), env);
const signedIn = { Cookie: "session=abc" };

test("cross-site POST is blocked", async () => {
  const r = await call(makeEnv(null), "POST", "/api/marks", { Origin: "https://evil.example", "Content-Type": "text/plain" }, "{}");
  assert.equal(r.status, 403);
});
test("POST with no Origin is blocked", async () => {
  assert.equal((await call(makeEnv(null), "POST", "/api/marks", {}, "{}")).status, 403);
});
test("cross-site DELETE is blocked", async () => {
  assert.equal((await call(makeEnv(null), "DELETE", "/api/marks/x", { Origin: "https://evil.example" })).status, 403);
});
test("POST from the real site passes the guard (then 401 without a session)", async () => {
  assert.equal((await call(makeEnv(null), "POST", "/api/marks", { Origin: SITE, "Content-Type": "application/json" }, "{}")).status, 401);
});
test("pipeline endpoints are exempt from the Origin check (token protected instead)", async () => {
  assert.equal((await call(makeEnv(null), "PUT", "/api/pipeline/locations/x", { "X-Pipeline-Token": "wrong" }, "{}")).status, 401);
});

test("anonymous visitors get no marks", async () => {
  assert.equal((await call(makeEnv(null), "GET", "/api/public/marks")).status, 401);
});
test("anonymous visitors get no home location or API key", async () => {
  const r = await call(makeEnv(null), "GET", "/api/public/settings");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { homeLat: null, homeLng: null, googleRoutesApiKey: null });
});
test("Admin is served their own marks and settings (home location is the signed-in user's; the Routes key is site-wide)", async () => {
  const env = makeEnv("admin", "admin-id");
  const marks = await (await call(env, "GET", "/api/public/marks", signedIn)).json();
  assert.equal(marks[0].id, "m1");
  const s = await (await call(env, "GET", "/api/public/settings", signedIn)).json();
  assert.equal(s.googleRoutesApiKey, "SITE-KEY"); // the site-wide key
});
test("a normal user only gets their own data", async () => {
  const s = await (await call(makeEnv("basic", "user-77"), "GET", "/api/public/settings", signedIn)).json();
  assert.equal(s.googleRoutesApiKey, "SITE-KEY"); // every signed-in user gets the same site-wide key
});
test("responses to signed-in reads are not cacheable and use the exact site origin", async () => {
  const r = await call(makeEnv("admin", "admin-id"), "GET", "/api/public/marks", signedIn);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.equal(r.headers.get("access-control-allow-origin"), SITE);
});
