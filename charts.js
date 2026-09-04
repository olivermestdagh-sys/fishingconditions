// Shared between conditions.html (app.js), live.html (live.js), and index.html
// (week.js) — one implementation of the combined temp/wind/rain/tide chart
// with day/night banding, so every page renders it identically and bug
// fixes only need to happen once.

function parseNaive(iso) {
  // Parse "YYYY-MM-DDTHH:MM:SS" (or with a space) into a timezone-neutral ms value,
  // treated as UTC purely for arithmetic/positioning.
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

function dayKeyOf(iso) {
  return iso.slice(0, 10); // "YYYY-MM-DD"
}

function formatDayHeading(dayKey) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat([], { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(dt);
}

function fmtChartTick(ms) {
  return new Intl.DateTimeFormat([], { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
}

/**
 * X-AXIS TICK LABELS ONLY — deliberately separate from fmtChartTick above,
 * which stays exactly as it is for its OTHER callers (tide extrema
 * markers, sunrise/sunset labels) that still want exact HH:MM precision,
 * not just the hour. This one is just the bare hour, two digits, no
 * minutes, no colon — per Oliver's own request.
 *
 * Uses 1-24 rather than the more usual 0-23: midnight reads as "24" (the
 * closing hour of the day it belongs to on this chart, immediately after
 * "23") rather than "00" (which would visually read as the OPENING hour
 * of the day that's about to start) — same convention some rail
 * timetables use for a day's last hour. "00" never appears anywhere on
 * this axis. If this reads wrong once it's actually on screen, it's a
 * one-line revert (just drop the `=== 0 ? 24 :` swap below) — flagging
 * this explicitly since "should midnight be 00 or 24" was a real,
 * debatable interpretation of the request, not an obvious one.
 */
function fmtAxisHourTick(ms) {
  const hour = new Date(ms).getUTCHours(); // naive-UTC convention, same as every other time helper here
  const displayHour = hour === 0 ? 24 : hour;
  return String(displayHour).padStart(2, "0");
}

/**
 * Small self-contained SVG icon for a location type — used on window
 * cards, the location dropdown, and the Live page's type picker. Hand-drawn
 * shapes, no external image assets, consistent with everything else on
 * this site being self-contained. Colored (not just currentColor outlines)
 * for better differentiation at a glance. Tested directly in the browser
 * at real render sizes (14–32px) — kept deliberately simple at small
 * sizes, since more detail (a full cockpit + paddle + reels on the kayak)
 * blurred into an indistinct blob below ~24px in testing.
 */
function typeIconSvg(type, size) {
  size = size || 16;
  if (type === "Kayak") {
    // Elongated hull + two rods angled outward from distinct mounting
    // points, reading as a fishing kayak rather than a plain kayak.
    return `<svg viewBox="0 0 32 24" width="${size}" height="${size}">
      <path d="M2 16 Q9 12.5 16 12.5 Q23 12.5 30 16 Q23 19 16 19 Q9 19 2 16 Z" fill="#f97316" stroke="#c2410c" stroke-width="0.8"/>
      <line x1="17" y1="14" x2="27" y2="3" stroke="#78350f" stroke-width="1.6" stroke-linecap="round"/>
      <line x1="15" y1="15" x2="5" y2="4" stroke="#78350f" stroke-width="1.6" stroke-linecap="round"/>
    </svg>`;
  }
  // Land based: a rod holder planted in the ground, a rod at an angle,
  // reel, and the line arcing out to the water.
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}">
    <path d="M1 20 L9 20" stroke="#a8a29e" stroke-width="2" stroke-linecap="round"/>
    <path d="M13 20 Q16 18.5 19 20 Q21 21 23 20" fill="none" stroke="#38bdf8" stroke-width="1.3" stroke-linecap="round"/>
    <rect x="7.3" y="14" width="1.4" height="6.5" rx="0.6" fill="#57534e"/>
    <line x1="8" y1="15" x2="20" y2="4" stroke="#92400e" stroke-width="1.2" stroke-linecap="round"/>
    <circle cx="10.3" cy="12.6" r="1" fill="#44403c"/>
    <path d="M20 4 Q19 10 17.5 19" stroke="#0ea5e9" stroke-width="0.6" fill="none" stroke-dasharray="0.5 1"/>
  </svg>`;
}

const COMPASS_DEGREES = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

// Shared with locationsadmin.js's location editor (moved here so the
// Location tab's preview Shore/Type pickers — see the "Preview condition
// scoring" section below — use the exact same lists rather than a second,
// driftable copy).
const TYPE_OPTIONS = ["Kayak", "Land based"];
const SHORE_OPTIONS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

function dirToArrowRotation(dirText) {
  if (!dirText) return 0;
  const deg = COMPASS_DEGREES[String(dirText).trim().toUpperCase()];
  if (deg == null) return 0;
  // Arrow points downwind (the direction the wind is blowing toward), which is
  // the compass "from" direction plus 180°. Chart.js triangle rotation: 0 = pointing up/north.
  return (deg + 180) % 360;
}

function windColor(speed) {
  if (speed == null) return "#9ca3af";
  if (speed < 10) return "#22c55e";
  if (speed < 20) return "#a5de37";
  if (speed < 30) return "#eab308";
  if (speed < 40) return "#f97316";
  return "#dc2626";
}

// Chart.js has no built-in "arrow" point style (only triangle, circle, etc.), so draw a real
// arrowhead — a bold dart/chevron shape, pointing up by default — onto a small offscreen canvas
// per color, and use that as a custom pointStyle. Chart.js rotates/positions a canvas
// pointStyle exactly like a built-in one, so dirToArrowRotation's angle math still applies
// unchanged. Cached per color+filled combo since there are only a handful of distinct
// wind-speed colors × the two forecast/realtime styles below.
const ARROW_CANVAS_CACHE = new Map();

/**
 * filled=true (Wind Realtime — an actual observed reading) draws a solid
 * dart. filled=false (Wind Forecast — a prediction, not yet a fact) draws
 * the same silhouette as an outline only — the forecast/realtime
 * distinction applied to every marker on this site's charts now (see the
 * datasets in renderConditionsChart below): hollow for "this is a
 * forecast", solid for "this actually happened".
 */
function makeArrowCanvas(color, filled = true) {
  const cacheKey = `${color}|${filled}`;
  if (ARROW_CANVAS_CACHE.has(cacheKey)) return ARROW_CANVAS_CACHE.get(cacheKey);
  const size = 20; // was 14 — bigger markers across the board, per Oliver's request
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const cx = size / 2;

  // A bold arrowhead/dart shape — the concave notch at the back is what
  // reads clearly as "an arrowhead" at this size, rather than the thin
  // needle-with-small-tip look a full shaft+small-triangle combo gives.
  // Same proportions as the old 14px version, just scaled up to 20px.
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx + 7, 15.7);
  ctx.lineTo(cx, 11.4);
  ctx.lineTo(cx - 7, 15.7);
  ctx.closePath();

  if (filled) {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  ARROW_CANVAS_CACHE.set(cacheKey, canvas);
  return canvas;
}

const DAY_BAND_COLORS = ["rgba(31, 78, 120, 0.055)", "rgba(31, 78, 120, 0)"];
const NIGHT_BAND_COLOR = "rgba(15, 23, 42, 0.10)";
const TWILIGHT_BAND_COLOR = "rgba(15, 23, 42, 0.05)";

// Condition strips — Location Condition and Fishing Condition are drawn as two
// thin colour-coded horizontal bands beneath the graph, rather than as more
// lines sharing the same axis as temperature/wind/rain/tide. Two derived 1-5
// scores don't read well as continuous lines next to six lines of raw
// weather data — a strip (like a UV-index or pollen bar) is a clearer, more
// compact way to show "how good was it" at a glance without adding visual
// competition to the actual data.
//
// TWO SEPARATE gradients, not one continuous 1-5 rainbow: below 3.0 is
// unambiguously "not acceptable" (red -> deep orange), and 3.0-5.0 is
// unambiguously "acceptable" (light green -> deep green) — Oliver's own
// threshold (3.0 = acceptable) is exactly where the colour FAMILY changes,
// deliberately, rather than partway through a smooth blend that used to
// put yellow right on top of the number people scan for most. A single
// continuous gradient (the old approach) would still leave a value like
// 2.7 looking part-way toward green on its way up to 3 — this doesn't:
// nothing below 3.0 ever contains any green, nothing at or above 3.0 ever
// contains any orange/red. CONDITION_COLORS (badges elsewhere — Week
// Ahead tiles, Live's current-condition badge) reads the SAME --cond-1..5
// CSS variables in style.css, which are set to match these exact stops at
// each whole number, so a badge showing "3.0" and this strip both agree.
const CONDITION_ZONE_BAD = { lo: [220, 38, 38], hi: [234, 88, 12] };   // 1.0 -> just under 3.0: red -> deep orange
const CONDITION_ZONE_GOOD = { lo: [134, 239, 172], hi: [21, 128, 61] }; // 3.0 -> 5.0: light green -> deep green
const CONDITION_NONE_COLOR = "rgb(156, 163, 175)"; // --cond-none

function conditionStripColor(value) {
  if (value == null) return CONDITION_NONE_COLOR;
  const clamped = Math.max(1, Math.min(5, value));
  const zone = clamped >= 3 ? CONDITION_ZONE_GOOD : CONDITION_ZONE_BAD;
  const [loBound, hiBound] = clamped >= 3 ? [3, 5] : [1, 3];
  const t = (clamped - loBound) / (hiBound - loBound);
  const [r1, g1, b1] = zone.lo;
  const [r2, g2, b2] = zone.hi;
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Compact "°C" / "km/h" unit labels at the top corners of the plot area,
 * replacing Chart.js's built-in rotated axis titles — those reserve a full
 * extra margin column on the left/right no matter how short the text is,
 * which on a narrow phone screen is real plotting space lost to a label a
 * couple of characters could convey just as well. Drawn just inside the
 * chart area's top corners instead, costing no extra margin at all.
 */
function buildAxisUnitLabelsPlugin() {
  return {
    id: "axisUnitLabels",
    afterDraw(chart) {
      const { ctx, chartArea } = chart;
      if (!chartArea) return;
      const { top, left, right } = chartArea;
      ctx.save();
      ctx.font = "600 9px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillStyle = "#6b7280";
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ctx.fillText("°C", left + 3, top + 2);
      ctx.textAlign = "right";
      ctx.fillText("km/h", right - 3, top + 2);
      ctx.restore();
    },
  };
}

/**
 * Small black canvas-drawn icons for the very first box of each condition
 * strip (see buildConditionStripsPlugin's showFirstBoxIcons option) — a
 * one-time visual legend so what the "Loc"/"Fish" strips and their colors
 * mean is recognizable without needing to read the small row labels.
 * Hand-drawn with Canvas path commands rather than an SVG/image asset —
 * this site has zero external icon dependencies to begin with, and these
 * need to be drawn directly into the chart's own canvas anyway (CSS/HTML
 * icons can't be overlaid at a precise pixel position inside a <canvas>).
 */
function drawWindsockIcon(ctx, cx, cy, size) {
  ctx.save();
  const poleTopX = cx - size * 0.9;
  const poleTopY = cy - size * 0.75;
  ctx.strokeStyle = "#000";
  ctx.lineWidth = size * 0.12;
  ctx.beginPath();
  ctx.moveTo(poleTopX, poleTopY);
  ctx.lineTo(poleTopX, cy + size * 0.95);
  ctx.stroke();

  // Mount bracket + open mouth ring connecting the pole to the sock.
  const ringX = poleTopX + size * 0.32;
  const ringY = poleTopY + size * 0.1;
  ctx.lineWidth = size * 0.06;
  ctx.beginPath();
  ctx.moveTo(poleTopX, poleTopY);
  ctx.lineTo(ringX, ringY - size * 0.22);
  ctx.moveTo(poleTopX, poleTopY);
  ctx.lineTo(ringX, ringY + size * 0.22);
  ctx.stroke();
  ctx.lineWidth = size * 0.07;
  ctx.beginPath();
  ctx.ellipse(ringX, ringY, size * 0.06, size * 0.24, 0.25, 0, Math.PI * 2);
  ctx.stroke();

  // Body: stays wide for most of its length before a blunt (not pointed)
  // rounded tip, drooping diagonally — a real windsock's fabric tube
  // shape, not a flat pennant/flag tapering straight to a point.
  const tailX = ringX + size * 1.5;
  const tailY = ringY + size * 0.7;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.moveTo(ringX + size * 0.1, ringY - size * 0.26);
  ctx.quadraticCurveTo(ringX + size * 0.95, ringY, tailX, tailY - size * 0.1);
  ctx.quadraticCurveTo(tailX + size * 0.1, tailY, tailX, tailY + size * 0.1);
  ctx.quadraticCurveTo(ringX + size * 0.95, ringY + size * 0.32, ringX + size * 0.1, ringY + size * 0.26);
  ctx.closePath();
  ctx.fill();

  // Wind bands (the segmented stripes visible on a real windsock).
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = size * 0.06;
  ctx.beginPath();
  ctx.moveTo(ringX + size * 0.55, ringY - size * 0.13);
  ctx.lineTo(ringX + size * 0.5, ringY + size * 0.18);
  ctx.moveTo(ringX + size * 0.95, ringY - size * 0.02);
  ctx.lineTo(ringX + size * 0.92, ringY + size * 0.26);
  ctx.stroke();
  ctx.restore();
}

function drawFishIcon(ctx, cx, cy, size) {
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.moveTo(cx + size, cy);
  ctx.quadraticCurveTo(cx + size * 0.3, cy - size * 0.75, cx - size * 0.5, cy);
  ctx.quadraticCurveTo(cx + size * 0.3, cy + size * 0.75, cx + size, cy);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.5, cy);
  ctx.lineTo(cx - size * 1.3, cy - size * 0.5);
  ctx.lineTo(cx - size * 1.3, cy + size * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.fillStyle = "#fff";
  ctx.arc(cx + size * 0.55, cy - size * 0.15, size * 0.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Three small canvas-drawn glyphs for the computed-session markers below
 * (buildComputedSessionMarkersPlugin) — same hand-drawn-shape, no-external-
 * asset approach as drawWindsockIcon/drawFishIcon above. Deliberately only
 * three shapes cover all seven schedule instants (see the ICON_FOR_INSTANT
 * mapping just below the plugin): Home covers leaveHome/homeBy, Car covers
 * arrive/driveHome, Boat covers launch/headBack — the instant's TEXT label
 * still disambiguates which specific one it is, so reusing a shape for two
 * instants doesn't lose any information, it just keeps the total icon
 * vocabulary small.
 */
function drawHomeIcon(ctx, cx, cy, size) {
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.moveTo(cx, cy - size * 0.9);
  ctx.lineTo(cx + size * 0.85, cy - size * 0.15);
  ctx.lineTo(cx + size * 0.6, cy - size * 0.15);
  ctx.lineTo(cx + size * 0.6, cy + size * 0.75);
  ctx.lineTo(cx - size * 0.6, cy + size * 0.75);
  ctx.lineTo(cx - size * 0.6, cy - size * 0.15);
  ctx.lineTo(cx - size * 0.85, cy - size * 0.15);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillRect(cx - size * 0.18, cy + size * 0.15, size * 0.36, size * 0.6);
  ctx.restore();
}

function drawCarIcon(ctx, cx, cy, size) {
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.moveTo(cx - size, cy + size * 0.5);
  ctx.lineTo(cx - size, cy);
  ctx.lineTo(cx - size * 0.55, cy - size * 0.55);
  ctx.lineTo(cx + size * 0.55, cy - size * 0.55);
  ctx.lineTo(cx + size, cy);
  ctx.lineTo(cx + size, cy + size * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(cx - size * 0.5, cy + size * 0.5, size * 0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + size * 0.5, cy + size * 0.5, size * 0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBoatIcon(ctx, cx, cy, size) {
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.moveTo(cx - size, cy + size * 0.3);
  ctx.quadraticCurveTo(cx, cy + size * 0.75, cx + size, cy + size * 0.3);
  ctx.lineTo(cx + size * 0.8, cy + size * 0.3);
  ctx.lineTo(cx - size * 0.8, cy + size * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = size * 0.14;
  ctx.beginPath();
  ctx.moveTo(cx, cy + size * 0.3);
  ctx.lineTo(cx, cy - size * 0.85);
  ctx.moveTo(cx, cy - size * 0.6);
  ctx.lineTo(cx + size * 0.6, cy - size * 0.3);
  ctx.stroke();
  ctx.restore();
}

function buildConditionStripsPlugin(rows, isMobile, showFirstBoxIcons = false) {
  const stripHeight = isMobile ? 11 : 14;
  const rowGap = isMobile ? 2 : 3;

  return {
    id: "conditionStrips",
    // Drawn INSIDE the plot area, anchored to its bottom edge — the
    // caller (renderConditionsChart) reserves exactly this much space via
    // layout.padding.bottom, so "inside the plot area" no longer means
    // "overlapping the data lines" the way it originally did; the data's
    // own Y-scale is squeezed to sit entirely above this strip zone
    // instead. A semi-opaque backing behind each strip is kept anyway, as
    // a second line of defense for anything that still reaches this low
    // (a marker/label right at an axis edge, say), not as the primary
    // legibility mechanism it used to be.
    //
    // Hooked to afterDatasetsDraw, NOT afterDraw — the built-in tooltip
    // plugin also draws in afterDraw, and Chart.js doesn't guarantee our
    // afterDraw runs before a differently-registered one (registration
    // order, not the plugin's own `z`, decided that in testing, and global
    // built-ins like tooltip are registered ahead of any chart-local
    // plugin regardless of array order or z value). Since the strips are
    // anchored to a fixed spot at the very bottom of the chart, a tooltip
    // hovering near there would otherwise get silently painted over —
    // afterDatasetsDraw is a strictly earlier phase than afterDraw, so this
    // guarantees the strips are always drawn before (i.e. underneath) the
    // tooltip, however Chart.js orders same-phase plugins internally.
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      const xScale = scales.x;
      const { left, right, bottom } = chartArea;

      // Anchored DOWNWARD from chartArea's bottom edge, into the
      // layout.padding.bottom reserved below it (renderConditionsChart) —
      // NOT upward into the plot area itself, which is what this
      // function used to do (and is exactly what let the data lines
      // dip under/behind the strips in the first place: reserving
      // padding without ALSO moving the strips' own draw position into
      // that padding just shrinks the plot area while the strips keep
      // drawing in the same relative spot, changing nothing). Custom
      // plugin drawing isn't clipped to chartArea by Chart.js — the day-
      // heading text/moon icon above (buildDayBandPlugin, "top - 16"/
      // "top - 28") already prove this same padding-zone-drawing pattern
      // works, just on the opposite edge.
      const topMarginInPadding = 2; // small gap between the plot area and the first strip
      const locStripTop = bottom + topMarginInPadding;
      const fishStripTop = locStripTop + stripHeight + rowGap;

      ctx.save();
      ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
      ctx.fillRect(left, locStripTop - 2, right - left, (fishStripTop + stripHeight) - locStripTop + 4);
      ctx.restore();

      const drawStrip = (field, label, stripTop, iconDrawFn) => {
        ctx.save();
        ctx.font = `700 ${isMobile ? 8 : 9}px -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.fillStyle = "#475569";
        // Right-aligned, ending just before chartArea.left — sits in the same
        // margin the y-axis's own tick labels/title already reserve.
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(label, left - 4, stripTop + stripHeight / 2);

        let iconDrawn = false;
        for (let i = 0; i < rows.length; i++) {
          const val = rows[i][field];
          if (val == null) continue;
          const xStart = xScale.getPixelForValue(rows[i]._t);
          const xEnd = i + 1 < rows.length ? xScale.getPixelForValue(rows[i + 1]._t) : right;
          const clippedStart = Math.max(xStart, left);
          const clippedEnd = Math.min(xEnd, right);
          if (clippedEnd <= clippedStart) continue;
          ctx.fillStyle = conditionStripColor(val);
          ctx.fillRect(clippedStart, stripTop, clippedEnd - clippedStart, stripHeight);
          if (showFirstBoxIcons && !iconDrawn && iconDrawFn) {
            iconDrawn = true;
            const iconSize = Math.min(stripHeight, clippedEnd - clippedStart) * 0.3;
            iconDrawFn(ctx, (clippedStart + clippedEnd) / 2, stripTop + stripHeight / 2, iconSize);
          }
        }
        ctx.restore();
      };

      drawStrip("Condition", "Loc", locStripTop, drawWindsockIcon);
      drawStrip("Fishing Condition", "Fish", fishStripTop, drawFishIcon);
    },
  };
}

