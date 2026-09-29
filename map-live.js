// Live mode of the Map tab (conditions.html): GPS lookup, closest tracked location, its 48-hour graph, and
// tap-the-map-to-log-a-catch. Moved here from the old Live tab (live.js). app.js owns the mode switching:
// it calls liveInitOnce() once, then liveEnter()/liveExit() as the Live toggle changes.
// parseNaive, nowInNaiveEncoding, CONDITION_COLORS, renderConditionsChart, wireHoldToShowTooltip,
// setupFullscreenToggle, requestGpsPosition, currentGpsPosition and the marks functions come from js/*.js
// (loaded before this file); isMobileDevice and `state` come from app.js.

const SETTINGS_URL = `${USER_BACKEND_URL}/api/public/settings`;
// The user-backend endpoint that returns the signed-in user's Routes key (null when signed out). Their homes come from js/homes.js.
const TIMINGS_STORAGE_KEY = "liveHomeTimings";

// Same convention as Week Ahead's PIXELS_PER_HOUR — a readable, un-squashed width per hour of data,
// rather than cramming a full 48-hour window into one phone-width canvas. Mobile only (see renderForLocation).
const LIVE_PIXELS_PER_HOUR = 32;

let liveData = null;
let liveChart = null;
let currentLocationName = null;
let currentType = null;
let currentLoc = null;
let stopFishingTime = null;
// Live drag-in-progress state for the "+ Fishing times"/"+ Home to home"
// gesture (js/week-tools.js) — read by buildSessionDragPreviewPlugin,
// updated by wireSessionRangeSelect (wired once in liveInitOnce, same
// reasoning as wireHoldToShowTooltip there: this mode reuses one
// persistent <canvas> across every location switch).
let liveDragPreview = { hoverXVal: null, dragStartXVal: null };
// Home address — a single lat/lng set on the Settings tab's map ("Add Home"), loaded from the settings endpoint.

// timeToMinutes comes from js/week-tools.js (identical).

