import { test } from "node:test";
import assert from "node:assert/strict";
import { compareRuns } from "../scripts/compare-parallel.mjs";

const loc = (name, type = "Kayak", ownerId = "public") => ({ ownerId, name, type });
const rows = (name, type = "Kayak", n = 50, tweak = {}) =>
  Array.from({ length: n }, (_, i) => ({
    "Location Name": name,
    Type: type,
    dateTime: `2026-10-15 ${String(i % 24).padStart(2, "0")}:${i < 24 ? "00" : "30"}`,
    "Tide Height (m)": 1 + i / 100,
    "Wind Forecast (km/h)": 10,
    "Temp Realtime (C)": 15,
    "Fishing Condition": "Good",
    ...tweak,
  }));
const doc = (over = {}) => ({ locations: [loc("A"), loc("B")], rows: [...rows("A"), ...rows("B")], sunTimes: { A: 1, B: 1 }, ...over });

test("identical data matches", () => assert.equal(compareRuns(doc(), doc()).ok, true));

test("small forecast drift is fine", () => {
  const w = doc({ rows: [...rows("A", "Kayak", 50, { "Wind Forecast (km/h)": 12 }), ...rows("B")] });
  assert.equal(compareRuns(w, doc()).ok, true);
});

test("a missing or extra location/type pair is a problem", () => {
  const r = compareRuns(doc({ locations: [loc("A")] }), doc());
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /only in git/);
});

test("a private location in the worker output is a problem", () => {
  const r = compareRuns(doc({ locations: [loc("A"), loc("B"), loc("C", "Kayak", "u1")] }), doc());
  assert.match(r.problems.join(), /non-public/);
});

test("tide heights that disagree are a problem", () => {
  const w = doc({ rows: [...rows("A", "Kayak", 50, { "Tide Height (m)": 9 }), ...rows("B")] });
  assert.match(compareRuns(w, doc()).problems.join(), /tide height/);
});

test("far fewer rows is a problem, and no overlap is a problem", () => {
  const w = doc({ rows: [...rows("A", "Kayak", 20), ...rows("B")] });
  assert.match(compareRuns(w, doc()).problems.join(), /row counts/);
  const moved = (n) => rows(n).map((r) => ({ ...r, dateTime: "2030-01-01 00:00" }));
  assert.match(compareRuns(doc({ rows: [...moved("A"), ...moved("B")] }), doc()).problems.join(), /no overlapping/);
});

test("graph file lists must match", () => {
  const g = (files) => files.map((file) => ({ file }));
  assert.equal(compareRuns(doc(), doc(), { worker: g(["a", "b"]), git: g(["b", "a"]) }).ok, true);
  assert.equal(compareRuns(doc(), doc(), { worker: g(["a"]), git: g(["a", "b"]) }).ok, false);
});
