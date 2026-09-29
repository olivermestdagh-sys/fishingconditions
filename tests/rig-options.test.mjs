// Rig options on the mark edit form: rigSublistMapFor (js/marks-core.js) — a rig's sub-options, own list plus a private override.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../js/marks-core.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const m = /function rigSublistMapFor[\s\S]*?\n}\n/.exec(src);
assert.ok(m, "rigSublistMapFor not found");
const make = (overrides) => new Function("rigSublistOverridesMap", `${m[0]}\nreturn rigSublistMapFor;`)(overrides);

test("a rig's own sub list is offered, and rigs without one are left out", () => {
  const rows = [
    { field: "Rig", id: "r1", value: "Soft plastic rig", hasSublist: true, subList: ["Vibe", "Paddle Tail", "Vibe"] },
    { field: "Rig", id: "r2", value: "Running sinker", hasSublist: false, subList: ["ignored"] },
    { field: "Rod", id: "x", value: "Light", hasSublist: true, subList: ["nope"] },
  ];
  assert.deepEqual(make(new Map())(rows), { "Soft plastic rig": ["Vibe", "Paddle Tail"] });
});

test("your private sub list on a rig you don't own is added", () => {
  const rows = [{ field: "Rig", id: "pub1", value: "Paternoster", hasSublist: false }, { field: "Rig", id: "pub2", value: "Jig", hasSublist: true, subList: ["A"] }];
  const fn = make(new Map([["pub1", ["Sinker 20g"]], ["pub2", ["B", "A"]]]));
  assert.deepEqual(fn(rows), { Paternoster: ["Sinker 20g"], Jig: ["A", "B"] });
});
