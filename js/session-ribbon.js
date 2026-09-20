// session-ribbon.js
// The Reports tab's "Session ribbon": a continuous, horizontally scrolling calendar (three days visible at a time, bounded by the Reports date filters). Each fishing session on it gets the site's own conditions graph for its own location (the same renderConditionsChart Week Ahead and the Location tab use: night shading, tide fill, wind arrows, Location/Fishing condition strips), with the session bar and a dot for every catch (in that species' mark colour) drawn over it.
// Loaded by reports.html after mark-lookup.js, weather-preview.js and chart-render.js. The top half of this file is pure logic (tested in tests/session-ribbon.test.mjs); the bottom half builds the rows, draws, and talks to the page.
//
// Data used (nothing new is stored):
//   - Session marks (type "Session", sessionRole start/end, sessionGroupId) and the Catch marks between them, by time.
//   - The conditions recorded on those marks, carried forward: a value is in force from the mark that sets it until a later mark changes it.
//   - Tide high/low events from WillyWeather (fetchTideExtremaForRange, cached), turned into hourly tide rows. Left out entirely when unavailable.
//   - Hourly wind, temperature and pressure from Open-Meteo's historical archive, and sea temperature from its marine archive.
//   - The site's own scoring (attachConditionScores for Kayak / Land based, attachFishingConditionScores) on those rows.
//   - Light times calculated from the location's latitude/longitude (the stored sun times only cover the forecast window, not past sessions).
// Times are naive local wall-clock milliseconds throughout, like the rest of the site (see parseNaive).
const RIBBON_PAD_MS = 30 * 60000; // axis padding before the start / after the end
const RIBBON_TIME_ZONE = "Australia/Melbourne"; // only used to express calculated sun times as wall-clock time

// ---------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------

