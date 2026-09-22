// Live mode's quick-entry cards (Map tab): the "Session defaults" flow and the "Catch" flow.
// Both are a stack of full-screen cards with large buttons and Prev / Next / Close.
//   Session defaults: target species, water, berley, active rods, then a rig card and a bait card for each rod.
//     Saved to the signed-in account (pref "liveSessionDefaults", see js/prefs.js) so they persist across sessions and devices.
//   Catch: species (the targets, with their limits and how many are kept), size (a +/- stepper with Too small), keep or release
//     (recommended from the limits), rod. The caller drops a Catch mark at the GPS position using the saved defaults.
// The first half of this file is pure (no DOM) and is tested in tests/live-cards.test.mjs; it uses the limit rules in
// js/catch-limits.js (loaded first). showCardFlow below is the only DOM part. Prefs, escapeHtml come from js/prefs.js and js/backend.js.

const LIVE_SESSION_DEFAULTS_KEY = "liveSessionDefaults";

function emptySessionDefaults() {
  return { species: [], water: "", berley: "", rods: [], rodSetups: {} };
}

const uniqueStrings = (list) => [...new Set((Array.isArray(list) ? list : []).filter((v) => typeof v === "string" && v !== ""))];

/**
 * Turns whatever was stored (a JSON string, an object, garbage or nothing) into a well-formed defaults object.
 * `options` ({species, water, berley, rods, rigs, baits}: arrays of allowed values), when given, drops any saved value
 * the Settings lists no longer offer; a list that is missing or empty is not used for pruning (the lists may not have loaded).
 * A rod's rig/bait setup is kept only while that rod is still selected.
 */
function normaliseSessionDefaults(raw, options) {
  let src = raw;
  if (typeof src === "string") {
    try {
      src = JSON.parse(src);
    } catch {
      src = null;
    }
  }
  if (!src || typeof src !== "object" || Array.isArray(src)) return emptySessionDefaults();
  const allowed = (key) => (options && Array.isArray(options[key]) && options[key].length ? options[key] : null);
  const keepAllowed = (list, key) => {
    const ok = allowed(key);
    return ok ? list.filter((v) => ok.includes(v)) : list;
  };
  const single = (value, key) => {
    const v = typeof value === "string" ? value : "";
    const ok = allowed(key);
    return ok && !ok.includes(v) ? "" : v;
  };
  const rods = keepAllowed(uniqueStrings(src.rods), "rods");
  const rodSetups = {};
  const rawSetups = src.rodSetups && typeof src.rodSetups === "object" && !Array.isArray(src.rodSetups) ? src.rodSetups : {};
  for (const rod of rods) {
    const s = rawSetups[rod] && typeof rawSetups[rod] === "object" ? rawSetups[rod] : {};
    rodSetups[rod] = { rig: single(s.rig, "rigs"), bait: single(s.bait, "baits") };
  }
  return {
    species: keepAllowed(uniqueStrings(src.species), "species"),
    water: single(src.water, "water"),
    berley: single(src.berley, "berley"),
    rods,
    rodSetups,
  };
}

/** The allowed values of one Mark List field, in list order, without duplicates. `markLists` is the flat [{field, value}] array. */
function markListValues(markLists, field) {
  return uniqueStrings((markLists || []).filter((row) => row && row.field === field).map((row) => row.value));
}

/** Each species' pictures ({id, version}, see js/species-image.js), keyed by species name. Species with none are left out. */
function speciesImagesFromMarkLists(markLists) {
  const out = {};
  for (const row of markLists || []) {
    if (!row || row.field !== "Species" || !Array.isArray(row.images) || !row.images.length) continue;
    out[row.value] = row.images.map((img) => ({ id: img.id, version: img.version ?? null }));
  }
  return out;
}

/** Every species picture, flattened to {species, id, version} — what the Catch flow's "Select by image" gallery lists. */
function allSpeciesImages(imagesBySpecies) {
  const out = [];
  for (const [species, images] of Object.entries(imagesBySpecies || {})) for (const img of images) out.push({ species, id: img.id, version: img.version });
  return out;
}

