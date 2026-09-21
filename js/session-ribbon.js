// session-ribbon.js
// The Reports tab's "Session ribbon": one fishing session at a time (the newest first; Previous / Next session step through the rest, within the Reports date filters). The view runs from 12 hours before the first session started to 12 hours after the last one finished, and is the site's own conditions graph for that location (the same renderConditionsChart Week Ahead and the Location tab use: night shading, tide fill, wind arrows, Location/Fishing condition strips), with the session shaded and a dot for every catch (in that species' mark colour) drawn over it. Sessions on the same day at the same place are shown together.
// Loaded by reports.html after mark-lookup.js, weather-preview.js and chart-render.js. The top half of this file is pure logic (tested in tests/session-ribbon.test.mjs); the bottom half builds the rows, draws, and talks to the page.
//
// Data used (nothing new is stored):
//   - Session marks (type "Session Start" / "Session End", sessionGroupId) and the Catch marks between them, by time.
//   - The conditions recorded on those marks, carried forward: a value is in force from the mark that sets it until a later mark changes it.
//   - Tide high/low events from WillyWeather (fetchTideExtremaForRange, cached), turned into hourly tide rows. Left out entirely when unavailable.
//   - Hourly wind, temperature and pressure from Open-Meteo's historical archive, and sea temperature from its marine archive.
//   - The site's own scoring (attachConditionScores for Kayak / Land based, attachFishingConditionScores) on those rows.
//   - Light times calculated from the location's latitude/longitude (the stored sun times only cover the forecast window, not past sessions).
// Times are naive local wall-clock milliseconds throughout, like the rest of the site (see parseNaive).
const RIBBON_TIME_ZONE = "Australia/Melbourne"; // only used to express calculated sun times as wall-clock time

// ---------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------

/** Groups Session marks (by sessionGroupId) into sessions with the Catch marks that fall between their start and end times, newest first. */
function ribbonBuildSessions(marks) {
  const groups = new Map();
  for (const m of marks) {
    if (!isSessionType(m.type) || !m.sessionGroupId || !m.dateTime) continue;
    if (!groups.has(m.sessionGroupId)) groups.set(m.sessionGroupId, []);
    groups.get(m.sessionGroupId).push(m);
  }
  const catches = marks
    .filter((m) => m.type === "Catch" && m.dateTime)
    .map((m) => ({ ...m, _t: parseNaive(m.dateTime) }))
    .filter((m) => m._t != null)
    .sort((a, b) => a._t - b._t);

  const sessions = [];
  for (const [groupId, ms] of groups) {
    const startMark = ms.find((m) => sessionRoleForType(m.type) === "start") || null;
    const endMark = ms.find((m) => sessionRoleForType(m.type) === "end") || null;
    let start = startMark ? parseNaive(startMark.dateTime) : null;
    let end = endMark ? parseNaive(endMark.dateTime) : null;
    if (start == null && end == null) continue;
    const TWELVE_H = 12 * 3600000;
    if (start == null) {
      const before = catches.filter((c) => c._t <= end && c._t >= end - TWELVE_H);
      start = before.length ? before[0]._t : end;
    }
    if (end == null) {
      const after = catches.filter((c) => c._t >= start && c._t <= start + TWELVE_H);
      end = after.length ? after[after.length - 1]._t : start;
    }
    const inSession = catches.filter((c) => c._t >= start && c._t <= end);
    const sessionMarks = ms.map((m) => ({ ...m, _t: parseNaive(m.dateTime) }));
    const anchor = startMark || endMark;
    sessions.push({
      groupId,
      name: String((startMark || endMark).name || "Session").replace(/\s+(start|end)$/i, ""),
      start,
      end,
      missingStart: !startMark,
      missingEnd: !endMark,
      lat: anchor.lat,
      lng: anchor.lng,
      catches: inSession,
      marks: [...sessionMarks, ...inSession].sort((a, b) => a._t - b._t),
    });
  }
  return sessions.sort((a, b) => b.start - a.start);
}

/** The latest non-blank value of `field` on any mark at or before time t — conditions on a mark stay in force until a later mark changes them. `marks` must be sorted by _t. */
function ribbonCarryForward(marks, t, field) {
  let val = null;
  for (const m of marks) {
    if (m._t > t) break;
    if (m[field] != null && m[field] !== "") val = m[field];
  }
  return val;
}

/** The recorded (mark-carried) conditions in force at time t. */
function ribbonMarkConditionsAt(marks, t) {
  const out = {};
  for (const f of ["tideCondition", "tideExtreme", "weatherCondition", "windSpeed", "windDirection", "barometer", "temperature", "waterTemperature"]) {
    const v = ribbonCarryForward(marks, t, f);
    if (v != null) out[f] = v;
  }
  return out;
}

/** Lays catch dots out so none hide each other: items {x, r} (sorted by x) get a `level` — level 0 is the top row, higher levels stack below it. */
function ribbonLayoutDots(items) {
  const lastAtLevel = [];
  for (const it of items) {
    let level = 0;
    while (lastAtLevel[level] && it.x - lastAtLevel[level].x < it.r + lastAtLevel[level].r + 2) level++;
    lastAtLevel[level] = it;
    it.level = level;
  }
  return items;
}

/** A wall-clock ("naive") ms for a UTC instant, expressed in the site's time zone. */
function ribbonLocalWallMs(utcMs) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: RIBBON_TIME_ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
}

