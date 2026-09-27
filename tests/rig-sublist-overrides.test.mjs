// A normal user's own private layer on top of a Rig they don't own (i.e. one of Public's) —
// user_rig_sublist_overrides / /api/rig-sublist-overrides. Always scoped to the caller's own id;
// rejected if the caller actually owns the referenced rig (they'd edit its own Sub List directly then).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = path.join(os.tmpdir(), `ub-rig-overrides-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const SITE = "https://site.example";

/** rigs: [{id, user_id, field}]; overrides: in-memory user_rig_sublist_overrides rows. */
function makeEnv(rigs, callerId = "u1") {
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
            if (/FROM user_mark_lists WHERE id/.test(sql)) return rigs.find((r) => r.id === args[0]) || null;
            if (/FROM user_rig_sublist_overrides WHERE user_id = \? AND rig_id = \?/.test(sql)) {
              return overrides.find((o) => o.user_id === args[0] && o.rig_id === args[1]) || null;
            }
            return null;
          },
          async all() {
            return { results: overrides.filter((o) => o.user_id === args[0]) };
          },
          async run() {
            if (/^INSERT INTO user_rig_sublist_overrides/.test(sql)) {
              const [id, user_id, rig_id, sub_list] = args;
              overrides.push({ id, user_id, rig_id, sub_list });
            } else if (/^UPDATE user_rig_sublist_overrides SET sub_list/.test(sql)) {
              const [sub_list, id] = args;
              const row = overrides.find((o) => o.id === id);
              if (row) row.sub_list = sub_list;
            } else if (/^DELETE FROM user_rig_sublist_overrides/.test(sql)) {
              const idx = overrides.findIndex((o) => o.user_id === args[0] && o.rig_id === args[1]);
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

test("create, list and update a private override on a rig you don't own", async () => {
  const env = makeEnv([{ id: "rig1", user_id: "public", field: "Rig" }]);

  let res = await req(env, "PUT", "/api/rig-sublist-overrides/rig1", { subList: ["3in Paddle Tail"] });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { rigId: "rig1", subList: ["3in Paddle Tail"] });

  res = await req(env, "GET", "/api/rig-sublist-overrides");
  assert.deepEqual(await res.json(), [{ rigId: "rig1", subList: ["3in Paddle Tail"] }]);

  res = await req(env, "PUT", "/api/rig-sublist-overrides/rig1", { subList: ["3in Paddle Tail", "Vibe"] });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).subList, ["3in Paddle Tail", "Vibe"]);

  res = await req(env, "DELETE", "/api/rig-sublist-overrides/rig1");
  assert.equal(res.status, 204);
  res = await req(env, "GET", "/api/rig-sublist-overrides");
  assert.deepEqual(await res.json(), []);
});

test("rejected if you own the rig — edit its Sub List directly instead", async () => {
  const env = makeEnv([{ id: "rig1", user_id: "u1", field: "Rig" }]);
  const res = await req(env, "PUT", "/api/rig-sublist-overrides/rig1", { subList: ["x"] });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /own this rig/);
});

test("404 for a missing rig or a non-Rig field", async () => {
  const env = makeEnv([{ id: "rig1", user_id: "public", field: "Bait" }]);
  let res = await req(env, "PUT", "/api/rig-sublist-overrides/rig1", { subList: ["x"] });
  assert.equal(res.status, 404);
  res = await req(env, "PUT", "/api/rig-sublist-overrides/nope", { subList: ["x"] });
  assert.equal(res.status, 404);
});

test("subList must be a list of non-empty strings", async () => {
  const env = makeEnv([{ id: "rig1", user_id: "public", field: "Rig" }]);
  for (const bad of [["ok", ""], "not-an-array", Array(101).fill("x")]) {
    const res = await req(env, "PUT", "/api/rig-sublist-overrides/rig1", { subList: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
});
