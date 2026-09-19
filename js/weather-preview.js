// weather-preview.js
// Location preview on the Location and Settings maps: fetching forecast rows (WillyWeather + Open-Meteo), building rows, and scoring conditions and fishing rating in the browser.
// One of the shared scripts split out of the old charts.js. All of them share one global scope; each page loads
// only the ones it needs, in this order (checked by scripts/check-page-scripts.mjs).

// --- WillyWeather live preview (Location tab "click map to preview") ------
//
// Builds a preview graph for an arbitrary map point WITHOUT it being a
// saved location in config/locations.json — see previewLocationOnMap,
// app.js. This is a browser-side port of fetch_conditions.py's own DATA
// MERGING (build_readings/process_location) — NOT its scoring
// (compute_condition/compute_fishing_condition), which needs each
// location's own saved shore/threshold config that doesn't exist yet for
// a spot that's only been clicked, not added. buildConditionStripsPlugin
// simply has nothing to draw for a preview's Location/Fishing Condition
// strips as a result — an empty strip, not a wrong one, and worth saying
// so explicitly to whoever's looking (see the preview note in app.js).
//
// WillyWeather's own weather.json (via the Worker's /weather endpoint,
// which is what keeps the API key off this page) supplies temperature,
// wind, rainfall probability, tides, and sunrise/sunset. Open-Meteo's
// pressure and marine (sea surface temperature) endpoints need no key at
// all, so those go straight from the browser rather than through the
// Worker — same division fetch_conditions.py itself uses.

const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const OPEN_METEO_MARINE_URL = "https://marine-api.open-meteo.com/v1/marine";
// Matches fetch_conditions.py's own FORECAST_DAYS default (6) — this used
// to be deliberately shorter (4) on the theory that a preview call should
// spend less metered WillyWeather quota than the scheduled pipeline does,
// but that reasoning didn't actually hold up: WillyWeather's `days`
// parameter just changes the SIZE of one response, not how many calls get
// made, so 4 vs 6 days costs practically the same per click. Left
// inconsistent otherwise for no real reason, which is exactly what Oliver
// noticed (a preview showing 4 days next to saved locations' 6).
//
// NOTE this can't actually track FORECAST_DAYS automatically if Oliver
// changes that via the GitHub Actions env var — this file is static
// client-side JS with no build step, it has no way to read a workflow
// env var at all. If FORECAST_DAYS ever changes, this constant needs
// updating by hand to match.
const PREVIEW_FORECAST_DAYS = 6;

/**
 * The whole preview data pipeline for one clicked point: WillyWeather
 * weather.json (via the Worker), Open-Meteo pressure/marine (direct), and
 * an OpenStreetMap coastline-based shore-direction guess (direct — no key
 * needed, Overpass is a public, keyless, CORS-friendly API), all fetched
 * in parallel, then pivoted into the same "rows" shape every other chart
 * on this site already expects (see renderConditionsChart) PLUS full
 * Location/Fishing Condition scoring — see the "Preview condition
 * scoring" section below for how that's actually computed. Returns null
 * on any failure (Worker not configured/reachable, WillyWeather id
 * invalid, no data at all) — callers show a friendly message rather than
 * a half-built graph. Never throws.
 *
 * clickLat/clickLng (the person's own precision) feed Open-Meteo's
 * pressure/marine calls, same reasoning as everywhere else on this site
 * that prefers a click's own precision over a station centroid.
 * shoreLat/shoreLng are DELIBERATELY separate — the shore-direction guess
 * uses WillyWeather's own resolved location coordinate instead (see
 * guessShoreDirection below), not the click, since that's the point
 * WillyWeather itself considers "this location" and is what the rest of
 * this location's data (tides, wind) is actually anchored to.
 */
async function fetchWillyWeatherPreviewRows(willyweatherId, clickLat, clickLng, shoreLat, shoreLng) {
  if (!WILLYWEATHER_SEARCH_WORKER_URL) return null;
  try {
    const [weather, pressureByHour, marine, shoreGuess] = await Promise.all([
      fetch(`${WILLYWEATHER_SEARCH_WORKER_URL}/weather?id=${encodeURIComponent(willyweatherId)}&days=${PREVIEW_FORECAST_DAYS}`).then((r) => (r.ok ? r.json() : null)),
      fetchOpenMeteoPressureHourly(clickLat, clickLng),
      fetchOpenMeteoMarineHourly(clickLat, clickLng),
      guessShoreDirection(shoreLat, shoreLng),
    ]);
    if (!weather || !weather.forecasts) return null;
    return buildPreviewRows(weather, pressureByHour, marine, shoreGuess);
  } catch (err) {
    console.error("WillyWeather preview fetch failed:", err);
    return null;
  }
}