function lastNonNullAtOrBefore(rows, field, now) {
  let best = null;
  for (const r of rows) {
    if (r[field] == null) continue;
    const t = new Date(r.dateTime);
    if (t <= now && (!best || t > new Date(best.dateTime))) best = r;
  }
  return best;
}

function nearestRowWithField(rows, field, now) {
  let best = null, bestDiff = Infinity;
  for (const r of rows) {
    if (r[field] == null) continue;
    const diff = Math.abs(new Date(r.dateTime) - now);
    if (diff < bestDiff) { bestDiff = diff; best = r; }
  }
  return best;
}

// "Now" marker + wind-speed threshold line — a shared overlay on every graph,
// not just the new Live page. "Now" is expressed in the same "naive local
// time treated as UTC" encoding as everything else (see parseNaive) — real
// current time, re-interpreted as if those wall-clock digits were UTC, to
// match how the data's own timestamps are encoded.
function nowInNaiveEncoding() {
  const d = new Date();
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
}

const KAYAK_WIND_THRESHOLD_KMH = 15;

/**
 * Finds every point where the tide curve crosses a given height threshold
 * (e.g. the minimum depth needed for a boat ramp to be usable), using
 * linear interpolation between consecutive tide readings to find the exact
 * crossing time. This is a small approximation — the real curve between
 * two readings is a cosine (see the server-side tide interpolation), not a
 * straight line — but with hourly sampling the error is minor, and it
 * never claims more precision than "roughly this time".
 */
function findTideThresholdCrossings(rows, threshold) {
  const crossings = [];
  const tideRows = rows
    .filter((r) => r["Tide Height (m)"] != null)
    .slice()
    .sort((a, b) => a._t - b._t);

  for (let i = 0; i < tideRows.length - 1; i++) {
    const h1 = tideRows[i]["Tide Height (m)"];
    const h2 = tideRows[i + 1]["Tide Height (m)"];
    const t1 = tideRows[i]._t;
    const t2 = tideRows[i + 1]._t;
    if (h1 === h2) continue; // genuinely flat segment — no crossing possible

    // Server-side tide heights are cosine-interpolated and rounded to 2dp
    // (see fetch_conditions.py), and ramp thresholds are typically set as
    // round numbers too (1.8m, 2.1m) — so a reading landing EXACTLY on the
    // threshold is common, not a rare edge case. h1 === threshold is always
    // the same reading as the previous iteration's h2, so skip it here to
    // avoid reporting the same moment twice; it was (or wasn't — see below)
    // already handled when this reading was h2.
    if (h1 === threshold) continue;

    if (h2 === threshold) {
      // This reading itself IS the crossing point. Look one reading further
      // ahead (if there is one) to tell a genuine crossing from a
      // touch-and-reverse — the tide kissing the threshold, then heading
      // back the way it came without ever really crossing it.
      const h3 = i + 2 < tideRows.length ? tideRows[i + 2]["Tide Height (m)"] : null;
      const cameFromBelow = h1 < threshold;
      const continuesPast = h3 == null || (cameFromBelow ? h3 >= threshold : h3 <= threshold);
      if (continuesPast) {
        crossings.push({ t: t2, becomingAccessible: cameFromBelow });
      }
      continue;
    }

    const above1 = h1 > threshold;
    const above2 = h2 > threshold;
    if (above1 !== above2) {
      const frac = (threshold - h1) / (h2 - h1);
      crossings.push({ t: t1 + frac * (t2 - t1), becomingAccessible: above2 });
    }
  }
  return crossings;
}

/**
 * Finds the local peaks (high tide) and troughs (low tide) in the tide
 * curve. A point counts as a candidate peak/trough if it's higher/lower
 * than both its immediate neighbors, but the reported TIME isn't just
 * that sampled hour — real tide peaks/troughs almost never land exactly
 * on the hour, and reporting the raw sample would be visibly wrong (e.g.
 * a true peak at 3:42 showing as "4:00"). Instead, a parabola is fitted
 * through the three hourly samples straddling the peak/trough, and its
 * vertex — the fraction of an hour before/after the middle sample where
 * the curve actually turns — is used to interpolate the real time. The
 * server-side tide curve is itself cosine-shaped (see the tide
 * interpolation in fetch_conditions.py), and a cosine is well approximated
 * by a parabola in the small neighborhood right around its own peak, so
 * this recovers the true peak time closely — verified against a
 * synthetic cosine with a known non-hour peak (3.7h): this method
 * recovered 3.704h, vs. 4h from the raw hourly sample.
 * The very first/last row is never reported: with nothing before/after it
 * to compare against, there's no way to tell whether it's a genuine local
 * extreme or just where the visible data happens to end.
 */
/**
 * Estimates the tide height at targetMs by interpolating within a
 * location's own (unshifted) tide curve — the building block for
 * applyTideOffsetToRows below. Cosine-eased between the two bracketing
 * real samples (slow near each end, faster through the middle) rather
 * than a straight line, matching the same interpolation shape
 * fetch_conditions.py's own server-side tide interpolation already uses
 * (the "Rule of Twelfths" — a real tide curve is smoothly curved, not
 * straight segments meeting at a point), so a shifted curve still looks
 * like a genuine tide curve rather than gaining visible kinks at each
 * original hourly sample.
 */
/**
 * Low-level Leaflet map builder shared by the Location tab (app.js) and
 * the Settings tab (locationsadmin.js) — each page builds its own
 * `points` array (with whatever popup/click behavior makes sense there;
 * see the two call sites for how they differ) and this just handles
 * creating the map, the tile layer, and placing/fitting markers.
 *
 * Uses Leaflet + plain OpenStreetMap tiles specifically because they're
 * free and need no API key, unlike Google Maps — appropriate here since
 * this site otherwise has zero paid mapping dependencies. Both pages load
 * Leaflet itself via CDN in their own <head> (see conditions.html /
 * locations.html) — this function assumes window.L already exists by the
 * time it's called.
 *
 * points: [{ lat, lng, label, onClick?, popupHtml? }]. A marker always
 * gets a hover tooltip (label); onClick fires immediately on click
 * (for a single, unambiguous selection), while popupHtml opens a
 * Leaflet popup instead (for a marker that needs to offer a choice —
 * see app.js's location-with-multiple-types case) — a point supplies
 * one or the other, not normally both.
 *
 * opts.onMapClick(lat, lng), if given, fires when the MAP ITSELF (not a
 * marker) is clicked — used by the Settings tab's "click map to add a
 * location" action (see locationsadmin.js) to capture exactly where the
 * admin clicked. Its presence also changes the empty-map fallback: with no
 * onMapClick, zero valid points means nothing useful can be shown at all,
 * so the function bails to an explanatory message; WITH onMapClick, a
 * genuinely empty map is still shown (centered on Port Phillip/Western
 * Port, since that's this whole site's coverage area) so there's still
 * something clickable to start the very first location from.
 *
 * Returns the Leaflet map instance, or null if Leaflet/the container
 * isn't available, or there are no valid (lat/lng-bearing) points to
 * show AND no onMapClick was given — callers can use that null to fall
 * back to showing an explanatory message instead of an empty map box.
 */
