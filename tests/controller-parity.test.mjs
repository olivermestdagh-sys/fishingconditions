// The Worker's server copies of the Live trip/action/catch builders (user-backend.js, "Fishing Controller API") must produce exactly
// what the browser's do (js/trip-defaults.js, js/live-cards.js, js/catch-limits.js) for the same inputs — a controller catch has to
// be indistinguishable from one tapped on the Live page. Both sides are loaded from source and run on the same fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const tripSrc = read("../js/trip-defaults.js");
const liveSrc = read("../js/live-cards.js");
const limitsSrc = read("../js/catch-limits.js");
const workerSrc = read("../user-backend.js");

// Browser side: everything above the DOM/backend sections is pure.
const tripPure = tripSrc.slice(0, tripSrc.indexOf("// --- Backend"));
const livePure = liveSrc.slice(0, liveSrc.indexOf("// --- DOM:"));
const browser = new Function(
  `${limitsSrc}\n${tripPure}\n${livePure}\nreturn { buildCatchFromCards, tdCatchFieldsFromAction, tripCatchName };`
)();

// Worker side: the ctl* helpers and constants, pulled out of the Worker file.
const grab = (re) => {
  const m = re.exec(workerSrc);
  assert.ok(m, `not found in user-backend.js: ${re}`);
  return m[0];
};
const worker = new Function(
  [
    grab(/function ctlTripCatchName[\s\S]*?\n}\n/),
    grab(/function ctlUniq[\s\S]*?\n}\n/),
    grab(/function ctlLiveRodSetupIds[\s\S]*?\n}\n/),
    grab(/function ctlCatchFieldsFromAction[\s\S]*?\n}\n/),
    grab(/function ctlBuildCatch[\s\S]*?\n}\n/),
    grab(/function ctlNaiveFromEpoch[\s\S]*?\n}\n/),
    grab(/function ctlSpeciesOrder[\s\S]*?\n}\n/),
    "return { ctlBuildCatch, ctlNaiveFromEpoch, ctlSpeciesOrder };",
  ].join("\n")
)();

const rodSetups = [
  { id: "r1", name: "Light", rod: "L Wilson", rig: "Paternoster", subListItems: [] },
  { id: "r2", name: "Lure", rod: "L Raider", rig: "Jig Head", subListItems: ["Vibe", "Paddle Tail"], bait: ["Squid", "Worm"], baitOptions: ["Whole"] },
  { id: "r4", name: "Bottom", rod: "M Penn", rig: "Paternoster", subListItems: [], bait: ["Prawn"], baitOptions: ["Peeled", "Whole"] },
  { id: "r3", name: "Heavy", rod: "M Penn", rig: "Paternoster", subListItems: [] },
];
const actions = {
  full: { id: "a1", tripId: "t1", name: "Drift", species: ["Bream", "Flathead", "Bream"], fishingMethod: ["Drifting"], berley: "Pilchard Mix", rodSetupIds: ["r1", "r2", "gone"] },
  one: { id: "a2", tripId: "t1", name: "Anchor", species: ["Snapper"], fishingMethod: [], berley: "", bait: [], rodSetupIds: ["r3"] },
  empty: { id: "a3", tripId: "t1", name: "Move", species: [], fishingMethod: [], berley: null, bait: [], rodSetupIds: [] },
};
const at = { lat: -38.1, lng: 145.2, dateTime: "2026-10-02 10:15:30", createdAt: "2026-10-02 10:15:30" };

