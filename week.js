const DATA_URL = "data/conditions.json";
const SETTINGS_URL = "config/settings.json";
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
let previewChart = null;
let hoverShowTimer = null;
let previewPinned = false;
let dayLabelsForStickyScroll = []; // rebuilt each render() — see the horizontal-sticky scroll handler below

// Hover-capable devices (desktop, trackpad) get a small floating preview on
// hover instead — lets you see the graph while still seeing every other
// session, since it doesn't cover the timeline the way the full modal does.
// Touch-only devices don't have a real hover state at all, so they keep the
// tap-to-open modal instead.
const supportsHover = typeof window.matchMedia === "function" && window.matchMedia("(hover: hover)").matches;

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
  // Loaded separately from the main data fetch, with its own error handling
  // — a missing/malformed settings file shouldn't break the rest of the
  // page, just leave the drive-time feature gracefully unavailable.
  try {
    const settingsRes = await fetch(SETTINGS_URL, { cache: "no-store" });
    if (settingsRes.ok) {
      const settings = await settingsRes.json();
      googleRoutesApiKey = settings.googleRoutesApiKey || null;
    }
  } catch (err) {
    console.error("Could not load settings.json:", err);
  }

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
  // across visits (same localStorage keys, via charts.js), so they don't
  // reset every time you come back to the page.
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

  // Launch Time / Home By persist across visits (same localStorage key as
  // ever) — used here only to work out fishing/drive time when a tile's
  // chart is opened, not to filter which sessions show.
  let savedTripTimes = null;
  try {
    savedTripTimes = JSON.parse(localStorage.getItem(TRIP_TIMES_STORAGE_KEY) || "null");
  } catch {
    savedTripTimes = null;
  }
  if (savedTripTimes) {
    document.getElementById("launchTime").value = savedTripTimes.launch || "";
    document.getElementById("homeBy").value = savedTripTimes.homeBy || "";
  }
  const persistTripTimes = () => {
    const launch = document.getElementById("launchTime").value;
    const homeBy = document.getElementById("homeBy").value;
    localStorage.setItem(TRIP_TIMES_STORAGE_KEY, JSON.stringify({ launch, homeBy }));
  };
  document.getElementById("launchTime").addEventListener("input", persistTripTimes);
  document.getElementById("homeBy").addEventListener("input", persistTripTimes);

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
  document.getElementById("btnCloseChartModal").addEventListener("click", closeChartModal);
  document.getElementById("btnClosePreview").addEventListener("click", unpinHoverPreview);
  // Click anywhere outside a PINNED preview (and not on a tile, which has
  // its own click handling) closes it — standard "click outside" popover
  // behaviour, so there's always a way out besides the close button.
  document.addEventListener("click", (e) => {
    if (!previewPinned) return;
    const preview = document.getElementById("weekHoverPreview");
    if (preview.contains(e.target) || e.target.closest(".week-tile")) return;
    unpinHoverPreview();
  });

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
  dayLabelsForStickyScroll = [];

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

  // Sun times aren't per-location on this shared timeline — pick any one
  // location's data as representative (Victorian locations are close
  // enough together that sunrise/sunset times barely differ day to day),
  // rather than trying to show a different day/night pattern per lane.
  const sunTimesEntry = Object.values(sunTimesData).find((arr) => arr && arr.length) || [];
  const sunByDate = new Map(sunTimesEntry.map((s) => [s.date, s]));

  // Header: day-boundary gridlines, date labels, moon phase per day, hour
  // marks, and sunrise/sunset markers — sticky so the date stays visible
  // at the top of the box regardless of how far down you've scrolled
  // through the lanes below.
  const headerTrack = document.createElement("div");
  headerTrack.className = "week-track week-header-track";
  headerTrack.style.width = totalTrackWidth + "px";

  for (let dayMs = timelineStart, dayIdx = 0; dayMs <= timelineEnd; dayMs += 86400000, dayIdx++) {
    const leftPx = ((dayMs - timelineStart) / 3600000) * PIXELS_PER_HOUR;
    const dayEndPx = Math.min(totalTrackWidth, leftPx + 24 * PIXELS_PER_HOUR);
    const dateKey = new Date(dayMs).toISOString().slice(0, 10);

    // Same alternating day tint as the lanes below, applied here too so
    // the header visually connects to its own column beneath it, not just
    // to the lanes on their own.
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

    // Moon phase sits right after the date label (not centred in the day's
    // span) — reuses the exact same drawMoonIcon() canvas-drawing routine
    // the main charts use, on a small dedicated canvas, rather than
    // re-implementing that geometry as SVG/DOM.
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

    // Sunrise/sunset — explicit markers at their real times. Collected
    // first (before the generic hour ticks below) so the hour-tick loop
    // can skip anything that would land too close to one of these (or the
    // moon icon above) and collide, now that everything lives on the same
    // single line.
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

    // Hour marks every 3 hours through the day — skipped wherever one
    // would land close enough to the moon icon or a sunrise/sunset marker
    // to collide with it, since those take precedence over a generic tick.
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
  // drawn ONCE behind all of them, rather than duplicated per lane.
  const lanesWrap = document.createElement("div");
  lanesWrap.className = "week-lanes-wrap";
  lanesWrap.style.width = totalTrackWidth + "px";

  const shading = document.createElement("div");
  shading.className = "week-shading-overlay";
  let dayIndex = 0;
  for (let dayMs = timelineStart; dayMs <= timelineEnd; dayMs += 86400000, dayIndex++) {
    const leftPx = ((dayMs - timelineStart) / 3600000) * PIXELS_PER_HOUR;
    const dayEndPx = Math.min(totalTrackWidth, leftPx + 24 * PIXELS_PER_HOUR);

    // Alternating day tint, from the same palette used elsewhere on the
    // site for day-grouped content — appended first so it sits behind the
    // night/twilight shading below (plain DOM order controls stacking
    // here, there's no z-index fight to worry about). Added for every day
    // regardless of whether sun data is available for it, unlike the
    // night/twilight bands below which need real sunrise/sunset times.
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
/**
 * Manually keeps each day's date label pinned to the visible left edge of
 * the timeline for as long as any part of that day is still on screen,
 * then lets it scroll away naturally once its own day has fully passed —
 * exactly what CSS position:sticky is meant for, but a genuine, confirmed
 * browser quirk in this specific nested layout (a sticky element inside
 * another absolutely-positioned wrapper, itself inside the header row)
 * stopped position:sticky from engaging at all here, for reasons that
 * held up under direct testing but didn't resolve to a fixable single
 * cause. This reproduces the same visual behavior directly instead of
 * relying on it: each label's true (unscrolled) position is clamped to
 * [its day's own start, its day's own end minus its own width], and the
 * clamped result naturally scrolls out of view once the scroll position
 * moves past it — no special-case "un-stick" logic needed for that part.
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
  tile.title = `${t.locationName} (${t.type}) — ${timeLabel}`;
  tile.setAttribute("role", "button");
  tile.setAttribute("tabindex", "0");

  const bg = document.createElement("div");
  bg.className = "week-tile-bg";
  bg.style.backgroundImage = `linear-gradient(rgba(255,255,255,0.88), rgba(255,255,255,0.88)), url(${photoUrl})`;
  tile.appendChild(bg);

  // Content lives in its own inner wrapper, sticky within the tile's own
  // bounds — as you scroll the timeline horizontally, this stays pinned to
  // the visible left edge for as long as any part of the tile is still on
  // screen, and only scrolls away once the tile itself has fully scrolled
  // past. Native position:sticky nested inside an absolutely-positioned
  // parent does exactly this: it's bounded by that parent's own width, not
  // free to drift past either edge of the tile.
  const content = document.createElement("div");
  content.className = "week-tile-content";
  content.innerHTML = `
    <div class="week-tile-header">
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
  tile.appendChild(content);

  if (supportsHover) {
    tile.addEventListener("mouseenter", () => {
      clearTimeout(hoverShowTimer);
      hoverShowTimer = setTimeout(() => showHoverPreview(t, tile), 250);
    });
    tile.addEventListener("mouseleave", () => {
      clearTimeout(hoverShowTimer);
      if (!previewPinned) hideHoverPreview();
    });
    tile.addEventListener("click", () => pinHoverPreview(t, tile));
  } else {
    tile.addEventListener("click", () => selectTile(t));
    tile.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectTile(t); }
    });
  }
  return tile;
}

/**
 * Small floating chart preview shown on hover (desktop only — see
 * supportsHover above) — deliberately NOT the full modal, so every other
 * session tile stays visible while you're looking at this one's graph.
 * Positioned near the hovered tile, flipped above/below/left/right as
 * needed to stay on screen. Clicking the tile "pins" this same preview
 * open and interactive (see pinHoverPreview) instead of it closing the
 * moment the mouse moves away.
 */
function renderPreviewContent(t, tileEl) {
  const dayRows = computeGraphRows(t);
  if (dayRows.length === 0) return false;

  const matchedLoc = allLocations.find((l) => l.name === t.locationName && l.type === t.type);
  const preview = document.getElementById("weekHoverPreview");

  const tileRect = tileEl.getBoundingClientRect();
  const previewWidth = 560;
  const previewHeight = 460;
  let left = tileRect.left;
  let top = tileRect.bottom + 8;
  if (top + previewHeight > window.innerHeight) top = tileRect.top - previewHeight - 8;
  if (top < 10) top = 10; // taller preview than the viewport itself — pin to the top rather than go negative
  if (left + previewWidth > window.innerWidth) left = window.innerWidth - previewWidth - 10;
  if (left < 10) left = 10;
  preview.style.left = left + "px";
  preview.style.top = top + "px";
  preview.style.display = "block";
  void preview.offsetHeight; // force a reflow before Chart.js measures the now-visible container, or it can measure a stale (zero/hidden) size

  // The chart renders immediately, synchronously — it must NOT wait on the
  // schedule below, whose drive-time lookup depends on GPS and a network
  // call and can legitimately take many seconds (or effectively hang
  // without location permission granted). Gating the graph itself behind
  // that would mean it simply doesn't appear for a long time, which is a
  // worse problem than the one this used to work around — that was
  // actually a real bug in the chart's own heading-text sizing (now fixed
  // directly in charts.js), not a container-timing issue that needed the
  // chart delayed to work around.
  previewChart = renderConditionsChart({
    canvas: document.getElementById("weekPreviewChart"),
    rows: dayRows,
    sunTimes: sunTimesData[t.locationName] || [],
    existingChart: previewChart,
    locationName: t.locationName,
    tideMaxObserved: matchedLoc ? matchedLoc.tideMaxObserved : null,
    moonPhases: moonPhasesData,
    minTideHeight: matchedLoc ? matchedLoc.minTideHeight : null,
    compact: false, // full axes on both hover and pinned — no stripped-down "quick glance" version
    sessionSpan: { from: t.from, to: t.to },
  });

  renderWeekSchedule(matchedLoc, "weekPreviewScheduleContainer").then(() => {
    // Safety net, not the primary fix: if the schedule's later-arriving
    // content does change the preview's height enough to add/remove a
    // scrollbar, this catches any resulting width change.
    if (previewChart) previewChart.resize();
  });
  return true;
}

function showHoverPreview(t, tileEl) {
  if (previewPinned) return; // a different session is deliberately pinned open — a stray hover shouldn't replace it
  renderPreviewContent(t, tileEl); // full axes, same as pinned — hover shows the proper graph, not a stripped-down version
}

/**
 * Clicking a tile while its preview is showing (or even without hovering
 * first, on a slower click) pins that same preview open and interactive —
 * pointer-events re-enabled (see .week-hover-preview.pinned), a close
 * button appears, and it no longer closes just because the mouse moved
 * away. Clicking a DIFFERENT tile while one is pinned switches the pin to
 * that new session instead of requiring an explicit close first.
 */
function pinHoverPreview(t, tileEl) {
  if (!renderPreviewContent(t, tileEl)) return;
  previewPinned = true;
  document.getElementById("weekHoverPreview").classList.add("pinned");
}

function unpinHoverPreview() {
  previewPinned = false;
  document.getElementById("weekHoverPreview").classList.remove("pinned");
  hideHoverPreview();
}

function hideHoverPreview() {
  document.getElementById("weekHoverPreview").style.display = "none";
}

let weekScheduleRenderToken = 0;

/**
 * Works out which stretch of rows a session's graph should cover — NOT
 * just that calendar day, but the session's own full duration, since a
 * session can run for many hours or even span several days. The range is
 * anchored to a meaningful day/night boundary rather than an arbitrary
 * clock time:
 *   - session starts in daylight -> start the graph at the PRIOR sunset
 *     (the previous evening's, since today's own sunset hasn't happened
 *     yet if the session is starting during the day)
 *   - session starts at night -> start the graph at the PRIOR sunrise
 *     (today's, if the session starts in the evening after today's
 *     sunrise already happened; yesterday's, if it's starting in the
 *     pre-dawn hours before today's sunrise)
 * Falls back to the session's own start time if sun data isn't available
 * for that day, rather than guessing.
 */
function computeGraphRows(t) {
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

  // Same reasoning, mirrored, for the end of the range — matches the Live
  // page's own graph: the start reaches back through one full opposite-type
  // period (day/night) before the session begins, so the end reaches
  // forward through one full opposite-type period after it finishes, for
  // balanced context on both sides rather than stopping abruptly the
  // moment the session itself ends.
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

  return allRows
    .filter((r) => r["Location Name"] === t.locationName && r["Type"] === t.type && r._t >= graphStart && r._t <= graphEnd)
    .sort((a, b) => a._t - b._t);
}

function selectTile(t) {
  currentTile = t;

  const dayRows = computeGraphRows(t);
  if (dayRows.length === 0) return;

  const matchedLoc = allLocations.find((l) => l.name === t.locationName && l.type === t.type);
  const overlay = document.getElementById("chartModalOverlay");
  overlay.style.display = "flex";
  void overlay.offsetHeight; // force a reflow before Chart.js measures the now-visible container, or it can measure a stale (zero/hidden) size

  // Renders immediately — must not wait on the schedule below, whose
  // drive-time lookup depends on GPS and a network call and can
  // legitimately take a long time (or hang without location permission
  // granted). See the matching comment in renderPreviewContent for why
  // that was tried and reverted: gating the graph on that lookup made it
  // simply not appear for a long time, which is worse than the sizing
  // issue it was meant to prevent — one that turned out to be a real bug
  // in the chart's own heading-text handling, fixed directly in charts.js.
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
    sessionSpan: { from: t.from, to: t.to },
  });

  renderWeekSchedule(matchedLoc, "weekScheduleContainer").then(() => {
    if (modalChart) modalChart.resize();
  });
}

