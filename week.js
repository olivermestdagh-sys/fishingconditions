const DATA_URL = "data/conditions.json";
const PIXELS_PER_HOUR = 32;
const MIN_TILE_WIDTH = 240;
const LANE_GAP = 10; // minimum pixel gap required between two tiles sharing a lane

let allRows = [];
let allLocations = [];
let sunTimesData = {};
let moonPhasesData = {};
let selectedLocations = new Set();
let selectedTypes = new Set(["Kayak", "Land based"]);
let currentTile = null;
let modalChart = null;

async function init() {
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allRows = data.rows.map((r) => ({ ...r, _t: parseNaive(r.dateTime) }));
    allLocations = data.locations || [];
    sunTimesData = data.sunTimes || {};
    moonPhasesData = data.moonPhases || {};
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
  document.getElementById("btnCloseChartModal").addEventListener("click", closeChartModal);

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

  // Each tile's pixel position/size is computed up front (and clamped to
  // MIN_TILE_WIDTH, since a card needs real room for its photo/badges/stats
  // regardless of how short the session actually was) — the lane-packing
  // below works off these RENDERED pixel bounds, not raw time, since two
  // tiles that don't truly overlap in time could still visually overlap on
  // screen once a short one gets padded out to the minimum width.
  const positioned = tiles.map((t) => {
    const clampedFrom = Math.max(t.from, timelineStart);
    const leftPx = ((clampedFrom - timelineStart) / 3600000) * PIXELS_PER_HOUR;
    const naturalWidthPx = ((t.to - clampedFrom) / 3600000) * PIXELS_PER_HOUR;
    const widthPx = Math.max(MIN_TILE_WIDTH, naturalWidthPx);
    return { ...t, leftPx, widthPx, rightPx: leftPx + widthPx };
  });

  const lanes = packIntoLanes(positioned);

  inner.innerHTML = "";

  // Header: day-boundary gridlines + date labels, plus a "Now" marker.
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
  inner.appendChild(headerTrack);

  // One lane per row of non-overlapping tiles — NOT one row per location.
  // A lane can (and usually will) contain tiles from several different
  // locations, since all that matters for sharing a lane is that their
  // time spans don't visually collide.
  for (const lane of lanes) {
    const laneEl = document.createElement("div");
    laneEl.className = "week-track week-lane";
    laneEl.style.width = totalTrackWidth + "px";
    if (nowLeftPx >= 0 && nowLeftPx <= totalTrackWidth) {
      const nowLine = document.createElement("div");
      nowLine.className = "week-now-line";
      nowLine.style.left = nowLeftPx + "px";
      laneEl.appendChild(nowLine);
    }
    for (const t of lane) {
      laneEl.appendChild(buildTileElement(t));
    }
    inner.appendChild(laneEl);
  }
}

/**
 * Greedy interval packing: sorted by left edge, each tile goes into the
 * first lane where it doesn't collide with that lane's last-placed tile
 * (with LANE_GAP of breathing room), or a new lane if none fit — the same
 * algorithm calendar apps use to stack overlapping events into columns,
 * applied here to rows instead since this timeline runs horizontally.
 */
function packIntoLanes(positionedTiles) {
  const sorted = [...positionedTiles].sort((a, b) => a.leftPx - b.leftPx);
  const lanes = []; // each lane: { lastRight: px, tiles: [...] }
  for (const t of sorted) {
    let placedLane = lanes.find((lane) => t.leftPx >= lane.lastRight + LANE_GAP);
    if (!placedLane) {
      placedLane = { lastRight: -Infinity, tiles: [] };
      lanes.push(placedLane);
    }
    placedLane.tiles.push(t);
    placedLane.lastRight = t.rightPx;
  }
  return lanes.map((lane) => lane.tiles);
}

