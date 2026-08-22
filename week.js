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

  // Launch Time / Home By are shared with the Trip Planner (same
  // localStorage key) — used here only to work out fishing/drive time when
  // a tile's chart is opened, not to filter which sessions show.
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

  for (let dayMs = timelineStart; dayMs <= timelineEnd; dayMs += 86400000) {
    const leftPx = ((dayMs - timelineStart) / 3600000) * PIXELS_PER_HOUR;
    const dayEndPx = Math.min(totalTrackWidth, leftPx + 24 * PIXELS_PER_HOUR);

    const boundary = document.createElement("div");
    boundary.className = "week-day-boundary";
    boundary.style.left = leftPx + "px";
    headerTrack.appendChild(boundary);

    const label = document.createElement("div");
    label.className = "week-day-label";
    label.style.left = leftPx + "px";
    label.textContent = fmtNaive(dayMs, { weekday: "short", day: "numeric", month: "short" });
    headerTrack.appendChild(label);

    // Hour marks every 3 hours through the day — small ticks + labels,
    // distinct from (and secondary to) the sunrise/sunset markers below.
    for (let h = 3; h < 24; h += 3) {
      const hourLeftPx = leftPx + h * PIXELS_PER_HOUR;
      if (hourLeftPx > dayEndPx) break;
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

    // Moon phase, one icon per day — reuses the exact same drawMoonIcon()
    // canvas-drawing routine the main charts use, on a small dedicated
    // canvas, rather than re-implementing that geometry as SVG/DOM.
    const dateKey = new Date(dayMs).toISOString().slice(0, 10);
    const moonInfo = moonPhasesData[dateKey];
    if (moonInfo && moonInfo.illumination != null) {
      const moonCanvas = document.createElement("canvas");
      moonCanvas.className = "week-moon-icon";
      moonCanvas.width = 16;
      moonCanvas.height = 16;
      moonCanvas.style.left = (leftPx + dayEndPx) / 2 - 8 + "px";
      const mctx = moonCanvas.getContext("2d");
      const waxing = moonInfo.phase ? !moonInfo.phase.startsWith("Waning") : true;
      drawMoonIcon(mctx, 8, 8, 7, moonInfo.illumination, waxing);
      headerTrack.appendChild(moonCanvas);
    }

    // Sunrise/sunset — explicit markers at their real times, distinct from
    // (and independent of) the generic 3-hourly tick grid above, since
    // sunrise/sunset rarely land exactly on one of those ticks.
    const sun = sunByDate.get(dateKey);
    if (sun) {
      if (sun.sunrise != null) {
        const x = leftPx + ((parseNaive(sun.sunrise) - dayMs) / 3600000) * PIXELS_PER_HOUR;
        headerTrack.appendChild(buildSunMarker(x, fmtChartTick(parseNaive(sun.sunrise))));
      }
      if (sun.sunset != null) {
        const x = leftPx + ((parseNaive(sun.sunset) - dayMs) / 3600000) * PIXELS_PER_HOUR;
        headerTrack.appendChild(buildSunMarker(x, fmtChartTick(parseNaive(sun.sunset))));
      }
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
  for (let dayMs = timelineStart; dayMs <= timelineEnd; dayMs += 86400000) {
    const leftPx = ((dayMs - timelineStart) / 3600000) * PIXELS_PER_HOUR;
    const dayEndPx = Math.min(totalTrackWidth, leftPx + 24 * PIXELS_PER_HOUR);
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
  tile.appendChild(content);

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
let weekScheduleRenderToken = 0;

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

  renderWeekSchedule(matchedLoc);
}

/**
 * Fishing time / drive time, worked out exactly the way the Trip Planner
 * does — same computeSchedule()/getDriveTimeMinutes() from charts.js, same
 * Launch Time / Home By inputs (shared localStorage key, so a value set on
 * either page carries over to the other).
 */
async function renderWeekSchedule(loc) {
  const container = document.getElementById("weekScheduleContainer");
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

  if (myToken !== weekScheduleRenderToken) return; // a newer tile was tapped meanwhile — discard this stale result

  const schedule = computeSchedule(loc, launchStr, homeByStr, driveMinutes);

  if (!schedule) {
    container.innerHTML = "";
    return;
  }

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
    <div class="schedule-fishing-time ${schedule.fishingTimeNegative ? "negative" : ""}" id="weekFishingTimeToggle" role="button" tabindex="0">
      Fishing time: <strong>${schedule.fishingTime}</strong>
      <span class="schedule-toggle-hint" id="weekScheduleToggleHint">▸ tap for times</span>
      ${schedule.fishingTimeNegative ? "<br>times don't add up, check Launch Time / Home By against this location's timings" : ""}
    </div>
    <div class="schedule-timeline collapsed" id="weekScheduleTimelineWrap">
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

  const toggle = document.getElementById("weekFishingTimeToggle");
  const wrap = document.getElementById("weekScheduleTimelineWrap");
  const hint = document.getElementById("weekScheduleToggleHint");
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
