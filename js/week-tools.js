// week-tools.js
// Week Ahead and Live helpers: location/type/group filter chips, session windows, drive-time (Google Routes) and schedule calculations, and the graph gestures (hold tooltip, fullscreen, drag scroll).
// One of the shared scripts split out of the old charts.js. All of them share one global scope; each page loads
// only the ones it needs, in this order (checked by scripts/check-page-scripts.mjs).

const LOC_FILTER_STORAGE_KEY = "goodConditionsSelectedLocations";
const TYPE_FILTER_STORAGE_KEY = "goodConditionsSelectedTypes";
const GROUP_FILTER_STORAGE_KEY = "goodConditionsSelectedGroups";
const DIRECTION_FILTER_STORAGE_KEY = "goodConditionsSelectedDirections";
const THRESHOLDS_STORAGE_KEY = "goodConditionsThresholds";

// Locations without any Location Group assigned yet (or before this field
// existed at all) still need to be filterable/visible rather than
// silently disappearing — grouped under this pseudo-value alongside
// whatever real group names exist.
const UNGROUPED_LABEL = "Ungrouped";

// A location can belong to several groups at once (locationGroups is an
// array) — always returns a non-empty array, so every call site can just
// iterate/some() over it without a separate "no group" special case.
function locationGroupsOf(loc) {
  const groups = Array.isArray(loc.locationGroups) ? loc.locationGroups.filter((g) => g && g.trim()) : [];
  return groups.length ? groups : [UNGROUPED_LABEL];
}

/**
 * Fixed set of Direction filter tiles. Unlike Location Group (an open,
 * admin-managed list assigned by hand per location), Direction is always
 * exactly these four, and isn't assigned at all — it's derived straight
 * from the location's existing Shore setting (see locationsadmin.js's
 * SHORE_OPTIONS, which covers all 16 compass points, e.g. "NNE", "SSW").
 * A tile matches any shore whose name STARTS WITH that letter, so the
 * "N" tile also catches "NE", "NW", "NNE" and "NNW" — not just an exact
 * "N" shore reading.
 */
const CARDINAL_DIRECTIONS = ["N", "E", "S", "W"];

function shoreStartsWithDirection(shore, direction) {
  return typeof shore === "string" && shore.startsWith(direction);
}

/**
 * Facet filters (Type/Location Group/Shore Direction/Locations) are 3-state
 * per value — neutral, include or exclude — same convention as the Map's
 * own mark filters (markMatchesFilters, js/marks-tools.js): an active
 * include set requires a match (a location with none of the values
 * fails); an active exclude set requires no match (a location with none
 * of the values passes trivially); a facet with neither populated imposes
 * no restriction at all. facets AND together; values within one facet's
 * include/exclude combine with OR. `valueOrValues` may be a single value
 * (Type, Locations) or an array (Location Group, Shore Direction — a
 * location can carry several of each), letting one function serve both
 * shapes identically.
 */
function passesFacet(facet, valueOrValues) {
  if (!facet) return true;
  const values = Array.isArray(valueOrValues) ? valueOrValues : [valueOrValues];
  if (facet.include && facet.include.size > 0) {
    if (!values.some((v) => v && facet.include.has(v))) return false;
  }
  if (facet.exclude && facet.exclude.size > 0) {
    if (values.some((v) => v && facet.exclude.has(v))) return false;
  }
  return true;
}

/** Whether a location passes every current facet filter (Type/Group/Direction/Locations) — see passesFacet. */
function locationMatchesFacetFilters(loc, facetFilters) {
  if (!passesFacet(facetFilters.type, loc.type)) return false;
  if (!passesFacet(facetFilters.group, locationGroupsOf(loc))) return false;
  const matchingDirs = CARDINAL_DIRECTIONS.filter((d) => shoreStartsWithDirection(loc.shore, d));
  if (!passesFacet(facetFilters.direction, matchingDirs)) return false;
  if (!passesFacet(facetFilters.location, loc.name)) return false;
  return true;
}

/** A fresh, empty (neutral) facet filter set — every facet imposes no restriction, matching everything. */
function emptyFacetFilters() {
  return {
    type: { include: new Set(), exclude: new Set() },
    group: { include: new Set(), exclude: new Set() },
    direction: { include: new Set(), exclude: new Set() },
    location: { include: new Set(), exclude: new Set() },
  };
}

/**
 * Lifts whatever's saved under the four legacy facet keys into the new
 * {include, exclude} shape, preserving today's exact visible result so
 * upgrading never silently changes anyone's view:
 *   - Group/Direction were already "empty = match everything" opt-in tag
 *     filters — a straight lift, the saved array becomes the include set.
 *   - Type/Locations were "closed" lists (checked = shown; empty = show
 *     NOTHING) — excluding the complement of what's checked, computed
 *     against the values that exist right now, reproduces the identical
 *     visible set under the new "empty = show everything" convention. An
 *     absent key (never touched) migrates to neutral (empty/empty),
 *     matching today's true default of "everything selected".
 * Also passes a value through unchanged if it's already the new shape (an
 * {include, exclude} object rather than a plain array) — handles an
 * account whose other device already migrated and synced the new shape
 * down to this one.
 */
function migrateLegacyFacetFilters(allLocationNames) {
  function readJson(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  }
  function isNewShape(saved) {
    return !!saved && typeof saved === "object" && !Array.isArray(saved) && (Array.isArray(saved.include) || Array.isArray(saved.exclude));
  }
  function toSets(saved) {
    return { include: new Set(saved.include || []), exclude: new Set(saved.exclude || []) };
  }
  function liftOpenFacet(key) {
    const saved = readJson(key);
    if (isNewShape(saved)) return toSets(saved);
    return { include: new Set(Array.isArray(saved) ? saved : []), exclude: new Set() };
  }
  function liftClosedFacet(key, universe) {
    const saved = readJson(key);
    if (isNewShape(saved)) return toSets(saved);
    if (!Array.isArray(saved)) return { include: new Set(), exclude: new Set() };
    const included = new Set(saved.filter((v) => universe.includes(v)));
    const excluded = new Set(universe.filter((v) => !included.has(v)));
    return { include: included, exclude: excluded };
  }
  return {
    type: liftClosedFacet(TYPE_FILTER_STORAGE_KEY, ["Kayak", "Land based"]),
    group: liftOpenFacet(GROUP_FILTER_STORAGE_KEY),
    direction: liftOpenFacet(DIRECTION_FILTER_STORAGE_KEY),
    location: liftClosedFacet(LOC_FILTER_STORAGE_KEY, allLocationNames),
  };
}

function fmtNaive(ms, opts) {
  const d = new Date(ms);
  // hour12:false as the DEFAULT (not just something callers remember to
  // pass) — 24-hour time everywhere on this site now, per Oliver's own
  // request; opts can still override it if some future caller genuinely
  // needs 12-hour, but nothing should by default.
  return new Intl.DateTimeFormat([], { timeZone: "UTC", hour12: false, ...opts }).format(d);
}

function hourOf(ms) {
  return new Date(ms).getUTCHours();
}

