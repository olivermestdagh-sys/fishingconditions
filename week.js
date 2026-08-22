const DATA_URL = "data/conditions.json";
const PIXELS_PER_HOUR = 22;

let allRows = [];
let allLocations = [];
let selectedLocations = new Set();
let selectedTypes = new Set(["Kayak", "Land based"]);
let currentTile = null;

async function init() {
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allRows = data.rows.map((r) => ({ ...r, _t: parseNaive(r.dateTime) }));
    allLocations = data.locations || [];
    if (data.generatedAt) {
      const dt = new Date(data.generatedAt);
      document.getElementById("updated").textContent = `Updated ${dt.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
    }
  } catch (err) {
    document.getElementById("updated").textContent = "Could not load data — has the site run its first update yet?";
    console.error(err);
    return;
  }

  const filtersToggle = document.getElementById("filtersToggle");
  const filtersContent = document.getElementById("filtersContent");
  const filtersHint = document.getElementById("filtersToggleHint");
  const toggleFilters = () => {
    const nowCollapsed = filtersContent.classList.toggle("collapsed");
    filtersHint.textContent = nowCollapsed ? "▸ tap to show" : "▾ hide";
  };
  filtersToggle.addEventListener("click", toggleFilters);
  filtersToggle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleFilters(); }
  });

  // Locations/types filters and Min Condition/Min Hours thresholds are
  // shared with the Trip Planner (same localStorage keys, via charts.js) —
  // changing them on one page is reflected on the other, since they're
  // both fundamentally "find good sessions" tools working from the same
  // underlying settings.
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(LOC_FILTER_STORAGE_KEY) || "null");
  } catch {
    saved = null;
  }
  const allNames = allLocations.map((l) => l.name);
  if (Array.isArray(saved) && saved.length) {
    selectedLocations = new Set(saved.filter((n) => allNames.includes(n)));
  } else {
    selectedLocations = new Set(allNames);
  }

  let savedTypes = null;
  try {
    savedTypes = JSON.parse(localStorage.getItem(TYPE_FILTER_STORAGE_KEY) || "null");
  } catch {
    savedTypes = null;
  }
  selectedTypes = Array.isArray(savedTypes) && savedTypes.length ? new Set(savedTypes) : new Set(["Kayak", "Land based"]);

  let savedThresholds = null;
  try {
    savedThresholds = JSON.parse(localStorage.getItem(THRESHOLDS_STORAGE_KEY) || "null");
  } catch {
    savedThresholds = null;
  }
  if (savedThresholds) {
    if (savedThresholds.minCondition != null) document.getElementById("minCondition").value = savedThresholds.minCondition;
    if (savedThresholds.minHours != null) document.getElementById("minHours").value = savedThresholds.minHours;
  }

  renderLocationChips(allLocations, selectedLocations, renderWeekView);
  renderTypeChips(selectedTypes, renderWeekView);
  document.getElementById("btnLocAll").addEventListener("click", () => {
    selectedLocations = new Set(allLocations.map((l) => l.name));
    persistSelectedLocations(selectedLocations);
    renderLocationChips(allLocations, selectedLocations, renderWeekView);
    renderWeekView();
  });
  document.getElementById("btnLocNone").addEventListener("click", () => {
    selectedLocations = new Set();
    persistSelectedLocations(selectedLocations);
    renderLocationChips(allLocations, selectedLocations, renderWeekView);
    renderWeekView();
  });
  document.getElementById("minCondition").addEventListener("input", () => {
    persistThresholds();
    renderWeekView();
  });
  document.getElementById("minHours").addEventListener("input", () => {
    persistThresholds();
    renderWeekView();
  });

  renderWeekView();
}

/**
 * Groups rows by (location, type), computes qualifying windows for each via
 * the same shared computeWindowsForLocation() the Trip Planner uses, and —
 * unlike Trip Planner, which deliberately shows a card per day a session
 * touches — collapses each session down to ONE tile here, since a Gantt-
 * style timeline shows a session's span directly as its own width rather
 * than needing a separate card per day.
 */
function computeWeekTiles() {
  const byLocation = {};
  for (const r of allRows) {
    const name = r["Location Name"];
    const type = r["Type"];
    if (!selectedLocations.has(name)) continue;
    if (!selectedTypes.has(type)) continue;
    const key = `${name}::${type}`;
    (byLocation[key] || (byLocation[key] = [])).push(r);
  }

  const minCondition = Number(document.getElementById("minCondition").value) || 1;
  const minHours = Number(document.getElementById("minHours").value) || 1;
  const nowLocal = new Date();

  const tiles = [];
  for (const key in byLocation) {
    const locRows = byLocation[key];
    const windows = computeWindowsForLocation(locRows, minCondition, minHours);
    const seenSpans = new Set();
    for (const w of windows) {
      if (naiveMsToLocalDate(w.to) < nowLocal) continue; // already finished
      const spanKey = `${w.from}::${w.to}`;
      if (seenSpans.has(spanKey)) continue; // same session, different day-anchor duplicate
      seenSpans.add(spanKey);
      tiles.push({
        ...w,
        avgCondition: average(locRows, "Condition", w.from, w.to),
        avgFishingCondition: average(locRows, "Fishing Condition", w.from, w.to),
        avgTemp: average(locRows, "Temp Forecast (C)", w.from, w.to),
        avgWind: average(locRows, "Wind Forecast (km/h)", w.from, w.to),
        avgRain: average(locRows, "Rainfall Probability (%)", w.from, w.to),
      });
    }
  }
  return tiles;
}

function renderWeekView() {
  const tiles = computeWeekTiles();
  const emptyState = document.getElementById("weekEmptyState");
  const scrollWrap = document.getElementById("weekTimelineScroll");
  const inner = document.getElementById("weekTimelineInner");

  if (tiles.length === 0) {
    emptyState.style.display = "block";
    scrollWrap.style.display = "none";
    inner.innerHTML = "";
    return;
  }
  emptyState.style.display = "none";
  scrollWrap.style.display = "block";

  // Timeline spans from the start of today through the latest tile's end —
  // no point showing hours already behind us on a page called Week Ahead.
  const nowMs = nowInNaiveEncoding();
  const timelineStart = dateOnly(nowMs);
  const timelineEnd = Math.max(...tiles.map((t) => t.to));
  const totalHours = (timelineEnd - timelineStart) / 3600000;
  const totalTrackWidth = Math.max(1, totalHours) * PIXELS_PER_HOUR;

  // One row per (location, type) that actually has a tile, in name/type order.
  const rowKeys = Array.from(new Set(tiles.map((t) => `${t.locationName}::${t.type}`))).sort();

  inner.innerHTML = "";

  // Header: day-boundary gridlines + date labels, plus a "Now" marker —
  // aligned with the tile rows below since they share the same track width
  // and the same timelineStart origin.
  const headerRow = document.createElement("div");
  headerRow.className = "week-header-row";
  headerRow.appendChild(makeLabelCell("", true));
  const headerTrack = document.createElement("div");
  headerTrack.className = "week-track week-header-track";
  headerTrack.style.width = totalTrackWidth + "px";
  for (let dayMs = timelineStart; dayMs <= timelineEnd; dayMs += 86400000) {
    const leftPx = ((dayMs - timelineStart) / 3600000) * PIXELS_PER_HOUR;
    const boundary = document.createElement("div");
    boundary.className = "week-day-boundary";
    boundary.style.left = leftPx + "px";
    headerTrack.appendChild(boundary);
    const label = document.createElement("div");
    label.className = "week-day-label";
    label.style.left = leftPx + "px";
    label.textContent = fmtNaive(dayMs, { weekday: "short", day: "numeric", month: "short" });
    headerTrack.appendChild(label);
  }
  const nowLeftPx = ((nowMs - timelineStart) / 3600000) * PIXELS_PER_HOUR;
  if (nowLeftPx >= 0 && nowLeftPx <= totalTrackWidth) {
    const nowLine = document.createElement("div");
    nowLine.className = "week-now-line";
    nowLine.style.left = nowLeftPx + "px";
    headerTrack.appendChild(nowLine);
  }
  headerRow.appendChild(headerTrack);
  inner.appendChild(headerRow);

  // One row per location+type, with its own tiles positioned/sized by real time.
  for (const key of rowKeys) {
    const [locationName, type] = splitKey(key);
    const rowTiles = tiles.filter((t) => t.locationName === locationName && t.type === type);

    const row = document.createElement("div");
    row.className = "week-row";
    row.appendChild(makeLabelCell(locationName, false, type));

    const track = document.createElement("div");
    track.className = "week-track";
    track.style.width = totalTrackWidth + "px";
    if (nowLeftPx >= 0 && nowLeftPx <= totalTrackWidth) {
      const nowLine = document.createElement("div");
      nowLine.className = "week-now-line";
      nowLine.style.left = nowLeftPx + "px";
      track.appendChild(nowLine);
    }

    for (const t of rowTiles) {
      // A session that began before today (its true start, per the shared
      // full-time-range logic) but is still ongoing needs its VISUAL left
      // edge clamped to the timeline's own start — otherwise this computes
      // a negative left offset and the tile bleeds off the track, straight
      // into the sticky label column. The displayed text still shows the
      // true start/end times regardless; only the positioning is clamped.
      const clampedFrom = Math.max(t.from, timelineStart);
      const leftPx = ((clampedFrom - timelineStart) / 3600000) * PIXELS_PER_HOUR;
      const widthPx = Math.max(4, ((t.to - clampedFrom) / 3600000) * PIXELS_PER_HOUR);
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "week-tile";
      tile.style.left = leftPx + "px";
      tile.style.width = widthPx + "px";
      tile.style.background = conditionColor(t.avgCondition);
      const timeLabel = `${fmtNaive(t.from, { hour: "2-digit", minute: "2-digit", hour12: false })}–${fmtNaive(t.to, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
      tile.title = `${locationName} (${type}) — ${timeLabel}`;
      // Wide enough for the time range alone; wider still and the key
      // stats fit too — narrower tiles just show as a plain colour block,
      // still fully clickable, rather than cramming in truncated text.
      if (widthPx > 100) {
        tile.innerHTML = `
          <div class="week-tile-time">${timeLabel} · ${t.hoursLabel}h</div>
          <div class="week-tile-stats">${t.avgTemp != null ? t.avgTemp.toFixed(1) + "°" : "–"} · ${t.avgWind != null ? Math.round(t.avgWind) + " km/h" : "–"} · ${t.avgRain != null ? Math.round(t.avgRain) + "% rain" : "–"}</div>
        `;
      } else if (widthPx > 46) {
        tile.innerHTML = `<div class="week-tile-time">${timeLabel}</div>`;
      }
      tile.addEventListener("click", () => selectTile(t));
      track.appendChild(tile);
    }

    row.appendChild(track);
    inner.appendChild(row);
  }
}

function splitKey(key) {
  const idx = key.lastIndexOf("::");
  return [key.slice(0, idx), key.slice(idx + 2)];
}

function makeLabelCell(text, isHeader, subtext) {
  const cell = document.createElement("div");
  cell.className = "week-label" + (isHeader ? " week-label-header" : "");
  if (text) {
    const nameEl = document.createElement("div");
    nameEl.className = "week-label-name";
    nameEl.textContent = text;
    cell.appendChild(nameEl);
  }
  if (subtext) {
    const typeEl = document.createElement("div");
    typeEl.className = "week-label-type";
    typeEl.innerHTML = `${typeIconSvg(subtext, 12)} <span>${subtext}</span>`;
    cell.appendChild(typeEl);
  }
  return cell;
}

function selectTile(t) {
  currentTile = t;
  const panel = document.getElementById("weekDetailPanel");
  panel.style.display = "block";
  const timeRange = `${fmtNaive(t.from, { hour: "2-digit", minute: "2-digit", hour12: false })} – ${fmtNaive(t.to, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  panel.innerHTML = `
    <div class="window-card-header">
      <div>
        <div class="window-loc">${t.locationName}</div>
        <div class="window-sub" style="margin-bottom:8px;">${t.type} · shore ${t.shore || "–"}</div>
      </div>
    </div>
    <div class="window-sub" style="margin-bottom:8px;">${timeRange} · ${t.hoursLabel}h</div>
    <div class="stat-grid">
      <div class="stat">
        <div class="label">Avg Temp</div>
        <div class="value">${t.avgTemp != null ? t.avgTemp.toFixed(1) + "°" : "–"}</div>
      </div>
      <div class="stat">
        <div class="label">Avg Wind</div>
        <div class="value">${t.avgWind != null ? Math.round(t.avgWind) + " km/h" : "–"}</div>
      </div>
      <div class="stat">
        <div class="label">Avg Rain</div>
        <div class="value">${t.avgRain != null ? Math.round(t.avgRain) + "%" : "–"}</div>
      </div>
    </div>
  `;
}

init();
