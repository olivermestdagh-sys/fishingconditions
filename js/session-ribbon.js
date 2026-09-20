// session-ribbon.js
// The Reports tab's "Session ribbon": a continuous, horizontally scrolling calendar (three days visible at a time, bounded by the Reports date filters). Every fishing session on it gets its own layers for its own location — the session bar, a dot per catch, the tide curve behind, a wind strip scored for the location/craft, and first light / sunrise / sunset / last light markers — all on the one shared wall-clock time axis.
// Loaded by reports.html after mark-lookup.js and weather-preview.js (uses their lookups and wind scoring). The top half of this file is pure logic (tested in tests/session-ribbon.test.mjs); the bottom half draws the SVG and talks to the page.
//
// Data used (nothing new is stored):
//   - Session marks (type "Session", sessionRole start/end, sessionGroupId) and the Catch marks between them, by time.
//   - The conditions recorded on those marks, carried forward: a value is in force from the mark that sets it until a later mark changes it.
//   - Tide high/low events from WillyWeather (fetchTideExtremaForRange, cached), joined into a curve. Left out entirely when unavailable.
//   - Hourly wind from Open-Meteo's historical archive, scored with the site's own computeConditionScore (Kayak or Land based). Falls back to the wind recorded on the marks.
//   - Light times are calculated from the location's latitude/longitude (the stored sun times only cover the forecast window, not past sessions).
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

/** Tide height at time t, cosine-interpolated between the surrounding high/low events (the same shape the site's own tide curve uses). Null outside the events. */
function ribbonTideAt(extrema, t) {
  for (let i = 0; i < extrema.length - 1; i++) {
    const a = extrema[i];
    const b = extrema[i + 1];
    if (t >= a.t && t <= b.t) {
      const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
      return { height: a.height + ((b.height - a.height) * (1 - Math.cos(f * Math.PI))) / 2, rising: b.height > a.height };
    }
  }
  return null;
}

/** Tide curve points every stepMs across [from, to]. */
function ribbonTideCurve(extrema, from, to, stepMs) {
  const pts = [];
  for (let t = from; t <= to; t += stepMs) {
    const at = ribbonTideAt(extrema, t);
    if (at) pts.push({ t, h: at.height });
  }
  return pts;
}

/** Hourly Open-Meteo wind ({time[], windspeed_10m[], winddirection_10m[]}) as one-hour cells clipped to [from, to]. */
function ribbonWindCellsFromHourly(hourly, from, to) {
  const cells = [];
  if (!hourly || !Array.isArray(hourly.time)) return cells;
  for (let i = 0; i < hourly.time.length; i++) {
    const speed = hourly.windspeed_10m ? hourly.windspeed_10m[i] : null;
    const deg = hourly.winddirection_10m ? hourly.winddirection_10m[i] : null;
    const t = parseNaive(String(hourly.time[i]).length === 16 ? `${hourly.time[i]}:00` : hourly.time[i]);
    if (t == null || speed == null) continue;
    const t0 = Math.max(from, t - 1800000);
    const t1 = Math.min(to, t + 1800000);
    if (t1 <= t0) continue;
    cells.push({ t0, t1, speed, dir: deg == null ? null : previewDegreesToCompass(deg) });
  }
  return cells;
}

/** Fallback wind cells from the marks themselves: each recorded wind holds until the next mark that records one. */
function ribbonWindCellsFromMarks(marks, from, to) {
  const withWind = marks.filter((m) => m.windSpeed != null);
  const cells = [];
  for (let i = 0; i < withWind.length; i++) {
    const t0 = Math.max(from, withWind[i]._t);
    const t1 = Math.min(to, i + 1 < withWind.length ? withWind[i + 1]._t : to);
    if (t1 > t0) cells.push({ t0, t1, speed: withWind[i].windSpeed, dir: withWind[i].windDirection || null });
  }
  return cells;
}

