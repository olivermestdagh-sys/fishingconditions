// Tests for the pure helpers of js/trip-map.js (trips drawn on the Map).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSharedScripts } from "./helpers.mjs";

const src = readSharedScripts();
const fn = (name) => {
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\r?\\n}\\r?\\n`));
  assert.ok(m, `${name} not found in js/*.js`);
  return m[0];
};
const h = new Function(
  [
    fn("distanceMetersBetween"),
    'const TRIP_MAP_MAX_LOCATION_M = 5000; const TRIP_MAP_OTHER = "Other"; const TRIP_MAP_COLOURS = ["a", "b", "c"];',
    'const TRIP_MAP_PIN_TYPES = { trip_start: "S", trip_end: "E", action_start: "A", change: "C", catch: "F" }; const TRIP_LOG_CHANGE_LABELS = { rod_setups: "rod setups", water: "water", depth: "depth", action: "action", "water+depth": "water + depth" };',
    ...["tripMapNearestLocationName", "tripMapGroupRuns", "tripMapSimplify", "tripMapPath", "tripMapPins", "tripMapChangeLines", "tripMapShapeSvg", "tripLogGearLine", "tripLogWaterText", "tripMapGroupByDistance", "tripMapRingOffsets", "tripMapColour"].map(fn),
    "return { tripMapNearestLocationName, tripMapGroupRuns, tripMapSimplify, tripMapPath, tripMapPins, tripMapChangeLines, tripMapShapeSvg, tripMapGroupByDistance, tripMapRingOffsets, tripMapColour };",
  ].join("\n")
)();

const locs = [
  { name: "Lang Lang", lat: -38.35, lng: 145.56 },
  { name: "Altona", lat: -37.87, lng: 144.83 },
];

test("nearest location within the cutoff, else null", () => {
  assert.equal(h.tripMapNearestLocationName(-38.351, 145.561, locs, 5000), "Lang Lang");
  assert.equal(h.tripMapNearestLocationName(-37.0, 145.0, locs, 5000), null);
  assert.equal(h.tripMapNearestLocationName(null, 145, locs, 5000), null);
});

test("runs are grouped by location, A-Z, with Other last", () => {
  const runs = [
    { runId: "1", startLat: -38.35, startLng: 145.56 },
    { runId: "2", startLat: -37.87, startLng: 144.83 },
    { runId: "3", startLat: null, startLng: null },
    { runId: "4", startLat: -38.351, startLng: 145.559 },
  ];
  const g = h.tripMapGroupRuns(runs, locs);
  assert.deepEqual(g.map((x) => x.name), ["Altona", "Lang Lang", "Other"]);
  assert.deepEqual(g[1].runs.map((r) => r.runId), ["1", "4"]);
});

test("simplify drops collinear points but keeps the ends and real corners", () => {
  const line = [[-38, 145], [-38, 145.0005], [-38, 145.001], [-38.001, 145.001]];
  assert.deepEqual(h.tripMapSimplify(line, 4), [[-38, 145], [-38, 145.001], [-38.001, 145.001]]);
  assert.deepEqual(h.tripMapSimplify([[1, 2]], 4), [[1, 2]]);
});

test("path prefers the GPS track, falling back to log positions", () => {
  const entries = [{ lat: -38, lng: 145 }, { lat: null, lng: null }, { lat: -38.1, lng: 145.1 }];
  assert.equal(h.tripMapPath([{ lat: 1, lng: 2 }, { lat: 1.1, lng: 2.1 }], entries).source, "track");
  const fb = h.tripMapPath([{ lat: 1, lng: 2 }], entries);
  assert.equal(fb.source, "log");
  assert.equal(fb.points.length, 2);
});

test("pins: start/end/action/change/catch with a position; unplaced lines are skipped", () => {
  const entries = [
    { type: "trip_start", lat: 1, lng: 2, ts: 1 },
    { type: "catch", lat: 1, lng: 2, ts: 2 },
    { type: "action_start", lat: null, lng: null, ts: 3 },
    { type: "change", lat: 1, lng: 2, ts: 4, changeField: "water" },
    { type: "trip_end", lat: 1, lng: 2, ts: 5 },
  ];
  assert.deepEqual(h.tripMapPins(entries).map((p) => p.kind), ["S", "F", "C", "E"]);
});

test("coincident pixels share a group, distant ones don't", () => {
  const items = [{ x: 0, y: 0 }, { x: 3, y: 2 }, { x: 100, y: 100 }, { x: 101, y: 100 }];
  assert.deepEqual(h.tripMapGroupByDistance(items, 10), [[0, 1], [2, 3]]);
});

test("ring offsets: one pin stays put, several are spread and clear of each other", () => {
  assert.deepEqual(h.tripMapRingOffsets(1, 20), [[0, 0]]);
  const o = h.tripMapRingOffsets(6, 20);
  assert.equal(o.length, 6);
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) assert.ok(Math.hypot(o[i][0] - o[j][0], o[i][1] - o[j][1]) >= 20);
});

test("a run keeps its colour", () => {
  assert.equal(h.tripMapColour("run-1"), h.tripMapColour("run-1"));
});

test("a change keeps the line it changed from", () => {
  const a = { type: "action_start", lat: 1, lng: 2, ts: 1 };
  const c = { type: "change", lat: 1, lng: 2, ts: 2 };
  const pins = h.tripMapPins([a, c]);
  assert.equal(pins[0].prev, null);
  assert.equal(pins[1].prev, a);
});

test("change text says what changed", () => {
  const prev = { actionName: "Bream", waterCondition: "Clear", waterDepth: 2, rods: [{ name: "Rod 1", bait: ["Squid"] }] };
  const now = { type: "change", changeField: "water+depth", actionName: "Bream", waterCondition: "Murky", waterDepth: 3, rods: [{ name: "Rod 1", bait: ["Squid"] }] };
  assert.deepEqual(h.tripMapChangeLines(now, prev), ["Water: Clear → Murky", "Depth: 2 → 3 m"]);
  const gear = { ...prev, changeField: "rod_setups", rods: [{ name: "Rod 1", bait: ["Prawn"] }] };
  assert.deepEqual(h.tripMapChangeLines(gear, prev), ["Rod setups: added Rod 1 — Prawn · removed Rod 1 — Squid"]);
  assert.deepEqual(h.tripMapChangeLines({ ...prev, changeField: "action", actionName: "Flathead" }, prev), ["Action: Bream → Flathead"]);
  assert.deepEqual(h.tripMapChangeLines({ changeField: "water", waterCondition: "Murky", rods: [] }, null), ["water changed to Murky"]);
});

test("shape svg: known shapes and a circle fallback", () => {
  assert.match(h.tripMapShapeSvg("diamond", "#f00"), /<polygon/);
  assert.match(h.tripMapShapeSvg("cross", "#f00"), /<path/);
  assert.match(h.tripMapShapeSvg("nope", "#f00"), /<circle/);
});