/** Hourly mean-sea-level pressure — same Open-Meteo call/params as
 * get_pressure_forecast in fetch_conditions.py. Fails to {} (never
 * throws), same as every other best-effort fetch on this site — a preview
 * missing its Pressure line is far better than a preview that won't load
 * at all over one flaky supplementary call. */
async function fetchOpenMeteoPressureHourly(lat, lng) {
  if (lat == null || lng == null) return {};
  try {
    const res = await fetch(`${OPEN_METEO_FORECAST_URL}?latitude=${lat}&longitude=${lng}&hourly=pressure_msl&forecast_days=${PREVIEW_FORECAST_DAYS}&timezone=auto`);
    if (!res.ok) return {};
    const data = await res.json();
    return openMeteoHourlyLookup((data.hourly || {}).time, (data.hourly || {}).pressure_msl);
  } catch (err) {
    console.error("Open-Meteo pressure fetch failed:", err);
    return {};
  }
}

/** Hourly sea surface temperature PLUS ocean current velocity/direction —
 * same Open-Meteo Marine call/params as get_marine_forecast in
 * fetch_conditions.py, all three in one request. Current velocity/
 * direction only actually get USED when the location turns out to be
 * tidal (see buildPreviewRows) — fetched unconditionally anyway, same as
 * fetch_conditions.py itself does (it strips them AFTER fetching for a
 * non-tidal location, not by skipping the call), since we don't know
 * whether this spot is tidal until WillyWeather's own response comes back
 * in the same Promise.all. */
async function fetchOpenMeteoMarineHourly(lat, lng) {
  if (lat == null || lng == null) return { sstByHour: {}, velocityByHour: {}, directionByHour: {} };
  try {
    const res = await fetch(
      `${OPEN_METEO_MARINE_URL}?latitude=${lat}&longitude=${lng}` +
      `&hourly=sea_surface_temperature,ocean_current_velocity,ocean_current_direction` +
      `&forecast_days=${Math.min(PREVIEW_FORECAST_DAYS, 8)}&past_days=1&timezone=auto&cell_selection=sea`
    );
    if (!res.ok) return { sstByHour: {}, velocityByHour: {}, directionByHour: {} };
    const data = await res.json();
    const hourly = data.hourly || {};
    return {
      sstByHour: openMeteoHourlyLookup(hourly.time, hourly.sea_surface_temperature),
      velocityByHour: openMeteoHourlyLookup(hourly.time, hourly.ocean_current_velocity),
      directionByHour: openMeteoHourlyLookup(hourly.time, hourly.ocean_current_direction),
    };
  } catch (err) {
    console.error("Open-Meteo marine fetch failed:", err);
    return { sstByHour: {}, velocityByHour: {}, directionByHour: {} };
  }
}

/** Open-Meteo returns parallel time[]/value[] arrays with "YYYY-MM-DDTHH:MM"
 * timestamps (no seconds) — this re-keys them to "YYYY-MM-DD HH" hour
 * buckets, the same lookup shape hourly_lookup() produces in
 * fetch_conditions.py, so buildPreviewRows can attach a value to every row
 * that falls in the same hour regardless of its own exact minute. */
function openMeteoHourlyLookup(times, values) {
  const out = {};
  if (!times || !values) return out;
  for (let i = 0; i < times.length; i++) {
    const v = values[i];
    if (v == null) continue;
    out[String(times[i]).slice(0, 13).replace("T", " ")] = v;
  }
  return out;
}

/** Ports daily_averages from fetch_conditions.py, operating on an
 * already-hour-bucketed lookup (openMeteoHourlyLookup's output) rather
 * than the raw parallel arrays — equivalent numerically, since Open-Meteo
 * already returns exactly one reading per hour (no aggregation lost by
 * going through the hourly map first), and it means this can be reused
 * for both the pressure and water-temp daily averages without repeating
 * the grouping logic. */