/** Wind favourability 1 (poor) – 5 (best) for a craft type at a shore, using the site's own Location Condition scoring. Null when it can't be scored. */
function ribbonWindScore(craft, shore, dir, speed) {
  return computeConditionScore(craft, shore, dir, speed, null, null);
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
// Drawing
// ---------------------------------------------------------------------

const RIBBON_LIGHT_INFO = {
  firstLight: { label: "First light", strong: false },
  sunrise: { label: "Sunrise", strong: true },
  sunset: { label: "Sunset", strong: true },
  lastLight: { label: "Last light", strong: false },
};
const RIBBON_TIDE_COLOR = "#2563eb";

function ribbonSpeciesColor(species) {
  return species ? `hsl(${hashStringToHue(species)} 62% 42%)` : "#6b7280";
}

function ribbonFmtTime(ms) {
  return fmtChartTick(ms); // HH:MM, 24-hour
}

function ribbonFmtDay(ms, withYear) {
  return new Intl.DateTimeFormat([], { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) }).format(new Date(ms));
}

/** One session's drawing context: its conditions data (whatever has loaded so far) resolved for the current craft. */
function ribbonBuildCtx(session, extra, seg) {
  const sun = [];
  for (let d = ribbonDayFloor(seg.from); d < seg.to; d += RIBBON_DAY_MS) {
    const times = ribbonSunTimes(naiveDateOnlyStr(d), session.lat, session.lng);
    for (const key of Object.keys(RIBBON_LIGHT_INFO)) {
      if (times[key] != null && times[key] >= seg.from && times[key] <= seg.to) sun.push({ key, t: times[key] });
    }
  }
  let windCells = extra.hourly ? ribbonWindCellsFromHourly(extra.hourly, seg.from, seg.to) : [];
  let windSource = "Open-Meteo hourly";
  if (windCells.length === 0) {
    // recorded wind only speaks for the session itself (plus a little padding), not the rest of the day
    windCells = ribbonWindCellsFromMarks(session.marks, Math.max(seg.from, session.start - RIBBON_PAD_MS), Math.min(seg.to, session.end + RIBBON_PAD_MS));
    windSource = windCells.length ? "recorded on the marks" : null;
  }
  const spot = extra.locations ? ribbonShoreFor(extra.locations, session.lat, session.lng, ribbonCraft) : { name: null, shore: null };
  return { session, seg, craft: ribbonCraft, shore: spot.shore, locationName: spot.name, tide: extra.tide || null, windCells, windSource, sun, loaded: !!extra.done };
}

/** Everything known about time t in one session's segment, for tooltips: tide, scored wind and the recorded (carried-forward) mark conditions. */
function ribbonConditionsAt(ctx, t) {
  const tide = ctx.tide ? ribbonTideAt(ctx.tide.extrema, t) : null;
  const cell = ctx.windCells.find((c) => t >= c.t0 && t <= c.t1) || null;
  const score = cell ? ribbonWindScore(ctx.craft, ctx.shore, cell.dir, cell.speed) : null;
  return { tide, cell, score, recorded: ribbonMarkConditionsAt(ctx.session.marks, t) };
}

function ribbonConditionLines(ctx, t) {
  const c = ribbonConditionsAt(ctx, t);
  const lines = [];
  if (c.tide) lines.push(`Tide: ${c.tide.height.toFixed(2)} m, ${c.tide.rising ? "rising" : "falling"}`);
  const rec = c.recorded;
  if (rec.tideCondition) lines.push(`Tide (recorded): ${rec.tideCondition}${rec.tideExtreme ? " · " + rec.tideExtreme : ""}`);
  if (c.cell) {
    lines.push(`Wind: ${Math.round(c.cell.speed)} km/h${c.cell.dir ? " " + c.cell.dir : ""}${c.score != null ? ` · ${c.score}/5 for ${ctx.craft}` : ""}`);
  } else if (rec.windSpeed != null) {
    lines.push(`Wind (recorded): ${rec.windSpeed} km/h${rec.windDirection ? " " + rec.windDirection : ""}`);
  }
  const other = [];
  if (rec.weatherCondition) other.push(rec.weatherCondition);
  if (rec.temperature != null) other.push(`${rec.temperature}°C air`);
  if (rec.waterTemperature != null) other.push(`${rec.waterTemperature}°C water`);
  if (rec.barometer != null) other.push(`${rec.barometer} hPa`);
  if (other.length) lines.push(other.join(" · "));
  return lines;
}

/**
 * The whole scrolling calendar as one SVG, plus the fixed tide-axis labels.
 * Layout is fixed-height rows (light labels/day headers, the plot with the
 * tide and session bar, the wind strip, the hour axis); horizontally, three
 * days fill the visible width. Returns { svg, axisSvg, model } where model
 * holds what the hover/tap handler needs (dots, light lines, segments).
 */
