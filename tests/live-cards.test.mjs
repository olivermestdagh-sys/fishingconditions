// Live mode quick-entry cards: the pure helpers in js/live-cards.js (defaults, card steps, the Catch mark).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../js/live-cards.js", import.meta.url), "utf8");
const limitsSrc = fs.readFileSync(new URL("../js/catch-limits.js", import.meta.url), "utf8"); // live-cards uses its rules (loaded first on the page)
// Everything above the DOM section is pure; evaluate just that part.
const pure = src.slice(0, src.indexOf("// --- DOM:"));
const fns = new Function(
  limitsSrc + "\n" + pure + "\nreturn { normaliseSessionDefaults, markListValues, sessionCardOptions, buildSessionCardSteps, applySessionCardChoice, buildCatchCardSteps, buildCatchFromCards, emptySessionDefaults, applySizeAction, catchCardState, sizeVerdictText, catchSavedMessage, speciesSublabels, speciesImagesFromMarkLists, allSpeciesImages };"
)();

const lists = [
  { field: "Species", value: "Bream" }, { field: "Species", value: "Whiting" }, { field: "Species", value: "Bream" },
  { field: "Water Condition", value: "Clear" }, { field: "Berley", value: "Pilchard" },
  { field: "Rod", value: "Light" }, { field: "Rod", value: "Heavy" },
  { field: "Rig", value: "Running sinker" }, { field: "Rig", value: "Paternoster" },
  { field: "Bait", value: "Prawn" }, { field: "Bait", value: "Squid" },
];
const options = fns.sessionCardOptions(lists);

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
  assert.deepEqual(steps.map((s) => s.id), ["species", "size", "fate", "rod"]);
  // targets first, then a divider position, then every other species
  assert.deepEqual(steps[0].options, ["Whiting", "Bream"]);
  assert.equal(steps[0].dividerAfter, 1);
  assert.deepEqual(steps[3].options, ["Heavy"]);
  assert.ok([steps[0], steps[2], steps[3]].every((s) => s.required), "species, keep/release and rod need an answer; the stepper always has a value");
  assert.equal(steps[1].kind, "stepper");
  const fallback = fns.buildCatchCardSteps(options, fns.emptySessionDefaults());
  assert.deepEqual(fallback[0].options, options.species);
  assert.equal(fallback[0].dividerAfter, 0);
  assert.ok(fallback[0].hint);
  const allTargets = fns.buildCatchCardSteps(options, { ...fns.emptySessionDefaults(), species: ["Bream", "Whiting"] });
  assert.equal(allTargets[0].dividerAfter, 0, "no divider when every species is a target");
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

// --- limits in the Catch flow -------------------------------------------------------------------------------
const H = 3600000;
const T0 = Date.UTC(2026, 8, 22, 6, 0, 0);
const limitLists = [
  { field: "Species", value: "Snapper", minSize: 28, maxQty: 10, bigSize: 40, bigMaxQty: 3 },
  { field: "Species", value: "Shark (School)", minSize: 45, maxQty: 2, qtyGroup: "G" },
  { field: "Species", value: "Shark (Gummy)", minSize: 45, maxQty: 2, qtyGroup: "G" },
  { field: "Species", value: "Elephant Fish" },
  { field: "Rod", value: "Light" },
];
const lopts = fns.sessionCardOptions(limitLists);
const ldefaults = { ...fns.emptySessionDefaults(), species: ["Snapper"], rods: ["Light"], rodSetups: { Light: { rig: "", bait: "" } } };
const kept = (id, species, hours, size = null, released = false) => ({ id, species, size, released, tMs: T0 + hours * H });
const lrun = [kept("1", "Snapper", 0, 41), kept("2", "Snapper", 1, 30), kept("3", "Shark (School)", 2)];
const stepsFor = (answers, run = lrun) => fns.buildCatchCardSteps(lopts, ldefaults, { answers, run, catches: run });
const byId = (steps, id) => steps.find((s) => s.id === id);

test("size stepper actions: steps from where it starts, never below 0, Too small toggles", () => {
  assert.equal(fns.applySizeAction(undefined, "delta:5", 28), 33);
  assert.equal(fns.applySizeAction(33, "delta:-1", 28), 32);
  assert.equal(fns.applySizeAction(3, "delta:-10", 28), 0);
  assert.equal(fns.applySizeAction(33.5, "delta:1", 28), 34.5);
  assert.equal(fns.applySizeAction(33, "tooSmall", 28), "small");
  assert.equal(fns.applySizeAction("small", "tooSmall", 28), undefined, "pressing Too small again undoes it");
  assert.equal(fns.applySizeAction("small", "delta:1", 28), 29, "stepping after Too small goes numeric from the start size");
  assert.equal(fns.applySizeAction(33, "nonsense", 28), 33);
});

