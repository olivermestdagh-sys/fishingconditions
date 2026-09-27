// Trips > Trip Setups (user_trip_setups): a named bundle of Rod Setups plus Species/Water/Berley/
// Fishing Method/Lure. Same CRUD shape as Rod Setups (/api/rodsetups) — list, create, update, delete,
// each scoped to the signed-in user.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = path.join(os.tmpdir(), `ub-trip-setups-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const SITE = "https://site.example";

/** An in-memory user_trip_setups table, just enough to exercise the collection/item handlers. */
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
            if (/FROM user_trip_setups WHERE id = \? AND user_id = \?/.test(sql)) {
              return rows.find((r) => r.id === args[0] && r.user_id === args[1]) || null;
            }
            if (/FROM user_trip_setups WHERE id = \?/.test(sql)) {
              return rows.find((r) => r.id === args[0]) || null;
            }
            return null;
          },
          async all() {
            if (/FROM user_trip_setups WHERE user_id = \?/.test(sql)) {
              return { results: rows.filter((r) => r.user_id === args[0]).sort((a, b) => a.name.localeCompare(b.name)) };
            }
            return { results: [] };
          },
          async run() {
            if (/^INSERT INTO user_trip_setups/.test(sql)) {
              const [id, user_id, name, rod_setup_ids, species, water, berley, fishing_method, lure, created_at] = args;
              if (rows.some((r) => r.user_id === user_id && r.name === name)) throw new Error("UNIQUE constraint failed");
              rows.push({ id, user_id, name, rod_setup_ids, species, water, berley, fishing_method, lure, created_at });
            } else if (/^UPDATE user_trip_setups/.test(sql)) {
              const [name, rod_setup_ids, species, water, berley, fishing_method, lure, id, user_id] = args;
              if (rows.some((r) => r.user_id === user_id && r.name === name && r.id !== id)) throw new Error("UNIQUE constraint failed");
              const row = rows.find((r) => r.id === id && r.user_id === user_id);
              Object.assign(row, { name, rod_setup_ids, species, water, berley, fishing_method, lure });
            } else if (/^DELETE FROM user_trip_setups/.test(sql)) {
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

test("create, list, update and delete a trip setup", async () => {
  const env = makeEnv();

  let res = await req(env, "POST", "/api/tripsetups", { name: "Weekend trip", rodSetupIds: ["rs1", "rs2"], species: ["Bream", "Whiting"] });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.name, "Weekend trip");
  assert.deepEqual(created.rodSetupIds, ["rs1", "rs2"]);
  assert.deepEqual(created.species, ["Bream", "Whiting"]);
  assert.equal(created.water, null);
  assert.equal(created.berley, null);
  assert.deepEqual(created.fishingMethod, []);
  assert.deepEqual(created.lure, []);

  res = await req(env, "GET", "/api/tripsetups");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [created]);

  res = await req(env, "PUT", `/api/tripsetups/${created.id}`, { water: "Clear", berley: "Pilchard", fishingMethod: ["Bait"], lure: ["Soft plastic"] });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(updated.water, "Clear");
  assert.equal(updated.berley, "Pilchard");
  assert.deepEqual(updated.fishingMethod, ["Bait"]);
  assert.deepEqual(updated.lure, ["Soft plastic"]);
  assert.deepEqual(updated.rodSetupIds, ["rs1", "rs2"]); // untouched fields stay as they were

  res = await req(env, "DELETE", `/api/tripsetups/${created.id}`);
  assert.equal(res.status, 204);
  res = await req(env, "GET", "/api/tripsetups");
  assert.deepEqual(await res.json(), []);
});

test("a name must be unique per account", async () => {
  const env = makeEnv();
  await req(env, "POST", "/api/tripsetups", { name: "Weekend trip" });
  const res = await req(env, "POST", "/api/tripsetups", { name: "Weekend trip" });
  assert.equal(res.status, 409);
});

test("name is required to create", async () => {
  const env = makeEnv();
  const res = await req(env, "POST", "/api/tripsetups", { species: ["Bream"] });
  assert.equal(res.status, 400);
});

test("array fields must be lists of non-empty strings", async () => {
  const env = makeEnv();
  const create = await (await req(env, "POST", "/api/tripsetups", { name: "Weekend trip" })).json();
  for (const bad of [{ species: ["ok", ""] }, { rodSetupIds: "not-an-array" }, { fishingMethod: [5] }]) {
    const res = await req(env, "PUT", `/api/tripsetups/${create.id}`, bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
});

test("water/berley must be strings or null", async () => {
  const env = makeEnv();
  const create = await (await req(env, "POST", "/api/tripsetups", { name: "Weekend trip" })).json();
  const res = await req(env, "PUT", `/api/tripsetups/${create.id}`, { water: 5 });
  assert.equal(res.status, 400);
});

test("a missing trip setup 404s", async () => {
  const env = makeEnv();
  const res = await req(env, "PUT", "/api/tripsetups/nope", { name: "x" });
  assert.equal(res.status, 404);
});
