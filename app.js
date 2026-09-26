const DATA_URL = "data/conditions.json";

// parseNaive, dayKeyOf, formatDayHeading, dirToArrowRotation, windColor, fmtChartTick,
// buildDayBandPlugin, renderConditionsChart, CONDITION_COLORS, wireHoldToShowTooltip,
// setupFullscreenToggle, setupDragToScroll, fetchWillyWeatherCandidates,
// showLocationCandidatePicker, fetchWillyWeatherPreviewRows, attachConditionScores,
// SHORE_OPTIONS, TYPE_OPTIONS, defaultTypeConfig, cachedIsAdmin,
// refreshAdminStatus, and saveNewLocationToD1 all come from charts.js
// (loaded before this file).

let state = {
  data: null, rowsByLocation: {}, chart: null,
  // Only meaningful while the hover panel is showing a PREVIEW (see
  // previewLocationOnMap) — previewRows is what recalcPreviewCondition
  // re-scores and re-renders on every Shore/Type change, without ever
  // needing another network round trip.
  previewRows: null, previewSunTimes: null, previewLoc: null,
  previewShore: null, previewType: "Kayak",
  // The real, saved location the hover panel is currently showing (null
  // while showing a preview, or while nothing's open) — read by
  // wireSessionRangeSelect's getLoc getter (js/week-tools.js), wired once
  // in init() against this page's one persistent <canvas> (see that call's
  // own comment for why a getter, not a fixed value). dragPreview is that
  // same wiring's live drag-in-progress state (buildSessionDragPreviewPlugin).
  currentLoc: null, dragPreview: { hoverXVal: null, dragStartXVal: null },
};

// Text hoverPanelEmptyState starts with in the HTML — captured once here so
// the preview flow (which temporarily repurposes this same element for
// "no match found"/"loading"/error messages — see onLocationMapClickForPreview
// and previewLocationOnMap) can always restore it afterward, rather than a
// stale preview message lingering the next time a REAL location genuinely
// has no data.
let defaultEmptyStateText = "";

// Same convention as Week Ahead's row charts (week.js's
// PIXELS_PER_HOUR) — a genuinely readable, un-squashed width per hour of
// data, rather than cramming the whole multi-day forecast into one phone-
// width canvas. Mobile gets a narrower per-hour width than desktop (less
// screen to spend), same as Week Ahead does.
const isMobileDevice = Math.min(window.innerWidth, window.innerHeight) <= 900;
const PIXELS_PER_HOUR = isMobileDevice ? 16 : 32;

// A location's NAME is no longer unique on its own — the same physical
// spot can have both a Kayak and a Land based entry. Everywhere a single
// location needs to be looked up, use this combined key instead.
function locationKey(name, type) {
  return `${name}::${type}`;
}

async function init() {
  await Prefs.load(); // a signed-in user's saved settings (js/prefs.js); the device's own values when signed out or offline
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    document.getElementById("updated").textContent = "Could not load data — has the site run its first update yet?";
    console.error(err);
    return;
  }

  defaultEmptyStateText = document.getElementById("hoverPanelEmptyState").textContent;

  // Small, fast Worker call — awaited so canEditLocations()/
  // showAddPermanentButton() below never race a not-yet-resolved check
  // (see cachedIsAdmin's own comment, charts.js, for the trade-off this
  // makes instead: a stale cache across tabs, not a race within one).
  await refreshAdminStatus();
  await refreshLocationQuota(); // how many more locations this person may add (canAddOwnLocation)

  groupRowsByLocation();
  renderUpdatedBanner();
  // Awaited — this is a small, fast, local file (not the slow
  // WillyWeather pipeline), so the wait is negligible, and awaiting it
  // avoids a race where the very first chart render below would happen
  // before tideOffset had been merged in.
  await loadTideOffsets(state.data.locations);
  // Only Public's and the signed-in person's own locations (locationVisibleToViewer, js/backend.js) — after the live
  // merge above, which is what supplies each one's owner until the next data run records it in the file.
  state.data.locations = state.data.locations.filter(locationVisibleToViewer);
  const visibleKeys = new Set(state.data.locations.map((l) => locationKey(l.name, l.type)));
  for (const key of Object.keys(state.rowsByLocation)) if (!visibleKeys.has(key)) delete state.rowsByLocation[key];
  await applyMyLocationTimings(state.data.locations); // a signed-in person's own times on others' locations

  document.getElementById("btnCloseHoverPanel").addEventListener("click", hideLocationHoverPanel);
  document.getElementById("previewShoreSelect").addEventListener("change", recalcPreviewCondition);
  document.getElementById("previewTypeSelect").addEventListener("change", recalcPreviewCondition);
  document.getElementById("btnAddPreviewAsLocation").addEventListener("click", onAddPreviewAsLocation);

  // Same gesture set as Week Ahead and Live, all shared from charts.js:
  // hold 2s to toggle the tooltip, double-tap/double-click to toggle real
  // fullscreen, and (desktop only — touch already scrolls natively)
  // click-and-drag to pan the now-horizontally-scrolling graph. Wired once
  // here rather than per-render — this page reuses the same <canvas> and
  // frame across every location switch (destroying/recreating the Chart.js
  // instance each time, never the DOM elements themselves), so wiring
  // these per-render would stack up duplicate listeners.
  // No suppressQuickTap here (see wireHoldToShowTooltip's own doc comment,
  // charts.js) — was previously set true, making a quick tap a no-op even
  // while armed, which is exactly the bug Oliver reported: once you'd
  // held to arm the tooltip, clicking elsewhere on the graph did nothing.
  // Now matches Live/Week Ahead: hold 2s to arm, then a plain tap
  // moves the tooltip to wherever you tap next.
  wireHoldToShowTooltip(() => state.chart, document.getElementById("conditionsChart"));
  setupFullscreenToggle("locationChartFrame", { fullscreenOnRotate: false });
  locationPill = mountLocationPill("locationChartFrame", {
    nameId: "hoverPanelLocationName",
    tileIds: ["hoverPanelTileInfo", "hoverPanelSessions", "hoverPanelHint"],
  });
  setupDragToScroll(document.getElementById("locationChartScroll"));

  // Same computed (drag-derived) schedule storage Week Ahead uses
  // (js/week-tools.js) — a schedule computed here shows up there too, and
  // vice versa, since both read/write the same locationName+locationType-
  // keyed records.
  computedSessions = loadComputedSessions();
  // Wired once against this page's one persistent <canvas>, same reasoning
  // as wireHoldToShowTooltip/setupDragToScroll just above — see
  // wireSessionRangeSelect's own comment (js/week-tools.js) for why it
  // takes getters here rather than fixed values.
  wireSessionRangeSelect(
    () => state.chart,
    document.getElementById("conditionsChart"),
    () => state.currentLoc,
    state.dragPreview,
    () => {
      if (state.currentLoc) renderLocation(locationKey(state.currentLoc.name, state.currentLoc.type));
    }
  );

  liveInitOnce();
  wireMapToolbar();
  initHomesToolbar(); // the house-with-+ button (js/homes.js)
  // A review that was loaded but never finished or cancelled (Import mode,
  // see map-sync.js/sync.js) survives leaving this tab: it's restored here,
  // and the map stays in Import mode until the person imports or cancels.
  const hasSavedReview = cachedIsAdmin ? await syncInit() : false;
  await setMode(hasSavedReview ? "import" : baseModeFromPrefs());
}

