// A normal user's own private override of a Public mark-list row's Shape/Colour Format pick (on a
// VALUE row like Species/Bait/Rig) or of a Format DEFINITION row's own icon/hex colour (Mark Shape
// Format / Mark Colour Format) — user_marklist_format_overrides / /api/marklist-format-overrides.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = path.join(os.tmpdir(), `ub-format-overrides-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const SITE = "https://site.example";

/** rows: [{id, user_id, field}] mark-list rows this test cares about; overrides: in-memory table. */
function makeEnv(rows, callerId = "u1") {
  const overrides = [];
  return {
    overrides,
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
            if (/FROM sessions/.test(sql)) return { id: callerId, role: "basic" };
            if (/FROM user_mark_lists WHERE id/.test(sql)) return rows.find((r) => r.id === args[0]) || null;
            if (/FROM user_marklist_format_overrides WHERE user_id = \? AND public_row_id = \?/.test(sql)) {
              return overrides.find((o) => o.user_id === args[0] && o.public_row_id === args[1]) || null;
            }
            return null;
          },
          async all() {
            return { results: overrides.filter((o) => o.user_id === args[0]) };
          },
          async run() {
            if (/^INSERT INTO user_marklist_format_overrides/.test(sql)) {
              const [id, user_id, public_row_id, shape_format, color_format, icon, color_value] = args;
              overrides.push({ id, user_id, public_row_id, shape_format, color_format, icon, color_value });
            } else if (/^UPDATE user_marklist_format_overrides SET/.test(sql)) {
              const [shape_format, color_format, icon, color_value, id] = args;
              const row = overrides.find((o) => o.id === id);
              if (row) Object.assign(row, { shape_format, color_format, icon, color_value });
            } else if (/^DELETE FROM user_marklist_format_overrides WHERE id/.test(sql)) {
              const idx = overrides.findIndex((o) => o.id === args[0]);
              if (idx !== -1) overrides.splice(idx, 1);
            } else if (/^DELETE FROM user_marklist_format_overrides WHERE user_id/.test(sql)) {
              const idx = overrides.findIndex((o) => o.user_id === args[0] && o.public_row_id === args[1]);
              if (idx !== -1) overrides.splice(idx, 1);
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
    new Request(`https://worker.example${path}`, {
      method,
      headers: { Cookie: "session=s", Origin: SITE, "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    env
  );

test("override a Public species' Colour Format, then list it", async () => {
  const env = makeEnv([{ id: "sp1", user_id: "public", field: "Species" }]);
  let res = await req(env, "PUT", "/api/marklist-format-overrides/sp1", { colorFormat: "Yellow" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { publicRowId: "sp1", shapeFormat: null, colorFormat: "Yellow", icon: null, colorValue: null });

  res = await req(env, "GET", "/api/marklist-format-overrides");
  assert.deepEqual(await res.json(), [{ publicRowId: "sp1", shapeFormat: null, colorFormat: "Yellow", icon: null, colorValue: null }]);
});

test("clearing the only overridden field deletes the row entirely", async () => {
  const env = makeEnv([{ id: "sp1", user_id: "public", field: "Species" }]);
  await req(env, "PUT", "/api/marklist-format-overrides/sp1", { colorFormat: "Yellow" });
  assert.equal(env.overrides.length, 1);
  const res = await req(env, "PUT", "/api/marklist-format-overrides/sp1", { colorFormat: null });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { publicRowId: "sp1", shapeFormat: null, colorFormat: null, icon: null, colorValue: null });
  assert.equal(env.overrides.length, 0);
});

test("override a Public Mark Shape Format's own icon", async () => {
  const env = makeEnv([{ id: "fmt1", user_id: "public", field: "Mark Shape Format" }]);
  const res = await req(env, "PUT", "/api/marklist-format-overrides/fmt1", { icon: "triangle" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).icon, "triangle");
});

test("shapeFormat/colorFormat rejected on a Format definition row", async () => {
  const env = makeEnv([{ id: "fmt1", user_id: "public", field: "Mark Shape Format" }]);
  const res = await req(env, "PUT", "/api/marklist-format-overrides/fmt1", { shapeFormat: "x" });
  assert.equal(res.status, 400);
});

test("icon rejected on anything but a Mark Shape Format; colorValue rejected on anything but a Mark Colour Format", async () => {
  const env = makeEnv([
    { id: "sp1", user_id: "public", field: "Species" },
    { id: "cfmt1", user_id: "public", field: "Mark Colour Format" },
  ]);
  assert.equal((await req(env, "PUT", "/api/marklist-format-overrides/sp1", { icon: "circle" })).status, 400);
  assert.equal((await req(env, "PUT", "/api/marklist-format-overrides/cfmt1", { icon: "circle" })).status, 400);
  assert.equal((await req(env, "PUT", "/api/marklist-format-overrides/sp1", { colorValue: "#fff" })).status, 400);
});

test("rejected if you own the row — edit it directly instead", async () => {
  const env = makeEnv([{ id: "sp1", user_id: "u1", field: "Species" }]);
  const res = await req(env, "PUT", "/api/marklist-format-overrides/sp1", { colorFormat: "Yellow" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /own this/);
});

test("404 for a missing row", async () => {
  const env = makeEnv([]);
  const res = await req(env, "PUT", "/api/marklist-format-overrides/nope", { colorFormat: "Yellow" });
  assert.equal(res.status, 404);
});

test("DELETE removes the whole override row", async () => {
  const env = makeEnv([{ id: "sp1", user_id: "public", field: "Species" }]);
  await req(env, "PUT", "/api/marklist-format-overrides/sp1", { shapeFormat: "Circle", colorFormat: "Yellow" });
  assert.equal(env.overrides.length, 1);
  const res = await req(env, "DELETE", "/api/marklist-format-overrides/sp1");
  assert.equal(res.status, 204);
  assert.equal(env.overrides.length, 0);
});
