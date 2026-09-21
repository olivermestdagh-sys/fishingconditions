// Live mode of the Map tab (conditions.html): GPS lookup, closest tracked location, its 48-hour graph, and
// tap-the-map-to-log-a-catch. Moved here from the old Live tab (live.js). app.js owns the mode switching:
// it calls liveInitOnce() once, then liveEnter()/liveExit() as the Live toggle changes.
// parseNaive, nowInNaiveEncoding, CONDITION_COLORS, renderConditionsChart, wireHoldToShowTooltip,
// setupFullscreenToggle, requestGpsPosition, currentGpsPosition and the marks functions come from js/*.js
// (loaded before this file); isMobileDevice and `state` come from app.js.

const SETTINGS_URL = "https://fishingconditions-users.oliver-mestdagh.workers.dev/api/public/settings";
// The user-backend endpoint that returns the signed-in user's own home and Routes key (all null when signed out): {googleRoutesApiKey, homeLat, homeLng}.
const TIMINGS_STORAGE_KEY = "liveHomeTimings";

// Same convention as Week Ahead's PIXELS_PER_HOUR — a readable, un-squashed width per hour of data,
// rather than cramming a full 48-hour window into one phone-width canvas. Mobile only (see renderForLocation).
const LIVE_PIXELS_PER_HOUR = 32;

let liveData = null;
let liveChart = null;
let currentLocationName = null;
let currentType = null;
let currentLoc = null;
let stopFishingTime = null;
// Home address — a single lat/lng set on the Settings tab's map ("Add Home"), loaded from the settings endpoint.
let homeLat = null;
let homeLng = null;

// timeToMinutes comes from js/week-tools.js (identical).