// In the installed app (Android), 100dvh can be taller than the window you can actually see — measured on a
// phone: a 781px page in a 725px window until the phone was rotated, which the old fixed bottom gap papered
// over and then showed as an empty strip after rotating. So there the page height follows window.innerHeight
// exactly (the --app-height var used by .map-fullpage-body); in a normal browser tab the var stays unset and
// the page keeps using 100dvh.
function syncAppHeight() {
  const root = document.documentElement;
  const apply = () => {
    if (window.matchMedia("(display-mode: standalone)").matches) root.style.setProperty("--app-height", `${window.innerHeight}px`);
    else root.style.removeProperty("--app-height");
  };
  apply();
  // The window's height settles a moment after a rotation, so re-read a few times as well as on every resize.
  const soon = () => {
    apply();
    for (const ms of [150, 500, 1200]) setTimeout(apply, ms);
  };
  window.addEventListener("resize", apply);
  window.addEventListener("orientationchange", soon);
  window.addEventListener("pageshow", soon);
  document.addEventListener("fullscreenchange", soon);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) soon();
  });
  if (window.visualViewport) window.visualViewport.addEventListener("resize", apply);
}

// ---------------------------------------------------------------------------
// Map modes: "normal" (tracked locations + marks, the old Location tab),
// "live" (GPS, nearest location, quick mark entry — the old Live tab) and
// "import" (a device export under review — the old Sync tab). Every mode
// draws onto the ONE #locationMap; changing mode tears the old map down and
// builds a fresh one, so nothing from the previous mode's layers or click
// handlers can leak into the next.
// ---------------------------------------------------------------------------
const LIVE_MODE_STORAGE_KEY = "mapLiveMode"; // per device on purpose (not synced): Live is a phone-in-the-field thing

let mapMode = null;
let modeToken = 0; // bumped on every mode change, so a slow GPS lookup can tell it's been superseded
// The marks layer state of whichever map is showing (Normal or Live) — read by
// the export button (getVisibleMarks) so it exports exactly what the filters leave visible.
let currentMarkLayerState = null;