/** Everything the cards can offer, keyed the way normaliseSessionDefaults expects. */
function sessionCardOptions(markLists) {
  return {
    species: markListValues(markLists, "Species"),
    water: markListValues(markLists, "Water Condition"),
    berley: markListValues(markLists, "Berley"),
    rods: markListValues(markLists, "Rod"),
    rigs: markListValues(markLists, "Rig"),
    baits: markListValues(markLists, "Bait"),
    limits: limitsFromMarkLists(markLists), // per-species limits (js/catch-limits.js), shown under species and used by the Catch flow
    images: speciesImagesFromMarkLists(markLists), // species pictures (js/species-image.js), used by the Catch flow's "Select by image"
  };
}

/**
 * The two-line blurb (limits, kept so far) under each species button: {species: {line1, line2, tone}}. `run` is the current
 * run's catches, or null when they aren't known yet (then limits only, never a misleading 0).
 */
function speciesSublabels(speciesList, limits, run) {
  const out = {};
  for (const s of speciesList) {
    const lines = speciesLimitLines(limits[s], run ? speciesCounts(run, limits, s) : null);
    if (lines.line1 === "No limits set") continue; // no limits: nothing worth saying (not even a count)
    out[s] = lines;
  }
  return out;
}

/**
 * The cards of the Session defaults flow for the current draft: Species, Water, Berley, Rods, then a Rig card and a
 * Bait card for each selected rod, in the order the rods are listed. Rebuilt after every choice, because choosing rods
 * changes the cards that follow. A step is {id, title, prompt, multi, options, selected: [values]}.
 */
function buildSessionCardSteps(options, draft, ctx = {}) {
  const steps = [
    {
      id: "species", title: "Target species", prompt: "Which species are you targeting?", multi: true, options: options.species, selected: draft.species,
      sublabels: speciesSublabels(options.species, options.limits || {}, ctx.run || null),
    },
    { id: "water", title: "Water", prompt: "What is the water like?", multi: false, options: options.water, selected: draft.water ? [draft.water] : [] },
    { id: "berley", title: "Berley", prompt: "Which berley are you using?", multi: false, options: options.berley, selected: draft.berley ? [draft.berley] : [] },
    { id: "rods", title: "Active rods", prompt: "Which rods are you fishing?", multi: true, options: options.rods, selected: draft.rods },
  ];
  for (const rod of draft.rods) {
    const setup = draft.rodSetups[rod] || {};
    steps.push({ id: `rig:${rod}`, title: rod, prompt: `Which rig is on ${rod}?`, multi: false, options: options.rigs, selected: setup.rig ? [setup.rig] : [] });
    steps.push({ id: `bait:${rod}`, title: rod, prompt: `Which bait is on ${rod}?`, multi: false, options: options.baits, selected: setup.bait ? [setup.bait] : [] });
  }
  return steps;
}

/** Applies a button press on one Session defaults card, returning the new draft (the old one is not changed). Pressing a chosen single-choice value clears it. */
function applySessionCardChoice(draft, stepId, value) {
  const next = {
    ...draft,
    species: [...draft.species],
    rods: [...draft.rods],
    rodSetups: Object.fromEntries(Object.entries(draft.rodSetups).map(([rod, s]) => [rod, { ...s }])),
  };
  const toggle = (list) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  if (stepId === "species") next.species = toggle(next.species);
  else if (stepId === "water") next.water = draft.water === value ? "" : value;
  else if (stepId === "berley") next.berley = draft.berley === value ? "" : value;
  else if (stepId === "rods") {
    next.rods = toggle(next.rods);
    for (const rod of Object.keys(next.rodSetups)) if (!next.rods.includes(rod)) delete next.rodSetups[rod];
    for (const rod of next.rods) if (!next.rodSetups[rod]) next.rodSetups[rod] = { rig: "", bait: "" };
  } else {
    const m = /^(rig|bait):(.*)$/.exec(stepId);
    if (m && next.rodSetups[m[2]]) next.rodSetups[m[2]][m[1]] = next.rodSetups[m[2]][m[1]] === value ? "" : value;
  }
  return next;
}

