// Pure helpers of js/trip-session.js (the Trip tab's trip state machine).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../js/trip-session.js", import.meta.url), "utf8");
const lib = new Function(
  `${src}; return { nextCycleValue, tsStartTripState, tsStartActionState, tsEndActionState, tsActiveSession, tsCatchDefaultsForAction, tsElapsedText };`
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
