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
    grab(/const SESSION_MULTI_VALUE_FIELDS = [^\n]*\r?\n/),
    grab(/function typeAllowsMultipleValues[\s\S]*?\r?\n}\r?\n/),
    "return { fieldKeysForMarkType, typeRequiresSpecies, typeAllowsMultipleSpecies, typeAllowsMultipleValues };",
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

test("Session allows several baits, rigs and rods (and berley), other types do not", () => {
  for (const k of ["bait", "rig", "rod", "berley", "species"]) {
    assert.equal(fns.typeAllowsMultipleValues("Session", k), true, k);
    assert.equal(fns.typeAllowsMultipleValues("Catch", k), false, k);
  }
  assert.equal(fns.typeAllowsMultipleValues("Session", "weatherCondition"), false);
});

test("Session has no Size or Released; Catch still does", () => {
  const session = fns.fieldKeysForMarkType("Session");
  assert.ok(!session.includes("size"));
  assert.ok(!session.includes("released"));
  for (const k of ["species", "bait", "rig", "rod", "notes"]) assert.ok(session.includes(k), k);
  const c = fns.fieldKeysForMarkType("Catch");
  assert.ok(c.includes("size") && c.includes("released"));
});