/**
 * A press on the size stepper card. `current` is the size answer so far (a number in cm, "small" for Too small, or undefined
 * if untouched), `action` is "delta:<cm>" (e.g. "delta:-5") or "tooSmall" (pressing it again undoes it), `start` where the
 * stepper opens. Returns the new size answer.
 */
function applySizeAction(current, action, start) {
  if (action === "tooSmall") return current === "small" ? undefined : "small";
  const base = typeof current === "number" ? current : start;
  const step = /^delta:(-?\d+(?:\.\d+)?)$/.exec(action);
  if (step) return Math.max(0, Math.round((base + Number(step[1])) * 10) / 10);
  // "tens:<n>" sets the tens (n = 1..12, so 10..120 cm) and keeps the ones digit: 38 + "tens:4" = 48, 38 + "tens:12" = 128.
  // "ones:<n>" sets the ones digit (0..9) and keeps the tens: 38 + "ones:5" = 35. Both work in whole cm.
  const tens = /^tens:(\d{1,2})$/.exec(action);
  if (tens) return Number(tens[1]) * 10 + (Math.floor(base) % 10);
  const ones = /^ones:(\d)$/.exec(action);
  if (ones) return Math.floor(base / 10) * 10 + Number(ones[1]);
  return current;
}

/**
 * What the Catch cards add up to so far, from the answers (`answers` = {species, size, fate, rod}; size is a number, "small"
 * or untouched) and context (`ctx` = {run: this run's catches or null, catches: every catch}). Untouched size means the
 * stepper's starting value; an untouched Keep/Release means the recommendation. Used by the cards and by the save.
 */
function catchCardState(options, ctx) {
  const answers = ctx.answers || {};
  const limits = options.limits || {};
  const species = answers.species || "";
  const lim = limits[species];
  const start = stepperStartSize(lim, lastCatchSize(ctx.catches || [], species));
  const size = answers.size === "small" ? "small" : typeof answers.size === "number" ? answers.size : start;
  const tooSmall = size === "small";
  const counts = ctx.run && species ? speciesCounts(ctx.run, limits, species) : null;
  const rec = recommendFate({ lim, size: tooSmall ? null : size, counts, tooSmall });
  const fate = tooSmall ? "Release" : answers.fate || rec.fate;
  return { species, lim, start, size, tooSmall, counts, rec, fate, released: fate === "Release", rod: answers.rod || "" };
}

/** The line under the stepper number: how the size measures against the species' limits. */
function sizeVerdictText(lim, size) {
  if (!lim) return { text: "", tone: "" };
  const v = sizeVerdict(lim, size);
  if (v.tooSmall) return { text: `Under the minimum size (${lim.minSize} cm) — release`, tone: "bad" };
  if (v.overSlot) return { text: `Over the maximum size (${lim.maxSize} cm) — release`, tone: "bad" };
  if (v.big) return { text: "Big fish", tone: "big" };
  if (lim.minSize != null || lim.maxSize != null) return { text: "Legal size", tone: "ok" };
  return { text: "", tone: "" };
}

/**
 * The cards of the Catch flow: Species (the session's targets first, then a divider and every other species, each with its
 * limits and kept count), Size (a +/- stepper with Too small), Keep or Release (skipped for Too small; the recommendation is
 * pre-selected) and Rod (the session's rods). With no targets or rods saved they fall back to the full lists.
 * `ctx` = {answers, run, catches} (see catchCardState); all optional.
 */
