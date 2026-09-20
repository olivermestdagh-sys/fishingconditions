// Tide clock: sessions laid onto the full two-high/two-low tide cycle (hours since the lower low water).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSharedScripts } from "./helpers.mjs";

const src = readSharedScripts();
const grab = (re) => {
  const m = src.match(re);
  if (!m) throw new Error("could not find in js/*.js: " + re);
  return m[0];
};
const fn = (name) => grab(new RegExp(`function ${name}\\b[\\s\\S]*?\\r?\\n}\\r?\\n`));
const fns = new Function(
  [
    grab(/const TIDE_CLOCK_BIN_H[^\n]*\r?\n/),
    grab(/const TIDE_CLOCK_BINS[^\n]*\r?\n/),
    grab(/const TIDE_CLOCK_SLICE_MS[^\n]*\r?\n/),
    grab(/const TIDE_CLOCK_MAX_GAP_H[^\n]*\r?\n/),
    grab(/const TIDE_CLOCK_MIN_EFFORT_H[^\n]*\r?\n/),
    fn("naiveDateOnlyStr"),
    fn("rankExtremum"),
    fn("tideClockHoursSinceLLW"),
    fn("tideClockBinFor"),
    fn("tideClockSessionEffort"),
    fn("tideClockCycles"),
    fn("tideClockAverageCycle"),
    fn("tideClockSegments"),
    fn("tideClockCurve"),
    fn("tideClockAggregate"),
    "return { tideClockHoursSinceLLW, tideClockBinFor, tideClockSessionEffort, tideClockCycles, tideClockAverageCycle, tideClockSegments, tideClockCurve, tideClockAggregate };",
  ].join("\n")
)();

const H = 3600000;
const D0 = Date.UTC(2026, 8, 20, 0, 0, 0); // naive wall-clock ms, like parseNaive
const ev = (hours, type, height) => ({ t: D0 + hours * H, type, height });
// Each cycle runs LLW, LHW, HLW, HHW (the higher of a day's two lows/highs is the H one).
const extrema = [
  ev(2, "low", 0.2), // LLW (day 20)
  ev(8, "high", 1.0), // LHW
  ev(13.5, "low", 0.6), // HLW
  ev(19.5, "high", 1.4), // HHW
  ev(26.8, "low", 0.2), // LLW (day 21)
  ev(32.8, "high", 1.0),
  ev(38.3, "low", 0.6),
  ev(44.3, "high", 1.4),
  ev(51.7, "low", 0.2), // LLW (day 22)
];

test("hours since LLW counts from the lower low, not the nearer higher low", () => {
  assert.equal(fns.tideClockHoursSinceLLW(extrema, D0 + 3 * H), 1);
  assert.ok(Math.abs(fns.tideClockHoursSinceLLW(extrema, D0 + 16 * H) - 14) < 1e-9); // after the 13.5h HLW, still counting from the LLW at 2h
  assert.ok(Math.abs(fns.tideClockHoursSinceLLW(extrema, D0 + 27.8 * H) - 1) < 1e-9); // restarts at the next LLW
});

test("times outside the stored events give null", () => {
  assert.equal(fns.tideClockHoursSinceLLW(extrema, D0 + 1 * H), null); // before the first LLW
  assert.equal(fns.tideClockHoursSinceLLW(extrema, D0 + 60 * H), null); // after the last event
  assert.equal(fns.tideClockHoursSinceLLW(null, D0), null);
});

test("a hole in the events (last LLW too old) gives null", () => {
  const sparse = [ev(0, "low", 0.2), ev(1, "low", 0.9), ev(40, "high", 1.0)];
  assert.equal(fns.tideClockHoursSinceLLW(sparse, D0 + 30 * H), null);
});

test("columns are half hours over a full cycle, and a very long cycle folds into the last one", () => {
  assert.equal(fns.tideClockBinFor(0), 0);
  assert.equal(fns.tideClockBinFor(0.5), 1);
  assert.equal(fns.tideClockBinFor(12.4), 24);
  assert.equal(fns.tideClockBinFor(24.8), 49);
  assert.equal(fns.tideClockBinFor(30), 49);
});

test("session effort adds up to the session length, across an LLW", () => {
  const effort = fns.tideClockSessionEffort(D0 + 25 * H, D0 + 29 * H, extrema); // crosses the LLW at 26.8h
  assert.equal(effort.length, 50);
  assert.ok(Math.abs(effort.reduce((a, b) => a + b, 0) - 4) < 1e-9);
  // 25:00-26:48 is 23-24.8h since the 2h LLW (columns 46-49); 26:48-29:00 is 0-2.2h (columns 0-4)
  assert.ok(effort.slice(46).every((h) => h > 0));
  assert.ok(effort.slice(0, 5).every((h) => h > 0));
  assert.ok(effort.slice(5, 46).every((h) => h === 0));
});