function dateOnly(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Melbourne's daylight-saving start: on the first Sunday of October the wall clock jumps
// 02:00 -> 03:00, so hourly rows go 01:00, 03:00 with no 02:00 between them.
function isDstSkippedGap(prevMs, curMs) {
  if (curMs - prevMs !== 2 * 3600 * 1000) return false;
  const d = new Date(prevMs);
  return d.getUTCMonth() === 9 && d.getUTCDay() === 0 && d.getUTCDate() <= 7 && d.getUTCHours() === 1;
}

function computeWindowsForLocation(locRows, minCondition, minHours) {
  // Only "hourly forecast rows" — where Condition is populated — participate in run detection,
  // matching the Excel calc area's P9 FILTER(Conditions[...], Conditions[Condition]<>"")
  // Only genuinely hourly-aligned rows participate in run detection — the
  // whole AD/AE consecutive-hour algorithm below assumes each entry is
  // exactly one hour after the last. Observational readings can land at
  // arbitrary sub-hourly timestamps (e.g. :10, :23), and occasionally have
  // complete enough data to get a real Condition score — when that happens
  // between two otherwise-consecutive hourly points, it silently breaks the
  // "exactly one hour apart" check on both sides of it, splitting what
  // should be one continuous run into pieces despite every actual hourly
  // reading being perfectly fine. Filtering to minute===0 keeps run
  // detection on the intended hourly grid; it doesn't discard that reading
  // anywhere else (charts still show it, bucketed into its hour).
  const filtered = locRows
    .filter((r) => r.Condition != null && new Date(r._t).getUTCMinutes() === 0)
    .sort((a, b) => a._t - b._t);
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
    const isConsecutiveHour = prev && (filtered[i]._t - prev._t === 3600 * 1000 || isDstSkippedGap(prev._t, filtered[i]._t));
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
    // AE[i] counts qualifying HOURLY DATA POINTS, not clock-hours of
    // duration — a run of 3 points (e.g. 16:00, 17:00, 18:00) only spans 2
    // clock hours. The minimum-hours filter is meant to match what's
    // actually displayed (a genuine clock-duration threshold), so it checks
    // AE[i]-1 here, not AE[i] itself — otherwise a "min 3 hours" setting
    // would let a 2-hour session through, since it has 3 qualifying points.
    const isSegmentStart = AD[i] > 0 && AE[i] - 1 >= minHours && (AD[i] === 1 || isMidnightContinuation);
    if (!isSegmentStart) continue;

    // The run's TRUE start and end — not clipped to this segment's own day —
    // used for the displayed time range and the stats/tide summary on the
    // card, so a session spanning midnight shows the SAME full span and
    // matching figures on every day-card it appears on, rather than a
    // different partial range (and partial averages) per day.
    // Walk by row index, not by N x 1h, so a run across the DST-skipped hour still spans its real rows.
    const trueFrom = filtered[i - (AD[i] - 1)]._t;
    const naturalEnd = filtered[i + (AE[i] - AD[i])]._t;

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

function rangeOf(rows, field, from, to) {
  const vals = rows.filter((r) => r._t >= from && r._t <= to && r[field] != null).map((r) => r[field]);
  if (vals.length === 0) return null;
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

function maxOf(rows, field, from, to) {
  const vals = rows.filter((r) => r._t >= from && r._t <= to && r[field] != null).map((r) => r[field]);
  if (vals.length === 0) return null;
  return Math.max(...vals);
}

/**
 * The qualifying ("good") sessions for one location's rows, from now on —
 * same rules Week Ahead uses (computeWindowsForLocation with the saved
 * min-condition / min-hours thresholds, defaulting to 3 and 3), each with its
 * averages/ranges. Shared so the Location tab's pill tile lists exactly what
 * Week Ahead does.
 */
function computeQualifyingSessions(locRows, minCondition, minHours) {
  if (minCondition == null || minHours == null) {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(THRESHOLDS_STORAGE_KEY) || "null");
    } catch {
      saved = null;
    }
    if (minCondition == null) minCondition = Number(saved && saved.minCondition) || 3;
    if (minHours == null) minHours = Number(saved && saved.minHours) || 3;
  }
  const nowMs = nowInNaiveEncoding(); // same naive Melbourne wall-clock encoding as w.to
  const seenSpans = new Set();
  const sessions = [];
  for (const w of computeWindowsForLocation(locRows, minCondition, minHours)) {
    if (w.to < nowMs) continue; // already finished
    const spanKey = `${w.from}::${w.to}`;
    if (seenSpans.has(spanKey)) continue; // same session, different day-anchor duplicate
    seenSpans.add(spanKey);
    sessions.push({
      ...w,
      avgCondition: average(locRows, "Condition", w.from, w.to),
      avgFishingCondition: average(locRows, "Fishing Condition", w.from, w.to),
      tempRange: rangeOf(locRows, "Temp Forecast (C)", w.from, w.to),
      windRange: rangeOf(locRows, "Wind Forecast (km/h)", w.from, w.to),
      maxRain: maxOf(locRows, "Rainfall Probability (%)", w.from, w.to),
    });
  }
  return sessions;
}

/** One session chip (time, hours, Loc/Fish/Temp/Wind/Rain badges). Callers add their own click handler. */
function buildSessionChipElement(s) {
  const timeLabel = `${fmtNaive(s.from, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })}–${fmtNaive(s.to, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  const chip = document.createElement("div");
  chip.className = "weeknew-session-chip";
  chip.innerHTML = `
    <div class="weeknew-session-time">${timeLabel} · ${s.hoursLabel}h</div>
    <div class="badge-stack">
      <div class="badge-item">
        <div class="condition-badge" style="background:${conditionColor(s.avgCondition)}">${s.avgCondition != null ? s.avgCondition.toFixed(1) : "–"}</div>
        <div class="badge-label">Loc</div>
      </div>
      <div class="badge-item">
        <div class="condition-badge" style="background:${conditionColor(s.avgFishingCondition)}">${s.avgFishingCondition != null ? s.avgFishingCondition.toFixed(1) : "–"}</div>
        <div class="badge-label">Fish</div>
      </div>
      <div class="badge-item">
        <div class="condition-badge weeknew-range-badge" style="background:#ea580c">${s.tempRange ? `${Math.round(s.tempRange.min)}–${Math.round(s.tempRange.max)}°` : "–"}</div>
        <div class="badge-label">Temp</div>
      </div>
      <div class="badge-item">
        <div class="condition-badge weeknew-range-badge" style="background:#0ea5e9">${s.windRange ? `${Math.round(s.windRange.min)}–${Math.round(s.windRange.max)}` : "–"}</div>
        <div class="badge-label">Wind</div>
      </div>
      <div class="badge-item">
        <div class="condition-badge weeknew-range-badge" style="background:#64748b">${s.maxRain != null ? `${Math.round(s.maxRain)}%` : "–"}</div>
        <div class="badge-label">Rain</div>
      </div>
    </div>
  `;
  return chip;
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

function persistFacetFilter(key, facet) {
  Prefs.set(key, JSON.stringify({ include: [...facet.include], exclude: [...facet.exclude] }));
}

const FACET_STORAGE_KEYS = { type: TYPE_FILTER_STORAGE_KEY, group: GROUP_FILTER_STORAGE_KEY, direction: DIRECTION_FILTER_STORAGE_KEY, location: LOC_FILTER_STORAGE_KEY };
const FACET_LABELS = { type: "Type", group: "Location Group", direction: "Shore Direction", location: "Locations" };

function persistFacetFilters(facetFilters) {
  for (const facet of Object.keys(FACET_STORAGE_KEYS)) persistFacetFilter(FACET_STORAGE_KEYS[facet], facetFilters[facet]);
}

function persistThresholds() {
  const minCondition = document.getElementById("minCondition").value;
  const minHours = document.getElementById("minHours").value;
  Prefs.set(THRESHOLDS_STORAGE_KEY, JSON.stringify({ minCondition, minHours }));
}

/**
 * Which values are offered as chips for one facet inside the modal below,
 * cross-narrowed by the OTHER three facets' current picks (same "restrict
 * which chips are offered, don't touch what's actually selected" approach
 * this file always took) — Type is fixed and never narrowed (it never was);
 * Group/Direction/Locations are each narrowed by the other three.
 */
function facetCandidates(facet, allLocations, facetFilters) {
  if (facet === "type") return ["Kayak", "Land based"];
  if (facet === "group") {
    const seen = new Set();
    const out = [];
    for (const loc of allLocations) {
      if (!passesFacet(facetFilters.type, loc.type)) continue;
      const dirs = CARDINAL_DIRECTIONS.filter((d) => shoreStartsWithDirection(loc.shore, d));
      if (!passesFacet(facetFilters.direction, dirs)) continue;
      for (const g of locationGroupsOf(loc)) {
        if (!seen.has(g)) {
          seen.add(g);
          out.push(g);
        }
      }
    }
    return out;
  }
  if (facet === "direction") {
    return CARDINAL_DIRECTIONS.filter((d) =>
      allLocations.some((loc) => {
        if (!passesFacet(facetFilters.type, loc.type)) return false;
        if (!passesFacet(facetFilters.group, locationGroupsOf(loc))) return false;
        return shoreStartsWithDirection(loc.shore, d);
      })
    );
  }
  // location
  const seen = new Set();
  const out = [];
  for (const loc of allLocations) {
    if (!passesFacet(facetFilters.type, loc.type)) continue;
    if (!passesFacet(facetFilters.group, locationGroupsOf(loc))) continue;
    const dirs = CARDINAL_DIRECTIONS.filter((d) => shoreStartsWithDirection(loc.shore, d));
    if (!passesFacet(facetFilters.direction, dirs)) continue;
    if (!seen.has(loc.name)) {
      seen.add(loc.name);
      out.push(loc.name);
    }
  }
  return out;
}

function facetChipStateFor(facetFilters, facet, value) {
  const f = facetFilters[facet];
  if (f.include.has(value)) return "include";
  if (f.exclude.has(value)) return "exclude";
  return "neutral";
}

// showFacetCardPanel/showThresholdsModal themselves live in week.js, not here — the only pieces of
// this facet-filter system that reference week.js-only globals (pinnedOrder, togglePin,
// wireThresholdStepper), and this file is shared with pages (conditions.html, reports.html) that
// load js/week-tools.js without week.js. Everything above (facetCandidates, facetChipStateFor,
// FACET_LABELS) is generic and used by those functions from there.

// ============================================================================
// Shared trip-schedule infrastructure — lets Week Ahead offer the same
// "fishing time / drive time" calculation for a session, from the same
// Launch Time / Home By settings and the same live GPS + Google Routes
// lookup. (The storage key name below predates this file's current
// structure — kept as-is so anyone's already-saved times aren't reset.)
// ============================================================================

const TRIP_TIMES_STORAGE_KEY = "goodConditionsTripTimes";

// Loaded from config/settings.json at page load, in each page's own init()
// — kept in a SEPARATE file from the rest of the site's code specifically
// so it never gets overwritten when any of these scripts are updated. Set
// via the Settings page, not by hand-editing any file.
let googleRoutesApiKey = null;

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
 * doesn't repeat the request. Relies on a page-level googleRoutesApiKey
 * variable, set by each page's own init() after loading config/settings.json.
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

/**
 * Real drive time (minutes) between two arbitrary coordinate pairs, via
 * Google's Routes API — unlike getDriveTimeMinutes above (which always
 * uses the device's CURRENT GPS position as the origin), this takes both
 * ends explicitly. Used for "fishing spot → home" (live.js) — the origin
 * there is the matched location's own saved lat/lng, not wherever the
 * device happens to be standing right now. Returns null (not an
 * exception) for any failure, same convention as getDriveTimeMinutes.
 * Deliberately NOT merged into getDriveTimeMinutes itself — that
 * function's whole shape (only needing a destination, GPS-caching
 * currentGpsPosition) is specifically for "drive time from here", and
 * forcing a generic two-coordinate signature onto every caller of it
 * would mean re-passing the current GPS position at every existing call
 * site for no benefit.
 */
async function getDriveTimeBetweenCoords(originLat, originLng, destLat, destLng) {
  if (originLat == null || originLng == null || destLat == null || destLng == null) return null;
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
        destination: { location: { latLng: { latitude: destLat, longitude: destLng } } },
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
    console.error("Drive time between coordinates lookup failed:", err);
    return null;
  }
}

// Where Week Ahead's planned trips ("+ Fishing times" / "+ Home to home") are driven from: "gps" (the device's current
// position) or one of the signed-in person's homes (its id). One choice for every row, remembered and synced per
// account (Prefs key "tripOrigin"); picked with the "From" select in front of each row's buttons (week.js).
const TRIP_ORIGIN_STORAGE_KEY = "tripOrigin";

/** The origin in use: the saved choice while it's still valid, else the first home, else GPS. */
function currentTripOrigin() {
  let saved = null;
  try {
    saved = localStorage.getItem(TRIP_ORIGIN_STORAGE_KEY);
  } catch {
    saved = null;
  }
  if (saved === "gps" || myHomes.some((h) => h.id === saved)) return saved;
  return myHomes.length ? myHomes[0].id : "gps";
}

function setTripOrigin(origin) {
  Prefs.set(TRIP_ORIGIN_STORAGE_KEY, origin);
}

/** "GPS", or the chosen home's town — for the From select and planned-trip chips. */
function tripOriginLabel(origin) {
  if (origin === "gps") return "GPS";
  return homeLabel(myHomes.find((h) => h.id === origin));
}

/** Drive time (minutes) to a location from the chosen origin — the device's position (getDriveTimeMinutes) or the
 * chosen home (getDriveTimeBetweenCoords, cached per home and destination). */
const homeDriveTimeCache = {};
async function getTripDriveMinutes(destLat, destLng, origin = currentTripOrigin()) {
  if (destLat == null || destLng == null) return null;
  const home = origin === "gps" ? null : myHomes.find((h) => h.id === origin);
  if (!home) return getDriveTimeMinutes(destLat, destLng);
  const key = `${home.id}|${destLat},${destLng}`;
  if (!(key in homeDriveTimeCache)) {
    const minutes = await getDriveTimeBetweenCoords(home.lat, home.lng, destLat, destLng);
    homeDriveTimeCache[key] = minutes == null ? null : Math.round(minutes);
  }
  return homeDriveTimeCache[key];
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

const COMPUTED_SESSIONS_STORAGE_KEY = "goodConditionsComputedSessions";

/**
 * Turns a click-drag-release range on a location's own graph into a full
 * schedule, via the SAME computeSchedule() above — this only handles the
 * one extra step computeSchedule doesn't know about: which of its two
 * direct inputs (launch, homeBy) the drag's two endpoints actually
 * correspond to, which depends on which of the two arm buttons was used
 * to start this drag ("+ Fishing times" vs "+ Home to home" — see
 * week.js's onArmScheduleClick):
 *
 *   "fishing" mode — drag spans the actual time AT the fishing spot
 *   ([fishAt, headBack]). dragStartMs converts to launch directly
 *   (launch = fishAt − timeToSpot, no drive time needed); dragEndMs
 *   converts to homeBy but DOES need drive time (homeBy = headBack +
 *   packUp + timeFromSpot + driveMinutes).
 *
 *   "onsite" mode — drag spans leaving home to being back home
 *   ([leaveHome, homeBy]). dragEndMs IS homeBy directly, no conversion;
 *   dragStartMs needs drive time to become launch (launch = leaveHome +
 *   driveMinutes + setUp).
 *
 * Either way, exactly one endpoint is direct and one needs driveMinutes —
 * never both, never neither. Works entirely in absolute milliseconds
 * (not the wrapped minutes-since-midnight computeSchedule itself uses)
 * so a session that crosses midnight, or markers drawn days apart on a
 * multi-day chart, stay unambiguous — computeSchedule's HH:MM strings are
 * fine for a single instant read off a form, but lose which calendar day
 * they belong to, which matters here since results get positioned back
 * onto the actual timeline (buildComputedSessionMarkersPlugin).
 *
 * Every field below can independently end up null if it depends on drive
 * time and drive time is genuinely unavailable (GPS denied, no Google
 * Routes key configured, a failed lookup) — NOT an all-or-nothing failure,
 * since whichever endpoint IS direct (and everything computeSchedule
 * derives from it without needing drive time — e.g. arrive/fishAt from a
 * direct launch) still has a real answer worth showing.
 */
function computeScheduleFromDragRangeMs(mode, dragStartMs, dragEndMs, loc, driveMinutes) {
  const setUpMs = (timeToMinutes(loc.setUp) || 0) * 60000;
  const timeToSpotMs = (timeToMinutes(loc.timeToSpot) || 0) * 60000;
  const packUpMs = (timeToMinutes(loc.packUp) || 0) * 60000;
  const timeFromSpotMs = (timeToMinutes(loc.timeFromSpot) || 0) * 60000;
  const driveMs = driveMinutes == null ? null : driveMinutes * 60000;

  const launchMs = mode === "fishing" ? dragStartMs - timeToSpotMs : driveMs == null ? null : dragStartMs + driveMs + setUpMs;
  const homeByMs = mode === "fishing" ? (driveMs == null ? null : dragEndMs + packUpMs + timeFromSpotMs + driveMs) : dragEndMs;

  const arriveMs = launchMs == null ? null : launchMs - setUpMs;
  const fishAtMs = launchMs == null ? null : launchMs + timeToSpotMs;
  const driveHomeMs = homeByMs == null || driveMs == null ? null : homeByMs - driveMs;
  const headBackMs = driveHomeMs == null ? null : driveHomeMs - packUpMs - timeFromSpotMs;
  const leaveHomeMs = arriveMs == null || driveMs == null ? null : arriveMs - driveMs;
  const fishingTimeMins = headBackMs == null || fishAtMs == null ? null : (headBackMs - fishAtMs) / 60000;

  return {
    mode,
    dragStartMs,
    dragEndMs,
    leaveHomeMs,
    arriveMs,
    launchMs,
    fishAtMs,
    headBackMs,
    driveHomeMs,
    homeByMs,
    fishingTimeMins,
    fishingTimeNegative: fishingTimeMins != null && fishingTimeMins < 0,
    driveTimeUnavailable: driveMs == null,
  };
}

/**
 * Computed (drag-derived) sessions persist in localStorage — matching this
 * page's whole "weigh up different options" use case, this is meant to
 * survive a reload, not reset the moment the phone locks or the tab
 * closes. Pruned on load (not on every save) to whatever's still within
 * the last day — a computed session for a slot that's already well in
 * the past isn't useful to keep comparing against, and letting them pile
 * up indefinitely would eventually clutter every graph that touches an
 * old date range.
 */
function loadComputedSessions() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(COMPUTED_SESSIONS_STORAGE_KEY) || "null");
  } catch {
    saved = null;
  }
  if (!Array.isArray(saved)) return [];
  const cutoff = nowInNaiveEncoding() - 86400000;
  return saved.filter((r) => r && (r.homeByMs != null ? r.homeByMs : r.dragEndMs) >= cutoff);
}

function persistComputedSessions(list) {
  Prefs.set(COMPUTED_SESSIONS_STORAGE_KEY, JSON.stringify(list));
}

// Computed (drag-derived) sessions — shared globally across Week Ahead, the
// Map tab, and Map Live mode: a schedule computed on any one of them is the
// same underlying record (keyed by locationName+locationType), stored via
// loadComputedSessions/persistComputedSessions above, so it shows up on all
// three. Each page loads this once at init (`computedSessions =
// loadComputedSessions();`) and re-renders whatever it needs to after any
// change, via the onChanged callback threaded through the functions below.
let computedSessions = [];

// Which canvas is currently primed for a click-drag-release range
// selection — null when nothing is armed. Sets/cleared by
// onArmScheduleClick and wireSessionRangeSelect below; checked by BOTH the
// tooltip-hold gesture and any drag-to-pan/drag-to-scroll gesture so they
// can get out of the way while a session calculation is actually being
// dragged out. Shared globally (not per-page) so only one graph across the
// whole site is ever armed at a time.
let armedLocationName = null;

// "fishing" or "onsite" — which of the two arm buttons ("+ Fishing times" /
// "+ Home to home") was used to arm it. Picked fresh every time by which
// button is tapped, since which one makes sense can genuinely differ
// session to session — not a persisted setting.
let armedMode = null;

/**
 * Only ever ONE canvas armed at a time, across the whole site — arming a
 * new one disarms whichever was previously armed first. Tracks the actual
 * DOM elements (not just the location name) so it can strip the "armed"
 * visual state cleanly regardless of which page/row/chip they belonged to.
 * armedRow is whatever element should get the "armed-for-schedule" outline
 * class — a Week Ahead row, or a Map/Live chart frame — and may be null for
 * a caller with nothing suitable to outline. armedScrollWrap is whatever
 * scrollable ancestor should be locked (overflow/touch-action) for the
 * duration of the drag — Week Ahead's board, Map's/Live's own chart
 * scroller, or null where there's nothing to lock (e.g. Map's desktop view,
 * which never scrolls in the first place).
 */
let armedRow = null;
let armedChip = null;
let armedCanvas = null;
let armedScrollWrap = null;

function disarmSchedule() {
  if (armedRow) armedRow.classList.remove("armed-for-schedule");
  if (armedChip) armedChip.classList.remove("armed");
  // Restored to "" (the CSS default, effectively "auto") rather than left
  // at "none" — an unarmed canvas should scroll normally again, same as it
  // always could before this row/graph was ever armed.
  if (armedCanvas) armedCanvas.style.touchAction = "";
  // touch-action alone on the canvas turned out not to be enough on real
  // phones — Week Ahead's mobile layout rotates the whole <body> -90deg
  // (the force-landscape trick in index.html), and under that
  // transform the browser's own touch-action-based scroll-vs-gesture
  // decision doesn't reliably line up with the canvas the person is
  // actually touching (same rotated-coordinate-space class of issue as
  // xValFromEvent's own comment below). Directly locking the scroll
  // CONTAINER itself — overflow:hidden, which blocks user-driven scrolling
  // outright regardless of touch-action — is a harder guarantee that
  // doesn't depend on that logic working correctly. scrollLeft/scrollTop
  // are preserved while hidden and restored the instant overflow goes back
  // to auto, so this doesn't visibly move anything, just freezes it in
  // place for the duration of the drag.
  if (armedScrollWrap) {
    armedScrollWrap.style.overflow = "";
    armedScrollWrap.style.touchAction = "";
  }
  armedLocationName = null;
  armedMode = null;
  armedRow = null;
  armedChip = null;
  armedCanvas = null;
  armedScrollWrap = null;
}

/**
 * Arms a canvas for the click-arm-then-drag flow (see wireSessionRangeSelect
 * just below for the drag half) — triggered by one of the two "+ Fishing
 * times" / "+ Home to home" buttons at the top of a location's session
 * list (mode is just whichever of those two was clicked), NOT by tapping
 * an individual qualifying-session chip. Arming isn't tied to any
 * particular session's time window, so there's nothing to scroll to here;
 * it just readies THIS chart for whatever range the person drags out next,
 * wherever they're currently looking.
 *
 * Sets this canvas's touch-action to "none" as part of arming — on a touch
 * device, the browser's native "drag on a scrollable area pans it"
 * behavior is decided from touch-action, not from whether JS later calls
 * preventDefault(), so this has to happen here (synchronously, at arm
 * time) rather than only inside wireSessionRangeSelect's own pointerdown
 * handler, which by itself was consistently losing the very first touch of
 * a drag to native scrolling.
 *
 * getRowChart is a () => chart closure rather than the chart directly,
 * because at the moment this listener is attached, the chart may not exist
 * yet on some callers (Week Ahead's deferred/lazy row rendering) — reading
 * it lazily always gets whatever the CURRENT chart is. row is the element
 * to add the "armed-for-schedule" outline class to (null if the caller has
 * nothing suitable — see disarmSchedule's comment). scrollWrap is the
 * scrollable ancestor to lock for the duration of the drag (null if there
 * isn't one to worry about).
 */
function onArmScheduleClick(loc, row, btn, mode, getRowChart, canvas, scrollWrap) {
  if (armedLocationName === loc.name && armedMode === mode) {
    // Tapping the already-armed row's own button again (the SAME mode)
    // is a cancel, not a re-arm — matches the hold-to-arm tooltip's own
    // "hold again to turn it back off" convention elsewhere on this site.
    disarmSchedule();
    return;
  }
  // Covers both "arming a fresh row" and "switching this row's OWN mode"
  // (tapping the other button while already armed) — either way, start
  // clean rather than trying to patch the previous armed state in place.
  disarmSchedule();
  armedLocationName = loc.name;
  armedMode = mode;
  armedRow = row || null;
  armedChip = btn;
  armedCanvas = canvas;
  armedScrollWrap = scrollWrap || null;
  if (armedRow) armedRow.classList.add("armed-for-schedule");
  btn.classList.add("armed");
  canvas.style.touchAction = "none";
  // See disarmSchedule's comment for why the scroll container itself
  // (not just this canvas) gets locked — belt-and-suspenders against the
  // rotated-mobile-layout touch-action quirk.
  if (armedScrollWrap) {
    armedScrollWrap.style.overflow = "hidden";
    armedScrollWrap.style.touchAction = "none";
  }
}

/**
 * The actual click-drag-release gesture, wired to a canvas by whichever
 * page owns it (Week Ahead wires one per row; Map/Live wire their own
 * single canvas) — each call only ever acts when armedLocationName matches
 * THIS canvas's own location, so an unarmed canvas behaves completely
 * normally (tooltip-hold, board/scroll pan) regardless of some OTHER
 * canvas being armed elsewhere.
 *
 * Should be registered before any tooltip-hold/drag-to-pan listener on the
 * same canvas so it gets first look at every pointer event:
 * stopImmediatePropagation() below prevents those from ever seeing that
 * event once armed. Three gestures (hold-to-tooltip, drag-to-pan,
 * drag-to-plan) can't coexist as three independent listeners on the same
 * surface, so arming makes this canvas swallow events for its own gesture
 * and nothing else gets a turn until it's disarmed again.
 *
 * stopImmediatePropagation alone isn't enough on a touch device, though:
 * mobile browsers decide whether a touch gesture is a native scroll BEFORE
 * JS's own event handlers necessarily get a meaningful chance to stop it,
 * based on the touched element's CSS touch-action, not on preventDefault()
 * alone. onArmScheduleClick sets this canvas's touch-action to "none" the
 * moment it arms (and disarmSchedule restores it), so a touch-drag here
 * never gets interpreted as "scroll sideways" in the first place — this is
 * genuinely necessary in addition to, not instead of, the
 * stopImmediatePropagation/preventDefault calls below.
 *
 * dragPreview is a small mutable {hoverXVal, dragStartXVal} object — see
 * buildSessionDragPreviewPlugin (js/chart-render.js) for how it's actually
 * drawn. Owned by whichever caller built this chart, passed in here so
 * this function can update it live and the plugin can read it live,
 * without either side needing to know about Chart.js internals or
 * re-create anything mid-gesture.
 *
 * onComputed is called after a completed drag successfully computes and
 * stores a session (Week Ahead passes renderWeekView, Map/Live pass their
 * own re-render function) — there's no single shared "redraw everything"
 * entry point across pages, so each caller supplies its own.
 *
 * getChart/getLoc are () => value getters, not fixed values, for the same
 * reason wireHoldToShowTooltip takes a getChart getter (see its own
 * comment): Week Ahead builds a fresh canvas+chart per row so a fixed
 * value would be fine there, but the Map tab and Map Live mode wire this
 * ONCE against their one persistent <canvas> (destroying/recreating the
 * Chart.js instance, and switching which location it shows, without ever
 * replacing the canvas element) — wiring per-render there would stack up
 * duplicate listeners, exactly like wireHoldToShowTooltip's own case.
 * Week Ahead's call site just passes trivial getters (() => rowChart,
 * () => loc) since those never change for that row's lifetime anyway.
 */
function wireSessionRangeSelect(getChart, canvas, getLoc, dragPreview, onComputed) {
  let dragStartXVal = null;

  canvas.addEventListener("pointerdown", (e) => {
    const loc = getLoc();
    const chart = getChart();
    if (!loc || !chart || armedLocationName !== loc.name) return; // not this canvas's turn — let tooltip-hold/board-pan handle it normally
    e.stopImmediatePropagation();
    e.preventDefault();
    dragStartXVal = xValFromEvent(chart, e);
    dragPreview.dragStartXVal = dragStartXVal;
    dragPreview.hoverXVal = dragStartXVal;
    chart.draw();
  });

  // Fires on every hover, not just while actually dragging (no button
  // pressed yet) — this is the "hovering over the armed graph shows the
  // time under the mouse" half of the gesture, before any press has
  // happened. Once a drag IS in progress (dragStartXVal set), the same
  // updated hoverXVal is also what the plugin uses as the live end of the
  // shaded range.
  canvas.addEventListener("pointermove", (e) => {
    const loc = getLoc();
    const chart = getChart();
    if (!loc || !chart || armedLocationName !== loc.name) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    dragPreview.hoverXVal = xValFromEvent(chart, e);
    chart.draw();
  });

  canvas.addEventListener("pointerup", (e) => {
    const loc = getLoc();
    const chart = getChart();
    if (!loc || !chart || armedLocationName !== loc.name || dragStartXVal == null) return;
    e.stopImmediatePropagation();
    const dragEndXVal = xValFromEvent(chart, e);
    const startMs = Math.min(dragStartXVal, dragEndXVal);
    const endMs = Math.max(dragStartXVal, dragEndXVal);
    const modeUsed = armedMode; // captured before disarmSchedule() clears it below
    dragStartXVal = null;
    dragPreview.dragStartXVal = null;
    dragPreview.hoverXVal = null;
    disarmSchedule();
    // A tap with no real drag (start === end, or too close to mean
    // anything) isn't a range — treat it as "changed my mind", not as a
    // zero-length session.
    if (endMs - startMs < 60000) {
      chart.draw(); // clears the now-stale preview shading/label
      return;
    }
    computeAndStoreSession(loc, startMs, endMs, modeUsed, onComputed);
  });

  canvas.addEventListener("pointercancel", () => {
    dragStartXVal = null;
    dragPreview.dragStartXVal = null;
    dragPreview.hoverXVal = null;
    const chart = getChart();
    if (chart) chart.draw();
  });
}

/**
 * Resolves live drive time (GPS + Google Routes, above), converts the drag
 * range into a full schedule for whichever arm button started this drag
 * ("+ Fishing times" vs "+ Home to home" — see onArmScheduleClick), stores
 * it, and calls onChanged so the caller can re-render however it needs to.
 *
 * Stores BOTH locationName and locationType — a location can have separate
 * Kayak and Land based entries sharing the same name but different
 * setUp/timeToSpot/packUp/timeFromSpot values, so a schedule computed for
 * one literally isn't correct for the other; scoping by name alone would
 * show the exact same computed markers on both of that location's rows.
 */
async function computeAndStoreSession(loc, dragStartMs, dragEndMs, mode, onChanged) {
  const origin = currentTripOrigin(); // the "From" choice — GPS or one of their homes
  const driveMinutes = await getTripDriveMinutes(loc.lat, loc.lng, origin);
  const schedule = computeScheduleFromDragRangeMs(mode, dragStartMs, dragEndMs, loc, driveMinutes);
  const record = {
    id: `${loc.name}|${loc.type}|${dragStartMs}|${Date.now()}`,
    locationName: loc.name,
    locationType: loc.type,
    originLabel: tripOriginLabel(origin), // shown on the chip: where its drive time was worked out from
    ...schedule,
  };
  computedSessions.push(record);
  persistComputedSessions(computedSessions);
  if (typeof onChanged === "function") onChanged();
}

function removeComputedSession(id, onChanged) {
  computedSessions = computedSessions.filter((r) => r.id !== id);
  persistComputedSessions(computedSessions);
  if (typeof onChanged === "function") onChanged();
}

/** The "From" select in front of a location's "+ Fishing times" / "+ Home to home" buttons: GPS or one of the
 * signed-in person's homes (by town). One choice site-wide — changing any select saves it and updates them all. */
function buildTripOriginSelect() {
  const select = document.createElement("select");
  select.className = "weeknew-trip-origin";
  select.setAttribute("aria-label", "Work out trip times from");
  select.title = "Where drive times are worked out from";
  fillTripOriginSelect(select);
  select.addEventListener("change", () => {
    setTripOrigin(select.value);
    refreshTripOriginSelects();
  });
  return select;
}

function fillTripOriginSelect(select) {
  const origin = currentTripOrigin();
  const options = [...myHomes.map((h) => ({ value: h.id, label: homeLabel(h) })), { value: "gps", label: "GPS" }];
  select.innerHTML = options.map((o) => `<option value="${escapeHtml(o.value)}">From: ${escapeHtml(o.label)}</option>`).join("");
  select.value = origin;
}

/** Re-labels and re-selects every From select on the page (after a change, or once home names have been looked up). */
function refreshTripOriginSelects() {
  document.querySelectorAll(".weeknew-trip-origin").forEach(fillTripOriginSelect);
}

/**
 * One chip for an already-computed (drag-derived) session — full text
 * breakdown of every schedule instant that resolved (see
 * computeScheduleFromDragRangeMs; a null field is simply skipped, not
 * shown as a blank/placeholder), plus a remove button. Deliberately plain
 * text here rather than icons — the icon+time compact treatment lives on
 * the chart itself (buildComputedSessionMarkersPlugin); repeating icons in
 * an already-narrow sidebar/panel column would mean wrapping constantly.
 *
 * onChanged is called after the remove button removes this session (same
 * per-caller re-render callback as computeAndStoreSession above).
 */
function buildComputedSessionChip(record, onChanged) {
  const chip = document.createElement("div");
  chip.className = "weeknew-computed-session";
  const fmt = (ms) => fmtNaive(ms, { hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = SCHEDULE_INSTANT_DISPLAY.filter(({ key }) => record[key] != null).map(({ key, label }) => `${label} ${fmt(record[key])}`);
  const modeLabel = record.mode === "fishing" ? "Fishing time" : "Home to home";
  const fromLabel = record.originLabel ? ` · from ${escapeHtml(record.originLabel)}` : "";
  chip.innerHTML = `
    <div class="weeknew-session-time">${modeLabel}${fromLabel}</div>
    <div class="weeknew-computed-session-line">${parts.join(" · ")}</div>
    ${record.driveTimeUnavailable ? `<div class="weeknew-computed-session-note">Drive time unavailable — showing what could be calculated without it.</div>` : ""}
    <button type="button" class="weeknew-computed-session-remove" aria-label="Remove this planned session">×</button>
  `;
  chip.querySelector(".weeknew-computed-session-remove").addEventListener("click", (e) => {
    e.stopPropagation();
    removeComputedSession(record.id, onChanged);
  });
  return chip;
}

/**
 * Replaces Chart.js's default "tap anywhere to show the tooltip" behavior
 * (disabled per-chart via the chart's own disableBuiltinEvents option —
 * see renderConditionsChart) with a hold-to-show gesture: a quick tap
 * doesn't show anything until the tooltip has been explicitly turned on.
 * Behavior:
 *   - Hold (press and don't move) for 2 seconds: shows the tooltip at that
 *     point, and "arms" the chart so it stays responsive to quick taps.
 *   - While armed, a quick tap anywhere moves the tooltip to that point —
 *     ordinary tap-to-inspect, same as Chart.js's own default behavior,
 *     just gated behind the initial hold.
 *   - Holding for 2 seconds again disarms it and hides the tooltip,
 *     returning to the initial "tap does nothing" state.
 * A press that moves more than a few pixels before the hold completes is
 * treated as a scroll/pan gesture, not a hold, and cancels the timer —
 * useful on any page where this canvas might sit inside a scrollable
 * area, so a hold-timer firing while someone's actually trying to scroll
 * isn't exactly the wrong moment for a tooltip to pop up.
 *
 * Takes a getChart() FUNCTION rather than a fixed chart instance — some
 * callers (Live) reuse the same persistent <canvas> across repeated
 * renders (switching location, periodic refresh), destroying and
 * recreating the Chart.js instance each time while the canvas element
 * itself never changes; wiring this once in that case, against a getter
 * that always reads whatever the current chart is, avoids attaching a
/**
 * Finds the data index nearest to xVal, reading the chart's own logical
 * x-values directly rather than any screen-pixel-based lookup — needed
 * because getElementsAtEventForMode's own event-position resolution
 * breaks under a CSS transform on an ancestor (see xValFromEvent below
 * for the full explanation); computing this straight from the data
 * sidesteps that path entirely, and is equally correct wherever no
 * transform is involved too.
 */
function nearestIndexForXVal(chart, xVal) {
  const dataset = chart.data.datasets.find((d) => d.data && d.data.length);
  if (!dataset) return -1;
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < dataset.data.length; i++) {
    const pt = dataset.data[i];
    if (!pt || pt.x == null) continue;
    const dist = Math.abs(pt.x - xVal);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Builds a chart.tooltip.setActiveElements()-compatible array for every
 * visible dataset at a given data index — the same shape
 * getElementsAtEventForMode("index", {intersect:false}) would return, but
 * computed directly from the index rather than an event position, so it
 * works identically regardless of any CSS transform on the canvas.
 */
function elementsAtIndex(chart, index) {
  const elements = [];
  if (index < 0) return elements;
  chart.data.datasets.forEach((ds, datasetIndex) => {
    const meta = chart.getDatasetMeta(datasetIndex);
    if (!meta || meta.hidden) return;
    const pt = ds.data && ds.data[index];
    if (!pt || pt.y == null) return;
    elements.push({ datasetIndex, index });
  });
  return elements;
}

/**
 * Reads a pointer/mouse event's local X position on the given canvas,
 * preferring e.offsetX (the event's position in the TARGET element's own
 * local, pre-transform coordinate space — per spec, unaffected by any CSS
 * transform on an ancestor) over the
 * "e.clientX - canvas.getBoundingClientRect().left" pattern used
 * elsewhere on this site. Those two are equivalent for a normal,
 * untransformed canvas, but genuinely diverge under a rotation: Week
 * (graphs)' mobile force-landscape layout (style.css) rotates <body>
 * -90deg, and under that transform the canvas's internal drawing buffer
 * and its VISUAL (post-rotation) bounding rect end up with their width
 * and height axes effectively swapped — confirmed directly against a
 * live chart: canvas.width/height read ~4586×292 while
 * getBoundingClientRect() reported ~300×4598 for the same element. Any
 * "clientX - rect.left" computation silently produces a wildly wrong
 * value once that mismatch is in play, which is what caused the
 * crosshair (drawn from the chart's own logical coordinates, unaffected)
 * to show correctly while Chart.js's own tooltip box — positioned via
 * this same broken pixel math — did not.
 *
 * Falls back to the rect-based computation if offsetX isn't a usable
 * number — some mobile Safari versions have historically been
 * inconsistent about populating offsetX/offsetY on TOUCH-originated
 * PointerEvents specifically (reliable for mouse). The fallback is only
 * correct when nothing is rotated, but that's still strictly better than
 * silently producing NaN and showing nothing at all.
 */
function localXFromEvent(e, canvas) {
  if (typeof e.offsetX === "number" && !Number.isNaN(e.offsetX)) return e.offsetX;
  const rect = canvas.getBoundingClientRect();
  return e.clientX - rect.left;
}

function localYFromEvent(e, canvas) {
  if (typeof e.offsetY === "number" && !Number.isNaN(e.offsetY)) return e.offsetY;
  const rect = canvas.getBoundingClientRect();
  return e.clientY - rect.top;
}

function xValFromEvent(chart, e) {
  return chart.scales.x.getValueForPixel(localXFromEvent(e, chart.canvas));
}

/**
 * fresh set of duplicate listeners to that same canvas on every render.
 * Callers whose canvas genuinely is recreated each time (Week Ahead,
 * a fresh canvas per row) can just pass a trivial () => chart closure.
 *
 * opts.suppressQuickTap (default false): when true, a plain quick tap
 * NEVER does anything, even while armed from a previous hold. Normally
 * (every current caller — Live, Week Ahead, the Location tab) a quick
 * tap while armed moves the tooltip to the new position, matching
 * Chart.js's own default tap behavior — this exists as an opt-out for
 * some future page that genuinely wants a plain tap to be a no-op under
 * every circumstance, not because any page currently needs it.
 */
function wireHoldToShowTooltip(getChart, canvas, opts = {}) {
  const { suppressQuickTap = false } = opts;
  const HOLD_MS = 2000;
  const MOVE_CANCEL_PX = 10;
  let pressTimer = null;
  let pressStartX = 0;
  let pressStartY = 0;
  let armed = false;

  function elementsAt(e) {
    const chart = getChart();
    if (!chart) return [];
    const index = nearestIndexForXVal(chart, xValFromEvent(chart, e));
    return elementsAtIndex(chart, index);
  }

  function showTooltipAt(e) {
    const chart = getChart();
    if (!chart) return;
    const elements = elementsAt(e);
    if (elements.length === 0) return;
    chart.tooltip.setActiveElements(elements, { x: localXFromEvent(e, canvas), y: localYFromEvent(e, canvas) });
    // No opacity juggling needed — buildTooltipCrosshairPlugin draws the
    // whole tooltip itself, straight from getActiveElements(), so all
    // this needs to do is update which elements are active and repaint.
    // chart.draw() (not update()) is a direct, synchronous repaint with
    // no risk of Chart.js's own tooltip lifecycle interfering — safe to
    // skip update() here specifically because nothing about the chart's
    // actual DATA or scales is changing, only the tooltip's transient
    // active-elements state.
    chart.draw();
  }

  function hideTooltip() {
    const chart = getChart();
    if (!chart) return;
    chart.tooltip.setActiveElements([], { x: 0, y: 0 });
    chart.draw();
  }

  function clearPressTimer() {
    if (pressTimer != null) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  canvas.addEventListener("pointerdown", (e) => {
    pressStartX = e.clientX;
    pressStartY = e.clientY;
    clearPressTimer();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      if (armed) {
        armed = false;
        hideTooltip();
      } else {
        armed = true;
        showTooltipAt(e);
      }
    }, HOLD_MS);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (pressTimer == null) return;
    const dx = e.clientX - pressStartX;
    const dy = e.clientY - pressStartY;
    if (Math.sqrt(dx * dx + dy * dy) > MOVE_CANCEL_PX) clearPressTimer();
  });

  canvas.addEventListener("pointerup", (e) => {
    const firedAsHold = pressTimer == null;
    clearPressTimer();
    if (firedAsHold) return; // the timer callback above already handled this press
    if (suppressQuickTap) return; // a plain quick tap is a complete no-op here — see opts.suppressQuickTap above
    if (armed) showTooltipAt(e); // ordinary quick tap while armed — move the tooltip, same as Chart.js's own default tap behavior
    // else: not armed yet — a plain quick tap does nothing, exactly the suppression that was asked for.
  });

  canvas.addEventListener("pointercancel", clearPressTimer);
  canvas.addEventListener("pointerleave", clearPressTimer);
}

/**
 * Double-tap (or double-click, for free — the same detector handles mouse
 * pointers too) the element with id === targetId to toggle real browser
 * fullscreen on it. Used for "the frame that contains the graph(s)" on
 * both Week Ahead (#weekTimelineScroll) and Live (#liveChartFrame).
 *
 * Fullscreen + a genuine user gesture is also the only context in which
 * screen.orientation.lock() can ever succeed — neither API can fire
 * outside a real user gesture, which is why a page needing a landscape
 * view on load at all (Week Ahead) has to fall back to a CSS rotation
 * trick instead; this double-tap gives both APIs a real gesture to work
 * with, so the orientation lock attempted here has a genuine chance of
 * working, on top of fullscreen itself hiding the browser's own address
 * bar too (something no CSS trick can do).
 *
 * Double-tap is detected manually (two pointerup events close together in
 * both time and position) rather than relying on the browser's native
 * 'dblclick' event, which fires inconsistently for touch input across
 * browsers. touch-action:manipulation on the target (set below) disables
 * the browser's own native double-tap-to-zoom so it doesn't fire at the
 * same time as — or instead of — this.
 */
/** A touch phone held sideways (also used by week.js to shrink the graphs in landscape). */
function isLandscapePhone() {
  const touch = navigator.maxTouchPoints > 0;
  // 900 matches the site's own "is a phone" cut-off (isMobileDevice);
  // the short-viewport check keeps landscape tablets out.
  const phoneSized = Math.min(screen.width, screen.height) <= 900;
  return touch && phoneSized && window.innerWidth > window.innerHeight && window.innerHeight <= 600;
}

// options.fullscreenOnRotate (default true): turning the phone sideways puts the page into browser fullscreen.
// The Map tab passes false — it has no use for it, and in the installed app leaving fullscreen again left a
// gap the height of the browser bar along the bottom. (The site bar is still hidden in landscape, see applyImmersive.)
function setupFullscreenToggle(targetId, options = {}) {
  const target = document.getElementById(targetId);
  if (!target) return;
  const fullscreenOnRotate = options.fullscreenOnRotate !== false;
  target.style.touchAction = "manipulation";

  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  const DOUBLE_TAP_MS = 350;
  const DOUBLE_TAP_MAX_DIST = 30; // px — taps this far apart are two separate single taps, not a double-tap

  function isFullscreen() {
    return document.fullscreenElement === target || document.webkitFullscreenElement === target;
  }

  function anyFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  // `el` defaults to the graph frame; rotation may pick the whole page
  // instead (see onRotate below). `lockOrientation` is off for rotation-
  // triggered fullscreen — the person is already holding the phone
  // sideways, and a landscape lock would stop them rotating back to
  // portrait to leave fullscreen again. Resolves true if fullscreen began.
  async function enterFullscreen(el = target, lockOrientation = true) {
    try {
      if (el.requestFullscreen) await el.requestFullscreen();
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else return false;
    } catch (err) {
      return false; // fullscreen refused/unsupported — nothing further to do
    }
    // Best-effort only — genuinely works now (inside fullscreen + a user
    // gesture) on browsers that support it, but plenty don't (notably iOS
    // Safari never does) — silently ignored on failure, since the
    // fullscreen view itself is still a real win even without a true
    // orientation lock.
    if (lockOrientation && screen.orientation && screen.orientation.lock) {
      try {
        await screen.orientation.lock("landscape");
      } catch (err) {
        /* expected on unsupported browsers */
      }
    }
    return true;
  }

  function exitFullscreen() {
    if (screen.orientation && screen.orientation.unlock) {
      try {
        screen.orientation.unlock();
      } catch (err) {
        /* ignore */
      }
    }
    if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }

  target.addEventListener("pointerup", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return; // ignore right-click etc.
    // Ignore taps that landed on an actual control (buttons, steppers) —
    // someone double-tapping a button wants to activate the button twice,
    // not also toggle fullscreen underneath it.
    if (e.target.closest("button, .loc-pill, .loc-tile")) return;

    const now = Date.now();
    const dx = e.clientX - lastTapX;
    const dy = e.clientY - lastTapY;
    const isDoubleTap = now - lastTapTime < DOUBLE_TAP_MS && Math.sqrt(dx * dx + dy * dy) < DOUBLE_TAP_MAX_DIST;

    if (isDoubleTap) {
      lastTapTime = 0; // reset so an accidental third tap doesn't chain into another toggle
      if (isFullscreen()) exitFullscreen();
      else enterFullscreen();
    } else {
      lastTapTime = now;
      lastTapX = e.clientX;
      lastTapY = e.clientY;
    }
  });

  // Android's back button/gesture (and other OS-level exits) can leave
  // fullscreen without ever going through exitFullscreen() above — this
  // keeps the orientation lock in sync with whatever actually happened,
  // rather than assuming our own toggle is the only way fullscreen ends.
  const onFullscreenChange = () => {
    if (!isFullscreen() && screen.orientation && screen.orientation.unlock) {
      try {
        screen.orientation.unlock();
      } catch (err) {
        /* ignore */
      }
    }
  };
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);

  // Rotating a phone to landscape goes fullscreen (as if the graph had been
  // double-tapped); rotating back to portrait leaves it again. Browsers only
  // allow fullscreen from a user gesture, and a rotation isn't one — Chrome
  // still accepts it if the person touched the screen in the last few
  // seconds, otherwise the request is refused, so the next tap is used as
  // the gesture instead. iPhone Safari has no element fullscreen at all, so
  // nothing happens there. Landscape phone = coarse pointer + short viewport
  // (tablets and desktop windows are left alone).
  // Detected in JS rather than with a media query so it doesn't depend on
  // `pointer: coarse` / height cut-offs some phones don't match: a touch
  // device whose shorter physical side is phone-sized, held wider than tall.
  const landscapePhone = {
    get matches() {
      return isLandscapePhone();
    },
  };
  let lastLandscape = null;
  let armedTap = null;
  function disarmTap() {
    if (armedTap) document.removeEventListener("pointerup", armedTap, true);
    armedTap = null;
  }
  function rotationTarget() {
    return target.getClientRects().length > 0 ? target : document.documentElement;
  }
  // Real fullscreen often can't start from a rotation (see above), so
  // landscape ALSO applies a CSS "immersive" mode that hides the site bar
  // (and, on Week Ahead, the filters card) — the same extra room fullscreen
  // gives, on every browser including iPhone Safari.
  function applyImmersive() {
    document.documentElement.classList.toggle("landscape-immersive", landscapePhone.matches);
    window.dispatchEvent(new Event("resize")); // Week Ahead re-sizes its board to the space left
  }
  async function onRotate() {
    const now = landscapePhone.matches;
    if (now === lastLandscape) return; // resize fires constantly; only act on a real rotation
    lastLandscape = now;
    disarmTap();
    applyImmersive();
    if (landscapePhone.matches) {
      if (!fullscreenOnRotate || anyFullscreenElement()) return;
      const el = rotationTarget();
      if (await enterFullscreen(el, false)) return;
      armedTap = () => {
        disarmTap();
        if (landscapePhone.matches && !anyFullscreenElement()) enterFullscreen(rotationTarget(), false);
      };
      document.addEventListener("pointerup", armedTap, true);
    } else if (anyFullscreenElement()) {
      exitFullscreen();
    }
  }
  window.addEventListener("resize", onRotate);
  window.addEventListener("orientationchange", () => setTimeout(onRotate, 150)); // innerWidth/Height settle just after the event
  lastLandscape = landscapePhone.matches;
  if (lastLandscape) applyImmersive(); // page opened while already sideways
}

/**
 * Floating location "pill" on a graph frame (the Week Ahead phone layout's
 * name pill, made available to every graph on the site). Mirrors the text of
 * existing name/sub-line elements (so the pages' own code that sets those
 * doesn't change) and, if `tileIds` are given, moves those elements into a
 * tile that the pill's ⓘ button opens. The tile's background is the
 * Kayak/Land based photo — set with the returned setPhoto(type). The pill
 * lives inside the frame, so it stays visible in fullscreen too.
 */
function locationPhotoUrl(type) {
  return type === "Kayak" ? "images/type-kayak.jpg" : "images/type-landbased.jpg";
}

function mountLocationPill(frameId, { nameId, subId, tileIds = [] }) {
  const frame = document.getElementById(frameId);
  const nameSrc = document.getElementById(nameId);
  if (!frame || !nameSrc) return null;
  const subSrc = subId ? document.getElementById(subId) : null;

  const pill = document.createElement("div");
  pill.className = "loc-pill";
  pill.hidden = true;
  const text = document.createElement("div");
  const nameEl = document.createElement("div");
  nameEl.className = "loc-pill-name";
  const subEl = document.createElement("div");
  subEl.className = "loc-pill-sub";
  text.append(nameEl, subEl);
  pill.appendChild(text);
  frame.appendChild(pill);

  let tile = null;
  if (tileIds.length) {
    tile = document.createElement("div");
    tile.className = "loc-tile";
    tile.hidden = true;
    for (const id of tileIds) {
      const node = document.getElementById(id);
      if (node) tile.appendChild(node);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "loc-pill-details-btn";
    btn.textContent = "ⓘ";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", "Location details");
    btn.addEventListener("click", () => {
      tile.hidden = !tile.hidden;
      btn.setAttribute("aria-expanded", String(!tile.hidden));
      pill.classList.toggle("open", !tile.hidden);
    });
    pill.appendChild(btn);
    frame.appendChild(tile);
  }

  const sync = () => {
    const name = nameSrc.textContent.replace(/ /g, " ").trim();
    nameEl.textContent = name;
    subEl.textContent = subSrc ? subSrc.textContent.trim() : "";
    subEl.hidden = !subEl.textContent;
    pill.hidden = !name;
  };
  const observer = new MutationObserver(sync);
  const opts = { childList: true, characterData: true, subtree: true };
  observer.observe(nameSrc, opts);
  if (subSrc) observer.observe(subSrc, opts);
  sync();

  return {
    setPhoto(type) {
      if (tile) tile.style.setProperty("--tile-photo", `url(${locationPhotoUrl(type)})`);
    },
  };
}

/**
 * Click-and-drag-to-pan for desktop (mouse) — grab a horizontally
 * scrolling chart area anywhere and drag to scroll it, rather than
 * needing a trackpad/scrollbar. Filtered to e.pointerType === "mouse"
 * specifically — touch already has native drag-to-scroll on an
 * overflow-x:auto container, and re-doing it here too would double up
 * with (and likely fight) that, plus the hold-to-show-tooltip gesture on
 * the chart itself. A genuine click (not a drag) is left alone — this
 * only ever engages once the pointer has actually moved past a small
 * threshold, so a plain click/tap still reaches whatever it would
 * normally reach (hold-to-show-tooltip's own tap handling, the
 * double-tap-fullscreen detector).
 *
 * Shared (originally written for Week Ahead, week.js, which keeps
 * its own copy rather than switching to this one — moved here mainly so
 * the Location tab's own horizontally-scrolling graph, app.js, could use
 * it too without duplicating the logic a second time).
 */
function setupDragToScroll(scrollWrap) {
  const DRAG_THRESHOLD_PX = 6;
  let isDown = false;
  let draggedPastThreshold = false;
  let startX = 0;
  let startY = 0;
  let startScrollLeft = 0;
  let startScrollTop = 0;

  scrollWrap.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    isDown = true;
    draggedPastThreshold = false;
    startX = e.clientX;
    startY = e.clientY;
    startScrollLeft = scrollWrap.scrollLeft;
    startScrollTop = scrollWrap.scrollTop;
  });

  window.addEventListener("pointermove", (e) => {
    if (!isDown) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!draggedPastThreshold) {
      if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD_PX) return;
      draggedPastThreshold = true;
      scrollWrap.classList.add("chart-scroll-dragging");
    }
    e.preventDefault(); // stop text selection while actively dragging
    scrollWrap.scrollLeft = startScrollLeft - dx;
    scrollWrap.scrollTop = startScrollTop - dy;
  });

  function endDrag() {
    isDown = false;
    draggedPastThreshold = false;
    scrollWrap.classList.remove("chart-scroll-dragging");
  }
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
}
