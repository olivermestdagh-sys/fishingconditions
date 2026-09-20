// Sync import matching: waypoints and session Start/End points match existing
// marks on GPS location (20 m) and calendar date only — never on name.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readSharedScripts } from "./helpers.mjs";

const sync = fs.readFileSync(new URL("../sync.js", import.meta.url), "utf8");
const shared = readSharedScripts();
const grab = (text, re) => {
  const m = text.match(re);
  if (!m) throw new Error("could not find: " + re);
  return m[0];
};
const fn = (text, name) => grab(text, new RegExp(`function ${name}\\b[\\s\\S]*?\\r?\\n}\\r?\\n`));

const make = (existing) =>
  new Function(
    "existingMarks",
    "trackData",
    [
      grab(sync, /const SYNC_MATCH_RADIUS_M[^\n]*\r?\n/),
      grab(sync, /const SYNC_GRID_DEG[^\n]*\r?\n/),
      fn(shared, "previewEpochToNaiveString"),
      fn(sync, "syncDateKey"),
      fn(sync, "syncDateKeyFromMs"),
      fn(sync, "syncDistanceMeters"),
      fn(sync, "gridCellKey"),
      fn(sync, "neighbourhoodCellKeys"),
      "const guessSpeciesFromRawName = (n) => String(n || '').toLowerCase();", // names are irrelevant to matching — a stub is enough
      fn(sync, "collapseRawWaypoints"),
      fn(sync, "matchAgainstExisting"),
      fn(sync, "sessionCandidateAlreadySaved"),
      fn(sync, "refreshSavedSessionFlags"),
      "return { collapseRawWaypoints, matchAgainstExisting, sessionCandidateAlreadySaved, refreshSavedSessionFlags };",
    ].join("\n")
  )(existing, []);

const ms = (naive) => Date.UTC(+naive.slice(0, 4), +naive.slice(5, 7) - 1, +naive.slice(8, 10), +naive.slice(11, 13) || 0, +naive.slice(14, 16) || 0);
const raw = (name, naive, lat = -38.4, lng = 145.1) => ({ lat, lng, rawName: name, notes: "", createdAtMs: ms(naive), uuid: null });

test("waypoints at the same spot on the same day fold together whatever they are called", () => {
  const { collapseRawWaypoints } = make([]);
  const groups = collapseRawWaypoints([raw("Squid", "2026-09-11T08:00"), raw("Snapper", "2026-09-11T09:30"), raw("Whiting", "2026-09-11T10:00", -38.5, 145.2)]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].visitCount, 2);
  assert.equal(groups[0].rawName, "Snapper"); // takes the most recent record's name
});

test("the same spot on another day is a separate candidate", () => {
  const { collapseRawWaypoints } = make([]);
  assert.equal(collapseRawWaypoints([raw("Squid", "2026-09-11T08:00"), raw("Squid", "2026-09-12T08:00")]).length, 2);
});

test("an existing mark matches on spot and date, not name; a different date is offered", () => {
  const existing = [{ id: "m1", name: "Totally different name", lat: -38.4, lng: 145.1, dateTime: "2026-09-11T07:00:00" }];
  const { collapseRawWaypoints, matchAgainstExisting } = make(existing);
  const groups = collapseRawWaypoints([raw("Squid", "2026-09-11T08:00"), raw("Squid", "2026-09-12T08:00")]);
  matchAgainstExisting(groups);
  assert.ok(groups[0].matchedExisting, "same spot + same date is already saved");
  assert.equal(groups[0].matchedExisting.id, "m1");
  assert.equal(groups[1].matchedExisting, null, "same spot, different date is a new visit");
});

test("a mark more than 20 m away does not match even on the same date", () => {
  const existing = [{ id: "m1", name: "x", lat: -38.4005, lng: 145.1, dateTime: "2026-09-11T07:00:00" }]; // ~55 m north
  const { collapseRawWaypoints, matchAgainstExisting } = make(existing);
  const groups = collapseRawWaypoints([raw("Squid", "2026-09-11T08:00")]);
  matchAgainstExisting(groups);
  assert.equal(groups[0].matchedExisting, null);
});

test("a session Start/End is already saved only for the same role, date and spot", () => {
  const existing = [{ type: "Session", sessionRole: "start", name: "Anything", lat: -38.4, lng: 145.1, dateTime: "2026-09-11T11:14:25" }];
  const { sessionCandidateAlreadySaved } = make(existing);
  const point = { lat: -38.4, lon: 145.1, timeNaive: "2026-09-11 11:14:25" };
  assert.equal(sessionCandidateAlreadySaved(point, "start"), true);
  assert.equal(sessionCandidateAlreadySaved(point, "end"), false); // other role
  assert.equal(sessionCandidateAlreadySaved({ ...point, timeNaive: "2026-09-12 11:14:25" }, "start"), false); // other date
  assert.equal(sessionCandidateAlreadySaved({ ...point, lat: -38.41 }, "start"), false); // elsewhere
});

test("saved session candidates are taken out of the import", () => {
  const existing = [{ type: "Session", sessionRole: "start", lat: -38.4, lng: 145.1, dateTime: "2026-09-11T11:14:25" }];
  const day = { points: [{ lat: -38.4, lon: 145.1, timeNaive: "2026-09-11 11:14:25" }, { lat: -38.5, lon: 145.2, timeNaive: "2026-09-11 12:00:00" }] };
  const cands = [
    { kind: "start", pointIdx: 0, importChecked: true },
    { kind: "end", pointIdx: 1, importChecked: true },
  ];
  const trackData = [{ dayGroups: [{ ...day, segments: [{ candidates: cands }] }] }];
  // refreshSavedSessionFlags reads the page-level existingMarks/trackData, so wire them in as parameters
  const refresh = new Function(
    "existingMarks",
    "trackData",
    [
      grab(sync, /const SYNC_MATCH_RADIUS_M[^\n]*\r?\n/),
      fn(sync, "syncDateKey"),
      fn(sync, "syncDistanceMeters"),
      fn(sync, "sessionCandidateAlreadySaved"),
      fn(sync, "refreshSavedSessionFlags"),
      "return refreshSavedSessionFlags;",
    ].join("\n")
  )(existing, trackData);
  refresh();
  assert.equal(cands[0].saved, true);
  assert.equal(cands[0].importChecked, false);
  assert.equal(cands[1].saved, false);
  assert.equal(cands[1].importChecked, true);
});
