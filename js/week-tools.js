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
// whatever real group names exist, both here and in renderGroupChips.
const UNGROUPED_LABEL = "Ungrouped";

// A location can belong to several groups at once (locationGroups is an
// array) — always returns a non-empty array, so every call site can just
// iterate/some() over it without a separate "no group" special case.
function locationGroupsOf(loc) {
  const groups = Array.isArray(loc.locationGroups) ? loc.locationGroups.filter((g) => g && g.trim()) : [];
  return groups.length ? groups : [UNGROUPED_LABEL];
}

/**
 * A set of tags matches the Location Group filter if the location carries
 * AT LEAST ONE of the currently selected groups — OR within the facet,
 * not AND. Location Group used to also do double duty for compass
 * direction (Eastern/Western/etc lived in the same flat group list),
 * which was the actual problem this replaced: AND-ing two region-style
 * groups together (e.g. "Port Phillip" + "Western Port") always produced
 * zero results, since a location normally sits in exactly one region.
 * Direction has since moved to its own facet (see directionsMatchFilter)
 * that's derived from the Shore setting instead, which is what actually
 * needed AND-against-region semantics — so Location Group itself can go
 * back to pure OR: checking "Port Phillip" and "Western Port" now sensibly
 * means "either bay", and stacking a Direction tile on top narrows THAT
 * combined result down to one shore, via the AND at the call site between
 * groupsMatchFilter(...) and directionsMatchFilter(...).
 *
 * An empty selection matches EVERYTHING — the opposite convention from
 * the Location/Type filters, where an empty set means "None was clicked,
 * hide everything". Those are simple set-membership filters (checking a
 * box includes a category); this is an opt-in tag filter, where checking
 * a box ADDS AN ACCEPTABLE OPTION rather than including a category — so
 * having nothing checked means no requirement has been added yet, not
 * that every possible requirement applies at once. Concretely: if this
 * treated an empty selection as "match nothing" (or defaulted every chip
 * to checked on load, mirroring Location/Type), a location would need to
 * carry a group that happens to be the only one that exists just to show
 * up on a fresh visit.
 */
function groupsMatchFilter(locGroups, selectedGroups) {
  if (selectedGroups.size === 0) return true;
  for (const g of selectedGroups) {
    if (locGroups.includes(g)) return true;
  }
  return false;
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
 * Direction filter matching — OR within the selection, same convention as
 * groupsMatchFilter: checking "N" and "E" together shows anything facing
 * a northern OR eastern shore, not locations that could somehow face
 * both. An empty selection matches everything, also matching
 * groupsMatchFilter's "no requirement added yet" convention.
 *
 * Location Group and Direction are deliberately kept as two SEPARATE
 * facets rather than merged into one list, specifically so they can be
 * ANDed against each other at the call site — groupsMatchFilter(...) &&
 * directionsMatchFilter(...) — giving "(Region A OR Region B) AND
 * (Direction N OR Direction E)" without the person needing to touch any
 * AND/OR toggle: OR-within-a-facet, AND-across-facets falls out of the
 * two functions simply being combined with &&.
 */
function directionsMatchFilter(shore, selectedDirections) {
  if (selectedDirections.size === 0) return true;
  for (const d of selectedDirections) {
    if (shoreStartsWithDirection(shore, d)) return true;
  }
  return false;
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

// Session timestamps (w.from/w.to) use the same "naive local time treated as
// UTC" convention as everything else in this app (see parseNaive above) —
// they're NOT real UTC instants. To compare one against the browser's
// actual current time, re-interpret those same wall-clock digits as the
// browser's own local time instead (matching the same assumption app.js
// already relies on: the viewer's browser is in the same timezone the data
// represents, i.e. Melbourne).
function naiveMsToLocalDate(ms) {
  const d = new Date(ms);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
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
  const nowLocal = new Date();
  const seenSpans = new Set();
  const sessions = [];
  for (const w of computeWindowsForLocation(locRows, minCondition, minHours)) {
    if (naiveMsToLocalDate(w.to) < nowLocal) continue; // already finished
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

function persistSelectedLocations(selectedLocations) {
  localStorage.setItem(LOC_FILTER_STORAGE_KEY, JSON.stringify(Array.from(selectedLocations)));
}

function persistSelectedTypes(selectedTypes) {
  localStorage.setItem(TYPE_FILTER_STORAGE_KEY, JSON.stringify(Array.from(selectedTypes)));
}

function persistSelectedGroups(selectedGroups) {
  localStorage.setItem(GROUP_FILTER_STORAGE_KEY, JSON.stringify(Array.from(selectedGroups)));
}

function persistSelectedDirections(selectedDirections) {
  localStorage.setItem(DIRECTION_FILTER_STORAGE_KEY, JSON.stringify(Array.from(selectedDirections)));
}

function persistThresholds() {
  const minCondition = document.getElementById("minCondition").value;
  const minHours = document.getElementById("minHours").value;
  localStorage.setItem(THRESHOLDS_STORAGE_KEY, JSON.stringify({ minCondition, minHours }));
}

// onChange is called after the toggle (with no arguments) so each caller
// can supply its own "re-render everything that depends on this filter"
// logic, rather than this function hardcoding a specific one.
//
// narrowByTypes/narrowByGroups/narrowByDirections are optional (callers
// pass what they have; not required for backward compatibility with any
// future caller that doesn't need cross-filtering) — when given, a
// location only gets a chip here if it matches the current Type filter
// AND matches the current Location Group filter (OR within that facet —
// see groupsMatchFilter) AND matches the current Direction filter (OR
// within that facet — see directionsMatchFilter). This only affects
// which chips are OFFERED, not what's actually selected — a location
// that disappears because its type/group/direction no longer matches
// stays in selectedLocations exactly as it was, so if the filter changes
// back, it reappears with its previous checked state rather than
// resetting.
function renderLocationChips(allLocations, selectedLocations, onChange, narrowByTypes, narrowByGroups, narrowByDirections) {
  const container = document.getElementById("locationChips");
  container.innerHTML = "";
  // A location's name is no longer unique on its own (Kayak and Land based
  // entries share the same name) — dedupe so this filter shows one chip
  // per physical spot, not one per (name, type) combination.
  const seenNames = new Set();
  for (const loc of allLocations) {
    if (narrowByTypes && !narrowByTypes.has(loc.type)) continue;
    if (narrowByGroups && !groupsMatchFilter(locationGroupsOf(loc), narrowByGroups)) continue;
    if (narrowByDirections && !directionsMatchFilter(loc.shore, narrowByDirections)) continue;
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
      persistSelectedLocations(selectedLocations);
      chip.classList.toggle("active");
      onChange();
    });
    container.appendChild(chip);
  }
}

function renderTypeChips(selectedTypes, onChange) {
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
      persistSelectedTypes(selectedTypes);
      chip.classList.toggle("active");
      onChange();
    });
    container.appendChild(chip);
  }
}

