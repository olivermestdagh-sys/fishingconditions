// Trips > Rod Setups (user_rod_setups): a named rod+rig combo, with an optional list of items picked from
// that rig's own sub list. Same CRUD shape as Location Groups (/api/groups) — list, create, update, delete,
// each scoped to the signed-in user (or Public, via ?userId=public, same as every other v2 endpoint).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = path.join(os.tmpdir(), `ub-rod-setups-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const SITE = "https://site.example";

/** An in-memory user_rod_setups table, just enough to exercise the collection/item handlers. */
function makeEnv() {
  const rows = [];
  return {
    rows,
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
            if (/FROM sessions/.test(sql)) return { id: "admin-id", role: "admin" };
            if (/FROM user_rod_setups WHERE id = \? AND user_id = \?/.test(sql)) {
              return rows.find((r) => r.id === args[0] && r.user_id === args[1]) || null;
            }
            if (/FROM user_rod_setups WHERE id = \?/.test(sql)) {
              return rows.find((r) => r.id === args[0]) || null;
            }
            return null;
          },
          async all() {
            if (/FROM user_rod_setups WHERE user_id = \?/.test(sql)) {
              return { results: rows.filter((r) => r.user_id === args[0]).sort((a, b) => a.name.localeCompare(b.name)) };
            }
            return { results: [] };
          },
          async run() {
            if (/^INSERT INTO user_rod_setups/.test(sql)) {
              const [id, user_id, name, rod, rig, sub_list_items, bait, created_at] = args;
              if (rows.some((r) => r.user_id === user_id && r.name === name)) throw new Error("UNIQUE constraint failed");
              rows.push({ id, user_id, name, rod, rig, sub_list_items, bait, created_at });
            } else if (/^UPDATE user_rod_setups/.test(sql)) {
              const [name, rod, rig, sub_list_items, bait, id, user_id] = args;
              if (rows.some((r) => r.user_id === user_id && r.name === name && r.id !== id)) throw new Error("UNIQUE constraint failed");
              const row = rows.find((r) => r.id === id && r.user_id === user_id);
              Object.assign(row, { name, rod, rig, sub_list_items, bait });
            } else if (/^DELETE FROM user_rod_setups/.test(sql)) {
              const idx = rows.findIndex((r) => r.id === args[0] && r.user_id === args[1]);
              if (idx !== -1) rows.splice(idx, 1);
            }
            return {};
          },
        };
      },
    },
  };
}

const req = (env, method, path, body) =>
  worker.fetch(
    new Request(`https://worker.example${path}?userId=public`, {
      method,
      headers: { Cookie: "session=s", Origin: SITE, "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    env
  );

test("create, list, update and delete a rod setup", async () => {
  const env = makeEnv();

  let res = await req(env, "POST", "/api/rodsetups", { name: "Whiting rig", rod: "Light spin", rig: "Paternoster" });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.name, "Whiting rig");
  assert.equal(created.rod, "Light spin");
  assert.equal(created.rig, "Paternoster");
  assert.deepEqual(created.subListItems, []);

  res = await req(env, "GET", "/api/rodsetups");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [created]);

  res = await req(env, "PUT", `/api/rodsetups/${created.id}`, { subListItems: ["Vibe"], rig: "Soft plastic rig" });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(updated.rig, "Soft plastic rig");
  assert.deepEqual(updated.subListItems, ["Vibe"]);

  res = await req(env, "DELETE", `/api/rodsetups/${created.id}`);
  assert.equal(res.status, 204);
  res = await req(env, "GET", "/api/rodsetups");
  assert.deepEqual(await res.json(), []);
});

test("a name must be unique per account", async () => {
  const env = makeEnv();
  await req(env, "POST", "/api/rodsetups", { name: "Whiting rig" });
  const res = await req(env, "POST", "/api/rodsetups", { name: "Whiting rig" });
  assert.equal(res.status, 409);
});

test("name is required to create", async () => {
  const env = makeEnv();
  const res = await req(env, "POST", "/api/rodsetups", { rod: "Light spin" });
  assert.equal(res.status, 400);
});

test("subListItems must be a list of non-empty strings", async () => {
  const env = makeEnv();
  const create = await (await req(env, "POST", "/api/rodsetups", { name: "Whiting rig" })).json();
  const res = await req(env, "PUT", `/api/rodsetups/${create.id}`, { subListItems: ["ok", ""] });
  assert.equal(res.status, 400);
});

test("a missing setup 404s", async () => {
  const env = makeEnv();
  const res = await req(env, "PUT", "/api/rodsetups/nope", { name: "x" });
  assert.equal(res.status, 404);
});