// 12-hour, unlike week-tools' 24-hour minutesToClock.
function liveMinutesToClock(mins) {
  const wrapped = ((Math.round(mins) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

// One fresh, high-accuracy GPS fix: {lat, lng}, or null if it is unavailable, denied or times out.
function getFreshGpsPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

function setTimingsStatus(html, isError) {
  const el = document.getElementById("timingsStatus");
  if (!el) return;
  el.innerHTML = html;
  el.style.color = isError ? "#dc2626" : "";
}

/**
 * Works backward from a "Home By" target to find the latest moment fishing
 * can continue: Home By − drive time (fishing spot → home address) − pack
 * up time (from this location's own timing data) − time to get back to the
 * car (current GPS position → the fishing spot, at a fixed 6 km/h walking/
 * paddling pace, not a road route). Draws the result as a line on the
 * graph and shows it as plain text underneath.
 */
async function updateTimings() {
  if (!currentLoc) {
    setTimingsStatus("Match a location first.", true);
    return;
  }
  // Drives to whichever of their homes is closest to this fishing spot (js/homes.js).
  await loadMyHomes();
  const home = nearestHome(currentLoc.lat, currentLoc.lng);
  if (!home) {
    setTimingsStatus("No home set yet — add one with the house button at the top of the map.", true);
    return;
  }
  const homeByStr = document.getElementById("homeByTime").value;
  if (!homeByStr) {
    setTimingsStatus("Enter a Home By time.", true);
    return;
  }
  const homeByMinutes = timeToMinutes(homeByStr);
  if (homeByMinutes == null) {
    setTimingsStatus("Home By time doesn't look valid.", true);
    return;
  }

  Prefs.set(TIMINGS_STORAGE_KEY, JSON.stringify({ homeByStr }));
  setTimingsStatus("Calculating…");

  // A fresh GPS read, not the cached currentGpsPosition from page load —
  // position may have changed since (paddled out, walked down the beach).
  const currentPosition = await getFreshGpsPosition();
  if (!currentPosition) {
    setTimingsStatus("Couldn't get your current location — check location access is allowed.", true);
    return;
  }

  // This location's own saved lat/lng to the saved home lat/lng, NOT the
  // device's current GPS position (that's the SEPARATE "back to car" segment below).
  const driveMinutes = await getDriveTimeBetweenCoords(currentLoc.lat, currentLoc.lng, home.lat, home.lng);
  if (driveMinutes == null) {
    setTimingsStatus("Couldn't calculate drive time — check that the Routes API key is set up.", true);
    return;
  }

  const packUpMinutes = timeToMinutes(currentLoc.packUp) || 0;

  const backToCarKm = distanceKm(currentPosition.lat, currentPosition.lng, currentLoc.lat, currentLoc.lng);
  const backToCarMinutes = (backToCarKm / 6) * 60; // fixed 6 km/h walking/paddling pace, not a road route

  const totalMinutesNeeded = driveMinutes + packUpMinutes + backToCarMinutes;

  const nowMs = nowInNaiveEncoding();
  const todayMidnight = Math.floor(nowMs / 86400000) * 86400000;
  let homeByTimestamp = todayMidnight + homeByMinutes * 60000;
  if (homeByTimestamp < nowMs) homeByTimestamp += 86400000; // Home By already passed today -> assume tomorrow

  stopFishingTime = homeByTimestamp - totalMinutesNeeded * 60000;

  setTimingsStatus(
    `Stop fishing by <strong>${liveMinutesToClock((stopFishingTime - todayMidnight) / 60000)}</strong> to be home by ${homeByStr} ` +
    `— back to car ${Math.round(backToCarMinutes)} min, pack up ${Math.round(packUpMinutes)} min, drive ${Math.round(driveMinutes)} min.`
  );

  renderForLocation(currentLoc);
}

// Flat-earth distance is more than accurate enough at these scales (tens of
// km at most between locations in the same two bays) — no need for a full
// great-circle/haversine calculation.
function distanceKm(lat1, lng1, lat2, lng2) {
  const dLat = lat2 - lat1;
  const dLng = (lng2 - lng1) * Math.cos((lat1 * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng) * 111.32;
}

function findNearestLocation(locations, lat, lng) {
  // The same physical spot can appear multiple times (once per type),
  // all sharing the same lat/lng — dedupe to unique NAMES first, so a
  // GPS match resolves to one physical place, not an arbitrary type.
  const seenNames = new Set();
  const uniqueLocations = [];
  for (const loc of locations) {
    if (loc.lat == null || loc.lng == null || seenNames.has(loc.name)) continue;
    seenNames.add(loc.name);
    uniqueLocations.push(loc);
  }
  let best = null, bestDist = Infinity;
  for (const loc of uniqueLocations) {
    const d = distanceKm(lat, lng, loc.lat, loc.lng);
    if (d < bestDist) { bestDist = d; best = loc; }
  }
  return best ? { location: best, distanceKm: bestDist } : null;
}

/**
 * Builds the Live-mode map: one marker per tracked location (same
 * dedup-by-name pattern as Normal mode's renderLocationMap), PLUS the
 * device's own current position as a distinct red dot marker when GPS
 * succeeded. Clicking a location marker opens/updates the hover panel for
 * that spot; clicking either the position marker OR any other open water
 * starts a new fishing mark right there (handleMapClickForMarks with no
 * preview callback) — for the position marker, using the actual
 * gpsPosition coordinates, since a marker click doesn't hand back map
 * coordinates the way a plain map click does.
 * Returns {map, markLayerState} so app.js can use the marks for export.
 */
function liveBuildMap(gpsPosition) {
  const markLayerState = createMarkLayerState();
  const byName = new Map();
  for (const loc of liveData.locations || []) {
    if (!byName.has(loc.name)) byName.set(loc.name, []);
    byName.get(loc.name).push(loc);
  }

  const points = [];
  for (const [name, variants] of byName) {
    const { lat, lng } = variants[0];
    const types = variants.map((v) => v.type);
    const iconKind = types.includes("Kayak") && types.includes("Land based") ? "both" : types.includes("Land based") ? "landBased" : "kayak";
    points.push({ lat, lng, label: displayNameFor(variants[0]), iconKind, onClick: () => selectLocationAndType(name, "Kayak") });
  }
  if (gpsPosition) {
    points.push({
      lat: gpsPosition.lat,
      lng: gpsPosition.lng,
      label: "You are here",
      iconKind: "currentPosition",
      // ONLY this exact entry point gets smart-filled Tide Condition (from
      // currentLoc's own real tide data) plus "last value used" for
      // everything else EXCEPT Weather Condition, which deliberately gets
      // no default at all — see computeQuickMarkDefaults' own comment
      // (js/marks-core.js). A plain map click always starts blank; guessing
      // conditions for an arbitrary clicked point would be guessing about
      // somewhere the person isn't necessarily standing.
      //
      // Reads the shared currentGpsPosition at click time, NOT the gpsPosition parameter this closure was built
      // with — liveRefreshGpsPosition (below) moves this same marker in place on a fresh fix without rebuilding
      // the map, so the parameter captured here goes stale the moment that happens; currentGpsPosition never does.
      onClick: () => {
        const defaults = { ...getLastMarkFieldValues(), ...liveMarkDefaultsForMark(), ...computeQuickMarkDefaults(getRowsForCurrentLoc()) };
        handleMapClickForMarks(map, currentGpsPosition.lat, currentGpsPosition.lng, markLayerState, null, defaults);
      },
    });
  }

  liveGpsMarker = null; // this rebuild discards whatever marker instance liveGpsMarker was pointing at
  const map = renderLeafletLocationMap("locationMap", points, {
    persistView: false, // Live sets its own view; don't overwrite where Normal mode reopens
    onMapClick: (lat, lng) => handleMapClickForMarks(map, lat, lng, markLayerState, null),
    onMarkerCreated: (p, marker) => { if (p.iconKind === "currentPosition") liveGpsMarker = marker; },
  });
  // Live's whole point is "where am I right now", so it always opens
  // centered on the device's actual position when that's available.
  if (map && gpsPosition) {
    map.setView([gpsPosition.lat, gpsPosition.lng], 13);
  }
  // Not awaited — the map appears straight away; + Session/End Session's numbers and visibility catch up once
  // this resolves (updateLiveSessionButtons no-ops if Live mode's already been left by then).
  if (map) loadAndRenderMarks(map, markLayerState).then(() => updateLiveSessionButtons());
  if (map) renderHomeMarkers(map); // the signed-in person's homes (js/homes.js)
  liveMap = map;
  liveMarkState = markLayerState;
  return { map, markLayerState };
}

// --- Quick-entry cards: Session defaults, + Session/End Session, and Catch (js/live-cards.js) --------
// The map and marks layer of the Live map currently showing, so a Catch/Session can be drawn on it once saved.
let liveMap = null;
let liveMarkState = null;
let liveGpsMarker = null; // the "You are here" Leaflet marker itself — see liveRefreshGpsPosition below
let activeCardFlow = null; // the open card stack, if any (only one at a time)

function showLiveToast(text, isError) {
  const el = document.createElement("div");
  el.className = "live-card-toast" + (isError ? " error" : "");
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), isError ? 6000 : 2500);
}

// The Species/Water/Berley/Rod/Rig/Bait options from the Settings lists (the same ones the mark edit form uses).
async function liveLoadCardOptions() {
  let lists = [];
  try {
    lists = await fetchUnionedMarkLists();
  } catch (err) {
    console.error("Could not load mark lists for the cards:", err);
  }
  return sessionCardOptions(lists);
}

// The Catch marks on the Live map as plain {id, species, size, released, tMs}, and the current run of them (catches chained
// within 8 hours of each other up to now: js/catch-limits.js). `run` is null until the marks have loaded, so the cards show
// limits only rather than a misleading count of 0.
function liveCatchContext() {
  const state = liveMarkState;
  const loaded = !!(state && state.markerLayer);
  const catches = catchesFromMarks(loaded ? state.marksById.values() : [], parseNaive);
  return { catches, run: loaded ? runCatches(catches, nowInNaiveEncoding()) : null };
}

// Map > Trip Defaults (Normal mode; js/trip-defaults.js): manage Trips, their Actions and Rod Setups.
async function openTripDefaults() {
  if (activeCardFlow) return;
  activeCardFlow = { close() {} }; // holds the one-card-flow-at-a-time guard while the hub loads and is open
  const flow = await showTripDefaults({
    onClose: () => {
      activeCardFlow = null;
      if (getLiveTripState()) loadLiveTripData().then(renderLiveTripUI); // its trips/actions may just have been edited
    },
  });
  if (activeCardFlow) activeCardFlow = flow;
}

// Draws a just-saved Catch on the Live map like any other mark (clickable, editable), if that map is still showing.
function addCatchToLiveMap(mark) {
  const state = liveMarkState;
  if (!liveMap || !state || state._discarded || !state.markerLayer) return;
  const style = markStyleFor(mark, state);
  const marker = createMarkShapeLayer([mark.lat, mark.lng], mark, {
    renderer: state.canvasRenderer,
    radius: style.radius,
    color: style.color,
    weight: style.weight,
    fillColor: style.fillColor,
    fillOpacity: 0.85,
  }, state.markLists).addTo(state.markerLayer);
  marker.bindTooltip(markTooltipText(mark, state), { direction: "top" });
  marker.bindPopup(buildMarkPopupViewHtml(mark), markPopupOptions());
  marker._markId = mark.id;
  marker.on("mousedown", (e) => {
    if (isSelectModifierKey(e.originalEvent)) L.DomEvent.stop(e);
  });
  marker.on("click", (e) => {
    if (!isSelectModifierKey(e.originalEvent)) return;
    L.DomEvent.stop(e);
    marker.closePopup();
    toggleMarkSelection(liveMap, state, mark.id);
  });
  marker.on("popupopen", () => fillMarkPopupDistances(marker.getPopup().getElement(), mark));
  state.marksById.set(mark.id, mark);
  state.markersById.set(mark.id, marker);
}

// The running trip Action (see "Live trips" below), or null when no Action's session is active.
function liveActiveTripAction() {
  const state = getLiveTripState();
  const active = liveActiveSession();
  if (!state || !state.actionId || !liveTripData || !active || active.mark.sessionGroupId !== state.sessionGroupId) return null;
  return liveTripData.actions.find((a) => a.id === state.actionId) || null;
}

// Catch-card defaults from a trip Action: its targets (then the trip's other targets), berley, method and water; the Rod card
// lists the Action's Rod Setups by name when there are several, and is skipped when there is one (or none).
function liveCatchDefaultsForAction(options, action) {
  const setups = tdLiveRodSetupIds(action.rodSetupIds, liveTripData.rodSetups).map((id) => liveTripData.rodSetups.find((r) => r.id === id));
  return {
    species: action.species || [],
    otherTargets: tdOtherTargets(liveTripData.actions, action),
    water: getLiveMarkDefaults().water || "",
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

async function saveLiveCatch(options, answers, defaults, gpsPromise, ctx) {
  const st = catchCardState(options, { ...ctx, answers }); // the same reading of the answers the cards showed
  const position = await gpsPromise;
  if (!position) {
    showLiveToast("Couldn't get your location — catch not saved.", true);
    return;
  }
  let tide = {};
  try {
    tide = computeQuickMarkDefaults(getRowsForCurrentLoc());
  } catch {
    tide = {}; // no tide data for this spot: the save fills what it can from looked-up data
  }
  const mark = buildCatchFromCards({
    id: makeMarkId(),
    lat: position.lat,
    lng: position.lng,
    dateTime: nowAsNaiveString(),
    species: st.species,
    size: st.tooSmall ? null : st.size,
    rod: defaults.tripAction ? "" : st.rod, // on a trip the rod/rig come from the chosen Rod Setup, below
    tooSmall: st.tooSmall,
    released: st.released,
  }, { ...defaults, water: getLiveMarkDefaults().water || defaults.water }, tide, st.depth);
  if (defaults.tripAction) {
    const chosen = defaults.tripRodSetups.find((s) => s.name === st.rod);
    Object.assign(mark, tdCatchFieldsFromAction(defaults.tripAction, liveTripData.rodSetups, chosen ? chosen.id : null));
  }
  const result = await saveMarkToD1(mark, true);
  if (!result.success) {
    showLiveToast("Catch not saved: " + result.error, true);
    return;
  }
  saveLastMarkFieldValues(mark);
  // A depth changed on the catch's own card becomes the Live page's Depth default too (the Depth button follows it).
  if (typeof answers.depth === "number") {
    setLiveMarkDefaults({ ...getLiveMarkDefaults(), depth: answers.depth });
    renderLiveDefaultsUI();
  }
  addCatchToLiveMap(mark);
  // Say where the bag stands now (the new catch is on the map, so it is part of the run).
  const after = liveCatchContext();
  const counts = after.run ? speciesCounts(after.run, options.limits || {}, st.species) : null;
  showLiveToast(catchSavedMessage(st, counts));
}

// Tap Catch: the GPS fix starts straight away (that is where the fish was), while the cards are answered.
async function startLiveCatch() {
  if (activeCardFlow || !liveMap || !liveMarkState) return;
  const gpsPromise = getFreshGpsPosition();
  const options = await liveLoadCardOptions();
  const action = liveActiveTripAction();
  // On a trip, the running Action decides everything: its targets first, then the other actions' targets, then the rest;
  // its berley/method/bait; and its Rod Setup (asked only when the Action has more than one). Otherwise the saved Session
  // defaults, as before.
  const defaults = action ? liveCatchDefaultsForAction(options, action) : getSessionDefaults(options);
  const answers = {};
  const ctx = { ...liveCatchContext(), depthDefault: getLiveMarkDefaults().depth ?? getLastMarkFieldValues().waterDepth ?? null };
  const finish = () => { activeCardFlow = null; };
  activeCardFlow = showCardFlow({
    getSteps: () => buildCatchCardSteps(options, defaults, { ...ctx, answers }),
    onChoose: (step, value) => {
      if (step.id === "size") {
        answers.size = applySizeAction(answers.size, value, catchCardState(options, { ...ctx, answers }).start);
      } else if (step.id === "species") {
        // A different species means a different size range and bag: start those cards again.
        if (answers.species !== value) { delete answers.size; delete answers.fate; }
        answers.species = answers.species === value ? "" : value;
      } else if (step.id === "fate") {
        answers.fate = value;
      } else if (step.id === "depth") {
        answers.depth = applyDepthAction(catchCardState(options, { ...ctx, answers }).depth, value);
      } else {
        answers[step.id] = answers[step.id] === value ? "" : value;
      }
    },
    onDone: () => {
      activeCardFlow.close();
      finish();
      saveLiveCatch(options, answers, defaults, gpsPromise, ctx);
    },
    onClose: finish,
    doneLabel: "Save catch",
  });
}

// The Session Start/End marks currently on the Live map: {starts: [Session Start marks], endedGroupIds: Set of
// every Session End's sessionGroupId}. Null until the marks have loaded — same null-until-loaded convention as
// liveCatchContext's `run`.
function liveSessionMarks() {
  const state = liveMarkState;
  if (!state || !state.markerLayer) return null;
  const starts = [];
  const endedGroupIds = new Set();
  for (const m of state.marksById.values()) {
    if (!m) continue;
    if (m.type === "Session Start" && m.dateTime) starts.push(m);
    else if (m.type === "Session End" && m.sessionGroupId) endedGroupIds.add(m.sessionGroupId);
  }
  return { starts, endedGroupIds };
}

// The existing Session Start marks' own times AND numbers — [{tMs, number}], the shape js/catch-limits.js's
// nextSessionNumber needs to find the HIGHEST number already used in a chain rather than just count how many
// exist (a session deleted from the middle of a chain must not let a later survivor's number get reused — see
// nextSessionNumber's own comment). `number` comes straight from each mark's own name (sessionNumberFromName);
// a mark whose name doesn't parse is left out, same as one with no usable time. Null until the marks have loaded.
function liveSessionStarts() {
  const sm = liveSessionMarks();
  if (!sm) return null;
  const out = [];
  for (const m of sm.starts) {
    const tMs = parseNaive(m.dateTime);
    const number = sessionNumberFromName(m.name);
    if (Number.isFinite(tMs) && number != null) out.push({ tMs, number, mark: m });
  }
  return out;
}

// The currently active session — the most recently started one that has no Session End sharing its sessionGroupId
// yet: {mark, number}, or null when there isn't one (or the marks haven't loaded, or its name doesn't parse — play
// safe rather than show a guessed number). `number` is read straight from the mark's own name, not recomputed.
function liveActiveSession() {
  const sm = liveSessionMarks();
  if (!sm || !sm.starts.length) return null;
  const sorted = [...sm.starts].sort((a, b) => parseNaive(a.dateTime) - parseNaive(b.dateTime));
  const latest = sorted[sorted.length - 1];
  if (!latest.sessionGroupId || sm.endedGroupIds.has(latest.sessionGroupId)) return null;
  const number = sessionNumberFromName(latest.name);
  return number != null ? { mark: latest, number } : null;
}

// Keeps "+ Session"/"End Session…/Move"/"+ Catch" in step with whatever's actually on the map: the next number to
// show on + Session, and End Session's/+Catch's own visibility (+ End Session's label) from the currently active
// session — +Catch only makes sense once a session's actually underway to log the catch against, same as End
// Session. Nothing but + Session's base text shown at all until the marks have loaded — never guess "Session 1"
// or show +Catch before there's actually a session known to be active, same reasoning as the bag counts staying
// blank until a run is known. Called once loadAndRenderMarks resolves, and after every save that can change
// session state (saveLiveSession, saveLiveEndSession).
function updateLiveSessionButtons() {
  if (!liveMap || !liveMarkState) return; // not in Live mode (or it's been left) — applyModeChrome already hid it
  renderLiveTripUI(); // the trip's action buttons show active only while their session is
  // +Catch only makes sense once a session's actually underway to log the catch against; liveActiveSession() is null
  // until the marks have loaded, so it stays hidden until then rather than guessing.
  document.getElementById("btnLiveCatch").style.display = liveActiveSession() && cachedIsSignedIn ? "" : "none";
}

// --- Live defaults: Water / Depth buttons -------------------------------------------------------------------
// Two device-local defaults for the marks made in Live mode (Session Start from a trip Action, +Catch, and a tap on the
// "You are here" marker): a Water Condition (the Water button cycles through the Settings list, then back to none) and a
// water depth (the Depth button opens a stepper). Unset means "carry on as before" (Session/Catch defaults, last value).
const LIVE_MARK_DEFAULTS_KEY = "liveMarkDefaults";
let liveWaterOptions = null; // the Water Condition list, loaded on first use

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
/** The set defaults as mark fields (for the tap-to-log quick mark). */
function liveMarkDefaultsForMark() {
  const d = getLiveMarkDefaults();
  const out = {};
  if (d.water) out.waterCondition = d.water;
  if (d.depth != null) out.waterDepth = d.depth;
  return out;
}

function renderLiveDefaultsUI() {
  const water = document.getElementById("btnLiveWater");
  const depth = document.getElementById("btnLiveDepth");
  if (!water || !depth) return;
  const d = getLiveMarkDefaults();
  water.textContent = `Water: ${d.water || "—"}`;
  depth.textContent = `Depth: ${d.depth != null ? d.depth.toFixed(1) + " m" : "—"}`;
}

/** The next value when cycling `options` from `current`: each option in turn, then none ("") after the last. */
function nextCycleValue(options, current) {
  if (!options.length) return "";
  const i = options.indexOf(current);
  if (i === -1) return options[0];
  return i + 1 < options.length ? options[i + 1] : "";
}

async function cycleLiveWater() {
  if (!liveWaterOptions) liveWaterOptions = (await liveLoadCardOptions()).water;
  const d = getLiveMarkDefaults();
  setLiveMarkDefaults({ ...d, water: nextCycleValue(liveWaterOptions, d.water) });
  renderLiveDefaultsUI();
}

// The Depth button: a full-screen stepper (same look as the old "+ Session" water depth card). Saved as it changes.
function openLiveDepth() {
  if (activeCardFlow) return;
  const overlay = document.createElement("div");
  overlay.className = "live-card-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  document.body.appendChild(overlay);
  document.body.classList.add("live-card-open");
  const finish = () => { activeCardFlow = null; };
  const close = () => {
    overlay.remove();
    document.body.classList.remove("live-card-open");
    finish();
    renderLiveDefaultsUI();
  };
  activeCardFlow = { close };
  const render = () => {
    const depth = getLiveMarkDefaults().depth;
    overlay.innerHTML = `
      <div class="live-card">
        <div class="live-card-head">
          <h2 class="live-card-title">Water depth</h2>
          <p class="live-card-prompt">Default depth for new marks${depth == null ? " (not set)" : ""}</p>
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
        const d = getLiveMarkDefaults();
        const next = Math.max(0, Math.round(((d.depth ?? 0) + Number(btn.dataset.depth)) * 10) / 10);
        setLiveMarkDefaults({ ...d, depth: next });
        render();
      })
    );
    overlay.querySelector("[data-depth-clear]").addEventListener("click", () => {
      setLiveMarkDefaults({ ...getLiveMarkDefaults(), depth: null });
      render();
    });
    overlay.querySelector("[data-depth-done]").addEventListener("click", close);
  };
  render();
}

// --- Live trips (js/trip-defaults.js): Start Trip -> the trip's Actions as toolbar buttons -----------------
// Tapping an Action starts a session from it (Session Start mark) and shows it active; tapping it again ends the session;
// tapping another ends the active one first and starts the new one. Which Action is active is never stored as a flag: the
// stored {actionId, sessionGroupId} only counts while liveActiveSession() really is that session, so ending it any other
// way (End Session/Move, "+ Session") un-actives the button by itself.
const LIVE_TRIP_KEY = "liveActiveTrip";
let liveTripData = null; // {trips, actions, rodSetups}, loaded lazily
let liveTripBusy = false;

function getLiveTripState() {
  try {
    return JSON.parse(localStorage.getItem(LIVE_TRIP_KEY)) || null;
  } catch {
    return null;
  }
}
function setLiveTripState(state) {
  try {
    if (state) localStorage.setItem(LIVE_TRIP_KEY, JSON.stringify(state));
    else localStorage.removeItem(LIVE_TRIP_KEY);
  } catch {
    // storage unavailable: the trip just won't survive a reload
  }
}

async function loadLiveTripData() {
  try {
    const [trips, actions, rodSetups] = await Promise.all([tdApi("/api/tripsetups"), tdApi("/api/tripactions"), tdApi("/api/rodsetups")]);
    liveTripData = { trips, actions, rodSetups };
  } catch (err) {
    console.error("Could not load trips:", err);
    showLiveToast("Couldn't load your trips: " + err.message, true);
  }
  return liveTripData;
}

// The Start/End Trip button is icon-only: a green play (start) or a red stop (end).
const LIVE_TRIP_PLAY_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></svg>';
const LIVE_TRIP_STOP_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
function setLiveTripButton(btn, running) {
  btn.innerHTML = running ? LIVE_TRIP_STOP_ICON : LIVE_TRIP_PLAY_ICON;
  const label = running ? "End Trip" : "Start Trip";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.classList.toggle("trip-stop", running);
  btn.classList.toggle("trip-start", !running);
}

// Start Trip / End Trip button, and the chosen trip's Actions as buttons (active = its session is the running one).
function renderLiveTripUI() {
  const btn = document.getElementById("btnStartTrip");
  const box = document.getElementById("liveTripActions");
  if (!btn || !box) return;
  const state = getLiveTripState();
  setLiveTripButton(btn, !!state);
  if (!state) {
    box.innerHTML = "";
    return;
  }
  if (!liveTripData) {
    loadLiveTripData().then(renderLiveTripUI);
    return;
  }
  const trip = liveTripData.trips.find((t) => t.id === state.tripId);
  if (!trip) {
    setLiveTripState(null); // the trip was deleted in Trip Defaults
    box.innerHTML = "";
    setLiveTripButton(btn, false);
    return;
  }
  const active = liveActiveSession();
  const activeGroup = active && state.sessionGroupId && active.mark.sessionGroupId === state.sessionGroupId ? state.actionId : null;
  box.innerHTML = tdActionsForTrip(liveTripData.actions, trip.id)
    .map((a) => `<button type="button" class="btn-secondary live-quick-btn live-trip-action${a.id === activeGroup ? " active" : ""}" data-trip-action="${escapeHtml(a.id)}" aria-pressed="${a.id === activeGroup}"${liveTripBusy ? " disabled" : ""}>${escapeHtml(a.name)}</button>`)
    .join("") || `<span class="map-toolbar-status">No actions in ${escapeHtml(trip.name)} yet — add some in Trip Defaults.</span>`;
}

// Ends `active` (a liveActiveSession()) at `position`: the Session End mark, saved and drawn. Null (with a toast) on failure.
async function liveCloseActiveSession(active, position) {
  const mark = buildSessionEndFromStart(active.mark, {
    id: makeMarkId(), lat: position.lat, lng: position.lng, dateTime: nowAsNaiveString(), createdAt: nowAsNaiveString(),
  }, active.number);
  const result = await saveMarkToD1(mark, true);
  if (!result.success) {
    showLiveToast(`Couldn't end Session ${active.number}: ` + result.error, true);
    return null;
  }
  addCatchToLiveMap(mark);
  return mark;
}

// Tap Start Trip: pick one trip (one card). While a trip is running the same button is End Trip.
async function onStartTripClick() {
  if (activeCardFlow || liveTripBusy || !liveMap || !liveMarkState) return;
  const state = getLiveTripState();
  if (state) {
    await endLiveTrip(state);
    return;
  }
  const data = await loadLiveTripData();
  if (!data) return;
  if (!data.trips.length) {
    showLiveToast("No trips yet — add one in Trip Defaults.", true);
    return;
  }
  const finish = () => { activeCardFlow = null; };
  let chosen = null;
  activeCardFlow = showCardFlow({
    getSteps: () => [{ id: "trip", title: "Start trip", prompt: "Which trip?", multi: false, options: data.trips.map((t) => t.name), selected: chosen ? [chosen.name] : [] }],
    onChoose: (step, value) => { chosen = data.trips.find((t) => t.name === value) || null; },
    onDone: () => {
      activeCardFlow.close();
      finish();
      if (!chosen) return;
      setLiveTripState({ tripId: chosen.id });
      renderLiveTripUI();
      showLiveToast(`${chosen.name} started`);
    },
    onClose: finish,
    doneLabel: "Start",
  });
}

// End Trip: closes the session this trip's Action started (if it is still running), then clears the trip.
async function endLiveTrip(state) {
  liveTripBusy = true;
  try {
    const active = liveActiveSession();
    if (active && state.sessionGroupId && active.mark.sessionGroupId === state.sessionGroupId) {
      const position = await getFreshGpsPosition();
      if (!position) {
        showLiveToast("Couldn't get your location — trip not ended.", true);
        return;
      }
      const ended = await liveCloseActiveSession(active, position);
      if (!ended) return;
    }
    setLiveTripState(null);
    updateLiveSessionButtons();
    showLiveToast("Trip ended");
  } finally {
    liveTripBusy = false;
    renderLiveTripUI();
  }
}

// Tap an Action button (see the section comment above for the three cases).
async function onTripActionTap(actionId) {
  if (liveTripBusy || activeCardFlow || !liveMap || !liveMarkState || !liveTripData) return;
  const state = getLiveTripState();
  const action = liveTripData.actions.find((a) => a.id === actionId);
  if (!state || !action) return;
  liveTripBusy = true;
  renderLiveTripUI(); // buttons disabled while the GPS fix and saves run
  try {
    const position = await getFreshGpsPosition();
    if (!position) {
      showLiveToast("Couldn't get your location — nothing saved.", true);
      return;
    }
    const active = liveActiveSession();
    const wasThisAction = !!active && state.actionId === actionId && state.sessionGroupId === active.mark.sessionGroupId;
    let ended = null;
    if (active) {
      // Whichever session is running is closed first (same as "+ Session"); stop here if that fails so nothing is left half done.
      ended = await liveCloseActiveSession(active, position);
      if (!ended) return;
    }
    if (wasThisAction) {
      setLiveTripState({ tripId: state.tripId });
      updateLiveSessionButtons();
      showLiveToast(`${ended.name} saved`);
      return;
    }
    let tide = {};
    try {
      tide = computeQuickMarkDefaults(getRowsForCurrentLoc());
    } catch {
      tide = {}; // no tide data for this spot: the save fills what it can from looked-up data
    }
    const now = nowAsNaiveString();
    const mark = buildSessionStartFromAction(action, liveTripData.rodSetups, {
      id: makeMarkId(), lat: position.lat, lng: position.lng, dateTime: now, createdAt: now, sessionGroupId: makeMarkId(),
      sessionNumber: nextSessionNumber(liveSessionStarts() || [], parseNaive(now)),
      water: getLiveMarkDefaults().water || "", waterDepth: getLiveMarkDefaults().depth ?? getLastMarkFieldValues().waterDepth ?? null,
    }, tide);
    const result = await saveMarkToD1(mark, true);
    if (!result.success) {
      showLiveToast("Session not saved: " + result.error, true);
      if (ended) setLiveTripState({ tripId: state.tripId }); // the old one is closed, the new one never started
      return;
    }
    saveLastMarkFieldValues(mark);
    addCatchToLiveMap(mark);
    setLiveTripState({ tripId: state.tripId, actionId, sessionGroupId: mark.sessionGroupId });
    updateLiveSessionButtons();
    showLiveToast(ended ? `${ended.name} saved; ${mark.name} saved` : `${mark.name} saved`);
  } finally {
    liveTripBusy = false;
    renderLiveTripUI();
  }
}

// Whether the panel's expanded content (ratings, timings, chart) is
// currently showing, vs just the collapsed name+distance banner. Reset to
// false whenever a genuinely NEW location is selected (see
// selectLocationAndType) — "when first getting a location, only show the
// banner" applies fresh each time a different spot is picked.
let isPanelExpanded = false;
// Whether renderForLocation (which builds both the summary badges AND the
// Chart.js chart) has actually run yet for whatever's currently in
// currentLoc. Deferred until the panel is actually expanded — building a
// chart into a canvas inside a display:none container measures as zero
// width/height, so rendering only happens once the container is visible.
let hasRenderedExpandedContentForCurrentLoc = false;

function showLiveHoverPanel() {
  // Same fix as showLocationHoverPanel (app.js): the two panels compete for space.
  if (typeof closeMarkDetailPanel === "function") closeMarkDetailPanel();
  document.getElementById("liveHoverPanel").style.display = "block";
}

function hideLiveHoverPanel() {
  document.getElementById("liveHoverPanel").style.display = "none";
  // Collapses for next time — closing the panel always means "start fresh,
  // collapsed" the next time it opens.
  setPanelExpanded(false);
  disarmSchedule(); // clears any leftover "armed-for-schedule" outline/touch-action lock (js/week-tools.js)
}

function setPanelExpanded(expanded) {
  isPanelExpanded = expanded;
  document.getElementById("liveHoverPanelExpanded").style.display = expanded ? "block" : "none";
  document.getElementById("liveHoverPanelChevron").textContent = expanded ? "▴" : "▾";
  document.getElementById("liveHoverPanelBanner").setAttribute("aria-expanded", expanded ? "true" : "false");
  if (expanded && currentLoc && !hasRenderedExpandedContentForCurrentLoc) {
    hasRenderedExpandedContentForCurrentLoc = true;
    renderForLocation(currentLoc);
  }
}

function updateDistanceDisplay(loc) {
  const el = document.getElementById("liveHoverPanelDistance");
  if (currentGpsPosition && loc.lat != null && loc.lng != null) {
    const d = distanceKm(currentGpsPosition.lat, currentGpsPosition.lng, loc.lat, loc.lng);
    el.textContent = `${d.toFixed(1)}km away`;
  } else {
    el.textContent = "";
  }
}

function renderTypePicker(availableTypes, selectedType, onSelect) {
  const section = document.getElementById("typePickerSection");
  const container = document.getElementById("typePicker");
  container.innerHTML = "";
  // Only worth showing a picker when there's actually a choice.
  if (availableTypes.length <= 1) {
    section.style.display = "none";
    return;
  }
  section.style.display = "block";
  for (const type of availableTypes) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "type-photo-card" + (type === selectedType ? " active" : "");
    const imgSrc = type === "Kayak" ? "images/type-kayak.jpg" : "images/type-landbased.jpg";
    card.innerHTML = `<img src="${imgSrc}" alt="${type}" /><span>${type}</span>`;
    card.addEventListener("click", () => onSelect(type));
    container.appendChild(card);
  }
}

// Selects a physical location by name, resolving which type variant to
// actually show — defaults to Kayak when available, falling back to
// whichever type IS available. Opens (or keeps open) the hover panel and
// updates its banner.
function selectLocationAndType(name, preferredType) {
  const variants = (liveData.locations || []).filter((l) => l.name === name);
  if (variants.length === 0) return;
  const availableTypes = variants.map((v) => v.type);
  const type = availableTypes.includes(preferredType)
    ? preferredType
    : (availableTypes.includes("Kayak") ? "Kayak" : availableTypes[0]);

  const isNewLocation = name !== currentLocationName;
  currentLocationName = name;
  currentType = type;

  renderTypePicker(availableTypes, type, (newType) => selectLocationAndType(name, newType));

  const loc = variants.find((v) => v.type === type);
  currentLoc = loc;
  // Pack-up time differs by type, and the reference point itself changes on
  // a different location — any previously calculated line would be stale.
  stopFishingTime = null;
  disarmSchedule(); // a schedule armed for the PREVIOUS location/type no longer applies here (js/week-tools.js)
  if (isNewLocation) hasCenteredLiveChartOnNow = false; // a genuinely new location is worth re-centering on "now" again; switching type on the SAME spot isn't
  setTimingsStatus("");

  document.getElementById("liveHoverPanelLocationName").textContent = displayNameFor(loc);
  updateDistanceDisplay(loc);
  showLiveHoverPanel();

  if (isNewLocation) {
    // A genuinely new spot always starts collapsed.
    hasRenderedExpandedContentForCurrentLoc = false;
    setPanelExpanded(false);
  } else if (isPanelExpanded) {
    // Same spot, just switched Kayak/Land based type, and the panel's
    // already open — refresh what's showing immediately.
    renderForLocation(loc);
  }
}

function liveRenderSummary(loc, rows, now) {
  const card = document.getElementById("liveSummaryCard");
  card.style.display = "flex";
  if (rows.length === 0) {
    card.innerHTML = `<span class="live-inline-stat">No data yet</span>`;
    return;
  }
  const tempRt = lastNonNullAtOrBefore(rows, "Temp Realtime (C)", now);
  const windRt = lastNonNullAtOrBefore(rows, "Wind Realtime (km/h)", now);
  const conditionRow = nearestRowWithField(rows, "Condition", now);
  const fishingRow = nearestRowWithField(rows, "Fishing Condition", now);
  const tideRow = nearestRowWithField(rows, "Tide Status", now);
  const tideHeightRow = nearestRowWithField(rows, "Tide Height (m)", now);

  const conditionVal = conditionRow ? conditionRow["Condition"] : null;
  const fishingVal = fishingRow ? fishingRow["Fishing Condition"] : null;

  // Compact inline badges/stats that sit directly on the heading row next to the location name.
  card.innerHTML = `
    <span class="condition-badge live-inline-badge" title="Location condition" style="background:${conditionVal != null ? (CONDITION_COLORS[Math.round(conditionVal)] || "var(--cond-none)") : "var(--cond-none)"}">${conditionVal != null ? conditionVal : "–"}</span>
    <span class="condition-badge live-inline-badge" title="Fishing condition" style="background:${fishingVal != null ? (CONDITION_COLORS[Math.round(fishingVal)] || "var(--cond-none)") : "var(--cond-none)"}">${fishingVal != null ? fishingVal : "–"}</span>
    <span class="live-inline-stat">${tempRt ? tempRt["Temp Realtime (C)"] + "°" : "–"}</span>
    <span class="live-inline-stat">${windRt ? Math.round(windRt["Wind Realtime (km/h)"]) + " km/h" : "–"}</span>
    <span class="live-inline-stat">${tideRow ? tideRow["Tide Status"] : "–"}${tideHeightRow ? " " + tideHeightRow["Tide Height (m)"] + "m" : ""}</span>
  `;
}

// Tracks whether we've already auto-centered the mobile chart on "now"
// for the CURRENT location — reset when the location changes, but NOT on
// every re-render for the same location, so a manually-scrolled position
// isn't yanked away.
let hasCenteredLiveChartOnNow = false;

// Shared by renderForLocation and the "You are here" quick-mark-entry click
// handler (liveBuildMap) — both need the exact same filtered/sorted/
// _t-annotated rows for currentLoc.
function getRowsForCurrentLoc() {
  if (!currentLoc) return [];
  return (liveData.rows || [])
    .filter((r) => r["Location Name"] === currentLoc.name && r["Type"] === currentLoc.type)
    .map((r) => ({ ...r, _t: parseNaive(r.dateTime) }))
    .sort((a, b) => a._t - b._t);
}

/**
 * The "+ Fishing times" / "+ Home to home" buttons and the list of
 * already-computed schedules for the current location — same feature Week
 * Ahead and the Map tab have (js/week-tools.js). null hides both (no data
 * for this location/type yet — see renderForLocation's early return).
 */
function renderLiveScheduleControls(loc) {
  const btnsBox = document.getElementById("liveScheduleButtons");
  const chipsBox = document.getElementById("liveComputedSessions");
  btnsBox.innerHTML = "";
  chipsBox.innerHTML = "";
  if (!loc) return;

  btnsBox.appendChild(buildTripOriginSelect());
  const canvas = document.getElementById("liveChart");
  for (const { mode, label } of [
    { mode: "fishing", label: "+ Fishing times" },
    { mode: "onsite", label: "+ Home to home" },
  ]) {
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "weeknew-add-fishing-times";
    addBtn.textContent = label;
    addBtn.addEventListener("click", () => {
      onArmScheduleClick(loc, document.getElementById("liveChartFrame"), addBtn, mode, () => liveChart, canvas, document.getElementById("liveChartScroll"));
    });
    btnsBox.appendChild(addBtn);
  }

  const thisLocComputed = computedSessions.filter((r) => r.locationName === loc.name && r.locationType === loc.type);
  for (const record of thisLocComputed) {
    chipsBox.appendChild(buildComputedSessionChip(record, () => renderForLocation(currentLoc)));
  }
}

function renderForLocation(loc) {
  const rows = getRowsForCurrentLoc();

  const nowMs = nowInNaiveEncoding();
  const windowStart = nowMs - 24 * 3600 * 1000;
  const windowEnd = nowMs + 24 * 3600 * 1000;
  const windowRows = rows.filter((r) => r._t >= windowStart && r._t <= windowEnd);

  liveRenderSummary(loc, windowRows, new Date());

  const frame = document.getElementById("liveChartFrame");
  const emptyState = document.getElementById("liveHoverPanelEmptyState");
  if (windowRows.length === 0) {
    frame.style.display = "none";
    emptyState.style.display = "block";
    renderLiveScheduleControls(null);
    return;
  }
  frame.style.display = "block";
  emptyState.style.display = "none";

  const sunTimes = (liveData.sunTimes && liveData.sunTimes[loc.name]) || [];

  const canvas = document.getElementById("liveChart");
  // Sets the WRAPPER's width, not the canvas's own — Chart.js's own
  // responsive resize logic silently resets the canvas back down to match
  // its parent, so making the PARENT wide is the only way this holds. On
  // mobile: natural, un-squashed per-hour width instead of forcing the full
  // 48-hour window into one phone-width canvas. Desktop fills the frame.
  const wideInner = document.getElementById("liveChartWideInner");
  if (isMobileDevice) {
    wideInner.style.width = 48 * LIVE_PIXELS_PER_HOUR + "px";
  } else {
    wideInner.style.width = "100%";
  }

  liveChart = renderConditionsChart({
    canvas,
    rows: windowRows,
    sunTimes,
    existingChart: liveChart,
    locationName: loc.name,
    tideMaxObserved: loc.tideMaxObserved,
    moonPhases: liveData.moonPhases,
    minTideHeight: loc.minTideHeight,
    stopFishingTime,
    // Flags for any already-computed ("+ Fishing times"/"+ Home to home")
    // schedule for this location+type — same computedSessions list Week
    // Ahead and the Map tab read (js/week-tools.js). A separate, additive
    // feature from stopFishingTime above (the Home By quick line).
    computedSessionMarkers: computedSessions.filter((r) => r.locationName === loc.name && r.locationType === loc.type),
    // Live drag-in-progress preview, read by buildSessionDragPreviewPlugin
    // — updated by wireSessionRangeSelect (wired once in liveInitOnce).
    dragPreviewState: () => liveDragPreview,
    compact: false,
    disableBuiltinEvents: true, // this mode drives the tooltip itself — see wireHoldToShowTooltip in liveInitOnce
    tideOffsetMinutes: loc.tideOffset,
    // Explicit, not left to auto-fit — guarantees "now" sits at EXACTLY
    // the horizontal midpoint of the canvas, which the mobile centering scroll below depends on.
    xRange: { min: windowStart, max: windowEnd },
  });
  renderLiveScheduleControls(loc);

  if (isMobileDevice && !hasCenteredLiveChartOnNow) {
    hasCenteredLiveChartOnNow = true;
    // Deferred a tick so the canvas has actually taken on the width set
    // above before computing where the midpoint is.
    requestAnimationFrame(() => {
      const scrollWrap = document.getElementById("liveChartScroll");
      if (!scrollWrap) return;
      const target = scrollWrap.scrollWidth / 2 - scrollWrap.clientWidth / 2;
      scrollWrap.scrollLeft = Math.max(0, target);
    });
  }
}

function setGpsStatus(html) {
  const el = document.getElementById("liveGpsStatus");
  if (!html) {
    el.style.display = "none";
    return;
  }
  el.innerHTML = html;
  el.style.display = "block";
}

// One-time wiring of Live's own controls. Called once by app.js at page load.
let liveSettingsPromise = null;
function liveInitOnce() {
  let savedTimings = null;
  try {
    savedTimings = JSON.parse(localStorage.getItem(TIMINGS_STORAGE_KEY) || "null");
  } catch {
    savedTimings = null;
  }
  if (savedTimings) {
    document.getElementById("homeByTime").value = savedTimings.homeByStr || "";
  }
  document.getElementById("btnUpdateTimings").addEventListener("click", updateTimings);
  document.getElementById("btnCloseLiveHoverPanel").addEventListener("click", hideLiveHoverPanel);
  document.getElementById("btnTripDefaults").addEventListener("click", openTripDefaults);
  document.getElementById("btnStartTrip").addEventListener("click", onStartTripClick);
  document.getElementById("liveTripActions").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-trip-action]");
    if (btn) onTripActionTap(btn.dataset.tripAction);
  });
  document.getElementById("btnLiveWater").addEventListener("click", cycleLiveWater);
  document.getElementById("btnLiveDepth").addEventListener("click", openLiveDepth);
  document.getElementById("btnLiveCatch").addEventListener("click", startLiveCatch);
  document.getElementById("liveHoverPanelBanner").addEventListener("click", () => setPanelExpanded(!isPanelExpanded));
  // Manual backup for whichever device/browser doesn't fire the visibilitychange refresh below reliably — same
  // function either way, so there's nothing to keep in sync between the two triggers.
  document.getElementById("btnRefreshLiveGps").addEventListener("click", () => liveRefreshGpsPosition({ center: true }));
  // The automatic trigger itself — see liveRefreshGpsPosition's own comment for why this is scoped here (not
  // folded into app.js's unrelated syncAppHeight visibilitychange listener) and why resume-only, not a timer.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) liveRefreshGpsPosition();
  });
  // Wired once, not inside renderForLocation — that function reuses this
  // same persistent <canvas> across every re-render (destroying and
  // recreating the Chart.js instance each time, never the canvas element),
  // so wiring per-render would stack up duplicate listeners. The getter
  // always reads whatever the current liveChart is.
  wireHoldToShowTooltip(() => liveChart, document.getElementById("liveChart"));
  // Same "wired once against a persistent canvas" reasoning as
  // wireHoldToShowTooltip just above — see wireSessionRangeSelect's own
  // comment (js/week-tools.js) for why it takes getters here rather than
  // fixed values.
  wireSessionRangeSelect(
    () => liveChart,
    document.getElementById("liveChart"),
    () => currentLoc,
    liveDragPreview,
    () => {
      if (currentLoc) renderForLocation(currentLoc);
    }
  );
  setupFullscreenToggle("liveChartFrame", { fullscreenOnRotate: false });
}

