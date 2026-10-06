// Trip recording without the map (trip.html). The same running-trip state, trip log entries and Catch marks the Map's Live mode makes
// (map-live.js "Live trips"), ported without any Leaflet dependency so a phone can record a whole trip from the Trip tab.
// Until the Map's own trip UI is retired the two are twins: a change to what a trip event logs belongs in both.
// The names shared with map-live.js (getLiveTripState, getLiveMarkDefaults, liveTripRunState, liveTripPosition, showLiveToast ...) are what
// js/trip-defaults.js and js/trip-log.js look for, so they keep their names; the two files are never loaded on the same page.
// Everything above "// --- Effects" is pure (unit-tested: tests/trip-session.test.mjs).

const LIVE_TRIP_KEY = "liveActiveTrip";
const LIVE_MARK_DEFAULTS_KEY = "liveMarkDefaults";

// --- Pure helpers ----------------------------------------------------------------------------------------------

/** The next value when cycling `options` from `current`: each option in turn, then none ("") after the last. */
function nextCycleValue(options, current) {
  if (!options.length) return "";
  const i = options.indexOf(current);
  if (i === -1) return options[0];
  return i + 1 < options.length ? options[i + 1] : "";
}

/** The state of a trip that has just started: no Action yet. */
function tsStartTripState(trip, runId) {
  return { tripId: trip.id, runId };
}

/** Starting an Action (ends the running one implicitly). `sessionNumber` counts the run's Actions from 1. */
function tsStartActionState(state, actionId, sessionGroupId) {
  const n = Number.isFinite(state.sessionNumber) ? state.sessionNumber : 0;
  return { tripId: state.tripId, actionId, sessionGroupId, runId: state.runId, sessionNumber: n + 1 };
}

/** Ending the running Action: the trip carries on with no Action, keeping its run id and count. */
function tsEndActionState(state) {
  return { tripId: state.tripId, runId: state.runId, sessionNumber: state.sessionNumber };
}

/** {actionId, sessionGroupId, number} while an Action is running, else null (twin of map-live.js liveActiveSession). */
function tsActiveSession(state) {
  if (!state || !state.actionId || !state.sessionGroupId) return null;
  return { actionId: state.actionId, sessionGroupId: state.sessionGroupId, number: Number.isFinite(state.sessionNumber) ? state.sessionNumber : null };
}

