// Tests for getVisibleMarks (js/marks-tools.js): the Map tab's export only includes marks the filters leave visible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSharedScripts } from "./helpers.mjs";

const src = readSharedScripts();
const fn = (name) => {
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\r?\\n}\\r?\\n`));
  assert.ok(m, `${name} not found in js/*.js`);
  return m[0];
};
const personalTypes = src.match(/const PERSONAL_MARK_TYPES = [^\n]*\r?\n/);
assert.ok(personalTypes, "PERSONAL_MARK_TYPES not found in js/*.js");
const getVisibleMarks = new Function(
  [personalTypes[0], fn("markOwnerLabel"), fn("markFieldValue"), fn("markMatchesFilters"), fn("getVisibleMarks"), "return getVisibleMarks;"].join("\n")
)();

function stateWith(marks, filters) {
  return { marksById: new Map(marks.map((m) => [m.id, m])), filters };
}
const marks = [
  { id: "a", species: "Snapper", source: "Manual" },
  { id: "b", species: "Flathead", source: "garmin-import" },
  { id: "c", source: "Manual" },
];
const ids = (list) => list.map((m) => m.id).sort();

test("no filters: every mark is exported", () => {
  assert.deepEqual(ids(getVisibleMarks(stateWith(marks, {}))), ["a", "b", "c"]);
});
test("include filter keeps only matching marks (and drops marks with no value)", () => {
  const filters = { species: { include: new Set(["Snapper"]), exclude: new Set() } };
  assert.deepEqual(ids(getVisibleMarks(stateWith(marks, filters))), ["a"]);
});
test("exclude filter drops matching marks but keeps marks with no value", () => {
  const filters = { species: { include: new Set(), exclude: new Set(["Snapper"]) } };
  assert.deepEqual(ids(getVisibleMarks(stateWith(marks, filters))), ["b", "c"]);
});
test("filters on different fields combine with AND", () => {
  const filters = {
    species: { include: new Set(["Snapper", "Flathead"]), exclude: new Set() },
    source: { include: new Set(), exclude: new Set(["garmin-import"]) },
  };
  assert.deepEqual(ids(getVisibleMarks(stateWith(marks, filters))), ["a"]);
});

test("Date/Time range keeps marks between from and to (to includes its whole minute)", () => {
  const dated = [
    { id: "a", dateTime: "2026-01-01 09:59:59" },
    { id: "b", dateTime: "2026-01-01 10:00:00" },
    { id: "c", dateTime: "2026-01-01 10:30:45" },
    { id: "d", dateTime: "2026-01-01 10:30:59" },
    { id: "e", dateTime: "2026-01-01 10:31:00" },
    { id: "f" },
  ];
  const filters = { dateTime: { from: "2026-01-01T10:00", to: "2026-01-01T10:30" } };
  assert.deepEqual(ids(getVisibleMarks(stateWith(dated, filters))), ["b", "c", "d"]);
});
test("Date/Time with only one bound, or none, and it combines with other filters", () => {
  const dated = [
    { id: "a", species: "Snapper", dateTime: "2025-06-01 08:00:00" },
    { id: "b", species: "Snapper", dateTime: "2026-06-01 08:00:00" },
    { id: "c", species: "Bream", dateTime: "2026-06-01 08:00:00" },
  ];
  assert.deepEqual(ids(getVisibleMarks(stateWith(dated, { dateTime: { from: "", to: "" } }))), ["a", "b", "c"]);
  assert.deepEqual(ids(getVisibleMarks(stateWith(dated, { dateTime: { from: "2026-01-01T00:00", to: "" } }))), ["b", "c"]);
  assert.deepEqual(ids(getVisibleMarks(stateWith(dated, { dateTime: { from: "", to: "2025-12-31T23:59" } }))), ["a"]);
  const both = { dateTime: { from: "2026-01-01T00:00", to: "" }, species: { include: new Set(["Snapper"]), exclude: new Set() } };
  assert.deepEqual(ids(getVisibleMarks(stateWith(dated, both))), ["b"]);
});

test("Owner filter: Catches and Sessions are Mine, Mark and POI are Public", () => {
  const owned = [
    { id: "c", type: "Catch" },
    { id: "s", type: "Session Start" },
    { id: "e", type: "Session End" },
    { id: "m", type: "Mark" },
    { id: "p", type: "POI" },
  ];
  const only = (label, mode) => ({ owner: { include: new Set(mode === "include" ? [label] : []), exclude: new Set(mode === "exclude" ? [label] : []) } });
  assert.deepEqual(ids(getVisibleMarks(stateWith(owned, only("Mine", "include")))), ["c", "e", "s"]);
  assert.deepEqual(ids(getVisibleMarks(stateWith(owned, only("Public", "include")))), ["m", "p"]);
  assert.deepEqual(ids(getVisibleMarks(stateWith(owned, only("Public", "exclude")))), ["c", "e", "s"]);
  const both = { owner: { include: new Set(["Mine", "Public"]), exclude: new Set() } };
  assert.equal(getVisibleMarks(stateWith(owned, both)).length, 5); // requiring both = everything
});