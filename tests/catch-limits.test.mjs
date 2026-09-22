// Catch rules built on species limits (js/catch-limits.js): the run of catches within 8 hours of each other,
// kept/big counts (with shared Max Qty groups), size verdicts, the keep/release recommendation, blurbs and edit warnings.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../js/catch-limits.js", import.meta.url), "utf8");
const f = new Function(
  src + "\nreturn { limitsFromMarkLists, catchesFromMarks, catchChain, runCatches, speciesGroupNames, keptCounts, sizeVerdict, recommendFate, stepperStartSize, lastCatchSize, speciesLimitLines, speciesCounts, catchLimitWarnings, CATCH_RUN_GAP_MS };"
)();

const H = 3600000;
const T0 = Date.UTC(2026, 8, 22, 6, 0, 0);
const at = (hours) => T0 + hours * H;
const lists = [
  { field: "Species", value: "Snapper", minSize: 28, maxQty: 10, bigSize: 40, bigMaxQty: 3 },
  { field: "Species", value: "Shark (School)", minSize: 45, maxQty: 2, qtyGroup: "G" },
  { field: "Species", value: "Shark (Gummy)", minSize: 45, maxQty: 2, qtyGroup: "G" },
  { field: "Species", value: "Flathead", minSize: 27, maxSize: 60, maxQty: 20 },
  { field: "Species", value: "Elephant Fish" },
  { field: "Species", value: "Protected", maxQty: 0 },
  { field: "Bait", value: "Squid" },
];
const limits = f.limitsFromMarkLists(lists);
let n = 0;
const c = (species, hours, extra = {}) => ({ id: `c${++n}`, species, size: null, released: false, tMs: at(hours), ...extra });

test("limits come from Species rows only, unset values as null", () => {
  assert.deepEqual(Object.keys(limits), ["Snapper", "Shark (School)", "Shark (Gummy)", "Flathead", "Elephant Fish", "Protected"]);
  assert.deepEqual(limits["Elephant Fish"], { minSize: null, maxSize: null, maxQty: null, bigSize: null, bigMaxQty: null, qtyGroup: null });
  assert.equal(limits.Snapper.bigMaxQty, 3);
});

test("catches are made from Catch marks only, with usable times", () => {
  const marks = [
    { id: "1", type: "Catch", species: "Snapper", size: "31", dateTime: "x", released: 1 },
    { id: "2", type: "Mark", species: "Snapper", dateTime: "x" },
    { id: "3", type: "Catch", species: "Bream", dateTime: "bad" },
  ];
  const out = f.catchesFromMarks(marks, (d) => (d === "x" ? 5 : NaN));
  assert.deepEqual(out, [{ id: "1", species: "Snapper", size: 31, released: true, tMs: 5 }]);
});

test("a run chains catches that are 8 hours or less apart", () => {
  const times = [at(0), at(7.99), at(15.98), at(24.1)];
  assert.deepEqual(f.catchChain(times, at(15.98)), { start: at(0), end: at(15.98) }, "anchored on a catch: the chain up to it");
  assert.deepEqual(f.catchChain(times, at(24.1)), { start: at(24.1), end: at(24.1) }, "8.12 h after the previous one: a new run");
  assert.deepEqual(f.catchChain(times.slice(0, 3), at(17)), { start: at(0), end: at(15.98) }, "now, 1 h after the last catch");
  assert.equal(f.CATCH_RUN_GAP_MS, 8 * H);
});

test("exactly 8 hours still chains; a minute more breaks the run", () => {
  assert.deepEqual(f.catchChain([at(0), at(8)], at(8)), { start: at(0), end: at(8) });
  assert.deepEqual(f.catchChain([at(0), at(8) + 60000], at(8) + 60000), { start: at(8) + 60000, end: at(8) + 60000 });
});

test("now counts as part of the run only while the last catch is within 8 hours", () => {
  const times = [at(0), at(2)];
  assert.deepEqual(f.catchChain(times, at(9.9)), { start: at(0), end: at(2) });
  assert.equal(f.catchChain(times, at(10.1)), null, "more than 8 hours since the last catch: no current run");
  assert.equal(f.catchChain([], at(1)), null);
});

test("runCatches keeps the run's catches and drops earlier trips", () => {
  const all = [c("Snapper", -30), c("Snapper", 0), c("Flathead", 3), c("Snapper", 9)];
  assert.deepEqual(f.runCatches(all, at(10)).map((x) => x.tMs), [at(0), at(3), at(9)]);
  assert.deepEqual(f.runCatches(all, at(40)), []);
});

