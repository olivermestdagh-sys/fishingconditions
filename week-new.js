// Week Ahead (new) — experimental replacement for week.js, built to try
// out embedding the real conditions graph directly into each session tile
// instead of a stat-panel tile that opens a graph on hover/click.
//
// Deliberately does NOT have: hover-preview, click-to-open modal, or the
// sticky-tile-content trick (background-photo split) that week.js/index.html
// use — none of those apply once the tile's content IS the graph rather
// than a small stat panel that expands into one elsewhere. Trip schedule
// (fishing/drive time) is also dropped from this page entirely: it was
// only ever shown inside the modal/preview this page no longer has.
//
// Everything about the timeline itself — day/night shading, the sticky
// date/moon/hour header row, lane packing, PIXELS_PER_HOUR scaling,
// Location/Type filters, Min Condition/Min Hours thresholds — is carried
// over unchanged from week.js, since none of that is tile-content-specific.

const DATA_URL = "data/conditions.json";
const PIXELS_PER_HOUR = 32;
// Floor so a tile never collapses to an unreadably narrow sliver — in
// practice a tile's real width (see computeGraphBounds below) is almost
// always well over this once it's been extended to the nearest sunrise/
// sunset boundary on each side, so this only bites in the rare case where
// a location has no sun-times data at all and the graph falls back to just
// the session's own (possibly short) span.
const MIN_TILE_WIDTH = 240;
const LANE_GAP = 10; // minimum pixel gap required between two tiles sharing a lane

let allRows = [];
let allLocations = [];
let sunTimesData = {};
let moonPhasesData = {};
let selectedLocations = new Set();
let selectedTypes = new Set(["Kayak", "Land based"]);
let dayLabelsForStickyScroll = []; // rebuilt each render() — see the horizontal-sticky scroll handler below

// Chart.js instances currently on screen — one per visible graph tile, torn
// down and rebuilt every renderWeekView() call (filters/thresholds changing,
// or the periodic data refresh). Chart.js doesn't garbage-collect an
// instance just because its canvas got removed from the DOM, so these must
// be destroyed explicitly or every re-render leaks the previous batch.
let activeTileCharts = [];

/**
 * Turns a hidden number input into a stepper: a circular badge (styled
 * like the Location/Fishing rating circles on session tiles) showing the
 * current value, with +/− buttons either side. For Min Condition, the
 * badge is colored via conditionColor() — the exact same function that
 * colors those tile badges — so a "3.0" here looks like a "3.0" would
 * anywhere else on the page. Min consecutive hours isn't a 1-5 condition
 * rating, so colorFn is null there — same badge shape, fixed neutral color
 * (see .rating-stepper-badge-neutral), purely for visual consistency.
 */
function wireThresholdStepper(id, step, min, max, colorFn) {
  const input = document.getElementById(id);
  const badge = document.getElementById(id + "Badge");
  const upBtn = document.getElementById(id + "Up");
  const downBtn = document.getElementById(id + "Down");

  function updateDisplay() {
    const value = Number(input.value);
    badge.textContent = value.toFixed(1);
    if (colorFn) badge.style.background = colorFn(value);
    downBtn.disabled = value <= min;
    upBtn.disabled = value >= max;
  }

  function changeBy(delta) {
    // Rounded to 1 decimal place — repeated 0.1 increments would otherwise
    // drift via ordinary floating-point error (e.g. 1.1 + 0.1 = 1.2000000000000002).
    const raw = Math.min(max, Math.max(min, Number(input.value) + delta));
    input.value = Math.round(raw * 10) / 10;
    updateDisplay();
    persistThresholds();
    renderWeekView();
  }

  downBtn.addEventListener("click", () => changeBy(-step));
  upBtn.addEventListener("click", () => changeBy(step));
  updateDisplay();
}

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

  // Locations/types filters and Min Condition/Min Hours thresholds persist
  // across visits (same localStorage keys as week.js, via charts.js) —
  // shared with the original Week Ahead page on purpose, since they're the
  // same underlying settings, not a separate copy for this page.
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

  wireThresholdStepper("minCondition", 0.1, 1, 5, conditionColor);
  wireThresholdStepper("minHours", 1, 1, 24, null);

  document.getElementById("weekTimelineScroll").addEventListener("scroll", updateStickyDayLabels);

  renderWeekView();
}

