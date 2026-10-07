// Trip tab (trip.html): record a trip from a phone, the way the Fishing Controller does — Start trip -> tap an Action to run it ->
// + Catch -> Water / Depth always on screen -> End trip. Tap-only (no rotary dial). The logic is js/trip-session.js; the catch question
// cards are js/live-cards.js (showCardFlow); editing an Action / Rod Setup is Trip Defaults (js/trip-defaults.js).

const tripUi = { busy: false, overlayOpen: false, waterOptions: null, catches: [], catchesLoaded: false, lastKey: "", rodView: false, move: null, td: null, adding: false };

// Trip Defaults' data (mark lists with their pictures, private sub lists), for the rod pictures and the quick bait / rig-option edit.
async function tripLoadTd() {
  try {
    tripUi.td = await tdLoadAll();
  } catch (err) {
    console.error("Could not load the lists for the rod screen:", err);
  }
}

function tripApp() {
  return document.getElementById("tripApp");
}

// --- Data ------------------------------------------------------------------------------------------------------

async function tripLoadData() {
  try {
    await tsLoadTripData();
  } catch (err) {
    console.error("Could not load trips:", err);
    showLiveToast("Couldn't load your trips: " + err.message, true);
  }
  return liveTripData;
}

async function tripLoadCardOptions() {
  let lists = [];
  try {
    lists = await fetchUnionedMarkLists();
  } catch (err) {
    console.error("Could not load mark lists for the cards:", err);
  }
  const options = sessionCardOptions(lists);
  tripUi.waterOptions = options.water;
  return options;
}

// The last 12 hours of Catch marks, so the cards can say where the bag stands (js/catch-limits.js).
async function tripLoadRecentCatches() {
  try {
    const res = await fetch(`${MARKS_FILE_PATH}?since=${Date.now() - 12 * 60 * 60 * 1000}&_=${Date.now()}`, { cache: "no-store", credentials: "include" });
    if (!res.ok) return;
    tripUi.catches = catchesFromMarks(await res.json(), parseNaive);
    tripUi.catchesLoaded = true;
  } catch (err) {
    console.error("Could not load recent catches:", err);
  }
}
function tripCatchContext() {
  return { catches: tripUi.catches, run: tripUi.catchesLoaded ? runCatches(tripUi.catches, nowInNaiveEncoding()) : null };
}

// --- Rendering -------------------------------------------------------------------------------------------------

const TRIP_PLAY_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></svg>';
const TRIP_STOP_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
const TRIP_FISH_ICON = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 12c3-5 8-6 12-3 .5 1.5.5 4.5 0 6-4 3-9 2-12-3z"/><path d="M6.5 12 2 8v8z"/><circle cx="15" cy="11" r=".6" fill="currentColor"/></svg>';

/** The start time (ms) a run id carries: run_<ms>_xxxxx. */
function tripRunStartMs(runId) {
  const m = /^run_(\d+)_/.exec(runId || "");
  return m ? Number(m[1]) : null;
}

function tripRender() {
  const root = tripApp();
  if (!root || tripUi.overlayOpen) return;
  const state = getLiveTripState();
  if (!state) {
    tripRenderIdle(root);
  } else {
    tripRenderRunning(root, state);
  }
  tripUi.lastKey = tripStateKey();
}
function tripStateKey() {
  const s = getLiveTripState();
  return s ? [s.tripId, s.actionId || "", s.sessionGroupId || "", s.runId || ""].join("|") : "";
}

