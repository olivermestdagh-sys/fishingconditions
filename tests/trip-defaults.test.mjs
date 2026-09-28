// Map > Trip Defaults: the pure helpers in js/trip-defaults.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../js/trip-defaults.js", import.meta.url), "utf8");
const pure = src.slice(0, src.indexOf("// --- Backend"));
const fns = new Function(pure + "\nreturn { tdToggle, tdToggleSingle, tdRigSublist, tdActionsForTrip, tdLiveRodSetupIds, tdHasValue, buildSessionStartFromAction, tdOtherTargets, tdCatchFieldsFromAction };")();

test("tdToggle adds a missing value and removes a present one, without mutating", () => {
  const list = ["a"];
  assert.deepEqual(fns.tdToggle(list, "b"), ["a", "b"]);
  assert.deepEqual(fns.tdToggle(list, "a"), []);
  assert.deepEqual(list, ["a"]);
  assert.deepEqual(fns.tdToggle(undefined, "x"), ["x"]);
});

test("tdToggleSingle clears the chosen value when tapped again", () => {
  assert.equal(fns.tdToggleSingle(null, "Pilchard"), "Pilchard");
  assert.equal(fns.tdToggleSingle("Pilchard", "Pilchard"), null);
  assert.equal(fns.tdToggleSingle("Pilchard", "Bread"), "Bread");
});

test("tdRigSublist uses the rig's own list, else the private override, else nothing", () => {
  const overrides = new Map([["r2", ["Vibe"]]]);
  assert.deepEqual(fns.tdRigSublist({ id: "r1", hasSublist: true, subList: ["Paddle Tail"] }, overrides), ["Paddle Tail"]);
  assert.deepEqual(fns.tdRigSublist({ id: "r2", hasSublist: false }, overrides), ["Vibe"]);
  assert.deepEqual(fns.tdRigSublist({ id: "r3" }, overrides), []);
  assert.deepEqual(fns.tdRigSublist(undefined, overrides), []);
});

test("tdActionsForTrip only returns that trip's actions", () => {
  const actions = [{ id: "1", tripId: "t1" }, { id: "2", tripId: "t2" }, { id: "3", tripId: "t1" }];
  assert.deepEqual(fns.tdActionsForTrip(actions, "t1").map((a) => a.id), ["1", "3"]);
});

test("tdLiveRodSetupIds drops rod setups that no longer exist", () => {
  assert.deepEqual(fns.tdLiveRodSetupIds(["a", "gone", "b"], [{ id: "a" }, { id: "b" }]), ["a", "b"]);
});

test("tdHasValue is a trimmed, case-insensitive membership check", () => {
  assert.equal(fns.tdHasValue(["Running Sinker"], " running sinker "), true);
  assert.equal(fns.tdHasValue(["Running Sinker"], "Paternoster"), false);
  assert.equal(fns.tdHasValue(undefined, "x"), false);
});

test("buildSessionStartFromAction maps an Action and its rod setups onto a Session Start mark", () => {
  const rodSetups = [
    { id: "a", rod: "Light", rig: "Soft plastic rig", subListItems: ["Vibe", "Paddle Tail"] },
    { id: "b", rod: "Heavy", rig: "Soft plastic rig", subListItems: ["Vibe"] },
  ];
  const action = { species: ["Bream", "Whiting"], fishingMethod: ["Lure"], berley: "Pilchard", bait: ["Prawn"], rodSetupIds: ["a", "b", "gone"] };
  const ctx = { id: "m1", lat: -38, lng: 145, dateTime: "2026-09-29 06:00:00", createdAt: "2026-09-29 06:00:00", sessionGroupId: "g1", sessionNumber: 3, water: "Clear", waterDepth: 2.5 };
  const mark = fns.buildSessionStartFromAction(action, rodSetups, ctx, { tideCondition: "Rising", tideExtreme: "HHW" });
  assert.equal(mark.name, "Session 3 Start");
  assert.equal(mark.type, "Session Start");
  assert.equal(mark.sessionRole, "start");
  assert.equal(mark.sessionGroupId, "g1");
  assert.equal(mark.species, "Bream, Whiting");
  assert.equal(mark.fishingMethod, "Lure");
  assert.equal(mark.berley, "Pilchard");
  assert.equal(mark.bait, "Prawn");
  assert.equal(mark.rod, "Light, Heavy");
  assert.equal(mark.rig, "Soft plastic rig"); // de-duplicated
  assert.equal(mark.rigOptions, "Vibe, Paddle Tail");
  assert.equal(mark.waterDepth, 2.5);
  assert.equal(mark.waterCondition, "Clear");
  assert.equal(mark.tideCondition, "Rising");
  assert.equal(mark.tideExtreme, "HHW");
});

test("buildSessionStartFromAction leaves off everything an Action doesn't set", () => {
  const mark = fns.buildSessionStartFromAction({}, [], { id: "m", lat: 0, lng: 0, dateTime: "d", createdAt: "d", sessionGroupId: "g", sessionNumber: 1, waterDepth: null }, {});
  for (const key of ["species", "fishingMethod", "berley", "bait", "rod", "rig", "rigOptions", "waterDepth", "waterCondition", "tideCondition"]) assert.equal(key in mark, false, key);
});

test("tdOtherTargets lists the trip's other actions' species, without the action's own or duplicates", () => {
  const a1 = { id: "1", tripId: "t", species: ["Bream", "Whiting"] };
  const actions = [a1, { id: "2", tripId: "t", species: ["Whiting", "Flathead"] }, { id: "3", tripId: "t", species: ["Flathead", "Salmon"] }, { id: "4", tripId: "other", species: ["Snapper"] }];
  assert.deepEqual(fns.tdOtherTargets(actions, a1), ["Flathead", "Salmon"]);
});

test("tdCatchFieldsFromAction takes gear from the Action and the chosen (or only) rod setup", () => {
  const setups = [
    { id: "a", rod: "Light", rig: "Paternoster", subListItems: ["Vibe"] },
    { id: "b", rod: "Heavy", rig: "Running sinker", subListItems: [] },
  ];
  const action = { rodSetupIds: ["a", "b"], berley: "Pilchard", bait: ["Prawn", "Squid"], fishingMethod: ["Bait"] };
  assert.deepEqual(fns.tdCatchFieldsFromAction(action, setups, "b"), { berley: "Pilchard", fishingMethod: "Bait", bait: "Prawn, Squid", rod: "Heavy", rig: "Running sinker" });
  // several setups and none chosen: no rod fields guessed
  assert.deepEqual(fns.tdCatchFieldsFromAction(action, setups, null), { berley: "Pilchard", fishingMethod: "Bait", bait: "Prawn, Squid" });
  // one setup: used without being chosen
  assert.equal(fns.tdCatchFieldsFromAction({ rodSetupIds: ["a"] }, setups, null).rigOptions, "Vibe");
});
