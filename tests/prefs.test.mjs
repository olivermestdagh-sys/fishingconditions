// The client-side rules for merging a device's saved settings with the signed-in account's (js/prefs.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../js/prefs.js", import.meta.url), "utf8");
const grab = (re) => {
  const m = src.match(re);
  if (!m) throw new Error("could not find in js/prefs.js: " + re);
  return m[0];
};
const { prefsMergePlan, SYNCED_PREF_KEYS } = new Function(
  [
    grab(/const SYNCED_PREF_KEYS = \[[\s\S]*?\];\r?\n/),
    grab(/function prefsMergePlan[\s\S]*?\r?\n}\r?\n/),
    "return { prefsMergePlan, SYNCED_PREF_KEYS };",
  ].join("\n")
)();

const PINS = "goodConditionsPinnedLocationsNew";
const LOC = "selectedLocation";
const plan = (o) => prefsMergePlan({ server: {}, local: {}, owner: null, userId: "u1", pending: [], ...o });

test("the account's value wins over the device's", () => {
  const p = plan({ server: { [PINS]: '["Flinders"]' }, local: { [PINS]: '["Rye"]' } });
  assert.deepEqual(p.toLocal, { [PINS]: '["Flinders"]' });
  assert.deepEqual(p.toServer, {});
});

test("a setting only the device has is uploaded once", () => {
  const p = plan({ server: { [PINS]: '["Flinders"]' }, local: { [PINS]: '["Flinders"]', [LOC]: "Rye|Kayak" } });
  assert.deepEqual(p.toServer, { [LOC]: "Rye|Kayak" });
  assert.deepEqual(p.toLocal, {}); // identical values need no local write
});

test("a setting only the account has is copied to the device", () => {
  const p = plan({ server: { [LOC]: "Cowes|Kayak" }, local: {} });
  assert.deepEqual(p.toLocal, { [LOC]: "Cowes|Kayak" });
  assert.deepEqual(p.toServer, {});
});

test("a change made here that hasn't been sent yet wins over the account's value", () => {
  const p = plan({ server: { [PINS]: '["Old"]' }, local: { [PINS]: '["New"]' }, owner: "u1", pending: [PINS] });
  assert.deepEqual(p.toServer, { [PINS]: '["New"]' });
  assert.deepEqual(p.toLocal, {});
});

test("a pending removal goes up as a removal", () => {
  const p = plan({ server: { [LOC]: "Old|Kayak" }, local: {}, owner: "u1", pending: [LOC] });
  assert.deepEqual(p.toServer, { [LOC]: null });
  assert.deepEqual(p.toLocal, {});
});

test("a different person signing in on this device never inherits or uploads the previous person's settings", () => {
  const p = plan({ server: { [LOC]: "Theirs|Kayak" }, local: { [PINS]: '["Mine"]', [LOC]: "Mine|Kayak" }, owner: "u2", userId: "u1", pending: [PINS] });
  assert.deepEqual(p.clearLocal.sort(), [LOC, PINS].sort()); // the other person's values are cleared
  assert.deepEqual(p.toServer, {}); // nothing of theirs is uploaded, pending or not
  assert.deepEqual(p.toLocal, { [LOC]: "Theirs|Kayak" }); // and the account's own value is used
});

test("a device that has never been synced (no owner) keeps its values and uploads what the account lacks", () => {
  const p = plan({ server: {}, local: { [PINS]: '["A"]' }, owner: null });
  assert.deepEqual(p.toServer, { [PINS]: '["A"]' });
  assert.deepEqual(p.clearLocal, []);
});

test("only the listed settings are ever considered", () => {
  const p = plan({ server: { somethingElse: "x", mapView: "y" }, local: { somethingElse: "z" } });
  assert.deepEqual(p.toLocal, {});
  assert.deepEqual(p.toServer, {});
  assert.ok(!SYNCED_PREF_KEYS.includes("goodConditionsLocationMapView"), "map position/zoom stays per device");
});

test("the client and Worker agree on which settings sync", () => {
  const worker = fs.readFileSync(new URL("../user-backend.js", import.meta.url), "utf8");
  const block = worker.match(/const SYNCED_PREF_KEYS = new Set\(\[([\s\S]*?)\]\);/)[1];
  const workerKeys = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...workerKeys].sort(), [...SYNCED_PREF_KEYS].sort());
});