function buildCatchCardSteps(options, defaults, ctx = {}) {
  const limits = options.limits || {};
  const answers = ctx.answers || {};
  const st = catchCardState(options, ctx);
  // Targets first, then a divider, then every other species for a quick pick of something unexpected.
  const others = options.species.filter((s) => !defaults.species.includes(s));
  const speciesList = [...defaults.species, ...others];
  const rodList = defaults.rods.length ? defaults.rods : options.rods;
  const steps = [
    {
      id: "species", title: "Species", prompt: "What did you catch?", multi: false, required: true, options: speciesList,
      selected: answers.species ? [answers.species] : [],
      sublabels: speciesSublabels(speciesList, limits, ctx.run || null),
      dividerAfter: defaults.species.length && others.length ? defaults.species.length : 0, // index of the first "other" species, 0 = no divider
      hint: defaults.species.length ? "" : "No target species set — showing every species. Set them in Session defaults.",
      images: allSpeciesImages(options.images), // every species picture, for "Select by image" — not just the targets
    },
    {
      id: "size", kind: "stepper", title: "Size", prompt: st.species ? `How big is the ${st.species}?` : "How big?", multi: false, required: false,
      options: [], selected: [], value: st.tooSmall ? null : st.size, tooSmall: st.tooSmall, minSize: st.lim ? st.lim.minSize : null,
      verdict: st.tooSmall ? { text: "Too small — will be released", tone: "bad" } : sizeVerdictText(st.lim, st.size),
    },
  ];
  if (!st.tooSmall) {
    steps.push({
      id: "fate", title: "Keep or release?", prompt: st.species ? `${st.species}, ${st.size} cm` : "", multi: false, required: true, options: ["Keep", "Release"],
      selected: [st.fate], sublabels: { [st.rec.fate]: { line1: "Recommended", line2: "", tone: "" } }, hint: st.rec.reason,
    });
  }
  if (rodList.length) {
    steps.push({
      id: "rod", title: "Rod", prompt: "Which rod?", multi: false, required: true, options: rodList, selected: answers.rod ? [answers.rod] : [],
      hint: defaults.rods.length ? "" : "No rods set — showing every rod. Set them in Session defaults.",
    });
  }
  return steps;
}

/**
 * The Catch mark for the three card answers at (lat, lng): type Catch, named after the species, with the rod's saved
 * rig and bait and the session's water and berley. `tide` ({tideCondition, tideExtreme}) is the tide worked out for now.
 * Weather, barometer, temperature and wind are left blank here; saving a new mark fills them (see saveMarkToD1).
 */
function buildCatchFromCards({ id, lat, lng, dateTime, species, size, rod, tooSmall, released }, defaults, tide) {
  const mark = { id, lat, lng, name: species, type: "Catch", dateTime, createdAt: dateTime, source: "Manual", species };
  const cm = size === "" || size == null ? NaN : Number(size);
  if (Number.isFinite(cm) && !tooSmall) mark.size = cm;
  if (tooSmall) mark.notes = "Too small"; // no size is known; the note tells it apart from other releases
  if (released || tooSmall) mark.released = true;
  if (rod) {
    mark.rod = rod;
    const setup = defaults.rodSetups[rod] || {};
    if (setup.rig) mark.rig = setup.rig;
    if (setup.bait) mark.bait = setup.bait;
  }
  if (defaults.water) mark.waterCondition = defaults.water;
  if (defaults.berley) mark.berley = defaults.berley;
  if (tide && tide.tideCondition) mark.tideCondition = tide.tideCondition;
  if (tide && tide.tideExtreme) mark.tideExtreme = tide.tideExtreme;
  return mark;
}

/** The toast after a Catch is saved: what happened to the fish and where the bag stands (`counts` from speciesCounts, or null). */
function catchSavedMessage(st, counts) {
  if (st.tooSmall) return `${st.species}: too small, released`;
  if (!st.released) {
    const maxQty = st.lim && st.lim.maxQty != null ? ` of ${st.lim.maxQty}` : "";
    return counts ? `${st.species} kept: ${counts.kept}${maxQty} in this run` : `${st.species} kept`;
  }
  return `${st.species} released`;
}