/** One sun event (rising or setting at the given zenith angle) on dateStr at (lat, lng), as wall-clock ms; null if the sun never reaches it that day. Standard almanac algorithm, good to about a minute. */
function ribbonSolarEvent(dateStr, lat, lng, zenithDeg, rising) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const rad = Math.PI / 180;
  const N = Math.floor((Date.UTC(y, mo - 1, d) - Date.UTC(y, 0, 0)) / 86400000);
  const lngHour = lng / 15;
  const t = N + ((rising ? 6 : 18) - lngHour) / 24;
  const M = 0.9856 * t - 3.289;
  let L = M + 1.916 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 282.634;
  L = ((L % 360) + 360) % 360;
  let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad;
  RA = ((RA % 360) + 360) % 360;
  RA += Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90;
  RA /= 15;
  const sinDec = 0.39782 * Math.sin(L * rad);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(zenithDeg * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
  if (cosH > 1 || cosH < -1) return null;
  const H = (rising ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad) / 15;
  const T = H + RA - 0.06571 * t - 6.622;
  const UT = (((T - lngHour) % 24) + 24) % 24;
  const base = Date.UTC(y, mo - 1, d) + UT * 3600000;
  for (const k of [0, -1, 1]) {
    const local = ribbonLocalWallMs(base + k * 86400000);
    if (naiveDateOnlyStr(local) === dateStr) return local;
  }
  return null;
}

/** First light, sunrise, sunset and last light (wall-clock ms) for a date at (lat, lng). First/last light = civil twilight (sun 6° below the horizon). */
function ribbonSunTimes(dateStr, lat, lng) {
  return {
    firstLight: ribbonSolarEvent(dateStr, lat, lng, 96, true),
    sunrise: ribbonSolarEvent(dateStr, lat, lng, 90.833, true),
    sunset: ribbonSolarEvent(dateStr, lat, lng, 90.833, false),
    lastLight: ribbonSolarEvent(dateStr, lat, lng, 96, false),
  };
}

const RIBBON_DAY_MS = 86400000;
const RIBBON_VIEW_PAD_MS = 12 * 3600000; // hours shown either side of the sessions

/** Midnight (naive wall-clock ms) at the start of the day ms falls on. */
function ribbonDayFloor(ms) {
  return Math.floor(ms / RIBBON_DAY_MS) * RIBBON_DAY_MS;
}

/** The sessions that started within the report's date filters (a blank filter is open-ended), oldest first. */
function ribbonSessionsInRange(sessions, dateFrom, dateTo) {
  const from = dateFrom ? parseNaive(`${dateFrom}T00:00:00`) : -Infinity;
  const to = dateTo ? parseNaive(`${dateTo}T00:00:00`) + RIBBON_DAY_MS : Infinity;
  return sessions.filter((s) => s.start >= from && s.start < to).sort((a, b) => a.start - b.start);
}

/** What the graph covers for a session (or the sessions of one day and place): 12 hours before the first started to 12 hours after the last finished. */
function ribbonViewWindow(sessions) {
  return {
    from: Math.min(...sessions.map((s) => s.start)) - RIBBON_VIEW_PAD_MS,
    to: Math.max(...sessions.map((s) => s.end)) + RIBBON_VIEW_PAD_MS,
  };
}
/**
 * The graph blocks: one per day AND place. Sessions on the same day at the same place (`locationKey`)
 * share one continuous block — they are just shaded inside it, the graph isn't cut at a session's
 * start or end. A different day or a different place starts a new block, so consecutive days (usually
 * different places) never link up. A block covers the day(s) its sessions span; two blocks on one day
 * (different places) are split midway between the last session of one and the first of the next.
 */
function ribbonSegmentBounds(sessions) {
  const sorted = [...sessions].sort((a, b) => a.start - b.start);
  const groups = [];
  for (const s of sorted) {
    const last = groups[groups.length - 1];
    const dayTo = ribbonDayFloor(s.end) + RIBBON_DAY_MS;
    if (last && s.start < last.dayTo && (s.locationKey || null) === last.locationKey) {
      last.sessions.push(s);
      last.dayTo = Math.max(last.dayTo, dayTo);
    } else {
      groups.push({ sessions: [s], dayFrom: ribbonDayFloor(s.start), dayTo, locationKey: s.locationKey || null });
    }
  }
  const startOf = (g) => Math.min(...g.sessions.map((s) => s.start));
  const endOf = (g) => Math.max(...g.sessions.map((s) => s.end));
  return groups.map((g, i) => {
    let from = g.dayFrom;
    let to = g.dayTo;
    // only blocks that share a day need splitting; different days already meet at midnight
    if (i > 0 && groups[i - 1].dayTo > g.dayFrom) from = Math.max(from, (endOf(groups[i - 1]) + startOf(g)) / 2);
    if (i < groups.length - 1 && groups[i + 1].dayFrom < g.dayTo) to = Math.min(to, (endOf(g) + startOf(groups[i + 1])) / 2);
    return { key: g.sessions.map((s) => s.groupId).join("+"), sessions: g.sessions, from: Math.min(from, startOf(g)), to: Math.max(to, endOf(g)) };
  });
}
// ---------------------------------------------------------------------
// Conditions rows (the same shape every other graph on the site uses)
// ---------------------------------------------------------------------

/** Sun times for every date in [from, to) at (lat, lng), in the {date, firstLight, sunrise, sunset, lastLight} shape the day/night shading expects. */
function ribbonSunTimesForRange(from, to, lat, lng) {
  const fmt = (ms) => (ms == null ? null : new Date(ms).toISOString().slice(0, 19).replace("T", " "));
  const out = [];
  for (let d = ribbonDayFloor(from); d < to; d += RIBBON_DAY_MS) {
    const date = naiveDateOnlyStr(d);
    const t = ribbonSunTimes(date, lat, lng);
    out.push({ date, firstLight: fmt(t.firstLight), sunrise: fmt(t.sunrise), sunset: fmt(t.sunset), lastLight: fmt(t.lastLight) });
  }
  return out;
}

