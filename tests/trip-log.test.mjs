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
  `${parseNaive}\n${tripSrc.slice(0, tripSrc.indexOf("// --- Backend"))}\n${logSrc}\nreturn { tripLogRodRows, tripLogCatchRodRows, tripLogBuildEntry, tripLogActionState, tripLogNewRunId };`
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

// --- the Trip Logs tab's reading helpers (js/trip-log-view.js) ---------------------------------------------------------
const view = new Function(read("../js/trip-log-view.js") + "\nreturn { tripLogEventLabel, tripLogGearLines, tripLogGearTitle, tripLogWaterText, tripLogConditionsText, tripLogCatchText, tripLogDurations, tripLogFormatDuration, tripLogElapsed, tripLogDateLabel, tripLogFlags, tripLogTotals, tripLogIsApprox, tripLogBuildPatch, tripLogParseNumber, tripLogRodFromSetup, tripLogSublist, tripLogChoices, tripLogToReportMarks };")();

test("labels, gear, water, conditions and catch text", () => {
  assert.equal(view.tripLogEventLabel({ type: "trip_start" }), "Trip started");
  assert.equal(view.tripLogEventLabel({ type: "change", changeField: "rod_setups" }), "Changed (rod setups)");
  assert.equal(view.tripLogEventLabel({ type: "change", changeField: "water+depth" }), "Changed (water + depth)");
  assert.equal(view.tripLogEventLabel({ type: "catch" }), "Catch");
  assert.deepEqual(
    view.tripLogGearLines([{ name: "Light", rod: "L Wilson", rig: "Paternoster", rigOptions: ["Octopus 3/0"], bait: ["Squid", "Prawn"], baitOptions: ["Wing Strip"] }, { rod: "EGI", rig: "Squid Jig" }, { name: "Bare" }, {}]),
    ["Light — Octopus 3/0 · Squid, Prawn · Wing Strip", "EGI · Squid Jig", "Bare", "Rod"]
  );
  assert.equal(view.tripLogGearTitle({ name: "Light", rod: "L Wilson", rig: "Paternoster" }), "L Wilson · Paternoster", "the rod and rig sit behind the setup's name");
  assert.equal(view.tripLogGearTitle({ rod: "EGI" }), "", "no name: the line already says it");
  assert.equal(view.tripLogWaterText({ waterCondition: "Murky", waterDepth: 2.5 }), "Murky, 2.5 m");
  assert.equal(view.tripLogWaterText({}), "");
  assert.equal(
    view.tripLogConditionsText({ tideCondition: "Running In", tideExtreme: "HHW", weatherCondition: "Cloudy", windSpeed: 13, windDirection: "SSW", temperature: 14.2, barometer: 1022.9 }),
    "Running In (HHW) · Cloudy · 13 km/h SSW · 14.2°C · 1022.9 hPa"
  );
  assert.equal(view.tripLogConditionsText({}), "", "still to be looked up");
  assert.equal(view.tripLogCatchText({ type: "catch", species: "Bream", size: 31, released: true }), "Bream 31 cm (released)");
  assert.equal(view.tripLogCatchText({ type: "action_start", species: "Bream" }), "");
});

test("how long each action ran: from its start to the next start / end, changes don't end it", () => {
  const MIN = 60000;
  const e = (type, min) => ({ type, ts: 1_000_000 + min * MIN });
  const entries = [e("trip_start", 0), e("action_start", 5), e("change", 20), e("catch", 25), e("action_start", 40), e("action_end", 70), e("action_start", 75), e("trip_end", 80)];
  const d = view.tripLogDurations(entries);
  assert.deepEqual([...d.entries()], [[1, 35 * MIN], [4, 30 * MIN], [6, 5 * MIN]]);
  assert.equal(view.tripLogDurations([e("trip_start", 0), e("action_start", 5)]).size, 0, "still running: nothing after it yet");
  assert.equal([...view.tripLogDurations(entries).values()].reduce((a, b) => a + b, 0), 70 * MIN);
});