/**
 * Hand-drawn map pin icons (Kayak / Land based / both) for
 * renderLeafletLocationMap below — built the same way this site already
 * builds its other icons (the windsock/fish markers on the graphs)
 * rather than depending on an icon font or library, since there's no
 * ready-made "kayak" icon in any standard set anyway. A classic teardrop
 * pin with a small circular window near the top holding the actual
 * symbol — kayak: a solid hull with a white paddle line (and blade caps
 * at each end) crossing it, the paddle drawn in white specifically so it
 * reads as a distinct line rather than blending into a same-color hull;
 * land based: a bold bent fishing rod, with the line down to the hook
 * drawn thin/faint so the rod itself — not the line — is the dominant
 * shape, matching which part actually signifies "fishing" at a glance.
 */
const MAP_PIN_STYLES = {
  kayak: { fill: "#185FA5", light: "#E6F1FB" },
  landBased: { fill: "#854F0B", light: "#FAEEDA" },
  both: { fill: "#534AB7", light: "#EEEDFE" },
};

function kayakGlyphSvg(color, cx, cy, scale) {
  return `
    <g transform="translate(${cx} ${cy}) scale(${scale})">
      <path d="M-9 0 Q-6 -3.2 0 -3.2 Q6 -3.2 9 0 Q6 3.2 0 3.2 Q-6 3.2 -9 0 Z" fill="${color}"/>
      <line x1="-7.5" y1="-6.5" x2="7.5" y2="6.5" stroke="white" stroke-width="1.3" stroke-linecap="round"/>
      <line x1="-9.3" y1="-8.3" x2="-6" y2="-5" stroke="white" stroke-width="2.6" stroke-linecap="round"/>
      <line x1="6" y1="5" x2="9.3" y2="8.3" stroke="white" stroke-width="2.6" stroke-linecap="round"/>
    </g>
  `;
}

function rodGlyphSvg(color, cx, cy, scale) {
  return `
    <g transform="translate(${cx} ${cy}) scale(${scale})">
      <path d="M-8 8 L5 -8 Q8 -12 6.5 -7" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M6 -7.5 L8.5 6" fill="none" stroke="${color}" stroke-width="0.8" stroke-dasharray="1,1.2" opacity="0.75"/>
      <circle cx="8.5" cy="7" r="1.4" fill="${color}"/>
    </g>
  `;
}

function buildMapPinIconHtml(kind) {
  const { fill, light } = MAP_PIN_STYLES[kind] || MAP_PIN_STYLES.kayak;
  let glyph;
  if (kind === "landBased") glyph = rodGlyphSvg(fill, 17, 16, 1);
  else if (kind === "both") glyph = kayakGlyphSvg(fill, 12.5, 16, 0.62) + rodGlyphSvg(fill, 21.5, 16, 0.62);
  else glyph = kayakGlyphSvg(fill, 17, 16, 1);
  return `
    <svg width="34" height="44" viewBox="0 0 34 44" xmlns="http://www.w3.org/2000/svg">
      <path d="M17 2C9.3 2 3 8.3 3 16c0 11 14 26 14 26s14-15 14-26C31 8.3 24.7 2 17 2z" fill="${fill}"/>
      <circle cx="17" cy="16" r="10.5" fill="${light}"/>
      ${glyph}
    </svg>
  `;
}

/**
 * A Leaflet divIcon (arbitrary HTML/SVG rather than an image file) for
 * the given kind — "kayak", "landBased", or "both". className resets
 * Leaflet's own default icon CSS (which otherwise adds a background/
 * border meant for its default image-based marker and would clash with
 * a custom SVG one) — see the .location-map-pin rule in style.css.
 */
function buildMapPinDivIcon(kind) {
  return L.divIcon({
    html: buildMapPinIconHtml(kind),
    className: "location-map-pin",
    iconSize: [34, 44],
    iconAnchor: [17, 44],
    popupAnchor: [0, -40],
    tooltipAnchor: [0, -38],
  });
}

// Shared between the Location tab's map and the Settings tab's map — both
// show the same geography, so "where was I last looking" is one
// preference, not two separate ones.
const MAP_VIEW_STORAGE_KEY = "goodConditionsLocationMapView";

// Tracks the live Leaflet map instance per container (keyed by containerId)
// across repeated renderLeafletLocationMap calls. The Settings tab in
// particular calls this on every renderRows() — initial load, adding a
// location, removing one, toggling a type, and now the map-click-to-add
// flow — all reusing the SAME #settingsLocationMap div. Leaflet throws
// "Error: Map container is already initialized" if L.map() is called again
// on a container that already has a live map, without tearing the old one
// down first — and since that throw happens mid-function, it silently
// skipped the applyLocationFilter() call right after it in the caller,
// which is what made a fresh "click to add" location appear alongside
// every OTHER location instead of alone. map.remove() is Leaflet's own
// teardown (unbinds events/layers, clears the container's internal
// "already initialized" flag) — calling it first makes every one of these
// re-renders safe.
const leafletMapInstances = {};

function renderLeafletLocationMap(containerId, points, opts = {}) {
  const container = document.getElementById(containerId);
  if (!container || typeof L === "undefined") return null;

  if (leafletMapInstances[containerId]) {
    leafletMapInstances[containerId].remove();
    delete leafletMapInstances[containerId];
  }

  const valid = points.filter((p) => p.lat != null && p.lng != null);
  if (valid.length === 0 && !opts.onMapClick) {
    container.innerHTML = `<p class="footnote" style="margin:0;">No locations with coordinates to show yet.</p>`;
    return null;
  }

  const map = L.map(container, { scrollWheelZoom: true });
  leafletMapInstances[containerId] = map;
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 18,
  }).addTo(map);

  const bounds = [];
  for (const p of valid) {
    bounds.push([p.lat, p.lng]);
    const marker = L.marker([p.lat, p.lng], { icon: buildMapPinDivIcon(p.iconKind || "kayak") }).addTo(map);
    if (p.label) marker.bindTooltip(p.label, { direction: "top" });
    if (p.popupHtml) marker.bindPopup(p.popupHtml);
    if (p.onClick) marker.on("click", p.onClick);
  }

  // Restores the last-viewed position/zoom if one was saved, rather than
  // always resetting to "fit every marker" on every page load — once
  // someone's zoomed in on their own local patch, they shouldn't have to
  // re-zoom back in every time they open this page. Falls back to the
  // original "fit everything" behavior the first time, before anything's
  // ever been saved.
  let savedView = null;
  try {
    savedView = JSON.parse(localStorage.getItem(MAP_VIEW_STORAGE_KEY) || "null");
  } catch {
    savedView = null;
  }
  if (savedView && typeof savedView.lat === "number" && typeof savedView.lng === "number" && typeof savedView.zoom === "number") {
    map.setView([savedView.lat, savedView.lng], savedView.zoom);
  } else if (bounds.length === 0) {
    // Only reachable via the onMapClick early-return bypass above (a
    // genuinely empty map, no locations with coordinates at all yet) —
    // fitBounds([]) has nothing to fit, so center on Port Phillip/Western
    // Port generally, since that's this whole site's coverage area, rather
    // than Leaflet's default (mid-Atlantic, lat/lng 0,0).
    map.setView([-38.2, 145.1], 9);
  } else if (bounds.length === 1) {
    // A single marker has no useful "bounds" to fit (fitBounds on one
    // point zooms in to the max level, which is usually too tight) —
    // center on it at a reasonable fixed zoom instead.
    map.setView(bounds[0], 12);
  } else {
    map.fitBounds(bounds, { padding: [24, 24] });
  }

  // Saves the current position/zoom whenever the user finishes panning or
  // zooming — registered after the initial setView/fitBounds above
  // deliberately, so restoring (or setting) the starting view doesn't
  // itself immediately re-trigger a save; only genuine user interaction
  // does.
  const saveCurrentView = () => {
    const center = map.getCenter();
    localStorage.setItem(MAP_VIEW_STORAGE_KEY, JSON.stringify({ lat: center.lat, lng: center.lng, zoom: map.getZoom() }));
  };
  map.on("moveend", saveCurrentView);
  map.on("zoomend", saveCurrentView);

  if (opts.onMapClick) {
    // Fires on a genuine click on open map area. Leaflet doesn't bubble
    // marker clicks up to this handler by default, so clicking an existing
    // pin correctly triggers ONLY that marker's own onClick (set above),
    // never both.
    map.on("click", (e) => opts.onMapClick(e.latlng.lat, e.latlng.lng));
  }

  return map;
}

// --- GitHub read/write (shared) ---------------------------------------------
//
// Originally lived only in locationsadmin.js (the Settings tab's own
// save flow) — moved here once the Location tab's preview needed the same
// "is there a GitHub connection, read the current file, write it back"
// plumbing for its own "Add as permanent location" button (see
// saveNewLocationToGitHub below, and previewLocationOnMap/
// btnAddPreviewAsLocation in app.js). GROUPS_FILE_PATH and WORKFLOW_FILE
// stay local to locationsadmin.js — nothing outside the Settings page
// touches location groups or triggers a data refresh.

const GITHUB_API = "https://api.github.com";
const FILE_PATH = "config/locations.json";
const BRANCH = "main";

/** Reads the same "ghConnection" localStorage entry the Settings page's
 * own Connect/Disconnect buttons write to (locationsadmin.js) — since
 * localStorage is scoped per-origin, not per-page, a connection made on
 * the Settings tab is already visible here with no extra wiring. Returns
 * null (never throws) if there's no connection, or the stored value is
 * malformed somehow. */
function getConnection() {
  try {
    return JSON.parse(localStorage.getItem("ghConnection") || "null");
  } catch {
    return null;
  }
}

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

// Which timing fields apply to each type. Drive time is no longer a static
// setting here at all — Week Ahead calculates it live from the device's
// current location. Both types have a "getting to/from the actual spot"
// step now — paddling for Kayak, walking from the carpark for Land based
// (a real case: walking along the beach to a specific spot).
const TYPE_TIME_FIELDS = {
  Kayak: [
    { key: "setUp", label: "Set up" },
    { key: "packUp", label: "Pack up" },
    { key: "timeToSpot", label: "Time to Spot" },
    { key: "timeFromSpot", label: "Time From Spot" },
  ],
  "Land based": [
    { key: "setUp", label: "Set up" },
    { key: "packUp", label: "Pack up" },
    { key: "timeToSpot", label: "Time to Spot" },
    { key: "timeFromSpot", label: "Time From Spot" },
  ],
};

function defaultTypeConfig(type) {
  const config = { type };
  for (const f of TYPE_TIME_FIELDS[type]) config[f.key] = "00:00";
  return config;
}

/**
 * Appends ONE new location object to config/locations.json on GitHub and
 * commits it directly — same GitHub Contents API read-sha/write pattern
 * locationsadmin.js's own onSave uses, just scoped to adding a single new
 * entry rather than overwriting a whole in-memory array (the Location tab,
 * unlike Settings, never loads the full locations list into memory, so
 * this reads the current file fresh right before writing rather than
 * trusting a copy that could be stale). Requires an existing GitHub
 * connection (see getConnection) — callers should check that BEFORE even
 * showing the option to save (see showAddPermanentButton, app.js), not
 * just before calling this.
 *
 * Blocks on an exact name collision (rather than silently creating a
 * confusing second entry with the same name — every page on this site
 * assumes location names are unique, e.g. locationKey()'s name::type
 * keying, the Settings map's marker-per-name grouping).
 *
 * Returns { success: true } or { success: false, error: "..." } — never
 * throws, so callers can show the error text directly without their own
 * try/catch.
 */
