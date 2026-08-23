const DATA_URL = "data/conditions.json";
const SETTINGS_URL = "config/settings.json";
const TIMINGS_STORAGE_KEY = "liveHomeTimings";

// CONDITION_COLORS comes from charts.js (loaded before this file).

let liveData = null;
let liveChart = null;
let currentLocationName = null;
let currentType = null;
let currentLoc = null;
let stopFishingTime = null;
let lastChartParams = null;
let modalChart = null;
// googleRoutesApiKey comes from charts.js (loaded before this file).

function openChartModal() {
  if (!lastChartParams) return;
  const overlay = document.getElementById("chartModalOverlay");
  overlay.style.display = "flex";
  modalChart = renderConditionsChart({
    canvas: document.getElementById("liveChartModal"),
    rows: lastChartParams.rows,
    sunTimes: lastChartParams.sunTimes,
    existingChart: modalChart,
    locationName: lastChartParams.locationName,
    tideMaxObserved: lastChartParams.tideMaxObserved,
    moonPhases: liveData.moonPhases,
    minTideHeight: lastChartParams.minTideHeight,
    stopFishingTime: lastChartParams.stopFishingTime,
    compact: false,
  });
}

function closeChartModal() {
  document.getElementById("chartModalOverlay").style.display = "none";
}

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

/**
 * Real drive time (minutes) from a set of coordinates to a free-text
 * address, via Google's Routes API — used here for "fishing location →
 * home address" (the reverse direction from charts.js's own
 * getDriveTimeMinutes(), which goes GPS → location). The destination is
 * passed as a plain address string; Routes API geocodes it internally, no
 * separate geocoding call needed. Returns null (not an exception) on any failure.
 */