function tripRenderIdle(root) {
  if (!liveTripData) {
    root.innerHTML = `<div class="trip-card"><p class="trip-muted">Loading your trips…</p></div>`;
    return;
  }
  const trips = liveTripData.trips;
  root.innerHTML = `
    <div class="trip-card">
      <h2 class="trip-title">Start a trip</h2>
      ${trips.length
        ? `<div class="trip-list">${trips.map((t) => `<div class="trip-pill trip-trip-pill">
            <button type="button" class="trip-pill-main" data-trip="${escapeHtml(t.id)}"${tripUi.busy ? " disabled" : ""}>${TRIP_PLAY_ICON}<span>${escapeHtml(t.name)}</span></button>
            <button type="button" class="trip-pill-gear" data-trip-edit="${escapeHtml(t.id)}" aria-label="Settings for ${escapeHtml(t.name)}"${tripUi.busy ? " disabled" : ""}>${TD_GEAR_SVG}</button>
          </div>`).join("")}</div>`
        : `<p class="trip-muted">No trips yet — add one below.</p>`}
      ${tripUi.adding
        ? `<div class="trip-add-row"><input type="text" id="tripNewName" class="trip-add-input" maxlength="80" placeholder="Trip name" /><button type="button" class="trip-small" id="tripAddSave">Add</button><button type="button" class="trip-small" id="tripAddCancel">Cancel</button></div>`
        : `<button type="button" class="trip-add-pill" id="tripAddBtn">+ Add trip</button>`}
    </div>`;
  root.querySelectorAll("[data-trip]").forEach((btn) => btn.addEventListener("click", () => tripOnStart(btn.dataset.trip)));
  root.querySelectorAll("[data-trip-edit]").forEach((btn) => btn.addEventListener("click", () => tripOpenDefaults({ tripId: btn.dataset.tripEdit })));
  const addBtn = document.getElementById("tripAddBtn");
  if (addBtn) addBtn.addEventListener("click", () => { tripUi.adding = true; tripRender(); const i = document.getElementById("tripNewName"); if (i) i.focus(); });
  const save = document.getElementById("tripAddSave");
  if (save) {
    const input = document.getElementById("tripNewName");
    input.focus();
    save.addEventListener("click", () => tripAddTrip(input.value));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") tripAddTrip(input.value); });
    document.getElementById("tripAddCancel").addEventListener("click", () => { tripUi.adding = false; tripRender(); });
  }
}

function tripRenderRunning(root, state) {
  if (!liveTripData) {
    root.innerHTML = `<div class="trip-card"><p class="trip-muted">Loading your trip…</p></div>`;
    return;
  }
  const trip = liveTripData.trips.find((t) => t.id === state.tripId);
  if (!trip) {
    setLiveTripState(null); // the trip was deleted in Trip Defaults
    tripRender();
    return;
  }
  const session = tsActiveSession(state);
  const running = session ? state.actionId : null;
  if (!session) { tripUi.rodView = false; tripUi.move = null; }
  if (tripUi.rodView) {
    tripRenderRods(root, state, trip);
    return;
  }
  const d = getLiveMarkDefaults();
  const actions = tdActionsForTrip(liveTripData.actions, trip.id);
  const dis = tripUi.busy ? " disabled" : "";
  root.innerHTML = `
    <div class="trip-card trip-status">
      <div class="trip-status-name">${escapeHtml(trip.name)}</div>
      <div class="trip-status-time" id="tripElapsed" aria-label="Time on this trip"></div>
    </div>
    <div class="trip-conditions">
      <button type="button" class="trip-cond" id="tripWaterBtn"><span class="trip-cond-label">Water</span><span class="trip-cond-value">${escapeHtml(d.water || "—")}</span></button>
      <button type="button" class="trip-cond" id="tripDepthBtn"><span class="trip-cond-label">Depth</span><span class="trip-cond-value">${d.depth != null ? escapeHtml(d.depth.toFixed(1)) + " m" : "—"}</span></button>
    </div>
    <div class="trip-card">
      <h2 class="trip-title">Actions</h2>
      ${actions.length
        ? `<div class="trip-actions">${actions.map((a) => `
          <div class="trip-pill${a.id === running ? " active" : ""}">
            <button type="button" class="trip-pill-main" data-action="${escapeHtml(a.id)}" aria-pressed="${a.id === running}"${dis}>${escapeHtml(a.name)}</button>
            <button type="button" class="trip-pill-gear" data-action-edit="${escapeHtml(a.id)}" aria-label="Edit ${escapeHtml(a.name)}"${dis}>${TD_GEAR_SVG}</button>
          </div>`).join("")}</div>`
        : `<p class="trip-muted">No actions in ${escapeHtml(trip.name)} yet — add some in Trip Defaults.</p>`}
      <p class="trip-muted trip-hint">${running ? "Tap the running action to end it, or another to switch." : "Tap an action to start it."}</p>
    </div>
    <button type="button" class="trip-big trip-end" id="tripEndBtn"${dis}>${TRIP_STOP_ICON}<span>End trip</span></button>`;
  root.querySelectorAll("[data-action]").forEach((btn) => btn.addEventListener("click", () => {
    if (btn.dataset.action === running) { tripUi.rodView = true; tripRender(); } // the running action: its rod screen (End action is there)
    else tripOnAction(btn.dataset.action);
  }));
  root.querySelectorAll("[data-action-edit]").forEach((btn) => btn.addEventListener("click", () => tripOpenDefaults({ tripId: state.tripId, actionId: btn.dataset.actionEdit })));
  document.getElementById("tripWaterBtn").addEventListener("click", tripOnWater);
  document.getElementById("tripDepthBtn").addEventListener("click", tripOpenDepth);
  document.getElementById("tripEndBtn").addEventListener("click", tripOnEnd);
  tripTickElapsed();
}

