// Species pictures: the browser-side sizing rule (js/species-image.js) and the Worker endpoints that store them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const clientSrc = fs.readFileSync(new URL("../js/species-image.js", import.meta.url), "utf8");
const fitWithin = new Function(clientSrc.match(/function fitWithin[\s\S]*?\r?\n}\r?\n/)[0] + "\nreturn fitWithin;")();

test("fitWithin shrinks the long side to the limit and keeps the shape", () => {
  assert.deepEqual(fitWithin(4000, 3000, 1024), { width: 1024, height: 768 });
  assert.deepEqual(fitWithin(3000, 4000, 1024), { width: 768, height: 1024 });
  assert.deepEqual(fitWithin(2048, 2048, 1024), { width: 1024, height: 1024 });
});

test("fitWithin never enlarges, and never returns 0", () => {
  assert.deepEqual(fitWithin(800, 600, 1024), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(1024, 1024, 1024), { width: 1024, height: 1024 });
  assert.deepEqual(fitWithin(10000, 1, 1024), { width: 1024, height: 1 });
});

// --- Worker ----------------------------------------------------------------------------------------------------------
const tmp = path.join(os.tmpdir(), `ub-images-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;
const SITE = "https://site.example";

/** A tiny in-memory stand-in for the two tables involved. `signedIn` false = no session. */
function makeEnv({ field = "Species", index = null, signedIn = true } = {}) {
  const list = { id: "sp1", user_id: "public", field, value: "Snapper", image_index: index };
  const images = new Map();
  const batches = [];
  const runs = [];
  const stmt = (sql) => {
    let args = [];
    return {
      sql,
      get args() { return args; },
      bind(...a) { args = a; return this; },
      async first() {
        if (/FROM sessions/.test(sql)) return signedIn ? { id: "admin-id", role: "admin" } : null;
        if (/FROM user_mark_lists WHERE id/.test(sql)) return args[0] === list.id ? { ...list } : null;
        if (/FROM species_images WHERE id/.test(sql)) return images.get(args[0]) || null;
        return null;
      },
      async run() { runs.push({ sql, args }); return {}; },
    };
  };
  const apply = (s) => {
    if (/INSERT INTO species_images/.test(s.sql)) images.set(s.args[0], { content_type: s.args[2], data: s.args[3], updated_at: s.args[4] });
    else if (/DELETE FROM species_images/.test(s.sql)) images.delete(s.args[0]);
    else if (/UPDATE user_mark_lists SET image_index/.test(s.sql)) list.image_index = s.args[0];
  };
  return {
    list, images, batches, runs,
    ALLOWED_ORIGIN: SITE,
    DB: {
      prepare: stmt,
      async batch(stmts) { batches.push(stmts.length); stmts.forEach(apply); return []; },
    },
  };
}
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const call = (env, method, urlPath, { type = "image/jpeg", body } = {}) =>
  worker.fetch(
    new Request(`https://worker.example${urlPath}`, {
      method,
      headers: { Cookie: "session=s", Origin: SITE, ...(type ? { "Content-Type": type } : {}) },
      body: method === "GET" || method === "DELETE" ? undefined : body ?? JPEG,
    }),
    env
  );