function liveModePreferred() {
  try {
    return localStorage.getItem(LIVE_MODE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function baseModeFromPrefs() {
  return liveModePreferred() ? "live" : "normal";
}

// Undoes whatever the current mode put on screen. Never touches saved
// preferences (hideLocationHoverPanel clears the remembered location, so it
// isn't used here).
function teardownMode() {
  if (currentMarkLayerState) currentMarkLayerState._discarded = true;
  currentMarkLayerState = null;
  if (typeof closeMarkDetailPanel === "function") closeMarkDetailPanel();
  document.getElementById("locationHoverPanel").style.display = "none";
  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }
  if (mapMode === "live") liveExit();
  if (mapMode === "import") syncDetachMap();
  document.getElementById("markControlsBar").style.display = "none";
  detachHomes();
  cancelPinMove();
  document.getElementById("markFilterBtn").style.display = "none";
  document.getElementById("exportStatus").textContent = "";
}

async function setMode(next) {
  const token = ++modeToken;
  teardownMode();
  mapMode = next;
  applyModeChrome();

  if (next === "import") {
    buildImportMap();
    return;
  }
  if (next === "live") {
    const built = await liveEnter(() => token !== modeToken);
    if (built) currentMarkLayerState = built.markLayerState;
    return;
  }
  renderLocationMap();
  restoreSavedLocation();
}

// Which toolbar controls and panels each mode shows.
function applyModeChrome() {
  const isImport = mapMode === "import";
  const isLive = mapMode === "live";
  const liveToggle = document.getElementById("liveModeToggle");
  liveToggle.checked = isLive || (isImport && liveModePreferred());
  liveToggle.disabled = isImport;
  const deviceTools = document.getElementById("mapDeviceTools");
  deviceTools.style.display = cachedIsAdmin && mapMode === "normal" ? "flex" : "none";
  document.getElementById("btnSessionDefaults").style.display = isLive ? "" : "none";
  document.getElementById("btnLiveSession").style.display = isLive && cachedIsSignedIn ? "" : "none";
  document.getElementById("btnRefreshLiveGps").style.display = isLive ? "" : "none";
  // End Session/Move and +Catch are never shown just because Live mode is on — only updateLiveSessionButtons
  // (map-live.js) reveals them, once the marks have actually loaded and confirm there's an active session (+Catch
  // only makes sense once a session's actually underway to log a catch against).
  document.getElementById("btnLiveEndSession").style.display = "none";
  document.getElementById("btnLiveCatch").style.display = "none";
  document.getElementById("importReviewPanel").style.display = isImport ? "flex" : "none";
  document.getElementById("markDetailPanel").style.display = "none";
  if (!isLive) document.getElementById("liveGpsStatus").style.display = "none";
  if (isLive) document.getElementById("parseStatus").textContent = "";
  document.body.classList.toggle("import-mode", isImport);
}

function wireMapToolbar() {
  document.getElementById("liveModeToggle").addEventListener("change", (e) => {
    const on = e.target.checked;
    try {
      localStorage.setItem(LIVE_MODE_STORAGE_KEY, on ? "1" : "0");
    } catch {
      /* storage blocked — the toggle still works for this visit */
    }
    setMode(on ? "live" : "normal");
  });
}

// Import mode: the shared map with NO tracked-location pins and NO marks
// layer — only what's in the import file (drawn by sync.js) is on it.
function buildImportMap() {
  const map = renderLeafletLocationMap("locationMap", [], {
    persistView: false,
    onMapClick: () => {}, // no new marks while reviewing; the trail line and popups handle their own clicks
  });
  if (map) syncShowReview(map);
}

// Called by sync.js when the review is finished or cancelled.
function leaveImportMode() {
  return setMode(baseModeFromPrefs());
}

// Restores and shows whichever location was last viewed, rather than
// starting on a bare map every visit. If the panel was last explicitly
// closed instead (see hideLocationHoverPanel, which clears this same
// entry), there's nothing saved here and the map correctly starts with no
// panel open.
function restoreSavedLocation() {
  const saved = localStorage.getItem("selectedLocation");
  if (saved && state.rowsByLocation[saved]) {
    // Panel visible BEFORE rendering the chart into it, not after — see
    // the comment on this same ordering in selectLocationByKey below.
    showLocationHoverPanel();
    renderLocation(saved);
  }
}

// Shared by the map's marker clicks (both the direct single-type case and
// the multi-type popup's buttons) — persists the choice, renders it into
// the hover panel, and shows the panel. There's no dropdown any more (see
// the map-fills-the-page redesign) — the map IS the only way to pick a
// location now, so this is the map's marker-click handler in all but name.
function selectLocationByKey(key) {
  Prefs.set("selectedLocation", key);
  // Show the panel FIRST, then render — a canvas inside a display:none
  // ancestor measures as zero width/height, and Chart.js reads that
  // measurement at construction time (new Chart(canvas, ...), inside
  // renderLocation -> renderCharts). Rendering into a chart that was
  // built against a 0x0 canvas and only fixed up later by Chart.js's own
  // internal resize-observer catching up produced exactly the "graph
  // looks lifted, weird space on the right" symptoms reported — this
  // ordering avoids ever handing Chart.js a hidden canvas to measure in
  // the first place, rather than relying on it to self-correct after.
  showLocationHoverPanel();
  renderLocation(key);
}

/**
 * The graph panel that floats over the map on marker click (see
 * .location-hover-panel, style.css). Also shown automatically on page
 * load for whichever location was last viewed (see the end of init()) —
 * the localStorage persistence in selectLocationByKey was already there
 * before that was wired up, it just wasn't being read back yet.
 */
function showLocationHoverPanel() {
  // Closes the mark detail panel first, if open — real, reported bug:
  // both panels open at once left the conditions graph squeezed into
  // whatever width the mark panel didn't already take, rather than its
  // own full width. The two serve different purposes and were never
  // meant to compete for the same space simultaneously.
  if (typeof closeMarkDetailPanel === "function") closeMarkDetailPanel();
  document.getElementById("locationHoverPanel").style.display = "block";
}

function hideLocationHoverPanel() {
  document.getElementById("locationHoverPanel").style.display = "none";
  // Closing is itself part of "last viewed state" — without this, init()'s
  // restore-on-load below would keep reopening whatever location was last
  // SELECTED even after being explicitly closed, since selecting one and
  // closing the panel are two separate actions and only the first one was
  // ever being remembered. Clearing it here makes "nothing open" a real,
  // rememberable state of its own, not just an unsaved transient one.
  Prefs.remove("selectedLocation");
  // Nothing left to arm a schedule against once the panel's closed — also
  // clears any leftover "armed-for-schedule" outline/touch-action lock if
  // this location happened to still be armed (js/week-tools.js).
  state.currentLoc = null;
  disarmSchedule();
}

/**
 * Builds the Location tab's map (renderLeafletLocationMap, charts.js) —
 * one marker per distinct location NAME, since lat/lng is the same
 * regardless of which type variant it is. A location with only one type
 * selects directly on click; one with several types (Kayak and Land based)
 * opens its Kayak graph (or its first type, if it has no Kayak entry) — the
 * other types are pills next to the graph's name (renderLocationTypePills).
 */
function renderLocationMap() {
  const byName = new Map();
  for (const loc of state.data.locations) {
    if (!byName.has(loc.name)) byName.set(loc.name, []);
    byName.get(loc.name).push(loc);
  }

  const points = [];
  for (const [name, variants] of byName) {
    const { lat, lng } = variants[0];
    const types = variants.map((v) => v.type);
    const iconKind = types.includes("Kayak") && types.includes("Land based") ? "both" : types.includes("Land based") ? "landBased" : "kayak";
    const first = variants.find((v) => v.type === "Kayak") || variants[0];
    const key = locationKey(first.name, first.type);
    points.push({
      lat,
      lng,
      label: displayNameFor(first),
      iconKind,
      // Clicking the pin you're carrying puts it back down (js/location-move.js); otherwise it opens the location.
      onClick: (e) => (isCarryingPin(e.target) ? cancelPinMove() : selectLocationByKey(key)),
      onLongPress: (marker) => startPinMove(first, marker, iconKind), // hold 2 s to pick the pin up and move it
    });
  }

  const markLayerState = createMarkLayerState();
  currentMarkLayerState = markLayerState;
  const map = renderLeafletLocationMap("locationMap", points, {
    onMapClick: (lat, lng) => handleMapClickForMarks(map, lat, lng, markLayerState, onLocationMapClickForPreview),
  });
  if (!map) return;
  renderHomeMarkers(map); // the signed-in person's homes (js/homes.js)
  // Fishing marks (data/marks.json) — an extra layer over the tracked-location
  // pins above, only for whoever has a GitHub connection set up (see
  // loadAndRenderMarks's own comment for exactly what that does and doesn't
  // gate). Fire-and-forget: this page's own map/location rendering doesn't
  // need to wait on it. markLayerState is created above (not inside
  // loadAndRenderMarks) so the onMapClick handler just wired in has
  // somewhere to read marksById/markersById/markLists from once this
  // finishes loading them, without a second callback.
  loadAndRenderMarks(map, markLayerState);
}

/**
 * The Location tab's map-click handler (see renderLocationMap's
 * renderLeafletLocationMap call) — fires on every click on open map area
 * (Leaflet doesn't bubble marker clicks up to this handler, so clicking an
 * existing pin still only ever triggers that marker's own onClick, never
 * this). Gated on canEditLocations() (cachedIsAdmin, refreshed once at
 * page load — see charts.js): without Admin sign-in there's no way to
 * act on a preview anyway (no "Add as permanent location" button — see
 * showAddPermanentButton), so an open-map click is simply a no-op for a
 * visitor who's just viewing the public site, same as it was before this
 * feature existed at all — only existing markers stay clickable. Looks up
 * real WillyWeather candidates near the clicked point (shared
 * fetchWillyWeatherCandidates, charts.js) and either previews the one
 * match directly, lets the person pick between several
 * (showLocationCandidatePicker, allowManual:false — there's no manual
 * fallback that makes sense here, unlike the Settings tab's own use of
 * this same picker), or shows a friendly "nothing nearby" message if
 * WillyWeather has no match at all.
 */
async function onLocationMapClickForPreview(lat, lng) {
  if (!canEditLocations()) return;

  const candidates = await fetchWillyWeatherCandidates(lat, lng);
  if (!candidates || candidates.length === 0) {
    showLocationHoverPanel();
    document.getElementById("hoverPanelLocationName").textContent = "Preview";
    setLocationEditGear(null); // a preview isn't a saved location — nothing to edit
    renderLocationTypePills(null);
    state.currentLoc = null;
    disarmSchedule();
    renderScheduleControls(null);
    showPreviewNote(false);
    showPreviewControls(false);
    hideAddPermanentButton();
    document.getElementById("locationChartFrame").style.display = "none";
    const emptyState = document.getElementById("hoverPanelEmptyState");
    emptyState.textContent = "No WillyWeather location found near that point — try clicking somewhere closer to the coast.";
    emptyState.style.display = "block";
    return;
  }

  let candidate = candidates[0];
  if (candidates.length > 1) {
    const result = await showLocationCandidatePicker(candidates, { allowManual: false });
    if (result.action !== "pick") return; // cancelled out of the picker — leave whatever was showing before untouched
    candidate = result.candidate;
  }

  await previewLocationOnMap(candidate, lat, lng);
}

/**
 * Fetches and renders a live WillyWeather preview for a clicked point into
 * the SAME hover panel/graph a real saved location uses (renderCharts is
 * shared unchanged — it only ever needed rows + a loc-shaped object, and a
 * preview can supply both without being a real entry in
 * state.rowsByLocation). Deliberately does NOT persist anything to
 * localStorage — a preview is a one-off look, not a "last viewed
 * location" a future page load should restore.
 */
async function previewLocationOnMap(candidate, clickLat, clickLng) {
  showLocationHoverPanel();
  document.getElementById("hoverPanelLocationName").textContent = `${candidate.name} (preview)`;
  setLocationEditGear(null); // a preview isn't a saved location — nothing to edit
    renderLocationTypePills(null);
  // A preview has no saved setUp/timeToSpot/packUp/timeFromSpot config to
  // compute a schedule from, so no arm buttons/computed chips for it —
  // also clears state.currentLoc so wireSessionRangeSelect's getLoc getter
  // (init()) can't be dragged against whichever REAL location was showing
  // right before this preview started.
  state.currentLoc = null;
  disarmSchedule();
  renderScheduleControls(null);
  showPreviewNote(true);
  showPreviewControls(false);
  document.getElementById("locationChartFrame").style.display = "none";
  const emptyState = document.getElementById("hoverPanelEmptyState");
  emptyState.textContent = "Loading preview…";
  emptyState.style.display = "block";

  // clickLat/clickLng (the person's own precision) feed Open-Meteo's
  // pressure/marine calls, same "the person's own precision beats a
  // station centroid" reasoning already established for the Settings
  // map's click-to-add flow (see createNewLocationAt, locationsadmin.js).
  // candidate.lat/candidate.lng are passed SEPARATELY — the shore-
  // direction guess deliberately uses WillyWeather's OWN resolved
  // coordinate instead (Oliver's own call), not the click.
  const preview = await fetchWillyWeatherPreviewRows(candidate.id, clickLat, clickLng, candidate.lat, candidate.lng);
  if (!preview || preview.rows.length === 0) {
    emptyState.textContent = "Couldn't load a preview for this spot — WillyWeather or Open-Meteo data wasn't available just now.";
    return;
  }

  state.previewRows = preview.rows;
  state.previewSunTimes = preview.sunTimes;
  state.previewLoc = {
    name: candidate.name,
    tideMaxObserved: preview.tideMaxObserved,
    // No saved config exists yet for a clicked-but-not-added spot, so
    // there's no per-location minTideHeight/tideOffset to apply — the
    // graph draws with sensible defaults for both, same as it would for a
    // brand-new location that hasn't had these set yet either.
    minTideHeight: null,
    tideOffset: null,
  };
  // Kept for onAddPreviewAsLocation below — building a real
  // config/locations.json entry needs the WillyWeather candidate's own
  // id/name/region/state, the click's own lat/lng (same "person's own
  // precision beats a station centroid" reasoning as everywhere else —
  // see createNewLocationAt, locationsadmin.js), and whether this preview
  // turned out tidal, all of which only exist right here, right now.
  state.previewCandidate = candidate;
  state.previewClickLat = clickLat;
  state.previewClickLng = clickLng;
  state.previewTidal = preview.tidal;

  // Type defaults to Kayak regardless of tidal-ness (Oliver's call) —
  // Shore only gets an auto-guessed starting value when WillyWeather
  // actually returned tide data for this spot (preview.shoreGuess is
  // already null otherwise — see buildPreviewRows, charts.js). Either
  // way it's just a STARTING value; both are editable via the controls
  // this populates below, and Location Condition recalculates live off
  // whatever the person leaves them at.
  state.previewType = "Kayak";
  state.previewShore = preview.shoreGuess;

  populatePreviewControls(preview.tidal, preview.shoreGuess);
  // Defaults to WillyWeather's own resolved name, same starting point
  // createNewLocationAt (locationsadmin.js) uses for both its own name
  // fields — freely editable here before "Add as permanent location" is
  // ever clicked, so the saved location can start with the right display
  // name from the very first save rather than needing a follow-up edit
  // in Settings.
  document.getElementById("previewDisplayNameInput").value = candidate.name || "";
  showAddPermanentButton();
  recalcPreviewCondition();
}

/**
 * Fills in and shows the Shore/Type dropdowns above the preview graph —
 * SHORE_OPTIONS/TYPE_OPTIONS come from charts.js (shared with
 * locationsadmin.js's own location editor, same lists). Doesn't wire
 * their change listeners here — those are wired ONCE in init() (see
 * onPreviewShoreOrTypeChange), same reasoning as every other listener
 * wired once against this page's reused DOM rather than per-render.
 */
function populatePreviewControls(tidal, shoreGuess) {
  const shoreSelect = document.getElementById("previewShoreSelect");
  const typeSelect = document.getElementById("previewTypeSelect");

  shoreSelect.innerHTML =
    `<option value="">— pick shore —</option>` +
    SHORE_OPTIONS.map((s) => `<option value="${s}">${s}</option>`).join("");
  shoreSelect.value = shoreGuess || "";

  typeSelect.innerHTML = TYPE_OPTIONS.map((t) => `<option value="${t}">${t}</option>`).join("");
  typeSelect.value = state.previewType;

  const hint = document.getElementById("previewShoreHint");
  if (!tidal) {
    hint.textContent = "No tide data for this spot — shore direction wasn't auto-detected; pick one to see Location Condition.";
  } else if (shoreGuess) {
    hint.textContent = "Auto-detected from nearby coastline data — double-check it, and change it if it looks wrong.";
  } else {
    hint.textContent = "Couldn't auto-detect a shore direction here — pick one to see Location Condition.";
  }

  showPreviewControls(true);
}

function showPreviewControls(show) {
  document.getElementById("hoverPanelPreviewControls").style.display = show ? "flex" : "none";
}

/**
 * Wired once in init() to both the Shore and Type <select>s — re-scores
 * Location Condition against whatever's already been fetched (no network
 * call needed, see attachConditionScores, charts.js) and re-renders. A
 * no-op if there's no active preview (state.previewRows unset), which can
 * only happen if these somehow fired while hidden — defensive, not
 * expected in normal use.
 */
function recalcPreviewCondition() {
  if (!state.previewRows) return;
  state.previewShore = document.getElementById("previewShoreSelect").value || null;
  state.previewType = document.getElementById("previewTypeSelect").value;
  attachConditionScores(state.previewRows, state.previewType, state.previewShore);
  renderCharts(state.previewRows, state.previewLoc, state.previewSunTimes);
}

function showPreviewNote(show) {
  const el = document.getElementById("hoverPanelPreviewNote");
  if (el) el.style.display = show ? "block" : "none";
}

/** Whether this person may preview a clicked spot and add it as a location: Admin (adds to Public), or anyone signed
 * in while their tier's extra-location allowance has room (canAddOwnLocation, js/backend.js). */
function canEditLocations() {
  return canAddOwnLocation();
}

/**
 * Shows/resets the "Add as permanent location" button for the CURRENT
 * preview — only ever shown if canEditLocations() (no point offering a
 * save action that would just fail with "not connected"). Called once per
 * fresh preview (previewLocationOnMap) so a stale "✓ Added" from a
 * PREVIOUS preview never lingers onto a new one.
 */
function showAddPermanentButton() {
  const btn = document.getElementById("btnAddPreviewAsLocation");
  btn.style.display = canEditLocations() ? "block" : "none";
  btn.disabled = false;
  btn.textContent = "➕ Add as permanent location";
  showPreviewAddStatus("", false);
}

function hideAddPermanentButton() {
  document.getElementById("btnAddPreviewAsLocation").style.display = "none";
  showPreviewAddStatus("", false);
}

function showPreviewAddStatus(text, isError) {
  const el = document.getElementById("previewAddStatus");
  el.textContent = text;
  el.style.color = isError ? "#dc2626" : "";
  el.style.display = text ? "block" : "none";
}

/**
 * Saves the CURRENT preview as a real config/locations.json entry (see
 * saveNewLocationToD1, charts.js) — the same minimal shape
 * createNewLocationAt (locationsadmin.js's own map-click-to-add flow)
 * builds: name/shore/types/lat/lng plus the WillyWeather id/name/region/
 * state cache, so this location's very first scheduled run already has a
 * confirmed WillyWeather id and never needs to search for it at all. The
 * one thing createNewLocationAt can't supply that this CAN: `tidal` —
 * this preview already determined that live (see buildPreviewRows,
 * charts.js), where the manual click-to-add flow has no way to know it
 * until the first scheduled run's own WillyWeather response comes back.
 * Requires a Shore to already be picked — every location needs one (same
 * rule validateLocations, locationsadmin.js, already enforces before a
 * Settings save), and a preview with no shore guess and none picked
 * manually yet has nothing valid to save.
 */
async function onAddPreviewAsLocation() {
  if (!state.previewLoc || !state.previewCandidate) return;
  if (!state.previewShore) {
    showPreviewAddStatus("Pick a Shore direction first — every location needs one.", true);
    return;
  }

  const btn = document.getElementById("btnAddPreviewAsLocation");
  btn.disabled = true;
  btn.textContent = "Saving…";
  showPreviewAddStatus("", false);

  const newLoc = {
    name: state.previewCandidate.name,
    // Read straight from the input rather than a tracked state
    // variable — same "just read the DOM element directly when it's
    // needed" pattern state.previewShore/previewType already follow
    // (recalcPreviewCondition), rather than needing its own dedicated
    // change listener to keep something in sync. Both fields default to
    // the same WillyWeather-resolved name — Oliver's own request — but
    // this one is freely editable in the meantime, so whatever the
    // person actually left in the field wins.
    displayName: document.getElementById("previewDisplayNameInput").value.trim() || state.previewCandidate.name,
    shore: state.previewShore,
    types: [defaultTypeConfig(state.previewType)],
    lat: state.previewClickLat,
    lng: state.previewClickLng,
    tidal: state.previewTidal,
    willyweatherId: state.previewCandidate.id,
    willyweatherName: state.previewCandidate.name,
    willyweatherRegion: state.previewCandidate.region,
    willyweatherState: state.previewCandidate.state,
  };

  const result = await saveNewLocationToD1(newLoc);
  if (result.success) {
    btn.textContent = "✓ Added";
    await refreshLocationQuota();
    showPreviewAddStatus(
      cachedIsAdmin
        ? "Saved to Public. Trigger a data refresh from Settings (or wait for the next scheduled run) to see it with real scored data."
        : "Saved to your account. It shows with real scored data after the next scheduled data run (every 3 hours).",
      false
    );
  } else {
    btn.disabled = false;
    btn.textContent = "➕ Add as permanent location";
    showPreviewAddStatus(result.error, true);
  }
}

function groupRowsByLocation() {
  state.rowsByLocation = {};
  for (const row of state.data.rows) {
    row._t = parseNaive(row.dateTime);
    const key = locationKey(row["Location Name"], row["Type"]);
    if (!state.rowsByLocation[key]) state.rowsByLocation[key] = [];
    state.rowsByLocation[key].push(row);
  }
  for (const key in state.rowsByLocation) {
    state.rowsByLocation[key].sort((a, b) => a._t - b._t);
  }
}

function renderUpdatedBanner() {
  if (!state.data.generatedAt) {
    document.getElementById("updated").textContent = "Not updated yet — waiting on the first scheduled run";
    return;
  }
  const dt = new Date(state.data.generatedAt);
  setUpdatedStamp(document.getElementById("updated"), dt);
}

// The pill tile's "Good sessions" list — same sessions, same saved
// thresholds (Week Ahead's Thresholds & filters) as the Week Ahead tab.
function renderTileSessions(rows) {
  const box = document.getElementById("hoverPanelSessions");
  const sessions = computeQualifyingSessions(rows);
  box.innerHTML = `<div class="loc-tile-heading">Good sessions</div>`;
  if (sessions.length === 0) {
    box.insertAdjacentHTML("beforeend", `<p class="footnote" style="margin:0;text-align:left;">No qualifying session in this period.</p>`);
    return;
  }
  for (const s of sessions) box.appendChild(buildSessionChipElement(s));
}

/** Pills after the graph panel's name (and gear) for a location usable for several types — Kayak first — with the
 * shown one selected; tapping another switches the graph to it. Empty (hidden) for a single-type location or a
 * preview (loc null). */
function renderLocationTypePills(loc) {
  const box = document.getElementById("hoverPanelTypePills");
  const variants = loc ? state.data.locations.filter((l) => l.name === loc.name) : [];
  if (variants.length < 2) {
    box.innerHTML = "";
    return;
  }
  variants.sort((a, b) => (a.type === "Kayak" ? -1 : b.type === "Kayak" ? 1 : 0));
  box.innerHTML = variants
    .map((v) => {
      const on = v.type === loc.type;
      return `<button type="button" class="loc-chip mark-pill${on ? " is-on" : ""}" aria-pressed="${on}" data-type-key="${escapeHtml(locationKey(v.name, v.type))}">${escapeHtml(v.type)}</button>`;
    })
    .join("");
  box.querySelectorAll("[data-type-key]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.getAttribute("aria-pressed") !== "true") selectLocationByKey(btn.dataset.typeKey);
    });
  });
}