/**
 * Groups rows by (location, type), computes qualifying windows for each via
 * the shared computeWindowsForLocation(), and collapses each session down
 * to ONE tile — a session spanning several days would otherwise produce a
 * separate window object per day it touches, but a Gantt-style timeline
 * shows a session's span directly as its own width, so it only needs
 * showing once, not once per day.
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
      });
    }
  }
  return tiles;
}

/**
 * Works out the sun-anchored [graphStart, graphEnd] range a session's graph
 * should cover — NOT just that calendar day, but reaching back/forward
 * through one full opposite-type (day/night) period on each side of the
 * session itself, for context. Split out from the row-filtering step below
 * (computeGraphRows) because renderWeekView needs just these two
 * timestamps up front, to size and position the tile, before any row data
 * or chart rendering is needed.
 *   - session starts in daylight -> start the graph at the PRIOR sunset
 *     (the previous evening's, since today's own sunset hasn't happened
 *     yet if the session is starting during the day)
 *   - session starts at night -> start the graph at the PRIOR sunrise
 *     (today's, if the session starts in the evening after today's
 *     sunrise already happened; yesterday's, if it's starting in the
 *     pre-dawn hours before today's sunrise)
 * Mirrored for the end of the range. Falls back to the session's own
 * start/end time if sun data isn't available for that day, rather than
 * guessing.
 */
function computeGraphBounds(t) {
  const sunTimesForLocation = sunTimesData[t.locationName] || [];
  const sunByDate = new Map(sunTimesForLocation.map((s) => [s.date, s]));

  const startDateKey = new Date(t.from).toISOString().slice(0, 10);
  const sun = sunByDate.get(startDateKey);

  let graphStart = t.from;
  if (sun && sun.sunrise != null && sun.sunset != null) {
    const sunriseMs = parseNaive(sun.sunrise);
    const sunsetMs = parseNaive(sun.sunset);
    const isDaytime = t.from >= sunriseMs && t.from < sunsetMs;

    if (isDaytime) {
      const prevDateKey = new Date(t.from - 86400000).toISOString().slice(0, 10);
      const prevSun = sunByDate.get(prevDateKey);
      graphStart = prevSun && prevSun.sunset != null ? parseNaive(prevSun.sunset) : sunriseMs;
    } else if (t.from < sunriseMs) {
      const prevDateKey = new Date(t.from - 86400000).toISOString().slice(0, 10);
      const prevSun = sunByDate.get(prevDateKey);
      graphStart = prevSun && prevSun.sunrise != null ? parseNaive(prevSun.sunrise) : sunsetMs;
    } else {
      graphStart = sunriseMs;
    }
  }

  const endDateKey = new Date(t.to).toISOString().slice(0, 10);
  const endSun = sunByDate.get(endDateKey);

  let graphEnd = t.to;
  if (endSun && endSun.sunrise != null && endSun.sunset != null) {
    const endSunriseMs = parseNaive(endSun.sunrise);
    const endSunsetMs = parseNaive(endSun.sunset);
    const endIsDaytime = t.to >= endSunriseMs && t.to < endSunsetMs;

    if (endIsDaytime) {
      const nextDateKey = new Date(t.to + 86400000).toISOString().slice(0, 10);
      const nextSun = sunByDate.get(nextDateKey);
      graphEnd = nextSun && nextSun.sunrise != null ? parseNaive(nextSun.sunrise) : endSunsetMs;
    } else if (t.to < endSunriseMs) {
      graphEnd = endSunsetMs;
    } else {
      const nextDateKey = new Date(t.to + 86400000).toISOString().slice(0, 10);
      const nextSun = sunByDate.get(nextDateKey);
      graphEnd = nextSun && nextSun.sunset != null ? parseNaive(nextSun.sunset) : endSunriseMs;
    }
  }

  return { graphStart, graphEnd };
}