/** The hourly grid [from, to) plus a last row just before `to`, so a day's data runs right up to its midnight without spilling a row into the next day. */
function ribbonRowTimes(from, to) {
  const times = [];
  for (let t = Math.ceil(from / 3600000) * 3600000; t < to; t += 3600000) times.push(t);
  const last = to - 120000; // two minutes short of midnight, leaving room for the block-end row a minute after it (still the same day)
  if (times.length === 0 || times[times.length - 1] < last) times.push(last);
  return times;
}

/**
 * Builds hourly "rows" (Tide Height, Tide Status, Wind, Temp, Pressure, Water
 * Temp, Location Condition, Fishing Condition) for [from, to) from the
 * historical lookups, using the same building blocks as the Location tab's
 * preview graph (deriveTideStatus, attachFishingConditionScores,
 * attachConditionScores) so scores and shading match the other pages.
 * `raw` = { hourly, marine, tide } as fetched; `tide` is null when the
 * location has no tide data, in which case no tide fields are set at all.
 * With `raw` null (conditions not fetched yet) the rows are blank — they hold
 * the place on the graph (day/night shading) but carry no values or scores.
 */
function ribbonBuildRows(raw, from, to, craft, shore, sunTimes) {
  const iso = (ms) => new Date(ms).toISOString().slice(0, 19);
  const byT = new Map();
  const rowAt = (t) => {
    if (!byT.has(t)) byT.set(t, { dateTime: iso(t), _t: t });
    return byT.get(t);
  };
  for (const t of ribbonRowTimes(from, to)) rowAt(t);
  if (!raw) return Array.from(byT.values());

  const lookup = (obj, field) => (obj && obj.time ? openMeteoHourlyLookup(obj.time, obj[field]) : {});
  const speed = lookup(raw.hourly, "windspeed_10m");
  const dirDeg = lookup(raw.hourly, "winddirection_10m");
  const temp = lookup(raw.hourly, "temperature_2m");
  const pressure = lookup(raw.hourly, "pressure_msl");
  const sst = lookup(raw.marine, "sea_surface_temperature");
  const currentKmh = lookup(raw.marine, "ocean_current_velocity"); // only the archive stores these
  const currentDir = lookup(raw.marine, "ocean_current_direction");
  const hasTide = !!(raw.tide && raw.tide.extrema.length);
  for (const row of byT.values()) {
    const key = row.dateTime.slice(0, 13).replace("T", " ");
    if (speed[key] != null) row["Wind Forecast (km/h)"] = Math.round(speed[key] * 10) / 10;
    if (dirDeg[key] != null) row["Wind Forecast Dir"] = previewDegreesToCompass(dirDeg[key]);
    if (temp[key] != null) row["Temp Forecast (C)"] = temp[key];
    if (pressure[key] != null) row["Pressure (hPa)"] = Math.round(pressure[key] * 10) / 10;
    if (sst[key] != null) row["Water Temp (C)"] = sst[key];
    // read by attachConditionScores for the Kayak wind-against-current penalty (tidal locations only, as in the pipeline)
    if (hasTide && currentKmh[key] != null) row._currentVelocity = currentKmh[key];
    if (hasTide && currentDir[key] != null) row._currentDirection = currentDir[key];
  }

  const tidal = !!(raw.tide && raw.tide.extrema.length);
  if (tidal) {
    const events = raw.tide.extrema.map((e) => ({ _t: e.t, "Tide Height (m)": e.height }));
    for (const e of raw.tide.extrema) {
      if (e.t < from || e.t >= to) continue;
      const row = rowAt(e.t);
      row["Tide Height (m)"] = e.height;
      row["Tide Type"] = e.type;
    }
    for (const row of byT.values()) {
      if (row["Tide Height (m)"] == null) {
        const h = interpolatedTideHeightAt(events, row._t);
        if (h != null) row["Tide Height (m)"] = Math.round(h * 100) / 100;
      }
    }
  }
  const rows = Array.from(byT.values()).sort((a, b) => a._t - b._t);
  if (tidal) deriveTideStatus(rows);
  attachFishingConditionScores(rows, sunTimes, tidal ? dailyTideRangesFromRows(rows) : {}, dailyAverageFromHourlyLookup(pressure), dailyAverageFromHourlyLookup(sst));
  attachConditionScores(rows, craft, shore);
  return rows;
}

/** Fraction (0 to 1) of the whole hours in [from, to) that have a stored station wind reading. */
function ribbonStoredCoverage(rows, from, to) {
  const total = Math.floor((to - from) / 3600000);
  if (total <= 0) return 0;
  const have = rows.filter((r) => {
    const t = parseNaive(`${r.hour}:00`);
    return r.windKmh != null && t != null && t >= from && t < to;
  }).length;
  return Math.min(1, have / total);
}

/** Open-Meteo-shaped {hourly, marine} arrays (what ribbonBuildRows reads) from stored observation rows; null when there are none. */
function ribbonStoredToArrays(rows) {
  if (!rows.length) return null;
  const time = rows.map((r) => r.hour.replace(" ", "T"));
  const compass = (d) => (d && COMPASS_DEGREES[d] != null ? COMPASS_DEGREES[d] : null);
  return {
    hourly: {
      time,
      windspeed_10m: rows.map((r) => r.windKmh),
      winddirection_10m: rows.map((r) => compass(r.windDir)),
      temperature_2m: rows.map((r) => r.tempC),
      pressure_msl: rows.map((r) => r.pressureHpa),
    },
    marine: {
      time,
      sea_surface_temperature: rows.map((r) => r.waterTempC),
      ocean_current_velocity: rows.map((r) => r.currentKmh),
      ocean_current_direction: rows.map((r) => r.currentDir),
    },
  };
}