async function saveNewLocationToGitHub(newLoc) {
  const conn = getConnection();
  if (!conn || !conn.owner || !conn.repo || !conn.token) {
    return { success: false, error: "Not connected to GitHub — connect from the Settings tab first." };
  }
  try {
    const getRes = await fetch(`${GITHUB_API}/repos/${conn.owner}/${conn.repo}/contents/${FILE_PATH}?ref=${BRANCH}`, {
      headers: { Authorization: `Bearer ${conn.token}`, Accept: "application/vnd.github+json" },
    });
    if (!getRes.ok) throw new Error(`Could not read current file (${getRes.status})`);
    const getJson = await getRes.json();
    const decoded = decodeURIComponent(escape(atob(getJson.content.replace(/\n/g, ""))));
    const locations = JSON.parse(decoded);

    if (locations.some((l) => l.name === newLoc.name)) {
      return { success: false, error: `A location named "${newLoc.name}" already exists — edit it from Settings instead of adding a duplicate.` };
    }

    locations.push(newLoc);
    const content = JSON.stringify(locations, null, 2) + "\n";
    const putRes = await fetch(`${GITHUB_API}/repos/${conn.owner}/${conn.repo}/contents/${FILE_PATH}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${conn.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: `Add location "${newLoc.name}" from Location tab preview`,
        content: utf8ToBase64(content),
        sha: getJson.sha,
        branch: BRANCH,
      }),
    });
    if (!putRes.ok) {
      const errBody = await putRes.json().catch(() => ({}));
      throw new Error(errBody.message || `GitHub returned ${putRes.status}`);
    }
    return { success: true };
  } catch (err) {
    console.error("saveNewLocationToGitHub failed:", err);
    return { success: false, error: err.message };
  }
}

// --- WillyWeather search / candidate picker (shared) -----------------------
//
// Originally lived only in locationsadmin.js (the Settings tab's "click map
// to add location" flow) — moved here once app.js's Location tab needed the
// exact same "click the map, ask WillyWeather what's really there, let the
// person pick from real candidates" flow for its own "click map to preview
// a spot" feature (see fetchWillyWeatherPreviewRows below, and
// onLocationMapClickForPreview in app.js). Both callers now share one
// implementation instead of two copies that could drift apart.
//
// URL of the willyweather-search Cloudflare Worker (see
// willyweather-search.js) — deliberately empty until it's actually
// deployed. The Worker exists purely to keep the WillyWeather API key off
// this public site (every page here is served as-is by GitHub Pages;
// anyone can view source) while still letting these map-click flows ask
// WillyWeather what's really at a given point. Left blank, both callers
// simply skip the live-suggestion step and fall back to their own
// no-Worker behavior — nothing breaks, it just doesn't get live data until
// this is set. Paste in the Worker's own URL after following the deploy
// steps at the top of willyweather-search.js, e.g.
// "https://fishingconditions-search.your-subdomain.workers.dev" — note the
// "https://" is required; a bare hostname here is a relative path as far
// as fetch() is concerned, not an absolute URL, and would silently 404
// against this site's own origin instead of ever reaching the Worker.
const WILLYWEATHER_SEARCH_WORKER_URL = "https://fishingconditions-search.oliver-mestdagh.workers.dev";

/**
 * Calls the willyweather-search Worker's coordinate-search endpoint.
 * Returns an array (possibly empty) on success, or null on any failure
 * (network error, non-OK response, Worker not yet deployed at this URL,
 * malformed response) — null is the signal callers use to fall back to
 * their own no-Worker behavior rather than getting stuck. Never throws.
 */
async function fetchWillyWeatherCandidates(lat, lng) {
  if (!WILLYWEATHER_SEARCH_WORKER_URL) return null;
  try {
    const res = await fetch(`${WILLYWEATHER_SEARCH_WORKER_URL}/search?lat=${lat}&lng=${lng}`);
    if (!res.ok) {
      console.error("willyweather-search Worker returned", res.status);
      return null;
    }
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch (err) {
    console.error("willyweather-search Worker request failed:", err);
    return null;
  }
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * Shows a small modal listing WillyWeather's candidate locations near a
 * map click, and resolves once the person picks one, chooses to enter/skip
 * manually instead, or cancels outright. Built fresh each call and torn
 * down on any exit path.
 *
 * opts.allowManual (default true) controls whether the "None of these"
 * button appears at all — the Settings tab's "click to add" flow has a
 * genuine manual-entry fallback to offer (createNewLocationAt with no
 * candidate), but the Location tab's "click to preview" flow has nothing
 * meaningful to fall back to (there's no location to preview without a
 * real WillyWeather match) — see onLocationMapClickForPreview, app.js.
 *
 * Resolves to one of:
 *   { action: "pick", candidate }  — chose a specific WillyWeather match
 *   { action: "manual" }           — "None of these" (only when allowManual)
 *   { action: "cancel" }           — closed without choosing anything
 */
function showLocationCandidatePicker(candidates, opts = {}) {
  const allowManual = opts.allowManual !== false;
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "ww-candidate-overlay";

    const items = candidates
      .map(
        (c, i) => `
      <button type="button" class="ww-candidate-item" data-candidate-idx="${i}">
        <span class="ww-candidate-name">${escapeHtml(c.name || "(unnamed)")}</span>
        <span class="ww-candidate-meta">${escapeHtml([c.region, c.state].filter(Boolean).join(", "))}</span>
      </button>`
      )
      .join("");

    overlay.innerHTML = `
      <div class="ww-candidate-dialog">
        <button type="button" class="ww-candidate-close" aria-label="Cancel">&times;</button>
        <h3 style="margin:0 0 4px;">What's here on WillyWeather?</h3>
        <p class="footnote" style="margin:0 0 12px;">Pick the real match so weather/tide data resolves correctly.</p>
        <div class="ww-candidate-list">${items}</div>
        ${allowManual ? `<button type="button" id="wwCandidateManual" class="btn-secondary" style="margin-top:12px;width:100%;">None of these — enter a name manually</button>` : ""}
      </div>
    `;
    document.body.appendChild(overlay);

    const cleanup = (result) => {
      overlay.remove();
      resolve(result);
    };

    overlay.querySelector(".ww-candidate-close").addEventListener("click", () => cleanup({ action: "cancel" }));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup({ action: "cancel" });
    });
    const manualBtn = overlay.querySelector("#wwCandidateManual");
    if (manualBtn) manualBtn.addEventListener("click", () => cleanup({ action: "manual" }));
    overlay.querySelectorAll(".ww-candidate-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.candidateIdx);
        cleanup({ action: "pick", candidate: candidates[idx] });
      });
    });
  });
}

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


/**
 * Fetches config/locations.json (the fast, directly-editable admin-side
 * file — NOT the slow WillyWeather-derived conditions.json every page
 * already loads) purely to pick up each location's tideOffset, and
 * merges it onto the matching entries in allLocations by name. This is
 * what makes a changed tide offset take effect on the next page load
 * instead of needing "Save & refresh data now" (which re-fetches from
 * WillyWeather and can take several minutes) — every OTHER per-location
 * setting still needs that full refresh, but the tide offset specifically
 * doesn't depend on anything WillyWeather-fetched changing, only on
 * which point of the already-fetched curve gets sampled at render time.
 * Fails silently (locations simply keep whatever tideOffset they already
 * had, i.e. none) if the fetch fails for any reason — best-effort, not
 * something that should block the page from rendering at all.
 */
async function loadTideOffsets(allLocations) {
  try {
    // A cache-busting query parameter, not just {cache:"no-store"} — that
    // option only tells THIS BROWSER not to use its own local cache; it
    // does nothing about GitHub Pages' own CDN, which can keep serving an
    // already-cached copy of this file for a while after it changes
    // regardless of what the request asks for (confirmed directly on this
    // site before: config/locations.json's neighbor charts.js was served
    // with Cache-Control: max-age=600 — a full 10-minute window). Appending
    // a query string makes every request a genuinely distinct URL as far
    // as the CDN's cache is concerned, so it always has to fetch fresh
    // from origin — the same fix already used elsewhere on this site for
    // this exact class of problem (see the Tide Offset per-row field's
    // own frontend-interpolation notes).
    const res = await fetch(`config/locations.json?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return;
    const configLocations = await res.json();
    const offsetByName = new Map(configLocations.map((l) => [l.name, l.tideOffset]));
    for (const loc of allLocations) {
      if (offsetByName.has(loc.name)) loc.tideOffset = offsetByName.get(loc.name);
    }
  } catch (err) {
    console.error("Could not load tide offsets from config/locations.json:", err);
  }
}

function interpolatedTideHeightAt(sortedTideRows, targetMs) {
  if (sortedTideRows.length === 0) return null;
  const first = sortedTideRows[0];
  if (targetMs <= first._t) return first["Tide Height (m)"];
  const last = sortedTideRows[sortedTideRows.length - 1];
  if (targetMs >= last._t) return last["Tide Height (m)"];
  for (let i = 0; i < sortedTideRows.length - 1; i++) {
    const a = sortedTideRows[i];
    const b = sortedTideRows[i + 1];
    if (a._t <= targetMs && targetMs <= b._t) {
      const frac = (targetMs - a._t) / (b._t - a._t);
      const eased = (1 - Math.cos(frac * Math.PI)) / 2;
      const av = a["Tide Height (m)"];
      const bv = b["Tide Height (m)"];
      return av + (bv - av) * eased;
    }
  }
  return null;
}

/**
 * Applies a location's tide offset dynamically, at render time — no data
 * refresh needed, unlike every other per-location setting on this site.
 * Returns a new rows array (the original is never mutated) with
 * "Tide Height (m)" on every row replaced by its value from
 * offsetMinutes earlier/later in that SAME location's own original curve
 * — e.g. offsetMinutes=15 means "this location's tide runs 15 minutes
 * later than the matched station's", so what's shown for it at real time
 * T is actually the station's own reading from T-15min. Only touches
 * "Tide Height (m)" — everything downstream that reads it (the drawn
 * curve, findTideExtrema's high/low labels, findTideThresholdCrossings'
 * ramp-access times) picks up the shift automatically as a result, since
 * they all read this same field from whatever rows they're given, with
 * no separate code path of their own to update. "Tide Status" (the
 * Incoming/Outgoing/High/Low label) and the Location/Fishing Condition
 * SCORES are deliberately NOT touched here — those are computed
 * server-side from the tide timing at fetch time, so they only reflect a
 * changed offset after an actual data refresh; recomputing them
 * client-side would mean reimplementing real scoring logic in JS and
 * risking it drifting out of sync with the Python original.
 */
function applyTideOffsetToRows(rows, offsetMinutes) {
  if (!offsetMinutes) return rows;
  const tideRows = rows
    .filter((r) => r["Tide Height (m)"] != null)
    .slice()
    .sort((a, b) => a._t - b._t);
  if (tideRows.length === 0) return rows;
  const offsetMs = offsetMinutes * 60000;
  return rows.map((r) => {
    if (r["Tide Height (m)"] == null) return r;
    const shifted = interpolatedTideHeightAt(tideRows, r._t - offsetMs);
    return shifted == null ? r : { ...r, "Tide Height (m)": shifted };
  });
}

function findTideExtrema(rows) {
  const tideRows = rows
    .filter((r) => r["Tide Height (m)"] != null)
    .slice()
    .sort((a, b) => a._t - b._t);

  const extrema = [];
  for (let i = 1; i < tideRows.length - 1; i++) {
    const prev = tideRows[i - 1]["Tide Height (m)"];
    const curr = tideRows[i]["Tide Height (m)"];
    const next = tideRows[i + 1]["Tide Height (m)"];
    const isHigh = curr > prev && curr >= next;
    const isLow = curr < prev && curr <= next;
    if (!isHigh && !isLow) continue;

    const denom = prev - 2 * curr + next;
    let offsetFraction = 0;
    if (denom !== 0) {
      offsetFraction = (prev - next) / (2 * denom);
      // Clamped defensively — a smooth, well-behaved curve keeps the true
      // vertex within half a sample of the middle point by construction;
      // this just guards against a degenerate/noisy denom (near-zero)
      // producing something wild.
      offsetFraction = Math.max(-0.5, Math.min(0.5, offsetFraction));
    }
    const spacingMs = (tideRows[i + 1]._t - tideRows[i - 1]._t) / 2 || 3600000;
    const interpolatedT = tideRows[i]._t + offsetFraction * spacingMs;

    extrema.push({ t: interpolatedT, height: curr, type: isHigh ? "high" : "low" });
  }
  return extrema;
}

/**
 * Labels each high/low tide directly on the tide curve — a small dot at
 * the peak/trough plus its time, in the tide line's own color, so reading
 * "when's the next high tide" doesn't require hovering for a tooltip.
 * Applies universally, everywhere renderConditionsChart is used, same as
 * buildTooltipCrosshairPlugin below.
 */
function buildTideExtremaPlugin(rows) {
  const extrema = findTideExtrema(rows);
  return {
    id: "tideExtrema",
    afterDatasetsDraw(chart) {
      if (extrema.length === 0) return;
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.x || !scales.yTide) return;
      const xScale = scales.x;
      const yScale = scales.yTide;
      const { left, right } = chartArea;
      ctx.save();
      ctx.font = "700 9px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#4f46e5";
      for (const ex of extrema) {
        const x = xScale.getPixelForValue(ex.t);
        if (x < left || x > right) continue; // outside this chart's own visible range
        const y = yScale.getPixelForValue(ex.height);
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.textBaseline = ex.type === "high" ? "bottom" : "top";
        ctx.fillText(fmtChartTick(ex.t), x, ex.type === "high" ? y - 5 : y + 5);
      }
      ctx.restore();
    },
  };
}

/**
 * Marks exactly which moment (and which line's value at that moment) the
 * tooltip is currently showing — a vertical crosshair across the full
 * plot height at the tooltip's x-position, plus an enlarged, white-ringed
 * dot on every visible dataset's own point at that same position. Without
 * this, a floating tooltip box only tells you the VALUES; on a chart with
 * several overlapping lines (and, in compact mode, no axes at all to
 * cross-reference against), it's easy to lose track of which vertical
 * slice of the chart — and which specific point on each line — those
 * values actually came from.
 *
 * Applies universally, everywhere renderConditionsChart is used, and
 * regardless of how the tooltip was triggered (Chart.js's own default
 * tap/hover, or a caller manually driving it via chart.tooltip.setActiveElements
 * — see wireHoldToShowTooltip) — chart.tooltip.getActiveElements() reflects
 * the current tooltip state either way, so this doesn't need to know which
 * one is in play.
 *
 * Skips the wind datasets' own highlight dot specifically — those already
 * render a large directional arrow at every valid point (see
 * makeArrowCanvas/pointStyle below), so an additional plain circle on top
 * would just clutter an already-distinct marker rather than clarify it.
 */
