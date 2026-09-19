// Tests for the tide classification logic in charts.js (a browser script, so the
// functions are pulled out of the source text and evaluated here).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../charts.js", import.meta.url), "utf8");
const grab = (re) => {
  const m = src.match(re);
  if (!m) throw new Error("could not find in charts.js: " + re);
  return m[0];
};
const fns = new Function(
  [
    grab(/const TIDE_SLACK_WINDOW_MS[^\n]*\r?\n/),
    grab(/const TIDE_RUN_TRANSITION_ZONE_MS[^\n]*\r?\n/),
    grab(/function naiveDateOnlyStr[\s\S]*?\r?\n}\r?\n/),
    grab(/function rankExtremum[\s\S]*?\r?\n}\r?\n/),
    grab(/function classifyTideConditionFromExtrema[\s\S]*?\r?\n}\r?\n/),
    grab(/function classifyTideFromExtrema[\s\S]*?\r?\n}\r?\n/),
    "return { rankExtremum, classifyTideFromExtrema, classifyTideConditionFromExtrema };",
  ].join("\n")
)();

const d = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return Date.UTC(2026, 8, 19, h, m); // 26:00 rolls into the next day
};
// One mixed-semidiurnal day: LHW 08:00 (1.2), LLW 14:00 (0.1), HHW 20:00 (1.6)
const day = [
  { t: d("02:00"), height: 0.4, type: "low" },
  { t: d("08:00"), height: 1.2, type: "high" },
  { t: d("14:00"), height: 0.1, type: "low" },
  { t: d("20:00"), height: 1.6, type: "high" },
  { t: d("26:00"), height: 0.5, type: "low" },
];

const cases = [
  ["08:00", "Slack High", "LHW"],
  ["07:00", "Last Run In", "LHW"],
  ["09:30", "Start Run Out", "LHW"],
  ["11:00", "Running Out", "LLW"],
  ["13:00", "Last Run Out", "LLW"],
  ["14:05", "Slack Low", "LLW"],
  ["15:00", "Start Run In", "LLW"],
  ["17:00", "Running In", "HHW"],
  ["19:00", "Last Run In", "HHW"],
  ["20:05", "Slack High", "HHW"],
  ["21:00", "Start Run Out", "HHW"],
];

for (const [time, condition, extreme] of cases) {
  test(`${time} -> ${condition} / ${extreme}`, () => {
    assert.deepEqual(fns.classifyTideFromExtrema(day, d(time)), { condition, extreme });
    assert.equal(fns.classifyTideConditionFromExtrema(day, d(time)), condition);
  });
}

test("no high/low bracketing the time -> null", () => {
  assert.equal(fns.classifyTideFromExtrema(day, d("01:00")), null);
});

test("extreme is null (condition still set) when there is no same-type peer", () => {
  const two = [
    { t: d("02:00"), height: 0.4, type: "low" },
    { t: d("08:00"), height: 1.2, type: "high" },
  ];
  assert.deepEqual(fns.classifyTideFromExtrema(two, d("07:00")), { condition: "Last Run In", extreme: null });
});

test("a lone high on its day is ranked against the neighbouring day's high", () => {
  const lone = [
    { t: d("02:00"), height: 0.4, type: "low" },
    { t: d("08:00"), height: 1.2, type: "high" },
    { t: d("14:00"), height: 0.2, type: "low" },
    { t: d("33:00"), height: 1.5, type: "high" }, // next day, higher
  ];
  assert.equal(fns.rankExtremum(lone, lone[1]), "LHW");
  assert.equal(fns.rankExtremum(lone, lone[3]), "HHW");
});
