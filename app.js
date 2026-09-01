const DATA_URL = "data/conditions.json";

// parseNaive, dayKeyOf, formatDayHeading, dirToArrowRotation, windColor, fmtChartTick,
// buildDayBandPlugin, renderConditionsChart, CONDITION_COLORS, wireHoldToShowTooltip,
// setupFullscreenToggle, setupDragToScroll, fetchWillyWeatherCandidates,
// showLocationCandidatePicker, fetchWillyWeatherPreviewRows, attachConditionScores,
// SHORE_OPTIONS, TYPE_OPTIONS, getConnection, defaultTypeConfig, and
// saveNewLocationToGitHub all come from charts.js (loaded before this file).

let state = {
  data: null, rowsByLocation: {}, chart: null,
  // Only meaningful while the hover panel is showing a PREVIEW (see
  // previewLocationOnMap) — previewRows is what recalcPreviewCondition
  // re-scores and re-renders on every Shore/Type change, without ever
  // needing another network round trip.
  previewRows: null, previewSunTimes: null, previewLoc: null,
  previewShore: null, previewType: "Kayak",
};

// Text hoverPanelEmptyState starts with in the HTML — captured once here so
// the preview flow (which temporarily repurposes this same element for
// "no match found"/"loading"/error messages — see onLocationMapClickForPreview
// and previewLocationOnMap) can always restore it afterward, rather than a
// stale preview message lingering the next time a REAL location genuinely
// has no data.
let defaultEmptyStateText = "";

// Same convention as Week (graphs)' row charts (week-new.js's
// PIXELS_PER_HOUR) — a genuinely readable, un-squashed width per hour of
// data, rather than cramming the whole multi-day forecast into one phone-
// width canvas. Mobile gets a narrower per-hour width than desktop (less
// screen to spend), same as Week (graphs) does.
const isMobileDevice = Math.min(window.innerWidth, window.innerHeight) <= 900;
const PIXELS_PER_HOUR = isMobileDevice ? 16 : 32;

// A location's NAME is no longer unique on its own — the same physical
// spot can have both a Kayak and a Land based entry. Everywhere a single
// location needs to be looked up, use this combined key instead.
function locationKey(name, type) {
  return `${name}::${type}`;
}

async function init() {
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

  groupRowsByLocation();
  renderUpdatedBanner();
  // Awaited — this is a small, fast, local file (not the slow
  // WillyWeather pipeline), so the wait is negligible, and awaiting it
  // avoids a race where the very first chart render below would happen
  // before tideOffset had been merged in.
  await loadTideOffsets(state.data.locations);
  renderLocationMap();

  document.getElementById("btnCloseHoverPanel").addEventListener("click", hideLocationHoverPanel);
  document.getElementById("previewShoreSelect").addEventListener("change", recalcPreviewCondition);
  document.getElementById("previewTypeSelect").addEventListener("change", recalcPreviewCondition);
  document.getElementById("btnAddPreviewAsLocation").addEventListener("click", onAddPreviewAsLocation);

  // Same gesture set as Week (graphs) and Live, all shared from charts.js:
  // hold 2s to toggle the tooltip, double-tap/double-click to toggle real
  // fullscreen, and (desktop only — touch already scrolls natively)
  // click-and-drag to pan the now-horizontally-scrolling graph. Wired once
  // here rather than per-render — this page reuses the same <canvas> and
  // frame across every location switch (destroying/recreating the Chart.js
  // instance each time, never the DOM elements themselves), so wiring
  // these per-render would stack up duplicate listeners.
  wireHoldToShowTooltip(() => state.chart, document.getElementById("conditionsChart"), { suppressQuickTap: true });
  setupFullscreenToggle("locationChartFrame");
  setupDragToScroll(document.getElementById("locationChartScroll"));

  // Restores and shows whichever location was last viewed, rather than
  // starting on a bare map every visit — the selection was already being
  // saved to localStorage on every pick (see selectLocationByKey) even
  // before this, it just wasn't being read back on load until now.
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
  localStorage.setItem("selectedLocation", key);
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
  document.getElementById("locationHoverPanel").style.display = "block";
}