/** The gear after the graph panel's location name (Admin only): runs `handler` on a click; null hides it. */
function setLocationEditGear(handler) {
  const btn = document.getElementById("hoverPanelEditLocationBtn");
  btn.hidden = !handler;
  btn.onclick = handler || null;
}

let locationPill = null; // floating name pill + details tile on the graph (mountLocationPill, js/week-tools.js)

function renderLocation(key) {
  const loc = state.data.locations.find((l) => locationKey(l.name, l.type) === key);
  const rows = state.rowsByLocation[key] || [];
  state.currentLoc = loc || null; // read live by wireSessionRangeSelect's getLoc getter (init())
  disarmSchedule(); // a schedule armed for the PREVIOUS location/type no longer applies here (js/week-tools.js)

  document.getElementById("hoverPanelLocationName").textContent = loc ? displayNameFor(loc) : "";
  document.getElementById("hoverPanelTileInfo").innerHTML = loc
    ? `<div class="loc-tile-type">${escapeHtml(loc.type)}</div><div>Shore ${escapeHtml(loc.shore || "–")}</div>`
    : "";
  if (loc && locationPill) locationPill.setPhoto(loc.type);
  renderLocationTypePills(loc);
  // Admin: the gear after the name edits this location (js/location-editor.js); after each save the live config is
  // merged back in and this same graph redrawn, so the change shows straight away.
  // Anyone signed in: the location's owner or Admin edit the location; anyone else edits their own times for it.
  setLocationEditGear(
    loc && cachedIsSignedIn
      ? () =>
          openLocationEditor(loc.name, {
            onChanged: async () => {
              await mergeLiveLocationConfig(state.data.locations);
              await applyMyLocationTimings(state.data.locations);
              renderLocation(key);
            },
            onRemoved: () => {
              hideLocationHoverPanel();
              state.data.locations = state.data.locations.filter((l) => l.name !== loc.name);
              for (const k of Object.keys(state.rowsByLocation)) if (k.startsWith(`${loc.name}::`)) delete state.rowsByLocation[k];
              refreshLocationQuota();
              setMode(mapMode); // redraws the map without its pin
            },
          })
      : null
  );
  renderTileSessions(rows);
  renderScheduleControls(loc);
  // A real, saved location's own graph — not a preview (see
  // previewLocationOnMap) — so the preview note/badge/controls never
  // linger onto it if the panel was last showing a preview.
  showPreviewNote(false);
  showPreviewControls(false);
  hideAddPermanentButton();
  state.previewRows = null;
  renderCharts(rows, loc);
}