/** The saved defaults on this device (Prefs keeps localStorage in step with the account). Never throws. */
function getSessionDefaults(options) {
  let raw = null;
  try {
    raw = localStorage.getItem(LIVE_SESSION_DEFAULTS_KEY);
  } catch {
    raw = null;
  }
  return normaliseSessionDefaults(raw, options);
}

function saveSessionDefaults(defaults) {
  try {
    Prefs.set(LIVE_SESSION_DEFAULTS_KEY, JSON.stringify(defaults));
  } catch {
    /* storage blocked — the choices still apply until the page is left */
  }
}

// --- DOM: the full-screen card stack ------------------------------------------------------------

/**
 * The full-screen "is this the one?" check shown after the first tap on a picture in the Species card's image gallery
 * (showCardFlow below). Reuses the Settings picture viewer's own CSS skeleton (`.species-image-viewer*`, see
 * openSpeciesImageViewer in locationsadmin.js) — same full-screen dark layout with the picture centered and scaled to
 * fit — just with "This one" / "Not this one" instead of Replace/Delete. `sublabel`, when given, is the species' own
 * limits/kept-so-far blurb (the same text already shown under its name on the plain list) — worth having right here,
 * since it can be exactly what decides "keep it or try another picture". `onConfirm` runs on "This one"; the backdrop,
 * ×, Escape and "Not this one" all just close it back to the gallery grid.
 */
function showGalleryImageConfirm(item, sublabel, { onConfirm }) {
  const overlay = document.createElement("div");
  overlay.className = "species-image-viewer";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `
    <div class="species-image-viewer-top">
      <span>${escapeHtml(item.species)}${sublabel && sublabel.line2 ? ` · ${escapeHtml(sublabel.line2)}` : ""}</span>
      <button type="button" data-v="close" aria-label="Close">&times;</button>
    </div>
    <div class="species-image-viewer-stage">
      <img src="${escapeHtml(speciesImageUrl(item))}" alt="${escapeHtml(item.species)}" />
    </div>
    <div class="species-image-viewer-actions">
      <button type="button" class="primary" data-v="confirm">This one</button>
      <button type="button" data-v="cancel">Not this one</button>
    </div>`;
  document.body.appendChild(overlay);
  wireImagePictureFallback(overlay.querySelector("img"));
  const close = () => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.classList.contains("species-image-viewer-stage")) close();
  });
  overlay.querySelector('[data-v="close"]').addEventListener("click", close);
  overlay.querySelector('[data-v="cancel"]').addEventListener("click", close);
  overlay.querySelector('[data-v="confirm"]').addEventListener("click", () => {
    close();
    onConfirm();
  });
}

/**
 * Shows the cards full-screen. Options:
 *   getSteps(): the current steps (called after every choice, since choosing can change later cards)
 *   onChoose(step, value): a button was pressed
 *   onDone(): Next was pressed on the last card
 *   onClose(): Close was pressed (or the overlay was dismissed)
 *   doneLabel: text of the last card's Next button
 * A step with `required` disables Next until something is chosen. Returns {close, refresh}.
 */