/** The archive rows ("YYYY-MM-DD HH:00", the observations table's shape) for the hours of the window [from, to) in live Open-Meteo arrays; hours with no value at all are left out. */
function ribbonLookupRows(hourly, marine, from, to) {
  const byHour = new Map();
  const at = (list) => {
    const out = [];
    (list && list.time ? list.time : []).forEach((iso, i) => {
      const t = parseNaive(String(iso).replace("T", " ") + ":00");
      if (t != null && t >= from && t < to) out.push({ i, hour: String(iso).replace("T", " ").slice(0, 13) + ":00" });
    });
    return out;
  };
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const compass = (deg) => (num(deg) == null ? null : SHORE_OPTIONS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]);
  const row = (hour) => {
    if (!byHour.has(hour)) byHour.set(hour, { hour, tempC: null, windKmh: null, windDir: null, pressureHpa: null, waterTempC: null, currentKmh: null, currentDir: null });
    return byHour.get(hour);
  };
  for (const { i, hour } of at(hourly)) {
    const r = row(hour);
    r.windKmh = num(hourly.windspeed_10m && hourly.windspeed_10m[i]);
    r.windDir = compass(hourly.winddirection_10m && hourly.winddirection_10m[i]);
    r.tempC = num(hourly.temperature_2m && hourly.temperature_2m[i]);
    r.pressureHpa = num(hourly.pressure_msl && hourly.pressure_msl[i]);
  }
  for (const { i, hour } of at(marine)) {
    const r = row(hour);
    r.waterTempC = num(marine.sea_surface_temperature && marine.sea_surface_temperature[i]);
    r.currentKmh = num(marine.ocean_current_velocity && marine.ocean_current_velocity[i]);
    r.currentDir = num(marine.ocean_current_direction && marine.ocean_current_direction[i]);
  }
  return [...byHour.values()]
    .filter((r) => Object.entries(r).some(([k, v]) => k !== "hour" && v != null))
    .sort((a, b) => (a.hour < b.hour ? -1 : 1));
}

/** Saves what the ribbon had to look up live into the archive (admin only, fire-and-forget: a failure just means it is looked up again next time). */
function ribbonSaveLookups(locationName, observations, tideEvents) {
  if (!locationName || (!observations.length && !tideEvents.length)) return;
  fetch(`${USER_BACKEND_URL}/api/archive/lookups`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location: locationName, observations, tideEvents }),
  }).catch(() => {});
}

/** Live Open-Meteo arrays with the stored ones laid over them: a stored hour wins where it has a value, live fills the rest (empty stored values never override). Either side may be null. */
function ribbonLayerStored(live, stored, fields) {
  if (!stored) return live;
  if (!live) return stored;
  const out = { time: [...live.time, ...stored.time] };
  for (const f of fields) out[f] = [...(live[f] || live.time.map(() => null)), ...(stored[f] || stored.time.map(() => null))];
  return out;
}

/** The row closest in time to t. */
function ribbonNearestRow(rows, t) {
  let best = null;
  for (const r of rows) if (r["Wind Forecast (km/h)"] != null || r["Tide Height (m)"] != null || r["Condition"] != null) if (!best || Math.abs(r._t - t) < Math.abs(best._t - t)) best = r;
  return best;
}

// ---------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------

const RIBBON_HEADER_H = 40;
const RIBBON_DOT_R = 6; // a catch with no recorded length
const RIBBON_DOT_R_MIN = 4.5; // dot radius runs from here (shortest fish in the view) ...
const RIBBON_DOT_R_MAX = 8.5; // ... to here (longest)
const RIBBON_DOT_TOP = 12; // centre of the first row of dots, below the top of the plot
const RIBBON_STORED_ENOUGH = 0.8; // when the archive has a wind reading for at least this share of the window's hours, live Open-Meteo isn't fetched
const RIBBON_HOURLY_FIELDS = ["windspeed_10m", "winddirection_10m", "temperature_2m", "pressure_msl"];
const RIBBON_MARINE_FIELDS = ["sea_surface_temperature", "ocean_current_velocity", "ocean_current_direction"];

function ribbonSpeciesColor(species) {
  const style = markStyleFor({ species, type: "Catch" }, { groupByKey: "species", markLists: ribbonMarkLists });
  return style.fillColor;
}

function ribbonFmtTime(ms) {
  return fmtChartTick(ms); // HH:MM, 24-hour
}

function ribbonFmtDay(ms, withYear) {
  return new Intl.DateTimeFormat([], { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) }).format(new Date(ms));
}

/** The site's own row values at time t (once loaded) plus what was recorded on the marks — for tooltips. */
function ribbonConditionLines(state, session, t) {
  const lines = [];
  const row = state.rows ? ribbonNearestRow(state.rows, t) : null;
  if (row) {
    if (row["Tide Height (m)"] != null) lines.push(`Tide: ${row["Tide Height (m)"].toFixed(2)} m${row["Tide Status"] ? ", " + row["Tide Status"].toLowerCase() : ""}`);
    if (row["Wind Forecast (km/h)"] != null) lines.push(`Wind: ${Math.round(row["Wind Forecast (km/h)"])} km/h${row["Wind Forecast Dir"] ? " " + row["Wind Forecast Dir"] : ""}`);
    if (row["Condition"] != null) lines.push(`Location condition ${row["Condition"]}/5 (${state.craft})`);
    if (row["Fishing Condition"] != null) lines.push(`Fishing condition ${Number(row["Fishing Condition"]).toFixed(1)}/5`);
  }
  const rec = ribbonMarkConditionsAt(session.marks, t);
  if (rec.tideCondition) lines.push(`Tide (recorded): ${rec.tideCondition}${rec.tideExtreme ? " · " + rec.tideExtreme : ""}`);
  if (!row || row["Wind Forecast (km/h)"] == null) {
    if (rec.windSpeed != null) lines.push(`Wind (recorded): ${rec.windSpeed} km/h${rec.windDirection ? " " + rec.windDirection : ""}`);
  }
  const other = [];
  if (rec.weatherCondition) other.push(rec.weatherCondition);
  if (rec.temperature != null) other.push(`${rec.temperature}°C air`);
  if (rec.waterTemperature != null) other.push(`${rec.waterTemperature}°C water`);
  if (rec.barometer != null) other.push(`${rec.barometer} hPa`);
  if (other.length) lines.push(other.join(" · "));
  return lines;
}