test("tens and ones buttons set that part of the size and keep the other", () => {
  assert.equal(fns.applySizeAction(38, "tens:4", 30), 48);
  assert.equal(fns.applySizeAction(38, "tens:12", 30), 128, "12 tens = 120 cm");
  assert.equal(fns.applySizeAction(38, "tens:10", 30), 108);
  assert.equal(fns.applySizeAction(38, "ones:5", 30), 35);
  assert.equal(fns.applySizeAction(128, "ones:0", 30), 120);
  assert.equal(fns.applySizeAction(undefined, "ones:5", 28), 25, "untouched: works from the start size");
  assert.equal(fns.applySizeAction(undefined, "tens:4", 28), 48, "the ones digit of the start size is kept");
  assert.equal(fns.applySizeAction("small", "tens:4", 28), 48, "after Too small it goes numeric from the start size");
  assert.equal(fns.applySizeAction(33.5, "ones:9", 28), 39, "the digit buttons work in whole cm");
  assert.equal(fns.applySizeAction(38, "tens:", 30), 38, "malformed actions are ignored");
  assert.equal(fns.applySizeAction(38, "ones:12", 30), 38);
  assert.equal(fns.applySizeAction(38, "digit:10:4", 30), 38, "the old hundreds/tens/ones action no longer exists");
});
test("the stepper starts at the min size and shows its verdict; Too small removes the keep/release card", () => {
  const steps = stepsFor({ species: "Snapper" }, []);
  const size = byId(steps, "size");
  assert.equal(size.value, 28, "no earlier size for this species: starts at its Min Size");
  assert.equal(size.minSize, 28);
  assert.equal(size.verdict.text, "Legal size");
  assert.ok(byId(steps, "fate"));
  const small = stepsFor({ species: "Snapper", size: "small" });
  assert.equal(byId(small, "size").tooSmall, true);
  assert.equal(byId(small, "size").value, null);
  assert.equal(byId(small, "fate"), undefined, "Too small decides Release itself");
  assert.deepEqual(small.map((s) => s.id), ["species", "size", "rod"]);
});

test("with no Min Size set, the stepper starts at 20", () => {
  assert.equal(byId(stepsFor({ species: "Elephant Fish" }, []), "size").value, 20);
});

test("verdict text: too small, over slot, big, legal, nothing when no limits", () => {
  const lim = { minSize: 28, maxSize: 60, bigSize: 40 };
  assert.match(fns.sizeVerdictText(lim, 20).text, /Under the minimum size \(28 cm\)/);
  assert.equal(fns.sizeVerdictText(lim, 20).tone, "bad");
  assert.match(fns.sizeVerdictText(lim, 61).text, /Over the maximum size \(60 cm\)/);
  assert.deepEqual(fns.sizeVerdictText(lim, 45), { text: "Big fish", tone: "big" });
  assert.deepEqual(fns.sizeVerdictText(lim, 30), { text: "Legal size", tone: "ok" });
  assert.deepEqual(fns.sizeVerdictText(undefined, 30), { text: "", tone: "" });
  assert.deepEqual(fns.sizeVerdictText({ maxQty: 5 }, 30), { text: "", tone: "" });
});

test("keep/release card: recommendation pre-selected with its reason, the person can override", () => {
  let fate = byId(stepsFor({ species: "Snapper", size: 35 }), "fate");
  assert.deepEqual(fate.selected, ["Keep"]);
  assert.match(fate.hint, /makes 3 of 10/);
  assert.equal(fate.sublabels.Keep.line1, "Recommended");
  fate = byId(stepsFor({ species: "Snapper", size: 35, fate: "Release" }), "fate");
  assert.deepEqual(fate.selected, ["Release"], "an override is kept");
  const bag = Array.from({ length: 10 }, (_, i) => kept(`b${i}`, "Snapper", i * 0.1, 30));
  fate = byId(stepsFor({ species: "Snapper", size: 35 }, bag), "fate");
  assert.deepEqual(fate.selected, ["Release"]);
  assert.match(fate.hint, /Bag full: 10 of 10 kept/);
  fate = byId(stepsFor({ species: "Snapper", size: 20 }), "fate");
  assert.deepEqual(fate.selected, ["Release"], "under the minimum size");
});

test("species cards show limits and how many are kept, once the run is known", () => {
  const species = byId(stepsFor({}), "species");
  assert.deepEqual(species.sublabels.Snapper, { line1: "Min 28 cm · Max qty 10 · Big 40+ cm (3)", line2: "Kept 2/10 · big 1/3", tone: "" });
  assert.equal(species.sublabels["Shark (School)"].line2, "Kept 1/2 (shared with Shark (Gummy))");
  assert.equal(species.sublabels["Shark (School)"].tone, "", "shared quantity: no frame colour");
  assert.equal(species.sublabels["Elephant Fish"], undefined, "no limits and nothing to say");
  const unknown = byId(fns.buildCatchCardSteps(lopts, ldefaults, { answers: {}, run: null }), "species");
  assert.equal(unknown.sublabels.Snapper.line2, "", "before the marks load: limits only");
  const session = fns.buildSessionCardSteps(lopts, fns.emptySessionDefaults(), { run: lrun });
  assert.equal(session[0].sublabels.Snapper.line2, "Kept 2/10 · big 1/3", "the same blurb while choosing targets");
});