function tripTickElapsed() {
  const el = document.getElementById("tripElapsed");
  if (!el) return;
  const state = getLiveTripState();
  const start = state ? tripRunStartMs(state.runId) : null;
  el.textContent = start ? tsElapsedText(start, Date.now()) : "";
}

// --- The rod screen: the running action's four rod positions as a 2x2 grid (the controller's rod screen) ----------------------

function tripRenderRods(root, state, trip) {
  const action = tsRunningAction();
  if (!action) { tripUi.rodView = false; tripRender(); return; }
  const slots = tdRodSlots(action, liveTripData.rodSetups);
  const d = getLiveMarkDefaults();
  const dis = tripUi.busy ? " disabled" : "";
  const moving = tripUi.move;
  const cells = slots.map((id, i) => {
    const setup = id ? liveTripData.rodSetups.find((r) => r.id === id) : null;
    const cls = "trip-rod" + (setup ? " filled" : " empty") + (moving && moving.from === i ? " moving" : "");
    if (!setup) return `<div class="trip-rod-wrap"><button type="button" class="${cls}" data-rod="${i}"${dis}><span class="trip-rod-empty">empty</span></button></div>`;
    const c = tsRodCell(setup);
    const image = tsRodImage(setup, tripUi.td); // the first picture of its bait option / bait / rig option, fitted under a dark veil
    const picture = image ? `<img class="trip-rod-img" src="${escapeHtml(speciesImageUrl(image))}" alt="" loading="lazy" />` : "";
    // the catch and gear buttons are siblings of the cell button (a button can't hold a button): bottom left logs a catch on this rod,
    // bottom right opens that rod setup's whole edit screen; tapping the box itself changes its bait / rig option
    return `<div class="trip-rod-wrap"><button type="button" class="${cls}${image ? " has-img" : ""}" data-rod="${i}"${dis}>${picture}<span class="trip-rod-name">${escapeHtml(c.name)}</span><span class="trip-rod-bait">${escapeHtml(c.bait)}</span><span class="trip-rod-rig">${escapeHtml(c.rig)}</span></button>` +
      `<button type="button" class="trip-rod-catch" data-rod-catch="${escapeHtml(setup.id)}" aria-label="Catch on ${escapeHtml(setup.name)}"${dis}>${TRIP_FISH_ICON}</button>` +
      `<button type="button" class="trip-rod-gear" data-rod-edit="${escapeHtml(setup.id)}" aria-label="Edit ${escapeHtml(setup.name)}"${dis}>${TD_GEAR_SVG}</button>` +
      `<button type="button" class="trip-rod-remove" data-rod-remove="${i}" aria-label="Remove ${escapeHtml(setup.name)} from this action"${dis}>&times;</button></div>`;
  });
  const hint = moving ? (moving.from == null ? "Move: tap the rod to pick up." : "Tap a position to drop it there.") : "Tap a rod to change its bait or rig option; the fish logs a catch on it; tap empty to fill it.";
  root.innerHTML = `
    <div class="trip-card trip-status">
      <div><div class="trip-status-name">${escapeHtml(trip.name)}</div><div class="trip-muted trip-status-action">${escapeHtml(action.name)}</div></div>
      <div class="trip-status-time" id="tripElapsed" aria-label="Time on this trip"></div>
    </div>
    <div class="trip-conditions">
      <button type="button" class="trip-cond" id="tripWaterBtn"><span class="trip-cond-label">Water</span><span class="trip-cond-value">${escapeHtml(d.water || "—")}</span></button>
      <button type="button" class="trip-cond" id="tripDepthBtn"><span class="trip-cond-label">Depth</span><span class="trip-cond-value">${d.depth != null ? escapeHtml(d.depth.toFixed(1)) + " m" : "—"}</span></button>
    </div>
    <div class="trip-rods">${cells.join("")}</div>
    <p class="trip-muted trip-hint">${hint}</p>
    <div class="trip-row">
      <button type="button" class="trip-small${moving ? " on" : ""}" id="tripMoveBtn"${dis}>${moving ? "Cancel move" : "Move rods"}</button>
      <button type="button" class="trip-small" id="tripCatchBtn"${dis}>+ Catch (any rod)</button>
      <button type="button" class="trip-small" id="tripEditActionBtn"${dis}>Edit action</button>
      <button type="button" class="trip-small" id="tripListBtn">All actions</button>
    </div>
    <button type="button" class="trip-big trip-end-action" id="tripEndActionBtn"${dis}>${TRIP_STOP_ICON}<span>End action</span></button>
    <button type="button" class="trip-big trip-end" id="tripEndBtn"${dis}>${TRIP_STOP_ICON}<span>End trip</span></button>`;
  root.querySelectorAll("[data-rod]").forEach((btn) => btn.addEventListener("click", () => tripOnRod(Number(btn.dataset.rod), action, slots)));
  root.querySelectorAll("[data-rod-catch]").forEach((btn) => btn.addEventListener("click", () => { if (!tripUi.busy && !tripUi.overlayOpen && !tripUi.move) tripStartCatch(btn.dataset.rodCatch); }));
  root.querySelectorAll("[data-rod-remove]").forEach((btn) => btn.addEventListener("click", () => {
    if (tripUi.busy || tripUi.overlayOpen || tripUi.move) return;
    const next = slots.slice();
    next[Number(btn.dataset.rodRemove)] = null; // off this action's grid; the rod setup itself stays
    tripGuard(() => tsSetRodSlots(action.id, next));
  }));
  root.querySelectorAll("[data-rod-edit]").forEach((btn) => btn.addEventListener("click", () => tripOpenDefaults({ tripId: state.tripId, actionId: action.id, rodId: btn.dataset.rodEdit })));
  document.getElementById("tripMoveBtn").addEventListener("click", () => { tripUi.move = tripUi.move ? null : { from: null }; tripRender(); });
  document.getElementById("tripCatchBtn").addEventListener("click", () => tripStartCatch());
  document.getElementById("tripEditActionBtn").addEventListener("click", () => tripOpenDefaults({ tripId: state.tripId, actionId: action.id }));
  document.getElementById("tripListBtn").addEventListener("click", () => { tripUi.rodView = false; tripUi.move = null; tripRender(); });
  document.getElementById("tripEndActionBtn").addEventListener("click", () => tripOnAction(action.id));
  document.getElementById("tripWaterBtn").addEventListener("click", tripOnWater);
  document.getElementById("tripDepthBtn").addEventListener("click", tripOpenDepth);
  document.getElementById("tripEndBtn").addEventListener("click", tripOnEnd);
  tripTickElapsed();
}

