// Session ribbon: the pure logic (session grouping, carried-forward conditions,
// tide curve, dot layout, wind cells, calculated light times).
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
    grab(/const RIBBON_TIME_ZONE[^\n]*\r?\n/),
    grab(/const RIBBON_DAY_MS[^\n]*\r?\n/),
    grab(/const RIBBON_VIEW_PAD_MS[^\n]*\r?\n/),
    fn("parseNaive"),
    fn("naiveDateOnlyStr"),
    fn("ribbonBuildSessions"),
    fn("ribbonCarryForward"),
    fn("ribbonMarkConditionsAt"),
    fn("ribbonLayoutDots"),
    fn("ribbonLocalWallMs"),
    fn("ribbonSolarEvent"),
    fn("ribbonSunTimes"),
    fn("ribbonDayFloor"),
    fn("ribbonSegmentBounds"),
    fn("ribbonSessionsInRange"),
    fn("ribbonViewWindow"),
    fn("ribbonRowTimes"),
    "return { ribbonBuildSessions, ribbonCarryForward, ribbonMarkConditionsAt, ribbonLayoutDots, ribbonSunTimes, parseNaive, ribbonDayFloor, ribbonSegmentBounds, ribbonSessionsInRange, ribbonViewWindow, ribbonRowTimes };",
  ].join("\n")
)();
const T = (s) => fns.parseNaive(s);

const marks = [
  { id: "s1", type: "Session", sessionRole: "start", sessionGroupId: "g1", name: "Session 1 start", dateTime: "2026-09-20T06:00:00", lat: -38.4, lng: 145.1, windSpeed: 10, windDirection: "N", tideCondition: "Running In" },
  { id: "s2", type: "Session", sessionRole: "end", sessionGroupId: "g1", name: "Session 1 end", dateTime: "2026-09-20T10:00:00", lat: -38.4, lng: 145.1 },
  { id: "c1", type: "Catch", species: "Whiting", dateTime: "2026-09-20T07:15:00", size: 30, windSpeed: 18, windDirection: "S" },
  { id: "c2", type: "Catch", species: "Snapper", dateTime: "2026-09-20T09:00:00" },
  { id: "c3", type: "Catch", species: "Whiting", dateTime: "2026-09-20T12:00:00" }, // after the session
  { id: "c4", type: "Catch", species: "Whiting", dateTime: "2026-09-19T07:00:00" }, // another day
];

test("a session gathers only the catches between its start and end", () => {
  const [s] = fns.ribbonBuildSessions(marks);
  assert.equal(s.name, "Session 1");
  assert.deepEqual(s.catches.map((c) => c.id), ["c1", "c2"]);
  assert.equal(s.missingStart || s.missingEnd, false);
});

test("a session with no catches is still a valid session", () => {
  const [s] = fns.ribbonBuildSessions(marks.filter((m) => m.type === "Session"));
  assert.equal(s.catches.length, 0);
  assert.equal(s.end - s.start, 4 * 3600000);
});

test("conditions on a mark stay in force until a later mark changes them", () => {
  const [s] = fns.ribbonBuildSessions(marks);
  assert.equal(fns.ribbonCarryForward(s.marks, T("2026-09-20T06:30:00"), "windSpeed"), 10);
  assert.equal(fns.ribbonCarryForward(s.marks, T("2026-09-20T08:00:00"), "windSpeed"), 18); // changed by the catch at 07:15
  assert.equal(fns.ribbonCarryForward(s.marks, T("2026-09-20T09:30:00"), "windDirection"), "S");
  assert.equal(fns.ribbonMarkConditionsAt(s.marks, T("2026-09-20T09:30:00")).tideCondition, "Running In"); // never changed
  assert.equal(fns.ribbonCarryForward(s.marks, T("2026-09-20T05:00:00"), "windSpeed"), null); // before any mark
});

test("a session missing its end mark ends at its last catch", () => {
  const [s] = fns.ribbonBuildSessions(marks.filter((m) => m.id !== "s2"));
  assert.equal(s.missingEnd, true);
  assert.equal(s.end, T("2026-09-20T12:00:00")); // last catch within 12 h of the start
});

test("catches close together stack instead of hiding each other", () => {
  const dots = fns.ribbonLayoutDots([{ x: 100, r: 6 }, { x: 104, r: 6 }, { x: 106, r: 6 }, { x: 200, r: 6 }]);
  assert.deepEqual(dots.map((d) => d.level), [0, 1, 2, 0]);
});