/**
 * Fishing time / drive time — uses computeSchedule()/getDriveTimeMinutes()
 * from charts.js, and the Launch Time / Home By inputs above. Shared
 * between the modal and the hover preview (different containerId per
 * caller) — both show the same schedule info, not just the modal.
 */
async function renderWeekSchedule(loc, containerId) {
  const container = document.getElementById(containerId);
  const myToken = ++weekScheduleRenderToken;

  const launchStr = document.getElementById("launchTime").value;
  const homeByStr = document.getElementById("homeBy").value;

  if (!launchStr || !homeByStr) {
    container.innerHTML = `<p class="footnote" style="margin:14px 0 0;text-align:left;">Set Launch Time and Home By in Thresholds &amp; filters above to see fishing/drive time for this session.</p>`;
    return;
  }
  if (!loc) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = `<p class="footnote" style="margin:14px 0 0;text-align:left;">Calculating drive time…</p>`;

  const driveMinutes = await getDriveTimeMinutes(loc.lat, loc.lng);

  if (myToken !== weekScheduleRenderToken) return; // a newer tile was tapped/hovered meanwhile — discard this stale result

  const schedule = computeSchedule(loc, launchStr, homeByStr, driveMinutes);

  if (!schedule) {
    container.innerHTML = "";
    return;
  }

  const toggleId = containerId + "FishingTimeToggle";
  const wrapId = containerId + "TimelineWrap";
  const hintId = containerId + "ToggleHint";

  if (schedule.driveTimeUnavailable) {
    container.innerHTML = `
      <label class="loc-edit-label" style="display:block;margin:16px 0 8px;">Trip schedule — ${loc.name}</label>
      <p class="footnote" style="margin:0;text-align:left;">
        Drive time isn't available right now (location access denied, or the
        drive-time lookup isn't set up yet), so Leave Home / Head Back / Drive
        Home can't be calculated. What we do know: Arrive ${schedule.arrive},
        Launch ${schedule.launch}, Fish at ${schedule.fishAt}, Home by ${schedule.homeBy}.
      </p>
    `;
    return;
  }

  container.innerHTML = `
    <label class="loc-edit-label" style="display:block;margin:16px 0 8px;">Trip schedule — ${loc.name}</label>
    <div class="schedule-fishing-time ${schedule.fishingTimeNegative ? "negative" : ""}" id="${toggleId}" role="button" tabindex="0">
      Fishing time: <strong>${schedule.fishingTime}</strong>
      <span class="schedule-toggle-hint" id="${hintId}">▸ tap for times</span>
      ${schedule.fishingTimeNegative ? "<br>times don't add up, check Launch Time / Home By against this location's timings" : ""}
    </div>
    <div class="schedule-timeline collapsed" id="${wrapId}">
      <div class="schedule-step"><span class="schedule-time">${schedule.leaveHome}</span><span class="schedule-label">Leave Home</span></div>
      <div class="schedule-step"><span class="schedule-time">${schedule.arrive}</span><span class="schedule-label">Arrive</span></div>
      <div class="schedule-step"><span class="schedule-time">${schedule.launch}</span><span class="schedule-label">Launch</span></div>
      <div class="schedule-step"><span class="schedule-time">${schedule.fishAt}</span><span class="schedule-label">Fish at</span></div>
      <div class="schedule-step"><span class="schedule-time">${schedule.headBack}</span><span class="schedule-label">Head Back</span></div>
      <div class="schedule-step"><span class="schedule-time">${schedule.driveHome}</span><span class="schedule-label">Drive Home</span></div>
      <div class="schedule-step"><span class="schedule-time">${schedule.homeBy}</span><span class="schedule-label">Home By</span></div>
    </div>
    <p class="footnote" style="margin:8px 0 0;text-align:left;">Drive time: ~${schedule.driveMinutes} min each way, from your current location.</p>
  `;

  const toggle = document.getElementById(toggleId);
  const wrap = document.getElementById(wrapId);
  const hint = document.getElementById(hintId);
  const toggleFn = () => {
    const nowCollapsed = wrap.classList.toggle("collapsed");
    hint.textContent = nowCollapsed ? "▸ tap for times" : "▾ hide times";
  };
  toggle.addEventListener("click", toggleFn);
  toggle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleFn(); }
  });
}

function closeChartModal() {
  document.getElementById("chartModalOverlay").style.display = "none";
}

init();