async function getDriveTimeToAddress(originLat, originLng, address) {
  if (originLat == null || originLng == null || !address) return null;
  if (!googleRoutesApiKey) return null;
  try {
    const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": googleRoutesApiKey,
        "X-Goog-FieldMask": "routes.duration",
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: originLat, longitude: originLng } } },
        destination: { address },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
      }),
    });
    if (!res.ok) throw new Error(`Routes API returned ${res.status}`);
    const data = await res.json();
    const durationStr = data.routes && data.routes[0] && data.routes[0].duration;
    const durationSeconds = durationStr ? parseInt(durationStr, 10) : null;
    return durationSeconds != null && !Number.isNaN(durationSeconds) ? durationSeconds / 60 : null;
  } catch (err) {
    console.error("Drive time to address lookup failed:", err);
    return null;
  }
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
  const homeByStr = document.getElementById("homeByTime").value;
  const address = document.getElementById("homeAddress").value.trim();
  if (!homeByStr || !address) {
    setTimingsStatus("Enter both a Home By time and a home address.", true);
    return;
  }
  const homeByMinutes = timeToMinutes(homeByStr);
  if (homeByMinutes == null) {
    setTimingsStatus("Home By time doesn't look valid.", true);
    return;
  }

  localStorage.setItem(TIMINGS_STORAGE_KEY, JSON.stringify({ homeByStr, address }));
  setTimingsStatus("Calculating…");

  // A fresh GPS read, not the one from page load — position may have
  // changed since (paddled out, walked down the beach).
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

  const driveMinutes = await getDriveTimeToAddress(currentLoc.lat, currentLoc.lng, address);
  if (driveMinutes == null) {
    setTimingsStatus("Couldn't calculate drive time — check the address, and that the Routes API key is set up.", true);
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

function populateManualPicker(locations, onSelect) {
  const select = document.getElementById("manualLocationSelect");
  select.innerHTML = "";
  const seenNames = new Set();
  for (const loc of locations) {
    if (seenNames.has(loc.name)) continue;
    seenNames.add(loc.name);
    const opt = document.createElement("option");
    opt.value = loc.name;
    opt.textContent = loc.name;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => onSelect(select.value));
  document.getElementById("manualPickerRow").style.display = "block";
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
// locations that don't have a Kayak option at all.
function selectLocationAndType(name, preferredType) {
  const variants = (liveData.locations || []).filter((l) => l.name === name);
  if (variants.length === 0) return;
  const availableTypes = variants.map((v) => v.type);
  const type = availableTypes.includes(preferredType)
    ? preferredType
    : (availableTypes.includes("Kayak") ? "Kayak" : availableTypes[0]);

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
  setTimingsStatus("");
  renderForLocation(loc);
}

function renderSummary(loc, rows, now) {
  const card = document.getElementById("summaryCard");
  card.style.display = "block";
  if (rows.length === 0) {
    card.innerHTML = `<div class="empty-state">No data yet for this location.</div>`;
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
          <div class="condition-badge" style="background:${conditionVal != null ? (CONDITION_COLORS[Math.round(conditionVal)] || "var(--cond-none)") : "var(--cond-none)"}">
            ${conditionVal != null ? conditionVal + "/5" : "–"}
          </div>
          <div class="badge-label">Location</div>
        </div>
        <div class="badge-item">
          <div class="condition-badge" style="background:${fishingVal != null ? (CONDITION_COLORS[Math.round(fishingVal)] || "var(--cond-none)") : "var(--cond-none)"}">
            ${fishingVal != null ? fishingVal + "/5" : "–"}
          </div>
          <div class="badge-label">Fishing</div>
        </div>
      </div>
    </div>
    <div class="stat-grid">
      <div class="stat">
        <div class="label">Temp (realtime)</div>
        <div class="value">${tempRt ? tempRt["Temp Realtime (C)"] + "°" : "–"}</div>
      </div>
      <div class="stat">
        <div class="label">Wind (realtime)</div>
        <div class="value">${windRt ? Math.round(windRt["Wind Realtime (km/h)"]) + " km/h" : "–"}</div>
      </div>
      <div class="stat">
        <div class="label">Tide</div>
        <div class="value">${tideRow ? tideRow["Tide Status"] : "–"}${tideHeightRow ? " " + tideHeightRow["Tide Height (m)"] + "m" : ""}</div>
      </div>
    </div>
  `;
}

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

  document.getElementById("liveChartSection").style.display = "block";
  const sunTimes = (liveData.sunTimes && liveData.sunTimes[loc.name]) || [];
  liveChart = renderConditionsChart({
    canvas: document.getElementById("liveChart"),
    rows: windowRows,
    sunTimes,
    existingChart: liveChart,
    locationName: loc.name,
    tideMaxObserved: loc.tideMaxObserved,
    moonPhases: liveData.moonPhases,
    minTideHeight: loc.minTideHeight,
    stopFishingTime,
    compact: false,
  });
  // Full axes shown directly here too now, not just once the modal opens —
  // no more stripped-down "compact" version anywhere on the site. Tapping
  // still opens the modal (a bigger view), it's just no longer the only
  // place axes show up.
  lastChartParams = { rows: windowRows, sunTimes, locationName: loc.name, tideMaxObserved: loc.tideMaxObserved, minTideHeight: loc.minTideHeight, stopFishingTime };

  if (windowRows.length === 0) {
    document.getElementById("liveChartSection").style.display = "none";
  }
}

function setGpsStatus(html) {
  document.getElementById("gpsStatus").innerHTML = html;
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

  let savedTimings = null;
  try {
    savedTimings = JSON.parse(localStorage.getItem(TIMINGS_STORAGE_KEY) || "null");
  } catch {
    savedTimings = null;
  }
  if (savedTimings) {
    document.getElementById("homeByTime").value = savedTimings.homeByStr || "";
    document.getElementById("homeAddress").value = savedTimings.address || "";
  }
  document.getElementById("btnUpdateTimings").addEventListener("click", updateTimings);
  document.getElementById("liveChart").addEventListener("click", openChartModal);
  document.getElementById("btnCloseChartModal").addEventListener("click", closeChartModal);

  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    liveData = await res.json();
    if (liveData.generatedAt) {
      const dt = new Date(liveData.generatedAt);
      document.getElementById("updated").textContent = `Updated ${dt.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
    }
  } catch (err) {
    setGpsStatus(`<div class="empty-state">Could not load conditions data — check your connection.</div>`);
    console.error(err);
    return;
  }

  const locations = liveData.locations || [];
  populateManualPicker(locations, (name) => {
    setGpsStatus(`<div class="summary-sub">Showing: <strong>${name}</strong> (manually selected)</div>`);
    selectLocationAndType(name, "Kayak");
  });

  if (!navigator.geolocation) {
    setGpsStatus(`<div class="empty-state">Your browser doesn't support GPS location. Pick a spot manually below.</div>`);
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude } = position.coords;
      const match = findNearestLocation(locations, latitude, longitude);
      if (!match) {
        setGpsStatus(`<div class="empty-state">Got your location, but no configured spots have coordinates yet. Pick one manually below.</div>`);
        return;
      }
      setGpsStatus(`<div class="summary-sub">Matched to: <strong>${match.location.name}</strong> (${match.distanceKm.toFixed(1)}km away)</div>`);
      selectLocationAndType(match.location.name, "Kayak");
    },
    (err) => {
      setGpsStatus(`<div class="empty-state">Couldn't get your location (${err.message}). Pick a spot manually below.</div>`);
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}

init();