function buildTileElement(t) {
  const timeLabel = `${fmtNaive(t.from, { hour: "2-digit", minute: "2-digit", hour12: false })}–${fmtNaive(t.to, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  const photoUrl = t.type === "Kayak" ? "images/type-kayak.jpg" : "images/type-landbased.jpg";

  const tile = document.createElement("div");
  tile.className = "week-tile";
  tile.style.left = t.leftPx + "px";
  tile.style.width = t.widthPx + "px";
  tile.style.backgroundImage = `linear-gradient(rgba(255,255,255,0.88), rgba(255,255,255,0.88)), url(${photoUrl})`;
  tile.title = `${t.locationName} (${t.type}) — ${timeLabel}`;
  tile.setAttribute("role", "button");
  tile.setAttribute("tabindex", "0");
  tile.innerHTML = `
    <div class="window-loc">${t.locationName}</div>
    <div class="window-sub">${t.type} · shore ${t.shore || "–"}</div>
    <div class="window-sub" style="margin:4px 0 8px;">${timeLabel} · ${t.hoursLabel}h</div>
    <div class="badge-stack">
      <div class="badge-item">
        <div class="condition-badge" style="background:${conditionColor(t.avgCondition)}">${t.avgCondition != null ? t.avgCondition.toFixed(1) : "–"}</div>
        <div class="badge-label">Location</div>
      </div>
      <div class="badge-item">
        <div class="condition-badge" style="background:${conditionColor(t.avgFishingCondition)}">${t.avgFishingCondition != null ? t.avgFishingCondition.toFixed(1) : "–"}</div>
        <div class="badge-label">Fishing</div>
      </div>
    </div>
    <div class="stat-grid week-tile-stats">
      <div class="stat">
        <div class="label">Temp</div>
        <div class="value">${t.avgTemp != null ? t.avgTemp.toFixed(1) + "°" : "–"}</div>
      </div>
      <div class="stat">
        <div class="label">Wind</div>
        <div class="value">${t.avgWind != null ? Math.round(t.avgWind) + " km/h" : "–"}</div>
      </div>
      <div class="stat">
        <div class="label">Rain</div>
        <div class="value">${t.avgRain != null ? Math.round(t.avgRain) + "%" : "–"}</div>
      </div>
    </div>
  `;
  tile.addEventListener("click", () => selectTile(t));
  tile.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectTile(t); }
  });
  return tile;
}

/**
 * Tapping a tile opens the same full-day chart modal Trip Planner uses when
 * you tap a session card — same underlying data (that location's whole
 * calendar day, not just the qualifying window's own hour span, so the
 * graph shows the good stretch in its full daily context), same compact:
 * false full-axes rendering.
 */
function selectTile(t) {
  currentTile = t;

  // Which day to show: the session's own true start day, unless that's
  // already in the past (a multi-day session that began before today) —
  // in which case show today instead, the same clamping principle already
  // used for the tile's own visual position on the timeline.
  const nowMs = nowInNaiveEncoding();
  const dayStart = dateOnly(Math.max(t.from, dateOnly(nowMs)));
  const dayRows = allRows
    .filter((r) => r["Location Name"] === t.locationName && r["Type"] === t.type && dateOnly(r._t) === dayStart)
    .sort((a, b) => a._t - b._t);

  if (dayRows.length === 0) return;

  const matchedLoc = allLocations.find((l) => l.name === t.locationName && l.type === t.type);
  const overlay = document.getElementById("chartModalOverlay");
  overlay.style.display = "flex";
  modalChart = renderConditionsChart({
    canvas: document.getElementById("weekChartModal"),
    rows: dayRows,
    sunTimes: sunTimesData[t.locationName] || [],
    existingChart: modalChart,
    locationName: t.locationName,
    tideMaxObserved: matchedLoc ? matchedLoc.tideMaxObserved : null,
    moonPhases: moonPhasesData,
    minTideHeight: matchedLoc ? matchedLoc.minTideHeight : null,
    compact: false,
  });
}

function closeChartModal() {
  document.getElementById("chartModalOverlay").style.display = "none";
}

init();