/**
 * The "+ Fishing times" / "+ Home to home" buttons and the list of
 * already-computed schedules for this location — the same feature Week
 * Ahead has (js/week-tools.js), added here so a schedule can be planned
 * straight from the Map tab's own graph, not just from Week Ahead's board.
 * null (or a preview — see previewLocationOnMap) hides both, same as
 * renderLocationTypePills/renderTileSessions above.
 */
function renderScheduleControls(loc) {
  const btnsBox = document.getElementById("hoverPanelScheduleButtons");
  const chipsBox = document.getElementById("hoverPanelComputedSessions");
  btnsBox.innerHTML = "";
  chipsBox.innerHTML = "";
  if (!loc) return;

  btnsBox.appendChild(buildTripOriginSelect());
  const canvas = document.getElementById("conditionsChart");
  for (const { mode, label } of [
    { mode: "fishing", label: "+ Fishing times" },
    { mode: "onsite", label: "+ Home to home" },
  ]) {
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "weeknew-add-fishing-times";
    addBtn.textContent = label;
    addBtn.addEventListener("click", () => {
      onArmScheduleClick(loc, document.getElementById("locationChartFrame"), addBtn, mode, () => state.chart, canvas, document.getElementById("locationChartScroll"));
    });
    btnsBox.appendChild(addBtn);
  }

  const thisLocComputed = computedSessions.filter((r) => r.locationName === loc.name && r.locationType === loc.type);
  for (const record of thisLocComputed) {
    chipsBox.appendChild(buildComputedSessionChip(record, () => renderLocation(locationKey(loc.name, loc.type))));
  }
}