function tripOnRod(index, action, slots) {
  if (tripUi.busy || tripUi.overlayOpen) return;
  const move = tripUi.move;
  if (move) {
    if (move.from == null) {
      if (!slots[index]) return; // nothing there to pick up
      tripUi.move = { from: index };
      tripRender();
      return;
    }
    const from = move.from;
    tripUi.move = null;
    if (from === index) { tripRender(); return; }
    tripGuard(() => tsSetRodSlots(action.id, tsSwapRodSlots(slots, from, index)));
    return;
  }
  if (slots[index]) tripQuickEditRod(liveTripData.rodSetups.find((r) => r.id === slots[index]));
  else tripFillRod(index, action, slots);
}

// Tap a filled rod position: change what is on the rod without opening the whole setup (the controller's quickEditRod). With bait on the
// rod setup that is its bait, then each chosen bait's options; with no bait it is the sub option of its rig.
async function tripQuickEditRod(setup) {
  if (!setup) return;
  if (!tripUi.td) await tripLoadTd();
  const td = tripUi.td;
  if (!td) { showLiveToast("Couldn't load your lists.", true); return; }
  const rigRow = td.rigRows.find((r) => r.value === setup.rig);
  const rigOptions = tdRigSublist(rigRow, td.overrides);
  const kind = tsQuickEditKind(setup, rigOptions);
  if (!kind) {
    showLiveToast("Nothing to change here — the gear opens the rod setup", true);
    return;
  }
  tripUi.overlayOpen = true;
  let flow = null;
  const done = async (patch) => {
    flow.close();
    tripUi.overlayOpen = false;
    if (!patch) { tripRender(); return; }
    tripUi.busy = true;
    tripRender();
    try {
      await tsSaveRodSetup(setup.id, patch);
      tripLoadTd(); // its pictures follow the new bait / option
    } catch (err) {
      showLiveToast("Not saved: " + err.message, true);
    } finally {
      tripUi.busy = false;
      tripRender();
    }
  };
  const onClose = () => { tripUi.overlayOpen = false; tripRender(); };

  if (kind === "sublist") {
    const NONE = "None";
    let chosen = (setup.subListItems || [])[0] || NONE;
    const thumbs = rigOptionThumbs(rigRow, td.overrideImages);
    flow = showCardFlow({
      getSteps: () => [{ id: "sub", title: `${setup.rig} options`, prompt: `${setup.name}: which option?`, multi: false, options: [NONE, ...rigOptions], selected: [chosen], thumbs }],
      onChoose: (step, value) => { chosen = value; },
      onDone: () => {
        const next = chosen === NONE ? [] : [chosen];
        done(JSON.stringify(next) === JSON.stringify(setup.subListItems || []) ? null : { subListItems: next });
      },
      onClose,
      doneLabel: "Save",
    });
    return;
  }

  // Bait (any number), then one card of options per chosen bait that has some.
  const allBaits = td.options.baits;
  let baits = allBaits.filter((b) => (setup.bait || []).includes(b));
  const ownOf = (b) => tdBaitOptionsFor([b], td.baitRows, td.overrides, td.overrideImages);
  const picked = {}; // bait -> its options picked
  for (const b of setup.bait || []) picked[b] = ownOf(b).options.filter((o) => (setup.baitOptions || []).includes(o));
  flow = showCardFlow({
    getSteps: () => [
      { id: "bait", title: "Bait", prompt: `${setup.name}: what bait?`, multi: true, options: allBaits, selected: baits, ...stepThumbs(td.options, "baits") },
      ...baits.filter((b) => ownOf(b).options.length).map((b) => ({
        id: `opt:${b}`, title: `${b} options`, prompt: `${b}: how is it prepared?`, multi: true, options: ownOf(b).options, selected: picked[b] || [], thumbs: ownOf(b).thumbs,
      })),
    ],
    onChoose: (step, value) => {
      if (step.id === "bait") baits = tsToggleOrdered(baits, value, allBaits);
      else {
        const b = step.id.slice(4);
        picked[b] = tsToggleOrdered(picked[b] || [], value, ownOf(b).options);
      }
    },
    onDone: () => {
      const order = tdBaitOptionsFor(baits, td.baitRows, td.overrides).options;
      const options = order.filter((o) => baits.some((b) => (picked[b] || []).includes(o)));
      const same = JSON.stringify(baits) === JSON.stringify(setup.bait || []) && JSON.stringify(options) === JSON.stringify(setup.baitOptions || []);
      done(same ? null : { bait: baits, baitOptions: options });
    },
    onClose,
    doneLabel: "Save",
  });
}