test("kept counts leave out released fish and add up the shared-limit group", () => {
  const run = [c("Shark (School)", 0), c("Shark (Gummy)", 1), c("Shark (Gummy)", 2, { released: true }), c("Snapper", 3)];
  const k = f.keptCounts(run, limits, "Shark (School)");
  assert.equal(k.kept, 2);
  assert.deepEqual(k.names, ["Shark (School)", "Shark (Gummy)"]);
  assert.equal(f.keptCounts(run, limits, "Snapper").kept, 1);
});

test("big count is this species' kept fish at or above Big Size", () => {
  const run = [c("Snapper", 0, { size: 40 }), c("Snapper", 1, { size: 39.9 }), c("Snapper", 2, { size: 55, released: true }), c("Snapper", 3, { size: 60 })];
  const k = f.keptCounts(run, limits, "Snapper");
  assert.equal(k.kept, 3);
  assert.equal(k.big, 2);
  assert.equal(f.keptCounts(run, limits, "Flathead").big, 0, "no Big Size set");
});

test("size verdicts at the exact limits", () => {
  const lim = limits.Flathead;
  assert.deepEqual(f.sizeVerdict(lim, 26.9), { tooSmall: true, overSlot: false, big: false });
  assert.deepEqual(f.sizeVerdict(lim, 27), { tooSmall: false, overSlot: false, big: false });
  assert.deepEqual(f.sizeVerdict(lim, 60), { tooSmall: false, overSlot: false, big: false });
  assert.equal(f.sizeVerdict(lim, 60.1).overSlot, true);
  assert.equal(f.sizeVerdict(limits.Snapper, 40).big, true);
  assert.deepEqual(f.sizeVerdict(undefined, 30), { tooSmall: false, overSlot: false, big: false });
  assert.deepEqual(f.sizeVerdict(lim, null), { tooSmall: false, overSlot: false, big: false });
});

test("recommendation: release when too small, over slot, bag full, or big-fish limit used; otherwise keep", () => {
  const none = { kept: 0, big: 0, names: ["Snapper"] };
  assert.equal(f.recommendFate({ lim: limits.Snapper, size: null, counts: none, tooSmall: true }).fate, "Release");
  assert.match(f.recommendFate({ lim: limits.Snapper, size: 20, counts: none }).reason, /Under the minimum size \(28 cm\)/);
  assert.match(f.recommendFate({ lim: limits.Flathead, size: 70, counts: none }).reason, /Over the maximum size \(60 cm\)/);
  const full = f.recommendFate({ lim: limits.Snapper, size: 35, counts: { kept: 10, big: 0, names: ["Snapper"] } });
  assert.equal(full.fate, "Release");
  assert.match(full.reason, /Bag full: 10 of 10 kept/);
  const bigFull = f.recommendFate({ lim: limits.Snapper, size: 45, counts: { kept: 5, big: 3, names: ["Snapper"] } });
  assert.equal(bigFull.fate, "Release");
  assert.match(bigFull.reason, /Big fish limit reached: 3 of 3/);
  const smallOk = f.recommendFate({ lim: limits.Snapper, size: 35, counts: { kept: 3, big: 3, names: ["Snapper"] } });
  assert.equal(smallOk.fate, "Keep", "a fish under Big Size isn't held back by the big-fish limit");
  assert.match(smallOk.reason, /makes 4 of 10$/, "no big-fish note for a fish under Big Size");
  const bigOk = f.recommendFate({ lim: limits.Snapper, size: 45, counts: { kept: 3, big: 1, names: ["Snapper"] } });
  assert.equal(bigOk.fate, "Keep");
  assert.match(bigOk.reason, /makes 4 of 10, big 2 of 3/);
  assert.equal(f.recommendFate({ lim: limits.Protected, size: 30, counts: none }).fate, "Release");
  assert.equal(f.recommendFate({ lim: limits["Elephant Fish"], size: 90, counts: none }).fate, "Keep");
  assert.equal(f.recommendFate({ lim: undefined, size: 30, counts: null }).fate, "Keep");
});

test("a shared bag counts both species", () => {
  const run = [c("Shark (School)", 0), c("Shark (Gummy)", 1)];
  const counts = f.keptCounts(run, limits, "Shark (School)");
  assert.equal(f.recommendFate({ lim: limits["Shark (School)"], size: 50, counts }).fate, "Release");
});

