// chart-base.js
// Shared basics used by every page with a graph: date/number formatting, wind and shore helpers, the small canvas icons (windsock, fish, home, car, boat), condition colours, chart-plugin builders for the axis labels and condition strips, and the tide-threshold (ramp access) calculation.
// One of the shared scripts split out of the old charts.js. All of them share one global scope; each page loads
// only the ones it needs, in this order (checked by scripts/check-page-scripts.mjs).

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

// A modest, tasteful tint — both non-zero (the original had the second
// at literal 0, invisible by design on alternating days). An earlier
// round pushed this all the way to 0.3/0.12 as a deliberate, unmissable
// diagnostic test, on the theory that the "gap" was this tint being too
// faint to register. It wasn't: even at 0.3 the person still saw plain
// white, which turned out to mean the real cause was elsewhere entirely
// (yTemp/yWind's axis max being hugely oversized relative to real data —
// see those scale definitions below — leaving the top of the chart
// structurally empty of any BOLD content regardless of this tint).
// Settled back to a subtle level now that this isn't doing the load-
// bearing work it was being tested for.
const DAY_BAND_COLORS = ["rgba(31, 78, 120, 0.06)", "rgba(31, 78, 120, 0.02)"];
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
  // 0, not a few px — the two strips sit directly touching now, per
  // feedback that even a small gap between them (and between the plot
  // area and the first strip) read as visually wrong once the actual
  // overlap bug was fixed. Each strip's own fill color still tells them
  // apart with no seam needed.
  const rowGap = 0;

  return {
    id: "conditionStrips",
    // Drawn INSIDE the plot area, anchored to its bottom edge — the
    // caller (renderConditionsChart) reserves exactly this much space via
    // layout.padding.bottom, so "inside the plot area" no longer means
    // "overlapping the data lines" the way it originally did; the data's
    // own Y-scale is squeezed to sit entirely above this strip zone
    // instead.
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
      const topMarginInPadding = 0; // flush against the plot area — safe now that strips are guaranteed to never overlap data (see the comment above), so there's no longer a reason to leave any gap here
      const locStripTop = bottom + topMarginInPadding;
      const fishStripTop = locStripTop + stripHeight + rowGap;

      // Backing rect flush with the strips themselves (no +/-px overshoot
      // into the plot area or past the last strip) — it used to reach 2px
      // into the plot area specifically to stay legible behind data lines
      // that could still be crossing right at that edge; now that overlap
      // is geometrically impossible, extending into the plot area at all
      // just reads as an extra sliver of gap between the chart and the
      // strips, which is exactly what this was meant to stop.
      ctx.save();
      ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
      ctx.fillRect(left, locStripTop, right - left, fishStripTop + stripHeight - locStripTop);
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

// String-formatted counterpart of nowInNaiveEncoding above, for anywhere a
// naive "YYYY-MM-DD HH:MM:SS" string (not a ms timestamp) is needed —
// currently just defaulting a brand-new mark's Date/Time and createdAt to
// "right now" (see startNewMarkEntry below).
function nowAsNaiveString() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