/** Moves / swaps two rod positions of the 2x2 grid: an empty target just takes the setup, a taken one swaps (as the controller's rod screen). */
function tsSwapRodSlots(slots, from, to) {
  const next = slots.slice();
  if (from === to || from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
  const moved = next[from];
  next[from] = next[to];
  next[to] = moved;
  return next;
}

/** What a rod position shows: the setup's name, its bait (with options) and its rig options (else the rig) — the controller's rodCell. */
function tsRodCell(setup) {
  const bait = !(setup.bait || []).length ? "no bait" : setup.bait.join(", ") + ((setup.baitOptions || []).length ? ` (${setup.baitOptions.join(", ")})` : "");
  const rig = (setup.subListItems || []).length ? setup.subListItems.join(", ") : setup.rig || "";
  return { name: setup.name, bait, rig };
}

/** What tapping a rod position edits (the controller's quickEditRod): its bait (then each bait's options) when it has bait, else its rig option, else nothing. */
function tsQuickEditKind(setup, rigOptions) {
  if ((setup.bait || []).length) return "bait";
  if ((rigOptions || []).length) return "sublist";
  return null;
}

/** `list` with `value` toggled, keeping the order of `order` (so baits stay in list order). */
function tsToggleOrdered(list, value, order) {
  const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  return order.filter((v) => next.includes(v));
}

/**
 * The picture a rod position shows (as the controller's rodCell): the first picture among its bait options, then its baits, then its rig options.
 * `td` is tdLoadAll()'s data (the pictures live on the Mark Lists). {id, version} or null.
 */
function tsRodImage(setup, td) {
  if (!td) return null;
  for (const o of setup.baitOptions || []) {
    for (const b of setup.bait || []) {
      const t = tdBaitOptionsFor([b], td.baitRows, td.overrides, td.overrideImages).thumbs[o];
      if (t) return t;
    }
  }
  for (const b of setup.bait || []) {
    const t = td.options.thumbs.baits[b];
    if (t) return t;
  }
  const rigRow = td.rigRows.find((r) => r.value === setup.rig);
  const thumbs = rigOptionThumbs(rigRow, td.overrideImages);
  for (const o of setup.subListItems || []) if (thumbs[o]) return thumbs[o];
  return null;
}

/**
 * Catch-card defaults from a trip Action (twin of map-live.js liveCatchDefaultsForAction; `data` = {trips, actions, rodSetups}).
 * `rodId`: a catch started from a rod position uses just that rod setup (the Rod question is skipped, everything defaults from it).
 */
function tsCatchDefaultsForAction(data, action, water, rodId = null) {
  let setups = tdLiveRodSetupIds(action.rodSetupIds, data.rodSetups).map((id) => data.rodSetups.find((r) => r.id === id));
  const forced = rodId ? data.rodSetups.find((r) => r.id === rodId) : null;
  if (forced) setups = [forced];
  return {
    forcedRod: forced || null,
    species: action.species || [],
    bait: [...new Set(setups.flatMap((s) => (s && s.bait) || []))],
    baitOptionsFor: (rodName) => {
      const chosen = setups.length === 1 ? setups[0] : setups.find((x) => x && x.name === rodName);
      return [...new Set((chosen && chosen.baitOptions) || [])];
    },
    otherTargets: tdOtherTargets(data.actions, action),
    water: water || "",
    berley: action.berley || "",
    fishingMethod: action.fishingMethod || [],
    rods: setups.length > 1 ? setups.map((s) => s.name) : [],
    skipRod: setups.length <= 1,
    rodTitle: "Rod setup",
    rodPrompt: "Which rod setup?",
    rodSetups: {},
    tripAction: action,
    tripRodSetups: setups,
  };
}

/** "1:05:09" / "42:10": the time since `startMs`. */
function tsElapsedText(startMs, nowMs) {
  const secs = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

// --- Effects: storage, GPS, network -----------------------------------------------------------------------------

let liveTripData = null; // {trips, actions, rodSetups}, loaded by tsLoadTripData
let tsLastPosition = null; // the last GPS fix, for log rows made without a fresh one

function showLiveToast(text, isError) {
  const el = document.createElement("div");
  el.className = "live-card-toast" + (isError ? " error" : "");
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), isError ? 6000 : 2500);
}

/** One fresh, high-accuracy GPS fix: {lat, lng}, or null if unavailable, denied or timed out. */
function getFreshGpsPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { tsLastPosition = { lat: p.coords.latitude, lng: p.coords.longitude }; resolve(tsLastPosition); },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}
function liveTripPosition() {
  return tsLastPosition;
}

// The running trip is an account setting (js/prefs.js), shared with the Map, other devices and the Fishing Controller.
// "No trip" is stored as {"tripId":null}, a value rather than a removal.
function getLiveTripState() {
  try {
    const state = JSON.parse(localStorage.getItem(LIVE_TRIP_KEY));
    return state && state.tripId ? state : null;
  } catch {
    return null;
  }
}
function setLiveTripState(state) {
  Prefs.set(LIVE_TRIP_KEY, JSON.stringify(state && state.tripId ? state : { tripId: null }));
}
/** The running trip's state with a run id (a trip started before the log existed gets one now), or null. */
function liveTripRunState() {
  const state = getLiveTripState();
  if (!state) return null;
  if (state.runId) return state;
  const withRun = { ...state, runId: tripLogNewRunId() };
  setLiveTripState(withRun);
  return withRun;
}
function liveActiveSession() {
  return tsActiveSession(getLiveTripState());
}

