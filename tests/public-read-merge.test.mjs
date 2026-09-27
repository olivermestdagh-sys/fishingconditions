// Any signed-in user may READ Public's Groups and Mark Lists (?userId=public with GET) so Settings can
// show them merged into your own view, badged and read-only — but writing to userId=public (POST here,
// PUT/DELETE on the item routes) stays Admin-only, exactly as before. See resolveEffectiveUserId's own
// `allowPublicRead` flag, user-backend.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = path.join(os.tmpdir(), `ub-public-read-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const SITE = "https://site.example";
function makeEnv(role) {
  return {
    ALLOWED_ORIGIN: SITE,
    DB: {
      prepare(sql) {
        let args = [];
        return {
          bind(...a) {
            args = a;
            return this;
          },
          async first() {
            if (/FROM sessions/.test(sql)) return { id: "u1", role };
            return null;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            return {};
          },
        };
      },
    },
  };
}

const req = (env, method, path) =>
  worker.fetch(new Request(`https://worker.example${path}`, { method, headers: { Cookie: "session=s", Origin: SITE } }), env);

for (const p of ["/api/groups?userId=public", "/api/marklists?userId=public"]) {
  test(`a non-admin CAN GET ${p}`, async () => {
    const env = makeEnv("basic");
    const res = await req(env, "GET", p);
    assert.equal(res.status, 200);
  });

  test(`a non-admin CANNOT POST ${p}`, async () => {
    const env = makeEnv("basic");
    const res = await worker.fetch(
      new Request(`https://worker.example${p}`, {
        method: "POST",
        headers: { Cookie: "session=s", Origin: SITE, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x", field: "Rig", value: "x" }),
      }),
      env
    );
    assert.equal(res.status, 403);
  });

  test(`an admin can GET and POST ${p}`, async () => {
    const env = makeEnv("admin");
    assert.equal((await req(env, "GET", p)).status, 200);
  });
}

test("a non-admin still can't act on someone else's real account (not Public)", async () => {
  const env = makeEnv("basic");
  const res = await req(env, "GET", "/api/groups?userId=someone-else");
  assert.equal(res.status, 403);
});