/** Groups Session marks (by sessionGroupId) into sessions with the Catch marks that fall between their start and end times, newest first. */
function ribbonBuildSessions(marks) {
  const groups = new Map();
  for (const m of marks) {
    if (m.type !== "Session" || !m.sessionGroupId || !m.dateTime) continue;
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
    const startMark = ms.find((m) => m.sessionRole === "start") || null;
    const endMark = ms.find((m) => m.sessionRole === "end") || null;
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

/** Lays catch dots out so none hide each other: items {x, r} (sorted by x) get a `level` — 0 sits on the bar, higher levels stack above. */
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
const RIBBON_VISIBLE_DAYS = 3;
const RIBBON_MAX_DAYS = 400; // the calendar never grows past this many days (the latest ones are kept)

/** Midnight (naive wall-clock ms) at the start of the day ms falls on. */
function ribbonDayFloor(ms) {
  return Math.floor(ms / RIBBON_DAY_MS) * RIBBON_DAY_MS;
}

/** The calendar's day-aligned span [from, to) and the sessions starting inside it. A missing filter date means "as far as the data goes"; the span is at least the three visible days. Null when there are no sessions. */
function ribbonRange(sessions, dateFrom, dateTo) {
  if (!sessions.length) return null;
  let from = dateFrom ? parseNaive(`${dateFrom}T00:00:00`) : ribbonDayFloor(Math.min(...sessions.map((s) => s.start)));
  let to = dateTo ? parseNaive(`${dateTo}T00:00:00`) + RIBBON_DAY_MS : ribbonDayFloor(Math.max(...sessions.map((s) => s.end))) + RIBBON_DAY_MS;
  if (from == null || to == null || !(to > from)) return null;
  if (to - from < RIBBON_VISIBLE_DAYS * RIBBON_DAY_MS) to = from + RIBBON_VISIBLE_DAYS * RIBBON_DAY_MS;
  if (to - from > RIBBON_MAX_DAYS * RIBBON_DAY_MS) from = to - RIBBON_MAX_DAYS * RIBBON_DAY_MS;
  return { from, to, sessions: sessions.filter((s) => s.start >= from && s.start < to).sort((a, b) => a.start - b.start) };
}

/** The window each session's condition layers cover: the day(s) it spans, trimmed so neighbouring sessions (possibly at other locations) never overlap. Always contains the session itself. */
function ribbonSegmentBounds(sessions) {
  const sorted = [...sessions].sort((a, b) => a.start - b.start);
  return sorted.map((s, i) => {
    let from = ribbonDayFloor(s.start);
    let to = ribbonDayFloor(s.end) + RIBBON_DAY_MS;
    if (i > 0) from = Math.max(from, (sorted[i - 1].end + s.start) / 2);
    if (i < sorted.length - 1) to = Math.min(to, (s.end + sorted[i + 1].start) / 2);
    return { session: s, from: Math.min(from, s.start), to: Math.max(to, s.end) };
  });
}
// ---------------------------------------------------------------------
// Conditions rows (the same shape every other graph on the site uses)
// ---------------------------------------------------------------------

/** Sun times for every date in [from, to] at (lat, lng), in the {date, firstLight, sunrise, sunset, lastLight} shape the day/night shading expects. */
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

/**
 * Builds hourly "rows" (Tide Height, Tide Status, Wind, Temp, Pressure, Water
 * Temp, Location Condition, Fishing Condition) for [from, to] from the
 * historical lookups, using the same building blocks as the Location tab's
 * preview graph (deriveTideStatus, attachFishingConditionScores,
 * attachConditionScores) so scores and shading match the other pages.
 * `raw` = { hourly, marine, tide } as fetched; `tide` is null when the
 * location has no tide data, in which case no tide fields are set at all.
 */
function ribbonBuildRows(raw, from, to, craft, shore, sunTimes) {
  const iso = (ms) => new Date(ms).toISOString().slice(0, 19);
  const lookup = (obj, field) => (obj && obj.time ? openMeteoHourlyLookup(obj.time, obj[field]) : {});
  const speed = lookup(raw.hourly, "windspeed_10m");
  const dirDeg = lookup(raw.hourly, "winddirection_10m");
  const temp = lookup(raw.hourly, "temperature_2m");
  const pressure = lookup(raw.hourly, "pressure_msl");
  const sst = lookup(raw.marine, "sea_surface_temperature");

  const byT = new Map();
  const rowAt = (t) => {
    if (!byT.has(t)) byT.set(t, { dateTime: iso(t), _t: t });
    return byT.get(t);
  };
  for (let t = Math.ceil(from / 3600000) * 3600000; t <= to; t += 3600000) {
    const row = rowAt(t);
    const key = row.dateTime.slice(0, 13).replace("T", " ");
    if (speed[key] != null) row["Wind Forecast (km/h)"] = Math.round(speed[key] * 10) / 10;
    if (dirDeg[key] != null) row["Wind Forecast Dir"] = previewDegreesToCompass(dirDeg[key]);
    if (temp[key] != null) row["Temp Forecast (C)"] = temp[key];
    if (pressure[key] != null) row["Pressure (hPa)"] = Math.round(pressure[key] * 10) / 10;
    if (sst[key] != null) row["Water Temp (C)"] = sst[key];
  }

  const tidal = !!(raw.tide && raw.tide.extrema.length);
  if (tidal) {
    const events = raw.tide.extrema.map((e) => ({ _t: e.t, "Tide Height (m)": e.height }));
    for (const e of raw.tide.extrema) {
      if (e.t < from || e.t > to) continue;
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

/** The row closest in time to t. */
function ribbonNearestRow(rows, t) {
  let best = null;
  for (const r of rows) if (!best || Math.abs(r._t - t) < Math.abs(best._t - t)) best = r;
  return best;
}

// ---------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------

const RIBBON_HEADER_H = 40;
const RIBBON_BAR_Y = 8; // top of the session bar inside the chart area
const RIBBON_BAR_H = 12;

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

/** Recorded (mark-carried) conditions plus, once loaded, the site's own row values at time t — for tooltips and the table. */
function ribbonConditionLines(state, t) {
  const lines = [];
  const row = state.rows ? ribbonNearestRow(state.rows, t) : null;
  if (row) {
    if (row["Tide Height (m)"] != null) lines.push(`Tide: ${row["Tide Height (m)"].toFixed(2)} m${row["Tide Status"] ? ", " + row["Tide Status"].toLowerCase() : ""}`);
    if (row["Wind Forecast (km/h)"] != null) lines.push(`Wind: ${Math.round(row["Wind Forecast (km/h)"])} km/h${row["Wind Forecast Dir"] ? " " + row["Wind Forecast Dir"] : ""}`);
    if (row["Condition"] != null) lines.push(`Location condition ${row["Condition"]}/5 (${state.craft})`);
    if (row["Fishing Condition"] != null) lines.push(`Fishing condition ${Number(row["Fishing Condition"]).toFixed(1)}/5`);
  }
  const rec = ribbonMarkConditionsAt(state.session.marks, t);
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

function ribbonTooltipHtml(state, t, dot) {
  const c = dot.c;
  const head = `<strong>${escapeHtml(c.species || c.name || "Catch")}</strong> · ${ribbonFmtDay(c._t)} ${ribbonFmtTime(c._t)}${c.size != null ? ` · ${c.size} cm` : ""}`;
  return `<div>${head}</div>` + ribbonConditionLines(state, t).map((l) => `<div style="color:var(--grey-700);">${escapeHtml(l)}</div>`).join("");
}

// ---------------------------------------------------------------------
// Page wiring (Reports tab)
// ---------------------------------------------------------------------

let ribbonSessions = [];
let ribbonCraft = "Kayak";
let ribbonMarkLists = [];
let ribbonLocations = [];
let ribbonModel = null; // { range, states, x, pxPerMs, width, rowH }
const ribbonStates = new Map(); // groupId -> { session, seg, raw, rows, sunTimes, chart, craft }
const ribbonLoading = new Set();
let ribbonReady = false;
let ribbonWantInitialScroll = true;
let ribbonScrollTimer = null;

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

function ribbonChip(color, label, shape) {
  const swatch = shape === "bar"
    ? `<span style="width:16px;height:10px;border-radius:3px;background:${color};display:inline-block;"></span>`
    : `<span style="width:11px;height:11px;border-radius:50%;background:${color};display:inline-block;"></span>`;
  return `<span style="display:inline-flex;align-items:center;gap:5px;margin:0 12px 4px 0;font-size:0.78rem;">${swatch}${escapeHtml(label)}</span>`;
}

function ribbonUpdateChrome() {
  const model = ribbonModel;
  if (!model) return;
  const states = model.states;
  const catches = states.reduce((n, s) => n + s.session.catches.length, 0);
  const noTide = states.filter((s) => s.rows && !s.raw.tide).length;
  const loading = states.filter((s) => !s.rows).length;
  const notes = [];
  if (loading) notes.push(`loading conditions for ${loading} session${loading === 1 ? "" : "s"}…`);
  if (noTide) notes.push(`no tide data for ${noTide} session${noTide === 1 ? "" : "s"}, so their tide layer is left out`);
  notes.push("light times are calculated from each location");
  document.getElementById("ribbonSummary").textContent =
    `${states.length} session${states.length === 1 ? "" : "s"}, ${catches} catch${catches === 1 ? "" : "es"} · ${ribbonFmtDay(model.range.from, true)} – ${ribbonFmtDay(model.range.to - 1, true)} (${notes.join("; ")})`;

  const species = Array.from(new Set(states.flatMap((s) => s.session.catches.map((k) => k.species)).filter(Boolean)));
  document.getElementById("ribbonLegend").innerHTML = species.map((sp) => ribbonChip(ribbonSpeciesColor(sp), sp)).join("") + ribbonChip("#1f4e78", "Session", "bar");

  const rows = [];
  for (const s of states) {
    for (const c of s.session.catches) {
      const row = s.rows ? ribbonNearestRow(s.rows, c._t) : null;
      const rec = ribbonMarkConditionsAt(s.session.marks, c._t);
      const wind = row && row["Wind Forecast (km/h)"] != null ? `${Math.round(row["Wind Forecast (km/h)"])} km/h ${row["Wind Forecast Dir"] || ""}` : rec.windSpeed != null ? `${rec.windSpeed} km/h ${rec.windDirection || ""}` : "–";
      const tide = row && row["Tide Height (m)"] != null ? `${row["Tide Height (m)"].toFixed(2)} m ${(row["Tide Status"] || "").toLowerCase()}` : rec.tideCondition || "–";
      rows.push(`<tr><td>${ribbonFmtDay(c._t)}</td><td>${ribbonFmtTime(c._t)}</td><td>${escapeHtml(c.species || "–")}</td><td>${c.size != null ? c.size + " cm" : "–"}</td><td>${escapeHtml(tide)}</td><td>${escapeHtml(wind)}</td><td>${escapeHtml(rec.weatherCondition || "–")}</td></tr>`);
    }
  }
  document.getElementById("ribbonTableBody").innerHTML = rows.length ? rows.join("") : `<tr><td colspan="7" class="footnote">No catches in these sessions.</td></tr>`;
  ribbonUpdateJumpButtons();
}

/** The date/hour header shared by the whole calendar (like Week Ahead's), plus faint day lines running down through the chart area. */
function ribbonHeaderSvg(model, dayPx) {
  const { range, x, width, rowH } = model;
  const labelHours = dayPx >= 576 ? 1 : dayPx >= 288 ? 3 : 6;
  let svg = `<svg width="${width}" height="${RIBBON_HEADER_H + rowH}" style="position:absolute;left:0;top:0;pointer-events:none;" aria-hidden="true">`;
  for (let d = range.from; d < range.to; d += RIBBON_DAY_MS) {
    svg += `<line x1="${x(d)}" x2="${x(d)}" y1="0" y2="${RIBBON_HEADER_H + rowH}" style="stroke:var(--grey-300, #cbd5e1)" stroke-width="1"/>`;
    svg += `<text x="${x(d) + 5}" y="14" font-size="11" font-weight="600" style="fill:var(--grey-700)">${ribbonFmtDay(d)}</text>`;
    for (let h = 0; h < 24; h += labelHours) {
      svg += `<text x="${x(d + h * 3600000) + (h === 0 ? 5 : 0)}" y="32" ${h === 0 ? "" : 'text-anchor="middle"'} font-size="10" style="fill:var(--grey-500)">${String(h).padStart(2, "0")}</text>`;
      if (h > 0) svg += `<line x1="${x(d + h * 3600000)}" x2="${x(d + h * 3600000)}" y1="${RIBBON_HEADER_H - 6}" y2="${RIBBON_HEADER_H}" style="stroke:var(--grey-300, #cbd5e1)"/>`;
    }
  }
  svg += `</svg>`;
  return svg;
}

/** Session bars and catch dots, drawn over the charts. Only the bars/dots take pointer events, so the chart underneath keeps its own hover tooltip. */
function ribbonOverlaySvg(model) {
  const { states, x, width, rowH } = model;
  let svg = `<svg id="ribbonOverlay" width="${width}" height="${rowH}" style="position:absolute;left:0;top:${RIBBON_HEADER_H}px;pointer-events:none;" role="img" aria-label="Fishing sessions and catches">`;
  model.dots = [];
  for (const s of states) {
    const { session } = s;
    const bx = x(session.start);
    const bw = Math.max(3, x(session.end) - bx);
    svg += `<rect data-bar="${escapeHtml(session.groupId)}" x="${bx}" y="${RIBBON_BAR_Y}" width="${bw}" height="${RIBBON_BAR_H}" rx="4" fill="#1f4e78" fill-opacity="0.92" style="pointer-events:all;"/>`;
    if (bw >= 74) svg += `<text x="${bx + 5}" y="${RIBBON_BAR_Y + 9}" font-size="9.5" fill="#ffffff" style="pointer-events:none;">${ribbonFmtTime(session.start)}–${ribbonFmtTime(session.end)}</text>`;

    const sizes = session.catches.map((c) => c.size).filter((v) => v != null);
    const sMin = Math.min(...sizes);
    const sMax = Math.max(...sizes);
    const radiusFor = (c) => (c.size != null && sMax > sMin ? 4.5 + ((c.size - sMin) / (sMax - sMin)) * 4 : 5.5);
    const dots = session.catches.map((c) => ({ c, state: s, x: x(c._t), r: radiusFor(c) }));
    ribbonLayoutDots(dots);
    for (const d of dots) {
      d.y = RIBBON_BAR_Y + RIBBON_BAR_H / 2 + d.level * 12; // on the bar, stacking downward where they'd overlap
      svg += `<circle data-dot="${model.dots.length}" cx="${d.x}" cy="${d.y}" r="${d.r}" fill="${ribbonSpeciesColor(d.c.species)}" style="stroke:var(--white);stroke-width:1.5;pointer-events:all;"/>`;
      model.dots.push(d);
    }
  }
  svg += `</svg>`;
  return svg;
}

function ribbonAttachHover(host, model) {
  const overlay = host.querySelector("#ribbonOverlay");
  const tip = host.querySelector("#ribbonTip");
  const scroll = document.getElementById("ribbonScroll");
  const hide = () => (tip.style.display = "none");
  const place = (px, py, html) => {
    tip.innerHTML = html;
    tip.style.display = "block";
    const visLeft = scroll.scrollLeft + 4;
    const visRight = scroll.scrollLeft + scroll.clientWidth - 4;
    tip.style.left = Math.min(Math.max(visLeft, px + 12), Math.max(visLeft, visRight - tip.offsetWidth)) + "px";
    tip.style.top = RIBBON_HEADER_H + py + 16 + "px";
  };
  const onMove = (e) => {
    const dotEl = e.target.closest && e.target.closest("[data-dot]");
    const barEl = e.target.closest && e.target.closest("[data-bar]");
    const rect = overlay.getBoundingClientRect();
    if (dotEl) {
      const d = model.dots[Number(dotEl.dataset.dot)];
      place(d.x, d.y, ribbonTooltipHtml(d.state, d.c._t, d));
    } else if (barEl) {
      const s = model.states.find((st) => st.session.groupId === barEl.dataset.bar);
      place(e.clientX - rect.left, RIBBON_BAR_Y, `<div><strong>${escapeHtml(s.session.name)}</strong> · ${ribbonFmtDay(s.session.start)} ${ribbonFmtTime(s.session.start)}–${ribbonFmtTime(s.session.end)}</div>${s.locationName ? `<div style="color:var(--grey-700);">${escapeHtml(s.locationName)}</div>` : ""}<div style="color:var(--grey-700);">${s.session.catches.length} catch${s.session.catches.length === 1 ? "" : "es"}</div>`);
    } else {
      hide();
    }
  };
  overlay.addEventListener("pointermove", onMove);
  overlay.addEventListener("pointerdown", onMove);
  overlay.addEventListener("pointerleave", hide);
}

/** Draws (or redraws) one session's chart into its segment box, the way Week Ahead draws a row: the shared renderConditionsChart with the same options. */
function ribbonRenderChart(state) {
  const box = document.querySelector(`[data-ribbon-seg="${CSS.escape(state.session.groupId)}"]`);
  if (!box || !state.raw) return;
  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }
  box.innerHTML = `<canvas role="img" aria-label="Conditions for ${escapeHtml(state.session.name)}"></canvas>`;
  box.style.background = "";
  state.craft = ribbonCraft;
  state.sunTimes = ribbonSunTimesForRange(state.seg.from, state.seg.to, state.session.lat, state.session.lng);
  state.rows = ribbonBuildRows(state.raw, state.seg.from, state.seg.to, ribbonCraft, state.shore, state.sunTimes);
  const tideHeights = state.raw.tide ? state.raw.tide.extrema.map((e) => e.height) : [];
  state.chart = renderConditionsChart({
    canvas: box.querySelector("canvas"),
    rows: state.rows,
    sunTimes: state.sunTimes,
    existingChart: null,
    tideMaxObserved: tideHeights.length ? Math.max(...tideHeights) : null,
    moonPhases: null,
    showDayHeading: false,
    showSunTimes: false,
    compact: true,
    sessionSpan: [{ from: state.session.start, to: state.session.end }],
    xRange: { min: state.seg.from, max: state.seg.to },
    showFirstBoxIcons: true,
  });
}

/** Draws the calendar for the current filters, keeping the scroll position (or centring the newest session the first time). */
function ribbonDraw() {
  const scroll = document.getElementById("ribbonScroll");
  const host = document.getElementById("ribbonHost");
  const body = document.getElementById("ribbonBody");
  const empty = document.getElementById("ribbonEmpty");
  if (!scroll) return;

  const dateFrom = typeof reportsFilters !== "undefined" ? reportsFilters.dateFrom : "";
  const dateTo = typeof reportsFilters !== "undefined" ? reportsFilters.dateTo : "";
  const range = ribbonRange(ribbonSessions, dateFrom, dateTo);
  if (!range || range.sessions.length === 0) {
    empty.textContent = ribbonSessions.length === 0
      ? "No fishing sessions logged yet. Sessions come from the Sync tab's trail import."
      : "No fishing sessions in this date range.";
    empty.style.display = "block";
    body.style.display = "none";
    ribbonModel = null;
    return;
  }
  empty.style.display = "none";
  body.style.display = "block";

  const viewportW = Math.max(300, scroll.clientWidth || 600);
  const dayPx = Math.max(144, viewportW / RIBBON_VISIBLE_DAYS); // three days across, never squeezed below ~6px an hour
  const pxPerMs = dayPx / RIBBON_DAY_MS;
  const x = (t) => (t - range.from) * pxPerMs;
  const totalDays = Math.round((range.to - range.from) / RIBBON_DAY_MS);
  const width = Math.ceil(totalDays * dayPx);
  const rowH = viewportW <= 700 ? 210 : 328; // Week Ahead's row heights

  const segs = ribbonSegmentBounds(range.sessions);
  const states = segs.map((seg) => {
    let st = ribbonStates.get(seg.session.groupId);
    if (!st) {
      st = { session: seg.session, raw: null, rows: null, chart: null };
      ribbonStates.set(seg.session.groupId, st);
    }
    // new bounds (different filters) mean the fetched window may no longer cover the segment
    if (st.raw && (st.raw.window.from > seg.from || st.raw.window.to < seg.to)) {
      st.raw = null;
      st.rows = null;
    }
    if (st.chart) {
      st.chart.destroy();
      st.chart = null;
    }
    st.seg = seg;
    const spot = ribbonLocations.length ? ribbonShoreFor(ribbonLocations, seg.session.lat, seg.session.lng, ribbonCraft) : { name: null, shore: null };
    st.shore = spot.shore;
    st.locationName = spot.name;
    return st;
  });

  const previousLeft = scroll.scrollLeft;
  const model = { range, states, x, pxPerMs, dayPx, width, rowH, viewportW };
  const boxes = states
    .map((s) => {
      const left = x(s.seg.from);
      const w = (s.seg.to - s.seg.from) * pxPerMs;
      return `<div class="ribbon-seg" data-ribbon-seg="${escapeHtml(s.session.groupId)}" style="left:${left}px;top:${RIBBON_HEADER_H}px;width:${w}px;height:${rowH}px;"><span class="footnote" style="position:absolute;left:8px;top:${RIBBON_BAR_Y + RIBBON_BAR_H + 6}px;margin:0;">${s.raw ? "" : "Loading conditions…"}</span></div>`;
    })
    .join("");
  host.style.width = width + "px";
  host.style.height = RIBBON_HEADER_H + rowH + "px";
  host.innerHTML = ribbonHeaderSvg(model, dayPx) + boxes + ribbonOverlaySvg(model) +
    `<div id="ribbonTip" role="status" style="display:none;position:absolute;z-index:5;pointer-events:none;max-width:240px;padding:6px 8px;border-radius:8px;font-size:0.78rem;line-height:1.35;background:var(--white);box-shadow:0 2px 10px rgba(0,0,0,0.3);"></div>`;
  ribbonModel = model;
  ribbonAttachHover(host, model);
  states.forEach((s) => s.raw && ribbonRenderChart(s));
  ribbonUpdateChrome();

  if (ribbonWantInitialScroll) {
    ribbonWantInitialScroll = false;
    ribbonCentreOn(range.sessions[range.sessions.length - 1], false);
  } else {
    scroll.scrollLeft = previousLeft;
  }
  ribbonLoadVisible();
}

/** Scrolls so the session's middle is at the middle of the view. */
function ribbonCentreOn(session, smooth) {
  const scroll = document.getElementById("ribbonScroll");
  if (!scroll || !ribbonModel) return;
  const mid = (session.start + session.end) / 2;
  const left = Math.max(0, ribbonModel.x(mid) - scroll.clientWidth / 2);
  if (smooth) scroll.scrollTo({ left, behavior: "smooth" });
  else scroll.scrollLeft = left;
}

/** The session before/after whichever is (nearest) centred right now; null at the ends. */
function ribbonNeighbour(dir) {
  const scroll = document.getElementById("ribbonScroll");
  if (!scroll || !ribbonModel) return null;
  const centre = ribbonModel.range.from + (scroll.scrollLeft + scroll.clientWidth / 2) / ribbonModel.pxPerMs;
  const sessions = ribbonModel.states.map((s) => s.session);
  const slack = 60000;
  if (dir > 0) return sessions.find((s) => (s.start + s.end) / 2 > centre + slack) || null;
  return [...sessions].reverse().find((s) => (s.start + s.end) / 2 < centre - slack) || null;
}

function ribbonUpdateJumpButtons() {
  document.querySelectorAll("[data-ribbon-page]").forEach((btn) => {
    btn.disabled = !ribbonNeighbour(Number(btn.dataset.ribbonPage));
  });
}

/** Fetches the conditions for sessions on (or a day either side of) the visible dates that haven't been loaded yet. A tide lookup is one billed WillyWeather call per uncached session; cheap when cached. */
async function ribbonLoadVisible() {
  const scroll = document.getElementById("ribbonScroll");
  const model = ribbonModel;
  if (!scroll || !model) return;
  ribbonUpdateJumpButtons();
  const leftT = model.range.from + scroll.scrollLeft / model.pxPerMs - RIBBON_DAY_MS;
  const rightT = model.range.from + (scroll.scrollLeft + scroll.clientWidth) / model.pxPerMs + RIBBON_DAY_MS;
  const todo = model.states.filter((s) => !s.raw && !ribbonLoading.has(s.session.groupId) && s.session.end >= leftT && s.session.start <= rightT);
  if (todo.length === 0) return;
  await Promise.all(
    todo.map(async (state) => {
      const { session, seg } = state;
      ribbonLoading.add(session.groupId);
      try {
        const days = [];
        for (let d = ribbonDayFloor(seg.from); d < seg.to; d += RIBBON_DAY_MS) days.push(naiveDateOnlyStr(d));
        const [hourlies, marines, tide] = await Promise.all([
          Promise.all(days.map((d) => fetchOpenMeteoHistoricalHourly(session.lat, session.lng, d))),
          Promise.all(days.map((d) => fetchOpenMeteoHistoricalMarineHourly(session.lat, session.lng, d))),
          fetchTideExtremaForRange(session.lat, session.lng, seg.from, seg.to),
        ]);
        const merge = (list, fields) => {
          const good = list.filter(Boolean);
          if (!good.length) return null;
          const out = { time: good.flatMap((h) => h.time) };
          for (const f of fields) out[f] = good.flatMap((h) => h[f] || []);
          return out;
        };
        state.raw = {
          hourly: merge(hourlies, ["windspeed_10m", "winddirection_10m", "temperature_2m", "pressure_msl"]),
          marine: merge(marines, ["sea_surface_temperature"]),
          tide,
          window: { from: seg.from, to: seg.to },
        };
        // the box may have been rebuilt while waiting; only draw if this state is still the one on screen
        if (ribbonModel && ribbonModel.states.includes(state)) ribbonRenderChart(state);
      } finally {
        ribbonLoading.delete(session.groupId);
      }
    })
  );
  ribbonUpdateChrome();
}

/** Called by reports.js whenever the report filters change: redraws for the new date range. */
function refreshSessionRibbon() {
  if (!ribbonReady || !document.getElementById("ribbonScroll")) return;
  ribbonWantInitialScroll = true;
  ribbonDraw();
}

async function initSessionRibbon(allMarks) {
  ribbonSessions = ribbonBuildSessions(allMarks);
  if (!document.getElementById("reportRibbonBlock")) return;
  const scroll = document.getElementById("ribbonScroll");
  scroll.addEventListener("scroll", () => {
    ribbonUpdateJumpButtons();
    clearTimeout(ribbonScrollTimer);
    ribbonScrollTimer = setTimeout(ribbonLoadVisible, 200);
  });
  document.querySelectorAll("[data-ribbon-craft]").forEach((btn) =>
    btn.addEventListener("click", () => {
      ribbonCraft = btn.dataset.ribbonCraft;
      document.querySelectorAll("[data-ribbon-craft]").forEach((b) => {
        const on = b.dataset.ribbonCraft === ribbonCraft;
        b.className = on ? "btn-primary" : "btn-secondary";
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      ribbonDraw(); // redraws every loaded chart with the new craft's Location Condition
    })
  );
  document.querySelectorAll("[data-ribbon-page]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const target = ribbonNeighbour(Number(btn.dataset.ribbonPage));
      if (target) ribbonCentreOn(target, true);
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
