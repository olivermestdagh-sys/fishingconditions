// The home location belongs to the signed-in user: setting it writes their own row, never the shared "public" one.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = path.join(os.tmpdir(), `ub-home-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const SITE = "https://site.example";
function makeEnv(role, id) {
  const updates = [];
  return {
    updates,
    ALLOWED_ORIGIN: SITE,
    DB: {
      prepare(sql) {
        let args = [];
        return {
          bind(...a) { args = a; return this; },
          async first() {
            if (/FROM sessions/.test(sql)) return role ? { id, role } : null;
            if (/home_lat/.test(sql)) return { home_lat: -37.9, home_lng: 145.2, google_routes_api_key: "KEY-" + args[0] };
            return null;
          },
          async run() {
            if (/UPDATE users SET home_lat/.test(sql)) updates.push(args);
            return {};
          },
        };
      },
    },
  };
}
const put = (env, body) =>
  worker.fetch(
    new Request("https://worker.example/api/admin/home-location", { method: "PUT", headers: { Cookie: "session=s", Origin: SITE, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    env
  );
const getSettings = (env, cookie = true) =>
  worker.fetch(new Request("https://worker.example/api/public/settings", { headers: cookie ? { Cookie: "session=s" } : {} }), env);

test("Admin setting a home location writes their own row, not the shared public one", async () => {
  const env = makeEnv("admin", "admin-id");
  const res = await put(env, { lat: -38.1, lng: 145.3 });
  assert.equal(res.status, 200);
  assert.deepEqual(env.updates, [[-38.1, 145.3, "admin-id"]]);
});

test("a normal user still cannot set a home location", async () => {
  const env = makeEnv("basic", "user-77");
  assert.equal((await put(env, { lat: -38.1, lng: 145.3 })).status, 403);
  assert.deepEqual(env.updates, []);
});

test("each signed-in user reads their own home settings; a signed-out visitor gets nothing", async () => {
  assert.equal((await (await getSettings(makeEnv("admin", "admin-id"))).json()).googleRoutesApiKey, "KEY-admin-id");
  assert.equal((await (await getSettings(makeEnv("basic", "user-77"))).json()).googleRoutesApiKey, "KEY-user-77");
  assert.deepEqual(await (await getSettings(makeEnv(null), false)).json(), { homeLat: null, homeLng: null, googleRoutesApiKey: null });
});
