// Live mode quick-entry cards: the pure helpers in js/live-cards.js (defaults, card steps, the Catch mark).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../js/live-cards.js", import.meta.url), "utf8");
// Everything above the DOM section is pure; evaluate just that part.
const pure = src.slice(0, src.indexOf("// --- DOM:"));
const fns = new Function(
  pure + "\nreturn { catchSizeOptions, normaliseSessionDefaults, markListValues, sessionCardOptions, buildSessionCardSteps, applySessionCardChoice, buildCatchCardSteps, buildCatchFromCards, emptySessionDefaults };"
)();

const lists = [
  { field: "Species", value: "Bream" }, { field: "Species", value: "Whiting" }, { field: "Species", value: "Bream" },
  { field: "Water Condition", value: "Clear" }, { field: "Berley", value: "Pilchard" },
  { field: "Rod", value: "Light" }, { field: "Rod", value: "Heavy" },
  { field: "Rig", value: "Running sinker" }, { field: "Rig", value: "Paternoster" },
  { field: "Bait", value: "Prawn" }, { field: "Bait", value: "Squid" },
];
const options = fns.sessionCardOptions(lists);

test("size buttons run 20 to 40 cm", () => {
  const sizes = fns.catchSizeOptions();
  assert.equal(sizes[0], 20);
  assert.equal(sizes[sizes.length - 1], 40);
  assert.equal(sizes.length, 21);
});

test("option lists come from the mark list rows, in order, without duplicates", () => {
  assert.deepEqual(options.species, ["Bream", "Whiting"]);
  assert.deepEqual(options.rods, ["Light", "Heavy"]);
  assert.deepEqual(options.water, ["Clear"]);
});

test("normalise copes with garbage and drops values the lists no longer offer", () => {
  assert.deepEqual(fns.normaliseSessionDefaults("not json"), fns.emptySessionDefaults());
  assert.deepEqual(fns.normaliseSessionDefaults(null), fns.emptySessionDefaults());
  assert.deepEqual(fns.normaliseSessionDefaults([1, 2]), fns.emptySessionDefaults());
  const raw = JSON.stringify({
    species: ["Bream", "Gone", "Bream"], water: "Muddy", berley: "Pilchard", rods: ["Light", "Retired"],
    rodSetups: { Light: { rig: "Paternoster", bait: "Nope" }, Retired: { rig: "Paternoster", bait: "Prawn" } },
  });
  assert.deepEqual(fns.normaliseSessionDefaults(raw, options), {
    species: ["Bream"], water: "", berley: "Pilchard", rods: ["Light"], rodSetups: { Light: { rig: "Paternoster", bait: "" } },
  });
  // With no lists loaded nothing is pruned
  assert.deepEqual(fns.normaliseSessionDefaults(raw).species, ["Bream", "Gone"]);
});

test("session cards: species, water, berley, rods, then a rig and a bait card per rod", () => {
  let draft = fns.emptySessionDefaults();
  assert.deepEqual(fns.buildSessionCardSteps(options, draft).map((s) => s.id), ["species", "water", "berley", "rods"]);
  draft = fns.applySessionCardChoice(draft, "rods", "Light");
  draft = fns.applySessionCardChoice(draft, "rods", "Heavy");
  const steps = fns.buildSessionCardSteps(options, draft);
  assert.deepEqual(steps.map((s) => s.id), ["species", "water", "berley", "rods", "rig:Light", "bait:Light", "rig:Heavy", "bait:Heavy"]);
  assert.equal(steps[4].title, "Light");
  assert.deepEqual(steps[4].options, options.rigs);
  assert.deepEqual(steps[5].options, options.baits);
});

test("choices: species and rods toggle, water/berley/rig/bait are single and clear on a second press", () => {
  let d = fns.emptySessionDefaults();
  d = fns.applySessionCardChoice(d, "species", "Bream");
  d = fns.applySessionCardChoice(d, "species", "Whiting");
  d = fns.applySessionCardChoice(d, "species", "Bream");
  assert.deepEqual(d.species, ["Whiting"]);
  d = fns.applySessionCardChoice(d, "water", "Clear");
  assert.equal(d.water, "Clear");
  d = fns.applySessionCardChoice(d, "water", "Clear");
  assert.equal(d.water, "");
  d = fns.applySessionCardChoice(d, "rods", "Light");
  d = fns.applySessionCardChoice(d, "rig:Light", "Paternoster");
  d = fns.applySessionCardChoice(d, "bait:Light", "Prawn");
  assert.deepEqual(d.rodSetups.Light, { rig: "Paternoster", bait: "Prawn" });
  d = fns.applySessionCardChoice(d, "bait:Light", "Squid");
  assert.equal(d.rodSetups.Light.bait, "Squid");
});

test("deselecting a rod discards its rig and bait; the input draft is never mutated", () => {
  let d = fns.applySessionCardChoice(fns.emptySessionDefaults(), "rods", "Light");
  d = fns.applySessionCardChoice(d, "rig:Light", "Paternoster");
  const before = JSON.stringify(d);
  const after = fns.applySessionCardChoice(d, "rods", "Light");
  assert.equal(JSON.stringify(d), before);
  assert.deepEqual(after.rods, []);
  assert.deepEqual(after.rodSetups, {});
});

test("catch cards: only target species and session rods; fall back to the full lists with a hint", () => {
  const defaults = { ...fns.emptySessionDefaults(), species: ["Whiting"], rods: ["Heavy"], rodSetups: { Heavy: { rig: "", bait: "" } } };
  const steps = fns.buildCatchCardSteps(options, defaults);
  assert.deepEqual(steps.map((s) => s.id), ["species", "size", "rod"]);
  assert.deepEqual(steps[0].options, ["Whiting"]);
  assert.deepEqual(steps[2].options, ["Heavy"]);
  assert.ok(steps.every((s) => s.required));
  const fallback = fns.buildCatchCardSteps(options, fns.emptySessionDefaults());
  assert.deepEqual(fallback[0].options, options.species);
  assert.ok(fallback[0].hint);
});

test("catch mark: type Catch, rig/bait from the rod, water and berley from the session, size a number", () => {
  const defaults = {
    species: ["Bream"], water: "Clear", berley: "Pilchard", rods: ["Light"],
    rodSetups: { Light: { rig: "Paternoster", bait: "Prawn" } },
  };
  const m = fns.buildCatchFromCards(
    { id: "m_1", lat: -33.9, lng: 151.2, dateTime: "2026-09-22 06:30:00", species: "Bream", size: "27", rod: "Light" },
    defaults,
    { tideCondition: "Running In", tideExtreme: "HHW" }
  );
  assert.deepEqual(m, {
    id: "m_1", lat: -33.9, lng: 151.2, name: "Bream", type: "Catch", dateTime: "2026-09-22 06:30:00", createdAt: "2026-09-22 06:30:00",
    source: "Manual", species: "Bream", size: 27, rod: "Light", rig: "Paternoster", bait: "Prawn",
    waterCondition: "Clear", berley: "Pilchard", tideCondition: "Running In", tideExtreme: "HHW",
  });
});

test("catch mark leaves unset fields off", () => {
  const m = fns.buildCatchFromCards({ id: "m_2", lat: 1, lng: 2, dateTime: "d", species: "Bream", size: "", rod: "" }, fns.emptySessionDefaults(), {});
  for (const k of ["size", "rod", "rig", "bait", "waterCondition", "berley", "tideCondition", "tideExtreme"]) assert.ok(!(k in m), k);
});
