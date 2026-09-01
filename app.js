const DATA_URL = "data/conditions.json";

// parseNaive, dayKeyOf, formatDayHeading, dirToArrowRotation, windColor, fmtChartTick,
// buildDayBandPlugin, renderConditionsChart, and CONDITION_COLORS all come from
// charts.js (loaded before this file).

let state = { data: null, rowsByLocation: {}, chart: null };
let lastChartParams = null;
let modalChart = null;

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

  document.getElementById("conditionsChart").addEventListener("click", openChartModal);
  document.getElementById("btnCloseChartModal").addEventListener("click", closeChartModal);
  document.getElementById("btnCloseHoverPanel").addEventListener("click", hideLocationHoverPanel);
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
 * The summary+graph panel that floats over the map on marker click (see
 * .location-hover-panel, style.css) — hidden by default (nothing selected
 * yet) and on every page load, even if a location was selected last visit;
 * showing it again requires an actual marker click, matching "hide the
 * graph until I click a location" rather than restoring previous state
 * automatically. The selection itself still persists to localStorage
 * (harmless, and available if a future "remember last view" feature wants
 * it) — only the panel's visibility doesn't.
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
  const chartWrap = document.querySelector(".location-hover-panel-chart-wrap");

  if (rows.length === 0) {
    if (state.chart) {
      state.chart.destroy();
      state.chart = null;
    }
    chartWrap.style.display = "none";
    emptyState.style.display = "block";
    return;
  }
  chartWrap.style.display = "block";
  emptyState.style.display = "none";

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
  });
  // Full axes shown directly here too now, not just once the modal opens —
  // no more stripped-down "compact" version anywhere on the site. Tapping
  // still opens the modal (a bigger view), it's just no longer the only
  // place axes show up.
  lastChartParams = {
    rows,
    sunTimes,
    tideMaxObserved: loc ? loc.tideMaxObserved : null,
    minTideHeight: loc ? loc.minTideHeight : null,
    tideOffsetMinutes: loc ? loc.tideOffset : null,
  };
}

function openChartModal() {
  if (!lastChartParams) return;
  const overlay = document.getElementById("chartModalOverlay");
  overlay.style.display = "flex";
  modalChart = renderConditionsChart({
    canvas: document.getElementById("conditionsChartModal"),
    rows: lastChartParams.rows,
    sunTimes: lastChartParams.sunTimes,
    existingChart: modalChart,
    tideMaxObserved: lastChartParams.tideMaxObserved,
    moonPhases: state.data.moonPhases,
    minTideHeight: lastChartParams.minTideHeight,
    compact: false,
    tideOffsetMinutes: lastChartParams.tideOffsetMinutes,
  });
}

function closeChartModal() {
  document.getElementById("chartModalOverlay").style.display = "none";
}

init();