// 12-hour, unlike week-tools' 24-hour minutesToClock.
function liveMinutesToClock(mins) {
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

  Prefs.set(TIMINGS_STORAGE_KEY, JSON.stringify({ homeByStr }));
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

  // This location's own saved lat/lng to the saved home lat/lng, NOT the
  // device's current GPS position (that's the SEPARATE "back to car" segment below).
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
    `Stop fishing by <strong>${liveMinutesToClock((stopFishingTime - todayMidnight) / 60000)}</strong> to be home by ${homeByStr} ` +
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
  // The same physical spot can appear multiple times (once per type),
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
 * Builds the Live-mode map: one marker per tracked location (same
 * dedup-by-name pattern as Normal mode's renderLocationMap), PLUS the
 * device's own current position as a distinct red dot marker when GPS
 * succeeded. Clicking a location marker opens/updates the hover panel for
 * that spot; clicking either the position marker OR any other open water
 * starts a new fishing mark right there (handleMapClickForMarks with no
 * preview callback) — for the position marker, using the actual
 * gpsPosition coordinates, since a marker click doesn't hand back map
 * coordinates the way a plain map click does.
 * Returns {map, markLayerState} so app.js can use the marks for export.
 */
function liveBuildMap(gpsPosition) {
  const markLayerState = createMarkLayerState();
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
    points.push({ lat, lng, label: displayNameFor(variants[0]), iconKind, onClick: () => selectLocationAndType(name, "Kayak") });
  }
  if (gpsPosition) {
    points.push({
      lat: gpsPosition.lat,
      lng: gpsPosition.lng,
      label: "You are here",
      iconKind: "currentPosition",
      // ONLY this exact entry point gets smart-filled Tide Condition (from
      // currentLoc's own real tide data) plus "last value used" for
      // everything else EXCEPT Weather Condition, which deliberately gets
      // no default at all — see computeQuickMarkDefaults' own comment
      // (js/marks-core.js). A plain map click always starts blank; guessing
      // conditions for an arbitrary clicked point would be guessing about
      // somewhere the person isn't necessarily standing.
      onClick: () => {
        const defaults = { ...getLastMarkFieldValues(), ...computeQuickMarkDefaults(getRowsForCurrentLoc()) };
        handleMapClickForMarks(map, gpsPosition.lat, gpsPosition.lng, markLayerState, null, defaults);
      },
    });
  }

  const map = renderLeafletLocationMap("locationMap", points, {
    persistView: false, // Live sets its own view; don't overwrite where Normal mode reopens
    onMapClick: (lat, lng) => handleMapClickForMarks(map, lat, lng, markLayerState, null),
  });
  // Live's whole point is "where am I right now", so it always opens
  // centered on the device's actual position when that's available.
  if (map && gpsPosition) {
    map.setView([gpsPosition.lat, gpsPosition.lng], 13);
  }
  if (map) loadAndRenderMarks(map, markLayerState);
  return { map, markLayerState };
}

// Whether the panel's expanded content (ratings, timings, chart) is
// currently showing, vs just the collapsed name+distance banner. Reset to
// false whenever a genuinely NEW location is selected (see
// selectLocationAndType) — "when first getting a location, only show the
// banner" applies fresh each time a different spot is picked.
let isPanelExpanded = false;
// Whether renderForLocation (which builds both the summary badges AND the
// Chart.js chart) has actually run yet for whatever's currently in
// currentLoc. Deferred until the panel is actually expanded — building a
// chart into a canvas inside a display:none container measures as zero
// width/height, so rendering only happens once the container is visible.
let hasRenderedExpandedContentForCurrentLoc = false;

function showLiveHoverPanel() {
  // Same fix as showLocationHoverPanel (app.js): the two panels compete for space.
  if (typeof closeMarkDetailPanel === "function") closeMarkDetailPanel();
  document.getElementById("liveHoverPanel").style.display = "block";
}

function hideLiveHoverPanel() {
  document.getElementById("liveHoverPanel").style.display = "none";
  // Collapses for next time — closing the panel always means "start fresh,
  // collapsed" the next time it opens.
  setPanelExpanded(false);
}

function setPanelExpanded(expanded) {
  isPanelExpanded = expanded;
  document.getElementById("liveHoverPanelExpanded").style.display = expanded ? "block" : "none";
  document.getElementById("liveHoverPanelChevron").textContent = expanded ? "▴" : "▾";
  document.getElementById("liveHoverPanelBanner").setAttribute("aria-expanded", expanded ? "true" : "false");
  if (expanded && currentLoc && !hasRenderedExpandedContentForCurrentLoc) {
    hasRenderedExpandedContentForCurrentLoc = true;
    renderForLocation(currentLoc);
  }
}

function updateDistanceDisplay(loc) {
  const el = document.getElementById("liveHoverPanelDistance");
  if (currentGpsPosition && loc.lat != null && loc.lng != null) {
    const d = distanceKm(currentGpsPosition.lat, currentGpsPosition.lng, loc.lat, loc.lng);
    el.textContent = `${d.toFixed(1)}km away`;
  } else {
    el.textContent = "";
  }
}

function renderTypePicker(availableTypes, selectedType, onSelect) {
  const section = document.getElementById("typePickerSection");
  const container = document.getElementById("typePicker");
  container.innerHTML = "";
  // Only worth showing a picker when there's actually a choice.
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
// actually show — defaults to Kayak when available, falling back to
// whichever type IS available. Opens (or keeps open) the hover panel and
// updates its banner.
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
  // Pack-up time differs by type, and the reference point itself changes on
  // a different location — any previously calculated line would be stale.
  stopFishingTime = null;
  if (isNewLocation) hasCenteredLiveChartOnNow = false; // a genuinely new location is worth re-centering on "now" again; switching type on the SAME spot isn't
  setTimingsStatus("");

  document.getElementById("liveHoverPanelLocationName").textContent = displayNameFor(loc);
  updateDistanceDisplay(loc);
  showLiveHoverPanel();

  if (isNewLocation) {
    // A genuinely new spot always starts collapsed.
    hasRenderedExpandedContentForCurrentLoc = false;
    setPanelExpanded(false);
  } else if (isPanelExpanded) {
    // Same spot, just switched Kayak/Land based type, and the panel's
    // already open — refresh what's showing immediately.
    renderForLocation(loc);
  }
}

function liveRenderSummary(loc, rows, now) {
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

  // Compact inline badges/stats that sit directly on the heading row next to the location name.
  card.innerHTML = `
    <span class="condition-badge live-inline-badge" title="Location condition" style="background:${conditionVal != null ? (CONDITION_COLORS[Math.round(conditionVal)] || "var(--cond-none)") : "var(--cond-none)"}">${conditionVal != null ? conditionVal : "–"}</span>
    <span class="condition-badge live-inline-badge" title="Fishing condition" style="background:${fishingVal != null ? (CONDITION_COLORS[Math.round(fishingVal)] || "var(--cond-none)") : "var(--cond-none)"}">${fishingVal != null ? fishingVal : "–"}</span>
    <span class="live-inline-stat">${tempRt ? tempRt["Temp Realtime (C)"] + "°" : "–"}</span>
    <span class="live-inline-stat">${windRt ? Math.round(windRt["Wind Realtime (km/h)"]) + " km/h" : "–"}</span>
    <span class="live-inline-stat">${tideRow ? tideRow["Tide Status"] : "–"}${tideHeightRow ? " " + tideHeightRow["Tide Height (m)"] + "m" : ""}</span>
  `;
}

// Tracks whether we've already auto-centered the mobile chart on "now"
// for the CURRENT location — reset when the location changes, but NOT on
// every re-render for the same location, so a manually-scrolled position
// isn't yanked away.
let hasCenteredLiveChartOnNow = false;

// Shared by renderForLocation and the "You are here" quick-mark-entry click
// handler (liveBuildMap) — both need the exact same filtered/sorted/
// _t-annotated rows for currentLoc.
function getRowsForCurrentLoc() {
  if (!currentLoc) return [];
  return (liveData.rows || [])
    .filter((r) => r["Location Name"] === currentLoc.name && r["Type"] === currentLoc.type)
    .map((r) => ({ ...r, _t: parseNaive(r.dateTime) }))
    .sort((a, b) => a._t - b._t);
}

function renderForLocation(loc) {
  const rows = getRowsForCurrentLoc();

  const nowMs = nowInNaiveEncoding();
  const windowStart = nowMs - 24 * 3600 * 1000;
  const windowEnd = nowMs + 24 * 3600 * 1000;
  const windowRows = rows.filter((r) => r._t >= windowStart && r._t <= windowEnd);

  liveRenderSummary(loc, windowRows, new Date());

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
  // Sets the WRAPPER's width, not the canvas's own — Chart.js's own
  // responsive resize logic silently resets the canvas back down to match
  // its parent, so making the PARENT wide is the only way this holds. On
  // mobile: natural, un-squashed per-hour width instead of forcing the full
  // 48-hour window into one phone-width canvas. Desktop fills the frame.
  const wideInner = document.getElementById("liveChartWideInner");
  if (isMobileDevice) {
    wideInner.style.width = 48 * LIVE_PIXELS_PER_HOUR + "px";
  } else {
    wideInner.style.width = "100%";
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
    disableBuiltinEvents: true, // this mode drives the tooltip itself — see wireHoldToShowTooltip in liveInitOnce
    tideOffsetMinutes: loc.tideOffset,
    // Explicit, not left to auto-fit — guarantees "now" sits at EXACTLY
    // the horizontal midpoint of the canvas, which the mobile centering scroll below depends on.
    xRange: { min: windowStart, max: windowEnd },
  });

  if (isMobileDevice && !hasCenteredLiveChartOnNow) {
    hasCenteredLiveChartOnNow = true;
    // Deferred a tick so the canvas has actually taken on the width set
    // above before computing where the midpoint is.
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

// One-time wiring of Live's own controls. Called once by app.js at page load.
let liveSettingsPromise = null;
function liveInitOnce() {
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
  document.getElementById("liveHoverPanelBanner").addEventListener("click", () => setPanelExpanded(!isPanelExpanded));
  // Wired once, not inside renderForLocation — that function reuses this
  // same persistent <canvas> across every re-render (destroying and
  // recreating the Chart.js instance each time, never the canvas element),
  // so wiring per-render would stack up duplicate listeners. The getter
  // always reads whatever the current liveChart is.
  wireHoldToShowTooltip(() => liveChart, document.getElementById("liveChart"));
  setupFullscreenToggle("liveChartFrame");
}

// Loaded separately from the main data fetch, with its own error handling —
// a missing settings response just leaves the drive-time feature unavailable.
function liveLoadSettings() {
  if (!liveSettingsPromise) {
    liveSettingsPromise = (async () => {
      try {
        const settingsRes = await fetch(SETTINGS_URL, { cache: "no-store", credentials: "include" });
        if (settingsRes.ok) {
          const settings = await settingsRes.json();
          googleRoutesApiKey = settings.googleRoutesApiKey || null;
          homeLat = settings.homeLat ?? null;
          homeLng = settings.homeLng ?? null;
        }
      } catch (err) {
        console.error("Could not load settings:", err);
      }
    })();
  }
  return liveSettingsPromise;
}

/**
 * Switches the Map tab into Live mode: GPS lookup, closest location, and the
 * Live map. `isStale()` says whether the person has since changed mode again
 * (GPS can take a while), in which case nothing more is drawn.
 * Resolves to {map, markLayerState}, or null if it went stale.
 */
async function liveEnter(isStale) {
  liveData = state.data;
  setGpsStatus("Finding your location…");
  liveLoadSettings(); // not awaited — only the drive-time feature needs it

  // requestGpsPosition (js/week-tools.js) — shared/cached, so this doesn't
  // trigger a SECOND permission prompt. Assigned to the SHARED
  // currentGpsPosition since updateDistanceDisplay needs it later too.
  currentGpsPosition = await requestGpsPosition();
  if (isStale()) return null;

  const locations = liveData.locations || [];
  if (!currentGpsPosition) {
    setGpsStatus(`Couldn't get your location — showing all tracked spots. Tap one on the map to view it.`);
    return liveBuildMap(null);
  }

  const match = findNearestLocation(locations, currentGpsPosition.lat, currentGpsPosition.lng);
  const built = liveBuildMap(currentGpsPosition);
  if (!match) {
    setGpsStatus(`Got your location, but no configured spots have coordinates yet.`);
    return built;
  }
  setGpsStatus("");
  selectLocationAndType(match.location.name, "Kayak");
  return built;
}

// Leaves Live mode: hides its panel/status and resets its per-location state,
// so re-entering re-matches the nearest spot from scratch.
function liveExit() {
  document.getElementById("liveHoverPanel").style.display = "none";
  setGpsStatus("");
  if (liveChart) {
    liveChart.destroy();
    liveChart = null;
  }
  isPanelExpanded = false;
  hasRenderedExpandedContentForCurrentLoc = false;
  hasCenteredLiveChartOnNow = false;
  currentLocationName = null;
  currentType = null;
  currentLoc = null;
  stopFishingTime = null;
}