function buildTooltipCrosshairPlugin(rows) {
  return {
    id: "tooltipCrosshair",
    // afterDatasetsDraw, not afterDraw — drawn after the lines/points but
    // (for pages using Chart.js's own native tooltip) still before that
    // tooltip's own afterDraw-hooked rendering, so this never paints over
    // it. Callers that manually drive the tooltip (Live, Week Ahead —
    // see disableBuiltinEvents/wireHoldToShowTooltip) disable the native
    // tooltip entirely (plugins.tooltip.enabled:false below) and rely on
    // THIS plugin to draw the whole box itself — Chart.js's own tooltip
    // rendering turned out to be unreliable when driven by an externally
    // triggered setActiveElements() rather than a genuine hover event:
    // position/size don't always get computed (confirmed directly against
    // a live chart — x/y/width/height came back undefined despite
    // getActiveElements() and opacity both being correct), in a way that
    // varied unpredictably across environments and was never fully
    // pinned down. This plugin's own drawing — same
    // "getActiveElements() + draw directly" approach as the crosshair and
    // highlighted points below, already proven reliable in every tested
    // scenario — sidesteps that whole class of problem rather than
    // continuing to fight it.
    afterDatasetsDraw(chart) {
      const active = chart.tooltip && chart.tooltip.getActiveElements ? chart.tooltip.getActiveElements() : [];
      if (!active || active.length === 0) return;
      const { ctx, chartArea } = chart;
      if (!chartArea) return;
      const { top, bottom, left, right } = chartArea;
      const { datasetIndex, index } = active[0];
      const meta = chart.getDatasetMeta(datasetIndex);
      const anchorPoint = meta && meta.data && meta.data[index];
      if (!anchorPoint) return;
      const x = anchorPoint.x;

      ctx.save();
      ctx.strokeStyle = "rgba(15, 23, 42, 0.55)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.restore();

      for (const el of active) {
        const ds = chart.data.datasets[el.datasetIndex];
        if (!ds || ds.yAxisID === "yWind") continue; // already has its own big arrow marker at this point
        const dMeta = chart.getDatasetMeta(el.datasetIndex);
        if (!dMeta || dMeta.hidden) continue;
        const point = dMeta.data && dMeta.data[el.index];
        const value = ds.data && ds.data[el.index] ? ds.data[el.index].y : null;
        if (!point || value == null) continue;
        ctx.save();
        ctx.beginPath();
        ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = ds.borderColor || "#000";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#fff";
        ctx.stroke();
        ctx.restore();
      }

      // The tooltip box itself — only drawn when the native Chart.js
      // tooltip is disabled (disableBuiltinEvents callers: Live, Week
      // (graphs)). Everywhere else, Chart.js's own tooltip is still
      // enabled and draws its own box via the normal hover/tap path — the
      // crosshair and highlighted points above still draw universally
      // (that's the whole point of this plugin for those callers), but
      // drawing a SECOND box here too would duplicate it.
      if (!chart.options.plugins.tooltip.enabled) {
        // Mirrors the callbacks configured on Chart.js's own native
        // tooltip (title: formatted time; one line per active dataset, in
        // that dataset's own label/color; afterBody: Location/Fishing
        // Condition, drawn as strips rather than real datasets so they're
        // pulled from the row directly) — kept in sync by hand since this
        // plugin doesn't go through those callbacks at all.
        const row = rows && rows[index];
        const lines = [];
        const t = row ? row._t : (chart.data.labels && chart.data.labels[index]);
        if (t != null) {
          lines.push({ text: new Intl.DateTimeFormat([], { timeZone: "UTC", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(t)), bold: true });
        }
        for (const el of active) {
          const ds = chart.data.datasets[el.datasetIndex];
          if (!ds) continue;
          const val = ds.data[el.index] ? ds.data[el.index].y : null;
          if (val == null) continue;
          const formatted = Number.isInteger(val) ? String(val) : val.toFixed(1);
          lines.push({ text: `${ds.label}: ${formatted}`, color: ds.borderColor || "#e5e7eb" });
        }
        if (row) {
          if (row["Condition"] != null) {
            lines.push({ text: `Location ${row["Condition"].toFixed(1)}/5 — ${row["Condition Reason"] || ""}` });
          }
          if (row["Fishing Condition"] != null) {
            lines.push({ text: `Fishing ${row["Fishing Condition"].toFixed(1)}/5 — ${row["Fishing Condition Reason"] || ""}` });
          }
        }
        drawTooltipBox(ctx, chartArea, x, lines);
      }
    },
  };
}

function drawTooltipBox(ctx, chartArea, x, lines) {
  if (lines.length === 0) return;
  const { top, bottom, left, right } = chartArea;

  ctx.save();
  const fontSize = 11;
  const lineHeight = fontSize + 5;
  const padding = 8;
  let maxWidth = 0;
  for (const line of lines) {
    ctx.font = `${line.bold ? "700 " : ""}${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
    maxWidth = Math.max(maxWidth, ctx.measureText(line.text).width);
  }
  const boxWidth = maxWidth + padding * 2;
  const boxHeight = lines.length * lineHeight + padding * 2;

  let boxX = x + 12;
  if (boxX + boxWidth > right) boxX = x - 12 - boxWidth;
  boxX = Math.max(left, Math.min(boxX, right - boxWidth));
  let boxY = top + 8;
  boxY = Math.max(top, Math.min(boxY, bottom - boxHeight));

  ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 6);
    ctx.fill();
  } else {
    ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
  }

  lines.forEach((line, i) => {
    ctx.fillStyle = line.color || "#f1f5f9";
    ctx.font = `${line.bold ? "700 " : ""}${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(line.text, boxX + padding, boxY + padding + i * lineHeight);
  });
  ctx.restore();
}

function buildNowAndThresholdPlugin(rows, minTideHeight, stopFishingTime) {
  return {
    id: "nowAndThreshold",
    // afterDatasetsDraw, not afterDraw — same reasoning as
    // buildConditionStripsPlugin above: these lines/labels span the full
    // chart height, so drawn in afterDraw they could paint over a tooltip
    // hovering anywhere near one of them. afterDatasetsDraw guarantees
    // they're drawn before the tooltip regardless of plugin registration
    // order.
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      const { top, bottom, left, right } = chartArea;

      // Dotted horizontal line at the 15 km/h kayak wind threshold
      if (scales.yWind) {
        const y = scales.yWind.getPixelForValue(KAYAK_WIND_THRESHOLD_KMH);
        if (y >= top - 0.5 && y <= bottom + 0.5) {
          ctx.save();
          ctx.strokeStyle = "#dc2626";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(left, y);
          ctx.lineTo(right, y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = "700 9px -apple-system, BlinkMacSystemFont, sans-serif";
          ctx.fillStyle = "#dc2626";
          ctx.textAlign = "left";
          ctx.textBaseline = "bottom";
          ctx.fillText(`${KAYAK_WIND_THRESHOLD_KMH} km/h`, left + 4, y - 2);
          ctx.restore();
        }
      }

      // Dashed horizontal line at the minimum tide height needed for boat
      // ramp access, with a marker + time label at every point the real
      // tide curve actually crosses it.
      if (scales.yTide && minTideHeight != null) {
        const y = scales.yTide.getPixelForValue(minTideHeight);
        if (y >= top - 0.5 && y <= bottom + 0.5) {
          ctx.save();
          ctx.strokeStyle = "#0891b2";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(left, y);
          ctx.lineTo(right, y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = "700 9px -apple-system, BlinkMacSystemFont, sans-serif";
          ctx.fillStyle = "#0891b2";
          ctx.textAlign = "left";
          ctx.textBaseline = "bottom";
          ctx.fillText(`${minTideHeight}m ramp access`, left + 4, y - 2);
          ctx.restore();

          if (scales.x) {
            const crossings = findTideThresholdCrossings(rows, minTideHeight);
            crossings.forEach((c, idx) => {
              if (c.t < scales.x.min || c.t > scales.x.max) return;
              const x = scales.x.getPixelForValue(c.t);
              ctx.save();
              ctx.beginPath();
              ctx.arc(x, y, 3, 0, Math.PI * 2);
              ctx.fillStyle = "#0891b2";
              ctx.fill();

              // Alternate labels above/below the line so consecutive
              // crossings (a full tide cycle can have several) don't
              // overlap each other.
              const labelBelow = idx % 2 === 1;
              ctx.font = "600 9px -apple-system, BlinkMacSystemFont, sans-serif";
              ctx.fillStyle = "#0891b2";
              ctx.textAlign = "center";
              ctx.textBaseline = labelBelow ? "top" : "bottom";
              ctx.fillText(fmtChartTick(c.t), x, labelBelow ? y + 5 : y - 5);
              ctx.restore();
            });
          }
        }
      }

      // Solid vertical line at the current moment, only drawn when "now"
      // actually falls within the chart's plotted time range.
      if (scales.x) {
        const nowMs = nowInNaiveEncoding();
        if (nowMs >= scales.x.min && nowMs <= scales.x.max) {
          const x = scales.x.getPixelForValue(nowMs);
          ctx.save();
          ctx.strokeStyle = "#0f172a";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, bottom);
          ctx.stroke();
          ctx.font = "700 9px -apple-system, BlinkMacSystemFont, sans-serif";
          ctx.fillStyle = "#0f172a";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText("Now", x, top + 2);
          ctx.restore();
        }

        // Dashed vertical line at the calculated "must stop fishing by"
        // time (Live page only — the time worked back from a Home By
        // target, minus drive time, pack-up time, and the trip back to the
        // car). Only drawn when actually set and within the plotted range.
        if (stopFishingTime != null && stopFishingTime >= scales.x.min && stopFishingTime <= scales.x.max) {
          const x = scales.x.getPixelForValue(stopFishingTime);
          ctx.save();
          ctx.strokeStyle = "#b91c1c";
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, bottom);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = "700 9px -apple-system, BlinkMacSystemFont, sans-serif";
          ctx.fillStyle = "#b91c1c";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          // Offset a little below the "Now" label (also anchored at the
          // top) so the two don't collide when the lines sit close
          // together horizontally.
          ctx.fillText("Stop fishing", x, top + 13);
          ctx.restore();
        }
      }
    },
  };
}

/**
 * Traces the boundary of a moon phase's illuminated region as a closed
 * polygon, for a given illumination fraction (0=new, 1=full) and whether
 * it's waxing (growing, lit on the right) or waning (shrinking, lit on the
 * left). Verified against the shoelace formula to match the target
 * illuminated area (k * circle area) to within ~0.04% across the full
 * range of phases — this isn't an approximation of "roughly crescent
 * shaped", it's the actual geometrically correct terminator curve.
 */
function moonPhasePoints(cx, cy, r, k, waxing, steps = 40) {
  const leftEdge = [];
  const rightEdge = [];
  for (let i = 0; i <= steps; i++) {
    const y = -r + (2 * r) * (i / steps);
    const w = Math.sqrt(Math.max(0, r * r - y * y));
    let xLeft, xRight;
    if (k <= 0.5) {
      const e = (1 - 2 * k) * w;
      xLeft = waxing ? e : -w;
      xRight = waxing ? w : -e;
    } else {
      const e = (2 * k - 1) * w;
      xLeft = waxing ? -e : -w;
      xRight = waxing ? w : e;
    }
    leftEdge.push([cx + xLeft, cy + y]);
    rightEdge.push([cx + xRight, cy + y]);
  }
  return leftEdge.concat(rightEdge.reverse());
}

function drawMoonIcon(ctx, cx, cy, r, illuminationPct, waxing) {
  const k = Math.max(0, Math.min(100, illuminationPct)) / 100;

  ctx.save();

  // Dark base (the unlit portion of the disk)
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#334155";
  ctx.fill();

  // Lit region — the actual verified geometry, not a fixed 8-way lookup
  if (k > 0.002) {
    const points = moonPhasePoints(cx, cy, r, k, waxing);
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    ctx.closePath();
    ctx.fillStyle = "#fef3c7";
    ctx.fill();
  }

  // Thin outline so it reads clearly against a light chart background
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "#94a3b8";
  ctx.lineWidth = 0.75;
  ctx.stroke();

  ctx.restore();
}