// An empty position: fill it with any rod setup the action doesn't already use.
function tripFillRod(index, action, slots) {
  const free = liveTripData.rodSetups.filter((r) => !slots.includes(r.id));
  if (!free.length) {
    showLiveToast("No other rod setups — add some in Trip Defaults", true);
    return;
  }
  tripUi.overlayOpen = true;
  let chosen = null;
  let flow = null;
  flow = showCardFlow({
    getSteps: () => [{ id: "rod", title: "Fill position", prompt: "Which rod setup?", multi: false, options: free.map((r) => r.name), selected: chosen ? [chosen.name] : [] }],
    onChoose: (step, value) => { chosen = free.find((r) => r.name === value) || null; },
    onDone: () => {
      flow.close();
      tripUi.overlayOpen = false;
      if (!chosen) { tripRender(); return; }
      const next = slots.slice();
      next[index] = chosen.id;
      tripGuard(() => tsSetRodSlots(action.id, next));
    },
    onClose: () => { tripUi.overlayOpen = false; tripRender(); },
    doneLabel: "Fill",
  });
}

// --- Actions ---------------------------------------------------------------------------------------------------

async function tripGuard(fn) {
  if (tripUi.busy || tripUi.overlayOpen) return;
  tripUi.busy = true;
  tripRender(); // buttons disabled while a GPS fix and the saves run
  try {
    await fn();
  } catch (err) {
    showLiveToast(err.message, true);
  } finally {
    tripUi.busy = false;
    tripRender();
  }
}

