const DATA_URL = "data/conditions.json";
const SETTINGS_URL = "config/settings.json";
const LOC_FILTER_STORAGE_KEY = "goodConditionsSelectedLocations";
const TYPE_FILTER_STORAGE_KEY = "goodConditionsSelectedTypes";
const TRIP_TIMES_STORAGE_KEY = "goodConditionsTripTimes";

// Loaded from config/settings.json at page load (see init()) — kept in a
// SEPARATE file from the rest of the site's code specifically so it never
// gets overwritten when goodconditions.js itself is updated. Set via the
// Settings page, not by hand-editing this file.
let googleRoutesApiKey = null;

let allRows = [];
let allLocations = [];
let sunTimesData = {};
let moonPhasesData = {};
let selectedLocations = new Set();
let selectedTypes = new Set(["Kayak", "Land based"]);

// Drive time is calculated live from the device's current GPS position to
// each location, rather than a fixed value set per location — the same
// spot might be a short drive from home but a long one when travelling.
let currentGpsPosition = null;
let gpsRequestPromise = null;
const driveTimeCache = {};

function requestGpsPosition() {
  // Only ever ask the browser once per page load — cached in a shared
  // promise so multiple simultaneous callers all wait on the same request
  // rather than triggering repeat permission prompts.
  if (gpsRequestPromise) return gpsRequestPromise;
  gpsRequestPromise = new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 300000 }
    );
  });
  return gpsRequestPromise;
}

/**
 * Real drive time (minutes) from the device's current GPS position to a
 * destination, via Google's Routes API (computeRoutes, traffic-aware) — a
 * genuine live routing lookup, not a fixed guess. Returns null (not an
 * exception) for any failure — no key configured, GPS denied, network
 * error — so callers can show a graceful "unavailable" state rather than
 * crashing. Caches per destination so revisiting the same location/session
 * doesn't repeat the request.
 */
async function getDriveTimeMinutes(destLat, destLng) {
  if (destLat == null || destLng == null) return null;
  if (!googleRoutesApiKey) return null;

  if (!currentGpsPosition) {
    currentGpsPosition = await requestGpsPosition();
  }
  if (!currentGpsPosition) return null;

  const cacheKey = `${destLat},${destLng}`;
  if (cacheKey in driveTimeCache) return driveTimeCache[cacheKey];

  try {
    const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": googleRoutesApiKey,
        // Routes API requires explicitly asking for the fields you want —
        // unlike most REST APIs, it won't return them by default.
        "X-Goog-FieldMask": "routes.duration",
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: currentGpsPosition.lat, longitude: currentGpsPosition.lng } } },
        destination: { location: { latLng: { latitude: destLat, longitude: destLng } } },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
      }),
    });
    if (!res.ok) throw new Error(`Routes API returned ${res.status}`);
    const data = await res.json();
    // Duration comes back as a string like "7812s", not a plain number —
    // parseInt stops at the first non-digit character, giving just the
    // numeric seconds count.
    const durationStr = data.routes && data.routes[0] && data.routes[0].duration;
    const durationSeconds = durationStr ? parseInt(durationStr, 10) : null;
    const minutes = durationSeconds != null && !Number.isNaN(durationSeconds) ? Math.round(durationSeconds / 60) : null;
    driveTimeCache[cacheKey] = minutes;
    return minutes;
  } catch (err) {
    console.error("Drive time lookup failed:", err);
    driveTimeCache[cacheKey] = null;
    return null;
  }
}

let currentDetailChart = null;
let selectedCardEl = null;
let currentSelectedWindow = null;

// parseNaive comes from charts.js (loaded before this file).

function fmtNaive(ms, opts) {
  const d = new Date(ms);
  return new Intl.DateTimeFormat([], { timeZone: "UTC", ...opts }).format(d);
}

function hourOf(ms) {
  return new Date(ms).getUTCHours();
}