// sunTimesOverride lets previewLocationOnMap supply WillyWeather's own
// sunrise/sunset for a clicked-but-unsaved point directly, rather than
// this falling back to state.data.sunTimes (which only has entries for
// this site's own saved locations, keyed by their saved name — a preview
// has no entry there at all). Every other caller doesn't pass this, so
// falls back to exactly the lookup that always ran here before.
function renderCharts(rows, loc, sunTimesOverride) {
  const emptyState = document.getElementById("hoverPanelEmptyState");
  const frame = document.getElementById("locationChartFrame");
  const chartWrap = document.getElementById("locationChartWrap");

  if (rows.length === 0) {
    if (state.chart) {
      state.chart.destroy();
      state.chart = null;
    }
    frame.style.display = "none";
    // Restores the normal "no data for this location" copy — the same
    // element gets repurposed for preview loading/error messages (see
    // onLocationMapClickForPreview/previewLocationOnMap), and without this
    // a preview's message could otherwise linger and be shown again here
    // for an unrelated, genuinely-empty real location later.
    emptyState.textContent = defaultEmptyStateText;
    emptyState.style.display = "block";
    return;
  }
  frame.style.display = "block";
  emptyState.style.display = "none";

  // Mobile keeps the wide, un-squashed, horizontally-scrollable graph
  // (explicit pixel width proportional to the real time range — see
  // PIXELS_PER_HOUR above), set BEFORE renderConditionsChart runs, since
  // Chart.js measures its canvas's parent's width at construction time to
  // decide the canvas's own size (same reason Week Ahead's row charts
  // set their wrapper's width right before rendering into it, not after).
  // Desktop instead shows the whole graph with no scrolling at all —
  // clearing any previous inline width here lets it fall back to CSS's
  // min-width:100%, which (with nothing else constraining it wider) means
  // exactly 100% of the visible frame, Chart.js squashing the data to fit
  // exactly like it did before the wide/scrollable mobile behavior existed.
  if (isMobileDevice) {
    const totalHours = Math.max(1, (rows[rows.length - 1]._t - rows[0]._t) / 3600000);
    chartWrap.style.width = Math.round(totalHours * PIXELS_PER_HOUR) + "px";
  } else {
    chartWrap.style.width = "";
  }
  // Force layout before Chart.js measures this canvas — same reasoning,
  // and same fix, as week.js's own "void built.chartWrap.offsetHeight"
  // before rendering into a row: a canvas can measure as zero/stale size
  // if Chart.js reads it before the browser has actually settled layout,
  // which the frame.style.display and chartWrap.style.width changes just
  // above both trigger. Reading offsetHeight forces the browser to
  // actually apply pending layout changes synchronously before the next
  // line runs, rather than leaving them queued for whenever it would
  // otherwise next repaint.
  void chartWrap.offsetHeight;
  // Scrolling back to the start on every new render (a fresh location, or
  // the same one re-rendering) — otherwise a location switch could leave
  // the new graph scrolled to wherever the PREVIOUS location's view
  // happened to be left, which is disorienting since "now" is always meant
  // to be near the start of the visible window. A no-op on desktop, since
  // there's nothing to scroll there in the first place.
  document.getElementById("locationChartScroll").scrollLeft = 0;

  const sunTimes = sunTimesOverride || (loc && state.data.sunTimes && state.data.sunTimes[loc.name]) || [];
  state.chart = renderConditionsChart({
    canvas: document.getElementById("conditionsChart"),
    rows,
    sunTimes,
    existingChart: state.chart,
    tideMaxObserved: loc ? loc.tideMaxObserved : null,
    moonPhases: state.data.moonPhases,
    minTideHeight: loc ? loc.minTideHeight : null,
    // true (not the site's usual false) purely to disable
    // renderConditionsChart's own legend-toggle-on-click listener — every
    // OTHER thing compact:true would normally also change (hiding axes,
    // skipping buildAxisUnitLabelsPlugin) is already independently covered
    // by hideValueAxes below, so this has no other effect here.
    compact: true,
    // Shades the good sessions on the graph, same as Week Ahead does.
    sessionSpan: computeQualifyingSessions(rows).map((s) => ({ from: s.from, to: s.to })),
    // Flags for any already-computed ("+ Fishing times"/"+ Home to home")
    // schedule for this location — same computedSessions list Week Ahead
    // reads (js/week-tools.js). None for a preview (loc null).
    computedSessionMarkers: loc ? computedSessions.filter((r) => r.locationName === loc.name && r.locationType === loc.type) : [],
    // Live drag-in-progress preview, read by buildSessionDragPreviewPlugin
    // — updated by wireSessionRangeSelect (wired once in init()).
    dragPreviewState: () => state.dragPreview,
    tideOffsetMinutes: loc ? loc.tideOffset : null,
    // The floating panel is a quick-glance view — the °C/km/h axis numbers
    // aren't very readable at this size anyway, and hiding them frees up
    // real width/height for the plot itself.
    hideValueAxes: true,
    // Draws the date headings/moon icons INSIDE the plot area instead of
    // reserving a separate strip above it for them — reclaims real
    // vertical space.
    overlayHeading: true,
    // This page now drives the tooltip itself (hold-2s, see
    // wireHoldToShowTooltip in init()) rather than Chart.js's own default
    // tap-triggered one — same reasoning/pattern as Live and Week Ahead.
    disableBuiltinEvents: true,
  });
}

syncAppHeight(); // before init() awaits anything, so the page is the right height from the first paint
init();