// Loaded separately from the main data fetch, with its own error handling —
// a missing settings response just leaves the drive-time feature unavailable.
function liveLoadSettings() {
  if (!liveSettingsPromise) {
    liveSettingsPromise = (async () => {
      try {
        const settingsRes = await fetch(SETTINGS_URL, { cache: "no-store", credentials: "include" });
        if (settingsRes.ok) {
          const settings = await settingsRes.json();
          googleRoutesApiKey = settings.googleRoutesApiKey || null;
        }
      } catch (err) {
        console.error("Could not load settings:", err);
      }
    })();
  }
  return liveSettingsPromise;
}

/**
 * Switches the Map tab into Live mode: GPS lookup, closest location, and the
 * Live map. `isStale()` says whether the person has since changed mode again
 * (GPS can take a while), in which case nothing more is drawn.
 * Resolves to {map, markLayerState}, or null if it went stale.
 */
async function liveEnter(isStale) {
  liveData = state.data;
  setGpsStatus("Finding your location…");
  liveLoadSettings(); // not awaited — only the drive-time feature needs it

  // requestGpsPosition (js/week-tools.js) — shared/cached, so this doesn't
  // trigger a SECOND permission prompt. Assigned to the SHARED
  // currentGpsPosition since updateDistanceDisplay needs it later too.
  currentGpsPosition = await requestGpsPosition();
  if (isStale()) return null;

  const locations = liveData.locations || [];
  if (!currentGpsPosition) {
    setGpsStatus(`Couldn't get your location — showing all tracked spots. Tap one on the map to view it.`);
    return liveBuildMap(null);
  }

  const match = findNearestLocation(locations, currentGpsPosition.lat, currentGpsPosition.lng);
  const built = liveBuildMap(currentGpsPosition);
  if (!match) {
    setGpsStatus(`Got your location, but no configured spots have coordinates yet.`);
    return built;
  }
  setGpsStatus("");
  selectLocationAndType(match.location.name, "Kayak");
  return built;
}

