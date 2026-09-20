// session-ribbon.js
// The Reports tab's "Session ribbon": a continuous, horizontally scrolling calendar (three days visible at a time, bounded by the Reports date filters). Each fishing session on it gets the site's own conditions graph for its own location (the same renderConditionsChart Week Ahead and the Location tab use: night shading, tide fill, wind arrows, Location/Fishing condition strips), with the session shaded and a dot for every catch (in that species' mark colour) drawn over it.
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
  for (const row of byT.values()) {
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

/**
 * One continuous row list from several sessions' row lists (each already a
 * day-aligned block): concatenated in time order, with an empty row just
 * after each block so the lines and condition strips stop at the block's edge
 * instead of stretching across the days with no session (blocks on consecutive
 * days run straight on, no marker between them).
 */
function ribbonJoinRowBlocks(blocks) {
  const rows = [];
  const sorted = blocks.filter((b) => b.length).sort((a, b) => a[0]._t - b[0]._t);
  sorted.forEach((block, i) => {
    rows.push(...block);
    const last = block[block.length - 1]._t;
    const next = sorted[i + 1] ? sorted[i + 1][0]._t : null;
    const gapAt = last + 60000;
    if (next == null || next - last > 2 * 3600000) rows.push({ dateTime: new Date(gapAt).toISOString().slice(0, 19), _t: gapAt, _break: true }); // _break: renderConditionsChart leaves it out of its hourly bucketing
  });
  return rows;
}

/** The row closest in time to t. */
function ribbonNearestRow(rows, t) {
  let best = null;
  for (const r of rows) if (r["Wind Forecast (km/h)"] != null || r["Tide Height (m)"] != null || r["Condition"] != null) if (!best || Math.abs(r._t - t) < Math.abs(best._t - t)) best = r;
  return best;
}

/**
 * Splits the sessions into runs of segments that each fit in one canvas.
 * Browsers cap a canvas at roughly 16k device pixels, so a very long calendar
 * needs more than one chart; almost always it's a single chart, which is what
 * keeps the graph continuous. A chart starts at its first session's day.
 */
function ribbonChunkSegments(segs, pxPerMs, maxCssPx) {
  const chunks = [];
  for (const seg of segs) {
    const cur = chunks[chunks.length - 1];
    if (cur && (seg.to - cur.from) * pxPerMs <= maxCssPx) {
      cur.segs.push(seg);
      cur.to = Math.max(cur.to, seg.to);
    } else {
      chunks.push({ from: seg.from, to: seg.to, segs: [seg] });
    }
  }
  return chunks;
}

// ---------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------

const RIBBON_HEADER_H = 40;
const RIBBON_DOT_R = 6; // a catch with no recorded length
const RIBBON_DOT_R_MIN = 4.5; // dot radius runs from here (shortest fish in the session) ...
const RIBBON_DOT_R_MAX = 8.5; // ... to here (longest)
const RIBBON_DOT_TOP = 12; // centre of the first row of dots, below the top of the plot

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

function ribbonSessionTooltipHtml(state) {
  const s = state.session;
  const n = s.catches.length;
  return `<div><strong>${escapeHtml(s.name)}</strong> · ${ribbonFmtDay(s.start)} ${ribbonFmtTime(s.start)}–${ribbonFmtTime(s.end)}</div>` +
    (state.locationName ? `<div style="color:var(--grey-700);">${escapeHtml(state.locationName)}</div>` : "") +
    `<div style="color:var(--grey-700);">${n} catch${n === 1 ? "" : "es"}</div>`;
}

function ribbonDotTooltipHtml(state, dot) {
  const c = dot.c;
  const head = `<strong>${escapeHtml(c.species || c.name || "Catch")}</strong> · ${ribbonFmtDay(c._t)} ${ribbonFmtTime(c._t)}${c.size != null ? ` · ${c.size} cm` : ""}`;
  return `<div>${head}</div>` + ribbonConditionLines(state, c._t).map((l) => `<div style="color:var(--grey-700);">${escapeHtml(l)}</div>`).join("");
}

/**
 * Draws the sessions inside the chart itself, so they're part of the graph:
 * the site's green tint over each session, and a dot for every catch along the
 * top (sized by the fish's length when recorded, in that species' mark colour,
 * stacking downward where catches are close together). hitAt(x, y) tells the
 * page what is under a canvas point — a catch dot, else a shaded session — so
 * their tooltips can always be shown (see ribbonWireHover).
 */
function buildRibbonSessionsPlugin(states, onHover) {
  let dots = [];
  let lastChart = null;
  const hitAt = (x, y) => {
    const dot = dots.find((d) => Math.hypot(x - d.x, y - d.y) <= d.r + 4);
    if (dot) return { dot };
    if (lastChart && lastChart.chartArea && y >= lastChart.chartArea.top && y <= lastChart.chartArea.bottom) {
      const t = lastChart.scales.x.getValueForPixel(x);
      const state = states.find((s) => t >= s.session.start && t <= s.session.end);
      if (state) return { session: state };
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
      for (const { session } of states) {
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
      const next = [];
      for (const state of states) {
        const sizes = state.session.catches.map((c) => c.size).filter((v) => v != null);
        const sMin = Math.min(...sizes);
        const sMax = Math.max(...sizes);
        const radiusFor = (c) => (c.size != null && sMax > sMin ? RIBBON_DOT_R_MIN + ((c.size - sMin) / (sMax - sMin)) * (RIBBON_DOT_R_MAX - RIBBON_DOT_R_MIN) : RIBBON_DOT_R);
        const items = state.session.catches.map((c) => ({ c, state, x: px(c._t), r: radiusFor(c) }));
        ribbonLayoutDots(items);
        for (const d of items) {
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
          next.push(d);
        }
      }
      dots = next;    },
  };
}

/** Draws (or redraws) one chart — the shared renderConditionsChart, with the same options Week Ahead uses for a row — for a run of session segments. */
function ribbonRenderChunk(chunk) {
  const box = chunk.box;
  if (!box) return;
  if (chunk.chart) {
    chunk.chart.destroy();
    chunk.chart = null;
  }
  box.innerHTML = `<canvas role="img" aria-label="Conditions and catches for the fishing sessions in this period"></canvas>`;
  const states = chunk.segs.map((seg) => seg.state);
  const blocks = states.map((s) => {
    s.craft = ribbonCraft;
    s.sunTimes = ribbonSunTimesForRange(s.seg.from, s.seg.to, s.session.lat, s.session.lng);
    s.rows = ribbonBuildRows(s.raw, s.seg.from, s.seg.to, ribbonCraft, s.shore, s.sunTimes);
    return s.rows;
  });
  const rows = ribbonJoinRowBlocks(blocks);
  const sunTimes = states.flatMap((s) => s.sunTimes);
  const plugin = buildRibbonSessionsPlugin(states);
  const tideHeights = states.flatMap((s) => (s.raw && s.raw.tide ? s.raw.tide.extrema.map((e) => e.height) : []));
  chunk.chart = renderConditionsChart({
    canvas: box.querySelector("canvas"),
    rows,
    sunTimes,
    existingChart: null,
    tideMaxObserved: tideHeights.length ? Math.max(...tideHeights) : null,
    moonPhases: null,
    showDayHeading: false,
    showSunTimes: false,
    compact: true,
    xRange: { min: chunk.from, max: chunk.to },
    showFirstBoxIcons: true, // once per chart, at its first strip box
    spanGaps: false,
    disableBuiltinEvents: true, // the graph's own hover tip is off until switched on with a 2-second hold, like the other graphs (below)
    extraPlugins: [plugin],
  });
  if (chunk.chart) {
    const canvas = box.querySelector("canvas");
    ribbonWireHover(chunk, canvas, plugin); // catch and session tooltips: always on
    wireHoldToShowTooltip(() => chunk.chart, canvas); // a 2-second press toggles the graph's own tooltip; off by default
  }
}

function ribbonShowTip(chunk, hit, e) {
  const tip = document.getElementById("ribbonTip");
  const scroll = document.getElementById("ribbonScroll");
  if (!tip) return;
  if (!hit) {
    tip.style.display = "none";
    return;
  }
  tip.innerHTML = hit.dot ? ribbonDotTooltipHtml(hit.dot.state, hit.dot) : ribbonSessionTooltipHtml(hit.session);
  tip.style.display = "block";
  const x = chunk.left + e.x;
  const visLeft = scroll.scrollLeft + 4;
  const visRight = scroll.scrollLeft + scroll.clientWidth - 4;
  tip.style.left = Math.min(Math.max(visLeft, x + 12), Math.max(visLeft, visRight - tip.offsetWidth)) + "px";
  tip.style.top = RIBBON_HEADER_H + e.y + 16 + "px";
}

/** Catch and session tooltips follow the pointer over the canvas all the time (independent of the 2-second-hold graph tooltip). */
function ribbonWireHover(chunk, canvas, plugin) {
  const show = (e) => {
    const x = localXFromEvent(e, canvas);
    const y = localYFromEvent(e, canvas);
    ribbonShowTip(chunk, plugin.hitAt(x, y), { x, y });
  };
  canvas.addEventListener("pointermove", show);
  canvas.addEventListener("pointerdown", show);
  canvas.addEventListener("pointerleave", () => ribbonShowTip(chunk, null));
}

// ---------------------------------------------------------------------
// Page wiring (Reports tab)
// ---------------------------------------------------------------------

let ribbonSessions = [];
let ribbonCraft = "Kayak";
let ribbonMarkLists = [];
let ribbonLocations = [];
let ribbonModel = null; // { range, states, chunks, x, pxPerMs, dayPx, width, rowH }
const ribbonStates = new Map(); // groupId -> { session, seg, raw, rows, sunTimes, craft, shore, locationName }
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

function ribbonChip(color, label) {
  return `<span style="display:inline-flex;align-items:center;gap:5px;margin:0 12px 4px 0;font-size:0.78rem;"><span style="width:11px;height:11px;border-radius:50%;background:${color};display:inline-block;"></span>${escapeHtml(label)}</span>`;
}
function ribbonUpdateChrome() {
  const model = ribbonModel;
  if (!model) return;
  const states = model.states;
  const catches = states.reduce((n, s) => n + s.session.catches.length, 0);
  const noTide = states.filter((s) => s.raw && !s.raw.tide).length;
  const loading = states.filter((s) => !s.raw).length;
  const notes = [];
  if (loading) notes.push(`loading conditions for ${loading} session${loading === 1 ? "" : "s"}…`);
  if (noTide) notes.push(`no tide data for ${noTide} session${noTide === 1 ? "" : "s"}, so their tide layer is left out`);
  notes.push("light times are calculated from each location");
  document.getElementById("ribbonSummary").textContent =
    `${states.length} session${states.length === 1 ? "" : "s"}, ${catches} catch${catches === 1 ? "" : "es"} · ${ribbonFmtDay(model.range.from, true)} – ${ribbonFmtDay(model.range.to - 1, true)} (${notes.join("; ")})`;

  const species = Array.from(new Set(states.flatMap((s) => s.session.catches.map((k) => k.species)).filter(Boolean)));
  document.getElementById("ribbonLegend").innerHTML = species.map((sp) => ribbonChip(ribbonSpeciesColor(sp), sp)).join("");

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
function ribbonHeaderSvg(model) {
  const { range, x, width, rowH, dayPx } = model;
  const labelHours = dayPx >= 576 ? 1 : dayPx >= 288 ? 3 : 6;
  let svg = `<svg width="${width}" height="${RIBBON_HEADER_H + rowH}" style="position:absolute;left:0;top:0;pointer-events:none;" aria-hidden="true">`;
  for (let d = range.from; d < range.to; d += RIBBON_DAY_MS) {
    svg += `<line x1="${x(d)}" x2="${x(d)}" y1="0" y2="${RIBBON_HEADER_H}" style="stroke:var(--grey-300, #cbd5e1)" stroke-width="1"/>`;
    svg += `<text x="${x(d) + 5}" y="14" font-size="11" font-weight="600" style="fill:var(--grey-700)">${ribbonFmtDay(d)}</text>`;
    for (let h = 0; h < 24; h += labelHours) {
      svg += `<text x="${x(d + h * 3600000) + (h === 0 ? 5 : 0)}" y="32" ${h === 0 ? "" : 'text-anchor="middle"'} font-size="10" style="fill:var(--grey-500)">${String(h).padStart(2, "0")}</text>`;
      if (h > 0) svg += `<line x1="${x(d + h * 3600000)}" x2="${x(d + h * 3600000)}" y1="${RIBBON_HEADER_H - 6}" y2="${RIBBON_HEADER_H}" style="stroke:var(--grey-300, #cbd5e1)"/>`;
    }
  }
  svg += `</svg>`;
  return svg;
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

  if (ribbonModel) ribbonModel.chunks.forEach((c) => c.chart && c.chart.destroy());
  const viewportW = Math.max(300, scroll.clientWidth || 600);
  const dayPx = Math.max(144, viewportW / RIBBON_VISIBLE_DAYS); // three days across, never squeezed below ~6px an hour
  const pxPerMs = dayPx / RIBBON_DAY_MS;
  const x = (t) => (t - range.from) * pxPerMs;
  const totalDays = Math.round((range.to - range.from) / RIBBON_DAY_MS);
  const width = Math.ceil(totalDays * dayPx);
  const rowH = viewportW <= 700 ? 210 : 328; // Week Ahead's row heights

  const segs = ribbonSegmentBounds(range.sessions).map((seg) => {
    let st = ribbonStates.get(seg.session.groupId);
    if (!st) {
      st = { session: seg.session, raw: null, rows: null };
      ribbonStates.set(seg.session.groupId, st);
    }
    // new bounds (different filters) mean the fetched window may no longer cover the segment
    if (st.raw && (st.raw.window.from > seg.from || st.raw.window.to < seg.to)) st.raw = null;
    st.seg = seg;
    const spot = ribbonLocations.length ? ribbonShoreFor(ribbonLocations, seg.session.lat, seg.session.lng, ribbonCraft) : { name: null, shore: null };
    st.shore = spot.shore;
    st.locationName = spot.name;
    return { ...seg, state: st };
  });
  const maxCssPx = Math.floor(16000 / (window.devicePixelRatio || 1));
  const chunks = ribbonChunkSegments(segs, pxPerMs, maxCssPx).map((c) => ({ ...c, left: x(c.from), width: (c.to - c.from) * pxPerMs, chart: null, box: null }));

  const previousLeft = scroll.scrollLeft;
  const model = { range, states: segs.map((s) => s.state), chunks, x, pxPerMs, dayPx, width, rowH, viewportW };
  host.style.width = width + "px";
  host.style.height = RIBBON_HEADER_H + rowH + "px";
  host.innerHTML = ribbonHeaderSvg(model) +
    chunks.map((c, i) => `<div class="ribbon-seg" data-ribbon-chunk="${i}" style="left:${c.left}px;top:${RIBBON_HEADER_H}px;width:${c.width}px;height:${rowH}px;"></div>`).join("") +
    `<div id="ribbonTip" role="status" style="display:none;position:absolute;z-index:5;pointer-events:none;max-width:240px;padding:6px 8px;border-radius:8px;font-size:0.78rem;line-height:1.35;background:var(--white);box-shadow:0 2px 10px rgba(0,0,0,0.3);"></div>`;
  chunks.forEach((c, i) => {
    c.box = host.querySelector(`[data-ribbon-chunk="${i}"]`);
    ribbonRenderChunk(c); // draws straight away — blank rows hold the place (night shading, sessions) until each session's conditions load
  });
  ribbonModel = model;
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
  const redraw = new Set();
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
        redraw.add(state);
      } finally {
        ribbonLoading.delete(session.groupId);
      }
    })
  );
  // one redraw per chart that gained data (skipped if the calendar was rebuilt while waiting)
  if (ribbonModel === model) {
    model.chunks.filter((c) => c.segs.some((s) => redraw.has(s.state))).forEach(ribbonRenderChunk);
    ribbonUpdateChrome();
  }
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
      ribbonDraw(); // redraws every chart with the new craft's Location Condition
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