test("durations, elapsed time, dates, flags and totals", () => {
  assert.equal(view.tripLogFormatDuration(8000), "8 s");
  assert.equal(view.tripLogFormatDuration(12 * 60000), "12 min");
  assert.equal(view.tripLogFormatDuration(65 * 60000), "1 h 05 min");
  assert.equal(view.tripLogFormatDuration(NaN), "");
  assert.equal(view.tripLogElapsed(0, 47 * 60000), "+0:47");
  assert.equal(view.tripLogElapsed(0, 125 * 60000), "+2:05");
  assert.equal(view.tripLogDateLabel("2026-10-04 09:37:45"), "Sun, 4 Oct");
  assert.equal(view.tripLogDateLabel(""), "");
  assert.deepEqual(view.tripLogFlags({ approximate: true, pending: true, hasTripEnd: false }), ["approx. times", "weather pending", "no end logged"]);
  assert.deepEqual(view.tripLogFlags({ hasTripEnd: true }), []);
  assert.deepEqual(view.tripLogTotals([{ fishedMs: 5, catches: 1 }, { fishedMs: 7 }]), { trips: 2, fishedMs: 12, catches: 1 });
  assert.equal(view.tripLogIsApprox({ source: "Backfill", markId: null }), true);
  assert.equal(view.tripLogIsApprox({ source: "Backfill", markId: "m1" }), false, "a rebuilt entry taking its time from a mark is exact");
  assert.equal(view.tripLogIsApprox({ source: "Controller" }), false);
});

test("the line editor's form becomes the PATCH body: blanks clear, numbers parse, catch fields only on a catch", () => {
  const form = {
    date: "2026-10-04", time: "10:54", type: "catch", changeField: "water", actionName: "Channel", waterCondition: "Murky", waterDepth: "3.2", tideCondition: "", tideExtreme: "HLW",
    weatherCondition: "Cloudy", windSpeed: "13", windDirection: "SSW", temperature: " 14.2 ", barometer: "", waterTemperature: "14.5", berley: "", fishingMethod: ["Drifting"], targets: [],
    species: "Ray", size: "60", released: true, lat: "-38.3", lng: "145.5",
    rods: [{ rodSetupId: "r1", name: "Penn", rod: "M Penn", rig: "Paternoster", rigOptions: ["Octopus 3/0"], bait: ["Squid"], baitOptions: ["Wing Strip"] }, { rodSetupId: "", name: "", rod: "", rig: "", rigOptions: [], bait: [], baitOptions: [] }],
  };
  const { body, error } = view.tripLogBuildPatch(form);
  assert.equal(error, undefined);
  assert.equal(body.manual, true);
  assert.equal(body.dateTime, "2026-10-04 10:54:00", "seconds are added");
  assert.deepEqual([body.waterDepth, body.windSpeed, body.temperature, body.barometer, body.lat], [3.2, 13, 14.2, null, -38.3]);
  assert.deepEqual([body.tideCondition, body.berley, body.changeField], [null, null, null], "blank text clears; 'what changed' only belongs to a change");
  assert.deepEqual([body.species, body.size, body.released], ["Ray", 60, true]);
  assert.deepEqual(body.rods.map((r) => [r.slot, r.rodSetupId, r.rod, r.bait]), [[1, "r1", "M Penn", ["Squid"]], [2, null, null, []]]);

  const change = view.tripLogBuildPatch({ ...form, type: "change", changeField: "rod_setups" }).body;
  assert.deepEqual([change.changeField, change.species, change.size, change.released], ["rod_setups", null, null, null], "catch fields are cleared on any other event");

  assert.match(view.tripLogBuildPatch({ ...form, date: "" }).error, /date and time/);
  assert.match(view.tripLogBuildPatch({ ...form, time: "9am" }).error, /date and time/);
  assert.match(view.tripLogBuildPatch({ ...form, waterDepth: "deep" }).error, /Depth must be a number/);
  assert.match(view.tripLogBuildPatch({ ...form, size: "big" }).error, /Size must be a number/);
});