test("Catch on a running action: same mark as the Live +Catch flow saves", () => {
  const cases = [
    { species: "Bream", size: 31.5, released: false, tooSmall: false, depth: 4, setupId: null, water: "" },
    { species: "Flathead", size: 28, released: true, tooSmall: false, depth: null, setupId: "r2", water: "Murky" },
    { species: "Bream", size: null, released: true, tooSmall: true, depth: 2.5, setupId: "r1", water: "" },
  ];
  for (const action of Object.values(actions)) {
    for (const c of cases) {
      const base = { id: "m9", lat: at.lat, lng: at.lng, dateTime: at.dateTime, species: c.species };
      // How map-live.js's saveLiveCatch builds it on a trip (tide left out): the card builder, then the Action's gear on top.
      const defaults = { water: c.water, berley: action.berley || "", fishingMethod: action.fishingMethod || [], rodSetups: {} };
      const viaBrowser = browser.buildCatchFromCards({ ...base, size: c.tooSmall ? null : c.size, rod: "", tooSmall: c.tooSmall, released: c.released }, defaults, undefined, c.depth);
      Object.assign(viaBrowser, browser.tdCatchFieldsFromAction(action, rodSetups, c.setupId, "Weekend"));
      viaBrowser.name = browser.tripCatchName(c.species, "Weekend", action.name, 2); // map-live.js names it after the species, trip, action and session number
      const viaWorker = worker.ctlBuildCatch({ ...base, size: c.size, released: c.released, tooSmall: c.tooSmall, water: c.water, waterDepth: c.depth, setupId: c.setupId, tripName: "Weekend", sessionNumber: 2 }, action, rodSetups);
      assert.deepEqual(viaWorker, viaBrowser, `${action.name} ${JSON.stringify(c)}`);
    }
  }
});

test("Catch with a Bait answer: the answer is the mark's bait, as the Live +Catch flow saves it", () => {
  for (const action of Object.values(actions)) {
    const base = { id: "m9", lat: at.lat, lng: at.lng, dateTime: at.dateTime, species: "Bream" };
    const defaults = { water: "", berley: action.berley || "", fishingMethod: action.fishingMethod || [], rodSetups: {} };
    const viaBrowser = browser.buildCatchFromCards({ ...base, size: 30, rod: "", bait: "Squid", released: false }, defaults, undefined, null);
    Object.assign(viaBrowser, browser.tdCatchFieldsFromAction(action, rodSetups, null, "Weekend"));
    viaBrowser.bait = "Squid"; // map-live.js puts the answer on after the action's gear
    viaBrowser.name = browser.tripCatchName("Bream", "Weekend", action.name, null);
    const viaWorker = worker.ctlBuildCatch({ ...base, size: 30, released: false, bait: "Squid", setupId: null, tripName: "Weekend" }, action, rodSetups);
    assert.deepEqual(viaWorker, viaBrowser, action.name);
  }
  // "none" (an empty answer from the controller) clears the rod setup's bait; no answer keeps it
  const base = { id: "m9", lat: at.lat, lng: at.lng, dateTime: at.dateTime, species: "Bream", size: 30, released: false, setupId: "r2" };
  assert.equal(worker.ctlBuildCatch({ ...base, bait: "" }, actions.full, rodSetups).bait, undefined);
  assert.equal(worker.ctlBuildCatch({ ...base }, actions.full, rodSetups).bait, "Squid, Worm");
});

test("a catch with no running action has only what the controller sent", () => {
  const m = worker.ctlBuildCatch({ id: "m1", ...at, species: "Squid", size: 18, released: false, waterDepth: 6, source: "Controller" }, null, rodSetups);
  assert.deepEqual(m, { id: "m1", lat: at.lat, lng: at.lng, name: "Squid", type: "Catch", dateTime: at.dateTime, createdAt: at.dateTime, source: "Controller", species: "Squid", size: 18, waterDepth: 6 });
});

test("UTC epoch seconds become the site's naive local time", () => {
  const utc = Date.UTC(2026, 9, 2, 0, 5, 9) / 1000;
  assert.equal(worker.ctlNaiveFromEpoch(utc, 0), "2026-10-02 00:05:09");
  assert.equal(worker.ctlNaiveFromEpoch(utc, 600), "2026-10-02 10:05:09", "UTC+10");
  assert.equal(worker.ctlNaiveFromEpoch(utc, -90), "2026-10-01 22:35:09", "crosses midnight backwards");
});

test("an action's species order: its targets, the trip's other targets, then the rest", () => {
  const all = ["Bream", "Flathead", "Snapper", "Squid", "Tailor"];
  const list = [actions.full, actions.one, { id: "a9", tripId: "other", species: ["Tailor"] }];
  assert.deepEqual(worker.ctlSpeciesOrder(actions.full, list, all), ["Bream", "Flathead", "Snapper", "Squid", "Tailor"]);
  assert.deepEqual(worker.ctlSpeciesOrder(actions.one, list, all), ["Snapper", "Bream", "Flathead", "Squid", "Tailor"]);
});
