// Pure helpers of js/trip-session.js (the Trip tab's trip state machine).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../js/trip-session.js", import.meta.url), "utf8");
const lib = new Function(
  `${src}; return { nextCycleValue, tsStartTripState, tsStartActionState, tsEndActionState, tsActiveSession, tsCatchDefaultsForAction, tsElapsedText, tsSwapRodSlots, tsRodCell, tsQuickEditKind, tsToggleOrdered };`
)();
globalThis.tdLiveRodSetupIds = (ids) => ids || [];
globalThis.tdOtherTargets = () => ["Bream"];

test("nextCycleValue goes through the options then back to none", () => {
  assert.equal(lib.nextCycleValue(["a", "b"], ""), "a");
  assert.equal(lib.nextCycleValue(["a", "b"], "a"), "b");
  assert.equal(lib.nextCycleValue(["a", "b"], "b"), "");
  assert.equal(lib.nextCycleValue([], "x"), "");
});

test("starting actions counts the run's actions from 1 and keeps the run id", () => {
  const t = lib.tsStartTripState({ id: "t1" }, "run_1");
  assert.deepEqual(t, { tripId: "t1", runId: "run_1" });
  const a1 = lib.tsStartActionState(t, "a1", "g1");
  assert.deepEqual(a1, { tripId: "t1", actionId: "a1", sessionGroupId: "g1", runId: "run_1", sessionNumber: 1 });
  const a2 = lib.tsStartActionState(a1, "a2", "g2"); // starting another ends the first implicitly
  assert.equal(a2.sessionNumber, 2);
  assert.equal(a2.actionId, "a2");
});

test("ending an action keeps the trip, run and count but no action", () => {
  const a1 = lib.tsStartActionState(lib.tsStartTripState({ id: "t1" }, "run_1"), "a1", "g1");
  const ended = lib.tsEndActionState(a1);
  assert.deepEqual(ended, { tripId: "t1", runId: "run_1", sessionNumber: 1 });
  assert.equal(lib.tsActiveSession(ended), null);
  assert.deepEqual(lib.tsActiveSession(a1), { actionId: "a1", sessionGroupId: "g1", number: 1 });
  assert.equal(lib.tsActiveSession(null), null);
});

test("catch defaults skip the rod card for one setup and list names for several", () => {
  const data = { actions: [], rodSetups: [{ id: "r1", name: "A", bait: ["Squid"] }, { id: "r2", name: "B", bait: ["Squid", "Prawn"] }] };
  const one = lib.tsCatchDefaultsForAction(data, { rodSetupIds: ["r1"], species: ["Flathead"] }, "Calm");
  assert.equal(one.skipRod, true);
  assert.deepEqual(one.rods, []);
  assert.equal(one.water, "Calm");
  const two = lib.tsCatchDefaultsForAction(data, { rodSetupIds: ["r1", "r2"] }, "");
  assert.deepEqual(two.rods, ["A", "B"]);
  assert.deepEqual(two.bait, ["Squid", "Prawn"]);
});

test("elapsed text", () => {
  assert.equal(lib.tsElapsedText(0, 42 * 60000 + 10000), "42:10");
  assert.equal(lib.tsElapsedText(0, 3725000), "1:02:05");
  assert.equal(lib.tsElapsedText(5000, 1000), "0:00");
});

test("rod positions: an empty target takes the setup, a taken one swaps, bad indexes change nothing", () => {
  assert.deepEqual(lib.tsSwapRodSlots(["a", null, "b", null], 0, 1), [null, "a", "b", null]);
  assert.deepEqual(lib.tsSwapRodSlots(["a", "c", "b", null], 0, 2), ["b", "c", "a", null]);
  assert.deepEqual(lib.tsSwapRodSlots(["a", null, null, null], 0, 0), ["a", null, null, null]);
  assert.deepEqual(lib.tsSwapRodSlots(["a", null, null, null], 0, 9), ["a", null, null, null]);
});

test("a rod position shows name, bait with options, and rig options else the rig", () => {
  assert.deepEqual(lib.tsRodCell({ name: "R1", bait: ["Squid", "Prawn"], baitOptions: ["Fresh"], subListItems: ["8lb"], rig: "Paternoster" }), { name: "R1", bait: "Squid, Prawn (Fresh)", rig: "8lb" });
  assert.deepEqual(lib.tsRodCell({ name: "R2", rig: "Running sinker" }), { name: "R2", bait: "no bait", rig: "Running sinker" });
});

test("a catch from a rod position defaults from that rod setup only and skips the rod question", () => {
  const data = { actions: [], rodSetups: [{ id: "r1", name: "A", bait: ["Squid"], baitOptions: ["Fresh"] }, { id: "r2", name: "B", bait: ["Prawn"] }] };
  const d = lib.tsCatchDefaultsForAction(data, { rodSetupIds: ["r1", "r2"] }, "", "r2");
  assert.equal(d.forcedRod.id, "r2");
  assert.equal(d.skipRod, true);
  assert.deepEqual(d.bait, ["Prawn"]);
});

test("tapping a rod edits its bait when it has bait, else its rig option, else nothing", () => {
  assert.equal(lib.tsQuickEditKind({ bait: ["Squid"] }, ["8lb"]), "bait");
  assert.equal(lib.tsQuickEditKind({ bait: [] }, ["8lb"]), "sublist");
  assert.equal(lib.tsQuickEditKind({}, []), null);
});

test("tsToggleOrdered keeps list order", () => {
  assert.deepEqual(lib.tsToggleOrdered(["b"], "a", ["a", "b", "c"]), ["a", "b"]);
  assert.deepEqual(lib.tsToggleOrdered(["a", "b"], "a", ["a", "b", "c"]), ["b"]);
});