function computeGraphRows(t, graphStart, graphEnd) {
  return allRows
    .filter((r) => r["Location Name"] === t.locationName && r["Type"] === t.type && r._t >= graphStart && r._t <= graphEnd)
    .sort((a, b) => a._t - b._t);
}

function renderWeekView() {
  // Torn down up front, not just on empty-state — every path below either
  // rebuilds a fresh set of tile charts or shows no tiles at all, so the
  // previous batch is stale either way.
  for (const c of activeTileCharts) c.destroy();
  activeTileCharts = [];

  const tiles = computeWeekTiles();
  const emptyState = document.getElementById("weekEmptyState");
  const scrollWrap = document.getElementById("weekTimelineScroll");
  const inner = document.getElementById("weekTimelineInner");
  dayLabelsForStickyScroll = [];

  if (tiles.length === 0) {
    emptyState.style.display = "block";
    scrollWrap.style.display = "none";
    inner.innerHTML = "";
    return;
  }
  emptyState.style.display = "none";
  scrollWrap.style.display = "block";

  // Timeline spans from the start of today through the latest tile's own
  // GRAPH end (not just its session end) — a tile's graph reaches past its
  // session into the following sunrise/sunset, so the track needs to be at
  // least that wide or the rightmost tile's own context would get clipped.
  const nowMs = nowInNaiveEncoding();
  const timelineStart = dateOnly(nowMs);

  const withBounds = tiles.map((t) => {
    const { graphStart, graphEnd } = computeGraphBounds(t);
    return { ...t, graphStart, graphEnd };
  });

  const timelineEnd = Math.max(...withBounds.map((t) => t.graphEnd));
  const totalHours = (timelineEnd - timelineStart) / 3600000;
  const totalTrackWidth = Math.max(1, totalHours) * PIXELS_PER_HOUR;

  // Tile position/width come from the GRAPH's own range now, not the
  // session's — this is what makes the embedded chart line up pixel-for-
  // pixel with the day/night shading and hour ticks behind it. The chart
  // itself is locked to this same [clampedGraphStart, graphEnd] range via
  // its xRange option (see buildGraphTileElement below), at the same
  // PIXELS_PER_HOUR scale used everywhere else on this timeline.
  const positioned = withBounds.map((t) => {
    const clampedGraphStart = Math.max(t.graphStart, timelineStart);
    const leftPx = ((clampedGraphStart - timelineStart) / 3600000) * PIXELS_PER_HOUR;
    const naturalWidthPx = ((t.graphEnd - clampedGraphStart) / 3600000) * PIXELS_PER_HOUR;
    const widthPx = Math.max(MIN_TILE_WIDTH, naturalWidthPx);
    return { ...t, clampedGraphStart, leftPx, widthPx, rightPx: leftPx + widthPx };
  });

  const lanes = packIntoLanes(positioned);

  inner.innerHTML = "";

  // Sun times aren't per-location on this shared timeline — pick any one
  // location's data as representative (Victorian locations are close
  // enough together that sunrise/sunset times barely differ day to day),
  // rather than trying to show a different day/night pattern per lane.
  const sunTimesEntry = Object.values(sunTimesData).find((arr) => arr && arr.length) || [];
  const sunByDate = new Map(sunTimesEntry.map((s) => [s.date, s]));

  // Header: day-boundary gridlines, date labels, moon phase per day, hour
  // marks, and sunrise/sunset markers — sticky so the date stays visible
  // at the top of the box regardless of how far down you've scrolled
  // through the lanes below. Unchanged from week.js: this is the shared
  // timeline header, not tile content, so it isn't affected by dropping
  // the per-tile date/moon/sticky-content logic below.
  const headerTrack = document.createElement("div");
  headerTrack.className = "week-track week-header-track";
  headerTrack.style.width = totalTrackWidth + "px";

  for (let dayMs = timelineStart, dayIdx = 0; dayMs <= timelineEnd; dayMs += 86400000, dayIdx++) {
    const leftPx = ((dayMs - timelineStart) / 3600000) * PIXELS_PER_HOUR;
    const dayEndPx = Math.min(totalTrackWidth, leftPx + 24 * PIXELS_PER_HOUR);
    const dateKey = new Date(dayMs).toISOString().slice(0, 10);

    const dayColor = DAY_COLORS[dayIdx % DAY_COLORS.length];
    const dayTint = document.createElement("div");
    dayTint.className = "week-header-day-tint";
    dayTint.style.left = leftPx + "px";
    dayTint.style.width = dayEndPx - leftPx + "px";
    dayTint.style.background = dayColor.bg;
    headerTrack.appendChild(dayTint);

    const boundary = document.createElement("div");
    boundary.className = "week-day-boundary";
    boundary.style.left = leftPx + "px";
    headerTrack.appendChild(boundary);

    const label = document.createElement("div");
    label.className = "week-day-label";
    label.style.left = leftPx + "px";
    label.dataset.dayLeft = leftPx;
    label.dataset.dayEnd = dayEndPx;
    label.textContent = fmtNaive(dayMs, { weekday: "short", day: "numeric", month: "short" });
    headerTrack.appendChild(label);
    dayLabelsForStickyScroll.push(label);

    const moonInfo = moonPhasesData[dateKey];
    const skipPositions = [];
    if (moonInfo && moonInfo.illumination != null) {
      const moonX = leftPx + 90;
      skipPositions.push(moonX);
      const moonCanvas = document.createElement("canvas");
      moonCanvas.className = "week-moon-icon";
      moonCanvas.width = 14;
      moonCanvas.height = 14;
      moonCanvas.style.left = moonX + "px";
      const mctx = moonCanvas.getContext("2d");
      const waxing = moonInfo.phase ? !moonInfo.phase.startsWith("Waning") : true;
      drawMoonIcon(mctx, 7, 7, 6, moonInfo.illumination, waxing);
      headerTrack.appendChild(moonCanvas);
    }

    const sun = sunByDate.get(dateKey);
    if (sun) {
      if (sun.sunrise != null) {
        const x = leftPx + ((parseNaive(sun.sunrise) - dayMs) / 3600000) * PIXELS_PER_HOUR;
        skipPositions.push(x);
        headerTrack.appendChild(buildSunMarker(x, fmtChartTick(parseNaive(sun.sunrise))));
      }
      if (sun.sunset != null) {
        const x = leftPx + ((parseNaive(sun.sunset) - dayMs) / 3600000) * PIXELS_PER_HOUR;
        skipPositions.push(x);
        headerTrack.appendChild(buildSunMarker(x, fmtChartTick(parseNaive(sun.sunset))));
      }
    }

    const MIN_GAP_PX = 34;
    for (let h = 3; h < 24; h += 3) {
      const hourLeftPx = leftPx + h * PIXELS_PER_HOUR;
      if (hourLeftPx > dayEndPx) break;
      if (skipPositions.some((sx) => Math.abs(sx - hourLeftPx) < MIN_GAP_PX)) continue;
      const tick = document.createElement("div");
      tick.className = "week-hour-tick";
      tick.style.left = hourLeftPx + "px";
      headerTrack.appendChild(tick);
      const hourLabel = document.createElement("div");
      hourLabel.className = "week-hour-label";
      hourLabel.style.left = hourLeftPx + "px";
      hourLabel.textContent = String(h).padStart(2, "0") + ":00";
      headerTrack.appendChild(hourLabel);
    }
  }

  const nowLeftPx = ((nowMs - timelineStart) / 3600000) * PIXELS_PER_HOUR;
  if (nowLeftPx >= 0 && nowLeftPx <= totalTrackWidth) {
    const nowLine = document.createElement("div");
    nowLine.className = "week-now-line";
    nowLine.style.left = nowLeftPx + "px";
    headerTrack.appendChild(nowLine);
  }
  inner.appendChild(headerTrack);

  // Lanes sit inside their own wrapper so a single shading overlay — night
  // and twilight bands, matching the main charts' own colours — can be
  // drawn ONCE behind all of them, rather than duplicated per lane. Each
  // graph tile's OWN chart also draws its own day/night shading internally
  // (unchanged — see charts.js's buildDayBandPlugin), so this is technically
  // duplicated where a tile sits; harmless since both are semi-transparent
  // and pixel-aligned, and it keeps the background consistent in any gaps
  // between/around tiles too.
  const lanesWrap = document.createElement("div");
  lanesWrap.className = "week-lanes-wrap";
  lanesWrap.style.width = totalTrackWidth + "px";

  const shading = document.createElement("div");
  shading.className = "week-shading-overlay";
  let dayIndex = 0;
  for (let dayMs = timelineStart; dayMs <= timelineEnd; dayMs += 86400000, dayIndex++) {
    const leftPx = ((dayMs - timelineStart) / 3600000) * PIXELS_PER_HOUR;
    const dayEndPx = Math.min(totalTrackWidth, leftPx + 24 * PIXELS_PER_HOUR);

    const dayColor = DAY_COLORS[dayIndex % DAY_COLORS.length];
    shading.appendChild(buildShadeBand(leftPx, dayEndPx, dayColor.bg));

    const sun = sunByDate.get(dayKeyOf(new Date(dayMs).toISOString()));
    if (!sun) continue;
    const xFirstLight = sun.firstLight != null ? leftPx + ((parseNaive(sun.firstLight) - dayMs) / 3600000) * PIXELS_PER_HOUR : null;
    const xSunrise = sun.sunrise != null ? leftPx + ((parseNaive(sun.sunrise) - dayMs) / 3600000) * PIXELS_PER_HOUR : null;
    const xSunset = sun.sunset != null ? leftPx + ((parseNaive(sun.sunset) - dayMs) / 3600000) * PIXELS_PER_HOUR : null;
    const xLastLight = sun.lastLight != null ? leftPx + ((parseNaive(sun.lastLight) - dayMs) / 3600000) * PIXELS_PER_HOUR : null;

    if (xFirstLight != null) {
      shading.appendChild(buildShadeBand(leftPx, xFirstLight, NIGHT_BAND_COLOR));
      if (xSunrise != null) shading.appendChild(buildShadeBand(xFirstLight, xSunrise, TWILIGHT_BAND_COLOR));
    } else if (xSunrise != null) {
      shading.appendChild(buildShadeBand(leftPx, xSunrise, NIGHT_BAND_COLOR));
    }
    if (xLastLight != null) {
      if (xSunset != null) shading.appendChild(buildShadeBand(xSunset, xLastLight, TWILIGHT_BAND_COLOR));
      shading.appendChild(buildShadeBand(xLastLight, dayEndPx, NIGHT_BAND_COLOR));
    } else if (xSunset != null) {
      shading.appendChild(buildShadeBand(xSunset, dayEndPx, NIGHT_BAND_COLOR));
    }
  }
  lanesWrap.appendChild(shading);

  // One lane per row of non-overlapping tiles — NOT one row per location.
  for (const lane of lanes) {
    const laneEl = document.createElement("div");
    laneEl.className = "week-track weeknew-lane";
    laneEl.style.width = totalTrackWidth + "px";
    if (nowLeftPx >= 0 && nowLeftPx <= totalTrackWidth) {
      const nowLine = document.createElement("div");
      nowLine.className = "week-now-line";
      nowLine.style.left = nowLeftPx + "px";
      laneEl.appendChild(nowLine);
    }
    for (const t of lane) {
      laneEl.appendChild(buildGraphTileElement(t));
    }
    lanesWrap.appendChild(laneEl);
  }
  inner.appendChild(lanesWrap);
  updateStickyDayLabels(); // position labels correctly right away if the view re-renders while already scrolled
}