test("selecting the species starts the size and keep/release answers again in the flow's state reading", () => {
  const st = fns.catchCardState(lopts, { answers: { species: "Snapper", size: 44 }, run: lrun, catches: lrun });
  assert.equal(st.size, 44);
  assert.equal(st.fate, "Keep");
  assert.equal(st.released, false);
  const undecided = fns.catchCardState(lopts, { answers: { species: "Snapper" }, run: lrun, catches: lrun });
  assert.equal(undecided.size, 28, "untouched stepper means its start value: Snapper's Min Size");
  const small = fns.catchCardState(lopts, { answers: { species: "Snapper", size: "small", fate: "Keep" }, run: lrun, catches: lrun });
  assert.deepEqual([small.tooSmall, small.released, small.fate], [true, true, "Release"], "Too small always releases");
});

test("catch mark: released fish, and Too small (no size, a note, released)", () => {
  const base = { id: "m_9", lat: 1, lng: 2, dateTime: "d", species: "Snapper", rod: "" };
  const kept1 = fns.buildCatchFromCards({ ...base, size: 35, released: false }, fns.emptySessionDefaults(), {});
  assert.ok(!("released" in kept1));
  assert.equal(kept1.size, 35);
  const rel = fns.buildCatchFromCards({ ...base, size: 35, released: true }, fns.emptySessionDefaults(), {});
  assert.equal(rel.released, true);
  assert.equal(rel.size, 35);
  const small = fns.buildCatchFromCards({ ...base, size: null, tooSmall: true, released: true }, fns.emptySessionDefaults(), {});
  assert.equal(small.released, true);
  assert.equal(small.notes, "Too small");
  assert.ok(!("size" in small));
});

test("saved-catch message says what happened and where the bag stands", () => {
  const lim = { maxQty: 10 };
  assert.equal(fns.catchSavedMessage({ species: "Snapper", tooSmall: true, released: true, lim }, null), "Snapper: too small, released");
  assert.equal(fns.catchSavedMessage({ species: "Snapper", tooSmall: false, released: true, lim }, null), "Snapper released");
  assert.equal(fns.catchSavedMessage({ species: "Snapper", tooSmall: false, released: false, lim }, { kept: 3 }), "Snapper kept: 3 of 10 in this run");
  assert.equal(fns.catchSavedMessage({ species: "Bream", tooSmall: false, released: false, lim: {} }, { kept: 2 }), "Bream kept: 2 in this run");
  assert.equal(fns.catchSavedMessage({ species: "Bream", tooSmall: false, released: false, lim: {} }, null), "Bream kept");
});

// --- species pictures ("Select by image" on the Catch species card) ---------------------------------------------------
const imageLists = [
  ...limitLists,
  { field: "Species", value: "Bream" }, // no images
];
imageLists.find((r) => r.value === "Snapper").images = [{ id: "img-1", version: 10 }, { id: "img-2", version: 20 }];
imageLists.find((r) => r.value === "Shark (Gummy)").images = [{ id: "img-3", version: 30 }];

test("species images are keyed by species, in the row's own order; species with none are left out", () => {
  const images = fns.speciesImagesFromMarkLists(imageLists);
  assert.deepEqual(images.Snapper, [{ id: "img-1", version: 10 }, { id: "img-2", version: 20 }]);
  assert.deepEqual(images["Shark (Gummy)"], [{ id: "img-3", version: 30 }]);
  assert.ok(!("Bream" in images) && !("Shark (School)" in images) && !("Elephant Fish" in images));
});

test("allSpeciesImages flattens every species' pictures, each tagged with its species", () => {
  const flat = fns.allSpeciesImages(fns.speciesImagesFromMarkLists(imageLists));
  assert.deepEqual(
    flat.sort((a, b) => a.id.localeCompare(b.id)),
    [{ species: "Snapper", id: "img-1", version: 10 }, { species: "Snapper", id: "img-2", version: 20 }, { species: "Shark (Gummy)", id: "img-3", version: 30 }]
      .sort((a, b) => a.id.localeCompare(b.id))
  );
  assert.deepEqual(fns.allSpeciesImages({}), []);
  assert.deepEqual(fns.allSpeciesImages(undefined), []);
});

test("the Catch species card lists every species' pictures, not just the session's targets", () => {
  const iopts = fns.sessionCardOptions(imageLists);
  // Snapper is the only target; Shark (Gummy) has pictures too and isn't targeted, but should still be pickable by image.
  const idefaults = { ...fns.emptySessionDefaults(), species: ["Snapper"] };
  const species = byId(fns.buildCatchCardSteps(iopts, idefaults, { answers: {}, run: null }), "species");
  const speciesNamesWithImages = species.images.map((i) => i.species).sort();
  assert.deepEqual([...new Set(speciesNamesWithImages)], ["Shark (Gummy)", "Snapper"]);
  assert.equal(species.images.length, 3);
});

test("Session defaults' species card has no image gallery — 'Select by image' is Catch-only", () => {
  const iopts = fns.sessionCardOptions(imageLists);
  const session = fns.buildSessionCardSteps(iopts, fns.emptySessionDefaults(), { run: null });
  assert.equal(byId(session, "species").images, undefined);
});