function tripOnStart(tripId) {
  const trip = liveTripData && liveTripData.trips.find((t) => t.id === tripId);
  if (!trip) return;
  tripGuard(async () => {
    tsStartTrip(trip);
    getFreshGpsPosition(); // not awaited: warms the GPS so the first action is quick
    showLiveToast(`${trip.name} started`);
  });
}

function tripOnAction(actionId) {
  tripGuard(async () => {
    const result = await tsTapAction(actionId);
    tripUi.rodView = result.kind === "started"; // starting an action opens its rod screen, as on the controller
    tripUi.move = null;
    showLiveToast(`${result.action.name} ${result.kind}`);
  });
}

async function tripOnEnd() {
  if (tripUi.busy || tripUi.overlayOpen) return;
  if (!(await confirmDialog("End this trip?", { title: "End trip", confirmLabel: "End trip", danger: true }))) return;
  tripGuard(async () => {
    await tsEndTrip();
    showLiveToast("Trip ended");
  });
}

async function tripOnWater() {
  if (tripUi.busy) return;
  if (!tripUi.waterOptions) await tripLoadCardOptions();
  tsCycleWater(tripUi.waterOptions || []);
  tripRender();
}

// "+ Add trip": creates it, then opens its settings to add actions.
async function tripAddTrip(name) {
  const value = String(name || "").trim();
  tripUi.adding = false;
  if (!value) { tripRender(); return; }
  if (tdHasValue(liveTripData.trips.map((t) => t.name), value)) {
    showLiveToast(`You already have a trip named "${value}".`, true);
    tripRender();
    return;
  }
  try {
    const created = await tdApi("/api/tripsetups", "POST", { name: value });
    liveTripData.trips.push(created);
    liveTripData.trips.sort((x, y) => x.name.localeCompare(y.name));
    tripRender();
    tripOpenDefaults({ tripId: created.id });
  } catch (err) {
    showLiveToast("Trip not added: " + err.message, true);
    tripRender();
  }
}