test("a session that runs outside the stored events is null", () => {
  assert.equal(fns.tideClockSessionEffort(D0 + 1 * H, D0 + 4 * H, extrema), null);
});

test("complete LLW-to-LLW cycles are found; a cycle with a missing event is dropped", () => {
  const cycles = fns.tideClockCycles(extrema);
  assert.equal(cycles.length, 2);
  assert.deepEqual(cycles[0].points.map((p) => p.type), ["low", "high", "low", "high", "low"]);
  assert.deepEqual(cycles[0].points.map((p) => Math.round(p.h * 10) / 10), [0, 6, 11.5, 17.5, 24.8]);
  const missingHigh = extrema.filter((e) => e !== extrema[3]); // no HHW in the first cycle
  assert.equal(fns.tideClockCycles(missingHigh).length, 1);
});

test("the average cycle and its segment marks: LHW comes before HHW", () => {
  const avg = fns.tideClockAverageCycle(fns.tideClockCycles(extrema));
  assert.equal(avg.n, 2);
  assert.equal(avg.lowerHighFirst, 2);
  assert.ok(Math.abs(avg.points[1].height - 1.0) < 1e-9);
  assert.deepEqual(fns.tideClockSegments(avg).map((s) => s.label), ["LLW", "LHW", "HLW", "HHW", "LLW"]);
  assert.equal(fns.tideClockAverageCycle([]), null);
});

test("if the higher high comes first, the marks follow the data", () => {
  const swapped = [ev(2, "low", 0.2), ev(8, "high", 1.4), ev(13.5, "low", 0.6), ev(19.5, "high", 1.0), ev(26.8, "low", 0.2)];
  const avg = fns.tideClockAverageCycle(fns.tideClockCycles(swapped));
  assert.equal(avg.lowerHighFirst, 0);
  assert.deepEqual(fns.tideClockSegments(avg).map((s) => s.label), ["LLW", "HHW", "HLW", "LHW", "LLW"]);
});

test("the simulated tide curve runs through the average high and low heights", () => {
  const avg = fns.tideClockAverageCycle(fns.tideClockCycles(extrema));
  const curve = fns.tideClockCurve(avg);
  assert.equal(curve.length, 50);
  assert.ok(Math.abs(curve[12] - 1.0) < 0.05); // column centred on 6.25h, the first high
  assert.ok(Math.abs(curve[35] - 1.4) < 0.05); // 17.75h, the second high
  assert.ok(curve.every((v) => v >= 0.2 - 1e-9 && v <= 1.4 + 1e-9));
});

test("aggregate counts catches into their column, works out the rate, and skips sessions without tides", () => {
  const good = {
    groupId: "g1",
    start: D0 + 3 * H, // 1h after LLW
    end: D0 + 6 * H, // 4h after LLW
    catches: [
      { id: "a", species: "Whiting", _t: D0 + 3.25 * H },
      { id: "b", species: "Whiting", _t: D0 + 3.3 * H },
      { id: "c", species: "Snapper", _t: D0 + 5.1 * H },
      { id: "d", species: "Bream", _t: D0 + 5.2 * H }, // filtered out below
    ],
  };
  const noTides = { groupId: "g2", start: D0 + 3 * H, end: D0 + 6 * H, catches: [{ id: "e", species: "Whiting", _t: D0 + 4 * H }] };
  const agg = fns.tideClockAggregate(
    [good, noTides],
    (s) => (s.groupId === "g1" ? extrema : null),
    (c) => c.id !== "d"
  );
  assert.equal(agg.used, 1);
  assert.equal(agg.skipped, 1);
  assert.equal(agg.catches, 3);
  assert.equal(agg.cycles.length, 2);
  assert.equal(agg.bins[2].catches, 2); // 1.25-1.3h since LLW is column 2
  assert.deepEqual(agg.bins[2].bySpecies, { Whiting: 2 });
  assert.equal(agg.bins[6].bySpecies.Snapper, 1); // 3.1h -> column 6
  assert.ok(Math.abs(agg.bins.reduce((a, b) => a + b.effortH, 0) - 3) < 1e-9);
});

test("a column with under an hour of effort shows no rate", () => {
  const s = { groupId: "g", start: D0 + 3 * H, end: D0 + 5 * H, catches: [{ id: "a", species: "Whiting", _t: D0 + 3.1 * H }] };
  const agg = fns.tideClockAggregate([s], () => extrema, () => true);
  assert.equal(agg.bins[2].rate, null); // only half an hour of effort per column
  const long = { groupId: "h", start: D0 + 3 * H, end: D0 + 5 * H, catches: [] };
  const agg2 = fns.tideClockAggregate([s, long, long, long], () => extrema, () => true);
  assert.ok(agg2.bins[2].rate > 0); // four sessions -> 2h in that column
});