function ribbonTimelineSvg(range, ctxs, viewportW) {
  const withTide = ctxs.some((c) => c.tide);
  const ml = withTide ? 40 : 8;
  const mr = 12;
  const dayPx = Math.max(90, (viewportW - ml) / RIBBON_VISIBLE_DAYS);
  const pxPerMs = dayPx / RIBBON_DAY_MS;
  const x = (t) => ml + (t - range.from) * pxPerMs;
  const totalDays = Math.round((range.to - range.from) / RIBBON_DAY_MS);
  const width = Math.ceil(ml + totalDays * dayPx + mr);

  const mt = 26;
  const plotH = withTide ? 170 : 110;
  const barH = 14;
  const barY = mt + plotH - barH - 6;
  const windY = mt + plotH + 6;
  const windH = 22;
  const axisY = windY + windH + 14;
  const height = axisY + 8;
  const st = (fill) => `style="fill:${fill}"`;
  const labelHours = dayPx >= 576 ? 1 : dayPx >= 288 ? 3 : 6;
  const showTideLabels = dayPx >= 288;

  let svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Session ribbon calendar, ${totalDays} days" style="display:block;">`;

  // day grid, day headers, hour labels
  for (let d = range.from; d < range.to; d += RIBBON_DAY_MS) {
    svg += `<line x1="${x(d)}" x2="${x(d)}" y1="${mt - 6}" y2="${windY + windH}" style="stroke:var(--grey-300, #cbd5e1)" stroke-width="1"/>`;
    svg += `<text x="${x(d) + 5}" y="14" font-size="11" font-weight="600" ${st("var(--grey-700)")}>${ribbonFmtDay(d)}</text>`;
    for (let h = labelHours; h < 24; h += labelHours) {
      svg += `<line x1="${x(d + h * 3600000)}" x2="${x(d + h * 3600000)}" y1="${mt}" y2="${windY + windH}" style="stroke:var(--grey-200)" stroke-width="1"/>`;
      svg += `<text x="${x(d + h * 3600000)}" y="${axisY}" text-anchor="middle" font-size="10" ${st("var(--grey-500)")}>${String(h).padStart(2, "0")}</text>`;
    }
    svg += `<text x="${x(d)}" y="${axisY}" text-anchor="middle" font-size="10" ${st("var(--grey-500)")}>00</text>`;
  }

  // one tide scale shared by every session shown, so curves are comparable
  const curves = ctxs.map((c) => (c.tide ? ribbonTideCurve(c.tide.extrema, c.seg.from, c.seg.to, 5 * 60000) : []));
  const allH = curves.flat().map((p) => p.h);
  const lo = allH.length ? Math.min(...allH) : 0;
  const hi = allH.length ? Math.max(...allH) : 1;
  const span = hi - lo || 1;
  const yTide = (h) => mt + plotH - 22 - ((h - lo) / span) * (plotH - 58); // leaves room for the low-tide label above the wind strip

  const model = { x, ml, width, mt, bottom: windY + windH, dots: [], lights: [], segs: [], from: range.from, to: range.to, dayPx };

  ctxs.forEach((ctx, idx) => {
    const { session } = ctx;
    model.segs.push({ ctx, from: ctx.seg.from, to: ctx.seg.to });

    // tide layer (omitted entirely without tide data)
    const curve = curves[idx];
    if (curve.length > 1) {
      const line = curve.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${yTide(p.h).toFixed(1)}`).join("");
      svg += `<path d="${line}L${x(curve[curve.length - 1].t).toFixed(1)},${mt + plotH}L${x(curve[0].t).toFixed(1)},${mt + plotH}Z" fill="${RIBBON_TIDE_COLOR}" fill-opacity="0.12"/>`;
      svg += `<path d="${line}" fill="none" stroke="${RIBBON_TIDE_COLOR}" stroke-width="2" stroke-linejoin="round"/>`;
      for (const e of ctx.tide.extrema) {
        if (e.t < ctx.seg.from || e.t > ctx.seg.to) continue;
        const ey = yTide(e.height);
        svg += `<circle cx="${x(e.t)}" cy="${ey}" r="3.5" fill="${RIBBON_TIDE_COLOR}" style="stroke:var(--white)" stroke-width="2"/>`;
        model.lights.push({ x: x(e.t), y: ey, text: `${e.type === "high" ? "High" : "Low"} tide ${ribbonFmtTime(e.t)} · ${e.height.toFixed(2)} m`, radius: 7 });
        if (showTideLabels) {
          svg += `<text x="${x(e.t)}" y="${e.type === "high" ? ey - 8 : ey + 15}" text-anchor="middle" font-size="10" font-weight="600" ${st("var(--grey-700)")}>${e.type === "high" ? "High" : "Low"} ${ribbonFmtTime(e.t)}</text>`;
        }
      }
    }

    // light markers: strong dashes for sunrise/sunset, lighter for first/last light
    for (const s of ctx.sun) {
      const info = RIBBON_LIGHT_INFO[s.key];
      svg += `<line x1="${x(s.t)}" x2="${x(s.t)}" y1="${mt}" y2="${windY + windH}" stroke="#d97706" stroke-opacity="${info.strong ? 0.95 : 0.5}" stroke-width="${info.strong ? 1.5 : 1}" stroke-dasharray="3 3"/>`;
      model.lights.push({ x: x(s.t), y: null, text: `${info.label} ${ribbonFmtTime(s.t)}`, radius: 4 });
    }

    // session bar
    const bx = x(session.start);
    const bw = Math.max(3, x(session.end) - bx);
    svg += `<rect x="${bx}" y="${barY}" width="${bw}" height="${barH}" rx="4" fill="#1f4e78"/>`;
    if (bw >= 74) svg += `<text x="${bx + 5}" y="${barY + 10.5}" font-size="9.5" fill="#ffffff">${ribbonFmtTime(session.start)}–${ribbonFmtTime(session.end)}</text>`;
    model.lights.push({ x: bx + bw / 2, y: barY + barH / 2, text: `${session.name} · ${ribbonFmtTime(session.start)}–${ribbonFmtTime(session.end)}${ctx.locationName ? " · " + ctx.locationName : ""}`, radius: bw / 2 + 2, bar: true });

    // catch dots, sized by length when recorded, stacked so none hide each other
    const sizes = session.catches.map((c) => c.size).filter((s) => s != null);
    const sMin = Math.min(...sizes);
    const sMax = Math.max(...sizes);
    const radiusFor = (c) => (c.size != null && sMax > sMin ? 4.5 + ((c.size - sMin) / (sMax - sMin)) * 4 : 5.5);
    const dots = session.catches.map((c) => ({ c, ctx, x: x(c._t), r: radiusFor(c) }));
    ribbonLayoutDots(dots);
    for (const d of dots) {
      d.y = barY - d.r - 2 - d.level * 11.5;
      svg += `<circle cx="${d.x}" cy="${d.y}" r="${d.r}" fill="${ribbonSpeciesColor(d.c.species)}" style="stroke:var(--white)" stroke-width="1.5"/>`;
      model.dots.push(d);
    }

    // wind strip coloured by favourability, with a downwind arrow and speed where there's room
    for (const cell of ctx.windCells) {
      const score = ribbonWindScore(ctx.craft, ctx.shore, cell.dir, cell.speed);
      const x0 = x(cell.t0);
      const w = x(cell.t1) - x0;
      svg += `<rect x="${x0}" y="${windY}" width="${Math.max(1, w - 1)}" height="${windH}" rx="2" style="fill:${score == null ? "var(--grey-300, #cbd5e1)" : `var(--cond-${Math.min(5, Math.max(1, Math.round(score)))})`}"/>`;
      if (w >= 30) {
        const rot = cell.dir ? (COMPASS_DEGREES[cell.dir] + 180) % 360 : null;
        if (rot != null) svg += `<path d="M0,-6 L4,4 L0,2 L-4,4Z" transform="translate(${x0 + 9},${windY + windH / 2}) rotate(${rot})" fill="#1f2937"/>`;
        svg += `<text x="${x0 + (rot != null ? 17 : 4)}" y="${windY + 14.5}" font-size="10" font-weight="600" fill="#1f2937">${Math.round(cell.speed)}</text>`;
      }
    }
  });

  svg += `<line id="ribbonCross" x1="0" x2="0" y1="${mt - 6}" y2="${windY + windH}" style="stroke:var(--grey-700);display:none" stroke-width="1"/>`;
  svg += `</svg>`;

  let axisSvg = "";
  if (withTide) {
    axisSvg = `<svg width="${ml}" height="${height}" style="display:block;">` +
      `<text x="${ml - 5}" y="${yTide(hi) + 3}" text-anchor="end" font-size="10" ${st("var(--grey-500)")}>${hi.toFixed(1)}m</text>` +
      `<text x="${ml - 5}" y="${yTide(lo) + 3}" text-anchor="end" font-size="10" ${st("var(--grey-500)")}>${lo.toFixed(1)}m</text></svg>`;
  }
  return { svg, axisSvg, model, ml };
}

function ribbonTooltipHtml(ctx, t, dot) {
  const lines = ribbonConditionLines(ctx, t);
  let head;
  if (dot) {
    const c = dot.c;
    head = `<strong>${escapeHtml(c.species || c.name || "Catch")}</strong> · ${ribbonFmtDay(c._t)} ${ribbonFmtTime(c._t)}${c.size != null ? ` · ${c.size} cm` : ""}`;
  } else {
    head = `<strong>${ribbonFmtDay(t)} ${ribbonFmtTime(t)}</strong>${ctx.locationName ? ` · ${escapeHtml(ctx.locationName)}` : ""}`;
  }
  return `<div>${head}</div>` + lines.map((l) => `<div style="color:var(--grey-700);">${escapeHtml(l)}</div>`).join("");
}

// ---------------------------------------------------------------------
// Page wiring (Reports tab)
// ---------------------------------------------------------------------

let ribbonSessions = [];
let ribbonCraft = "Kayak";
let ribbonModel = null; // last drawn model, for hover/tap and for finding visible sessions
let ribbonCache = new Map(); // groupId -> { hourly, tide, locations, window, done }
const ribbonLoading = new Set();
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

function ribbonUpdateChrome(range, ctxs) {
  const catches = ctxs.reduce((n, c) => n + c.session.catches.length, 0);
  const noTide = ctxs.filter((c) => c.loaded && !c.tide).length;
  const loading = ctxs.filter((c) => !c.loaded).length;
  const notes = [];
  if (loading) notes.push(`loading conditions for ${loading} session${loading === 1 ? "" : "s"}…`);
  if (noTide) notes.push(`no tide data for ${noTide} session${noTide === 1 ? "" : "s"}, so their tide layer is left out`);
  const noWind = ctxs.filter((c) => c.loaded && !c.windSource).length;
  if (noWind) notes.push(`no wind data for ${noWind}`);
  notes.push("light times are calculated from each location");
  document.getElementById("ribbonSummary").textContent =
    `${ctxs.length} session${ctxs.length === 1 ? "" : "s"}, ${catches} catch${catches === 1 ? "" : "es"} · ${ribbonFmtDay(range.from, true)} – ${ribbonFmtDay(range.to - 1, true)} (${notes.join("; ")})`;

  const species = Array.from(new Set(ctxs.flatMap((c) => c.session.catches.map((k) => k.species)).filter(Boolean)));
  let legend = species.map((s) => ribbonChip(ribbonSpeciesColor(s), s)).join("");
  legend += ribbonChip("#1f4e78", "Session", "bar");
  legend += `<span style="display:inline-flex;align-items:center;gap:5px;margin:0 12px 4px 0;font-size:0.78rem;"><span style="width:14px;border-top:2px solid ${RIBBON_TIDE_COLOR};display:inline-block;"></span>Tide</span>`;
  legend += `<span style="display:inline-flex;align-items:center;gap:5px;margin:0 12px 4px 0;font-size:0.78rem;"><span style="width:14px;border-top:2px dashed #d97706;display:inline-block;"></span>Sunrise/sunset <span style="width:14px;border-top:1px dashed #d97706;opacity:0.6;display:inline-block;"></span>first/last light</span>`;
  legend += `<span style="display:inline-flex;align-items:center;gap:4px;margin:0 12px 4px 0;font-size:0.78rem;">Wind for ${escapeHtml(ribbonCraft)}: poor ` +
    [1, 2, 3, 4, 5].map((s) => `<span style="width:14px;height:10px;border-radius:2px;display:inline-block;background:var(--cond-${s});"></span>`).join("") + ` best</span>`;
  document.getElementById("ribbonLegend").innerHTML = legend;

  const rows = [];
  for (const ctx of ctxs) {
    for (const c of ctx.session.catches) {
      const at = ribbonConditionsAt(ctx, c._t);
      const wind = at.cell ? `${Math.round(at.cell.speed)} km/h ${at.cell.dir || ""}` : at.recorded.windSpeed != null ? `${at.recorded.windSpeed} km/h ${at.recorded.windDirection || ""}` : "–";
      const tide = at.tide ? `${at.tide.height.toFixed(2)} m ${at.tide.rising ? "rising" : "falling"}` : at.recorded.tideCondition || "–";
      rows.push(`<tr><td>${ribbonFmtDay(c._t)}</td><td>${ribbonFmtTime(c._t)}</td><td>${escapeHtml(c.species || "–")}</td><td>${c.size != null ? c.size + " cm" : "–"}</td><td>${escapeHtml(tide)}</td><td>${escapeHtml(wind)}</td><td>${escapeHtml(at.recorded.weatherCondition || "–")}</td></tr>`);
    }
  }
  document.getElementById("ribbonTableBody").innerHTML = rows.length ? rows.join("") : `<tr><td colspan="7" class="footnote">No catches in these sessions.</td></tr>`;
}

function ribbonAttachHover(host, model) {
  const svg = host.querySelector("svg");
  const tip = host.querySelector("#ribbonTip");
  const cross = host.querySelector("#ribbonCross");
  const scroll = document.getElementById("ribbonScroll");
  const hide = () => {
    tip.style.display = "none";
    cross.style.display = "none";
  };
  const show = (e) => {
    const rect = svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const t = model.from + (px - model.ml) / model.dayPx * RIBBON_DAY_MS;
    if (t < model.from || t > model.to) return hide();
    const dot = model.dots.find((d) => Math.hypot(px - d.x, py - d.y) <= d.r + 6) || null;
    const mark = dot ? null : model.lights.find((l) => (l.bar ? Math.abs(px - l.x) <= l.radius && py >= model.bottom - 62 && py <= model.bottom - 26 : l.y == null ? Math.abs(px - l.x) <= l.radius : Math.hypot(px - l.x, py - l.y) <= l.radius)) || null;
    const seg = model.segs.find((s) => t >= s.from && t <= s.to) || null;
    let html;
    let ax = px;
    if (dot) {
      html = ribbonTooltipHtml(dot.ctx, dot.c._t, dot);
      ax = dot.x;
    } else if (mark) {
      html = `<div><strong>${escapeHtml(mark.text)}</strong></div>`;
      ax = mark.x;
    } else if (seg) {
      html = ribbonTooltipHtml(seg.ctx, t, null);
    } else {
      return hide();
    }
    cross.setAttribute("x1", ax);
    cross.setAttribute("x2", ax);
    cross.style.display = "";
    tip.innerHTML = html;
    tip.style.display = "block";
    const visLeft = scroll.scrollLeft + 4;
    const visRight = scroll.scrollLeft + scroll.clientWidth - 4;
    const w = tip.offsetWidth;
    tip.style.left = Math.min(Math.max(visLeft, ax + 12), Math.max(visLeft, visRight - w)) + "px";
    tip.style.top = Math.max(4, py - tip.offsetHeight - 10) + "px";
  };
  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointerleave", hide);
}

/** Draws the calendar for the current filters, keeping the scroll position (or jumping to the newest session the first time). */
function ribbonDraw() {
  const scroll = document.getElementById("ribbonScroll");
  const host = document.getElementById("ribbonHost");
  const axis = document.getElementById("ribbonAxis");
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

  const segs = ribbonSegmentBounds(range.sessions);
  const ctxs = segs.map((seg) => ribbonBuildCtx(seg.session, ribbonCache.get(seg.session.groupId) || {}, seg));
  const previousLeft = scroll.scrollLeft;
  const built = ribbonTimelineSvg(range, ctxs, Math.max(300, scroll.clientWidth || 600));
  host.innerHTML = built.svg + `<div id="ribbonTip" role="status" style="display:none;position:absolute;z-index:5;pointer-events:none;max-width:240px;padding:6px 8px;border-radius:8px;font-size:0.78rem;line-height:1.35;background:var(--white);box-shadow:0 2px 10px rgba(0,0,0,0.3);"></div>`;
  host.style.width = built.model.width + "px";
  axis.innerHTML = built.axisSvg;
  axis.style.display = built.axisSvg ? "block" : "none";
  ribbonModel = built.model;
  ribbonModel.range = range;
  ribbonModel.ctxs = ctxs;
  ribbonAttachHover(host, built.model);
  ribbonUpdateChrome(range, ctxs);

  if (ribbonWantInitialScroll) {
    ribbonWantInitialScroll = false;
    const newest = range.sessions[range.sessions.length - 1];
    // put the newest session's day in the middle of the three visible
    scroll.scrollLeft = Math.max(0, built.model.x(ribbonDayFloor(newest.start)) - built.model.dayPx - built.ml);
  } else {
    scroll.scrollLeft = previousLeft;
  }
  ribbonLoadVisible();
}

/** Fetches wind/tide for the sessions on (or a day either side of) the visible dates that haven't been loaded yet. Cheap for cached ones; a tide lookup is one billed WillyWeather call per uncached session. */
async function ribbonLoadVisible() {
  const scroll = document.getElementById("ribbonScroll");
  const model = ribbonModel;
  if (!scroll || !model) return;
  const leftT = model.from + ((scroll.scrollLeft - model.ml) / model.dayPx) * RIBBON_DAY_MS - RIBBON_DAY_MS;
  const rightT = model.from + ((scroll.scrollLeft + scroll.clientWidth - model.ml) / model.dayPx) * RIBBON_DAY_MS + RIBBON_DAY_MS;
  const todo = model.segs.filter((s) => {
    const cached = ribbonCache.get(s.ctx.session.groupId);
    const fresh = cached && cached.done && cached.window.from <= s.from && cached.window.to >= s.to;
    return !fresh && !ribbonLoading.has(s.ctx.session.groupId) && s.ctx.session.end >= leftT && s.ctx.session.start <= rightT;
  });
  if (todo.length === 0) return;
  const locations = await loadTrackedLocationsForLookup();
  await Promise.all(
    todo.map(async ({ ctx, from, to }) => {
      const session = ctx.session;
      ribbonLoading.add(session.groupId);
      try {
        const days = [];
        for (let d = ribbonDayFloor(from); d < to; d += RIBBON_DAY_MS) days.push(naiveDateOnlyStr(d));
        const [hourlies, tide] = await Promise.all([
          Promise.all(days.map((d) => fetchOpenMeteoHistoricalHourly(session.lat, session.lng, d))),
          fetchTideExtremaForRange(session.lat, session.lng, from, to),
        ]);
        const good = hourlies.filter(Boolean);
        ribbonCache.set(session.groupId, {
          hourly: good.length ? { time: good.flatMap((h) => h.time), windspeed_10m: good.flatMap((h) => h.windspeed_10m), winddirection_10m: good.flatMap((h) => h.winddirection_10m) } : null,
          tide,
          locations,
          window: { from, to },
          done: true,
        });
      } finally {
        ribbonLoading.delete(session.groupId);
      }
    })
  );
  ribbonDraw();
}

/** Called by reports.js on load, and again whenever the report filters change: redraws for the new date range. */
let ribbonReady = false;
function refreshSessionRibbon() {
  if (!ribbonReady || !document.getElementById("ribbonScroll")) return;
  ribbonWantInitialScroll = true;
  ribbonDraw();
}

function initSessionRibbon(allMarks) {
  ribbonSessions = ribbonBuildSessions(allMarks);
  if (!document.getElementById("reportRibbonBlock")) return;
  ribbonReady = true;
  const scroll = document.getElementById("ribbonScroll");
  scroll.addEventListener("scroll", () => {
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
      ribbonDraw();
    })
  );
  document.querySelectorAll("[data-ribbon-page]").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (!ribbonModel) return;
      scroll.scrollBy({ left: Number(btn.dataset.ribbonPage) * RIBBON_VISIBLE_DAYS * ribbonModel.dayPx, behavior: "smooth" });
    })
  );
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(ribbonDraw, 150);
  });
  refreshSessionRibbon();
}