async function tripOpenDefaults(start) {
  if (tripUi.overlayOpen) return;
  tripUi.overlayOpen = true;
  await showTripDefaults({
    start: start && (start.actionId || start.tripId) ? start : undefined,
    onClose: () => {
      tripUi.overlayOpen = false;
      tripLoadData().then(tripRender); // its trips / actions / rod setups may just have been edited
      tripLoadTd().then(tripRender);
    },
  });
}

// --- Depth: a full-screen stepper, saved as it changes, logged once when closed -----------------------------------

function tripOpenDepth() {
  if (tripUi.overlayOpen) return;
  tripUi.overlayOpen = true;
  const overlay = document.createElement("div");
  overlay.className = "live-card-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  document.body.appendChild(overlay);
  document.body.classList.add("live-card-open");
  const depthAtOpen = getLiveMarkDefaults().depth;
  const close = () => {
    overlay.remove();
    document.body.classList.remove("live-card-open");
    tripUi.overlayOpen = false;
    if (getLiveMarkDefaults().depth !== depthAtOpen) liveLogConditionChange("depth"); // one log row for the whole stepping
    tripRender();
  };
  const render = () => {
    const depth = getLiveMarkDefaults().depth;
    overlay.innerHTML = `
      <div class="live-card">
        <div class="live-card-head">
          <h2 class="live-card-title">Water depth</h2>
          <p class="live-card-prompt">Depth for new marks${depth == null ? " (not set)" : ""}</p>
        </div>
        <div class="live-card-grid live-card-grid-stepper">
          <div class="live-card-stepper">
            <div class="live-card-stepper-row">
              <button type="button" class="live-card-choice live-card-step-btn" data-depth="-1" aria-label="One metre shallower">&minus;</button>
              <div class="live-card-stepper-value">${depth == null ? "—" : escapeHtml(depth.toFixed(1))}<span class="live-card-stepper-unit"> m</span></div>
              <button type="button" class="live-card-choice live-card-step-btn" data-depth="1" aria-label="One metre deeper">+</button>
            </div>
            <div class="live-card-stepper-row-fine">
              <button type="button" class="live-card-choice live-card-step-btn-fine" data-depth="-0.1">&minus; 0.1 m</button>
              <button type="button" class="live-card-choice live-card-step-btn-fine" data-depth="0.1">+ 0.1 m</button>
            </div>
          </div>
        </div>
        <div class="live-card-nav live-card-nav-2">
          <button type="button" class="live-card-nav-btn" data-depth-clear>Clear</button>
          <button type="button" class="live-card-nav-btn live-card-next" data-depth-done>Done</button>
        </div>
      </div>`;
    overlay.querySelectorAll("[data-depth]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const cur = getLiveMarkDefaults().depth;
        tsSetDepth(Math.max(0, Math.round(((cur ?? 0) + Number(btn.dataset.depth)) * 10) / 10));
        render();
      })
    );
    overlay.querySelector("[data-depth-clear]").addEventListener("click", () => { tsSetDepth(null); render(); });
    overlay.querySelector("[data-depth-done]").addEventListener("click", close);
  };
  render();
}

// --- Catch: the same cards as the Map's Live +Catch (map-live.js startLiveCatch) -----------------------------------

