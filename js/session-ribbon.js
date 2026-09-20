// session-ribbon.js
// The Reports tab's "Session ribbon": one chart for one logged fishing session — the session bar, a dot per catch, the tide curve behind, a wind strip scored for the location/craft, and first light / sunrise / sunset / last light markers, all on one shared wall-clock time axis.
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

// ---------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------

const RIBBON_LIGHT_LABELS = { firstLight: "First light", sunrise: "Sunrise", sunset: "Sunset", lastLight: "Last light" };
const RIBBON_TIDE_COLOR = "#2563eb";

function ribbonSpeciesColor(species) {
  return species ? `hsl(${hashStringToHue(species)} 62% 42%)` : "#6b7280";
}

function ribbonFmtTime(ms) {
  return fmtChartTick(ms); // HH:MM, 24-hour
}

function ribbonTicks(from, to, width) {
  const steps = [15, 30, 60, 120, 180, 360].map((m) => m * 60000);
  const maxTicks = Math.max(3, Math.floor(width / 56));
  const step = steps.find((s) => (to - from) / s <= maxTicks) || steps[steps.length - 1];
  const out = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) out.push(t);
  return out;
}

/** Everything known about time t on this chart, for tooltips: tide, scored wind and the recorded (carried-forward) mark conditions. */
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

