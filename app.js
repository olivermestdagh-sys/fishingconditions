const DATA_URL = "data/conditions.json";

const CONDITION_COLORS = {
  5: "var(--cond-5)",
  4: "var(--cond-4)",
  3: "var(--cond-3)",
  2: "var(--cond-2)",
  1: "var(--cond-1)",
};

// parseNaive, dayKeyOf, formatDayHeading, dirToArrowRotation, windColor, fmtChartTick,
// buildDayBandPlugin, and renderConditionsChart all come from charts.js (loaded before this file).

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
  populateLocationPicker();

  document.getElementById("locationSelect").addEventListener("change", (e) => {
    localStorage.setItem("selectedLocation", e.target.value);
    renderLocation(e.target.value);
  });
  document.getElementById("conditionsChart").addEventListener("click", openChartModal);
  document.getElementById("btnCloseChartModal").addEventListener("click", closeChartModal);

  const saved = localStorage.getItem("selectedLocation");
  const first = state.data.locations[0] ? locationKey(state.data.locations[0].name, state.data.locations[0].type) : null;
  const initial = saved && state.rowsByLocation[saved] ? saved : first;
  if (initial) {
    document.getElementById("locationSelect").value = initial;
    renderLocation(initial);
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

function populateLocationPicker() {
  const select = document.getElementById("locationSelect");
  select.innerHTML = "";
  // Explicit key order guarantees Kayak entries list before Land based
  // ones, regardless of what order locations happen to appear in the data.
  const groups = { Kayak: [], "Land based": [] };
  for (const loc of state.data.locations) {
    (groups[loc.type] || (groups[loc.type] = [])).push(loc);
  }
  for (const [type, locs] of Object.entries(groups)) {
    if (locs.length === 0) continue;
    const optgroup = document.createElement("optgroup");
    optgroup.label = type;
    for (const loc of locs) {
      const opt = document.createElement("option");
      opt.value = locationKey(loc.name, loc.type);
      opt.textContent = loc.name;
      optgroup.appendChild(opt);
    }
    select.appendChild(optgroup);
  }
}

function renderLocation(key) {
  const loc = state.data.locations.find((l) => locationKey(l.name, l.type) === key);
  const rows = state.rowsByLocation[key] || [];
  const now = new Date();

  renderSummary(loc, rows, now);
  renderCharts(rows, loc);
}

function renderSummary(loc, rows, now) {
  const card = document.getElementById("summaryCard");
  if (rows.length === 0) {
    card.innerHTML = `<div class="empty-state">No data yet for this location. It'll appear after the next scheduled update.</div>`;
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

  card.innerHTML = `
    <div class="summary-top">
      <div>
        <div class="summary-title">${loc.name}</div>
        <div class="summary-sub">${loc.type} · shore faces ${loc.shore}</div>
      </div>
      <div class="badge-stack">
        <div class="badge-item">
          <div class="condition-badge" style="background:${conditionVal != null ? (CONDITION_COLORS[Math.round(conditionVal)] || "var(--cond-none)") : "var(--cond-none)"}" title="${conditionRow && conditionRow["Condition Reason"] ? conditionRow["Condition Reason"].replace(/"/g, "&quot;") : ""}">
            ${conditionVal != null ? conditionVal + "/5" : "–"}
          </div>
          <div class="badge-label">Location</div>
        </div>
        <div class="badge-item">
          <div class="condition-badge" style="background:${fishingVal != null ? (CONDITION_COLORS[Math.round(fishingVal)] || "var(--cond-none)") : "var(--cond-none)"}" title="${fishingRow && fishingRow["Fishing Condition Reason"] ? fishingRow["Fishing Condition Reason"].replace(/"/g, "&quot;") : ""}">
            ${fishingVal != null ? fishingVal + "/5" : "–"}
          </div>
          <div class="badge-label">Fishing</div>
        </div>
      </div>
    </div>
    <div class="stat-grid">
      <div class="stat">
        <div class="label">Temp now</div>
        <div class="value">${tempRt ? tempRt["Temp Realtime (C)"] + "°C" : "–"}</div>
      </div>
      <div class="stat">
        <div class="label">Wind now</div>
        <div class="value">${windRt ? Math.round(windRt["Wind Realtime (km/h)"]) + " km/h " + (windRt["Wind Realtime Dir"] || "") : "–"}</div>
      </div>
      <div class="stat">
        <div class="label">Tide</div>
        <div class="value">${tideRow ? tideRow["Tide Status"] : "–"}${tideHeightRow ? " · " + tideHeightRow["Tide Height (m)"] + "m" : ""}</div>
      </div>
    </div>
  `;
}

function renderCharts(rows, loc) {
  const sunTimes = (loc && state.data.sunTimes && state.data.sunTimes[loc.name]) || [];
  state.chart = renderConditionsChart({
    canvas: document.getElementById("conditionsChart"),
    rows,
    sunTimes,
    existingChart: state.chart,
    tideMaxObserved: loc ? loc.tideMaxObserved : null,
    moonPhases: state.data.moonPhases,
    minTideHeight: loc ? loc.minTideHeight : null,
    compact: true,
  });
  // The full chart (with axes) only gets built when the modal actually
  // opens — no point maintaining a second live Chart.js instance the whole
  // time when it might never be viewed. Stash what it'll need to re-render
  // itself on demand.
  lastChartParams = { rows, sunTimes, tideMaxObserved: loc ? loc.tideMaxObserved : null, minTideHeight: loc ? loc.minTideHeight : null };
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
  });
}

function closeChartModal() {
  document.getElementById("chartModalOverlay").style.display = "none";
}

init();