// Leaves Live mode: hides its panel/status and resets its per-location state,
// so re-entering re-matches the nearest spot from scratch.
function liveExit() {
  document.getElementById("liveHoverPanel").style.display = "none";
  setGpsStatus("");
  if (activeCardFlow) {
    activeCardFlow.close();
    activeCardFlow = null;
  }
  liveMap = null;
  liveMarkState = null;
  liveGpsMarker = null;
  if (liveChart) {
    liveChart.destroy();
    liveChart = null;
  }
  isPanelExpanded = false;
  hasRenderedExpandedContentForCurrentLoc = false;
  hasCenteredLiveChartOnNow = false;
  currentLocationName = null;
  currentType = null;
  currentLoc = null;
  stopFishingTime = null;
}

/**
 * Oliver's own request: out fishing with Live mode open, locking and later unlocking the phone left the "You are
 * here" marker frozen at wherever it was when Live mode was last entered — nothing was ever wired to notice the
 * phone coming back. Re-fetches position and updates the marker/panel IN PLACE (see liveGpsMarker/onMarkerCreated
 * in liveBuildMap) rather than rebuilding the whole map, which would reset zoom/pan and close any open popup for
 * what should be an invisible correction. Runs from two triggers, both wired in liveInitOnce below: the page
 * becoming visible again (phone unlock/app-switch-back), and a manual refresh button as a backup for whichever
 * device/browser doesn't fire that event reliably.
 *
 * Deliberately resume/tap-triggered only, never a running timer — Oliver's own call: this fixes "I looked away
 * and back", not "keep silently polling GPS the whole time the screen's on".
 */
