// mark-lookup.js
// Looking up conditions for a mark at a place and time (weather, wind, pressure, tide via WillyWeather), the nearest tracked location, and the OpenStreetMap shore-direction guess.
// One of the shared scripts split out of the old charts.js. All of them share one global scope; each page loads
// only the ones it needs, in this order (checked by scripts/check-page-scripts.mjs).

// --- Historical mark conditions lookup (weather/wind/barometer/tide) -------
//
// Auto-fills weatherCondition/tideCondition/barometer/temperature/
// waterTemperature/windDirection/windSpeed for a mark at a given
// (lat, lng, dateTime) — see lookupHistoricalMarkConditions below, the
// single entry point everything else in this section builds toward.
// waterDepth has no entry here at all — nothing this site already talks
// to can supply bathymetry for an arbitrary point, so it stays a manual-
// only field (see its own schema comment). Scope, per how this was
// designed: ONLY runs for a brand-new mark, either created manually
// (startNewMarkEntry) or accepted through the Sync tab's import (sync.js)
// — never a retroactive bulk backfill over marks.json's existing ~2,500
// marks. That's a real cost consideration, not just tidiness: WillyWeather
// is billed per call, so backfilling every existing mark would mean
// thousands of billed calls for a one-off convenience; doing it only at
// creation/import time keeps this to one WillyWeather call + two
// Open-Meteo calls (weather + marine) per NEW mark, same order of
// magnitude as everything else this site already calls per mark.
//
// Three independent data sources, fetched in parallel (see
// lookupHistoricalMarkConditions):
//   - Wind (direction/speed), Barometer, Temperature, and Weather Condition
//     all come from Open-Meteo's historical archive API — free, keyless,
//     documented back to 1940 (archive-api.open-meteo.com/v1/archive).
//     Same parameter names/units this site's live pressure fetch already
//     uses (pressure_msl, timezone=auto for naive-local timestamps), plus
//     windspeed_10m/winddirection_10m/weathercode/temperature_2m.
//   - Water Temperature comes from Open-Meteo's separate MARINE API
//     (marine-api.open-meteo.com/v1/marine — the same endpoint
//     fetchOpenMeteoMarineHourly already uses for the Location tab's live
//     preview, just with start_date/end_date instead of forecast_days/
//     past_days). Open-Meteo's own docs describe this endpoint's
//     historical coverage as "limited" without saying exactly how limited
//     — see fetchOpenMeteoHistoricalMarineHourly's own comment.
//   - Tide Condition comes from WillyWeather, via the willyweather-search
//     Worker, using "our defined rules" (classifyTideConditionFromExtrema
//     above) applied to real historical tide events — snapped to whichever
//     TRACKED location (config/locations.json) is nearest the mark's own
//     coordinate, per Oliver's own call: an arbitrary mark's point has no
//     manually-verified tideOffset of its own, but every tracked location
//     does, so borrowing the nearest one's calibration is the practical
//     answer rather than leaving Tide Condition unset for anything that
//     isn't itself a tracked location.
//
// TWO THINGS WORTH KNOWING BEFORE TRUSTING THIS BLINDLY, neither of which
// could be verified directly while building this (no network path to
// either external API from the dev sandbox this was built in, and no
// WillyWeather key on hand even if there had been):
//   1. This assumes WillyWeather's weather.json genuinely honors a
//      `startDate` query param for a PAST date the way it does for a
//      future one. It's a standard, documented parameter for this API, but
//      lookupTideConditionAt below includes a real sanity check (the
//      returned tide events actually have to bracket the requested date)
//      specifically because this was never confirmed against a real call —
//      if WillyWeather silently ignored it and returned "today onward"
//      instead, that check is what catches it rather than silently saving
//      a wrong Tide Condition.
//   2. willyweather-search.js (the Worker) needed a matching change to
//      forward startDate at all — that file isn't part of this site's
//      normal GitHub-upload deploy flow, it has to be manually
//      copy-pasted into Cloudflare's dashboard and redeployed (see that
//      file's own header). If Tide Condition never fills in, checking
//      whether that redeploy actually happened is the first thing to
//      check, before assuming the code itself is wrong.

const OPEN_METEO_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