/**
 * Location Group filter chips — one per distinct group name currently in
 * use across allLocations (plus an "Ungrouped" chip for any location with
 * no groups at all, via locationGroupsOf(), so nothing becomes
 * unfilterable/invisible just because it predates this field or hasn't
 * been assigned a group yet). A location can belong to several groups at
 * once, so it contributes a chip candidate for EACH of its groups, not
 * just one. The set of AVAILABLE group names is managed separately on the
 * Settings page (config/location_groups.json, locationsadmin.js) — this
 * only shows groups actually assigned to at least one location right now,
 * same "derive what's shown from what's actually in use" approach
 * renderLocationChips already takes for individual locations.
 *
 * narrowByTypes/narrowByDirections (optional) restrict this to groups
 * that have at least one location matching the current Type filter AND
 * current Direction filter — same "narrow the offered chips, don't touch
 * what's actually selected" approach as renderLocationChips's own
 * narrowing params.
 */
function renderGroupChips(allLocations, selectedGroups, onChange, narrowByTypes, narrowByDirections) {
  const container = document.getElementById("groupChips");
  if (!container) return;
  container.innerHTML = "";
  const seenGroups = new Set();
  for (const loc of allLocations) {
    if (narrowByTypes && !narrowByTypes.has(loc.type)) continue;
    if (narrowByDirections && !directionsMatchFilter(loc.shore, narrowByDirections)) continue;
    for (const group of locationGroupsOf(loc)) {
      if (seenGroups.has(group)) continue;
      seenGroups.add(group);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "loc-chip" + (selectedGroups.has(group) ? " active" : "");
      chip.textContent = group;
      chip.addEventListener("click", () => {
        if (selectedGroups.has(group)) {
          selectedGroups.delete(group);
        } else {
          selectedGroups.add(group);
        }
        persistSelectedGroups(selectedGroups);
        chip.classList.toggle("active");
        onChange();
      });
      container.appendChild(chip);
    }
  }
}

/**
 * Direction filter chips — always exactly CARDINAL_DIRECTIONS (unlike
 * renderGroupChips, which derives its chip list from whatever groups are
 * actually assigned by hand). A tile is only offered if at least one
 * currently-visible location's Shore starts with that letter, same
 * "don't offer a chip that can't match anything right now" approach as
 * the other chip renderers — narrowByTypes/narrowByGroups apply first,
 * same as renderGroupChips's own narrowing params.
 */
function renderDirectionChips(allLocations, selectedDirections, onChange, narrowByTypes, narrowByGroups) {
  const container = document.getElementById("directionChips");
  if (!container) return;
  container.innerHTML = "";
  for (const dir of CARDINAL_DIRECTIONS) {
    const hasMatch = allLocations.some((loc) => {
      if (narrowByTypes && !narrowByTypes.has(loc.type)) return false;
      if (narrowByGroups && !groupsMatchFilter(locationGroupsOf(loc), narrowByGroups)) return false;
      return shoreStartsWithDirection(loc.shore, dir);
    });
    if (!hasMatch) continue;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "loc-chip" + (selectedDirections.has(dir) ? " active" : "");
    chip.textContent = dir;
    chip.addEventListener("click", () => {
      if (selectedDirections.has(dir)) {
        selectedDirections.delete(dir);
      } else {
        selectedDirections.add(dir);
      }
      persistSelectedDirections(selectedDirections);
      chip.classList.toggle("active");
      onChange();
    });
    container.appendChild(chip);
  }
}

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
  localStorage.setItem(COMPUTED_SESSIONS_STORAGE_KEY, JSON.stringify(list));
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
function setupFullscreenToggle(targetId) {
  const target = document.getElementById(targetId);
  if (!target) return;
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
      const touch = navigator.maxTouchPoints > 0;
      const phoneSized = Math.min(screen.width, screen.height) <= 600;
      return touch && phoneSized && window.innerWidth > window.innerHeight;
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
      if (anyFullscreenElement()) return;
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