let liveGpsRefreshInFlight = false;
async function liveRefreshGpsPosition({ center = false } = {}) { // center: the Refresh button also pans the map to the new fix (the automatic refreshes leave the view alone)
  if (mapMode !== "live" || !liveMap || liveGpsRefreshInFlight) return;
  liveGpsRefreshInFlight = true;
  setGpsStatus("Refreshing your location…");
  try {
    // getFreshGpsPosition (uncached, this file) — NOT requestGpsPosition (js/week-tools.js), whose fix is
    // memoized and shared with Week Ahead's own home-detection prompt; this refresh must never touch that cache.
    const fresh = await getFreshGpsPosition();
    if (mapMode !== "live" || !liveMap) return; // left Live mode while the fix was in flight
    if (!fresh) {
      // Denied/timed out — keep showing the last-known position rather than clearing it; the same silent
      // tolerance liveEnter itself already has for a missing fix.
      setGpsStatus("");
      return;
    }
    currentGpsPosition = fresh;
    if (liveGpsMarker) liveGpsMarker.setLatLng([fresh.lat, fresh.lng]);
    const match = findNearestLocation(liveData.locations || [], fresh.lat, fresh.lng);
    if (match && match.location.name !== currentLocationName) {
      // Moved far enough (paddled/walked) to now be closer to a different tracked spot — switch to it, keeping
      // whichever type (Kayak/Land based) was already selected rather than resetting to Kayak.
      selectLocationAndType(match.location.name, currentType || "Kayak");
    } else if (currentLoc) {
      // Same spot: just correct the distance readout, no need to touch anything else about the open panel.
      updateDistanceDisplay(currentLoc);
    }
    if (center) liveMap.setView([fresh.lat, fresh.lng], liveMap.getZoom()); // after any location switch above, which can move the view itself
    setGpsStatus("");
  } finally {
    liveGpsRefreshInFlight = false;
  }
}
