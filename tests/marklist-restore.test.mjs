// Settings > Mark Lists safety net: counting the marks that use a value (the delete prompt) and finding values marks use
// that the lists no longer have ("Restore missing values"). Pure helpers in locationsadmin.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const admin = read("../locationsadmin.js");
const backend = read("../js/backend.js");
const grab = (src, re) => {
  const m = re.exec(src);
  assert.ok(m, `not found: ${re}`);
  return m[0];
};
const code = [
  grab(backend, /const MARK_LIST_FIELDS = \[[\s\S]*?\n\];\n/),
  grab(backend, /function markFieldValue\(mark, key\)[\s\S]*?\n}\n/),
  grab(backend, /const MARK_FILTER_MULTI_VALUE_KEYS[^\n]*\n/),
  grab(backend, /function markFieldValues[\s\S]*?\n}\n/),
  grab(admin, /const LOCKED_MARK_LIST_KEYS[^\n]*\n/),
  grab(admin, /function marksUsingValue[\s\S]*?\n}\n/),
  grab(admin, /function findMissingListValues[\s\S]*?\n}\n/),
].join("\n");
const { marksUsingValue, findMissingListValues } = new Function(`${code}\nreturn { marksUsingValue, findMissingListValues };`)();

const marks = [
  { type: "Mark", species: "Snapper" },
  { type: "Catch", species: "Bream", bait: "Squid", rig: "Soft plastic", rigOptions: "Vibe", rod: "L Wilson", tideCondition: "Running In" },
  { type: "Session Start", species: "Bream, Flathead", bait: "Prawn, Squid", rig: "Lure, Jig Head", rigOptions: "Paddle Tail", rod: "L Raider, M Penn" },
  { type: "Catch", species: "Snapper", bait: "squid", rig: "Soft plastic", rigOptions: "Vibe, Paddle Tail" },
];

test("marksUsingValue counts each pick of a comma-joined field, ignoring case", () => {
  assert.equal(marksUsingValue(marks, "species", "Snapper"), 2);
  assert.equal(marksUsingValue(marks, "species", "Flathead"), 1);
  assert.equal(marksUsingValue(marks, "bait", "Squid"), 3, "Squid, squid and one of Prawn, Squid");
  assert.equal(marksUsingValue(marks, "bait", "Nope"), 0);
  assert.equal(marksUsingValue([], "bait", "Squid"), 0);
  assert.equal(marksUsingValue(undefined, "bait", "Squid"), 0);
});

test("a rig option's count is narrowed to marks on that rig", () => {
  assert.equal(marksUsingValue(marks, "rigOptions", "Vibe", "Soft plastic"), 2);
  assert.equal(marksUsingValue(marks, "rigOptions", "Paddle Tail", "Soft plastic"), 1);
  assert.equal(marksUsingValue(marks, "rigOptions", "Paddle Tail", "Lure"), 1, "a mark with several rigs still counts for each");
  assert.equal(marksUsingValue(marks, "rigOptions", "Paddle Tail"), 2, "no rig given: every mark");
});

const lists = {
  Species: ["Snapper", "Bream"],
  Bait: ["Squid"],
  Rig: ["Soft plastic", "Lure"],
  Rod: ["L Wilson"],
  "Tide Condition": [],
};
const has = (label, value) => (lists[label] || []).some((v) => v.toLowerCase() === String(value).toLowerCase());
const rigOptions = { "soft plastic": ["Vibe"] };
const rigOptionsOf = (rig) => rigOptions[String(rig).toLowerCase()] || [];

test("missing values are what marks use but the lists lack, split per pick, matched case-insensitively, locked fields skipped", () => {
  const found = findMissingListValues(marks, has, rigOptionsOf);
  const names = found.values.map((v) => `${v.field}:${v.value}`).sort();
  assert.deepEqual(names, ["Bait:Prawn", "Rig:Jig Head", "Rod:L Raider", "Rod:M Penn", "Species:Flathead"]);
  assert.ok(!names.some((n) => n.startsWith("Tide Condition")), "tide values are never offered");
  assert.ok(!names.some((n) => n.startsWith("Mark Type")), "mark types are never offered");
  assert.equal(new Set(names).size, names.length, "no duplicates");
});

test("rig options are only taken from marks with exactly one rig, and only the ones the rig lacks", () => {
  const found = findMissingListValues(marks, has, rigOptionsOf);
  assert.deepEqual(found.rigOptions, [{ rig: "Soft plastic", option: "Paddle Tail" }]);
});

test("nothing is missing when every value is in the lists", () => {
  const all = () => true;
  const found = findMissingListValues(marks, all, () => ["Vibe", "Paddle Tail"]);
  assert.deepEqual(found, { values: [], rigOptions: [] });
});