test("stepper start: last size, else Min Size, else 30", () => {
  assert.equal(f.stepperStartSize(limits.Snapper, 33), 33);
  assert.equal(f.stepperStartSize(limits.Snapper, null), 28);
  assert.equal(f.stepperStartSize(limits["Elephant Fish"], null), 30);
  assert.equal(f.stepperStartSize(undefined, null), 30);
});

test("last catch size is the most recent catch of the species that has one", () => {
  const all = [c("Snapper", 5, { size: 31 }), c("Snapper", 9, { size: 35 }), c("Snapper", 12), c("Flathead", 13, { size: 50 })];
  assert.equal(f.lastCatchSize(all, "Snapper"), 35);
  assert.equal(f.lastCatchSize(all, "Bream"), null);
});

test("species blurb: limits, kept count, shared bag, tones", () => {
  const run = [c("Shark (School)", 0), c("Snapper", 1, { size: 45 }), c("Snapper", 2, { size: 30 })];
  const snapper = f.speciesLimitLines(limits.Snapper, f.speciesCounts(run, limits, "Snapper"));
  assert.equal(snapper.line1, "Min 28 cm · Max qty 10 · Big 40+ cm (3)");
  assert.equal(snapper.line2, "Kept 2/10 · big 1/3");
  assert.equal(snapper.tone, "");
  const school = f.speciesLimitLines(limits["Shark (School)"], f.speciesCounts(run, limits, "Shark (School)"));
  assert.equal(school.line2, "Kept 1/2 (shared with Shark (Gummy))");
  assert.equal(school.tone, "warn", "one left");
  const full = f.speciesLimitLines(limits["Shark (Gummy)"], f.speciesCounts([...run, c("Shark (Gummy)", 3)], limits, "Shark (Gummy)"));
  assert.equal(full.tone, "full");
  assert.deepEqual(f.speciesLimitLines(limits["Elephant Fish"], f.speciesCounts(run, limits, "Elephant Fish")), { line1: "No limits set", line2: "Kept 0", tone: "" });
  assert.deepEqual(f.speciesLimitLines(limits.Snapper, null), { line1: "Min 28 cm · Max qty 10 · Big 40+ cm (3)", line2: "", tone: "" }, "counts unknown: limits only");
});

test("edit warnings: kept but small, over slot, over the bag, over the big-fish limit; released is never warned", () => {
  const others = [c("Snapper", 0, { size: 41 }), c("Snapper", 1, { size: 42 }), c("Snapper", 2, { size: 43 })];
  const mk = (over) => ({ id: "edit", species: "Snapper", size: 30, released: false, tMs: at(3), ...over });
  assert.deepEqual(f.catchLimitWarnings(mk(), limits, others), []);
  assert.match(f.catchLimitWarnings(mk({ size: 20 }), limits, others)[0], /under the minimum size \(28 cm\)/);
  assert.match(f.catchLimitWarnings(mk({ size: 44 }), limits, others).join(" "), /Over the big-fish limit: 4 kept at 40\+ cm, allowed 3/);
  assert.deepEqual(f.catchLimitWarnings(mk({ size: 20, released: true }), limits, others), []);
  assert.match(f.catchLimitWarnings({ id: "e", species: "Flathead", size: 70, released: false, tMs: at(3) }, limits, others)[0], /over the maximum size \(60 cm\)/);
  const many = Array.from({ length: 10 }, (_, i) => c("Snapper", i * 0.1));
  assert.match(f.catchLimitWarnings(mk({ tMs: at(2) }), limits, many)[0], /Over the bag limit: 11 kept, Max qty 10/);
  const shared = [c("Shark (School)", 0), c("Shark (Gummy)", 1)];
  assert.match(f.catchLimitWarnings({ id: "s", species: "Shark (Gummy)", size: 50, released: false, tMs: at(2) }, limits, shared)[0], /Over the bag limit: 3 kept, Max qty 2 \(shared with Shark \(School\)\)/);
});

test("editing an existing catch doesn't count it twice", () => {
  const saved = { id: "same", species: "Flathead", size: 30, released: false, tMs: at(0) };
  const warnings = f.catchLimitWarnings({ ...saved }, limits, [saved]);
  assert.deepEqual(warnings, []);
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, species: "Flathead", size: 30, released: false, tMs: at(i * 0.1) }));
  const atLimit = f.catchLimitWarnings({ ...many[0] }, limits, many);
  assert.deepEqual(atLimit, [], "20 kept of 20 is at the limit, not over");
});