function ribbonSvg(ctx, width) {
  const { session } = ctx;
  const from = session.start - RIBBON_PAD_MS;
  const to = session.end + RIBBON_PAD_MS;
  const hasTide = !!(ctx.tide && ctx.tide.extrema.length);
  const ml = hasTide ? 40 : 12;
  const mr = 12;
  const plotW = Math.max(60, width - ml - mr);
  const x = (t) => ml + ((t - from) / (to - from)) * plotW;

  const mt = 34; // room for light-marker labels
  const plotH = hasTide ? 170 : 110;
  const barH = 14;
  const barY = mt + plotH - barH - 6;
  const windY = mt + plotH + 6;
  const windH = 22;
  const axisY = windY + windH + 14;
  const totalH = axisY + 8;
  const st = (fill) => `style="fill:${fill}"`;

  let svg = `<svg viewBox="0 0 ${width} ${totalH}" width="${width}" height="${totalH}" role="img" aria-label="Session ribbon: ${escapeHtml(ctx.summary)}" style="display:block;touch-action:pan-y;">`;

  // gridlines + time axis
  for (const t of ribbonTicks(from, to, plotW)) {
    svg += `<line x1="${x(t)}" x2="${x(t)}" y1="${mt}" y2="${windY + windH}" style="stroke:var(--grey-200)" stroke-width="1"/>`;
    svg += `<text x="${x(t)}" y="${axisY}" text-anchor="middle" font-size="10" ${st("var(--grey-500)")}>${ribbonFmtTime(t)}</text>`;
  }

  // tide layer (omitted entirely without tide data)
  const extremaShown = [];
  if (hasTide) {
    const curve = ribbonTideCurve(ctx.tide.extrema, from, to, 5 * 60000);
    if (curve.length > 1) {
      const hs = curve.map((p) => p.h);
      const lo = Math.min(...hs);
      const hi = Math.max(...hs);
      const span = hi - lo || 1;
      const y = (h) => mt + plotH - 8 - ((h - lo) / span) * (plotH - 40);
      const line = curve.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.h).toFixed(1)}`).join("");
      svg += `<path d="${line}L${x(curve[curve.length - 1].t).toFixed(1)},${mt + plotH}L${x(curve[0].t).toFixed(1)},${mt + plotH}Z" fill="${RIBBON_TIDE_COLOR}" fill-opacity="0.12"/>`;
      svg += `<path d="${line}" fill="none" stroke="${RIBBON_TIDE_COLOR}" stroke-width="2" stroke-linejoin="round"/>`;
      svg += `<text x="${ml - 6}" y="${y(hi) + 3}" text-anchor="end" font-size="10" ${st("var(--grey-500)")}>${hi.toFixed(1)}m</text>`;
      svg += `<text x="${ml - 6}" y="${y(lo) + 3}" text-anchor="end" font-size="10" ${st("var(--grey-500)")}>${lo.toFixed(1)}m</text>`;
      for (const e of ctx.tide.extrema) {
        if (e.t < from || e.t > to) continue;
        extremaShown.push(e);
        const ey = y(e.height);
        svg += `<circle cx="${x(e.t)}" cy="${ey}" r="3.5" fill="${RIBBON_TIDE_COLOR}" style="stroke:var(--white)" stroke-width="2"/>`;
        svg += `<text x="${x(e.t)}" y="${e.type === "high" ? ey - 8 : ey + 15}" text-anchor="middle" font-size="10" font-weight="600" ${st("var(--grey-700)")}>${e.type === "high" ? "High" : "Low"} ${ribbonFmtTime(e.t)}</text>`;
      }
    }
  }

  // light markers
  let lightIdx = 0;
  for (const key of ["firstLight", "sunrise", "sunset", "lastLight"]) {
    const t = ctx.sun[key];
    if (t == null || t < from || t > to) continue;
    const ly = 12 + (lightIdx++ % 2) * 11;
    svg += `<line x1="${x(t)}" x2="${x(t)}" y1="${ly + 2}" y2="${windY + windH}" stroke="#d97706" stroke-width="1" stroke-dasharray="3 3"/>`;
    svg += `<text x="${x(t) + 3}" y="${ly}" font-size="9.5" ${st("var(--grey-700)")}>${RIBBON_LIGHT_LABELS[key]} ${ribbonFmtTime(t)}</text>`;
  }

  // session bar
  svg += `<rect x="${x(session.start)}" y="${barY}" width="${Math.max(2, x(session.end) - x(session.start))}" height="${barH}" rx="4" fill="#1f4e78"/>`;
  svg += `<text x="${x(session.start) + 5}" y="${barY + 10.5}" font-size="9.5" fill="#ffffff">${ribbonFmtTime(session.start)}–${ribbonFmtTime(session.end)}</text>`;

  // catch dots (sized by length when recorded), stacked so none hide each other
  const sizes = session.catches.map((c) => c.size).filter((s) => s != null);
  const sMin = Math.min(...sizes);
  const sMax = Math.max(...sizes);
  const radiusFor = (c) => (c.size != null && sMax > sMin ? 5 + ((c.size - sMin) / (sMax - sMin)) * 5 : 6.5);
  const dots = session.catches.map((c) => ({ c, x: x(c._t), r: radiusFor(c) }));
  ribbonLayoutDots(dots);
  const step = 2 * 11.5 + 1;
  for (const d of dots) {
    d.y = barY - d.r - 2 - d.level * step;
    svg += `<circle cx="${d.x}" cy="${d.y}" r="${d.r}" fill="${ribbonSpeciesColor(d.c.species)}" style="stroke:var(--white)" stroke-width="2"/>`;
  }
  ctx._dots = dots;

  // wind strip, coloured by favourability, with a downwind arrow and speed
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
  if (ctx.windCells.length === 0) {
    svg += `<text x="${ml}" y="${windY + 15}" font-size="10" ${st("var(--grey-500)")}>No wind data for this time</text>`;
  }

  svg += `<line id="ribbonCross" x1="0" x2="0" y1="${mt}" y2="${windY + windH}" style="stroke:var(--grey-700);display:none" stroke-width="1"/>`;
  svg += `</svg>`;
  ctx._geom = { ml, plotW, from, to, mt, bottom: windY + windH };
  return svg;
}

function ribbonTooltipHtml(ctx, t, dot) {
  const lines = ribbonConditionLines(ctx, t);
  let head;
  if (dot) {
    const c = dot.c;
    head = `<strong>${escapeHtml(c.species || c.name || "Catch")}</strong> · ${ribbonFmtTime(c._t)}${c.size != null ? ` · ${c.size} cm` : ""}`;
  } else {
    head = `<strong>${ribbonFmtTime(t)}</strong>`;
  }
  return `<div>${head}</div>` + lines.map((l) => `<div style="color:var(--grey-700);">${escapeHtml(l)}</div>`).join("");
}

function ribbonRender(host, ctx) {
  const width = Math.max(300, host.clientWidth || 600);
  host.innerHTML = ribbonSvg(ctx, width) + `<div id="ribbonTip" role="status" style="display:none;position:absolute;z-index:5;pointer-events:none;max-width:240px;padding:6px 8px;border-radius:8px;font-size:0.78rem;line-height:1.35;background:var(--white);box-shadow:0 2px 10px rgba(0,0,0,0.3);"></div>`;
  const svg = host.querySelector("svg");
  const tip = host.querySelector("#ribbonTip");
  const cross = host.querySelector("#ribbonCross");
  const g = ctx._geom;

  const show = (e) => {
    const rect = svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const inside = px >= g.ml && px <= g.ml + g.plotW;
    if (!inside) return hide();
    const t = g.from + ((px - g.ml) / g.plotW) * (g.to - g.from);
    const dot = ctx._dots.find((d) => Math.hypot(px - d.x, py - d.y) <= d.r + 6) || null;
    const tt = dot ? dot.c._t : t;
    cross.setAttribute("x1", dot ? dot.x : px);
    cross.setAttribute("x2", dot ? dot.x : px);
    cross.style.display = "";
    tip.innerHTML = ribbonTooltipHtml(ctx, tt, dot);
    tip.style.display = "block";
    const tipW = tip.offsetWidth;
    const left = Math.min(Math.max(4, (dot ? dot.x : px) + 12), Math.max(4, rect.width - tipW - 4));
    tip.style.left = left + "px";
    tip.style.top = Math.max(4, py - tip.offsetHeight - 10) + "px";
  };
  const hide = () => {
    tip.style.display = "none";
    cross.style.display = "none";
  };
  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointerleave", hide);
}

// ---------------------------------------------------------------------
// Page wiring (Reports tab)
// ---------------------------------------------------------------------

let ribbonSessions = [];
let ribbonCraft = "Kayak";
let ribbonToken = 0; // bumps on every selection so a late lookup can't draw over a newer session
const ribbonCache = new Map(); // groupId -> { hourly, tide, location, shore per craft }

function ribbonSessionLabel(s) {
  const date = new Intl.DateTimeFormat([], { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(s.start));
  const n = s.catches.length;
  return `${date} · ${ribbonFmtTime(s.start)}–${ribbonFmtTime(s.end)} · ${s.name} · ${n} catch${n === 1 ? "" : "es"}`;
}

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

function ribbonBuildCtx(session, extra) {
  const wallDate = (ms) => naiveDateOnlyStr(ms);
  const sun = ribbonSunTimes(wallDate(session.start), session.lat, session.lng);
  const from = session.start - RIBBON_PAD_MS;
  const to = session.end + RIBBON_PAD_MS;
  let windCells = extra.hourly ? ribbonWindCellsFromHourly(extra.hourly, from, to) : [];
  let windSource = "Open-Meteo hourly";
  if (windCells.length === 0) {
    windCells = ribbonWindCellsFromMarks(session.marks, from, to);
    windSource = windCells.length ? "recorded on the marks" : null;
  }
  const n = session.catches.length;
  const summary = `${ribbonSessionLabel(session)}${extra.locationName ? " · " + extra.locationName : ""}`;
  return { session, craft: ribbonCraft, shore: extra.shore || null, tide: extra.tide || null, windCells, windSource, sun, summary, locationName: extra.locationName || null, _n: n };
}

function ribbonUpdateChrome(ctx, loading) {
  const n = ctx.session.catches.length;
  const notes = [];
  if (ctx.session.missingStart) notes.push("no start mark — start taken from the first catch");
  if (ctx.session.missingEnd) notes.push("no end mark — end taken from the last catch");
  if (!ctx.tide && !loading) notes.push("no tide data for this location, so the tide layer is left out");
  if (ctx.windSource) notes.push(`wind: ${ctx.windSource}${ctx.shore ? "" : ctx.craft === "Land based" ? " (Land based scoring needs a shore direction, so it is grey)" : ""}`);
  else if (!loading) notes.push("no wind data for this time");
  notes.push("light times calculated from the location");
  document.getElementById("ribbonSummary").textContent =
    `${ctx.summary}${n === 0 ? " — no catches logged in this session" : ""}${loading ? " — loading conditions…" : ""}` + (notes.length ? ` (${notes.join("; ")})` : "");

  const species = Array.from(new Set(ctx.session.catches.map((c) => c.species).filter(Boolean)));
  const chip = (color, label) => `<span style="display:inline-flex;align-items:center;gap:5px;margin:0 12px 4px 0;font-size:0.78rem;"><span style="width:11px;height:11px;border-radius:50%;background:${color};display:inline-block;"></span>${escapeHtml(label)}</span>`;
  let legend = species.map((s) => chip(ribbonSpeciesColor(s), s)).join("");
  legend += `<span style="display:inline-flex;align-items:center;gap:5px;margin:0 12px 4px 0;font-size:0.78rem;"><span style="width:16px;height:10px;border-radius:3px;background:#1f4e78;display:inline-block;"></span>Session</span>`;
  legend += `<span style="display:inline-flex;align-items:center;gap:4px;margin:0 12px 4px 0;font-size:0.78rem;">Wind for ${escapeHtml(ctx.craft)}: poor ` +
    [1, 2, 3, 4, 5].map((s) => `<span style="width:14px;height:10px;border-radius:2px;display:inline-block;background:var(--cond-${s});"></span>`).join("") + ` best</span>`;
  document.getElementById("ribbonLegend").innerHTML = legend;

  const rows = ctx.session.catches.map((c) => {
    const at = ribbonConditionsAt(ctx, c._t);
    const wind = at.cell ? `${Math.round(at.cell.speed)} km/h ${at.cell.dir || ""}` : at.recorded.windSpeed != null ? `${at.recorded.windSpeed} km/h ${at.recorded.windDirection || ""}` : "–";
    const tide = at.tide ? `${at.tide.height.toFixed(2)} m ${at.tide.rising ? "rising" : "falling"}` : at.recorded.tideCondition || "–";
    return `<tr><td>${ribbonFmtTime(c._t)}</td><td>${escapeHtml(c.species || "–")}</td><td>${c.size != null ? c.size + " cm" : "–"}</td><td>${escapeHtml(tide)}</td><td>${escapeHtml(wind)}</td><td>${escapeHtml(at.recorded.weatherCondition || "–")}</td></tr>`;
  });
  document.getElementById("ribbonTableBody").innerHTML = rows.length ? rows.join("") : `<tr><td colspan="6" class="footnote">No catches in this session.</td></tr>`;
}

async function ribbonShowSelected() {
  const select = document.getElementById("ribbonSessionSelect");
  const session = ribbonSessions.find((s) => s.groupId === select.value);
  const host = document.getElementById("ribbonHost");
  if (!session) return;
  const token = ++ribbonToken;
  const cached = ribbonCache.get(session.groupId);

  const draw = (extra, loading) => {
    if (token !== ribbonToken) return;
    const ctx = ribbonBuildCtx(session, extra);
    ribbonRender(host, ctx);
    ribbonUpdateChrome(ctx, loading);
  };

  if (cached) return draw(cached, false);

  // Immediate draw from the marks alone; conditions fill in as lookups finish.
  const extra = { hourly: null, tide: null, shore: null, locationName: null };
  draw(extra, true);

  const locations = await loadTrackedLocationsForLookup();
  const spot = ribbonShoreFor(locations, session.lat, session.lng, ribbonCraft);
  extra.shore = spot.shore;
  extra.locationName = spot.name;
  extra.locations = locations;
  draw(extra, true);

  const days = [];
  for (let d = naiveDateOnlyStr(session.start - RIBBON_PAD_MS); d <= naiveDateOnlyStr(session.end + RIBBON_PAD_MS); d = naiveDateOnlyStr(parseNaive(`${d}T00:00:00`) + 86400000)) days.push(d);
  const [hourlies, tide] = await Promise.all([
    Promise.all(days.map((d) => fetchOpenMeteoHistoricalHourly(session.lat, session.lng, d))),
    fetchTideExtremaForRange(session.lat, session.lng, session.start - RIBBON_PAD_MS, session.end + RIBBON_PAD_MS),
  ]);
  const good = hourlies.filter(Boolean);
  if (good.length) {
    extra.hourly = { time: good.flatMap((h) => h.time), windspeed_10m: good.flatMap((h) => h.windspeed_10m), winddirection_10m: good.flatMap((h) => h.winddirection_10m) };
  }
  extra.tide = tide;
  ribbonCache.set(session.groupId, extra);
  draw(extra, false);
}

function initSessionRibbon(allMarks) {
  ribbonSessions = ribbonBuildSessions(allMarks);
  const block = document.getElementById("reportRibbonBlock");
  const select = document.getElementById("ribbonSessionSelect");
  const empty = document.getElementById("ribbonEmpty");
  if (!block) return;
  if (ribbonSessions.length === 0) {
    empty.style.display = "block";
    document.getElementById("ribbonBody").style.display = "none";
    return;
  }
  empty.style.display = "none";
  select.innerHTML = ribbonSessions.map((s) => `<option value="${escapeHtml(s.groupId)}">${escapeHtml(ribbonSessionLabel(s))}</option>`).join("");
  select.addEventListener("change", ribbonShowSelected);
  document.querySelectorAll("[data-ribbon-craft]").forEach((btn) =>
    btn.addEventListener("click", () => {
      ribbonCraft = btn.dataset.ribbonCraft;
      document.querySelectorAll("[data-ribbon-craft]").forEach((b) => {
        const on = b.dataset.ribbonCraft === ribbonCraft;
        b.className = on ? "btn-primary" : "btn-secondary";
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      ribbonCache.forEach((extra) => {
        if (extra.locations) {
          const s = ribbonSessions.find((x) => ribbonCache.get(x.groupId) === extra);
          if (s) extra.shore = ribbonShoreFor(extra.locations, s.lat, s.lng, ribbonCraft).shore;
        }
      });
      ribbonShowSelected();
    })
  );
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(ribbonShowSelected, 150);
  });
  ribbonShowSelected();
}