test("adding an image stores it, indexes it on the list entry and returns the entry with its images", async () => {
  const env = makeEnv();
  const res = await call(env, "POST", "/api/marklists/sp1/images?userId=public");
  assert.equal(res.status, 201);
  const row = await res.json();
  assert.equal(row.images.length, 1);
  assert.match(row.images[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(typeof row.images[0].version, "number");
  assert.equal(env.batches.length, 1, "table row and index change in one batch");
  assert.equal(env.images.get(row.images[0].id).content_type, "image/jpeg");
  assert.equal(Buffer.from(env.images.get(row.images[0].id).data, "base64").equals(Buffer.from(JPEG)), true);
});

test("a second image is added after the first; replacing changes only that image's version", async () => {
  const env = makeEnv();
  const a = (await (await call(env, "POST", "/api/marklists/sp1/images?userId=public")).json()).images[0];
  await new Promise((r) => setTimeout(r, 5));
  const two = await (await call(env, "POST", "/api/marklists/sp1/images?userId=public")).json();
  assert.deepEqual(two.images.map((i) => i.id).slice(0, 1), [a.id], "kept in the order they were added");
  assert.equal(two.images.length, 2);
  await new Promise((r) => setTimeout(r, 5));
  const replaced = await (await call(env, "PUT", `/api/marklists/sp1/images/${a.id}?userId=public`, { body: new Uint8Array([9, 9, 9]) })).json();
  assert.equal(replaced.images.length, 2);
  assert.equal(replaced.images[0].id, a.id);
  assert.ok(replaced.images[0].version > a.version, "a fresh version, so caches refetch it");
  assert.equal(replaced.images[1].version, two.images[1].version, "the other image is untouched");
  assert.equal(Buffer.from(env.images.get(a.id).data, "base64").length, 3);
});

test("deleting removes just that image, and the index goes back to none after the last", async () => {
  const env = makeEnv();
  const a = (await (await call(env, "POST", "/api/marklists/sp1/images")).json()).images[0];
  const two = await (await call(env, "POST", "/api/marklists/sp1/images")).json();
  const afterOne = await (await call(env, "DELETE", `/api/marklists/sp1/images/${a.id}`)).json();
  assert.deepEqual(afterOne.images.map((i) => i.id), [two.images[1].id]);
  assert.equal(env.images.has(a.id), false);
  const gone = await (await call(env, "DELETE", `/api/marklists/sp1/images/${two.images[1].id}`)).json();
  assert.deepEqual(gone.images, []);
  assert.equal(env.list.image_index, null);
  assert.equal((await call(env, "DELETE", "/api/marklists/sp1/images/nope")).status, 404);
});

test("a species can hold 12 images and the 13th is refused", async () => {
  const index = JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, v: 1 })));
  const env = makeEnv({ index });
  const res = await call(env, "POST", "/api/marklists/sp1/images");
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /at most 12/);
  assert.deepEqual(env.batches, []);
});

test("bad uploads are refused and nothing is saved", async () => {
  const cases = [
    ["wrong type", { type: "image/gif" }, 400],
    ["no type", { type: "" }, 400],
    ["empty body", { body: new Uint8Array(0) }, 400],
    ["too large", { body: new Uint8Array(700 * 1024 + 1) }, 413],
  ];
  for (const [label, opts, status] of cases) {
    const env = makeEnv();
    const res = await call(env, "POST", "/api/marklists/sp1/images", opts);
    assert.equal(res.status, status, label);
    assert.deepEqual(env.batches, [], label);
  }
  const notSpecies = makeEnv({ field: "Bait" });
  assert.equal((await call(notSpecies, "POST", "/api/marklists/sp1/images")).status, 400);
  const signedOut = makeEnv({ signedIn: false });
  assert.equal((await call(signedOut, "POST", "/api/marklists/sp1/images")).status, 401);
  assert.equal((await call(makeEnv(), "POST", "/api/marklists/missing/images")).status, 404);
  assert.equal((await call(makeEnv(), "PUT", "/api/marklists/sp1/images/nope")).status, 404);
});

test("the public image endpoint serves the bytes with a long cache lifetime, and 404s when missing", async () => {
  const env = makeEnv();
  const image = (await (await call(env, "POST", "/api/marklists/sp1/images")).json()).images[0];
  const res = await worker.fetch(new Request(`https://worker.example/api/public/species-image/${image.id}?v=${image.version}`), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "image/jpeg");
  assert.match(res.headers.get("Cache-Control"), /max-age=31536000, immutable/);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), JPEG);
  const missing = await worker.fetch(new Request("https://worker.example/api/public/species-image/nope"), env);
  assert.equal(missing.status, 404);
});

test("deleting a species also deletes its images", async () => {
  const env = makeEnv();
  await call(env, "POST", "/api/marklists/sp1/images");
  const res = await call(env, "DELETE", "/api/marklists/sp1?userId=public", { type: "" });
  assert.equal(res.status, 204);
  assert.ok(env.runs.some((r) => /DELETE FROM species_images WHERE list_id = \?/.test(r.sql) && r.args[0] === "sp1"));
});
