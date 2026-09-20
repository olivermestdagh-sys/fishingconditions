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
    grab(/const RIBBON_PAD_MS[^\n]*\r?\n/),
    grab(/const RIBBON_TIME_ZONE[^\n]*\r?\n/),
    grab(/const RIBBON_DAY_MS[^\n]*\r?\n/),
    grab(/const RIBBON_VISIBLE_DAYS[^\n]*\r?\n/),
    grab(/const RIBBON_MAX_DAYS[^\n]*\r?\n/),
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
    fn("ribbonRange"),
    fn("ribbonSegmentBounds"),
    fn("ribbonRowTimes"),
    fn("ribbonJoinRowBlocks"),
    fn("ribbonChunkSegments"),
    fn("ribbonDayLocations"),
    "return { ribbonBuildSessions, ribbonCarryForward, ribbonMarkConditionsAt, ribbonLayoutDots, ribbonSunTimes, parseNaive, ribbonDayFloor, ribbonRange, ribbonSegmentBounds, ribbonRowTimes, ribbonJoinRowBlocks, ribbonChunkSegments, ribbonDayLocations };",
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

test("the calendar spans the filter dates, or the data when a filter is blank", () => {
  const a = mk("a", "2026-09-10T06:00:00", "2026-09-10T09:00:00");
  const b = mk("b", "2026-09-14T06:00:00", "2026-09-14T09:00:00");
  const open = fns.ribbonRange([a, b], "", "");
  assert.equal(open.from, T("2026-09-10T00:00:00"));
  assert.equal(open.to, T("2026-09-15T00:00:00"));
  assert.deepEqual(open.sessions.map((s) => s.groupId), ["a", "b"]);
  const bounded = fns.ribbonRange([a, b], "2026-09-12", "2026-09-14");
  assert.equal(bounded.from, T("2026-09-12T00:00:00"));
  assert.equal(bounded.to, T("2026-09-15T00:00:00")); // the "to" date is included
  assert.deepEqual(bounded.sessions.map((s) => s.groupId), ["b"]);
});

test("the calendar is always at least the three visible days, and null with no sessions", () => {
  const a = mk("a", "2026-09-10T06:00:00", "2026-09-10T09:00:00");
  const r = fns.ribbonRange([a], "", "");
  assert.equal(r.to - r.from, 3 * 86400000);
  assert.equal(fns.ribbonRange([], "", ""), null);
});

test("two sessions on one day get non-overlapping condition windows that still contain each session", () => {
  const a = mk("a", "2026-09-10T06:00:00", "2026-09-10T08:00:00");
  const b = mk("b", "2026-09-10T15:00:00", "2026-09-10T17:00:00");
  const [sa, sb] = fns.ribbonSegmentBounds([b, a]);
  assert.equal(sa.session.groupId, "a");
  assert.equal(sa.from, T("2026-09-10T00:00:00"));
  assert.equal(sa.to, sb.from);
  assert.equal(sb.to, T("2026-09-11T00:00:00"));
  assert.ok(sa.from <= a.start && sa.to >= a.end && sb.from <= b.start && sb.to >= b.end);
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

test("separate session blocks are joined with an empty row so lines and strips stop at the block's edge", () => {
  const row = (iso) => ({ dateTime: iso, _t: T(iso) });
  const a = [row("2026-09-10T00:00:00"), row("2026-09-10T23:58:00")];
  const b = [row("2026-09-13T00:00:00"), row("2026-09-13T23:58:00")];
  const joined = fns.ribbonJoinRowBlocks([b, a]);
  assert.equal(joined.length, 6);
  assert.equal(joined[2]._t, T("2026-09-10T23:58:00") + 60000); // gap marker straight after block a
  assert.equal(joined[2].dateTime.slice(0, 10), "2026-09-10"); // still the same day, so no extra day is shaded
  assert.equal(joined[2]["Wind Forecast (km/h)"], undefined);
  assert.equal(joined[2]._break, true); // marked so the chart keeps it out of hourly bucketing
  assert.ok(joined[3]._t > joined[2]._t && joined[5]._t > joined[3]._t);
});

test("sessions share one chart unless a canvas would be too wide", () => {
  const seg = (fromDay, toDay) => ({ from: T(`${fromDay}T00:00:00`), to: T(`${toDay}T00:00:00`) });
  const segs = [seg("2026-09-01", "2026-09-02"), seg("2026-09-05", "2026-09-06"), seg("2026-09-20", "2026-09-21")];
  const pxPerMs = 100 / 86400000; // 100 px a day
  const one = fns.ribbonChunkSegments(segs, pxPerMs, 5000);
  assert.equal(one.length, 1);
  assert.equal(one[0].segs.length, 3);
  assert.equal(one[0].from, segs[0].from); // starts at the first session's day
  assert.equal(one[0].to, segs[2].to);
  const split = fns.ribbonChunkSegments(segs, pxPerMs, 800); // 8 days of width
  assert.equal(split.length, 2);
  assert.deepEqual(split.map((c) => c.segs.length), [2, 1]);
});
test("blocks on consecutive days run straight on with no break between them", () => {
  const row = (iso) => ({ dateTime: iso, _t: T(iso) });
  const a = [row("2026-09-10T00:00:00"), row("2026-09-10T23:58:00")];
  const b = [row("2026-09-11T00:00:00"), row("2026-09-11T23:58:00")];
  const joined = fns.ribbonJoinRowBlocks([a, b]);
  assert.equal(joined.filter((r) => r._break).length, 1); // only after the last block
  assert.equal(joined.length, 5);
});
test("a day's header lists the locations fished that day, in order, once each in a row", () => {
  const st = (start, end, locationName) => ({ session: { start: T(start), end: T(end) }, locationName });
  const states = [
    st("2026-09-11T15:00:00", "2026-09-11T17:00:00", "Rye"), // later on the day
    st("2026-09-11T06:00:00", "2026-09-11T08:00:00", "Flinders"),
    st("2026-09-11T09:00:00", "2026-09-11T10:00:00", "Flinders"), // same place straight after: not repeated
    st("2026-09-12T06:00:00", "2026-09-12T08:00:00", "Cowes"),
    st("2026-09-13T06:00:00", "2026-09-13T08:00:00", null), // location unknown
  ];
  const day = (d) => fns.ribbonDayLocations(states, T(`${d}T00:00:00`));
  assert.equal(day("2026-09-11"), "Flinders, Rye");
  assert.equal(day("2026-09-12"), "Cowes");
  assert.equal(day("2026-09-13"), "");
  assert.equal(day("2026-09-14"), "");
});

test("a session running past midnight names its place on both days", () => {
  const states = [{ session: { start: T("2026-09-11T22:00:00"), end: T("2026-09-12T02:00:00") }, locationName: "Flinders" }];
  assert.equal(fns.ribbonDayLocations(states, T("2026-09-11T00:00:00")), "Flinders");
  assert.equal(fns.ribbonDayLocations(states, T("2026-09-12T00:00:00")), "Flinders");
});