function showCardFlow({ getSteps, onChoose, onDone, onClose, doneLabel = "Done" }) {
  const overlay = document.createElement("div");
  overlay.className = "live-card-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  document.body.appendChild(overlay);
  document.body.classList.add("live-card-open");
  let index = 0;
  // The species card's "Select by image" gallery: whether it is showing, reset whenever a different card comes into view
  // (so returning to Species later starts back on the plain list).
  let gallery = false;
  let galleryStepId = null;

  const close = () => {
    overlay.remove();
    document.body.classList.remove("live-card-open");
  };

  // On to the next card, or done when this is the last one.
  function advance() {
    if (index >= getSteps().length - 1) {
      onDone();
      return;
    }
    index += 1;
    render();
  }

  function render() {
    const steps = getSteps();
    if (index >= steps.length) index = steps.length - 1;
    if (index < 0) index = 0;
    const step = steps[index];
    if (step.id !== galleryStepId) {
      gallery = false;
      galleryStepId = step.id;
    }
    const isLast = index === steps.length - 1;
    const canNext = !step.required || step.selected.length > 0;
    const galleryButton = (item, i) => `
      <button type="button" class="live-card-choice live-card-gallery-item" data-gallery="${i}">
        <img src="${escapeHtml(speciesImageUrl(item))}" alt="${escapeHtml(item.species)}" loading="lazy" />
        <span>${escapeHtml(item.species)}</span>
      </button>`;
    const optionButton = (value, i) => {
      const sub = step.sublabels && step.sublabels[value];
      const tone = sub && sub.tone ? ` tone-${sub.tone}` : "";
      const lines = sub
        ? `${sub.line1 ? `<span class="live-card-choice-sub">${escapeHtml(sub.line1)}</span>` : ""}${sub.line2 ? `<span class="live-card-choice-sub">${escapeHtml(sub.line2)}</span>` : ""}`
        : "";
      return `<button type="button" class="live-card-choice${step.selected.includes(value) ? " selected" : ""}${tone}" data-choice="${i}" aria-pressed="${step.selected.includes(value)}"><span>${escapeHtml(value)}</span>${lines}</button>`;
    };
    const stepperHtml = () => {
      const verdict = step.verdict || { text: "", tone: "" };
      // Two columns set the size directly: 10s (1..12 = 10..120 cm) and 1s (0..9). The current size's buttons are
      // highlighted (nothing while Too small is chosen).
      const whole = step.tooSmall || step.value == null ? null : Math.floor(step.value);
      const column = (caption, action, numbers, isCurrent) => `
        <div class="live-card-digit-col">
          <div class="live-card-digit-caption">${caption}</div>
          <div class="live-card-digit-buttons">
            ${numbers.map((n) => `<button type="button" class="live-card-choice live-card-digit${whole != null && isCurrent(n) ? " selected" : ""}" data-stepper="${action}:${n}">${n}</button>`).join("")}
          </div>
        </div>`;
      const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
      return `
        <div class="live-card-stepper">
          <div class="live-card-stepper-row">
            <button type="button" class="live-card-choice live-card-step-btn" data-stepper="delta:-1" aria-label="One cm smaller">&minus;</button>
            <div class="live-card-stepper-value${step.tooSmall ? " small" : ""}">${step.tooSmall ? "Too small" : `${escapeHtml(step.value)}<span class="live-card-stepper-unit"> cm</span>`}</div>
            <button type="button" class="live-card-choice live-card-step-btn" data-stepper="delta:1" aria-label="One cm bigger">+</button>
          </div>
          <div class="live-card-stepper-verdict${verdict.tone ? ` tone-${verdict.tone}` : ""}">${escapeHtml(verdict.text) || "&nbsp;"}</div>
          ${step.minSize != null ? `<button type="button" class="live-card-choice live-card-toosmall${step.tooSmall ? " selected" : ""}" data-stepper="tooSmall" aria-pressed="${step.tooSmall}">Too small (under ${escapeHtml(step.minSize)} cm)</button>` : ""}
          <div class="live-card-digit-cols">
            ${column("10s", "tens", range(1, 12), (n) => Math.floor(whole / 10) === n)}
            ${column("1s", "ones", range(0, 9), (n) => whole % 10 === n)}
          </div>
        </div>`;
    };
    const hasGallery = Array.isArray(step.images) && step.images.length > 0;
    const buttons = step.kind === "stepper"
      ? stepperHtml()
      : gallery
        ? step.images.map(galleryButton).join("")
        : step.options.length
          ? step.options.map((value, i) => (step.dividerAfter && i === step.dividerAfter ? `<div class="live-card-divider" role="separator">Other species</div>` : "") + optionButton(value, i)).join("")
          : `<p class="live-card-empty">Nothing to choose yet — add options for this on the Settings tab.</p>`;
    const galleryToggleHtml = hasGallery
      ? `<button type="button" class="live-card-gallery-toggle" data-gallery-toggle>${gallery ? "&larr; Back to the list" : "Select by image &rarr;"}</button>`
      : "";
    overlay.innerHTML = `
      <div class="live-card">
        <div class="live-card-head">
          <div class="live-card-progress">${index + 1} / ${steps.length}</div>
          <h2 class="live-card-title">${escapeHtml(step.title)}</h2>
          <p class="live-card-prompt">${escapeHtml(step.prompt)}${step.multi ? " (pick any)" : ""}</p>
          ${step.hint ? `<p class="live-card-hint">${escapeHtml(step.hint)}</p>` : ""}
          ${galleryToggleHtml}
        </div>
        <div class="live-card-grid${step.kind === "stepper" ? " live-card-grid-stepper" : ""}${gallery ? " live-card-grid-gallery" : ""}">${buttons}</div>
        <div class="live-card-nav">
          <button type="button" class="live-card-nav-btn" data-nav="prev"${index === 0 ? " disabled" : ""}>Prev</button>
          <button type="button" class="live-card-nav-btn live-card-close" data-nav="close">Close</button>
          <button type="button" class="live-card-nav-btn live-card-next" data-nav="next"${canNext ? "" : " disabled"}>${isLast ? escapeHtml(doneLabel) : "Next"}</button>
        </div>
      </div>`;
    const grid = overlay.querySelector(".live-card-grid");
    grid.scrollTop = 0;
    // Choosing on a single-choice card moves straight on to the next card (or finishes, on the last one). Pressing the value
    // that is already chosen just moves on rather than clearing it. Multi-choice cards ("pick any") stay put.
    overlay.querySelectorAll("[data-choice]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const value = step.options[Number(btn.dataset.choice)];
        if (!step.multi) {
          if (!step.selected.includes(value)) onChoose(step, value);
          advance();
          return;
        }
        onChoose(step, value);
        const scrollTop = grid.scrollTop;
        render();
        overlay.querySelector(".live-card-grid").scrollTop = scrollTop;
      })
    );
    // A picture just uploaded can briefly 404 (see wireImagePictureFallback) — every gallery thumbnail gets the same retry/fallback.
    overlay.querySelectorAll(".live-card-gallery-item img").forEach((img) => wireImagePictureFallback(img));
    // A picture's first tap opens it full screen to confirm, rather than selecting straight away — small thumbnails can
    // be hard to tell apart. "This one" selects the species it belongs to (same as tapping its name) and moves on;
    // "Not this one" just closes the preview, back on the same picture grid.
    overlay.querySelectorAll("[data-gallery]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const item = step.images[Number(btn.dataset.gallery)];
        showGalleryImageConfirm(item, step.sublabels && step.sublabels[item.species], {
          onConfirm: () => {
            onChoose(step, item.species);
            advance();
          },
        });
      })
    );
    const galleryToggleBtn = overlay.querySelector("[data-gallery-toggle]");
    if (galleryToggleBtn) {
      galleryToggleBtn.addEventListener("click", () => {
        gallery = !gallery;
        render();
      });
    }
    // The size stepper's buttons pass an action ("delta:1", "tens:4", "ones:2", "tooSmall") instead of an option value.
    // Only Too small moves on (when it has just been chosen); the number buttons stay so the size can be adjusted.
    overlay.querySelectorAll("[data-stepper]").forEach((btn) =>
      btn.addEventListener("click", () => {
        onChoose(step, btn.dataset.stepper);
        const now = getSteps()[index];
        if (btn.dataset.stepper === "tooSmall" && now && now.tooSmall) advance();
        else render();
      })
    );
    overlay.querySelector('[data-nav="prev"]').addEventListener("click", () => {
      index -= 1;
      render();
    });
    overlay.querySelector('[data-nav="close"]').addEventListener("click", () => {
      close();
      if (onClose) onClose();
    });
    overlay.querySelector('[data-nav="next"]').addEventListener("click", () => {
      if (isLast) {
        onDone();
        return;
      }
      index += 1;
      render();
    });
  }

  render();
  return { close, refresh: render };
}
