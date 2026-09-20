// Tide clock: sessions laid onto the tide cycle (hours since low tide).
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
    fn("tideClockHoursSinceLow"),
    fn("tideClockBinFor"),
    fn("tideClockSessionEffort"),
    fn("tideClockAggregate"),
    "return { tideClockHoursSinceLow, tideClockBinFor, tideClockSessionEffort, tideClockAggregate };",
  ].join("\n")
)();

const H = 3600000;
const D0 = Date.UTC(2026, 8, 20, 0, 0, 0); // naive wall-clock ms, like parseNaive
// low 02:00, high 08:12, low 14:24, high 20:36, low 02:48 next day
const extrema = [
  { t: D0 + 2 * H, type: "low" },
  { t: D0 + 8.2 * H, type: "high" },
  { t: D0 + 14.4 * H, type: "low" },
  { t: D0 + 20.6 * H, type: "high" },
  { t: D0 + 26.8 * H, type: "low" },
];

test("hours since low is measured from the latest low at or before the time", () => {
  assert.equal(fns.tideClockHoursSinceLow(extrema, D0 + 3 * H), 1);
  assert.ok(Math.abs(fns.tideClockHoursSinceLow(extrema, D0 + 16.4 * H) - 2) < 1e-9);
});

test("times outside the stored events give null", () => {
  assert.equal(fns.tideClockHoursSinceLow(extrema, D0 + 1 * H), null); // before the first low
  assert.equal(fns.tideClockHoursSinceLow(extrema, D0 + 30 * H), null); // after the last event
  assert.equal(fns.tideClockHoursSinceLow(null, D0), null);
});

test("a hole in the events (last low too old) gives null", () => {
  const sparse = [
    { t: D0, type: "low" },
    { t: D0 + 40 * H, type: "high" },
  ];
  assert.equal(fns.tideClockHoursSinceLow(sparse, D0 + 30 * H), null);
});

test("columns are half hours, and a very long tide folds into the last one", () => {
  assert.equal(fns.tideClockBinFor(0), 0);
  assert.equal(fns.tideClockBinFor(0.49), 0);
  assert.equal(fns.tideClockBinFor(0.5), 1);
  assert.equal(fns.tideClockBinFor(12.4), 24);
  assert.equal(fns.tideClockBinFor(13.5), 24);
});

test("session effort adds up to the session length, across a low tide", () => {
  const effort = fns.tideClockSessionEffort(D0 + 13 * H, D0 + 16 * H, extrema); // 13:00-16:00 crosses the 14:24 low
  const total = effort.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 3) < 1e-9);
  // 13:00-14:24 is 11-12.4h since the 02:00 low (columns 22-24), 14:24-16:00 is 0-1.6h (columns 0-3)
  assert.ok(effort.slice(0, 4).every((h) => h > 0));
  assert.ok(effort.slice(4, 22).every((h) => h === 0));
  assert.ok(effort[22] > 0);
});

test("a session that runs outside the stored events is null", () => {
  assert.equal(fns.tideClockSessionEffort(D0 + 1 * H, D0 + 4 * H, extrema), null);
});

test("aggregate counts catches into their column, works out the rate, and skips sessions without tides", () => {
  const good = {
    groupId: "g1",
    start: D0 + 3 * H, // 1h after low
    end: D0 + 6 * H, // 4h after low
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
  assert.equal(agg.bins[2].catches, 2); // 1.25-1.3h since low is column 2
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
