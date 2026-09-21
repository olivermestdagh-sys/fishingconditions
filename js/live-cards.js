// Live mode's quick-entry cards (Map tab): the "Session defaults" flow and the "Catch" flow.
// Both are a stack of full-screen cards with large buttons and Prev / Next / Close.
//   Session defaults: target species, water, berley, active rods, then a rig card and a bait card for each rod.
//     Saved to the signed-in account (pref "liveSessionDefaults", see js/prefs.js) so they persist across sessions and devices.
//   Catch: species (the targets), size, rod. The caller drops a Catch mark at the GPS position using the saved defaults.
// The first half of this file is pure (no DOM, no globals) and is tested in tests/live-cards.test.mjs;
// showCardFlow below is the only DOM part. Prefs, escapeHtml come from js/prefs.js and js/backend.js.

const LIVE_SESSION_DEFAULTS_KEY = "liveSessionDefaults";
// Catch size buttons, in cm. To be refined later — change here only.
const CATCH_SIZE_MIN_CM = 20;
const CATCH_SIZE_MAX_CM = 40;
const CATCH_SIZE_STEP_CM = 1;

function catchSizeOptions() {
  const sizes = [];
  for (let cm = CATCH_SIZE_MIN_CM; cm <= CATCH_SIZE_MAX_CM; cm += CATCH_SIZE_STEP_CM) sizes.push(cm);
  return sizes;
}

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

/** Everything the cards can offer, keyed the way normaliseSessionDefaults expects. */
function sessionCardOptions(markLists) {
  return {
    species: markListValues(markLists, "Species"),
    water: markListValues(markLists, "Water Condition"),
    berley: markListValues(markLists, "Berley"),
    rods: markListValues(markLists, "Rod"),
    rigs: markListValues(markLists, "Rig"),
    baits: markListValues(markLists, "Bait"),
  };
}

/**
 * The cards of the Session defaults flow for the current draft: Species, Water, Berley, Rods, then a Rig card and a
 * Bait card for each selected rod, in the order the rods are listed. Rebuilt after every choice, because choosing rods
 * changes the cards that follow. A step is {id, title, prompt, multi, options, selected: [values]}.
 */
function buildSessionCardSteps(options, draft) {
  const steps = [
    { id: "species", title: "Target species", prompt: "Which species are you targeting?", multi: true, options: options.species, selected: draft.species },
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
 * The cards of the Catch flow. Species offers only the session's target species, and the rod card only the session's
 * rods; with none saved they fall back to the full lists (`usedFallback` says so, so the caller can hint at Session defaults).
 */
function buildCatchCardSteps(options, defaults) {
  // Targets first, then a divider, then every other species for a quick pick of something unexpected.
  const others = options.species.filter((s) => !defaults.species.includes(s));
  const speciesList = [...defaults.species, ...others];
  const rodList = defaults.rods.length ? defaults.rods : options.rods;
  const steps = [
    {
      id: "species", title: "Species", prompt: "What did you catch?", multi: false, required: true, options: speciesList,
      dividerAfter: defaults.species.length && others.length ? defaults.species.length : 0, // index of the first "other" species, 0 = no divider
      hint: defaults.species.length ? "" : "No target species set — showing every species. Set them in Session defaults.",
    },
    { id: "size", title: "Size", prompt: "How big (cm)?", multi: false, required: true, options: catchSizeOptions().map(String) },
  ];
  if (rodList.length) {
    steps.push({ id: "rod", title: "Rod", prompt: "Which rod?", multi: false, required: true, options: rodList, hint: defaults.rods.length ? "" : "No rods set — showing every rod. Set them in Session defaults." });
  }
  return steps;
}

/**
 * The Catch mark for the three card answers at (lat, lng): type Catch, named after the species, with the rod's saved
 * rig and bait and the session's water and berley. `tide` ({tideCondition, tideExtreme}) is the tide worked out for now.
 * Weather, barometer, temperature and wind are left blank here; saving a new mark fills them (see saveMarkToD1).
 */
function buildCatchFromCards({ id, lat, lng, dateTime, species, size, rod }, defaults, tide) {
  const mark = { id, lat, lng, name: species, type: "Catch", dateTime, createdAt: dateTime, source: "Manual", species };
  const cm = size === "" || size == null ? NaN : Number(size);
  if (Number.isFinite(cm)) mark.size = cm;
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

  const close = () => {
    overlay.remove();
    document.body.classList.remove("live-card-open");
  };

  function render() {
    const steps = getSteps();
    if (index >= steps.length) index = steps.length - 1;
    if (index < 0) index = 0;
    const step = steps[index];
    const isLast = index === steps.length - 1;
    const canNext = !step.required || step.selected.length > 0;
    const buttons = step.options.length
      ? step.options
          .map((value, i) => (step.dividerAfter && i === step.dividerAfter ? `<div class="live-card-divider" role="separator">Other species</div>` : "") +
            `<button type="button" class="live-card-choice${step.selected.includes(value) ? " selected" : ""}" data-choice="${i}" aria-pressed="${step.selected.includes(value)}">${escapeHtml(value)}</button>`)
          .join("")
      : `<p class="live-card-empty">Nothing to choose yet — add options for this on the Settings tab.</p>`;
    overlay.innerHTML = `
      <div class="live-card">
        <div class="live-card-head">
          <div class="live-card-progress">${index + 1} / ${steps.length}</div>
          <h2 class="live-card-title">${escapeHtml(step.title)}</h2>
          <p class="live-card-prompt">${escapeHtml(step.prompt)}${step.multi ? " (pick any)" : ""}</p>
          ${step.hint ? `<p class="live-card-hint">${escapeHtml(step.hint)}</p>` : ""}
        </div>
        <div class="live-card-grid">${buttons}</div>
        <div class="live-card-nav">
          <button type="button" class="live-card-nav-btn" data-nav="prev"${index === 0 ? " disabled" : ""}>Prev</button>
          <button type="button" class="live-card-nav-btn live-card-close" data-nav="close">Close</button>
          <button type="button" class="live-card-nav-btn live-card-next" data-nav="next"${canNext ? "" : " disabled"}>${isLast ? escapeHtml(doneLabel) : "Next"}</button>
        </div>
      </div>`;
    const grid = overlay.querySelector(".live-card-grid");
    grid.scrollTop = 0;
    overlay.querySelectorAll("[data-choice]").forEach((btn) =>
      btn.addEventListener("click", () => {
        onChoose(step, step.options[Number(btn.dataset.choice)]);
        const scrollTop = grid.scrollTop;
        render();
        overlay.querySelector(".live-card-grid").scrollTop = scrollTop;
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
