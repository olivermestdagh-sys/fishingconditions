// Combined species limits: species sharing a qty_group share one Max Qty (e.g. School + Gummy shark).
// planSpeciesLinks decides the row changes; the Worker applies them in one batch.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const source = fs.readFileSync(new URL("../user-backend.js", import.meta.url), "utf8");
const planSrc = source.match(/function planSpeciesLinks[\s\S]*?\r?\n}\r?\n/);
if (!planSrc) throw new Error("could not find planSpeciesLinks in user-backend.js");
const planSpeciesLinks = new Function(planSrc[0] + "\nreturn planSpeciesLinks;")();

const row = (id, value, qtyGroup = null, maxQty = null) => ({ id, value, qtyGroup, maxQty });
const plan = (rows, editedId, linkedValues, maxQty) => planSpeciesLinks({ rows, editedId, linkedValues, maxQty, newGroupId: "NEW" });
const byId = (updates) => Object.fromEntries(updates.map((u) => [u.id, u]));

test("linking two species puts both in a new group with the edited species' Max Qty", () => {
  const rows = [row("a", "Shark (School)", null, 2), row("b", "Shark (Gummy)", null, 5), row("c", "Snapper")];
  const { updates } = plan(rows, "a", ["Shark (Gummy)"], 2);
  assert.deepEqual(byId(updates), { a: { id: "a", qtyGroup: "NEW", maxQty: 2 }, b: { id: "b", qtyGroup: "NEW", maxQty: 2 } });
});

test("adding a third joins the existing group and takes the shared Max Qty", () => {
  const rows = [row("a", "School", "G", 2), row("b", "Gummy", "G", 2), row("c", "Bronze whaler", null, 9)];
  const { updates } = plan(rows, "a", ["Gummy", "Bronze whaler"], 2);
  assert.deepEqual(byId(updates), { c: { id: "c", qtyGroup: "G", maxQty: 2 } });
});

test("unticking a species removes only that one from the group", () => {
  const rows = [row("a", "School", "G", 2), row("b", "Gummy", "G", 2), row("c", "Bronze whaler", "G", 2)];
  const { updates } = plan(rows, "a", ["Gummy"], 2);
  assert.deepEqual(byId(updates), { c: { id: "c", qtyGroup: null, maxQty: 2 } }, "the ticked mate is not pulled back in");
});

test("unticking everything leaves a group of one, which is no group", () => {
  const rows = [row("a", "School", "G", 2), row("b", "Gummy", "G", 2)];
  const { updates } = plan(rows, "a", [], 2);
  assert.deepEqual(byId(updates), { a: { id: "a", qtyGroup: null, maxQty: 2 }, b: { id: "b", qtyGroup: null, maxQty: 2 } });
});

test("choosing a species from another group merges the two groups", () => {
  const rows = [row("a", "School", "G1", 2), row("b", "Gummy", "G1", 2), row("c", "Bronze whaler", "G2", 4), row("d", "Wobbegong", "G2", 4), row("e", "Snapper")];
  const { updates } = plan(rows, "a", ["Gummy", "Bronze whaler"], 2);
  assert.deepEqual(byId(updates), { c: { id: "c", qtyGroup: "G1", maxQty: 2 }, d: { id: "d", qtyGroup: "G1", maxQty: 2 } });
});

test("merging into a species that had no group of its own reuses the chosen group's members", () => {
  const rows = [row("a", "School", null, 3), row("b", "Gummy", "G2", 4), row("c", "Bronze whaler", "G2", 4)];
  const { updates } = plan(rows, "a", ["Gummy"], 3);
  assert.deepEqual(byId(updates), {
    a: { id: "a", qtyGroup: "NEW", maxQty: 3 },
    b: { id: "b", qtyGroup: "NEW", maxQty: 3 },
    c: { id: "c", qtyGroup: "NEW", maxQty: 3 },
  });
});

test("nothing to change gives no updates; a blank Max Qty is shared as blank", () => {
  const same = [row("a", "School", "G", 2), row("b", "Gummy", "G", 2)];
  assert.deepEqual(plan(same, "a", ["Gummy"], 2).updates, []);
  const blank = plan([row("a", "School", null, null), row("b", "Gummy", null, 6)], "a", ["Gummy"], null);
  assert.deepEqual(byId(blank.updates), { a: { id: "a", qtyGroup: "NEW", maxQty: null }, b: { id: "b", qtyGroup: "NEW", maxQty: null } });
});

