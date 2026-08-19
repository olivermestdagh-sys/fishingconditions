const DATA_URL = "data/conditions.json";

const CONDITION_COLORS = {
  5: "var(--cond-5)",
  4: "var(--cond-4)",
  3: "var(--cond-3)",
  2: "var(--cond-2)",
  1: "var(--cond-1)",
};

let liveData = null;
let liveChart = null;
let currentLocationName = null;
let currentType = null;

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
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "loc-chip type-chip" + (type === selectedType ? " active" : "");
    chip.innerHTML = `${typeIconSvg(type, 16)} <span>${type}</span>`;
    chip.addEventListener("click", () => onSelect(type));
    container.appendChild(chip);
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
  });

  if (windowRows.length === 0) {
    document.getElementById("liveChartSection").style.display = "none";
  }
}

function setGpsStatus(html) {
  document.getElementById("gpsStatus").innerHTML = html;
}

async function init() {
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