async function tripStartCatch(rodId = null) {
  if (tripUi.busy || tripUi.overlayOpen) return;
  const action = tsRunningAction();
  if (!action) return;
  tripUi.overlayOpen = true;
  const gpsPromise = getFreshGpsPosition(); // that is where the fish was, so the fix starts straight away
  const options = await tripLoadCardOptions();
  if (!tripUi.catchesLoaded) await tripLoadRecentCatches();
  const defaults = tsCatchDefaultsForAction(liveTripData, action, getLiveMarkDefaults().water, rodId);
  const answers = {};
  const ctx = { ...tripCatchContext(), depthDefault: getLiveMarkDefaults().depth ?? getLastMarkFieldValues().waterDepth ?? null };
  let flow = null;
  const finish = () => { tripUi.overlayOpen = false; tripRender(); };
  flow = showCardFlow({
    getSteps: () => buildCatchCardSteps(options, defaults, { ...ctx, answers }),
    onChoose: (step, value) => {
      if (step.id === "size") {
        answers.size = applySizeAction(answers.size, value, catchCardState(options, { ...ctx, answers }).start);
      } else if (step.id === "species") {
        if (answers.species !== value) { delete answers.size; delete answers.fate; } // a different species: its own size range and bag
        answers.species = answers.species === value ? "" : value;
      } else if (step.id === "fate") {
        answers.fate = value;
      } else if (step.id === "depth") {
        answers.depth = applyDepthAction(catchCardState(options, { ...ctx, answers }).depth, value);
      } else if (step.id === "baitOptions") {
        const current = Array.isArray(answers.baitOptions) ? answers.baitOptions : step.selected;
        answers.baitOptions = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
      } else {
        if (step.id === "bait" && answers.bait !== value) delete answers.baitOptions;
        answers[step.id] = answers[step.id] === value ? "" : value;
      }
    },
    onDone: async () => {
      flow.close();
      tripUi.overlayOpen = false;
      tripUi.busy = true;
      tripRender();
      try {
        const result = await tsSaveCatch(options, answers, defaults, gpsPromise, ctx);
        if (!result.ok) {
          showLiveToast(result.error, true);
          return;
        }
        const m = result.mark;
        tripUi.catches = [...tripUi.catches, ...catchesFromMarks([m], parseNaive)];
        const after = tripCatchContext();
        const counts = after.run ? speciesCounts(after.run, options.limits || {}, result.st.species) : null;
        showLiveToast(catchSavedMessage(result.st, counts));
      } catch (err) {
        showLiveToast("Catch not saved: " + err.message, true);
      } finally {
        tripUi.busy = false;
        tripRender();
      }
    },
    onClose: finish,
    doneLabel: "Save catch",
  });
}

// --- Keeping in step with other devices (the Map, the Fishing Controller) ----------------------------------------------

let tripSyncAt = 0;
async function tripSync() {
  if (tripUi.busy || tripUi.overlayOpen || document.hidden) return;
  if (Date.now() - tripSyncAt < 15000) return;
  tripSyncAt = Date.now();
  await Prefs.refresh();
  flushTripLog(); // entries that couldn't be sent earlier (offline)
  enrichTripLog();
  if (tripStateKey() !== tripUi.lastKey) {
    if (getLiveTripState() && !liveTripData) await tripLoadData();
    tripRender();
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const gate = document.getElementById("tripNotConnected");
  const app = tripApp();
  await refreshAdminStatus();
  if (!cachedIsSignedIn) {
    gate.style.display = "block";
    return;
  }
  app.style.display = "block";
  await Prefs.load();
  tripRender(); // "Loading…" while the trips come in
  await tripLoadData();
  tripRender();
  flushTripLog();
  tripLoadRecentCatches();
  tripLoadTd().then(tripRender); // the rod pictures come in once the lists have loaded
  setInterval(tripTickElapsed, 1000);
  setInterval(tripSync, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tripSync(); });
});
