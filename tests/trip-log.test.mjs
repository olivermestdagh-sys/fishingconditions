// Trip log, site side (js/trip-log.js): the pure helpers, and that its rod snapshot matches the Worker's (user-backend.js tlogRodRows),
// since the same table is written from both. The Worker side of the log is tested in controller-api.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const tripSrc = read("../js/trip-defaults.js");
const logSrc = read("../js/trip-log.js");
const workerSrc = read("../user-backend.js");

const parseNaive = String.raw`function parseNaive(iso) { const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/); if (!m) return null; const [, y, mo, d, h, mi, s] = m.map(Number); return Date.UTC(y, mo - 1, d, h, mi, s); }`;
const browser = new Function(
  `${parseNaive}\n${tripSrc.slice(0, tripSrc.indexOf("// --- Backend"))}\n${logSrc}\nreturn { tripLogRodRows, tripLogCatchRodRows, tripLogBuildEntry, tripLogActionState, tripLogDescribe, tripLogNewRunId };`
)();

const grab = (re) => {
  const m = re.exec(workerSrc);
  assert.ok(m, `not found in user-backend.js: ${re}`);
  return m[0];
};
const worker = new Function(
  [grab(/function ctlLiveRodSetupIds[\s\S]*?\n}\n/), grab(/function tlogRodRows[\s\S]*?\n}\n/), grab(/function tlogCatchRodRows[\s\S]*?\n}\n/), "return { tlogRodRows, tlogCatchRodRows };"].join("\n")
)();

const rodSetups = [
  { id: "r1", name: "Light", rod: "L Wilson", rig: "Paternoster", subListItems: [], bait: ["Prawn"], baitOptions: [] },
  { id: "r2", name: "Lure", rod: "L Raider", rig: "Jig Head", subListItems: ["Vibe"], bait: ["Squid"], baitOptions: ["Whole"] },
  { id: "r3", name: "Bottom", rod: "Heavy", rig: null, subListItems: [], bait: [], baitOptions: [] },
];

test("rod rows: placed setups take their position, unplaced follow from 5, deleted ones drop out — same as the Worker", () => {
  const action = { rodSetupIds: ["r2", "r1", "r3", "gone"], rodSlots: [null, "r1", null, "r2"] };
  const rows = browser.tripLogRodRows(action, rodSetups);
  assert.deepEqual(rows.map((r) => [r.slot, r.rodSetupId]), [[4, "r2"], [2, "r1"], [5, "r3"]]);
  assert.deepEqual(rows, worker.tlogRodRows(action, rodSetups));
  assert.deepEqual(browser.tripLogRodRows({ rodSetupIds: ["r1"] }, rodSetups).map((r) => r.slot), [5], "no saved positions: not placed");
});

test("a catch logs the setup it used: the chosen one, else the Action's only one, else none — same as the Worker", () => {
  const two = { rodSetupIds: ["r1", "r2"], rodSlots: ["r1", "r2", null, null] };
  const one = { rodSetupIds: ["r2"], rodSlots: ["r2", null, null, null] };
  for (const [action, chosen, expected] of [[two, "r2", ["r2"]], [two, null, []], [one, null, ["r2"]], [one, "r2", ["r2"]]]) {
    const rows = browser.tripLogCatchRodRows(action, rodSetups, chosen);
    assert.deepEqual(rows.map((r) => r.rodSetupId), expected);
    assert.deepEqual(rows, worker.tlogCatchRodRows(action, rodSetups, chosen));
  }
});

test("an entry carries the site's wall-clock text, the real time and the offset between them", () => {
  const e = browser.tripLogBuildEntry("run_1", { type: "trip_start", tripId: "t1" }, { ts: Date.UTC(2026, 9, 5, 0, 0, 0), dateTime: "2026-10-05 10:00:00" });
  assert.equal(e.tzOffsetMin, 600);
  assert.equal(e.runId, "run_1");
  assert.equal(e.type, "trip_start");
  assert.match(e.uuid, /^site_\d+_/);
  assert.notEqual(browser.tripLogBuildEntry("run_1", {}, { ts: 1, dateTime: "2026-10-05 10:00:00" }).uuid, browser.tripLogBuildEntry("run_1", {}, { ts: 1, dateTime: "2026-10-05 10:00:00" }).uuid);
  assert.match(browser.tripLogNewRunId(), /^run_\d+_/);
});

test("an Action's state: berley, methods, targets and every rod setup", () => {
  const s = browser.tripLogActionState({ id: "a1", name: "Drift", berley: "Pilchard Mix", fishingMethod: ["Drifting"], species: ["Bream"], rodSetupIds: ["r1"], rodSlots: ["r1", null, null, null] }, rodSetups);
  assert.equal(s.actionId, "a1");
  assert.deepEqual([s.berley, s.fishingMethod, s.targets], ["Pilchard Mix", ["Drifting"], ["Bream"]]);
  assert.equal(s.rods.length, 1);
});

test("the viewer describes an entry: what happened, the gear in force, the conditions", () => {
  const d = browser.tripLogDescribe({
    type: "change", changeField: "rod_setups", actionName: "Drift", waterCondition: "Clear", waterDepth: 3,
    rods: [{ name: "Light", rod: "L Wilson", rig: "Paternoster", rigOptions: [], bait: ["Squid", "Prawn"], baitOptions: [] }],
  });
  assert.equal(d.title, "Changed — (rod setups) — Drift");
  assert.ok(d.lines[0].includes("Squid/Prawn"));
  assert.equal(d.lines[1], "Clear, 3 m");
  assert.equal(browser.tripLogDescribe({ type: "catch", species: "Bream", size: 31 }).title, "Catch — Bream 31 cm");
});