/**
 * Open-Meteo's WMO weathercode collapsed onto this site's own 4-value
 * Weather Condition pick-list (config/mark_lists.json) — there's no exact
 * match for every WMO code, so this groups by what a person glancing
 * outside would actually call it: 0-1 (clear/mainly clear) -> Clear, 2
 * (partly cloudy) -> Cloudy, 3 (overcast) and 45/48 (fog) -> Overcast,
 * everything else (drizzle, rain, snow, showers, thunderstorms — the site's
 * pick-list has no separate Snow option, and snow at these coastal
 * Victorian marks is vanishingly unlikely anyway) -> Rain. Returns null for
 * an unrecognised/missing code rather than guessing.
 */
function weatherCodeToCondition(code) {
  if (code == null) return null;
  if (code === 0 || code === 1) return "Clear";
  if (code === 2) return "Cloudy";
  if (code === 3 || code === 45 || code === 48) return "Overcast";
  return "Rain";
}

/**
 * One hour's wind/pressure/weathercode from Open-Meteo's historical
 * archive, for the exact calendar day dateStr ("YYYY-MM-DD") falls on —
 * returns the raw `hourly` object (parallel time[]/value[] arrays, same
 * shape openMeteoHourlyLookup already expects) or null on any failure.
 * `timezone=auto` (same convention fetchOpenMeteoPressureHourly already
 * uses) makes Open-Meteo return timestamps in the COORDINATE's own local
 * time — for Victorian marks, that's Melbourne wall-clock time, matching
 * this site's naive-string convention with no further conversion needed.
 */
