// Map > Trip Defaults: the pure helpers in js/trip-defaults.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../js/trip-defaults.js", import.meta.url), "utf8");
const pure = src.slice(0, src.indexOf("// --- Backend"));
const fns = new Function(pure + "\nreturn { tdToggle, tdToggleSingle, tdRigSublist, tdActionsForTrip, tdLiveRodSetupIds, tdDefaultName };")();

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

test("tdDefaultName picks the first unused 'New x' name, ignoring case", () => {
  assert.equal(fns.tdDefaultName("New trip", []), "New trip");
  assert.equal(fns.tdDefaultName("New trip", ["New trip"]), "New trip 2");
  assert.equal(fns.tdDefaultName("New trip", ["new trip", "New trip 2"]), "New trip 3");
});
