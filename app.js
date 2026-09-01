const DATA_URL = "data/conditions.json";

// parseNaive, dayKeyOf, formatDayHeading, dirToArrowRotation, windColor, fmtChartTick,
// buildDayBandPlugin, renderConditionsChart, CONDITION_COLORS, wireHoldToShowTooltip,
// setupFullscreenToggle, and setupDragToScroll all come from charts.js (loaded before
// this file).

let state = { data: null, rowsByLocation: {}, chart: null };

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

  groupRowsByLocation();
  renderUpdatedBanner();
  // Awaited — this is a small, fast, local file (not the slow
  // WillyWeather pipeline), so the wait is negligible, and awaiting it
  // avoids a race where the very first chart render below would happen
  // before tideOffset had been merged in.
  await loadTideOffsets(state.data.locations);
  renderLocationMap();

  document.getElementById("btnCloseHoverPanel").addEventListener("click", hideLocationHoverPanel);

  // Same gesture set as Week (graphs) and Live, all shared from charts.js:
  // hold 2s to toggle the tooltip, double-tap/double-click to toggle real
  // fullscreen, and (desktop only — touch already scrolls natively)
  // click-and-drag to pan the now-horizontally-scrolling graph. Wired once
  // here rather than per-render — this page reuses the same <canvas> and
  // frame across every location switch (destroying/recreating the Chart.js
  // instance each time, never the DOM elements themselves), so wiring
  // these per-render would stack up duplicate listeners.
  wireHoldToShowTooltip(() => state.chart, document.getElementById("conditionsChart"));
  setupFullscreenToggle("locationChartFrame");
  setupDragToScroll(document.getElementById("locationChartScroll"));

  // Restores and shows whichever location was last viewed, rather than
  // starting on a bare map every visit — the selection was already being
  // saved to localStorage on every pick (see selectLocationByKey) even
  // before this, it just wasn't being read back on load until now.
  const saved = localStorage.getItem("selectedLocation");
  if (saved && state.rowsByLocation[saved]) {
    renderLocation(saved);
    showLocationHoverPanel();
  }
}

// Shared by the map's marker clicks (both the direct single-type case and
// the multi-type popup's buttons) — persists the choice, renders it into
// the hover panel, and shows the panel. There's no dropdown any more (see
// the map-fills-the-page redesign) — the map IS the only way to pick a
// location now, so this is the map's marker-click handler in all but name.
function selectLocationByKey(key) {
  localStorage.setItem("selectedLocation", key);
  renderLocation(key);
  showLocationHoverPanel();
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

  const map = renderLeafletLocationMap("locationMap", points);
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
  renderCharts(rows, loc);
}

function renderCharts(rows, loc) {
  const emptyState = document.getElementById("hoverPanelEmptyState");
  const frame = document.getElementById("locationChartFrame");
  const chartWrap = document.getElementById("locationChartWrap");

  if (rows.length === 0) {
    if (state.chart) {
      state.chart.destroy();
      state.chart = null;
    }
    frame.style.display = "none";
    emptyState.style.display = "block";
    return;
  }
  frame.style.display = "block";
  emptyState.style.display = "none";

  // Explicit pixel width, proportional to the real time range being shown
  // (see PIXELS_PER_HOUR above) — set BEFORE renderConditionsChart runs,
  // since Chart.js measures its canvas's parent's width at construction
  // time to decide the canvas's own size (same reason Week (graphs)'s row
  // charts set their wrapper's width right before rendering into it, not
  // after). Without this, the graph would render squashed to whatever
  // narrow width the wrap happened to have first, then never widen even
  // once this line did run.
  const totalHours = Math.max(1, (rows[rows.length - 1]._t - rows[0]._t) / 3600000);
  chartWrap.style.width = Math.round(totalHours * PIXELS_PER_HOUR) + "px";
  // Scrolling back to the start on every new render (a fresh location, or
  // the same one re-rendering) — otherwise a location switch could leave
  // the new graph scrolled to wherever the PREVIOUS location's view
  // happened to be left, which is disorienting since "now" is always meant
  // to be near the start of the visible window.
  document.getElementById("locationChartScroll").scrollLeft = 0;

  const sunTimes = (loc && state.data.sunTimes && state.data.sunTimes[loc.name]) || [];
  state.chart = renderConditionsChart({
    canvas: document.getElementById("conditionsChart"),
    rows,
    sunTimes,
    existingChart: state.chart,
    tideMaxObserved: loc ? loc.tideMaxObserved : null,
    moonPhases: state.data.moonPhases,
    minTideHeight: loc ? loc.minTideHeight : null,
    compact: false,
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