function buildDayBandPlugin(rows, sunTimes, locationName, moonPhases, showDayHeading = true, showSunTimes = true, overlayHeading = false) {
  // Group rows by calendar day, tracking each day's exact start/end timestamp — bands
  // are positioned by real elapsed time (via the linear x-axis), not by row index, so
  // they're pixel-accurate regardless of how densely each day happens to be sampled.
  const dayGroups = [];
  let currentKey = null;
  for (const r of rows) {
    const key = dayKeyOf(r.dateTime);
    const t = r._t;
    if (key !== currentKey) {
      currentKey = key;
      dayGroups.push({ key, minT: t, maxT: t });
    } else {
      const g = dayGroups[dayGroups.length - 1];
      if (t < g.minT) g.minT = t;
      if (t > g.maxT) g.maxT = t;
    }
  }
  const sunByDate = new Map((sunTimes || []).map((s) => [s.date, s]));

  return {
    id: "dayBands",
    beforeDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || dayGroups.length === 0) return;
      const xScale = scales.x;
      const { top, bottom, right, left } = chartArea;

      ctx.save();
      dayGroups.forEach((g, gi) => {
        // Each day spans its own local midnight to the next day's midnight, not just
        // the range of its actual data points.
        const [y, m, d] = g.key.split("-").map(Number);
        const dayStartT = Date.UTC(y, m - 1, d); // Date.UTC month is 0-indexed; g.key's is not
        const dayEndT = dayStartT + 24 * 3600 * 1000;

        const xStart = gi === 0 ? left : xScale.getPixelForValue(dayStartT);
        const xEnd = gi + 1 < dayGroups.length ? xScale.getPixelForValue(dayEndT) : right;

        ctx.fillStyle = DAY_BAND_COLORS[gi % 2];
        ctx.fillRect(xStart, top, xEnd - xStart, bottom - top);

        const sun = sunByDate.get(g.key);
        if (sun) {
          const xFirstLight = sun.firstLight != null ? xScale.getPixelForValue(parseNaive(sun.firstLight)) : null;
          const xSunrise = sun.sunrise != null ? xScale.getPixelForValue(parseNaive(sun.sunrise)) : null;
          const xSunset = sun.sunset != null ? xScale.getPixelForValue(parseNaive(sun.sunset)) : null;
          const xLastLight = sun.lastLight != null ? xScale.getPixelForValue(parseNaive(sun.lastLight)) : null;

          if (xFirstLight != null) {
            ctx.fillStyle = NIGHT_BAND_COLOR;
            ctx.fillRect(xStart, top, xFirstLight - xStart, bottom - top);
            if (xSunrise != null) {
              ctx.fillStyle = TWILIGHT_BAND_COLOR;
              ctx.fillRect(xFirstLight, top, xSunrise - xFirstLight, bottom - top);
            }
          } else if (xSunrise != null) {
            ctx.fillStyle = NIGHT_BAND_COLOR;
            ctx.fillRect(xStart, top, xSunrise - xStart, bottom - top);
          }

          if (xLastLight != null) {
            if (xSunset != null) {
              ctx.fillStyle = TWILIGHT_BAND_COLOR;
              ctx.fillRect(xSunset, top, xLastLight - xSunset, bottom - top);
            }
            ctx.fillStyle = NIGHT_BAND_COLOR;
            ctx.fillRect(xLastLight, top, xEnd - xLastLight, bottom - top);
          } else if (xSunset != null) {
            ctx.fillStyle = NIGHT_BAND_COLOR;
            ctx.fillRect(xSunset, top, xEnd - xSunset, bottom - top);
          }

          // Explicit time labels at the actual sunrise/sunset moment — the
          // shading already marks the transition visually, but not the
          // specific time. Placed a little below the "Now"/"Stop fishing"
          // labels (which sit right at the very top) and well above the
          // condition strips (anchored to the very bottom), since both of
          // those are already using their own ends of the chart.
          //
          // Skippable via showSunTimes=false — added for Week Ahead's
          // row-per-location graphs (week.js), where the shared
          // timeline header above every row already shows sunrise/sunset
          // times once; repeating them inside each row's own (now several-
          // days-wide) chart added visual noise without new information.
          // Every other caller doesn't pass this, so defaults to true and
          // renders exactly as before.
          if (showSunTimes) {
            ctx.font = "700 8px -apple-system, BlinkMacSystemFont, sans-serif";
            ctx.fillStyle = "#b45309";
            ctx.textAlign = "center";
            if (xSunrise != null && xSunrise >= left && xSunrise <= right) {
              ctx.strokeStyle = "#b45309";
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(xSunrise, top + 24);
              ctx.lineTo(xSunrise, top + 32);
              ctx.stroke();
              ctx.textBaseline = "top";
              ctx.fillText(fmtChartTick(parseNaive(sun.sunrise)), xSunrise, top + 33);
            }
            if (xSunset != null && xSunset >= left && xSunset <= right) {
              ctx.strokeStyle = "#b45309";
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(xSunset, top + 24);
              ctx.lineTo(xSunset, top + 32);
              ctx.stroke();
              ctx.textBaseline = "top";
              ctx.fillText(fmtChartTick(parseNaive(sun.sunset)), xSunset, top + 33);
            }
          }
        }

        // Skippable via showDayHeading=false — added for Week Ahead's
        // embedded per-tile graphs (week.js), where the date (and the
        // moon phase below) are already shown once in the shared timeline
        // header above every tile, and again in the tile's own small info
        // row — repeating both a third time, per day-band, inside a chart
        // that's often only a few hundred pixels wide, is pure clutter
        // there. Every other caller (the main Conditions page, Live, the
        // old Week Ahead modal/preview) doesn't pass this, so defaults to
        // true and renders exactly as before.
        if (showDayHeading) {
          ctx.fillStyle = "#1f4e78";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";

          // Location name only on the FIRST day this chart spans — repeating
          // it for every day looks redundant once a chart covers several
          // days (which happens often now that Week Ahead's graphs span
          // sunset-to-sunrise ranges, sometimes several days for a long
          // session) — the date alone is enough context for the later days.
          const headingText = locationName && gi === 0 ? `${locationName} — ${formatDayHeading(g.key)}` : formatDayHeading(g.key);

          // Shrink the font until the text actually fits this band's width, rather
          // than risk it overflowing onto a second line or running off the edge —
          // matters more now that a location name can make this considerably longer,
          // and needs to hold up on narrow phone screens too.
          const maxTextWidth = xEnd - xStart - 8;
          let fontSize = 11;
          ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
          while (ctx.measureText(headingText).width > maxTextWidth && fontSize > 7) {
            fontSize -= 0.5;
            ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
          }

          // Shrinking has a floor (7px) — for a long location name on a
          // narrow first/last day-band (routine now that Week Ahead's graphs
          // start at a sunset/sunrise boundary, often leaving only a few
          // hours of that first day on screen), the text can still be wider
          // than the band even at the smallest allowed size. Centering it on
          // the band's own midpoint in that case pushes it straight past the
          // chart's edge, where the canvas silently clips it — invisible
          // rather than just imperfectly placed. Clamping the draw position
          // to the chart's actual left/right bounds keeps it fully visible
          // (very rare cosmetic trade-off: it can nudge toward a neighbouring
          // label) rather than partially or entirely disappearing.
          let drawX = (xStart + xEnd) / 2;
          const halfTextWidth = ctx.measureText(headingText).width / 2;
          if (drawX - halfTextWidth < left) drawX = left + halfTextWidth;
          if (drawX + halfTextWidth > right) drawX = right - halfTextWidth;

          // overlayHeading draws INSIDE the plot area, right at its top
          // edge, instead of in the reserved padding strip above it (see
          // the smaller layout.padding.top used alongside this in
          // renderConditionsChart) — the Location tab's inline preview
          // graph is the only caller that passes this, specifically to
          // reclaim that reserved space rather than leave it blank. Text
          // now sits over whatever's plotted there, so a small translucent
          // backdrop behind it keeps it legible against a crossing line
          // rather than relying on line/text colours never colliding.
          if (overlayHeading) {
            const textHeight = fontSize + 2;
            ctx.save();
            ctx.fillStyle = "rgba(255,255,255,0.78)";
            ctx.fillRect(drawX - halfTextWidth - 3, top + 1, halfTextWidth * 2 + 6, textHeight);
            ctx.restore();
            ctx.fillStyle = "#1f4e78";
            ctx.fillText(headingText, drawX, top + 2);
          } else {
            ctx.fillText(headingText, drawX, top - 16);
          }
        }

        // Moon phase, one icon per day. Custom-drawn to the exact real
        // illumination percentage, not snapped to one of 8 fixed pictures.
        // Gated on moonPhases being passed at all (not on showDayHeading) —
        // callers that want the icon suppressed simply pass moonPhases: null,
        // same as they always could. Normally drawn ABOVE the day heading
        // (needs its own reserved space — see the increased
        // layout.padding.top where this chart gets built) — but alongside
        // overlayHeading, drawn just to the right of the date text instead,
        // both sharing the same reclaimed strip at the very top of the
        // plot area rather than each needing their own.
        const moonInfo = moonPhases && moonPhases[g.key];
        if (moonInfo && moonInfo.illumination != null) {
          const waxing = moonInfo.phase ? !moonInfo.phase.startsWith("Waning") : true;
          if (overlayHeading) {
            const moonX = Math.min((xStart + xEnd) / 2 + (showDayHeading ? 46 : 0), right - 10);
            drawMoonIcon(ctx, moonX, top + 9, 7, moonInfo.illumination, waxing);
          } else {
            drawMoonIcon(ctx, (xStart + xEnd) / 2, top - 28, 9, moonInfo.illumination, waxing);
          }
        }
      });
      ctx.restore();
    },
  };
}

/**
 * Renders (or re-renders) the combined temp/wind/rain/tide chart into a canvas.
 * @param {Object} opts
 * @param {HTMLCanvasElement} opts.canvas
 * @param {Array} opts.rows - rows for a single location, each with a numeric `_t` timestamp
 * @param {Array} opts.sunTimes - that location's sun times (from data.sunTimes[locationName])
 * @param {Chart|null} opts.existingChart - a previous Chart instance to destroy, if any
 * @param {string} [opts.locationName] - if provided, prefixed onto the day heading drawn on
 *   the chart itself (e.g. "Spot A — Tue, 11 Aug"). Intended for single-day views (the Good
 *   Conditions detail panel) where combining them avoids a separate heading above the chart;
 *   omit it for multi-day views (the main Conditions page) where the location's already shown
 *   elsewhere on the page and repeating it on every day's band would just be clutter.
 * @returns {Chart|null} the new Chart instance, or null if there were no rows
 */
const HOURLY_NUMERIC_FIELDS = [
  "Temp Forecast (C)", "Temp Realtime (C)", "Rainfall Probability (%)",
  "Wind Forecast (km/h)", "Wind Realtime (km/h)", "Tide Height (m)",
  "Water Temp (C)", "Pressure (hPa)", "Condition", "Fishing Condition",
];

/**
 * Collapses rows finer than an hour (e.g. today's 10-minute realtime
 * readings) into one row per hour, averaging numeric fields. Already-hourly
 * data (forecast-only future days) passes through unchanged — a hour with
 * only one row is a no-op, so this is safe to apply universally rather than
 * needing to special-case which rows are "dense".
 */
function bucketRowsHourly(rows) {
  if (!rows || rows.length <= 1) return rows;

  const buckets = new Map();
  for (const r of rows) {
    const hourKey = Math.floor(r._t / 3600000) * 3600000;
    if (!buckets.has(hourKey)) buckets.set(hourKey, []);
    buckets.get(hourKey).push(r);
  }

  const result = [];
  for (const [hourKey, group] of buckets) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    // Non-numeric fields (direction text, Tide Status, reason strings, etc.)
    // aren't meaningfully averageable — take them from the last reading in
    // the hour as the most "current" representative value.
    const merged = { ...group[group.length - 1] };
    merged._t = hourKey;
    merged.dateTime = new Date(hourKey).toISOString().slice(0, 19);
    for (const field of HOURLY_NUMERIC_FIELDS) {
      const vals = group.map((r) => r[field]).filter((v) => v != null);
      merged[field] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    result.push(merged);
  }

  return result.sort((a, b) => a._t - b._t);
}

// Session-span highlight — Week Ahead specific (sessionFrom/sessionTo are
// only ever passed there; every other caller leaves them undefined, in
// which case this draws nothing). The graph itself is deliberately wider
// than the qualifying session (extended through a full day/night period on
// each side for context), so this marks which part of that wider view is
// actually the session: a light tint plus bracketing lines at the exact
// start/end, both in the site's established "good condition" green so
// they read as "this is the highlighted part", not as another day/night
// band or a warning threshold like the other overlay lines on this chart.
const SESSION_SPAN_COLOR = "#16a34a";

/**
 * Which icon-draw function and short label go with each of the seven
 * schedule instants computeScheduleFromDragRangeMs can produce. Order
 * here is also draw/label order (chronological through a session).
 */
const SCHEDULE_INSTANT_DISPLAY = [
  { key: "leaveHomeMs", label: "Leave", icon: drawHomeIcon, color: "#0f766e" },
  { key: "arriveMs", label: "Arrive", icon: drawCarIcon, color: "#0f766e" },
  { key: "launchMs", label: "Launch", icon: drawBoatIcon, color: "#0f766e" },
  { key: "fishAtMs", label: "Fishing", icon: drawFishIcon, color: "#0f766e" },
  { key: "headBackMs", label: "Head back", icon: drawBoatIcon, color: "#0f766e" },
  { key: "driveHomeMs", label: "Driving", icon: drawCarIcon, color: "#0f766e" },
  { key: "homeByMs", label: "Home", icon: drawHomeIcon, color: "#0f766e" },
];

// A small fixed palette so several computed sessions on the same chart stay
// visually distinguishable from each other without needing the person to
// track which color means what — it's purely "these all belong together",
// not a legend that needs decoding.
const COMPUTED_SESSION_COLORS = ["#0f766e", "#7c3aed", "#b45309", "#be123c", "#0369a1"];

/**
 * Draws each computed (drag-derived) session's schedule instants as small
 * compact flags — a tick, a tiny icon, and a HH:MM label — rather than
 * full-height dashed lines with long text labels (buildSessionSpanPlugin
 * above). Kept deliberately lightweight since a single session already has
 * up to seven of these, and more than one computed session can be showing
 * on the same row at once (that's the whole point — comparing options).
 * A record with a field that's null (see computeScheduleFromDragRangeMs —
 * happens when live drive time genuinely couldn't be resolved) just skips
 * that one flag rather than showing a wrong or placeholder time.
 *
 * Labels are collision-avoided: gathered across EVERY record together
 * (not per-record in isolation — two different computed sessions with
 * markers close in time need to avoid each other just as much as two
 * instants within the same session do), sorted chronologically, then
 * swept left-to-right assigning each one the shallowest vertical "tier"
 * that doesn't collide with whatever's already been placed at that tier.
 * A tick mark's length grows to match wherever its own label actually
 * landed, so a pushed-down label still reads as connected to its instant
 * on the timeline rather than floating.
 */