test("unknown species, itself and a missing edited species are errors", () => {
  const rows = [row("a", "School"), row("b", "Gummy")];
  assert.match(plan(rows, "a", ["Nope"], 1).error, /isn't a species/);
  assert.match(plan(rows, "a", ["School"], 1).error, /itself/);
  assert.match(plan(rows, "zzz", [], 1).error, /not found/);
});

// --- the Worker end: PUT linkedSpecies is applied as one batch ---------------------------------------------
const tmp = path.join(os.tmpdir(), `ub-links-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;
const SITE = "https://site.example";

function makeEnv(rows, field = "Species") {
  const batches = [];
  const runs = [];
  return {
    batches,
    runs,
    ALLOWED_ORIGIN: SITE,
    DB: {
      prepare(sql) {
        let args = [];
        return {
          sql,
          get args() { return args; },
          bind(...a) { args = a; return this; },
          async first() {
            if (/FROM sessions/.test(sql)) return { id: "admin-id", role: "admin" };
            if (/FROM user_mark_lists WHERE id/.test(sql)) {
              const r = rows.find((x) => x.id === args[0]);
              return r ? { id: r.id, user_id: "public", field, value: r.value, max_qty: r.maxQty, qty_group: r.qtyGroup } : null;
            }
            return null;
          },
          async run() { runs.push({ sql, args }); return {}; },
          async all() {
            return { results: rows.map((r) => ({ id: r.id, value: r.value, qty_group: r.qtyGroup, max_qty: r.maxQty })) };
          },
        };
      },
      async batch(stmts) { batches.push(stmts.map((s) => ({ sql: s.sql, args: s.args }))); return []; },
    },
  };
}
const put = (env, id, body) =>
  worker.fetch(
    new Request(`https://worker.example/api/marklists/${id}?userId=public`, {
      method: "PUT",
      headers: { Cookie: "session=s", Origin: SITE, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env
  );

test("PUT linkedSpecies writes every changed row in a single batch", async () => {
  const env = makeEnv([row("a", "School", null, 2), row("b", "Gummy", null, 5)]);
  const res = await put(env, "a", { linkedSpecies: ["Gummy"] });
  assert.equal(res.status, 200);
  assert.equal(env.batches.length, 1);
  assert.equal(env.batches[0].length, 2);
  for (const stmt of env.batches[0]) {
    assert.match(stmt.sql, /UPDATE user_mark_lists SET qty_group = \?, max_qty = \?/);
    assert.equal(stmt.args[1], 2, "everyone gets the edited species' Max Qty");
    assert.ok(stmt.args[0], "a group id is assigned");
  }
  assert.equal(env.batches[0][0].args[0], env.batches[0][1].args[0], "both share the same group id");
});

test("PUT maxQty on a combined species is applied to its whole group", async () => {
  const env = makeEnv([row("a", "School", "G", 2), row("b", "Gummy", "G", 2)]);
  const res = await put(env, "a", { maxQty: 3 });
  assert.equal(res.status, 200);
  const groupWrite = env.runs.find((r) => /SET max_qty = \? WHERE user_id = \? AND field = 'Species' AND qty_group = \?/.test(r.sql));
  assert.ok(groupWrite, "a group-wide Max Qty update ran");
  assert.deepEqual(groupWrite.args, [3, "public", "G"]);
});

test("bad linkedSpecies is refused, and only species can be combined", async () => {
  const rows = [row("a", "School"), row("b", "Gummy")];
  for (const body of [{ linkedSpecies: "Gummy" }, { linkedSpecies: [""] }, { linkedSpecies: [3] }, { linkedSpecies: ["Nope"] }, { linkedSpecies: ["School"] }]) {
    const env = makeEnv(rows);
    const res = await put(env, "a", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(env.batches, [], JSON.stringify(body));
  }
  const env = makeEnv(rows, "Bait");
  assert.equal((await put(env, "a", { linkedSpecies: ["Gummy"] })).status, 400);
});

test("deleting a species clears a group that would be left with one member", async () => {
  const env = makeEnv([row("a", "School", "G", 2), row("b", "Gummy", "G", 2)]);
  const res = await worker.fetch(
    new Request("https://worker.example/api/marklists/a?userId=public", { method: "DELETE", headers: { Cookie: "session=s", Origin: SITE } }),
    env
  );
  assert.equal(res.status, 204);
  const cleanup = env.runs.find((r) => /SET qty_group = NULL/.test(r.sql));
  assert.ok(cleanup, "the leftover single-member group is cleared");
  assert.deepEqual(cleanup.args, ["public", "G", "public", "G"]);
});
