const DATA_URL = "data/conditions.json";
const SETTINGS_URL = "config/settings.json";
const TIMINGS_STORAGE_KEY = "liveHomeTimings";

// Same convention as week.js's own PIXELS_PER_HOUR — a genuinely
// readable, un-squashed width per hour of data, rather than cramming a
// full 48-hour window into one phone-width canvas. Only used on mobile
// (see renderForLocation's isMobileDevice branch) — desktop has enough
// width already that squashing to fit was never the complaint here.
const PIXELS_PER_HOUR = 32;
const isMobileDevice = Math.min(window.innerWidth, window.innerHeight) <= 900;

// CONDITION_COLORS comes from charts.js (loaded before this file).

let liveData = null;
let liveChart = null;
let currentLocationName = null;
let currentType = null;
let currentLoc = null;
let stopFishingTime = null;
// googleRoutesApiKey, currentGpsPosition, requestGpsPosition all come from
// charts.js (loaded before this file).
// Home address — a single lat/lng set on the Settings tab's map ("Add
// Home"), loaded from config/settings.json below. A fixed, precise
// coordinate set once, rather than a free-text address geocoded at
// request time.
let homeLat = null;
let homeLng = null;

function timeToMinutes(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function minutesToClock(mins) {
  const wrapped = ((Math.round(mins) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

function setTimingsStatus(html, isError) {
  const el = document.getElementById("timingsStatus");
  if (!el) return;
  el.innerHTML = html;
  el.style.color = isError ? "#dc2626" : "";
}

/**
 * Works backward from a "Home By" target to find the latest moment fishing
 * can continue: Home By − drive time (fishing spot → home address) − pack
 * up time (from this location's own timing data) − time to get back to the
 * car (current GPS position → the fishing spot, at a fixed 6 km/h walking/
 * paddling pace, not a road route). Draws the result as a line on the
 * graph and shows it as plain text underneath.
 */
async function updateTimings() {
  if (!currentLoc) {
    setTimingsStatus("Match a location first.", true);
    return;
  }
  if (homeLat == null || homeLng == null) {
    setTimingsStatus('No home address set yet — add one on the <a href="locations.html">Settings</a> tab first ("Add Home" on the map).', true);
    return;
  }
  const homeByStr = document.getElementById("homeByTime").value;
  if (!homeByStr) {
    setTimingsStatus("Enter a Home By time.", true);
    return;
  }
  const homeByMinutes = timeToMinutes(homeByStr);
  if (homeByMinutes == null) {
    setTimingsStatus("Home By time doesn't look valid.", true);
    return;
  }

  localStorage.setItem(TIMINGS_STORAGE_KEY, JSON.stringify({ homeByStr }));
  setTimingsStatus("Calculating…");

  // A fresh GPS read, not the cached currentGpsPosition from page load —
  // position may have changed since (paddled out, walked down the beach).
  const currentPosition = await new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
  if (!currentPosition) {
    setTimingsStatus("Couldn't get your current location — check location access is allowed.", true);
    return;
  }

  // getDriveTimeBetweenCoords comes from charts.js — this location's own
  // saved lat/lng to the saved home lat/lng, NOT the device's current GPS
  // position (that's the SEPARATE "back to car" segment below).
  const driveMinutes = await getDriveTimeBetweenCoords(currentLoc.lat, currentLoc.lng, homeLat, homeLng);
  if (driveMinutes == null) {
    setTimingsStatus("Couldn't calculate drive time — check that the Routes API key is set up.", true);
    return;
  }

  const packUpMinutes = timeToMinutes(currentLoc.packUp) || 0;

  const backToCarKm = distanceKm(currentPosition.lat, currentPosition.lng, currentLoc.lat, currentLoc.lng);
  const backToCarMinutes = (backToCarKm / 6) * 60; // fixed 6 km/h walking/paddling pace, not a road route

  const totalMinutesNeeded = driveMinutes + packUpMinutes + backToCarMinutes;

  const nowMs = nowInNaiveEncoding();
  const todayMidnight = Math.floor(nowMs / 86400000) * 86400000;
  let homeByTimestamp = todayMidnight + homeByMinutes * 60000;
  if (homeByTimestamp < nowMs) homeByTimestamp += 86400000; // Home By already passed today -> assume tomorrow

  stopFishingTime = homeByTimestamp - totalMinutesNeeded * 60000;

  setTimingsStatus(
    `Stop fishing by <strong>${minutesToClock((stopFishingTime - todayMidnight) / 60000)}</strong> to be home by ${homeByStr} ` +
    `— back to car ${Math.round(backToCarMinutes)} min, pack up ${Math.round(packUpMinutes)} min, drive ${Math.round(driveMinutes)} min.`
  );

  renderForLocation(currentLoc);
}

// Flat-earth distance is more than accurate enough at these scales (tens of
// km at most between locations in the same two bays) — no need for a full
// great-circle/haversine calculation.
function distanceKm(lat1, lng1, lat2, lng2) {
  const dLat = lat2 - lat1;
  const dLng = (lng2 - lng1) * Math.cos((lat1 * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng) * 111.32;
}

function findNearestLocation(locations, lat, lng) {
  // The same physical spot can now appear multiple times (once per type),
  // all sharing the same lat/lng — dedupe to unique NAMES first, so a
  // GPS match resolves to one physical place, not an arbitrary type.
  const seenNames = new Set();
  const uniqueLocations = [];
  for (const loc of locations) {
    if (loc.lat == null || loc.lng == null || seenNames.has(loc.name)) continue;
    seenNames.add(loc.name);
    uniqueLocations.push(loc);
  }
  let best = null, bestDist = Infinity;
  for (const loc of uniqueLocations) {
    const d = distanceKm(lat, lng, loc.lat, loc.lng);
    if (d < bestDist) { bestDist = d; best = loc; }
  }
  return best ? { location: best, distanceKm: bestDist } : null;
}

/**
 * Builds the map (renderLeafletLocationMap, charts.js) — one marker per
 * tracked location (same dedup-by-name-then-both-types-if-present pattern
 * as the Location tab's own renderLocationMap in app.js), PLUS the
 * device's own current position as a distinct red dot marker
 * (iconKind:"currentPosition") when GPS succeeded — see init(). Clicking
 * a location marker opens/updates the hover panel for that spot; the
 * position marker itself isn't clickable, it's purely a "you are here"
 * reference alongside it.
 */
function renderLiveMap(gpsPosition) {
  const byName = new Map();
  for (const loc of liveData.locations || []) {
    if (!byName.has(loc.name)) byName.set(loc.name, []);
    byName.get(loc.name).push(loc);
  }

  const points = [];
  for (const [name, variants] of byName) {
    const { lat, lng } = variants[0];
    const types = variants.map((v) => v.type);
    const iconKind = types.includes("Kayak") && types.includes("Land based") ? "both" : types.includes("Land based") ? "landBased" : "kayak";
    points.push({ lat, lng, label: name, iconKind, onClick: () => selectLocationAndType(name, "Kayak") });
  }
  if (gpsPosition) {
    points.push({ lat: gpsPosition.lat, lng: gpsPosition.lng, label: "You are here", iconKind: "currentPosition" });
  }

  const map = renderLeafletLocationMap("liveMap", points, {});
  // Overrides whatever renderLeafletLocationMap itself just set (either a
  // saved view shared with the Location/Settings maps, or a fit-everything
  // view) — Live's whole point is "where am I right now", so it should
  // always open centered on the device's actual position when that's
  // available, not wherever a DIFFERENT page's map was last left looking.
  if (map && gpsPosition) {
    map.setView([gpsPosition.lat, gpsPosition.lng], 13);
  }
}

function showLiveHoverPanel() {
  document.getElementById("liveHoverPanel").style.display = "block";
}

function hideLiveHoverPanel() {
  document.getElementById("liveHoverPanel").style.display = "none";
}

function renderTypePicker(availableTypes, selectedType, onSelect) {
  const section = document.getElementById("typePickerSection");
  const container = document.getElementById("typePicker");
  container.innerHTML = "";
  // Only worth showing a picker at all when there's actually a choice —
  // a location with just one type doesn't need a toggle for it.
  if (availableTypes.length <= 1) {
    section.style.display = "none";
    return;
  }
  section.style.display = "block";
  for (const type of availableTypes) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "type-photo-card" + (type === selectedType ? " active" : "");
    const imgSrc = type === "Kayak" ? "images/type-kayak.jpg" : "images/type-landbased.jpg";
    card.innerHTML = `<img src="${imgSrc}" alt="${type}" /><span>${type}</span>`;
    card.addEventListener("click", () => onSelect(type));
    container.appendChild(card);
  }
}

// Selects a physical location by name, resolving which type variant to
// actually show — defaults to Kayak when available (per the site owner's
// stated preference), falling back to whichever type IS available for
// locations that don't have a Kayak option at all. Opens (or keeps open)
// the hover panel and updates its heading — the map-click equivalent of
// tapping a marker on the Location tab.
function selectLocationAndType(name, preferredType) {
  const variants = (liveData.locations || []).filter((l) => l.name === name);
  if (variants.length === 0) return;
  const availableTypes = variants.map((v) => v.type);
  const type = availableTypes.includes(preferredType)
    ? preferredType
    : (availableTypes.includes("Kayak") ? "Kayak" : availableTypes[0]);

  const isNewLocation = name !== currentLocationName;
  currentLocationName = name;
  currentType = type;

  renderTypePicker(availableTypes, type, (newType) => selectLocationAndType(name, newType));

  const loc = variants.find((v) => v.type === type);
  currentLoc = loc;
  // Pack-up time (part of the stop-fishing calculation) differs by type,
  // and the reference point itself changes on a different location — any
  // previously calculated line would be stale, so clear it rather than
  // show a result that no longer matches what's on screen.
  stopFishingTime = null;
  if (isNewLocation) hasCenteredLiveChartOnNow = false; // a genuinely new location is worth re-centering on "now" again; switching type on the SAME spot isn't
  setTimingsStatus("");

  document.getElementById("liveHoverPanelLocationName").textContent = loc.name;
  document.getElementById("liveHoverPanelSub").textContent = `${loc.type} · shore faces ${loc.shore}`;
  showLiveHoverPanel();

  renderForLocation(loc);
}

function renderSummary(loc, rows, now) {
  const card = document.getElementById("liveSummaryCard");
  card.style.display = "flex";
  if (rows.length === 0) {
    card.innerHTML = `<span class="live-inline-stat">No data yet</span>`;
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

  // Compact inline versions of the same badges/stats that used to live in
  // their own stacked card — same data, same condition-badge colors, just
  // small enough to sit directly on the heading row next to the location
  // name (see live.html's .live-heading-row) rather than below it.
  card.innerHTML = `
    <span class="condition-badge live-inline-badge" title="Location condition" style="background:${conditionVal != null ? (CONDITION_COLORS[Math.round(conditionVal)] || "var(--cond-none)") : "var(--cond-none)"}">${conditionVal != null ? conditionVal : "–"}</span>
    <span class="condition-badge live-inline-badge" title="Fishing condition" style="background:${fishingVal != null ? (CONDITION_COLORS[Math.round(fishingVal)] || "var(--cond-none)") : "var(--cond-none)"}">${fishingVal != null ? fishingVal : "–"}</span>
    <span class="live-inline-stat">${tempRt ? tempRt["Temp Realtime (C)"] + "°" : "–"}</span>
    <span class="live-inline-stat">${windRt ? Math.round(windRt["Wind Realtime (km/h)"]) + " km/h" : "–"}</span>
    <span class="live-inline-stat">${tideRow ? tideRow["Tide Status"] : "–"}${tideHeightRow ? " " + tideHeightRow["Tide Height (m)"] + "m" : ""}</span>
  `;
}

// Tracks whether we've already auto-centered the mobile chart on "now"
// for the CURRENT location — reset when the location changes (see
// selectLocationAndType), but NOT on every re-render for the same
// location (switching type, updating timings), so a manually-scrolled
// position isn't yanked away by those.
let hasCenteredLiveChartOnNow = false;

function renderForLocation(loc) {
  const rows = (liveData.rows || [])
    .filter((r) => r["Location Name"] === loc.name && r["Type"] === loc.type)
    .map((r) => ({ ...r, _t: parseNaive(r.dateTime) }))
    .sort((a, b) => a._t - b._t);

  const nowMs = nowInNaiveEncoding();
  const windowStart = nowMs - 24 * 3600 * 1000;
  const windowEnd = nowMs + 24 * 3600 * 1000;
  const windowRows = rows.filter((r) => r._t >= windowStart && r._t <= windowEnd);

  renderSummary(loc, windowRows, new Date());

  const frame = document.getElementById("liveChartFrame");
  const emptyState = document.getElementById("liveHoverPanelEmptyState");
  if (windowRows.length === 0) {
    frame.style.display = "none";
    emptyState.style.display = "block";
    return;
  }
  frame.style.display = "block";
  emptyState.style.display = "none";

  const sunTimes = (liveData.sunTimes && liveData.sunTimes[loc.name]) || [];

  const canvas = document.getElementById("liveChart");
  // On mobile: natural, un-squashed per-hour width (same PIXELS_PER_HOUR
  // convention as week.js) instead of forcing the full 48-hour window
  // into one phone-width canvas — #liveChartScroll (style.css) is what
  // actually makes this scrollable; a canvas width alone does nothing
  // without that wrapper. Desktop is untouched (100%, fills the frame
  // exactly, no scrolling — there was never a "squashed" complaint there).
  if (isMobileDevice) {
    canvas.style.width = 48 * PIXELS_PER_HOUR + "px";
  } else {
    canvas.style.width = "100%";
  }

  liveChart = renderConditionsChart({
    canvas,
    rows: windowRows,
    sunTimes,
    existingChart: liveChart,
    locationName: loc.name,
    tideMaxObserved: loc.tideMaxObserved,
    moonPhases: liveData.moonPhases,
    minTideHeight: loc.minTideHeight,
    stopFishingTime,
    compact: false,
    disableBuiltinEvents: true, // this page drives the tooltip itself — see wireHoldToShowTooltip in init(), and charts.js
    tideOffsetMinutes: loc.tideOffset,
    // Explicit, not left to auto-fit — guarantees "now" sits at EXACTLY
    // the horizontal midpoint of the canvas (windowStart..windowEnd is
    // symmetric around nowMs by construction), which is what the mobile
    // centering scroll just below depends on.
    xRange: { min: windowStart, max: windowEnd },
  });

  if (isMobileDevice && !hasCenteredLiveChartOnNow) {
    hasCenteredLiveChartOnNow = true;
    // Deferred a tick so the canvas has actually taken on the width set
    // above (and .live-chart-scroll's own scrollWidth reflects it) before
    // computing where the midpoint is.
    requestAnimationFrame(() => {
      const scrollWrap = document.getElementById("liveChartScroll");
      if (!scrollWrap) return;
      const target = scrollWrap.scrollWidth / 2 - scrollWrap.clientWidth / 2;
      scrollWrap.scrollLeft = Math.max(0, target);
    });
  }
}

function setGpsStatus(html) {
  const el = document.getElementById("liveGpsStatus");
  if (!html) {
    el.style.display = "none";
    return;
  }
  el.innerHTML = html;
  el.style.display = "block";
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
      homeLat = settings.homeLat ?? null;
      homeLng = settings.homeLng ?? null;
    }
  } catch (err) {
    console.error("Could not load settings.json:", err);
  }

  let savedTimings = null;
  try {
    savedTimings = JSON.parse(localStorage.getItem(TIMINGS_STORAGE_KEY) || "null");
  } catch {
    savedTimings = null;
  }
  if (savedTimings) {
    document.getElementById("homeByTime").value = savedTimings.homeByStr || "";
  }
  document.getElementById("btnUpdateTimings").addEventListener("click", updateTimings);
  document.getElementById("btnCloseLiveHoverPanel").addEventListener("click", hideLiveHoverPanel);
  // Wired once here, not inside renderForLocation — that function reuses
  // this same persistent <canvas> across every location switch and
  // re-render (destroying and recreating the Chart.js instance each time,
  // but never the canvas element itself), so wiring these per-render
  // would stack up duplicate listeners on the same canvas. getChart()
  // always reads whatever the current liveChart is, so this stays correct
  // across those re-renders without needing to be re-wired.
  wireHoldToShowTooltip(() => liveChart, document.getElementById("liveChart"));
  setupFullscreenToggle("liveChartFrame");

  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    liveData = await res.json();
    if (liveData.generatedAt) {
      const dt = new Date(liveData.generatedAt);
      document.getElementById("updated").textContent = `Updated ${dt.toLocaleString([], { dateStyle: "medium", timeStyle: "short", hour12: false })}`;
    }
    // Awaited — small, fast, local file (not the slow WillyWeather
    // pipeline), so negligible delay; avoids a race where the very first
    // location match/render below could happen before tideOffset had
    // been merged in.
    await loadTideOffsets(liveData.locations);
  } catch (err) {
    setGpsStatus(`Could not load conditions data — check your connection.`);
    console.error(err);
    return;
  }

  const locations = liveData.locations || [];

  // requestGpsPosition (charts.js) — shared/cached, so this doesn't
  // trigger a SECOND permission prompt if something else on the page
  // (e.g. a later "Update timings" click) also asks; that action does its
  // own fresh read regardless, since position may have moved on since.
  const position = await requestGpsPosition();
  if (!position) {
    setGpsStatus(`Couldn't get your location — showing all tracked spots. Tap one on the map to view it.`);
    renderLiveMap(null);
    return;
  }

  const match = findNearestLocation(locations, position.lat, position.lng);
  renderLiveMap(position);
  if (!match) {
    setGpsStatus(`Got your location, but no configured spots have coordinates yet.`);
    return;
  }
  setGpsStatus("");
  selectLocationAndType(match.location.name, "Kayak");
}

init();