function buildComputedSessionMarkersPlugin(records) {
  const validRecords = (records || []).filter((r) => r != null);
  return {
    id: "computedSessionMarkers",
    afterDatasetsDraw(chart) {
      if (!validRecords.length) return;
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.x) return;
      const { top } = chartArea;
      const ICON_SIZE = 6;
      const TIER_HEIGHT = 20; // vertical space each collision-avoidance tier takes
      const LABEL_GAP_PX = 8; // minimum breathing room required between two labels' bounding boxes

      const markers = [];
      validRecords.forEach((record, recordIdx) => {
        const color = COMPUTED_SESSION_COLORS[recordIdx % COMPUTED_SESSION_COLORS.length];
        for (const { key, label, icon } of SCHEDULE_INSTANT_DISPLAY) {
          const t = record[key];
          if (t == null) continue;
          if (t < scales.x.min || t > scales.x.max) continue;
          const x = scales.x.getPixelForValue(t);
          const text = `${label} ${fmtNaive(t, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
          markers.push({ x, text, icon, color });
        }
      });
      if (!markers.length) return;
      markers.sort((a, b) => a.x - b.x);

      ctx.save();
      ctx.font = "700 8px -apple-system, BlinkMacSystemFont, sans-serif";
      // tierRightEdge[i] = the rightmost pixel already claimed at tier i by
      // whatever was placed there most recently (markers are processed in
      // x-order, so "most recently" is always the nearest one to the left).
      const tierRightEdge = [];
      for (const marker of markers) {
        const halfWidth = ctx.measureText(marker.text).width / 2;
        let tier = 0;
        while (tierRightEdge[tier] != null && marker.x - halfWidth < tierRightEdge[tier] + LABEL_GAP_PX) {
          tier++;
        }
        tierRightEdge[tier] = marker.x + halfWidth;
        marker.tier = tier;
      }

      for (const { x, text, icon, color, tier } of markers) {
        const iconCy = top + ICON_SIZE + 3 + tier * TIER_HEIGHT;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, iconCy - ICON_SIZE - 1);
        ctx.stroke();
        // Icon draw functions above are all black/white-fill by design
        // (matching drawFishIcon's existing convention) — tint via a
        // save/restore + globalCompositeOperation trick would be
        // overkill here, so instead each icon gets a small colored dot
        // behind it (cheap, reliable) rather than trying to recolor the
        // icon's own path fills per record.
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, iconCy, ICON_SIZE + 3, 0, Math.PI * 2);
        ctx.globalAlpha = 0.16;
        ctx.fill();
        ctx.globalAlpha = 1;
        icon(ctx, x, iconCy, ICON_SIZE);
        ctx.font = "700 8px -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.fillStyle = color;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(text, x, iconCy + ICON_SIZE + 3);
      }
      ctx.restore();
    },
  };
}

/**
 * Live feedback for the click-drag-release gesture itself (wireSessionRangeSelect,
 * week.js) — a getPreviewState() closure rather than a plain value
 * because this plugin is built ONCE per row at chart-creation time, but
 * the drag state changes on every pointermove afterwards; reading it
 * fresh at each redraw (the caller calls chart.draw() on every
 * pointermove while armed) means one plugin instance can serve the whole
 * gesture rather than rebuilding the chart mid-drag.
 *
 * getPreviewState() returns null (or an object with hoverXVal null) when
 * this row isn't currently armed/being interacted with, in which case
 * this draws nothing at all — same shape either way, so the caller never
 * needs to add/remove this plugin, just let it return nothing to draw.
 */
function buildSessionDragPreviewPlugin(getPreviewState) {
  return {
    id: "sessionDragPreview",
    afterDatasetsDraw(chart) {
      const state = getPreviewState ? getPreviewState() : null;
      if (!state || state.hoverXVal == null) return;
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.x) return;
      const { top, bottom } = chartArea;
      ctx.save();
      // Shaded range for the drag in progress — only while an actual drag
      // (pointer down) is underway, not during the plain pre-drag hover.
      if (state.dragStartXVal != null) {
        const fromVal = Math.min(state.dragStartXVal, state.hoverXVal);
        const toVal = Math.max(state.dragStartXVal, state.hoverXVal);
        const xA = scales.x.getPixelForValue(Math.max(fromVal, scales.x.min));
        const xB = scales.x.getPixelForValue(Math.min(toVal, scales.x.max));
        if (xB > xA) {
          ctx.fillStyle = "rgba(15, 118, 110, 0.18)";
          ctx.fillRect(xA, top, xB - xA, bottom - top);
        }
      }
      // The hover time itself — shown under the mouse the whole time this
      // row is armed, whether or not a drag is currently in progress, so
      // there's always a readable answer to "what time am I about to
      // start/end this at".
      const x = scales.x.getPixelForValue(state.hoverXVal);
      if (x >= chartArea.left && x <= chartArea.right) {
        ctx.strokeStyle = "#0f766e";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        const label = fmtNaive(state.hoverXVal, { hour: "2-digit", minute: "2-digit", hour12: false });
        ctx.font = "700 10px -apple-system, BlinkMacSystemFont, sans-serif";
        const textWidth = ctx.measureText(label).width;
        const boxPad = 5;
        const boxH = 15;
        const boxY = top + 2;
        let boxX = x - textWidth / 2 - boxPad;
        // Clamped to stay inside the plot area rather than running off the
        // edge when hovering right at the start/end of the visible range.
        boxX = Math.max(chartArea.left, Math.min(chartArea.right - (textWidth + boxPad * 2), boxX));
        ctx.fillStyle = "#0f766e";
        ctx.fillRect(boxX, boxY, textWidth + boxPad * 2, boxH);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(label, boxX + boxPad, boxY + 3);
      }
      ctx.restore();
    },
  };
}

function buildSessionSpanPlugin(spans) {
  // Accepts an ARRAY of {from,to} spans now, not just one — a single
  // location's row can have more than one qualifying session across the
  // displayed period (Week Ahead's new row-per-location layout), and all
  // of them need shading on the same chart. Invalid/incomplete spans are
  // filtered out up front so beforeDraw/afterDraw don't need to re-check
  // each one every frame.
  const validSpans = (spans || []).filter((s) => s && s.from != null && s.to != null);

  return {
    id: "sessionSpan",
    beforeDraw(chart) {
      if (validSpans.length === 0) return;
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.x) return;
      const { top, bottom } = chartArea;
      ctx.save();
      ctx.fillStyle = "rgba(22, 163, 74, 0.14)";
      for (const { from, to } of validSpans) {
        const clampedFrom = Math.max(from, scales.x.min);
        const clampedTo = Math.min(to, scales.x.max);
        if (clampedTo <= clampedFrom) continue;
        const xStart = scales.x.getPixelForValue(clampedFrom);
        const xEnd = scales.x.getPixelForValue(clampedTo);
        ctx.fillRect(xStart, top, xEnd - xStart, bottom - top);
      }
      ctx.restore();
    },
    // afterDatasetsDraw, not afterDraw — same reasoning as the other
    // full-height overlay plugins above: these dashed lines/labels could
    // otherwise paint over a tooltip hovering nearby. afterDatasetsDraw
    // guarantees they draw before the tooltip regardless of plugin
    // registration order.
    afterDatasetsDraw(chart) {
      if (validSpans.length === 0) return;
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.x) return;
      const { top, bottom } = chartArea;
      for (const { from, to } of validSpans) {
        [
          { t: from, label: "Session start" },
          { t: to, label: "Session end" },
        ].forEach(({ t, label }) => {
          if (t < scales.x.min || t > scales.x.max) return;
          const x = scales.x.getPixelForValue(t);
          ctx.save();
          ctx.strokeStyle = SESSION_SPAN_COLOR;
          ctx.lineWidth = 2;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, bottom);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = "700 9px -apple-system, BlinkMacSystemFont, sans-serif";
          ctx.fillStyle = SESSION_SPAN_COLOR;
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillText(label, x, bottom - 2);
          ctx.restore();
        });
      }
    },
  };
}

function renderConditionsChart({ canvas, rows, sunTimes, existingChart, locationName, tideMaxObserved, moonPhases, minTideHeight, stopFishingTime, compact, sessionSpan, computedSessionMarkers, dragPreviewState, showDayHeading = true, showSunTimes = true, xRange, disableBuiltinEvents = false, showFirstBoxIcons = false, tideOffsetMinutes, hideValueAxes = false, overlayHeading = false }) {
  if (existingChart) existingChart.destroy();
  if (!rows || rows.length === 0) return null;
  rows = bucketRowsHourly(rows);
  // Applied here, once, centrally — every caller of this shared function
  // (every graph on the site) gets the shift automatically as a result,
  // with no separate per-page code needed: the drawn curve, the high/low
  // labels, and the ramp-access threshold-crossing times all read
  // "Tide Height (m)" from these SAME rows, so shifting it here is enough
  // for all three at once. See applyTideOffsetToRows for what this
  // deliberately does NOT touch (Tide Status, Condition scores).
  rows = applyTideOffsetToRows(rows, tideOffsetMinutes);

  // On mobile, the full descriptive legend labels take up a lot of vertical space
  // under the chart (often wrapping to several lines) — shorten them there, since
  // desktop has plenty of room to keep the fuller, more descriptive text.
  const isMobile = typeof window !== "undefined" && window.innerWidth < 900;

  // Each location's own real observed tide range calibrates its own axis
  // ceiling, rather than one fixed number for every location — Western
  // Port's ~3m swings and Port Phillip Bay's sub-1m ones would otherwise
  // either clip the former or make the latter look flat/unreadable. Now
  // that tide has its own labeled axis (below), this headroom is just
  // normal chart practice — keeping the peak clear of the very top pixel —
  // not an attempt to dodge overlapping with a different, hidden axis
  // (that confusion is gone structurally now, not by tuning a margin).
  // Falls back to a sensible default if this specific location has no
  // tide data at all (older cached data, or no nearby tide station).
  const tideAxisMax = tideMaxObserved != null ? Math.round(tideMaxObserved * 1.15 * 100) / 100 : 3.5;
  const L = isMobile
    ? { tempFcst: "Tmp Fcst", tempNow: "Tmp Now", rain: "Rain %", windFcst: "Wind Fcst", windNow: "Wind Now", tide: "Tide", waterTemp: "Water °C", pressure: "Pressure" }
    : { tempFcst: "Temp Forecast (°C)", tempNow: "Temp Realtime (°C)", rain: "Rainfall Probability (%)", windFcst: "Wind Forecast (km/h)", windNow: "Wind Realtime (km/h)", tide: "Tide Height (m)", waterTemp: "Water Temp (°C)", pressure: "Pressure (hPa)" };

  const pointsFor = (field) => rows.map((r) => ({ x: r._t, y: r[field] ?? null }));

  const datasets = [
    {
      // Forecast — hollow/outline marker (see makeArrowCanvas's own
      // comment for the same forecast=hollow/realtime=solid convention
      // applied to every paired series below): pointBackgroundColor
      // "transparent" with a colored border is how Chart.js draws an
      // outline-only circle, rather than a separate shape.
      label: L.tempFcst,
      data: pointsFor("Temp Forecast (C)"),
      borderColor: "#f97316",
      borderWidth: 1,
      pointRadius: 4,
      pointBackgroundColor: "transparent",
      pointBorderColor: "#f97316",
      pointBorderWidth: 2,
      yAxisID: "yTemp",
      tension: 0.3,
    },
    {
      // Realtime — solid/filled marker (an actual observed reading, not a
      // prediction). Previously had no markers at all (pointRadius: 0);
      // now shows a dot only where a real reading exists, same
      // "only draw a point where there's really a value" guard the wind
      // arrows below already used.
      label: L.tempNow,
      data: pointsFor("Temp Realtime (C)"),
      borderColor: "#fdba74",
      borderWidth: 1,
      pointRadius: rows.map((r) => (r["Temp Realtime (C)"] != null ? 4 : 0)),
      pointBackgroundColor: "#fdba74",
      yAxisID: "yTemp",
      tension: 0.3,
    },
    {
      // Sea surface temperature, from Open-Meteo's Marine API — plotted on
      // the same Celsius axis as air temperature (yTemp) since it's the
      // same unit and a similar real-world range, rather than adding a
      // seventh axis just for one line. Thin and light — a trend line to
      // glance at alongside air temp, not something meant to compete
      // visually with the wind/rain/tide lines that actually drive the
      // Location/Fishing Condition scores. No forecast/realtime pairing
      // exists for this one (it's Open-Meteo's own forecast only), so it
      // stays a plain line with no point markers, same as Tide/Pressure
      // below — the forecast=hollow/realtime=solid convention only
      // applies to series that actually have both variants.
      label: L.waterTemp,
      data: pointsFor("Water Temp (C)"),
      borderColor: "#7dd3fc",
      borderWidth: 1,
      pointRadius: 0,
      yAxisID: "yTemp",
      tension: 0.3,
    },
    {
      // Rainfall probability only ever exists as a forecast (WillyWeather
      // has no "realtime rainfall" reading this site plots) — hollow
      // marker for the same reason Temp Forecast's is: it's a prediction,
      // not yet a fact.
      label: L.rain,
      data: pointsFor("Rainfall Probability (%)"),
      borderColor: "#3b82f6",
      pointRadius: 4,
      pointBackgroundColor: "transparent",
      pointBorderColor: "#3b82f6",
      pointBorderWidth: 2,
      yAxisID: "yRain",
      tension: 0.3,
    },
    {
      // Forecast — hollow arrow (makeArrowCanvas's filled=false), bigger
      // than before (radius 7 → 10, arrow canvas itself 14px → 20px).
      label: L.windFcst,
      data: pointsFor("Wind Forecast (km/h)"),
      borderColor: "#16a34a",
      borderWidth: 1,
      pointStyle: rows.map((r) => makeArrowCanvas(windColor(r["Wind Forecast (km/h)"]), false)),
      pointRadius: rows.map((r) => (r["Wind Forecast (km/h)"] != null ? 10 : 0)),
      pointRotation: rows.map((r) => dirToArrowRotation(r["Wind Forecast Dir"])),
      yAxisID: "yWind",
      tension: 0.3,
    },
    {
      // Realtime — solid arrow, same bigger size as the forecast one above.
      label: L.windNow,
      data: pointsFor("Wind Realtime (km/h)"),
      borderColor: "#86efac",
      borderWidth: 1,
      pointStyle: rows.map((r) => makeArrowCanvas(windColor(r["Wind Realtime (km/h)"]), true)),
      pointRadius: rows.map((r) => (r["Wind Realtime (km/h)"] != null ? 10 : 0)),
      pointRotation: rows.map((r) => dirToArrowRotation(r["Wind Realtime Dir"])),
      yAxisID: "yWind",
      tension: 0.3,
    },
    {
      label: L.tide,
      data: pointsFor("Tide Height (m)"),
      borderColor: "#4f46e5",
      backgroundColor: "rgba(79, 70, 229, 0.15)",
      fill: true,
      pointRadius: 0,
      yAxisID: "yTide",
      tension: 0.4,
    },
    {
      // Mean sea-level pressure, from Open-Meteo (the same hourly series
      // whose daily average already feeds the Fishing Condition score's
      // pressure factor). Its own hidden axis, same treatment as yTide —
      // hPa has no natural shared axis with anything else on this chart
      // (not Celsius, not km/h, not a percentage), and a full visible axis
      // for one supplementary trend line would be more clutter than the
      // line is worth. Plain black and thin so it reads as a subtle
      // reference line, not another line competing with wind/rain/tide.
      label: L.pressure,
      data: pointsFor("Pressure (hPa)"),
      borderColor: "#000000",
      borderWidth: 1,
      pointRadius: 0,
      yAxisID: "yPressure",
      tension: 0.3,
    },
  ];

  // xRange lets a caller lock this chart's x-axis to two exact timestamps
  // rather than the first/last row it happens to have data for — used by
  // Week Ahead's embedded per-tile graphs (week.js) so the chart's own
  // time-to-pixel scale matches PIXELS_PER_HOUR exactly and lines up with
  // the shared timeline's day/night shading and hour ticks sitting behind
  // it. Every other caller doesn't pass this, so falls back to the actual
  // row range exactly as before.
  const minT = xRange ? xRange.min : rows[0]._t;
  const maxT = xRange ? xRange.max : rows[rows.length - 1]._t;

  // sessionSpan may be a single {from,to} object (every existing caller —
  // app.js, live.js, week.js) or an array of them (Week Ahead's new
  // row-per-location layout, where one location can have several
  // qualifying sessions across the displayed period) — normalized to an
  // array here so buildSessionSpanPlugin only has to handle one shape.
  const sessionSpanList = sessionSpan == null ? [] : Array.isArray(sessionSpan) ? sessionSpan : [sessionSpan];

  const chart = new Chart(canvas, {
    type: "line",
    data: { datasets },
    plugins: [
      buildDayBandPlugin(rows, sunTimes, locationName, moonPhases, showDayHeading, showSunTimes, overlayHeading),
      buildSessionSpanPlugin(sessionSpanList),
      buildComputedSessionMarkersPlugin(computedSessionMarkers),
      buildSessionDragPreviewPlugin(dragPreviewState),
      buildConditionStripsPlugin(rows, isMobile, showFirstBoxIcons),
      buildNowAndThresholdPlugin(rows, minTideHeight, stopFishingTime),
      buildTideExtremaPlugin(rows),
      buildTooltipCrosshairPlugin(rows),
      // Skipped in compact mode — nothing to label when there are no axes.
      // Also skipped when hideValueAxes alone is set (x-axis still shows,
      // but the °C/km/h axes these labels annotate don't) — same reasoning,
      // just for a narrower case than full compact mode.
      ...(compact || hideValueAxes ? [] : [buildAxisUnitLabelsPlugin()]),
    ],
    options: {
      responsive: true,
      // Skips Chart.js's own built-in tap/click/hover-triggered tooltip
      // interaction entirely (an empty events list means nothing native
      // triggers it) — for callers that want to drive the tooltip
      // themselves via chart.tooltip.setActiveElements() instead (Week
      // Ahead's hold-to-show-tooltip behavior — see week.js). This
      // has to happen at chart CONSTRUCTION time: Chart.js reads
      // options.events once, when it first binds its own internal
      // listeners, so mutating it after the chart already exists doesn't
      // reliably take effect. Every other caller doesn't pass this, so
      // defaults to false and gets Chart.js's normal tap/hover tooltip
      // behavior exactly as before.
      ...(disableBuiltinEvents ? { events: [] } : {}),
      // Chart.js defaults to maintainAspectRatio:true (with its own
      // built-in default aspectRatio, ~2:1 for line charts) — meaning
      // WITHOUT this, Chart.js computes the canvas's internal height from
      // its own aspect ratio instead of the container's actual measured
      // height, then the CSS width/height:100%!important on the canvas
      // (every chart-wrap on this site uses that pattern deliberately, to
      // let CSS fully control the container's size) forces that wrongly-
      // sized internal raster to fit anyway — invisible when a container's
      // real aspect ratio happens to be close to 2:1 (most of this site's
      // chart containers are), but severely distorted (aliased, jagged
      // lines) on anything far from that, like Week Ahead's row-per-
      // location graphs (~15:1 — very wide, fixed-height rows). Explicit
      // false makes Chart.js size the canvas to the container's actual
      // measured box instead, which is what every container on this site
      // already assumes is happening.
      maintainAspectRatio: false,
      spanGaps: true,
      // Extra top padding reserves space for two stacked elements above the
      // plot area: the moon phase glyph and the day heading text (see
      // buildDayBandPlugin). Shrunk when both are suppressed (showDayHeading:
      // false, moonPhases: null) so a tile that isn't drawing either doesn't
      // waste vertical space reserving room for them anyway.
      // autoPadding:false stops Chart.js reserving extra edge margin so
      // large point markers (the pointRadius:10 wind arrows) never get
      // clipped when they land exactly at the x-axis's own min/max — which
      // they do on Week Ahead's row-per-location graphs, since every row's
      // first/last row of data sits exactly at the displayed range's own
      // start/end. That auto-reserved margin (Chart.js's default) insets
      // the chart's own internal time-to-pixel mapping from the canvas's
      // true edges while the shared timeline header (plain CSS, no such
      // margin) doesn't — so the two drift apart the further from centre
      // you look: each row's graph reads a little late at its own start
      // and a little early at its own end relative to the header's
      // sunrise/sunset ticks above it. Turning this off makes the chart's
      // plot area span the canvas edge-to-edge, matching the header's own
      // unpadded pixel math exactly. Trade-off: the very first/last wind
      // arrow marker can now sit flush against (and be very slightly
      // clipped by) the canvas edge instead of being padded clear of it —
      // a minor cosmetic cost against every row lining up correctly with
      // the shared header, which matters far more here.
      // Also shrunk to the small (8) value, regardless of showDayHeading/
      // moonPhases, when overlayHeading is set — that draws the day
      // heading/moon icon INSIDE the plot area instead of in this reserved
      // strip above it, specifically to reclaim the space this padding
      // would otherwise set aside. See buildDayBandPlugin.
      // Bottom padding reserves vertical space for
      // buildConditionStripsPlugin's two condition-strip rows, so the
      // data lines' own Y-scale clears the strip zone instead of ever
      // rendering into it — same principle as the top padding already
      // reserving space for the day-heading strip above.
      //
      // Flat 39px regardless of isMobile (mobile's actual strip rows are
      // a few px shorter — see buildConditionStripsPlugin's own
      // stripHeight/rowGap — so this over-reserves slightly there, which
      // is harmless: a few extra px of blank space, not a mismatch in
      // the other direction). Kept as one flat number specifically so it
      // can't drift out of sync with the CSS values below it depends on.
      //
      // THIS PADDING ALONE ONLY MOVES THE PROBLEM, IT DOESN'T FIX IT: it
      // shrinks the plot area within whatever total canvas height the
      // page's CSS gives it, which compresses every data line CLOSER to
      // the new (higher) bottom edge — for a value that only had a
      // little headroom to begin with, shrinking the available height
      // can push it INTO the now-higher strip zone rather than clear of
      // it (this is exactly what happened the first time this was
      // "fixed": it visibly got worse, not better). The other, equally
      // required half of this fix is in each page's CSS: the fixed chart
      // frame height (.location-hover-panel-chart-frame,
      // .live-chart-frame, .weeknew-row-chart) needs to grow by this
      // same 39px, so the plot area's OWN usable height stays exactly
      // what it was before this reservation existed, and the 39px is
      // genuinely NEW space appended below it for the strips — not
      // carved out of space the data was already using.
      layout: {
        padding: {
          top: overlayHeading ? 8 : showDayHeading || moonPhases ? 40 : 8,
          bottom: 39,
        },
        autoPadding: false,
      },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          type: "linear",
          min: minT,
          max: maxT,
          // hideValueAxes hides this too, despite its name being about the
          // y ("value") axes — its only actual caller (the Location tab's
          // preview panel, app.js) wants every axis gone, and there was no
          // reason to invent a second, near-identical flag just to cover
          // the x-axis as well once that became true too.
          display: !compact && !hideValueAxes,
          // stepSize is exactly one hour in ms — a candidate tick at every
          // hour boundary within the visible range, not Chart.js's default
          // "nice round numbers" spacing. autoSkip:false forces every one
          // of those candidates to actually render rather than Chart.js
          // thinning them out to fit — Oliver explicitly asked for every
          // hour, so on a multi-day view this axis will genuinely be
          // dense; that's the deliberate trade-off of what was asked for,
          // not an oversight (autoSkip:true + a real crowding problem is
          // the one-setting revert if it turns out too cluttered in
          // practice). maxTicksLimit no longer does anything once
          // autoSkip is off, so it's dropped rather than left in place
          // pretending to still matter.
          ticks: { stepSize: 3600000, autoSkip: false, callback: (value) => fmtAxisHourTick(value) },
          grid: { color: "rgba(0,0,0,0.05)" },
        },
        // Each axis's min used to be pushed well below any realistic data
        // value specifically to leave clear space at the bottom for the
        // condition strips — no longer needed for that now that the
        // strips draw in their own reserved padding.bottom zone instead
        // of inside the plot area (buildConditionStripsPlugin) — so
        // yRain's min is a real 0 now, meaning 0% rainfall correctly sits
        // right at the very bottom rather than floating above it.
        // yTemp/yWind keep a small negative floor (-5) below their real
        // minimum (0°C-ish, 0 km/h) purely as a little visual breathing
        // room, not because anything below them needs the space anymore.
        // No axis title here (display:false) — a rotated Chart.js title
        // reserves a full extra margin column on the left/right regardless
        // of how short the text is. A compact "°C"/"km/h" label is drawn
        // directly at the top of each axis instead, by buildAxisUnitLabelsPlugin
        // below, using space already reserved for the day heading rather
        // than adding new margin.
        yTemp: { position: "left", min: -5, max: 40, display: !compact && !hideValueAxes, title: { display: false } },
        yRain: { display: false, min: 0, max: 100 },
        yWind: { position: "right", min: -5, max: 50, display: !compact && !hideValueAxes, grid: { drawOnChartArea: false }, title: { display: false } },
        yTide: {
          // Always hidden — the filled tide shape on the chart already
          // conveys high/low visually; a numeric axis for it isn't needed,
          // and hiding it keeps that side of the chart clear for temperature.
          display: false,
          position: "left",
          min: 0,
          max: tideAxisMax,
        },
        yPressure: {
          // Always hidden, same reasoning as yTide above — the line itself
          // (a thin black trend) is the point, not a readable number scale.
          // Fixed 970-1050hPa range (not per-location calibrated, unlike
          // yTide) — pressure swings are weather-driven, not a property of
          // the location, so one sensible fixed range covering the real
          // range Victoria sees suits every location equally well.
          display: false,
          position: "left",
          min: 970,
          max: 1050,
        },
      },
      plugins: {
        legend: {
          display: false,
          position: "bottom",
          labels: {
            boxWidth: isMobile ? 8 : 12,
            boxHeight: isMobile ? 8 : 12,
            padding: isMobile ? 6 : 10,
            font: { size: isMobile ? 8 : 10 },
          },
          // Preserves Chart.js's own default behavior (toggling that
          // dataset's visibility) while flagging that this click was a
          // genuine legend-item click — relying on Chart.js's own hit-
          // testing here, rather than reimplementing "was this click
          // inside the legend's drawn area" by hand. The canvas-level
          // "tap to show/hide the whole legend" handler below checks this
          // flag so it doesn't also fire for the same click.
          onClick: (e, legendItem, legend) => {
            Chart.defaults.plugins.legend.onClick.call(legend, e, legendItem, legend);
            canvas.dataset.legendItemJustClicked = "true";
          },
        },
        tooltip: {
          // Disabled entirely for callers that manually drive the
          // tooltip (disableBuiltinEvents — Live, Week Ahead) — see
          // buildTooltipCrosshairPlugin for why: Chart.js's own tooltip
          // rendering proved unreliable when triggered by an externally
          // set active element rather than a genuine hover, so those
          // pages draw their own box instead. enabled:false only turns
          // off the native BOX rendering — chart.tooltip.getActiveElements()
          // / setActiveElements() keep working exactly the same, which is
          // all that plugin needs. Every other caller is unaffected and
          // keeps Chart.js's normal tap/hover tooltip exactly as before.
          enabled: !disableBuiltinEvents,
          callbacks: {
            title: (items) =>
              items.length
                ? new Intl.DateTimeFormat([], { timeZone: "UTC", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(items[0].parsed.x))
                : "",
            // Location/Fishing Condition are drawn as strips, not real
            // datasets, so they don't get their own tooltip line from Chart.js
            // automatically — this adds one manually, looking up the same row
            // by index that the hovered point already resolved to.
            afterBody: (items) => {
              if (!items.length) return [];
              const row = rows[items[0].dataIndex];
              if (!row) return [];
              const lines = [];
              if (row["Condition"] != null) {
                lines.push(`Location ${row["Condition"].toFixed(1)}/5 — ${row["Condition Reason"] || ""}`);
              }
              if (row["Fishing Condition"] != null) {
                lines.push(`Fishing ${row["Fishing Condition"].toFixed(1)}/5 — ${row["Fishing Condition Reason"] || ""}`);
              }
              return lines;
            },
          },
        },
      },
    },
  });

  // Tap the graph to show/hide the legend — cursor:pointer signals it's clickable.
  // Only wired up outside compact mode — a compact chart's own click is reserved
  // for opening the full view instead (see live.js), and a toggleable legend
  // doesn't fit a deliberately minimal view anyway. Attach only once per canvas
  // element (guarded via dataset), since the canvas persists in the DOM across
  // repeated calls even as the Chart.js instance itself gets destroyed/recreated
  // on every render — Chart.getChart() always looks up whichever instance is
  // *currently* attached, so a stale closure isn't a risk.
  if (!compact) {
    canvas.style.cursor = "pointer";
    if (!canvas.dataset.legendToggleAttached) {
      canvas.dataset.legendToggleAttached = "true";
      canvas.addEventListener("click", () => {
        // A genuine legend-item click already ran through Chart.js's own
        // legend.onClick above (toggling that dataset's visibility) —
        // don't also collapse the whole legend for that same click, or
        // clicking any legend item immediately hides the legend it just
        // acted on, making it impossible to toggle a second item.
        if (canvas.dataset.legendItemJustClicked === "true") {
          canvas.dataset.legendItemJustClicked = "false";
          return;
        }
        const current = Chart.getChart(canvas);
        if (!current) return;
        current.options.plugins.legend.display = !current.options.plugins.legend.display;
        current.update();
      });
    }
  }

  return chart;
}

// ============================================================================
// Shared "qualifying session window" logic — used by week.js (Week Ahead)
// to compute sessions from the site-wide threshold/filter settings, kept
// here rather than duplicated so bug fixes only need to happen once.
// ============================================================================

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

  async function enterFullscreen() {
    try {
      if (target.requestFullscreen) await target.requestFullscreen();
      else if (target.webkitRequestFullscreen) target.webkitRequestFullscreen();
      else return;
    } catch (err) {
      return; // fullscreen refused/unsupported — nothing further to do
    }
    // Best-effort only — genuinely works now (inside fullscreen + a user
    // gesture) on browsers that support it, but plenty don't (notably iOS
    // Safari never does) — silently ignored on failure, since the
    // fullscreen view itself is still a real win even without a true
    // orientation lock.
    if (screen.orientation && screen.orientation.lock) {
      try {
        await screen.orientation.lock("landscape");
      } catch (err) {
        /* expected on unsupported browsers */
      }
    }
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
    if (e.target.closest("button")) return;

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