function ribbonSessionTooltipHtml(item) {
  const s = item.session;
  const n = s.catches.length;
  return `<div><strong>${escapeHtml(s.name)}</strong> · ${ribbonFmtDay(s.start)} ${ribbonFmtTime(s.start)}–${ribbonFmtTime(s.end)}</div>` +
    `<div style="color:var(--grey-700);">${n} catch${n === 1 ? "" : "es"}</div>`;
}

function ribbonDotTooltipHtml(dot) {
  const c = dot.c;
  const head = `<strong>${escapeHtml(c.species || c.name || "Catch")}</strong> · ${ribbonFmtDay(c._t)} ${ribbonFmtTime(c._t)}${c.size != null ? ` · ${c.size} cm` : ""}`;
  return `<div>${head}</div>` + ribbonConditionLines(dot.state, dot.session, c._t).map((l) => `<div style="color:var(--grey-700);">${escapeHtml(l)}</div>`).join("");
}

/**
 * Draws the sessions inside the chart itself, so they're part of the graph:
 * the site's green tint over each session, and a dot for every catch along the
 * top (sized by the fish's length when recorded, in that species' mark colour,
 * stacking downward where catches are close together). hitAt(x, y) tells the
 * page what is under a canvas point — a catch dot, else a shaded session — so
 * their tooltips can always be shown (see ribbonWireHover).
 */
function buildRibbonSessionsPlugin(items) {
  let dots = [];
  let lastChart = null;
  const hitAt = (x, y) => {
    const dot = dots.find((d) => Math.hypot(x - d.x, y - d.y) <= d.r + 4);
    if (dot) return { dot };
    if (lastChart && lastChart.chartArea && y >= lastChart.chartArea.top && y <= lastChart.chartArea.bottom) {
      const t = lastChart.scales.x.getValueForPixel(x);
      const item = items.find((it) => t >= it.session.start && t <= it.session.end);
      if (item) return { session: item };
    }
    return null;
  };
  return {
    id: "ribbonSessions",
    hitAt,
    beforeDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.x) return;
      ctx.save();
      ctx.fillStyle = "rgba(22, 163, 74, 0.14)";
      for (const { session } of items) {
        const from = Math.max(session.start, scales.x.min);
        const to = Math.min(session.end, scales.x.max);
        if (to <= from) continue;
        const x0 = scales.x.getPixelForValue(from);
        ctx.fillRect(x0, chartArea.top, scales.x.getPixelForValue(to) - x0, chartArea.bottom - chartArea.top);
      }
      ctx.restore();
    },
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.x) return;
      lastChart = chart;
      const px = (t) => scales.x.getPixelForValue(t);
      const all = items.flatMap((it) => it.session.catches.map((c) => ({ c, session: it.session, state: it.state })));
      const sizes = all.map((d) => d.c.size).filter((v) => v != null);
      const sMin = Math.min(...sizes);
      const sMax = Math.max(...sizes);
      const radiusFor = (c) => (c.size != null && sMax > sMin ? RIBBON_DOT_R_MIN + ((c.size - sMin) / (sMax - sMin)) * (RIBBON_DOT_R_MAX - RIBBON_DOT_R_MIN) : RIBBON_DOT_R);
      const next = all.map((d) => ({ ...d, x: px(d.c._t), r: radiusFor(d.c) })).sort((a, b) => a.x - b.x);
      ribbonLayoutDots(next);
      for (const d of next) {
        d.y = chartArea.top + RIBBON_DOT_TOP + d.level * (2 * RIBBON_DOT_R_MAX + 2);
        ctx.save();
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fillStyle = ribbonSpeciesColor(d.c.species);
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
        ctx.restore();
      }
      dots = next;
    },
  };
}

// ---------------------------------------------------------------------
// Page wiring (Reports tab)
// ---------------------------------------------------------------------

let ribbonSessions = [];
let ribbonCraft = "Kayak";
let ribbonMarkLists = [];
let ribbonLocations = [];
let ribbonBlocks = []; // the day/place blocks in time order — one is shown at a time
let ribbonIndex = 0; // which block is showing
let ribbonChart = null;
let ribbonView = null; // { block, width, rowH, x, plugin } for the block on screen
const ribbonStates = new Map(); // block key -> { key, sessions, from, to, raw, rows, sunTimes, craft, shore, locationName }
const ribbonLoading = new Set();
let ribbonReady = false;

function ribbonShoreFor(locations, lat, lng, craft) {
  let nearest = null;
  let best = Infinity;
  for (const l of locations) {
    if (typeof l.lat !== "number" || typeof l.lng !== "number") continue;
    const d = distanceMetersBetween(lat, lng, l.lat, l.lng);
    if (d < best) {
      best = d;
      nearest = l;
    }
  }
  if (!nearest) return { name: null, shore: null };
  const sameSpot = locations.filter((l) => l.name === nearest.name);
  const forCraft = sameSpot.find((l) => l.type === craft) || sameSpot[0] || nearest;
  return { name: displayNameFor(nearest), shore: forCraft.shore || null };
}

