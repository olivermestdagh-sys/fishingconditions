// The Worker refuses to delete values of the Mark Type, Tide Condition and Tide Extreme lists
// (they carry the shapes/colours marks are drawn with), and still deletes every other list's values.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = path.join(os.tmpdir(), `ub-lock-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const SITE = "https://site.example";
function makeEnv(field) {
  const deleted = [];
  return {
    deleted,
    ALLOWED_ORIGIN: SITE,
    DB: {
      prepare(sql) {
        let args = [];
        return {
          bind(...a) { args = a; return this; },
          async first() {
            if (/FROM sessions/.test(sql)) return { id: "admin-id", role: "admin" };
            if (/FROM user_mark_lists WHERE id/.test(sql)) return { id: args[0], user_id: "public", field, value: "Anything" };
            return null;
          },
          async run() {
            if (/DELETE FROM user_mark_lists/.test(sql)) deleted.push(args[0]);
            return {};
          },
        };
      },
    },
  };
}
const del = (env) =>
  worker.fetch(
    new Request("https://worker.example/api/marklists/abc?userId=public", { method: "DELETE", headers: { Cookie: "session=s", Origin: SITE } }),
    env
  );

for (const field of ["Mark Type", "Tide Condition", "Tide Extreme"]) {
  test(`a ${field} value can't be deleted`, async () => {
    const env = makeEnv(field);
    const res = await del(env);
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /can't be deleted/);
    assert.deepEqual(env.deleted, []);
  });
}

test("values of other lists can still be deleted", async () => {
  for (const field of ["Species", "Bait", "Mark Shape Format"]) {
    const env = makeEnv(field);
    const res = await del(env);
    assert.equal(res.status, 204, field);
    assert.deepEqual(env.deleted, ["abc"], field);
  }
});
