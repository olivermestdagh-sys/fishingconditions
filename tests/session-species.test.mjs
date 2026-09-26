// Session marks (Session Start / Session End): species are optional multiple targets and never drive the Name.
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
    grab(/const SESSION_TYPE_ROLES = [^\n]*\r?\n/),
    grab(/function isSessionType[\s\S]*?\r?\n}\r?\n/),
    grab(/function sessionRoleForType[\s\S]*?\r?\n}\r?\n/),
    grab(/const SESSION_FIELD_KEYS = [^\n]*\r?\n/),
    grab(/MARK_TYPE_FIELD_KEYS\["Session Start"\] = [^\n]*\r?\n/),
    grab(/MARK_TYPE_FIELD_KEYS\["Session End"\] = [^\n]*\r?\n/),
    grab(/function fieldKeysForMarkType[\s\S]*?\r?\n}\r?\n/),
    grab(/function typeRequiresSpecies[\s\S]*?\r?\n}\r?\n/),
    grab(/function typeAllowsMultipleSpecies[\s\S]*?\r?\n}\r?\n/),
    grab(/const SESSION_MULTI_VALUE_FIELDS = [^\n]*\r?\n/),
    grab(/function typeAllowsMultipleValues[\s\S]*?\r?\n}\r?\n/),
    "return { fieldKeysForMarkType, typeRequiresSpecies, typeAllowsMultipleSpecies, typeAllowsMultipleValues, isSessionType, sessionRoleForType };",
  ].join("\n")
)();

const SESSION_TYPES = ["Session Start", "Session End"];

test("Session Start and Session End are session types with a role; nothing else is", () => {
  assert.equal(fns.isSessionType("Session Start"), true);
  assert.equal(fns.isSessionType("Session End"), true);
  for (const t of ["Session", "Catch", "Mark", "POI", "Fish", "", undefined, "toString"]) assert.equal(fns.isSessionType(t), false, String(t));
  assert.equal(fns.sessionRoleForType("Session Start"), "start");
  assert.equal(fns.sessionRoleForType("Session End"), "end");
  assert.equal(fns.sessionRoleForType("Catch"), null);
});

test("A session has species field but does not require it", () => {
  for (const t of SESSION_TYPES) {
    assert.ok(fns.fieldKeysForMarkType(t).includes("species"), t);
    assert.equal(fns.typeRequiresSpecies(t), false, t);
  }
});

test("Catch and Mark still require a species; POI has none", () => {
  assert.equal(fns.typeRequiresSpecies("Catch"), true);
  assert.equal(fns.typeRequiresSpecies("Mark"), true);
  assert.equal(fns.typeRequiresSpecies("POI"), false);
});

test("only a Session allows multiple species", () => {
  for (const t of SESSION_TYPES) assert.equal(fns.typeAllowsMultipleSpecies(t), true, t);
  for (const t of ["Catch", "Mark", "POI", "Fish"]) assert.equal(fns.typeAllowsMultipleSpecies(t), false);
});

test("A session allows several baits, rigs and rods (and berley, fishing method), other types do not", () => {
  for (const k of ["bait", "rig", "rod", "berley", "fishingMethod", "species"]) {
    for (const t of SESSION_TYPES) assert.equal(fns.typeAllowsMultipleValues(t, k), true, `${t} ${k}`);
    assert.equal(fns.typeAllowsMultipleValues("Catch", k), false, k);
  }
  assert.equal(fns.typeAllowsMultipleValues("Session Start", "weatherCondition"), false);
});

test("A session has no Size or Released; Catch still does", () => {
  const session = fns.fieldKeysForMarkType("Session Start");
  assert.deepEqual(fns.fieldKeysForMarkType("Session End"), session);
  assert.ok(!session.includes("size"));
  assert.ok(!session.includes("released"));
  for (const k of ["species", "bait", "rig", "rod", "notes"]) assert.ok(session.includes(k), k);
  const c = fns.fieldKeysForMarkType("Catch");
  assert.ok(c.includes("size") && c.includes("released"));
});