function buildShadeBand(xStart, xEnd, color) {
  const band = document.createElement("div");
  band.className = "week-shade-band";
  band.style.left = xStart + "px";
  band.style.width = Math.max(0, xEnd - xStart) + "px";
  band.style.background = color;
  return band;
}

function buildSunMarker(x, timeLabel) {
  const wrap = document.createElement("div");
  wrap.className = "week-sun-marker";
  wrap.style.left = x + "px";
  wrap.innerHTML = `<div class="week-sun-tick"></div><div class="week-sun-label">${timeLabel}</div>`;
  return wrap;
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

/**
 * Manually keeps each day's date label pinned to the visible left edge of
 * the timeline for as long as any part of that day is still on screen,
 * then lets it scroll away naturally once its own day has fully passed —
 * see the matching comment in week.js for the full reasoning (a genuine
 * browser quirk stops plain CSS position:sticky from engaging in this
 * nested layout). Kept as-is here — this is the shared timeline HEADER's
 * own behavior, unrelated to the per-tile sticky-content trick this page
 * deliberately drops (see buildGraphTileElement).
 */
function updateStickyDayLabels() {
  const scrollLeft = document.getElementById("weekTimelineScroll").scrollLeft;
  for (const label of dayLabelsForStickyScroll) {
    const dayLeft = Number(label.dataset.dayLeft);
    const dayEnd = Number(label.dataset.dayEnd);
    const maxLeft = Math.max(dayLeft, dayEnd - label.offsetWidth);
    const desired = Math.min(Math.max(scrollLeft, dayLeft), maxLeft);
    label.style.transform = `translateX(${desired - dayLeft}px)`;
  }
}

/**
 * Builds one session tile as a real conditions graph — replacing the old
 * stat-panel tile (photo background, badges, temp/wind/rain averages) that
 * week.js still uses. A small plain (non-sticky) info row stays at the top
 * for identification — location, type, shore, time range, and the
 * Location/Fishing condition badges, since the chart itself no longer
 * carries a location/date heading (see showDayHeading:false below) — the
 * chart fills the rest of the tile.
 *
 * No hover/click wiring at all: the graph IS the tile's content now, so
 * there's nothing left to reveal on hover or expand on click. No sticky-
 * content trick either — with overflow:hidden safe to use directly here
 * (nothing inside needs to slide independently of the tile), the tile's
 * rounded corners just clip normally.
 */
function buildGraphTileElement(t) {
  const timeLabel = `${fmtNaive(t.from, { hour: "2-digit", minute: "2-digit", hour12: false })}–${fmtNaive(t.to, { hour: "2-digit", minute: "2-digit", hour12: false })}`;

  const tile = document.createElement("div");
  tile.className = "weeknew-tile";
  tile.style.left = t.leftPx + "px";
  tile.style.width = t.widthPx + "px";
  tile.title = `${t.locationName} (${t.type}) — ${timeLabel}`;

  const header = document.createElement("div");
  header.className = "weeknew-tile-header";
  header.innerHTML = `
    <div>
      <div class="window-loc">${t.locationName}</div>
      <div class="window-sub">${t.type} · shore ${t.shore || "–"}</div>
      <div class="window-sub">${timeLabel} · ${t.hoursLabel}h</div>
    </div>
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
  `;
  tile.appendChild(header);

  const chartWrap = document.createElement("div");
  chartWrap.className = "weeknew-tile-chart-wrap";
  const canvas = document.createElement("canvas");
  chartWrap.appendChild(canvas);
  tile.appendChild(chartWrap);

  const dayRows = computeGraphRows(t, t.graphStart, t.graphEnd);
  if (dayRows.length > 0) {
    const matchedLoc = allLocations.find((l) => l.name === t.locationName && l.type === t.type);
    const tileChart = renderConditionsChart({
      canvas,
      rows: dayRows,
      sunTimes: sunTimesData[t.locationName] || [],
      existingChart: null,
      tideMaxObserved: matchedLoc ? matchedLoc.tideMaxObserved : null,
      minTideHeight: matchedLoc ? matchedLoc.minTideHeight : null,
      // Suppressed per this page's brief: the date is already shown in the
      // shared timeline header above every tile, and the moon phase there
      // too — repeating both again per day-band inside a several-hundred-
      // pixel-wide tile chart added nothing but clutter.
      moonPhases: null,
      showDayHeading: false,
      // No x/y axes — the master timeline's own hour ticks and day
      // boundaries directly behind this tile already give the time scale;
      // this chart's xRange below locks it to line up with them exactly.
      compact: true,
      sessionSpan: { from: t.from, to: t.to },
      xRange: { min: t.clampedGraphStart, max: t.graphEnd },
    });
    if (tileChart) activeTileCharts.push(tileChart);
  }

  return tile;
}

init();
