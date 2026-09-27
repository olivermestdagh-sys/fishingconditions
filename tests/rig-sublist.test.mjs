// A Rig value can maintain its own free-form sub list (hasSublist/subList on user_mark_lists), read by
// Settings > Trips > Rod Setups. Only Rig rows may set it; every other field is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = path.join(os.tmpdir(), `ub-rig-sublist-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const SITE = "https://site.example";
function makeEnv(field) {
  const row = { id: "abc", user_id: "public", field, value: "Paternoster", has_sublist: 0, sub_list: null };
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
            if (/FROM sessions/.test(sql)) return { id: "admin-id", role: "admin" };
            if (/FROM user_mark_lists WHERE id/.test(sql)) return { ...row };
            return null;
          },
          async run() {
            if (/UPDATE user_mark_lists/.test(sql)) {
              updates.push({ sql, args });
              const hasSublist = args[13];
              const subList = args[14];
              Object.assign(row, { has_sublist: hasSublist, sub_list: subList });
            }
            return {};
          },
          async all() {
            return { results: [{ ...row }] };
          },
        };
      },
    },
  };
}
const put = (env, body) =>
  worker.fetch(
    new Request("https://worker.example/api/marklists/abc?userId=public", {
      method: "PUT",
      headers: { Cookie: "session=s", Origin: SITE, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env
  );

test("a Rig can turn on a sub list and save its options", async () => {
  const env = makeEnv("Rig");
  let body = await (await put(env, { hasSublist: true })).json();
  assert.equal(body.hasSublist, true);
  assert.deepEqual(body.subList, []);

  body = await (await put(env, { subList: ["3in Paddle Tail", "Vibe"] })).json();
  assert.equal(body.hasSublist, true);
  assert.deepEqual(body.subList, ["3in Paddle Tail", "Vibe"]);
  assert.equal(env.updates.length, 2);
});

test("only Rig values can have a sub list", async () => {
  for (const field of ["Rod", "Bait", "Species"]) {
    const env = makeEnv(field);
    const res = await put(env, { hasSublist: true });
    assert.equal(res.status, 400, field);
    assert.match((await res.json()).error, /Only Rig values/);
    assert.deepEqual(env.updates, [], field);
  }
});

test("subList must be a list of non-empty strings, at most 100", async () => {
  const env = makeEnv("Rig");
  for (const bad of [["ok", ""], ["ok", 5], "not-an-array", Array(101).fill("x")]) {
    const res = await put(env, { subList: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(env.updates, []);
});