function dailyAverageFromHourlyLookup(hourlyMap) {
  const byDate = {};
  for (const hourKey in hourlyMap) {
    const dateStr = hourKey.slice(0, 10);
    (byDate[dateStr] = byDate[dateStr] || []).push(hourlyMap[hourKey]);
  }
  const out = {};
  for (const dateStr in byDate) {
    const vals = byDate[dateStr];
    out[dateStr] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  return out;
}


/** Mirrors GetNumericField from fetch_conditions.py: grabs whatever
 * numeric field is present on a temperature forecast entry, regardless of
 * its exact name (WillyWeather's field name for this varies by product). */
function previewNumericField(entry) {
  for (const key in entry) {
    if (key === "dateTime" || key === "type") continue;
    const val = entry[key];
    if (typeof val === "number" && !Number.isNaN(val)) return val;
  }
  return null;
}

/** WillyWeather's observationalGraphs timestamps are epoch SECONDS that
 * already represent local wall-clock time (per their docs) — mirrors
 * epoch_to_local_dt's UTC-math conversion (no real timezone shift) into
 * this site's usual naive "YYYY-MM-DD HH:MM:SS" string convention, so the
 * result slots into the same byDt pivot as every other reading below. */
function previewEpochToNaiveString(epochSeconds) {
  if (epochSeconds == null) return null;
  const d = new Date(epochSeconds * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Nearest of the 16 compass points to a given degree value — the reverse
 * of COMPASS_DEGREES, needed by fillPreviewWindGaps' circular averaging. */
function previewDegreesToCompass(deg) {
  let closest = null;
  let closestDiff = Infinity;
  for (const name in COMPASS_DEGREES) {
    const diff = Math.min(Math.abs(COMPASS_DEGREES[name] - deg), 360 - Math.abs(COMPASS_DEGREES[name] - deg));
    if (diff < closestDiff) {
      closestDiff = diff;
      closest = name;
    }
  }
  return closest;
}

/**
 * Ports fill_wind_gaps from fetch_conditions.py: fills missing wind
 * speed/direction by averaging the nearest REAL reading before and after
 * the gap — never extrapolates past the first/last real one. Direction is
 * averaged as unit vectors (not a plain numeric mean) so a gap between,
 * say, 350° and 10° resolves to roughly 0° rather than swinging through
 * 180°. Mutates rows in place, from a snapshot of the original values —
 * see the Python original for why (an early fill must never feed a later
 * gap's average).
 */
function fillPreviewWindGaps(rows) {
  const n = rows.length;
  const originalSpeed = rows.map((r) => (r["Wind Forecast (km/h)"] != null ? r["Wind Forecast (km/h)"] : null));
  const originalDir = rows.map((r) => (r["Wind Forecast Dir"] != null ? r["Wind Forecast Dir"] : null));

  const nearestReal = (values, i, step) => {
    let j = i;
    while (j >= 0 && j < n) {
      if (values[j] != null) return j;
      j += step;
    }
    return null;
  };

  for (let i = 0; i < n; i++) {
    if (originalSpeed[i] != null) continue;
    const prevIdx = nearestReal(originalSpeed, i - 1, -1);
    const nextIdx = nearestReal(originalSpeed, i + 1, 1);
    if (prevIdx != null && nextIdx != null) {
      rows[i]["Wind Forecast (km/h)"] = Math.round(((originalSpeed[prevIdx] + originalSpeed[nextIdx]) / 2) * 10) / 10;
    }
  }
  for (let i = 0; i < n; i++) {
    if (originalDir[i] != null) continue;
    const prevIdx = nearestReal(originalDir, i - 1, -1);
    const nextIdx = nearestReal(originalDir, i + 1, 1);
    if (prevIdx == null || nextIdx == null) continue;
    const deg1 = COMPASS_DEGREES[originalDir[prevIdx]];
    const deg2 = COMPASS_DEGREES[originalDir[nextIdx]];
    if (deg1 == null || deg2 == null) continue;
    const rad1 = (deg1 * Math.PI) / 180;
    const rad2 = (deg2 * Math.PI) / 180;
    const avgX = (Math.cos(rad1) + Math.cos(rad2)) / 2;
    const avgY = (Math.sin(rad1) + Math.sin(rad2)) / 2;
    const avgDeg = ((Math.atan2(avgY, avgX) * 180) / Math.PI + 360) % 360;
    rows[i]["Wind Forecast Dir"] = previewDegreesToCompass(avgDeg);
  }
}

/**
 * Pivots WillyWeather's weather.json (raw forecast/observational shape)
 * plus the Open-Meteo hourly lookups into the "rows" array
 * renderConditionsChart expects — ports process_location's merge AND
 * Tide Status derivation (not its per-type Condition scoring, which is a
 * separate step — see attachConditionScores below, since it needs to be
 * re-runnable whenever the person changes Shore/Type in the preview UI
 * without re-fetching anything).
 *
 * `tidal` is determined here, not passed in — a location counts as tidal
 * for this preview if WillyWeather's own tides forecast actually returned
 * a real height reading, exactly mirroring config/locations.json's own
 * `tidal` flag semantics (see process_location, fetch_conditions.py) but
 * derived live instead of pre-saved. When not tidal: tide height/status
 * are stripped entirely (never interpolated/guessed), ocean current data
 * is dropped (only mattered for Kayak's wind-against-current penalty),
 * and `shoreGuess` is discarded even if the Overpass lookup found
 * something — Oliver's own call: don't trust a coastline-bearing guess
 * for a spot WillyWeather itself doesn't consider tidal, since it's
 * probably not the kind of open-coast point that guess is good for.
 *
 * Returns { rows, sunTimes, tideMaxObserved, tidal, shoreGuess }.
 */
function buildPreviewRows(weather, pressureByHour, marine, shoreGuess) {
  const forecasts = weather.forecasts || {};
  const byDt = {};
  const setField = (dtRaw, field, value) => {
    if (dtRaw == null || value == null) return;
    const rec = byDt[dtRaw] || (byDt[dtRaw] = { dateTime: dtRaw });
    rec[field] = value;
  };

  for (const day of (forecasts.temperature || {}).days || []) {
    for (const entry of day.entries || []) {
      setField(entry.dateTime, "Temp Forecast (C)", previewNumericField(entry));
    }
  }
  for (const day of (forecasts.wind || {}).days || []) {
    for (const entry of day.entries || []) {
      setField(entry.dateTime, "Wind Forecast (km/h)", entry.speed);
      setField(entry.dateTime, "Wind Forecast Dir", entry.directionText || entry.direction);
    }
  }
  // Mirrors build_readings's own swell block (fetch_conditions.py) exactly
  // — same four fields, same reasoning for keeping raw degrees separate
  // from the compass-letter text (the chart needs a real number to point
  // an arrow by; the text is for display/tooltip use only). Naturally
  // produces nothing at all for a location with no swell data, the same
  // way every other forecast type here already does — no extra handling
  // needed for "where it exists" on the preview path specifically.
  for (const day of (forecasts.swell || {}).days || []) {
    for (const entry of day.entries || []) {
      setField(entry.dateTime, "Swell Height (m)", entry.height);
      setField(entry.dateTime, "Swell Period (s)", entry.period);
      setField(entry.dateTime, "Swell Dir", entry.direction);
      setField(entry.dateTime, "Swell Dir Text", entry.directionText);
    }
  }
  for (const day of (forecasts.rainfallprobability || {}).days || []) {
    for (const entry of day.entries || []) {
      setField(entry.dateTime, "Rainfall Probability (%)", entry.probability);
    }
  }

  // Tide events are WillyWeather's actual high/low readings — a handful
  // per day, not an hourly curve — kept as their own sorted list (rather
  // than only living inside byDt) so interpolatedTideHeightAt below (the
  // same cosine interpolation the Tide Offset feature already uses) has a
  // clean bracketing pair to interpolate between for every OTHER hourly
  // row that has no real tide reading of its own. `tidal` is simply
  // "did any of these exist at all".
  const realTideEvents = [];
  for (const day of (forecasts.tides || {}).days || []) {
    for (const entry of day.entries || []) {
      if (entry.height == null) continue;
      setField(entry.dateTime, "Tide Height (m)", entry.height);
      if (entry.type) setField(entry.dateTime, "Tide Type", entry.type);
      const t = parseNaive(entry.dateTime);
      if (t != null) realTideEvents.push({ _t: t, "Tide Height (m)": entry.height });
    }
  }
  realTideEvents.sort((a, b) => a._t - b._t);
  const tidal = realTideEvents.length > 0;

  const obsGraphs = weather.observationalGraphs || {};
  const tempGroups = ((obsGraphs.temperature || {}).dataConfig || {}).series?.groups || [];
  for (const group of tempGroups) {
    for (const point of group.points || []) {
      setField(previewEpochToNaiveString(point.x), "Temp Realtime (C)", point.y);
    }
  }
  const windGroups = ((obsGraphs.wind || {}).dataConfig || {}).series?.groups || [];
  for (const group of windGroups) {
    for (const point of group.points || []) {
      const dtStr = previewEpochToNaiveString(point.x);
      setField(dtStr, "Wind Realtime (km/h)", point.y);
      setField(dtStr, "Wind Realtime Dir", point.directionText);
    }
  }

  let rows = Object.values(byDt);
  for (const r of rows) r._t = parseNaive(r.dateTime);
  rows = rows.filter((r) => r._t != null).sort((a, b) => a._t - b._t);

  fillPreviewWindGaps(rows);

  if (!tidal) {
    // Stripped at the source, same as fetch_conditions.py does for a
    // config-level tidal:false location — a non-tidal spot that happened
    // to pick up a stray "Tide Type" from a malformed/edge-case entry
    // above shouldn't get Tide Status derived from it either.
    for (const r of rows) {
      delete r["Tide Height (m)"];
      delete r["Tide Type"];
    }
  } else {
    for (const r of rows) {
      if (r["Tide Height (m)"] == null) {
        const interpolated = interpolatedTideHeightAt(realTideEvents, r._t);
        if (interpolated != null) r["Tide Height (m)"] = Math.round(interpolated * 100) / 100;
      }
    }
    deriveTideStatus(rows);
  }

  for (const r of rows) {
    const hourKey = r.dateTime.slice(0, 13).replace("T", " ");
    if (pressureByHour[hourKey] != null) r["Pressure (hPa)"] = pressureByHour[hourKey];
    if (marine.sstByHour[hourKey] != null) r["Water Temp (C)"] = marine.sstByHour[hourKey];
    // Internal (underscore-prefixed, not a real chart field) — carried on
    // each row purely so attachConditionScores can re-run Kayak's
    // wind-against-current penalty on demand (e.g. after the person
    // changes Type in the preview UI) without a second network round trip.
    // Only set when tidal, mirroring how fetch_conditions.py zeroes these
    // out for a non-tidal location before Condition scoring ever sees them.
    if (tidal) {
      if (marine.velocityByHour[hourKey] != null) r._currentVelocity = marine.velocityByHour[hourKey];
      if (marine.directionByHour[hourKey] != null) r._currentDirection = marine.directionByHour[hourKey];
    }
  }

  const tideHeights = realTideEvents.map((e) => e["Tide Height (m)"]);
  const tideMaxObserved = tideHeights.length ? Math.round(Math.max(...tideHeights) * 100) / 100 : null;

  const daysTideRanges = tidal ? dailyTideRangesFromRows(rows) : {};
  const pressureByDate = dailyAverageFromHourlyLookup(pressureByHour);
  const sstByDate = dailyAverageFromHourlyLookup(marine.sstByHour);
  const sunTimes = extractPreviewSunTimes(weather);
  attachFishingConditionScores(rows, sunTimes, daysTideRanges, pressureByDate, sstByDate);

  return { rows, sunTimes, tideMaxObserved, tidal, shoreGuess: tidal ? shoreGuess : null };
}

/**
 * Ports the Tide Status derivation loop from process_location
 * (fetch_conditions.py) verbatim — Low/High from a row's own real tide
 * event type, everything else Incoming/Outgoing from the nearest known
 * event before/after it. Mutates rows in place, removing the intermediate
 * "Tide Type" field once done (matching the Python original's row.pop) —
 * "Tide Status" is what everything downstream (Fishing Condition's tide
 * factors) actually reads.
 */
function deriveTideStatus(rows) {
  const n = rows.length;
  const nextTypeByIdx = new Array(n).fill(null);
  let runningNext = null;
  for (let i = n - 1; i >= 0; i--) {
    if (rows[i]["Tide Type"]) runningNext = rows[i]["Tide Type"];
    nextTypeByIdx[i] = rows[i]["Tide Type"] ? rows[i]["Tide Type"] : runningNext;
  }

  let runningPrev = null;
  for (let i = 0; i < n; i++) {
    const row = rows[i];
    const thisType = row["Tide Type"];
    const prevForRow = runningPrev;
    const nextForRow = nextTypeByIdx[i];

    let status = null;
    if (row["Tide Height (m)"] != null && thisType === "low") status = "Low";
    else if (row["Tide Height (m)"] != null && thisType === "high") status = "High";
    else if (prevForRow == null && nextForRow === "high") status = "Incoming";
    else if (prevForRow == null && nextForRow === "low") status = "Outgoing";
    else if (nextForRow == null && prevForRow === "high") status = "Outgoing";
    else if (nextForRow == null && prevForRow === "low") status = "Incoming";
    else if (prevForRow === "low" && nextForRow === "high") status = "Incoming";
    else if (prevForRow === "high" && nextForRow === "low") status = "Outgoing";

    row["Tide Status"] = status;
    delete row["Tide Type"];
    if (thisType) runningPrev = thisType;
  }
}

/** Ports the daily_tide_ranges computation from process_location: each
 * date's max-minus-min across that date's own real High/Low readings
 * (needs Tide Status already derived — see deriveTideStatus above). */
function dailyTideRangesFromRows(rows) {
  const heightsByDate = {};
  for (const row of rows) {
    if ((row["Tide Status"] === "High" || row["Tide Status"] === "Low") && row["Tide Height (m)"] != null) {
      const dateStr = row.dateTime.slice(0, 10);
      (heightsByDate[dateStr] = heightsByDate[dateStr] || []).push(row["Tide Height (m)"]);
    }
  }
  const out = {};
  for (const dateStr in heightsByDate) {
    const heights = heightsByDate[dateStr];
    if (heights.length >= 2) out[dateStr] = Math.max(...heights) - Math.min(...heights);
  }
  return out;
}


/** Ports extract_sun_times from fetch_conditions.py — same
 * {date, firstLight, sunrise, sunset, lastLight} shape buildDayBandPlugin
 * already expects (see state.data.sunTimes, app.js/live.js/week.js). */
function extractPreviewSunTimes(weather) {
  const days = ((weather.forecasts || {}).sunrisesunset || {}).days || [];
  const out = [];
  for (const day of days) {
    const entries = day.entries || [];
    if (!entries.length) continue;
    const e = entries[0];
    const dateStr = (day.dateTime || "").slice(0, 10);
    if (!dateStr) continue;
    out.push({
      date: dateStr,
      firstLight: e.firstLightDateTime,
      sunrise: e.riseDateTime,
      sunset: e.setDateTime,
      lastLight: e.lastLightDateTime,
    });
  }
  return out;
}


// --- Preview condition scoring ---------------------------------------------
//
// Ports fetch_conditions.py's Location Condition and Fishing Condition
// scoring formulas verbatim (compute_condition/explain_condition,
// compute_fishing_condition/explain_fishing_condition, and everything they
// call) — see that file for the extended reasoning behind each factor's
// weighting; the comments here stay short and point back there rather
// than re-explaining the same formula twice.
//
// attachFishingConditionScores runs ONCE per preview (Fishing Condition
// doesn't depend on Shore/Type at all). attachConditionScores is the one
// that re-runs every time the person changes Shore or Type in the preview
// UI (see previewLocationOnMap/recalcPreviewCondition, app.js) — it never
// needs another network call, since everything it reads (wind, and the
// _currentVelocity/_currentDirection internal fields) is already sitting
// on each row from buildPreviewRows.

function compassToDegrees(direction) {
  if (!direction) return null;
  const deg = COMPASS_DEGREES[String(direction).trim().toUpperCase()];
  return deg == null ? null : deg;
}

function angleDiff(a, b) {
  if (a == null || b == null) return null;
  const raw = Math.abs(a - b);
  return raw > 180 ? 360 - raw : raw;
}

/** Ports land_based_wind_tier — 0 (straight offshore) .. 4 (straight
 * onshore/blown out). math.ceil rounds every in-between 22.5°-step
 * reading into the WORSE of its two neighbouring tiers, same deliberate
 * conservative tie-break as the Python original. */
function landBasedWindTier(shore, windDir) {
  const diff = angleDiff(compassToDegrees(shore), compassToDegrees(windDir));
  if (diff == null) return null;
  return Math.min(4, Math.ceil(diff / 45));
}

/** Ports wind_against_tide_severity — returns [penalty, label]. See the
 * Python original for the full reasoning on the sliding threshold and the
 * partial/direct × small/large-excess tier table. */
function windAgainstTideSeverity(windDir, windSpeed, currentVelocity, currentDirection) {
  if (currentVelocity == null || currentVelocity < 0.3) return [0, null];
  if (currentDirection == null || windSpeed == null) return [0, null];

  const windDeg = compassToDegrees(windDir);
  if (windDeg == null) return [0, null];
  const windTravelDeg = (windDeg + 180) % 360; // direction the wind is blowing TOWARD
  const diff = angleDiff(windTravelDeg, currentDirection);
  if (diff == null || diff <= 90) return [0, null];

  const threshold = Math.max(5, Math.min(10, 10 - currentVelocity * 2.5));
  const excess = windSpeed - threshold;
  if (excess <= 0) return [0, null];

  const direct = diff >= 150;
  const largeExcess = excess >= 5;

  if (direct && largeExcess) return [1.0, "major"];
  if (direct || largeExcess) return [0.5, "medium"];
  return [0.25, "minor"];
}

/** Ports compute_condition — Location Condition, 1-5 or null if there's
 * not enough data (missing shore for Land based, missing wind for Kayak). */
function computeConditionScore(locType, shore, windDir, windSpeed, currentVelocity, currentDirection) {
  if (locType === "Land based") {
    const tier = landBasedWindTier(shore, windDir);
    return tier == null ? null : 5 - tier;
  }
  if (locType === "Kayak") {
    if (windSpeed == null) return null;
    let base;
    if (windSpeed < 5) base = 5;
    else if (windSpeed < 10) base = 4;
    else if (windSpeed < 15) {
      const diff = angleDiff(compassToDegrees(shore), compassToDegrees(windDir));
      if (diff == null) return null;
      base = diff <= 90 ? 4 : 3;
    } else if (windSpeed < 20) base = 2;
    else base = 1;

    const [penalty] = windAgainstTideSeverity(windDir, windSpeed, currentVelocity, currentDirection);
    return Math.max(1, base - penalty);
  }
  return null;
}

/** Ports explain_condition — short human-readable reason, using the exact
 * same tier/severity calculations computeConditionScore does so the two
 * can never disagree. */
function explainConditionScore(locType, shore, windDir, windSpeed, currentVelocity, currentDirection) {
  if (locType === "Land based") {
    const tier = landBasedWindTier(shore, windDir);
    if (tier == null) return "Insufficient wind data";
    return [
      "Straight offshore — clean waves",
      "Mostly offshore — good waves",
      "Cross-shore wind",
      "Mostly onshore — messy surf",
      "Straight onshore — blown out",
    ][tier];
  }
  if (locType === "Kayak") {
    if (windSpeed == null) return "Insufficient wind data";
    let text;
    if (windSpeed < 5) text = `Calm (${windSpeed.toFixed(0)} km/h)`;
    else if (windSpeed < 10) text = `Light wind (${windSpeed.toFixed(0)} km/h)`;
    else if (windSpeed < 15) {
      const diff = angleDiff(compassToDegrees(shore), compassToDegrees(windDir));
      text = diff != null && diff <= 90
        ? `Moderate wind (${windSpeed.toFixed(0)} km/h), from behind/side`
        : `Moderate wind (${windSpeed.toFixed(0)} km/h), from ahead`;
    } else if (windSpeed < 20) text = `Strong wind (${windSpeed.toFixed(0)} km/h)`;
    else text = `Very strong wind (${windSpeed.toFixed(0)} km/h)`;

    const [, severity] = windAgainstTideSeverity(windDir, windSpeed, currentVelocity, currentDirection);
    if (severity) text += ` · wind ${severity} against ${currentVelocity.toFixed(1)}km/h current`;
    return text;
  }
  return null;
}

/**
 * Sets "Condition"/"Condition Reason" on every row for the given
 * type/shore — the ONE thing that changes when the person edits the
 * preview's Shore/Type pickers (Fishing Condition doesn't depend on
 * either). Mutates rows in place and returns them, so callers can either
 * use the return value or just re-render off the same array reference.
 */
function attachConditionScores(rows, locType, shore) {
  for (const row of rows) {
    const windDir = row["Wind Forecast Dir"];
    const windSpeed = row["Wind Forecast (km/h)"];
    const currentVelocity = row._currentVelocity;
    const currentDirection = row._currentDirection;
    row["Condition"] = computeConditionScore(locType, shore, windDir, windSpeed, currentVelocity, currentDirection);
    row["Condition Reason"] = explainConditionScore(locType, shore, windDir, windSpeed, currentVelocity, currentDirection);
  }
  return rows;
}

/** Ports tide_strength_score — MINOR factor, ±0.2 relative to the whole
 * fetched window's own tidal range (needs 3+ days of range data). */
function tideStrengthScoreFn(dateStr, dailyRanges) {
  const entries = Object.entries(dailyRanges);
  if (!(dateStr in dailyRanges) || entries.length < 3) return 0;
  const sorted = entries.slice().sort((a, b) => a[1] - b[1]);
  const n = sorted.length;
  const rank = sorted.findIndex(([d]) => d === dateStr);
  if (rank >= (2 * n) / 3) return 0.2;
  if (rank < n / 3) return -0.2;
  return 0;
}

/** Ports tide_stage_score — DOMINANT factor, ±0.8. */
function tideStageScoreFn(tideStatus) {
  if (tideStatus === "Incoming" || tideStatus === "Outgoing") return 0.8;
  if (tideStatus === "Low" || tideStatus === "High") return -0.8;
  return 0;
}

/** Ports pressure_score — DOMINANT factor, ±0.8, Southern Hemisphere
 * convention (high pressure is good, opposite of Northern Hemisphere
 * freshwater advice). */
function pressureScoreFn(pressureHpa) {
  if (pressureHpa == null) return 0;
  if (pressureHpa >= 1025) return 0.8;
  if (pressureHpa < 1010) return -0.8;
  return 0;
}

/** Ports light_score — MINOR factor, +0.2 within 1hr of sunrise/sunset,
 * +0.1 within 2hrs, never a penalty. */
function lightScoreFn(t, sunriseStr, sunsetStr) {
  let bestDiffHours = null;
  for (const edgeStr of [sunriseStr, sunsetStr]) {
    if (!edgeStr) continue;
    const edgeT = parseNaive(edgeStr);
    if (edgeT == null) continue;
    const diffHours = Math.abs(t - edgeT) / 3600000;
    if (bestDiffHours == null || diffHours < bestDiffHours) bestDiffHours = diffHours;
  }
  if (bestDiffHours == null) return 0;
  if (bestDiffHours <= 1) return 0.2;
  if (bestDiffHours <= 2) return 0.1;
  return 0;
}

/** Ports water_temp_trend_score — MINOR factor, +0.2 if warming day-over-
 * day, -0.1 if cooling (asymmetric on purpose — see the Python original). */
function waterTempTrendScoreFn(dateStr, dailySstAvgs) {
  if (!(dateStr in dailySstAvgs)) return 0;
  const thisT = parseNaive(dateStr + " 00:00:00");
  if (thisT == null) return 0;
  const prevDateStr = new Date(thisT - 86400000).toISOString().slice(0, 10);
  if (!(prevDateStr in dailySstAvgs)) return 0;
  const diff = dailySstAvgs[dateStr] - dailySstAvgs[prevDateStr];
  if (diff > 0.05) return 0.2;
  if (diff < -0.05) return -0.1;
  return 0;
}

function computeFishingConditionScore(dateStr, tideStatus, dailyTideRanges, pressureHpa, t, sunriseStr, sunsetStr, dailySstAvgs) {
  let score = 3.0;
  score += tideStrengthScoreFn(dateStr, dailyTideRanges);
  score += tideStageScoreFn(tideStatus);
  score += pressureScoreFn(pressureHpa);
  score += lightScoreFn(t, sunriseStr, sunsetStr);
  score += waterTempTrendScoreFn(dateStr, dailySstAvgs);
  return Math.max(1.0, Math.min(5.0, Math.round(score * 100) / 100));
}

function explainFishingConditionScore(dateStr, tideStatus, dailyTideRanges, pressureHpa, t, sunriseStr, sunsetStr, dailySstAvgs) {
  const parts = [];
  const ts = tideStrengthScoreFn(dateStr, dailyTideRanges);
  if (ts > 0) parts.push("strong tide");
  else if (ts < 0) parts.push("weak tide");
  const tg = tideStageScoreFn(tideStatus);
  if (tg > 0) parts.push("tide moving");
  else if (tg < 0) parts.push("near slack water");
  const ps = pressureScoreFn(pressureHpa);
  if (ps > 0) parts.push("high pressure");
  else if (ps < 0) parts.push("low pressure");
  const ls = lightScoreFn(t, sunriseStr, sunsetStr);
  if (ls > 0) parts.push("near dawn/dusk");
  const wt = waterTempTrendScoreFn(dateStr, dailySstAvgs);
  if (wt > 0) parts.push("water warming");
  else if (wt < 0) parts.push("water cooling");
  if (parts.length === 0) return "Neutral across all factors";
  const text = parts.join(", ");
  return text[0].toUpperCase() + text.slice(1);
}

/** Sets "Fishing Condition"/"Fishing Condition Reason" on every row —
 * computed once per preview (doesn't depend on Shore/Type at all, unlike
 * Location Condition — see attachConditionScores above). sunByDate is
 * built once here from the sunTimes array already extracted elsewhere. */
function attachFishingConditionScores(rows, sunTimes, dailyTideRanges, pressureByDate, sstByDate) {
  const sunByDate = {};
  for (const s of sunTimes) sunByDate[s.date] = s;
  for (const row of rows) {
    const dateStr = row.dateTime.slice(0, 10);
    const sun = sunByDate[dateStr] || {};
    row["Fishing Condition"] = computeFishingConditionScore(
      dateStr, row["Tide Status"], dailyTideRanges, pressureByDate[dateStr],
      row._t, sun.sunrise, sun.sunset, sstByDate
    );
    row["Fishing Condition Reason"] = explainFishingConditionScore(
      dateStr, row["Tide Status"], dailyTideRanges, pressureByDate[dateStr],
      row._t, sun.sunrise, sun.sunset, sstByDate
    );
  }
}