test("calculated light times match the stored sun times for a known day", () => {
  // conditions.json, Balnarring Beach, 2026-09-20: first light 05:46, sunrise 06:12, sunset 18:13, last light 18:40
  const sun = fns.ribbonSunTimes("2026-09-20", -38.3884, 145.1245);
  const within = (got, want) => Math.abs(got - T(`2026-09-20T${want}:00`)) <= 3 * 60000;
  assert.ok(within(sun.firstLight, "05:46"), "first light");
  assert.ok(within(sun.sunrise, "06:12"), "sunrise");
  assert.ok(within(sun.sunset, "18:13"), "sunset");
  assert.ok(within(sun.lastLight, "18:40"), "last light");
});

const mk = (id, start, end, extra = {}) => ({ groupId: id, start: T(start), end: T(end), ...extra });

test("sessions on the same day at the same place share one graph block, not one each", () => {
  const a = mk("a", "2026-09-10T06:00:00", "2026-09-10T08:00:00", { locationKey: "Flinders" });
  const b = mk("b", "2026-09-10T15:00:00", "2026-09-10T17:00:00", { locationKey: "Flinders" });
  const blocks = fns.ribbonSegmentBounds([b, a]);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].sessions.map((s) => s.groupId), ["a", "b"]);
  assert.equal(blocks[0].from, T("2026-09-10T00:00:00"));
  assert.equal(blocks[0].to, T("2026-09-11T00:00:00"));
});

test("two places on one day get two blocks split between the sessions, each containing its own", () => {
  const a = mk("a", "2026-09-10T06:00:00", "2026-09-10T08:00:00", { locationKey: "Flinders" });
  const b = mk("b", "2026-09-10T15:00:00", "2026-09-10T17:00:00", { locationKey: "Rye" });
  const [ba, bb] = fns.ribbonSegmentBounds([a, b]);
  assert.equal(ba.from, T("2026-09-10T00:00:00"));
  assert.equal(ba.to, bb.from);
  assert.equal(bb.to, T("2026-09-11T00:00:00"));
  assert.ok(ba.from <= a.start && ba.to >= a.end && bb.from <= b.start && bb.to >= b.end);
});

test("different days are different blocks even at the same place", () => {
  const a = mk("a", "2026-09-10T06:00:00", "2026-09-10T08:00:00", { locationKey: "Flinders" });
  const b = mk("b", "2026-09-11T06:00:00", "2026-09-11T08:00:00", { locationKey: "Flinders" });
  const blocks = fns.ribbonSegmentBounds([a, b]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].to, T("2026-09-11T00:00:00"));
  assert.equal(blocks[1].from, T("2026-09-11T00:00:00"));
});
test("a session that runs past midnight covers both days", () => {
  const a = mk("a", "2026-09-10T22:00:00", "2026-09-11T02:00:00");
  const [s] = fns.ribbonSegmentBounds([a]);
  assert.equal(s.from, T("2026-09-10T00:00:00"));
  assert.equal(s.to, T("2026-09-12T00:00:00"));
});
test("a day's rows run hourly up to its midnight without spilling into the next day", () => {
  const from = T("2026-09-10T00:00:00");
  const to = T("2026-09-11T00:00:00");
  const times = fns.ribbonRowTimes(from, to);
  assert.equal(times[0], from);
  assert.ok(times.every((t) => t < to), "no row at or after the next midnight");
  assert.equal(times[times.length - 1], to - 120000);
  assert.equal(times.length, 25); // 24 hourly rows (00:00..23:00) + the end-of-day row
});

test("only sessions that started inside the date filters are listed, oldest first; a blank filter is open-ended", () => {
  const a = mk("a", "2026-09-10T06:00:00", "2026-09-10T09:00:00");
  const b = mk("b", "2026-09-14T06:00:00", "2026-09-14T09:00:00");
  const c = mk("c", "2026-09-20T06:00:00", "2026-09-20T09:00:00");
  assert.deepEqual(fns.ribbonSessionsInRange([c, a, b], "", "").map((s) => s.groupId), ["a", "b", "c"]);
  assert.deepEqual(fns.ribbonSessionsInRange([a, b, c], "2026-09-12", "2026-09-14").map((s) => s.groupId), ["b"]); // the "to" date is included
  assert.deepEqual(fns.ribbonSessionsInRange([a, b, c], "2026-09-15", "").map((s) => s.groupId), ["c"]);
  assert.deepEqual(fns.ribbonSessionsInRange([], "", ""), []);
});

test("the view runs 12 hours before the first session started to 12 hours after the last one finished", () => {
  const a = mk("a", "2026-09-11T06:14:00", "2026-09-11T07:57:00");
  const b = mk("b", "2026-09-11T09:02:00", "2026-09-11T09:13:00");
  const w = fns.ribbonViewWindow([a, b]);
  assert.equal(w.from, T("2026-09-10T18:14:00")); // 12 h before the 06:14 start
  assert.equal(w.to, T("2026-09-11T21:13:00")); // 12 h after the 09:13 finish
  const single = fns.ribbonViewWindow([a]);
  assert.equal(single.to, T("2026-09-11T19:57:00"));
});