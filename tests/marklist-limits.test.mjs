// Species limits (Min Size, Max Size, Max Qty, Big Max Qty, Big Size) on mark list rows:
// returned by the Worker in camelCase, saved through PUT, and validated (numbers >= 0, quantities whole, null clears).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = path.join(os.tmpdir(), `ub-limits-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const SITE = "https://site.example";
function makeEnv() {
  const row = { id: "abc", user_id: "public", field: "Species", value: "Flathead", min_size: 36, max_size: null, max_qty: 10, big_max_qty: null, big_size: null };
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
              const [, , , , , , , , minSize, maxSize, maxQty, bigMaxQty, bigSize] = args;
              Object.assign(row, { min_size: minSize, max_size: maxSize, max_qty: maxQty, big_max_qty: bigMaxQty, big_size: bigSize });
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

test("the five limits come back as camelCase fields, null when unset", async () => {
  const env = makeEnv();
  const res = await worker.fetch(new Request("https://worker.example/api/marklists?userId=public", { headers: { Cookie: "session=s", Origin: SITE } }), env);
  assert.equal(res.status, 200);
  const [entry] = await res.json();
  assert.equal(entry.minSize, 36);
  assert.equal(entry.maxQty, 10);
  assert.equal(entry.maxSize, null);
  assert.equal(entry.bigMaxQty, null);
  assert.equal(entry.bigSize, null);
});

test("PUT saves the limits and leaves the ones not sent alone", async () => {
  const env = makeEnv();
  const res = await put(env, { bigSize: 70, bigMaxQty: 1 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual([body.minSize, body.maxSize, body.maxQty, body.bigMaxQty, body.bigSize], [36, null, 10, 1, 70]);
  assert.equal(env.updates.length, 1);
});

test("0 is a real value (e.g. a no-take species) and null clears one", async () => {
  const env = makeEnv();
  let body = await (await put(env, { maxQty: 0 })).json();
  assert.equal(body.maxQty, 0);
  body = await (await put(env, { minSize: null })).json();
  assert.equal(body.minSize, null);
  assert.equal(body.maxQty, 0);
});

test("bad limits are refused with a 400 and nothing is saved", async () => {
  const bad = [
    { minSize: -1 },
    { maxSize: "40" },
    { maxQty: 2.5 },
    { bigMaxQty: 1.5 },
    { bigSize: true },
  ]; // (NaN/Infinity can't arrive: JSON turns them into null, which just clears the value)
  for (const body of bad) {
    const env = makeEnv();
    const res = await put(env, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(env.updates, [], JSON.stringify(body));
  }
});