test("editor helpers: numbers, Rod Setup rows, sub lists and the choices a pick-list offers", () => {
  assert.deepEqual(["", " 5 ", "x", "-1.5", null].map(view.tripLogParseNumber), [null, 5, undefined, -1.5, null]);
  assert.deepEqual(view.tripLogRodFromSetup({ id: "r1", name: "Light", rod: "L Wilson", rig: "Paternoster", subListItems: ["A"], bait: ["Squid"], baitOptions: ["Half"] }),
    { rodSetupId: "r1", name: "Light", rod: "L Wilson", rig: "Paternoster", rigOptions: ["A"], bait: ["Squid"], baitOptions: ["Half"] });
  assert.deepEqual(view.tripLogRodFromSetup(null), { rodSetupId: "", name: "", rod: "", rig: "", rigOptions: [], bait: [], baitOptions: [] });
  assert.deepEqual(view.tripLogSublist({ id: "x", hasSublist: true, subList: ["a", "b"] }), ["a", "b"]);
  assert.deepEqual(view.tripLogSublist({ id: "x", hasSublist: false }, new Map([["x", ["mine"]]])), ["mine"], "your private list on a rig you don't own");
  assert.deepEqual(view.tripLogSublist(null), []);
  assert.deepEqual(view.tripLogChoices(["a", "b"], "z"), ["a", "b", "z"], "a value the list no longer has stays choosable");
  assert.deepEqual(view.tripLogChoices(["a", "b"], ["b", "c", ""]), ["a", "b", "c"]);
});

// --- Reports source: log rows -> mark-like objects ---------------------------------------------------------------------------------

const reportEntries = [
  { id: "t1", runId: "r1", type: "action_start", ts: 1, dateTime: "2026-03-07 07:00:00", lat: -38.1, lng: 145.2, actionName: "Drift", tripName: "Day", tideCondition: "Running In" },
  { id: "t2", runId: "r1", type: "catch", ts: 2, dateTime: "2026-03-07 07:40:00", lat: -38.1, lng: 145.2, markId: "m9", species: "Bream", size: 30, released: false, fishingMethod: ["Drifting", "Bottom"], waterCondition: "Murky", waterDepth: 3, tideCondition: "Running In", tideExtreme: "HHW", temperature: 21.5, berley: "Pilchard",
    rods: [{ rod: "L Wilson", rig: "Paternoster", bait: ["Prawn", "Squid"] }, { rod: "L Raider", rig: "Paternoster", bait: ["Prawn"] }] },
  { id: "t3", runId: "r1", type: "action_start", ts: 3, dateTime: "2026-03-07 09:00:00", lat: -38.2, lng: 145.3, actionName: "Anchor" },
  { id: "t4", runId: "r1", type: "trip_end", ts: 4, dateTime: "2026-03-07 10:00:00", lat: -38.3, lng: 145.4 },
  { id: "t5", runId: "r2", type: "catch", ts: 5, dateTime: "2026-03-08 08:00:00", lat: -38, lng: 145, species: "Flathead", rods: [] },
  { id: "t6", runId: "r3", type: "action_start", ts: 6, dateTime: "2026-03-09 08:00:00", lat: -38, lng: 145, tripName: "Open" },
];

test("reports adapter: a catch row becomes a Catch mark with its gear joined as text", () => {
  const marks = view.tripLogToReportMarks(reportEntries);
  const c = marks.find((m) => m.type === "Catch" && m.species === "Bream");
  assert.equal(c.id, "m9");
  assert.equal(c.rod, "L Wilson, L Raider");
  assert.equal(c.rig, "Paternoster");
  assert.equal(c.bait, "Prawn, Squid");
  assert.equal(c.fishingMethod, "Drifting, Bottom");
  assert.deepEqual([c.tideCondition, c.tideExtreme, c.temperature, c.waterCondition, c.waterDepth, c.size], ["Running In", "HHW", 21.5, "Murky", 3, 30]);
  assert.equal(marks.find((m) => m.species === "Flathead").id, "t5"); // no mark: the log row's id
});

test("reports adapter: an action runs to the next action start / trip end; a running one has no End", () => {
  const marks = view.tripLogToReportMarks(reportEntries).filter((m) => m.type !== "Catch");
  assert.deepEqual(marks.map((m) => [m.type, m.sessionGroupId, m.dateTime.slice(11, 16), m.name]), [
    ["Session Start", "r1:0", "07:00", "Drift"],
    ["Session End", "r1:0", "09:00", "Drift"],
    ["Session Start", "r1:1", "09:00", "Anchor"],
    ["Session End", "r1:1", "10:00", "Anchor"],
    ["Session Start", "r3:0", "08:00", "Open"],
  ]);
  assert.equal(marks[0].tideCondition, "Running In"); // the start carries its conditions for the ribbon
});