function dateOnly(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Session timestamps (w.from/w.to) use the same "naive local time treated as
// UTC" convention as everything else in this app (see parseNaive in
// charts.js) — they're NOT real UTC instants. To compare one against the
// browser's actual current time, re-interpret those same wall-clock digits
// as the browser's own local time instead (matching the same assumption
// app.js already relies on: the viewer's browser is in the same timezone
// the data represents, i.e. Melbourne).
function naiveMsToLocalDate(ms) {
  const d = new Date(ms);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

// Time-of-day / duration arithmetic, all working in minutes-since-midnight.
// Intermediate results are kept unwrapped (can go negative or past 1440) so a
// chain of subtractions that crosses midnight still produces a sensible answer —
// wrapping only happens at the point a value is displayed as a clock time.
function timeToMinutes(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function minutesToClock(mins) {
  const wrapped = ((Math.round(mins) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function minutesToDuration(mins) {
  const rounded = Math.round(mins);
  const sign = rounded < 0 ? "-" : "";
  const abs = Math.abs(rounded);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function computeSchedule(loc, launchStr, homeByStr, driveMinutes) {
  const launch = timeToMinutes(launchStr);
  const homeBy = timeToMinutes(homeByStr);
  if (launch == null || homeBy == null || !loc) return null;

  const setUp = timeToMinutes(loc.setUp) || 0;
  const timeToSpot = timeToMinutes(loc.timeToSpot) || 0;
  const packUp = timeToMinutes(loc.packUp) || 0;
  const timeFromSpot = timeToMinutes(loc.timeFromSpot) || 0;

  const arrive = launch - setUp;
  const fishAt = launch + timeToSpot;

  // Drive time comes from a live routing lookup now, not a stored field —
  // it can genuinely be unavailable (GPS denied, no token configured, a
  // failed request). Rather than fail the whole schedule, still show the
  // parts that don't depend on it.
  if (driveMinutes == null) {
    return {
      arrive: minutesToClock(arrive),
      launch: minutesToClock(launch),
      fishAt: minutesToClock(fishAt),
      homeBy: minutesToClock(homeBy),
      driveTimeUnavailable: true,
    };
  }

  const leaveHome = arrive - driveMinutes;
  const driveHome = homeBy - driveMinutes;
  const headBack = driveHome - packUp - timeFromSpot;
  const fishingTimeMins = headBack - fishAt;

  return {
    leaveHome: minutesToClock(leaveHome),
    arrive: minutesToClock(arrive),
    launch: minutesToClock(launch),
    fishAt: minutesToClock(fishAt),
    headBack: minutesToClock(headBack),
    driveHome: minutesToClock(driveHome),
    homeBy: minutesToClock(homeBy),
    fishingTime: minutesToDuration(fishingTimeMins),
    fishingTimeNegative: fishingTimeMins < 0,
    driveMinutes,
  };
}

function persistTripTimes() {
  const launch = document.getElementById("launchTime").value;
  const homeBy = document.getElementById("homeBy").value;
  localStorage.setItem(TRIP_TIMES_STORAGE_KEY, JSON.stringify({ launch, homeBy }));
}

let scheduleRenderToken = 0;

async function renderSchedule() {
  const container = document.getElementById("scheduleContainer");
  if (!currentSelectedWindow) {
    container.innerHTML = "";
    return;
  }

  // Incremented on every call — lets a slow drive-time lookup detect it's
  // been superseded by a newer render (a different session clicked, or
  // Launch/Home By changed again) and discard its stale result instead of
  // overwriting the UI after the fact.
  const myToken = ++scheduleRenderToken;

  const loc = allLocations.find((l) => l.name === currentSelectedWindow.locationName && l.type === currentSelectedWindow.type);
  const launchStr = document.getElementById("launchTime").value;
  const homeByStr = document.getElementById("homeBy").value;

  if (!launchStr || !homeByStr) {
    container.innerHTML = `<p class="footnote" style="margin:14px 0 0;text-align:left;">Set Launch Time and Home By above to see a full trip schedule for this location.</p>`;
    return;
  }

  container.innerHTML = `<p class="footnote" style="margin:14px 0 0;text-align:left;">Calculating drive time…</p>`;

  const driveMinutes = await getDriveTimeMinutes(loc ? loc.lat : null, loc ? loc.lng : null);

  if (myToken !== scheduleRenderToken) return; // superseded — a newer render already started

  const schedule = computeSchedule(loc, launchStr, homeByStr, driveMinutes);

  if (!schedule) {
    container.innerHTML = `<p class="footnote" style="margin:14px 0 0;text-align:left;">Set Launch Time and Home By above to see a full trip schedule for this location.</p>`;
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
    <div class="schedule-fishing-time ${schedule.fishingTimeNegative ? "negative" : ""}" id="fishingTimeToggle" role="button" tabindex="0">
      Fishing time: <strong>${schedule.fishingTime}</strong>
      <span class="schedule-toggle-hint" id="scheduleToggleHint">▸ tap for times</span>
      ${schedule.fishingTimeNegative ? "<br>times don't add up, check Launch Time / Home By against this location's timings" : ""}
    </div>
    <div class="schedule-timeline collapsed" id="scheduleTimelineWrap">
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

  const toggle = document.getElementById("fishingTimeToggle");
  const wrap = document.getElementById("scheduleTimelineWrap");
  const hint = document.getElementById("scheduleToggleHint");
  const toggleFn = () => {
    const nowCollapsed = wrap.classList.toggle("collapsed");
    hint.textContent = nowCollapsed ? "▸ tap for times" : "▾ hide times";
    requestAnimationFrame(updateStickyOffset);
  };
  toggle.addEventListener("click", toggleFn);
  toggle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleFn(); }
  });
}

async function init() {
  // Loaded separately from the main data fetch, with its own error handling
  // — a missing/malformed settings file shouldn't break the rest of the
  // page, just leave the drive-time feature gracefully unavailable (same
  // behaviour as if the key were simply blank).
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

    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(LOC_FILTER_STORAGE_KEY) || "null");
    } catch {
      saved = null;
    }
    const allNames = allLocations.map((l) => l.name);
    if (Array.isArray(saved) && saved.length) {
      // Keep only saved selections that still exist, so a removed/renamed location
      // doesn't leave a phantom entry silently excluding nothing.
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
    if (Array.isArray(savedTypes) && savedTypes.length) {
      selectedTypes = new Set(savedTypes);
    } else {
      selectedTypes = new Set(["Kayak", "Land based"]);
    }

    if (!data.generatedAt) {
      document.getElementById("updated").textContent = "Not updated yet — waiting on the first scheduled run";
    } else {
      const dt = new Date(data.generatedAt);
      document.getElementById("updated").textContent = `Updated ${dt.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
    }
  } catch (err) {
    document.getElementById("updated").textContent = "Could not load data — has the site run its first update yet?";
    console.error(err);
    return;
  }

  renderLocationChips();
  renderTypeChips();
  document.getElementById("btnLocAll").addEventListener("click", () => {
    selectedLocations = new Set(allLocations.map((l) => l.name));
    persistSelectedLocations();
    renderLocationChips();
    render();
  });
  document.getElementById("btnLocNone").addEventListener("click", () => {
    selectedLocations = new Set();
    persistSelectedLocations();
    renderLocationChips();
    render();
  });

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
  document.getElementById("launchTime").addEventListener("input", () => {
    persistTripTimes();
    renderSchedule();
  });
  document.getElementById("homeBy").addEventListener("input", () => {
    persistTripTimes();
    renderSchedule();
  });

  document.getElementById("minCondition").addEventListener("input", render);
  document.getElementById("minHours").addEventListener("input", render);
  render();
  requestAnimationFrame(updateStickyOffset);
}

function persistSelectedLocations() {
  localStorage.setItem(LOC_FILTER_STORAGE_KEY, JSON.stringify(Array.from(selectedLocations)));
}

function renderLocationChips() {
  const container = document.getElementById("locationChips");
  container.innerHTML = "";
  // A location's name is no longer unique on its own (Kayak and Land based
  // entries share the same name) — dedupe so this filter shows one chip
  // per physical spot, not one per (name, type) combination.
  const seenNames = new Set();
  for (const loc of allLocations) {
    if (seenNames.has(loc.name)) continue;
    seenNames.add(loc.name);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "loc-chip" + (selectedLocations.has(loc.name) ? " active" : "");
    chip.textContent = loc.name;
    chip.addEventListener("click", () => {
      if (selectedLocations.has(loc.name)) {
        selectedLocations.delete(loc.name);
      } else {
        selectedLocations.add(loc.name);
      }
      persistSelectedLocations();
      chip.classList.toggle("active");
      render();
    });
    container.appendChild(chip);
  }
}

function persistSelectedTypes() {
  localStorage.setItem(TYPE_FILTER_STORAGE_KEY, JSON.stringify(Array.from(selectedTypes)));
}

function renderTypeChips() {
  const container = document.getElementById("typeChips");
  if (!container) return;
  container.innerHTML = "";
  for (const type of ["Kayak", "Land based"]) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "loc-chip type-chip" + (selectedTypes.has(type) ? " active" : "");
    chip.innerHTML = `${typeIconSvg(type, 14)} <span>${type}</span>`;
    chip.addEventListener("click", () => {
      if (selectedTypes.has(type)) {
        selectedTypes.delete(type);
      } else {
        selectedTypes.add(type);
      }
      persistSelectedTypes();
      chip.classList.toggle("active");
      render();
    });
    container.appendChild(chip);
  }
}

function computeWindowsForLocation(locRows, minCondition, minHours) {
  // Only "hourly forecast rows" — where Condition is populated — participate in run detection,
  // matching the Excel calc area's P9 FILTER(Conditions[...], Conditions[Condition]<>"")
  const filtered = locRows.filter((r) => r.Condition != null).sort((a, b) => a._t - b._t);
  const n = filtered.length;
  if (n === 0) return [];

  const AD = new Array(n).fill(0); // Run Hrs: consecutive qualifying-hour counter
  for (let i = 0; i < n; i++) {
    const cond = filtered[i].Condition;
    if (cond < minCondition) {
      AD[i] = 0;
      continue;
    }
    const prev = i > 0 ? filtered[i - 1] : null;
    const isConsecutiveHour = prev && filtered[i]._t - prev._t === 3600 * 1000;
    AD[i] = isConsecutiveHour && AD[i - 1] > 0 ? AD[i - 1] + 1 : 1;
  }

  const AE = new Array(n).fill(0); // Window Hrs: backward-filled final run length
  for (let i = n - 1; i >= 0; i--) {
    if (AD[i] === 0) {
      AE[i] = 0;
    } else if (i + 1 < n && AD[i + 1] === AD[i] + 1) {
      AE[i] = AE[i + 1];
    } else {
      AE[i] = AD[i];
    }
  }

  const windows = [];
  for (let i = 0; i < n; i++) {
    // A run's total length (AE[i]) is constant across every position within
    // it — it does NOT mean "hours remaining from here". So detecting a
    // genuine midnight continuation (there's real time left AFTER midnight,
    // worth its own next-day card) needs AE[i] - AD[i] > 0 specifically —
    // hours remaining past this exact point — not just AE[i] itself. Without
    // this, a run whose very last qualifying hour happens to land exactly on
    // midnight would spawn a zero-duration "session" on the next day, when
    // really the run simply ended right as the day began.
    const isMidnightContinuation = AD[i] > 1 && hourOf(filtered[i]._t) === 0 && AE[i] - AD[i] > 0;
    const isSegmentStart = AD[i] > 0 && AE[i] >= minHours && (AD[i] === 1 || isMidnightContinuation);
    if (!isSegmentStart) continue;

    // The run's TRUE start and end — not clipped to this segment's own day —
    // used for the displayed time range and the stats/tide summary on the
    // card, so a session spanning midnight shows the SAME full span and
    // matching figures on every day-card it appears on, rather than a
    // different partial range (and partial averages) per day.
    const trueFrom = filtered[i]._t - (AD[i] - 1) * 3600 * 1000;
    const naturalEnd = filtered[i]._t + (AE[i] - AD[i]) * 3600 * 1000;

    const hoursLabel = AE[i] - 1;

    windows.push({
      locationName: filtered[i]["Location Name"],
      type: filtered[i]["Type"],
      shore: filtered[i]["Shore"],
      // This segment's OWN day — i.e. which day-heading this particular
      // card sits under, and which day's full chart opens on click. Kept
      // separate from from/to (the session's true full span) specifically
      // so a midnight-continuation segment still shows up under ITS OWN
      // day, not silently regrouped under the day the session first began.
      dayAnchor: filtered[i]._t,
      from: trueFrom,
      to: naturalEnd,
      hoursLabel,
    });
  }
  return windows;
}

function average(rows, field, from, to) {
  const vals = rows.filter((r) => r._t >= from && r._t <= to && r[field] != null).map((r) => r[field]);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function tidesInWindow(rows, from, to) {
  const events = rows
    .filter((r) => r._t >= from && r._t <= to && (r["Tide Status"] === "High" || r["Tide Status"] === "Low"))
    .sort((a, b) => a._t - b._t)
    .map((r) => `${r["Tide Status"]} ${Number(r["Tide Height (m)"]).toFixed(2)}m @ ${fmtNaive(r._t, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })}`);
  if (events.length) return events.join(", ");

  // No High/Low event actually falls inside this window — describe the trend instead
  // (Incoming/Outgoing), taken from whichever row is closest to the window's start.
  let nearest = null, nearestDiff = Infinity;
  for (const r of rows) {
    if (r["Tide Status"] == null) continue;
    const diff = Math.abs(r._t - from);
    if (diff < nearestDiff) { nearestDiff = diff; nearest = r; }
  }
  return nearest ? nearest["Tide Status"] : "—";
}

const DAY_COLORS = [
  { bg: "#eaf2fb", accent: "#1f4e78", photoTint: "rgba(234,242,251,0.86)" }, // blue
  { bg: "#fef3e0", accent: "#b45309", photoTint: "rgba(254,243,224,0.86)" }, // amber
  { bg: "#e8f7ee", accent: "#15803d", photoTint: "rgba(232,247,238,0.86)" }, // green
  { bg: "#f3e8fd", accent: "#7c3aed", photoTint: "rgba(243,232,253,0.86)" }, // purple
  { bg: "#fde8ec", accent: "#be123c", photoTint: "rgba(253,232,236,0.86)" }, // rose
  { bg: "#e0f6f8", accent: "#0e7490", photoTint: "rgba(224,246,248,0.86)" }, // cyan
  { bg: "#fdf6e3", accent: "#a16207", photoTint: "rgba(253,246,227,0.86)" }, // olive
];

const CONDITION_COLORS = {
  5: "var(--cond-5)",
  4: "var(--cond-4)",
  3: "var(--cond-3)",
  2: "var(--cond-2)",
  1: "var(--cond-1)",
};

function conditionColor(avgValue) {
  if (avgValue == null) return "var(--cond-none)";
  const rounded = Math.min(5, Math.max(1, Math.round(avgValue)));
  return CONDITION_COLORS[rounded] || "var(--cond-none)";
}

// Measures the sticky graph panel's actual rendered height (varies: short placeholder
// text before any window is clicked, vs. a full chart afterward, and the chart's own
// height varies by viewport width) and exposes it as a CSS variable so the sticky day
// headings in the list below know exactly how far down to stick, without hardcoding
// a guessed pixel value that would drift out of sync on different screens.
function updateStickyOffset() {
  const panel = document.getElementById("detailPanel");
  if (!panel) return;
  const height = panel.getBoundingClientRect().height;
  document.documentElement.style.setProperty("--detail-panel-height", `${height}px`);
}

let stickyOffsetResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(stickyOffsetResizeTimer);
  stickyOffsetResizeTimer = setTimeout(updateStickyOffset, 150);
});

function selectWindow(w, cardEl) {
  if (selectedCardEl) selectedCardEl.classList.remove("selected");
  if (cardEl) {
    cardEl.classList.add("selected");
    selectedCardEl = cardEl;
  }
  currentSelectedWindow = w;

  // Full calendar day for this location — not just the qualifying window's hour
  // span — so the graph shows the whole day's context around the good window.
  // Uses dayAnchor (this card's OWN day), not from (the session's true
  // start, which for a midnight-continuation card would be the PREVIOUS
  // day) — clicking the card grouped under "Friday" should open Friday.
  const dayStart = dateOnly(w.dayAnchor);
  const dayRows = allRows
    .filter((r) => r["Location Name"] === w.locationName && dateOnly(r._t) === dayStart)
    .sort((a, b) => a._t - b._t);

  const placeholder = document.getElementById("detailPlaceholder");
  const canvas = document.getElementById("detailChart");

  if (dayRows.length === 0) {
    placeholder.textContent = "No data available for that day.";
    placeholder.style.display = "block";
    canvas.style.display = "none";
    if (currentDetailChart) { currentDetailChart.destroy(); currentDetailChart = null; }
    renderSchedule();
    requestAnimationFrame(updateStickyOffset);
    return;
  }

  placeholder.style.display = "none";
  canvas.style.display = "block";
  const matchedLoc = allLocations.find((l) => l.name === w.locationName && l.type === w.type);
  currentDetailChart = renderConditionsChart({
    canvas,
    rows: dayRows,
    sunTimes: sunTimesData[w.locationName] || [],
    existingChart: currentDetailChart,
    locationName: w.locationName,
    tideMaxObserved: matchedLoc ? matchedLoc.tideMaxObserved : null,
    moonPhases: moonPhasesData,
    minTideHeight: matchedLoc ? matchedLoc.minTideHeight : null,
  });
  renderSchedule();

  // Safety net: force Chart.js to re-measure after the browser has actually committed the
  // display:block change and settled layout — guards against the canvas being measured as
  // zero-size if this runs in the same paint tick as becoming visible (seen on some mobile
  // browsers, especially right after scrolling to reveal the panel).
  if (currentDetailChart) {
    requestAnimationFrame(() => {
      currentDetailChart && currentDetailChart.resize();
      updateStickyOffset();
    });
  }
}

function render() {
  const minCondition = Number(document.getElementById("minCondition").value) || 1;
  const minHours = Number(document.getElementById("minHours").value) || 1;

  const byLocation = {};
  for (const r of allRows) {
    const name = r["Location Name"];
    const type = r["Type"];
    if (!selectedLocations.has(name)) continue;
    if (!selectedTypes.has(type)) continue;
    // Keyed by (name, type) — the same physical location can now have both
    // a Kayak and a Land based entry, each with its own Condition scores
    // and its own qualifying windows, so they must not be mixed together.
    const key = `${name}::${type}`;
    (byLocation[key] || (byLocation[key] = [])).push(r);
  }

  let results = [];
  for (const key in byLocation) {
    const locRows = byLocation[key];
    const windows = computeWindowsForLocation(locRows, minCondition, minHours);
    for (const w of windows) {
      results.push({
        ...w,
        avgCondition: average(locRows, "Condition", w.from, w.to),
        avgFishingCondition: average(locRows, "Fishing Condition", w.from, w.to),
        avgTemp: average(locRows, "Temp Forecast (C)", w.from, w.to),
        avgWind: average(locRows, "Wind Forecast (km/h)", w.from, w.to),
        avgRain: average(locRows, "Rainfall Probability (%)", w.from, w.to),
        tides: tidesInWindow(locRows, w.from, w.to),
      });
    }
  }

  // SORT by {From, Location Name} ascending, matching the Excel SORT({4,1},{1,1})
  results.sort((a, b) => a.dayAnchor - b.dayAnchor || a.locationName.localeCompare(b.locationName));

  // Don't show sessions that have already finished — no point suggesting a
  // trip window that's already in the past.
  const nowLocal = new Date();
  results = results.filter((w) => naiveMsToLocalDate(w.to) >= nowLocal);

  const container = document.getElementById("windowsContainer");
  const emptyState = document.getElementById("emptyState");
  container.innerHTML = "";

  if (results.length === 0) {
    emptyState.textContent = selectedLocations.size === 0
      ? "No locations selected — pick some above to see qualifying windows."
      : "No sessions meet the criteria";
    emptyState.style.display = "block";
    container.style.display = "none";
    return;
  }
  emptyState.style.display = "none";
  container.style.display = "block";

  // Group by dayAnchor — this card's OWN day — not by from, which is now
  // the session's true full span and could be an earlier day than this
  // particular segment for a midnight-continuation card.
  const byDay = new Map();
  for (const w of results) {
    const dayKey = dateOnly(w.dayAnchor);
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey).push(w);
  }
  const dayKeys = Array.from(byDay.keys()).sort((a, b) => a - b);

  dayKeys.forEach((dayKey, dayIndex) => {
    const colors = DAY_COLORS[dayIndex % DAY_COLORS.length];

    const dayGroup = document.createElement("section");
    dayGroup.className = "day-group";

    const heading = document.createElement("h3");
    heading.className = "day-heading";
    heading.textContent = fmtNaive(dayKey, { weekday: "long", day: "numeric", month: "long" });
    heading.style.color = colors.accent;
    heading.style.borderBottomColor = colors.accent;
    dayGroup.appendChild(heading);

    // If the same (location, type) has more than one qualifying session
    // today (e.g. a morning window and a separate evening window), combine
    // them into ONE card listing every session. Keyed by location+type, not
    // location alone — a Kayak session and a Land based session at the same
    // spot on the same day are shown as SEPARATE cards, never merged.
    const byLocationThisDay = new Map();
    for (const w of byDay.get(dayKey)) {
      const key = `${w.locationName}::${w.type}`;
      if (!byLocationThisDay.has(key)) byLocationThisDay.set(key, []);
      byLocationThisDay.get(key).push(w);
    }

    for (const [, sessions] of byLocationThisDay) {
      const first = sessions[0];
      const card = document.createElement("div");
      card.className = "window-card";
      // Photo background (real photos of the actual activity, layered under
      // a tinted wash of that day's colour) replaces the old flat pastel
      // background + small corner icon — the whole tile now conveys type,
      // not just a badge in the corner.
      const photoUrl = first.type === "Kayak" ? "images/type-kayak.jpg" : "images/type-landbased.jpg";
      card.style.backgroundImage = `linear-gradient(${colors.photoTint}, ${colors.photoTint}), url(${photoUrl})`;
      card.style.backgroundSize = "cover";
      card.style.backgroundPosition = "center";
      card.style.backgroundRepeat = "no-repeat";
      card.style.borderLeft = `4px solid ${colors.accent}`;

      const sessionsHtml = sessions.map((w, idx) => {
        // Same-day sessions show a plain "18:00–23:00" range. A session
        // spanning midnight shows the SAME full true span on every day-card
        // it appears on, so each time needs its own weekday label too —
        // otherwise "18:00–02:00" looks like it runs backward, and a card
        // grouped under Friday showing a range that starts Thursday needs
        // that made explicit.
        const spansDays = dateOnly(w.from) !== dateOnly(w.to);
        const timeOpts = { hour: "2-digit", minute: "2-digit", hour12: false };
        const fromLabel = fmtNaive(w.from, timeOpts) + (spansDays ? ` ${fmtNaive(w.from, { weekday: "short" })}` : "");
        const toLabel = fmtNaive(w.to, timeOpts) + (spansDays ? ` ${fmtNaive(w.to, { weekday: "short" })}` : "");
        const timeRange = `${fromLabel} – ${toLabel}`;
        return `
        <div class="session-block" data-session-idx="${idx}">
          <div class="window-card-top">
            <div class="window-sub">${timeRange} · ${w.hoursLabel}h</div>
            <div class="badge-stack">
              <div class="badge-item">
                <div class="condition-badge" style="background:${conditionColor(w.avgCondition)}">
                  ${w.avgCondition != null ? w.avgCondition.toFixed(1) : "–"}
                </div>
                <div class="badge-label">Location</div>
              </div>
              <div class="badge-item">
                <div class="condition-badge" style="background:${conditionColor(w.avgFishingCondition)}">
                  ${w.avgFishingCondition != null ? w.avgFishingCondition.toFixed(1) : "–"}
                </div>
                <div class="badge-label">Fishing</div>
              </div>
            </div>
          </div>
          <div class="stat-grid">
            <div class="stat">
              <div class="label">Avg Temp</div>
              <div class="value">${w.avgTemp != null ? w.avgTemp.toFixed(1) + "°" : "–"}</div>
            </div>
            <div class="stat">
              <div class="label">Avg Wind</div>
              <div class="value">${w.avgWind != null ? Math.round(w.avgWind) + " km/h" : "–"}</div>
            </div>
            <div class="stat">
              <div class="label">Avg Rain</div>
              <div class="value">${w.avgRain != null ? Math.round(w.avgRain) + "%" : "–"}</div>
            </div>
          </div>
          <div class="window-tides">Tides: ${w.tides}</div>
        </div>`;
      }).join("");

      card.innerHTML = `
        <div class="window-card-header">
          <div>
            <div class="window-loc">${first.locationName}</div>
            <div class="window-sub" style="margin-bottom:8px;">${first.type || "–"} · shore ${first.shore || "–"}</div>
          </div>
        </div>
        ${sessionsHtml}
      `;

      // One click target for the whole card (heading + every session), not
      // per-session — every session in a merged card is the same calendar
      // day, so selectWindow's "full day" graph comes out identical no
      // matter which specific session triggered it. Uses the first session
      // as the representative window passed to selectWindow.
      card.addEventListener("click", () => selectWindow(sessions[0], card));

      dayGroup.appendChild(card);
    }

    container.appendChild(dayGroup);
  });
}

init();