function ribbonChip(color, label) {
  return `<span style="display:inline-flex;align-items:center;gap:5px;margin:0 12px 4px 0;font-size:0.78rem;"><span style="width:11px;height:11px;border-radius:50%;background:${color};display:inline-block;"></span>${escapeHtml(label)}</span>`;
}

/** Summary line under the buttons: where, when, how many, and where this session sits in the list. */
function ribbonUpdateChrome() {
  const block = ribbonBlocks[ribbonIndex];
  if (!block) return;
  const sessions = block.sessions;
  const catches = sessions.reduce((n, s) => n + s.catches.length, 0);
  const start = Math.min(...sessions.map((s) => s.start));
  const end = Math.max(...sessions.map((s) => s.end));
  const when = `${ribbonFmtDay(start, true)} ${ribbonFmtTime(start)}–${ribbonDayFloor(end) === ribbonDayFloor(start) ? "" : ribbonFmtDay(end) + " "}${ribbonFmtTime(end)}`;
  const notes = [];
  if (!block.raw) notes.push("loading conditions…");
  else {
    if (!block.raw.tide) notes.push("no tide data for this location, so the tide layer is left out");
    if (block.raw.storedHours) notes.push("using stored station readings");
  }
  notes.push("light times are calculated from the location");
  document.getElementById("ribbonSummary").textContent =
    `${block.locationName || "Unknown location"} · ${when} · ${sessions.length} session${sessions.length === 1 ? "" : "s"}, ${catches} catch${catches === 1 ? "" : "es"} · ${ribbonIndex + 1} of ${ribbonBlocks.length} (${notes.join("; ")})`;

  const species = Array.from(new Set(sessions.flatMap((s) => s.catches.map((k) => k.species)).filter(Boolean)));
  document.getElementById("ribbonLegend").innerHTML = species.map((sp) => ribbonChip(ribbonSpeciesColor(sp), sp)).join("");

  const rows = [];
  for (const session of sessions) {
    for (const c of session.catches) {
      const row = block.rows ? ribbonNearestRow(block.rows, c._t) : null;
      const rec = ribbonMarkConditionsAt(session.marks, c._t);
      const wind = row && row["Wind Forecast (km/h)"] != null ? `${Math.round(row["Wind Forecast (km/h)"])} km/h ${row["Wind Forecast Dir"] || ""}` : rec.windSpeed != null ? `${rec.windSpeed} km/h ${rec.windDirection || ""}` : "–";
      const tide = row && row["Tide Height (m)"] != null ? `${row["Tide Height (m)"].toFixed(2)} m ${(row["Tide Status"] || "").toLowerCase()}` : rec.tideCondition || "–";
      rows.push(`<tr><td>${ribbonFmtDay(c._t)}</td><td>${ribbonFmtTime(c._t)}</td><td>${escapeHtml(c.species || "–")}</td><td>${c.size != null ? c.size + " cm" : "–"}</td><td>${escapeHtml(tide)}</td><td>${escapeHtml(wind)}</td><td>${escapeHtml(rec.weatherCondition || "–")}</td></tr>`);
    }
  }
  document.getElementById("ribbonTableBody").innerHTML = rows.length ? rows.join("") : `<tr><td colspan="7" class="footnote">No catches in this session.</td></tr>`;
  ribbonUpdateButtons();
}

/** Previous/Next are only enabled when there is an earlier/later session to go to. */
function ribbonUpdateButtons() {
  document.querySelectorAll("[data-ribbon-page]").forEach((btn) => {
    const target = ribbonIndex + Number(btn.dataset.ribbonPage);
    btn.disabled = target < 0 || target >= ribbonBlocks.length;
  });
}

/** The time axis over the graph: date labels (a new one at each midnight in view) and hour marks. No place names here — the place is in the summary line. */
function ribbonHeaderSvg(view) {
  const { block, width, rowH, x } = view;
  const hours = (block.to - block.from) / 3600000;
  const stepH = [1, 2, 3, 6].find((h) => (width / hours) * h >= 26) || 6;
  let svg = `<svg width="${width}" height="${RIBBON_HEADER_H + rowH}" style="position:absolute;left:0;top:0;pointer-events:none;" aria-hidden="true">`;
  for (let d = ribbonDayFloor(block.from); d < block.to; d += RIBBON_DAY_MS) {
    const xs = Math.max(0, x(d));
    const xe = Math.min(width, x(d + RIBBON_DAY_MS));
    if (d > block.from) svg += `<line x1="${xs}" x2="${xs}" y1="0" y2="${RIBBON_HEADER_H}" style="stroke:var(--grey-300, #cbd5e1)" stroke-width="1"/>`;
    svg += `<svg x="${xs + 5}" y="0" width="${Math.max(10, xe - xs - 8)}" height="20"><text x="0" y="14" font-size="11" font-weight="600" style="fill:var(--grey-700)">${ribbonFmtDay(d)}</text></svg>`;
  }
  const stepMs = stepH * 3600000;
  for (let t = Math.ceil(block.from / stepMs) * stepMs; t < block.to; t += stepMs) {
    if (x(t) < 10 || x(t) > width - 10) continue; // a label centred on the very edge would be clipped
    const hh = String(new Date(t).getUTCHours()).padStart(2, "0");
    svg += `<text x="${x(t)}" y="32" text-anchor="middle" font-size="10" style="fill:var(--grey-500)">${hh}</text>`;
    svg += `<line x1="${x(t)}" x2="${x(t)}" y1="${RIBBON_HEADER_H - 6}" y2="${RIBBON_HEADER_H}" style="stroke:var(--grey-300, #cbd5e1)"/>`;
  }
  svg += `</svg>`;
  return svg;
}

