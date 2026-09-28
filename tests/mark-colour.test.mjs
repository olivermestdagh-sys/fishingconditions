// Mark pin colours (markStyleFor, js/marks-core.js): a Session Start/End takes its Mark Type's colour, not its target species'.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const core = read("../js/marks-core.js");
const layer = read("../js/marks-layer.js");
const grab = (src, re) => {
  const m = re.exec(src);
  assert.ok(m, `not found: ${re}`);
  return m[0];
};
const code = [
  grab(core, /const SESSION_TYPE_ROLES[^\n]*\n/),
  grab(core, /function isSessionType[\s\S]*?\n}\n/),
  grab(core, /function hashStringToHue[\s\S]*?\n}\n/),
  grab(core, /const MARK_NO_VALUE_STYLE[^\n]*\n/),
  grab(core, /function markStyleFor[\s\S]*?\n}\n/),
  grab(layer, /function resolveMarkColorFormat[\s\S]*?\n}\n/),
  grab(layer, /function resolveColorFormatForFieldValue[\s\S]*?\n}\n/),
  "const MARK_LIST_FIELDS = [{ key: 'species', label: 'Species' }, { key: 'type', label: 'Mark Type' }, { key: 'bait', label: 'Bait' }];",
].join("\n");
const { markStyleFor } = new Function(`${code}\nreturn { markStyleFor };`)();

const lists = [
  { field: "Mark Colour Format", value: "Green", color: "#00ff00" },
  { field: "Mark Colour Format", value: "Red", color: "#ff0000" },
  { field: "Mark Colour Format", value: "White", color: "#ffffff" },
  { field: "Mark Type", value: "Catch", colorFormat: "White" },
  { field: "Mark Type", value: "Session Start", colorFormat: "Green" },
  { field: "Mark Type", value: "Session End", colorFormat: "Red" },
  { field: "Species", value: "Snapper", colorFormat: "Red" },
  { field: "Species", value: "Squid", colorFormat: "Green" },
];
const bySpecies = { groupByKey: "species", markLists: lists };

test("a Catch is coloured by its species, falling back to its Mark Type", () => {
  assert.equal(markStyleFor({ type: "Catch", species: "Snapper" }, bySpecies).fillColor, "#ff0000");
  assert.equal(markStyleFor({ type: "Catch", species: "Unlisted" }, bySpecies).fillColor, "#ffffff");
});

test("a Session Start/End takes its Mark Type's colour even when its target species has a colour of its own", () => {
  // Squid is Green and Snapper Red: neither may recolour the sessions.
  assert.equal(markStyleFor({ type: "Session Start", species: "Squid" }, bySpecies).fillColor, "#00ff00");
  assert.equal(markStyleFor({ type: "Session End", species: "Squid" }, bySpecies).fillColor, "#ff0000");
  assert.equal(markStyleFor({ type: "Session Start", species: "Snapper" }, bySpecies).fillColor, "#00ff00");
  // and a session with no species at all is no longer left grey
  assert.equal(markStyleFor({ type: "Session End" }, bySpecies).fillColor, "#ff0000");
});

test("colouring by another field leaves sessions alone", () => {
  const byBait = { groupByKey: "bait", markLists: lists };
  assert.deepEqual(markStyleFor({ type: "Session Start", species: "Squid" }, byBait), markStyleFor({ type: "Catch" }, byBait));
});
