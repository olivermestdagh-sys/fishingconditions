// Session marks: species are optional multiple targets and never drive the Name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSharedScripts } from "./helpers.mjs";

const src = readSharedScripts();
const grab = (re) => {
  const m = src.match(re);
  if (!m) throw new Error("could not find in js/*.js: " + re);
  return m[0];
};
const fns = new Function(
  [
    grab(/const MARK_TYPE_FIELD_KEYS = \{[\s\S]*?\r?\n};\r?\n/),
    grab(/MARK_TYPE_FIELD_KEYS\.Fish = [^\n]*\r?\n/),
    grab(/MARK_TYPE_FIELD_KEYS\.Session = [^\n]*\r?\n/),
    grab(/function fieldKeysForMarkType[\s\S]*?\r?\n}\r?\n/),
    grab(/function typeRequiresSpecies[\s\S]*?\r?\n}\r?\n/),
    grab(/function typeAllowsMultipleSpecies[\s\S]*?\r?\n}\r?\n/),
    "return { fieldKeysForMarkType, typeRequiresSpecies, typeAllowsMultipleSpecies };",
  ].join("\n")
)();

test("Session has species field but does not require it", () => {
  assert.ok(fns.fieldKeysForMarkType("Session").includes("species"));
  assert.equal(fns.typeRequiresSpecies("Session"), false);
});

test("Catch and Mark still require a species; POI has none", () => {
  assert.equal(fns.typeRequiresSpecies("Catch"), true);
  assert.equal(fns.typeRequiresSpecies("Mark"), true);
  assert.equal(fns.typeRequiresSpecies("POI"), false);
});

test("only a Session allows multiple species", () => {
  assert.equal(fns.typeAllowsMultipleSpecies("Session"), true);
  for (const t of ["Catch", "Mark", "POI", "Fish"]) assert.equal(fns.typeAllowsMultipleSpecies(t), false);
});
