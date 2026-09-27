// Week Ahead's facet filters (Type/Location Group/Shore Direction/Locations), js/week-tools.js:
// locationMatchesFacetFilters (the Map-style include/exclude matching) and migrateLegacyFacetFilters
// (lifting the old plain-array selections into the new shape without changing anyone's visible rows).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSharedScripts } from "./helpers.mjs";

const src = readSharedScripts();
const fn = (name) => {
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\r?\\n}\\r?\\n`));
  assert.ok(m, `${name} not found in js/*.js`);
  return m[0];
};
const constDecl = (name) => {
  const m = src.match(new RegExp(`const ${name} = [^\\n]*\\r?\\n`));
  assert.ok(m, `${name} not found in js/*.js`);
  return m[0];
};

const deps = [
  constDecl("UNGROUPED_LABEL"),
  constDecl("CARDINAL_DIRECTIONS"),
  constDecl("LOC_FILTER_STORAGE_KEY"),
  constDecl("TYPE_FILTER_STORAGE_KEY"),
  constDecl("GROUP_FILTER_STORAGE_KEY"),
  constDecl("DIRECTION_FILTER_STORAGE_KEY"),
  fn("locationGroupsOf"),
  fn("shoreStartsWithDirection"),
  fn("passesFacet"),
  fn("locationMatchesFacetFilters"),
  fn("emptyFacetFilters"),
  fn("migrateLegacyFacetFilters"),
].join("\n");

const { locationMatchesFacetFilters, emptyFacetFilters, migrateLegacyFacetFilters } = new Function(
  "localStorage",
  [deps, "return { locationMatchesFacetFilters, emptyFacetFilters, migrateLegacyFacetFilters };"].join("\n")
)(makeLocalStorage());

/** A tiny in-memory localStorage — migrateLegacyFacetFilters reads it as a free global, same as it would in a browser. */
function makeLocalStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: (k) => {
      delete store[k];
    },
  };
}

function facet(include = [], exclude = []) {
  return { include: new Set(include), exclude: new Set(exclude) };
}

const kayakRamp = { name: "Corinella Boat Ramp", type: "Kayak", shore: "N", locationGroups: ["Western Port"] };
const landJetty = { name: "Rye Pier", type: "Land based", shore: "SW", locationGroups: ["Port Phillip", "Western Port"] };
const noGroup = { name: "Somewhere", type: "Kayak", shore: "NE", locationGroups: [] };

test("no filters at all: everything matches", () => {
  const f = emptyFacetFilters();
  assert.equal(locationMatchesFacetFilters(kayakRamp, f), true);
  assert.equal(locationMatchesFacetFilters(landJetty, f), true);
});

test("include on a single-value field (type) requires a match", () => {
  const f = emptyFacetFilters();
  f.type = facet(["Kayak"]);
  assert.equal(locationMatchesFacetFilters(kayakRamp, f), true);
  assert.equal(locationMatchesFacetFilters(landJetty, f), false);
});

test("exclude on a single-value field requires no match", () => {
  const f = emptyFacetFilters();
  f.type = facet([], ["Kayak"]);
  assert.equal(locationMatchesFacetFilters(kayakRamp, f), false);
  assert.equal(locationMatchesFacetFilters(landJetty, f), true);
});

test("a location with several groups matches an include via OR", () => {
  const f = emptyFacetFilters();
  f.group = facet(["Port Phillip"]);
  assert.equal(locationMatchesFacetFilters(landJetty, f), true); // has both groups
  assert.equal(locationMatchesFacetFilters(kayakRamp, f), false); // only Western Port
});

test("a location assigned no group falls back to Ungrouped for matching", () => {
  const f = emptyFacetFilters();
  f.group = facet(["Ungrouped"]);
  assert.equal(locationMatchesFacetFilters(noGroup, f), true);
  assert.equal(locationMatchesFacetFilters(kayakRamp, f), false);
});

test("direction matches any cardinal tile the shore satisfies (OR)", () => {
  const f = emptyFacetFilters();
  f.direction = facet(["N"]);
  assert.equal(locationMatchesFacetFilters(kayakRamp, f), true); // shore "N" starts with "N"
  assert.equal(locationMatchesFacetFilters(landJetty, f), false); // shore "SW" doesn't start with "N"
  assert.equal(locationMatchesFacetFilters(noGroup, f), true); // shore "NE" also starts with "N"
});

test("two facets AND together", () => {
  const f = emptyFacetFilters();
  f.type = facet(["Kayak"]);
  f.group = facet(["Western Port"]);
  assert.equal(locationMatchesFacetFilters(kayakRamp, f), true);
  f.group = facet(["Port Phillip"]);
  assert.equal(locationMatchesFacetFilters(kayakRamp, f), false); // right type, wrong group
});

test("migrateLegacyFacetFilters: an absent key migrates to neutral (matches everything)", () => {
  const ls = makeLocalStorage();
  const migrate = new Function(
    "localStorage",
    [deps, "return migrateLegacyFacetFilters;"].join("\n")
  )(ls);
  const result = migrate(["A", "B"]);
  assert.deepEqual([...result.type.include], []);
  assert.deepEqual([...result.type.exclude], []);
  assert.deepEqual([...result.location.include], []);
  assert.deepEqual([...result.location.exclude], []);
});

test("migrateLegacyFacetFilters: a closed list (Type/Locations) preserves the same visible set via exclude", () => {
  const ls = makeLocalStorage({
    goodConditionsSelectedTypes: JSON.stringify(["Kayak"]),
    goodConditionsSelectedLocations: JSON.stringify(["A"]),
  });
  const migrate = new Function(
    "localStorage",
    [deps, "return migrateLegacyFacetFilters;"].join("\n")
  )(ls);
  const result = migrate(["A", "B", "C"]);
  // "Kayak" was checked, "Land based" wasn't -> Land based excluded, Kayak neither included nor excluded
  // (a facet with nothing in include still needs the exclude to reproduce "everything but Land based" exactly:
  // only Land based fails passesFacet's exclude test, Kayak/anything else passes).
  assert.deepEqual([...result.type.exclude].sort(), ["Land based"]);
  assert.deepEqual([...result.location.exclude].sort(), ["B", "C"]);
});

test("migrateLegacyFacetFilters: an open facet (Group/Direction) lifts straight into include", () => {
  const ls = makeLocalStorage({ goodConditionsSelectedGroups: JSON.stringify(["Port Phillip"]) });
  const migrate = new Function(
    "localStorage",
    [deps, "return migrateLegacyFacetFilters;"].join("\n")
  )(ls);
  const result = migrate([]);
  assert.deepEqual([...result.group.include], ["Port Phillip"]);
  assert.deepEqual([...result.group.exclude], []);
});

test("migrateLegacyFacetFilters: a value already in the new shape passes through unchanged", () => {
  const ls = makeLocalStorage({ goodConditionsSelectedGroups: JSON.stringify({ include: ["X"], exclude: ["Y"] }) });
  const migrate = new Function(
    "localStorage",
    [deps, "return migrateLegacyFacetFilters;"].join("\n")
  )(ls);
  const result = migrate([]);
  assert.deepEqual([...result.group.include], ["X"]);
  assert.deepEqual([...result.group.exclude], ["Y"]);
});
