// locationVisibleToViewer (js/backend.js): the Map, Week Ahead, Live and nearest-location look-ups show Public's
// locations plus the signed-in person's own — never another account's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSharedScripts } from "./helpers.mjs";

const src = readSharedScripts();
const fnSrc = src.match(/function locationVisibleToViewer\([\s\S]*?\r?\n}\r?\n/);
assert.ok(fnSrc, "locationVisibleToViewer not found in js/*.js");
// cachedUserId is a free variable inside the function — a factory parameter stands in for the page's global.
const visibleFor = (cachedUserId) => new Function("cachedUserId", `${fnSrc[0]}\nreturn locationVisibleToViewer;`)(cachedUserId);

const locs = [{ ownerId: "public" }, { ownerId: "me" }, { ownerId: "someone-else" }, {}];

test("signed in: Public's, their own, and any with no owner recorded (an older data file)", () => {
  assert.deepEqual(locs.map(visibleFor("me")), [true, true, false, true]);
});

test("signed out: Public's only — nobody's own locations", () => {
  assert.deepEqual(locs.map(visibleFor(null)), [true, false, false, true]);
});