function ribbonShowTip(hit, e) {
  const tip = document.getElementById("ribbonTip");
  if (!tip || !ribbonView) return;
  if (!hit) {
    tip.style.display = "none";
    return;
  }
  tip.innerHTML = hit.dot ? ribbonDotTooltipHtml(hit.dot) : ribbonSessionTooltipHtml(hit.session);
  tip.style.display = "block";
  tip.style.left = Math.min(Math.max(4, e.x + 12), Math.max(4, ribbonView.width - tip.offsetWidth - 4)) + "px";
  tip.style.top = RIBBON_HEADER_H + e.y + 16 + "px";
}

/** Catch and session tooltips follow the pointer over the canvas all the time (independent of the 2-second-hold graph tooltip). */
function ribbonWireHover(canvas, plugin) {
  const show = (e) => {
    const x = localXFromEvent(e, canvas);
    const y = localYFromEvent(e, canvas);
    ribbonShowTip(plugin.hitAt(x, y), { x, y });
  };
  canvas.addEventListener("pointermove", show);
  canvas.addEventListener("pointerdown", show);
  canvas.addEventListener("pointerleave", () => ribbonShowTip(null));
}

/** Draws the chart for the block on screen — the shared renderConditionsChart, with the same options Week Ahead uses for a row. */
function ribbonRenderChart() {
  const view = ribbonView;
  const box = document.getElementById("ribbonChartBox");
  if (!view || !box) return;
  const block = view.block;
  if (ribbonChart) {
    ribbonChart.destroy();
    ribbonChart = null;
  }
  box.innerHTML = `<canvas role="img" aria-label="Conditions and catches for this fishing session"></canvas>`;
  block.craft = ribbonCraft;
  block.sunTimes = ribbonSunTimesForRange(block.from, block.to, block.sessions[0].lat, block.sessions[0].lng);
  block.rows = ribbonBuildRows(block.raw, block.from, block.to, ribbonCraft, block.shore, block.sunTimes);
  const items = block.sessions.map((session) => ({ session, state: block }));
  const plugin = buildRibbonSessionsPlugin(items);
  view.plugin = plugin;
  const tideHeights = block.raw && block.raw.tide ? block.raw.tide.extrema.map((e) => e.height) : [];
  ribbonChart = renderConditionsChart({
    canvas: box.querySelector("canvas"),
    rows: block.rows,
    sunTimes: block.sunTimes,
    existingChart: null,
    tideMaxObserved: tideHeights.length ? Math.max(...tideHeights) : null,
    moonPhases: null,
    showDayHeading: false,
    showSunTimes: false,
    compact: true,
    xRange: { min: block.from, max: block.to },
    showFirstBoxIcons: true,
    disableBuiltinEvents: true, // the graph's own hover tip is off until switched on with a 2-second hold, like the other graphs (below)
    extraPlugins: [plugin],
  });
  if (ribbonChart) {
    const canvas = box.querySelector("canvas");
    ribbonWireHover(canvas, plugin); // catch and session tooltips: always on
    wireHoldToShowTooltip(() => ribbonChart, canvas); // a 2-second press toggles the graph's own tooltip; off by default
  }
}

/** Rebuilds the list of blocks (one per day and place) from the sessions inside the report's date filters, keeping what's already been loaded. */
function ribbonRebuildBlocks() {
  const dateFrom = typeof reportsFilters !== "undefined" ? reportsFilters.dateFrom : "";
  const dateTo = typeof reportsFilters !== "undefined" ? reportsFilters.dateTo : "";
  const sessions = ribbonSessionsInRange(ribbonSessions, dateFrom, dateTo);
  // each session's place (the nearest tracked location) decides which sessions share a block
  for (const s of sessions) {
    s.spot = ribbonLocations.length ? ribbonShoreFor(ribbonLocations, s.lat, s.lng, ribbonCraft) : { name: null, shore: null };
    s.locationKey = s.spot.name;
  }
  ribbonBlocks = ribbonSegmentBounds(sessions).map((seg) => {
    let st = ribbonStates.get(seg.key);
    if (!st) {
      st = { key: seg.key, raw: null, rows: null };
      ribbonStates.set(seg.key, st);
    }
    const win = ribbonViewWindow(seg.sessions);
    if (st.raw && (st.raw.window.from !== win.from || st.raw.window.to !== win.to)) st.raw = null; // the window changed (e.g. a session was edited)
    st.sessions = seg.sessions;
    st.from = win.from;
    st.to = win.to;
    st.shore = seg.sessions[0].spot.shore;
    st.locationName = seg.sessions[0].spot.name;
    return st;
  });
}