function hideLocationHoverPanel() {
  document.getElementById("locationHoverPanel").style.display = "none";
}

/**
 * Builds the Location tab's map (renderLeafletLocationMap, charts.js) —
 * one marker per distinct location NAME, since lat/lng is the same
 * regardless of which type variant it is. A location with only one type
 * selects directly on click; one with both Kayak and Land based entries
 * opens a small popup to choose between them instead, since a single
 * marker can't otherwise say which of the two the person meant.
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
    if (variants.length === 1) {
      const key = locationKey(variants[0].name, variants[0].type);
      points.push({ lat, lng, label: name, iconKind, onClick: () => selectLocationByKey(key) });
    } else {
      const popupHtml = `
        <div style="font-weight:600;margin-bottom:6px;">${name}</div>
        ${variants
          .map((v) => `<button type="button" class="map-popup-type-btn" data-map-key="${locationKey(v.name, v.type)}">${v.type}</button>`)
          .join("")}
      `;
      points.push({ lat, lng, label: name, iconKind, popupHtml });
    }
  }

  const map = renderLeafletLocationMap("locationMap", points, { onMapClick: onLocationMapClickForPreview });
  if (!map) return;
  // Popup content only exists in the DOM once a popup actually opens (up
  // until then it's just an HTML string Leaflet is holding onto), so its
  // buttons have to be wired here rather than up front.
  map.on("popupopen", (e) => {
    const popupEl = e.popup.getElement();
    popupEl.querySelectorAll("[data-map-key]").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectLocationByKey(btn.dataset.mapKey);
        map.closePopup();
      });
    });
  });
}

/**
 * The Location tab's map-click handler (see renderLocationMap's
 * renderLeafletLocationMap call) — fires on every click on open map area
 * (Leaflet doesn't bubble marker clicks up to this handler, so clicking an
 * existing pin still only ever triggers that marker's own onClick, never
 * this). Gated on canEditLocations() (charts.js's getConnection — same
 * "ghConnection" localStorage entry the Settings tab's Connect button
 * writes): without a GitHub connection there's no way to act on a preview
 * anyway (no "Add as permanent location" button — see
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

/** True only when a GitHub connection already exists (same "ghConnection"
 * localStorage entry the Settings tab's Connect button writes — see
 * getConnection, charts.js) — this page never asks for a token itself, it
 * just checks whether one's already sitting there from a Settings visit. */
function canEditLocations() {
  const conn = getConnection();
  return !!(conn && conn.owner && conn.repo && conn.token);
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
 * saveNewLocationToGitHub, charts.js) — the same minimal shape
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

  const result = await saveNewLocationToGitHub(newLoc);
  if (result.success) {
    btn.textContent = "✓ Added";
    showPreviewAddStatus("Saved to config/locations.json. Trigger a data refresh from Settings (or wait for the next scheduled run) to see it with real scored data.", false);
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
  document.getElementById("updated").textContent = `Updated ${dt.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
}

function renderLocation(key) {
  const loc = state.data.locations.find((l) => locationKey(l.name, l.type) === key);
  const rows = state.rowsByLocation[key] || [];

  document.getElementById("hoverPanelLocationName").textContent = loc ? loc.name : "";
  // A real, saved location's own graph — not a preview (see
  // previewLocationOnMap) — so the preview note/badge/controls never
  // linger onto it if the panel was last showing a preview.
  showPreviewNote(false);
  showPreviewControls(false);
  hideAddPermanentButton();
  state.previewRows = null;
  renderCharts(rows, loc);
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
  // decide the canvas's own size (same reason Week (graphs)'s row charts
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
  // and same fix, as week-new.js's own "void built.chartWrap.offsetHeight"
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
    // by hideValueAxes below, so this has no other effect here. Needed so
    // a plain single click/tap on this graph is a genuine no-op, matching
    // suppressQuickTap below for the tooltip gesture.
    compact: true,
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
    // tap-triggered one — same reasoning/pattern as Live and Week (graphs).
    disableBuiltinEvents: true,
  });
}

init();
