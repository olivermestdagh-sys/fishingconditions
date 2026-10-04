// Tests for applyTroughWideningToRows (js/chart-render.js): per-location HLW/LLW offsets that widen the
// too-low / launchable window around a low tide. Browser scripts, so the functions are pulled from the source text.
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
    grab(/function naiveDateOnlyStr[\s\S]*?\r?\n}\r?\n/),
    grab(/function rankExtremum[\s\S]*?\r?\n}\r?\n/),
    grab(/function findTideThresholdCrossings[\s\S]*?\r?\n}\r?\n/),
    grab(/function interpolatedTideHeightAt[\s\S]*?\r?\n}\r?\n/),
    grab(/function findTideExtrema[\s\S]*?\r?\n}\r?\n/),
    grab(/function applyTroughWideningToRows[\s\S]*?\r?\n}\r?\n/),
    "return { applyTroughWideningToRows, findTideExtrema, findTideThresholdCrossings };",
  ].join("\n")
)();

const H = 3600000;
const T0 = Date.UTC(2026, 9, 1, 0, 0);
// (edges padded so every real extremum has neighbours) H 00:00 (2.0), HLW 06:00 (0.5), H 12:00 (1.8), LLW 18:00 (0.2), H 24:00 (2.0); half-cosine between, hourly rows.
const ext = [[-6, 0.3], [0, 2.0], [6, 0.5], [12, 1.8], [18, 0.2], [24, 2.0], [30, 0.4]]; // edge lows are not detectable extrema
const rows = [];
for (let h = -6; h <= 30; h++) {
  let i = 0;
  while (ext[i + 1][0] < h) i++;
  const [h0, v0] = ext[i];
  const [h1, v1] = ext[i + 1];
  const eased = (1 - Math.cos(((h - h0) / (h1 - h0)) * Math.PI)) / 2;
  rows.push({ _t: T0 + h * H, "Tide Height (m)": v0 + (v1 - v0) * eased });
}
const THRESH = 1.0;
const crossings = (r) => fns.findTideThresholdCrossings(r, THRESH);
const firstLow = (r) => fns.findTideExtrema(r).filter((e) => e.type === "low")[0];

test("zero / missing offsets and missing threshold leave rows untouched", () => {
  assert.equal(fns.applyTroughWideningToRows(rows, { hlw: 0, llw: 0 }, THRESH), rows);
  assert.equal(fns.applyTroughWideningToRows(rows, null, THRESH), rows);
  assert.equal(fns.applyTroughWideningToRows(rows, { hlw: 40 }, null), rows);
});

test("HLW offset widens the window around the higher low and moves the low later", () => {
  const before = crossings(rows).filter((c) => c.t > T0 && c.t < T0 + 12 * H);
  const lowBefore = firstLow(rows);
  const out = fns.applyTroughWideningToRows(rows, { hlw: 40 }, THRESH);
  const after = crossings(out).filter((c) => c.t > T0 && c.t < T0 + 12 * H);
  assert.equal(before.length, 2);
  assert.equal(after.length, 2);
  const O = 40 * 60000;
  const tol = 15 * 60000; // hourly sampling + linear crossing interpolation
  assert.ok(Math.abs(before[0].t - after[0].t - O) < tol, "too-low crossing ~40 min earlier");
  assert.ok(Math.abs(after[1].t - before[1].t - O) < tol, "high-enough crossing ~40 min later");
  assert.ok(Math.abs(firstLow(out).t - lowBefore.t - O) < tol, "the low itself ~40 min later");
});

test("rows outside the bracket, and the other low, are untouched with hlw only", () => {
  const out = fns.applyTroughWideningToRows(rows, { hlw: 40 }, THRESH);
  rows.forEach((r, i) => {
    if (r._t <= T0 || r._t >= T0 + 12 * H) assert.equal(out[i]["Tide Height (m)"], r["Tide Height (m)"]);
  });
  // second low (LLW 18:00, not HLW): its side of the day is unchanged
  rows.forEach((r, i) => {
    if (r._t >= T0 + 12 * H) assert.equal(out[i]["Tide Height (m)"], r["Tide Height (m)"]);
  });
});

test("LLW offset applies to the lower low only", () => {
  const out = fns.applyTroughWideningToRows(rows, { llw: 30 }, THRESH);
  rows.forEach((r, i) => {
    // (the bracket edge is the parabolic high estimate, a hair off the hourly grid, so stay one sample clear of it)
    if (r._t <= T0 + 11 * H) assert.equal(out[i]["Tide Height (m)"], r["Tide Height (m)"]);
  });
  assert.ok(out.some((r, i) => r["Tide Height (m)"] !== rows[i]["Tide Height (m)"]));
});

test("a low that never dips below the threshold is left alone", () => {
  assert.equal(fns.applyTroughWideningToRows(rows, { hlw: 40, llw: 40 }, 0.05), rows);
});

test("the input rows are never mutated", () => {
  const snap = JSON.stringify(rows);
  fns.applyTroughWideningToRows(rows, { hlw: 40, llw: 40 }, THRESH);
  assert.equal(JSON.stringify(rows), snap);
});