async function fetchOpenMeteoHistoricalHourly(lat, lng, dateStr) {
  if (lat == null || lng == null || !dateStr) return null;
  try {
    const res = await fetch(
      `${OPEN_METEO_ARCHIVE_URL}?latitude=${lat}&longitude=${lng}&start_date=${dateStr}&end_date=${dateStr}` +
      `&hourly=windspeed_10m,winddirection_10m,pressure_msl,weathercode,temperature_2m&timezone=auto`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.hourly || null;
  } catch (err) {
    console.error("Open-Meteo historical fetch failed:", err);
    return null;
  }
}

/**
 * Sea surface temperature for the exact calendar day dateStr falls on, at
 * (lat, lng) — same historical-lookup idea as fetchOpenMeteoHistoricalHourly
 * just above, but Open-Meteo splits marine data onto its own separate
 * endpoint (OPEN_METEO_MARINE_URL — the same one fetchOpenMeteoMarineHourly
 * already uses for the Location tab's live preview, just with start_date/
 * end_date instead of forecast_days/past_days). UNVERIFIED against a real
 * call, same honesty note as lookupTideConditionAt's own: Open-Meteo's own
 * docs describe the marine API as having "limited" historical coverage
 * compared to the main weather archive, but didn't specify exactly how
 * limited, and this was never actually confirmed live (no network path to
 * either Open-Meteo endpoint from the sandbox this was built in). Failing
 * to null here just means waterTemperature stays unset on that mark, same
 * as any other lookup piece that comes back empty — never a wrong guess.
 */
async function fetchOpenMeteoHistoricalMarineHourly(lat, lng, dateStr) {
  if (lat == null || lng == null || !dateStr) return null;
  try {
    const res = await fetch(
      `${OPEN_METEO_MARINE_URL}?latitude=${lat}&longitude=${lng}&start_date=${dateStr}&end_date=${dateStr}` +
      `&hourly=sea_surface_temperature&timezone=auto&cell_selection=sea`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.hourly || null;
  } catch (err) {
    console.error("Open-Meteo historical marine fetch failed:", err);
    return null;
  }
}

// Cached once per page load — a Sync import can look up conditions for a
// dozen-plus marks in one batch, and every one of them needs the SAME
// static list of tracked locations to snap against, so this avoids
// re-fetching config/locations.json from scratch for every single mark.
let _trackedLocationsForLookupCache = null;

/** Fresh (cache-busted) config/locations.json, for findNearestTrackedLocation
 * below — same file/pattern loadTideOffsets already fetches, but that
 * function only MERGES tideOffset onto an already-loaded conditions.json
 * location list; this needs the full list (lat/lng/willyweatherId/
 * tideOffset) standalone, for pages (like sync.html) that never load
 * conditions.json at all. */
async function loadTrackedLocationsForLookup() {
  if (_trackedLocationsForLookupCache) return _trackedLocationsForLookupCache;
  // Prefer the live list from D1 (same fields — name, displayName, lat, lng,
  // willyweatherId, tideOffset — and always current, unlike the exported
  // file, which only updates when the data job runs).
  try {
    const live = await fetch(`${USER_BACKEND_URL}/api/public/locations?_=${Date.now()}`, { cache: "no-store" });
    if (live.ok) {
      const list = await live.json();
      if (Array.isArray(list) && list.length > 0) {
        _trackedLocationsForLookupCache = list;
        return list;
      }
    }
  } catch (err) {
    console.error("Live locations unavailable, falling back to config/locations.json:", err);
  }
  try {
    const res = await fetch(`config/locations.json?_=${Date.now()}`, { cache: "no-store" });
    _trackedLocationsForLookupCache = res.ok ? await res.json() : [];
  } catch (err) {
    console.error("Could not load config/locations.json for nearest-location lookup:", err);
    _trackedLocationsForLookupCache = [];
  }
  return _trackedLocationsForLookupCache;
}

/** Local equirectangular-projection point-to-point distance in metres —
 * same approach as overpassSegmentDistanceM (point-to-segment) above,
 * just between two plain points; plenty accurate at the scale a
 * "nearest tracked location" search runs at across Port Phillip/Western
 * Port. */
function distanceMetersBetween(lat1, lng1, lat2, lng2) {
  const lat0 = ((lat1 + lat2) / 2) * (Math.PI / 180);
  const kx = 111320 * Math.cos(lat0);
  const ky = 110540;
  const dx = (lng2 - lng1) * kx;
  const dy = (lat2 - lat1) * ky;
  return Math.hypot(dx, dy);
}

/**
 * Whichever tracked location (config/locations.json) is physically nearest
 * (lat, lng) — no distance cutoff, always returns the closest one that has
 * both a willyweatherId and real coordinates, per Oliver's own call: snap
 * to nearest unconditionally rather than falling back to "no calibration"
 * past some threshold. Returns null only if locations.json failed to load
 * or genuinely has no usable entries.
 */
async function findNearestTrackedLocation(lat, lng) {
  const locations = await loadTrackedLocationsForLookup();
  let best = null;
  let bestDist = Infinity;
  for (const loc of locations) {
    if (typeof loc.lat !== "number" || typeof loc.lng !== "number" || !loc.willyweatherId) continue;
    const d = distanceMetersBetween(lat, lng, loc.lat, loc.lng);
    if (d < bestDist) {
      bestDist = d;
      best = loc;
    }
  }
  return best;
}

/** "YYYY-MM-DD HH:MM:SS" naive-string ms value -> "YYYY-MM-DD" (UTC
 * getters, per this site's naive convention — see parseNaive). */
function naiveDateOnlyStr(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * Real historical Tide Condition for (lat, lng) at targetMs — snaps to the
 * nearest tracked location (findNearestTrackedLocation) for its
 * willyweatherId/tideOffset, fetches that station's real tide events for a
 * 3-day window centred on targetMs's own day (a full day either side, so
 * there are always real extrema bracketing targetMs even right at a day
 * boundary — a tide half-cycle is ~6.2h, nowhere near wide enough to need
 * more), shifts each event's time by the location's own tideOffset exactly
 * the way applyTideOffsetToRows shifts a whole curve (algebraically
 * equivalent for a pure time-shift: shifting every extremum's timestamp by
 * +offsetMinutes reproduces the same "read this station's curve
 * offsetMinutes earlier" effect, without needing to rebuild and re-scan a
 * synthetic hourly grid the way applyTideOffsetToRows/findTideExtrema do
 * for the live chart), then classifies via classifyTideConditionFromExtrema
 * — the exact same rules computeQuickMarkDefaults already uses, just fed
 * real past events instead of "now".
 *
 * Returns null on any failure, including the sanity check described in
 * this section's own header comment: if the returned tide events don't
 * actually bracket targetMs, that's treated as "this lookup didn't really
 * work" rather than risking a wrong classification from data that quietly
 * wasn't for the date requested.
 */
async function lookupTideConditionAt(lat, lng, targetMs) {
  if (!WILLYWEATHER_SEARCH_WORKER_URL) return null;
  const nearest = await findNearestTrackedLocation(lat, lng);
  if (!nearest) return null;

  const startDateStr = naiveDateOnlyStr(targetMs - 86400000);
  try {
    const res = await fetch(`${WILLYWEATHER_SEARCH_WORKER_URL}/weather?id=${encodeURIComponent(nearest.willyweatherId)}&startDate=${startDateStr}&days=3`);
    if (!res.ok) return null;
    const data = await res.json();
    const tideDays = ((data.forecasts || {}).tides || {}).days || [];
    const rawEntries = [];
    for (const day of tideDays) {
      for (const entry of day.entries || []) rawEntries.push(entry);
    }
    if (rawEntries.length === 0) return null;

    const offsetMs = (nearest.tideOffset || 0) * 60000;
    const extrema = rawEntries
      .map((e) => ({ t: parseNaive(e.dateTime) + offsetMs, height: e.height, type: e.type }))
      .filter((e) => Number.isFinite(e.t) && (e.type === "high" || e.type === "low"))
      .sort((a, b) => a.t - b.t);

    if (extrema.length === 0 || extrema[0].t > targetMs || extrema[extrema.length - 1].t < targetMs) {
      console.error(
        "Historical tide lookup: returned events don't bracket the requested date — " +
        "startDate may not be honored by WillyWeather as expected, or the Worker hasn't " +
        "been redeployed with startDate support yet (see willyweather-search.js)."
      );
      return null;
    }

    return classifyTideFromExtrema(extrema, targetMs); // { condition, extreme } or null
  } catch (err) {
    console.error("Historical tide lookup failed:", err);
    return null;
  }
}

/** A naive-ms timestamp as "YYYY-MM-DD HH:MM:SS" (the archive's format). */
function archiveTimeString(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** Hourly observed conditions for a tracked location from the pipeline's archive (Worker: /api/public/observations), oldest first; [] when there are none or the call fails. */
async function fetchStoredObservations(locationName, fromMs, toMs) {
  try {
    const res = await fetch(
      `${USER_BACKEND_URL}/api/public/observations?location=${encodeURIComponent(locationName)}&from=${encodeURIComponent(archiveTimeString(fromMs))}&to=${encodeURIComponent(archiveTimeString(toMs))}`
    );
    if (!res.ok) return [];
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.error("Stored observations unavailable:", err);
    return [];
  }
}

/**
 * The stored tide events (raw from the station, like WillyWeather's) for a tracked location around
 * [startMs, endMs], shifted by the location's own tideOffset exactly as the live lookup does. Null unless
 * the events bracket the whole window — a curve needs an event at or before the start and at or after the
 * end — so callers fall back to the live lookup for anything the archive doesn't fully cover.
 */
async function fetchStoredTideExtrema(location, startMs, endMs) {
  try {
    const res = await fetch(
      `${USER_BACKEND_URL}/api/public/tide-events?location=${encodeURIComponent(location.name)}` +
        `&from=${encodeURIComponent(archiveTimeString(startMs - 86400000))}&to=${encodeURIComponent(archiveTimeString(endMs + 86400000))}`
    );
    if (!res.ok) return null;
    const events = await res.json();
    if (!Array.isArray(events)) return null;
    const offsetMs = (location.tideOffset || 0) * 60000;
    const extrema = events
      .map((e) => ({ t: parseNaive(e.time) + offsetMs, height: e.heightM, type: e.type }))
      .filter((e) => Number.isFinite(e.t) && (e.type === "high" || e.type === "low"))
      .sort((a, b) => a.t - b.t);
    if (extrema.length < 2 || extrema[0].t > startMs || extrema[extrema.length - 1].t < endMs) return null;
    return extrema;
  } catch (err) {
    console.error("Stored tide events unavailable:", err);
    return null;
  }
}

/**
 * Real tide high/low events covering [startMs, endMs] (naive ms) for the
 * tracked location nearest (lat, lng), shifted by that location's own
 * tideOffset exactly as lookupTideConditionAt does — for the Reports tab's
 * Session Ribbon tide curve. Returns { location, extrema } (extrema sorted,
 * {t, height, type}) or null when there's no tide data (no nearby location
 * with a WillyWeather id, request failed, or the events don't cover the
 * window). One WillyWeather call is billed per uncached request, so results
 * are cached in localStorage per (station, start date, days) — reopening the
 * same session never bills again.
 */
async function fetchTideExtremaForRange(lat, lng, startMs, endMs) {
  if (!WILLYWEATHER_SEARCH_WORKER_URL) return null;
  const nearest = await findNearestTrackedLocation(lat, lng);
  if (!nearest) return null;

  // The pipeline's archive keeps the tide events (see fetchStoredTideExtrema): when they cover the window
  // there is no need for a billed WillyWeather call. Anything else falls through to the live lookup below.
  const stored = await fetchStoredTideExtrema(nearest, startMs, endMs);
  if (stored) return { location: nearest, extrema: stored };

  const startDateStr = naiveDateOnlyStr(startMs - 86400000);
  const days = Math.min(7, Math.ceil((endMs - startMs) / 86400000) + 3);
  const cacheKey = `ribbonTide:${nearest.willyweatherId}:${startDateStr}:${days}`;
  let rawEntries = null;
  try {
    rawEntries = JSON.parse(localStorage.getItem(cacheKey) || "null");
  } catch {
    rawEntries = null;
  }
  if (!Array.isArray(rawEntries)) {
    try {
      const res = await fetch(`${WILLYWEATHER_SEARCH_WORKER_URL}/weather?id=${encodeURIComponent(nearest.willyweatherId)}&startDate=${startDateStr}&days=${days}`);
      if (!res.ok) return null;
      const data = await res.json();
      rawEntries = [];
      for (const day of ((data.forecasts || {}).tides || {}).days || []) {
        for (const entry of day.entries || []) rawEntries.push(entry);
      }
      try {
        localStorage.setItem(cacheKey, JSON.stringify(rawEntries));
      } catch {
        /* storage full/blocked — just refetch next time */
      }
    } catch (err) {
      console.error("Tide range lookup failed:", err);
      return null;
    }
  }
  const offsetMs = (nearest.tideOffset || 0) * 60000;
  const extrema = rawEntries
    .map((e) => ({ t: parseNaive(e.dateTime) + offsetMs, height: e.height, type: e.type }))
    .filter((e) => Number.isFinite(e.t) && (e.type === "high" || e.type === "low"))
    .sort((a, b) => a.t - b.t);
  if (extrema.length < 2 || extrema[0].t > startMs || extrema[extrema.length - 1].t < endMs) return null;
  return { location: nearest, extrema };
}

/**
 * The single entry point for this whole section — looks up best-effort
 * weatherCondition/tideCondition/barometer/windDirection/windSpeed for a
 * mark at (lat, lng, dateTimeNaive). Returns a plain object with whichever
 * fields actually resolved; any that failed or found nothing are simply
 * absent (never throws, never returns a partially-wrong guess) — same
 * sparse-object convention every other optional mark field already
 * follows. Runs the WillyWeather tide lookup and the Open-Meteo weather
 * lookup in parallel since they're fully independent of each other.
 */
async function lookupHistoricalMarkConditions(lat, lng, dateTimeNaive) {
  const result = {};
  const targetMs = parseNaive(dateTimeNaive);
  if (targetMs == null || lat == null || lng == null) return result;
  const dateStr = dateTimeNaive.slice(0, 10);
  const hourKey = dateTimeNaive.slice(0, 13);

  const [tide, hourly, marineHourly] = await Promise.all([
    lookupTideConditionAt(lat, lng, targetMs),
    fetchOpenMeteoHistoricalHourly(lat, lng, dateStr),
    fetchOpenMeteoHistoricalMarineHourly(lat, lng, dateStr),
  ]);

  if (tide) {
    result.tideCondition = tide.condition;
    if (tide.extreme) result.tideExtreme = tide.extreme;
  }

  if (hourly && Array.isArray(hourly.time)) {
    const speed = openMeteoHourlyLookup(hourly.time, hourly.windspeed_10m)[hourKey];
    const dir = openMeteoHourlyLookup(hourly.time, hourly.winddirection_10m)[hourKey];
    const pressure = openMeteoHourlyLookup(hourly.time, hourly.pressure_msl)[hourKey];
    const code = openMeteoHourlyLookup(hourly.time, hourly.weathercode)[hourKey];
    const airTemp = openMeteoHourlyLookup(hourly.time, hourly.temperature_2m)[hourKey];

    if (speed != null) result.windSpeed = Math.round(speed);
    if (dir != null) result.windDirection = previewDegreesToCompass(dir);
    if (pressure != null) result.barometer = Math.round(pressure * 10) / 10;
    if (airTemp != null) result.temperature = Math.round(airTemp * 10) / 10;
    const cond = weatherCodeToCondition(code);
    if (cond) result.weatherCondition = cond;
  }

  if (marineHourly && Array.isArray(marineHourly.time)) {
    const waterTemp = openMeteoHourlyLookup(marineHourly.time, marineHourly.sea_surface_temperature)[hourKey];
    if (waterTemp != null) result.waterTemperature = Math.round(waterTemp * 10) / 10;
  }

  return result;
}

// --- Shore direction guess (OpenStreetMap coastline bearing) ---------------
//
// Ports validate_shore.py's algorithm (already run and confirmed against
// every one of this site's own saved locations before this was wired into
// the live feature — see that script and its own module docstring for the
// full derivation/confidence notes) directly into the browser: Overpass is
// a public, keyless, CORS-friendly API, so this needs no Worker proxy,
// unlike the WillyWeather calls elsewhere on this page.
//
// `shore` = the LAND direction at that point (confirmed directly by
// Oliver — NOT the water/seaward direction the Settings page's "Shore
// faces" label might suggest at a glance). OpenStreetMap's coastline
// convention is documented and strict: land is on the LEFT of a
// natural=coastline way's own node order, water on the right — so this
// rotates -90° off the nearest segment's bearing, not +90°.

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const SHORE_GUESS_SEARCH_RADII_M = [1000, 3000, 8000];

function overpassBearingDeg(lat1, lng1, lat2, lng2) {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const x = Math.sin(dl) * Math.cos(p2);
  const y = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

/** Local equirectangular-projection point-to-segment distance in metres —
 * more than accurate enough at the few-km scale this runs at, far simpler
 * than exact spherical geometry (same approach as validate_shore.py). */
function overpassSegmentDistanceM(plat, plng, alat, alng, blat, blng) {
  const lat0 = ((alat + blat) / 2) * (Math.PI / 180);
  const kx = 111320 * Math.cos(lat0);
  const ky = 110540;
  const toXY = (lat, lng) => [lng * kx, lat * ky];
  const [px, py] = toXY(plat, plng);
  const [ax, ay] = toXY(alat, alng);
  const [bx, by] = toXY(blat, blng);
  const dx = bx - ax, dy = by - ay;
  const segLenSq = dx * dx + dy * dy;
  const t = segLenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / segLenSq));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Guesses the compass direction of LAND at (lat, lng) from the nearest
 * OpenStreetMap coastline segment, escalating the search radius if
 * nothing's found nearby. Returns a 16-point compass string, or null if
 * no coastline data was found at any radius, the fetch failed, or lat/lng
 * weren't supplied — never throws, same pattern as every other
 * best-effort fetch in this preview pipeline.
 */
async function guessShoreDirection(lat, lng) {
  if (lat == null || lng == null) return null;
  let best = null; // {distance, bearing}
  for (const radius of SHORE_GUESS_SEARCH_RADII_M) {
    try {
      const ql = `[out:json][timeout:20];way(around:${radius},${lat},${lng})[natural=coastline];out geom;`;
      const res = await fetch(`${OVERPASS_URL}?data=${encodeURIComponent(ql)}`);
      if (!res.ok) continue;
      const data = await res.json();
      for (const el of data.elements || []) {
        const geometry = el.geometry || [];
        for (let i = 0; i < geometry.length - 1; i++) {
          const a = geometry[i], b = geometry[i + 1];
          if (a.lat == null || b.lat == null) continue;
          const dist = overpassSegmentDistanceM(lat, lng, a.lat, a.lon, b.lat, b.lon);
          if (best == null || dist < best.distance) {
            best = { distance: dist, bearing: overpassBearingDeg(a.lat, a.lon, b.lat, b.lon) };
          }
        }
      }
    } catch (err) {
      console.error(`Overpass shore-direction lookup failed at radius ${radius}m:`, err);
    }
    if (best != null) break;
  }
  if (best == null) return null;
  const landBearing = (best.bearing - 90 + 360) % 360;
  return previewDegreesToCompass(landBearing);
}