/** Draws the session at ribbonIndex: header, chart and summary. */
function ribbonDraw() {
  const host = document.getElementById("ribbonHost");
  const body = document.getElementById("ribbonBody");
  const empty = document.getElementById("ribbonEmpty");
  if (!host) return;
  if (ribbonBlocks.length === 0) {
    empty.textContent = ribbonSessions.length === 0
      ? "No fishing sessions logged yet. Sessions come from the Sync tab's trail import."
      : "No fishing sessions in this date range.";
    empty.style.display = "block";
    body.style.display = "none";
    ribbonView = null;
    return;
  }
  empty.style.display = "none";
  body.style.display = "block";
  ribbonIndex = Math.min(Math.max(ribbonIndex, 0), ribbonBlocks.length - 1);

  const block = ribbonBlocks[ribbonIndex];
  const width = Math.max(300, host.clientWidth || 600);
  const rowH = width <= 700 ? 210 : 328; // Week Ahead's row heights
  const x = (t) => ((t - block.from) / (block.to - block.from)) * width;
  ribbonView = { block, width, rowH, x, plugin: null };
  host.style.height = RIBBON_HEADER_H + rowH + "px";
  host.innerHTML = ribbonHeaderSvg(ribbonView) +
    `<div id="ribbonChartBox" class="ribbon-seg" style="left:0;top:${RIBBON_HEADER_H}px;width:${width}px;height:${rowH}px;"></div>` +
    `<div id="ribbonTip" role="status" style="display:none;position:absolute;z-index:5;pointer-events:none;max-width:240px;padding:6px 8px;border-radius:8px;font-size:0.78rem;line-height:1.35;background:var(--white);box-shadow:0 2px 10px rgba(0,0,0,0.3);"></div>`;
  ribbonRenderChart(); // draws straight away — blank rows hold the place (night shading, sessions) until the conditions load
  ribbonUpdateChrome();
  ribbonLoadCurrent();
}

/** Fetches the conditions for the session on screen if they haven't been loaded yet. A tide lookup is one billed WillyWeather call per uncached session; cheap when cached. */
async function ribbonLoadCurrent() {
  const block = ribbonBlocks[ribbonIndex];
  if (!block || block.raw || ribbonLoading.has(block.key)) return;
  const { lat, lng } = block.sessions[0];
  ribbonLoading.add(block.key);
  try {
    // The pipeline's archive first: real station readings, and the tide events (fetchTideExtremaForRange looks there
    // itself before making a billed WillyWeather call). Live Open-Meteo is only fetched for what the archive lacks.
    const nearest = await findNearestTrackedLocation(lat, lng);
    const storedRows = nearest ? await fetchStoredObservations(nearest.name, block.from, block.to) : [];
    const stored = ribbonStoredToArrays(storedRows);
    const enough = ribbonStoredCoverage(storedRows, block.from, block.to) >= RIBBON_STORED_ENOUGH;
    let liveHourly = null;
    let liveMarine = null;
    const merge = (list, fields) => {
      const good = list.filter(Boolean);
      if (!good.length) return null;
      const out = { time: good.flatMap((h) => h.time) };
      for (const f of fields) out[f] = good.flatMap((h) => h[f] || []);
      return out;
    };
    const days = [];
    for (let d = ribbonDayFloor(block.from); d < block.to; d += RIBBON_DAY_MS) days.push(naiveDateOnlyStr(d));
    const [hourlies, marines, tide] = await Promise.all([
      enough ? [] : Promise.all(days.map((d) => fetchOpenMeteoHistoricalHourly(lat, lng, d))),
      enough ? [] : Promise.all(days.map((d) => fetchOpenMeteoHistoricalMarineHourly(lat, lng, d))),
      fetchTideExtremaForRange(lat, lng, block.from, block.to),
    ]);
    liveHourly = merge(hourlies, RIBBON_HOURLY_FIELDS);
    liveMarine = merge(marines, RIBBON_MARINE_FIELDS);
    if (nearest && !enough) {
      ribbonSaveLookups(nearest.name, ribbonLookupRows(liveHourly, liveMarine, block.from, block.to), (tide && tide.live) || []);
    } else if (nearest && tide && tide.live) {
      ribbonSaveLookups(nearest.name, [], tide.live);
    }
    block.raw = {
      hourly: ribbonLayerStored(liveHourly, stored && stored.hourly, RIBBON_HOURLY_FIELDS),
      marine: ribbonLayerStored(liveMarine, stored && stored.marine, RIBBON_MARINE_FIELDS),
      tide,
      storedHours: storedRows.length,
      window: { from: block.from, to: block.to },
    };
  } finally {
    ribbonLoading.delete(block.key);
  }
  // redraw only if it is still the session on screen (the person may have moved on while this loaded)
  if (ribbonBlocks[ribbonIndex] === block) {
    ribbonRenderChart();
    ribbonUpdateChrome();
  }
}

/** Called by reports.js whenever the report filters change: back to the newest session in the new date range. */
function refreshSessionRibbon() {
  if (!ribbonReady || !document.getElementById("ribbonHost")) return;
  ribbonRebuildBlocks();
  ribbonIndex = ribbonBlocks.length - 1; // the last session is shown first
  ribbonDraw();
}

async function initSessionRibbon(allMarks) {
  ribbonSessions = ribbonBuildSessions(allMarks);
  if (!document.getElementById("reportRibbonBlock")) return;
  document.querySelectorAll("[data-ribbon-craft]").forEach((btn) =>
    btn.addEventListener("click", () => {
      ribbonCraft = btn.dataset.ribbonCraft;
      document.querySelectorAll("[data-ribbon-craft]").forEach((b) => {
        const on = b.dataset.ribbonCraft === ribbonCraft;
        b.className = on ? "btn-primary" : "btn-secondary";
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      ribbonRebuildBlocks(); // the craft changes which shore direction is used for scoring
      ribbonDraw();
    })
  );
  document.querySelectorAll("[data-ribbon-page]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const target = ribbonIndex + Number(btn.dataset.ribbonPage);
      if (target < 0 || target >= ribbonBlocks.length) return;
      ribbonIndex = target;
      ribbonDraw();
    })
  );
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(ribbonDraw, 200);
  });
  // The species colours are the ones used for marks (Settings' colour formats), and the shore direction comes from the nearest tracked location.
  try {
    [ribbonMarkLists, ribbonLocations] = await Promise.all([fetchUnionedMarkLists(), loadTrackedLocationsForLookup()]);
  } catch (err) {
    console.error("Session ribbon: could not load mark lists / locations:", err);
  }
  ribbonReady = true;
  refreshSessionRibbon();
}
