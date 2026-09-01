const DATA_URL = "data/conditions.json";

// parseNaive, dayKeyOf, formatDayHeading, dirToArrowRotation, windColor, fmtChartTick,
// buildDayBandPlugin, renderConditionsChart, CONDITION_COLORS, wireHoldToShowTooltip,
// setupFullscreenToggle, setupDragToScroll, fetchWillyWeatherCandidates,
// showLocationCandidatePicker, and fetchWillyWeatherPreviewRows all come from charts.js
// (loaded before this file).

let state = { data: null, rowsByLocation: {}, chart: null };

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
  document.getElementById("btnPreviewMapClick").addEventListener("click", togglePreviewClickMode);

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

// True while the "📍 Click map to preview a spot" button is armed — the
// NEXT click on open map area (not a marker) previews WillyWeather's live
// conditions for that exact point instead of selecting one of this site's
// own saved locations. Same armed/disarm shape as the Settings tab's
// "click map to add location" (locationsadmin.js's addLocationClickArmed)
// — a separate armed step avoids turning every ordinary pan/zoom click
// into an unwanted preview lookup, which is the map's much more common use.
let previewClickArmed = false;

function togglePreviewClickMode() {
  previewClickArmed = !previewClickArmed;
  const btn = document.getElementById("btnPreviewMapClick");
  btn.textContent = previewClickArmed ? "Click the map to preview… (cancel)" : "📍 Click map to preview a spot";
  btn.classList.toggle("active", previewClickArmed);
  document.getElementById("locationMap").classList.toggle("map-preview-armed", previewClickArmed);
}

/**
 * The Location tab's map-click handler (see renderLocationMap's
 * renderLeafletLocationMap call) — a no-op unless "click map to preview"
 * is currently armed, exactly like onSettingsMapClick's own armed guard.
 * Looks up real WillyWeather candidates near the clicked point (shared
 * fetchWillyWeatherCandidates, charts.js) and either previews the one
 * match directly, lets the person pick between several
 * (showLocationCandidatePicker, allowManual:false — there's no manual
 * fallback that makes sense here, unlike the Settings tab's own use of
 * this same picker), or shows a friendly "nothing nearby" message if
 * WillyWeather has no match at all.
 */
async function onLocationMapClickForPreview(lat, lng) {
  if (!previewClickArmed) return;
  previewClickArmed = false;
  const btn = document.getElementById("btnPreviewMapClick");
  btn.textContent = "📍 Click map to preview a spot";
  btn.classList.remove("active");
  document.getElementById("locationMap").classList.remove("map-preview-armed");

  const candidates = await fetchWillyWeatherCandidates(lat, lng);
  if (!candidates || candidates.length === 0) {
    showLocationHoverPanel();
    document.getElementById("hoverPanelLocationName").textContent = "Preview";
    showPreviewNote(false);
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
  document.getElementById("locationChartFrame").style.display = "none";
  const emptyState = document.getElementById("hoverPanelEmptyState");
  emptyState.textContent = "Loading preview…";
  emptyState.style.display = "block";

  // The clicked point's own lat/lng, not the candidate's WillyWeather
  // station/locality centroid, feeds Open-Meteo's pressure/marine calls —
  // same "the person's own precision beats a station centroid" reasoning
  // already established for the Settings map's click-to-add flow (see
  // createNewLocationAt, locationsadmin.js).
  const preview = await fetchWillyWeatherPreviewRows(candidate.id, clickLat, clickLng);
  if (!preview || preview.rows.length === 0) {
    emptyState.textContent = "Couldn't load a preview for this spot — WillyWeather or Open-Meteo data wasn't available just now.";
    return;
  }

  const previewLoc = {
    name: candidate.name,
    tideMaxObserved: preview.tideMaxObserved,
    // No saved config exists yet for a clicked-but-not-added spot, so
    // there's no per-location minTideHeight/tideOffset to apply — the
    // graph draws with sensible defaults for both, same as it would for a
    // brand-new location that hasn't had these set yet either.
    minTideHeight: null,
    tideOffset: null,
  };
  renderCharts(preview.rows, previewLoc, preview.sunTimes);
}

function showPreviewNote(show) {
  const el = document.getElementById("hoverPanelPreviewNote");
  if (el) el.style.display = show ? "block" : "none";
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
  // previewLocationOnMap) — so the preview note/badge never lingers onto
  // it if the panel was last showing a preview.
  showPreviewNote(false);
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
