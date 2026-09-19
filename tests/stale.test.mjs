// Tests for the header "Updated ..." stamp's stale-data warning (js/*.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSharedScripts } from "./helpers.mjs";

const src = readSharedScripts();
const m = src.match(/const STALE_DATA_HOURS[\s\S]*?\r?\nfunction setUpdatedStamp[\s\S]*?\r?\n}\r?\n/);
assert.ok(m, "setUpdatedStamp not found in js/*.js");
const setUpdatedStamp = new Function(m[0] + "\nreturn setUpdatedStamp;")();

function fakeEl() {
  const classes = new Set();
  return {
    textContent: "",
    title: "",
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), has: (c) => classes.has(c) },
    removeAttribute() { this.title = ""; },
  };
}
const hoursAgo = (h) => new Date(Date.now() - h * 3600000);

test("fresh data shows a plain Updated stamp", () => {
  const el = fakeEl();
  setUpdatedStamp(el, hoursAgo(2));
  assert.match(el.textContent, /^Updated /);
  assert.equal(el.classList.has("stale"), false);
});
test("data over 12 hours old is flagged stale with its age", () => {
  const el = fakeEl();
  setUpdatedStamp(el, hoursAgo(20));
  assert.match(el.textContent, /^⚠ Data is 20 h old/);
  assert.equal(el.classList.has("stale"), true);
});
test("very old data is described in days", () => {
  const el = fakeEl();
  setUpdatedStamp(el, hoursAgo(72));
  assert.match(el.textContent, /3 days old/);
});
test("a refresh clears the stale flag", () => {
  const el = fakeEl();
  setUpdatedStamp(el, hoursAgo(30));
  setUpdatedStamp(el, hoursAgo(1));
  assert.equal(el.classList.has("stale"), false);
  assert.match(el.textContent, /^Updated /);
});