// Water / Depth: device-local defaults for the marks made on a trip (same key as the Map's Live buttons).
function getLiveMarkDefaults() {
  try {
    const raw = JSON.parse(localStorage.getItem(LIVE_MARK_DEFAULTS_KEY)) || {};
    return { water: typeof raw.water === "string" ? raw.water : "", depth: Number.isFinite(raw.depth) ? raw.depth : null };
  } catch {
    return { water: "", depth: null };
  }
}
function setLiveMarkDefaults(next) {
  try {
    localStorage.setItem(LIVE_MARK_DEFAULTS_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable: the default just won't survive a reload
  }
}

async function tsLoadTripData() {
  const [trips, actions, rodSetups] = await Promise.all([tdApi("/api/tripsetups"), tdApi("/api/tripactions"), tdApi("/api/rodsetups")]);
  liveTripData = { trips, actions, rodSetups };
  return liveTripData;
}

function liveTripNameOf(tripId) {
  const trip = liveTripData && (liveTripData.trips || []).find((t) => t.id === tripId);
  return trip ? trip.name : null;
}
/** The running Action object, or null. */
function tsRunningAction() {
  const state = getLiveTripState();
  if (!state || !state.actionId || !liveTripData) return null;
  return liveTripData.actions.find((a) => a.id === state.actionId) || null;
}

/** Logs a Water / Depth change made while an Action runs: a `change` row carrying the whole state in force. */
function liveLogConditionChange(field) {
  const state = liveTripRunState();
  const action = state && state.actionId ? tsRunningAction() : null;
  if (!action) return;
  const d = getLiveMarkDefaults();
  const pos = liveTripPosition();
  logTripEvent(state, {
    type: "change", changeField: field, tripId: state.tripId, tripName: liveTripNameOf(state.tripId), sessionGroupId: state.sessionGroupId || null,
    water: d.water || null, depth: d.depth, lat: pos ? pos.lat : null, lng: pos ? pos.lng : null, ...tripLogActionState(action, liveTripData.rodSetups),
  });
}

/** Start a trip (no Action yet). */
function tsStartTrip(trip) {
  const started = tsStartTripState(trip, tripLogNewRunId());
  setLiveTripState(started);
  const pos = liveTripPosition();
  logTripEvent(started, { type: "trip_start", tripId: trip.id, tripName: trip.name, lat: pos ? pos.lat : null, lng: pos ? pos.lng : null });
}

/** Tap an Action: ends it when it is the running one, else starts it (the running one ends implicitly). Throws without a GPS fix. */
async function tsTapAction(actionId) {
  const state = getLiveTripState();
  const action = liveTripData && liveTripData.actions.find((a) => a.id === actionId);
  if (!state || !action) throw new Error("No such action");
  const position = await getFreshGpsPosition();
  if (!position) throw new Error("Couldn't get your location — nothing saved.");
  const runState = liveTripRunState() || state;
  const runId = runState.runId;
  const d = getLiveMarkDefaults();
  if (state.actionId === actionId && tsActiveSession(state)) {
    setLiveTripState(tsEndActionState({ ...state, runId }));
    logTripEvent({ ...runState, runId }, {
      type: "action_end", tripId: state.tripId, tripName: liveTripNameOf(state.tripId), actionId: action.id, actionName: action.name, sessionGroupId: state.sessionGroupId || null,
      water: d.water || null, depth: d.depth, lat: position.lat, lng: position.lng,
    });
    return { kind: "ended", action };
  }
  const sessionGroupId = makeMarkId();
  setLiveTripState(tsStartActionState({ ...state, runId }, actionId, sessionGroupId));
  logTripEvent({ ...runState, runId }, {
    type: "action_start", tripId: state.tripId, tripName: liveTripNameOf(state.tripId), sessionGroupId,
    water: d.water || null, depth: d.depth ?? getLastMarkFieldValues().waterDepth ?? null, lat: position.lat, lng: position.lng, ...tripLogActionState(action, liveTripData.rodSetups),
  });
  return { kind: "started", action };
}

/** End the trip: logs the end of the running Action (if any) with the trip, then clears the trip. Throws without a GPS fix while an Action runs. */
async function tsEndTrip() {
  const state = getLiveTripState();
  if (!state) return;
  let position = liveTripPosition();
  if (tsActiveSession(state)) {
    position = await getFreshGpsPosition(); // an Action is running: the trip ends where you are
    if (!position) throw new Error("Couldn't get your location — trip not ended.");
  }
  const runState = liveTripRunState() || state;
  const d = getLiveMarkDefaults();
  logTripEvent(runState, {
    type: "trip_end", tripId: state.tripId, tripName: liveTripNameOf(state.tripId), actionId: state.actionId || null, sessionGroupId: state.sessionGroupId || null,
    water: d.water || null, depth: d.depth, lat: position ? position.lat : null, lng: position ? position.lng : null,
  });
  setLiveTripState(null);
}

/** Saves an Action's four rod positions (like Trip Defaults' rod grid) and logs it as a change while that Action runs. */
async function tsSetRodSlots(actionId, slots) {
  const saved = await tdApi(`/api/tripactions/${actionId}`, "PUT", { rodSlots: slots });
  const i = liveTripData.actions.findIndex((a) => a.id === actionId);
  if (i >= 0) liveTripData.actions[i] = saved;
  tripLogNoteDefaultsEdit("/api/tripactions", actionId, liveTripData, liveTripRunState(), liveTripPosition());
}

/** Saves a Rod Setup change (bait / baitOptions / subListItems) and logs it as a change while an Action using it runs. */
async function tsSaveRodSetup(id, patch) {
  const saved = await tdApi(`/api/rodsetups/${id}`, "PUT", patch);
  const i = liveTripData.rodSetups.findIndex((r) => r.id === id);
  if (i >= 0) liveTripData.rodSetups[i] = saved;
  tripLogNoteDefaultsEdit("/api/rodsetups", id, liveTripData, liveTripRunState(), liveTripPosition());
  return saved;
}

/** Water button: the next Water Condition from `options` (then none), logged as a change while an Action runs. */
function tsCycleWater(options) {
  const d = getLiveMarkDefaults();
  setLiveMarkDefaults({ ...d, water: nextCycleValue(options, d.water) });
  liveLogConditionChange("water");
}

/** Depth stepper: sets the depth default (null clears). The caller logs the change once, when stepping is finished. */
function tsSetDepth(depth) {
  setLiveMarkDefaults({ ...getLiveMarkDefaults(), depth });
}

/**
 * Saves a Catch from the answered cards on the running Action (twin of map-live.js saveLiveCatch, minus the map).
 * Returns {ok, error?, mark?, st?}. The tide is not looked up here: the save and the hourly cron fill what they can.
 */
async function tsSaveCatch(options, answers, defaults, gpsPromise, ctx) {
  const st = catchCardState(options, { ...ctx, answers });
  const position = await gpsPromise;
  if (!position) return { ok: false, error: "Couldn't get your location — catch not saved." };
  const water = getLiveMarkDefaults().water || defaults.water;
  const mark = buildCatchFromCards({
    id: makeMarkId(), lat: position.lat, lng: position.lng, dateTime: nowAsNaiveString(),
    species: st.species, size: st.tooSmall ? null : st.size, rod: "", bait: st.bait, baitOptions: st.baitOptions, tooSmall: st.tooSmall, released: st.released,
  }, { ...defaults, water }, {}, st.depth);
  const action = defaults.tripAction;
  const chosen = defaults.forcedRod || defaults.tripRodSetups.find((s) => s.name === st.rod);
  const trip = liveTripData.trips.find((t) => t.id === action.tripId);
  Object.assign(mark, tdCatchFieldsFromAction(action, liveTripData.rodSetups, chosen ? chosen.id : null, trip ? trip.name : ""));
  const running = liveActiveSession();
  mark.name = tripCatchName(st.species, mark.tripName, mark.actionName, running ? running.number : null);
  if (st.bait) mark.bait = st.bait;
  const configuredBaits = liveTripData.rodSetups.flatMap((r) => r.bait || []);
  if (!st.bait || !configuredBaits.includes(st.bait)) delete mark.baitOptions;
  if (st.baitOptions) {
    if (st.baitOptions.length) mark.baitOptions = st.baitOptions.join(", ");
    else delete mark.baitOptions;
  }
  const prevDepthDefault = getLiveMarkDefaults().depth;
  const result = await saveMarkToD1(mark, true);
  if (!result.success) return { ok: false, error: "Catch not saved: " + result.error };
  saveLastMarkFieldValues(mark);
  const runState = liveTripRunState();
  if (typeof answers.depth === "number") {
    setLiveMarkDefaults({ ...getLiveMarkDefaults(), depth: answers.depth });
    if (runState && answers.depth !== prevDepthDefault) liveLogConditionChange("depth");
  }
  const rods = tripLogCatchRodRows(action, liveTripData.rodSetups, chosen ? chosen.id : null);
  logTripEvent(runState, {
    type: "catch", tripId: action.tripId, tripName: trip ? trip.name : null, actionId: action.id, actionName: action.name,
    sessionGroupId: runState ? runState.sessionGroupId || null : null, water: mark.waterCondition || null, depth: mark.waterDepth ?? null, lat: mark.lat, lng: mark.lng,
    markId: mark.id, species: mark.species || st.species, size: mark.size ?? null, released: !!mark.released, rods, rodSetupId: rods.length ? rods[0].rodSetupId : null,
  });
  return { ok: true, mark, st };
}
