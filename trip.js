// Trip tab (trip.html): record a trip from a phone, the way the Fishing Controller does — Start trip -> tap an Action to run it ->
// + Catch -> Water / Depth always on screen -> End trip. Tap-only (no rotary dial). The logic is js/trip-session.js; the catch question
// cards are js/live-cards.js (showCardFlow); editing an Action / Rod Setup is Trip Defaults (js/trip-defaults.js).

const tripUi = { busy: false, overlayOpen: false, waterOptions: null, catches: [], catchesLoaded: false, lastKey: "" };

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
        ? `<div class="trip-list">${trips.map((t) => `<button type="button" class="trip-big trip-go" data-trip="${escapeHtml(t.id)}"${tripUi.busy ? " disabled" : ""}>${TRIP_PLAY_ICON}<span>${escapeHtml(t.name)}</span></button>`).join("")}</div>`
        : `<p class="trip-muted">No trips yet — add one in Trip Defaults.</p>`}
      <button type="button" class="trip-link" id="tripDefaultsBtn">Trip Defaults</button>
    </div>`;
  root.querySelectorAll("[data-trip]").forEach((btn) => btn.addEventListener("click", () => tripOnStart(btn.dataset.trip)));
  document.getElementById("tripDefaultsBtn").addEventListener("click", () => tripOpenDefaults());
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
  const d = getLiveMarkDefaults();
  const actions = tdActionsForTrip(liveTripData.actions, trip.id);
  const dis = tripUi.busy ? " disabled" : "";
  root.innerHTML = `
    <div class="trip-card trip-status">
      <div class="trip-status-name">${escapeHtml(trip.name)}</div>
      <div class="trip-status-time" id="tripElapsed" aria-label="Time on this trip"></div>
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
    <button type="button" class="trip-big trip-catch" id="tripCatchBtn"${session && !tripUi.busy ? "" : " disabled"}>${TRIP_FISH_ICON}<span>+ Catch</span></button>
    <div class="trip-conditions">
      <button type="button" class="trip-cond" id="tripWaterBtn"><span class="trip-cond-label">Water</span><span class="trip-cond-value">${escapeHtml(d.water || "—")}</span></button>
      <button type="button" class="trip-cond" id="tripDepthBtn"><span class="trip-cond-label">Depth</span><span class="trip-cond-value">${d.depth != null ? escapeHtml(d.depth.toFixed(1)) + " m" : "—"}</span></button>
    </div>
    <button type="button" class="trip-big trip-end" id="tripEndBtn"${dis}>${TRIP_STOP_ICON}<span>End trip</span></button>`;
  root.querySelectorAll("[data-action]").forEach((btn) => btn.addEventListener("click", () => tripOnAction(btn.dataset.action)));
  root.querySelectorAll("[data-action-edit]").forEach((btn) => btn.addEventListener("click", () => tripOpenDefaults({ tripId: state.tripId, actionId: btn.dataset.actionEdit })));
  document.getElementById("tripCatchBtn").addEventListener("click", tripStartCatch);
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
    showLiveToast(`${result.action.name} ${result.kind}`);
  });
}

function tripOnEnd() {
  if (tripUi.busy || tripUi.overlayOpen) return;
  if (!confirm("End this trip?")) return;
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

async function tripOpenDefaults(start) {
  if (tripUi.overlayOpen) return;
  tripUi.overlayOpen = true;
  await showTripDefaults({
    start: start && start.actionId ? start : undefined,
    onClose: () => {
      tripUi.overlayOpen = false;
      tripLoadData().then(tripRender); // its trips / actions / rod setups may just have been edited
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

async function tripStartCatch() {
  if (tripUi.busy || tripUi.overlayOpen) return;
  const action = tsRunningAction();
  if (!action) return;
  tripUi.overlayOpen = true;
  const gpsPromise = getFreshGpsPosition(); // that is where the fish was, so the fix starts straight away
  const options = await tripLoadCardOptions();
  if (!tripUi.catchesLoaded) await tripLoadRecentCatches();
  const defaults = tsCatchDefaultsForAction(liveTripData, action, getLiveMarkDefaults().water);
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
  setInterval(tripTickElapsed, 1000);
  setInterval(tripSync, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tripSync(); });
});
