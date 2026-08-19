// Shared between conditions.html (app.js) and index.html/Good Conditions (goodconditions.js) —
// one implementation of the combined temp/wind/rain/tide chart with day/night banding,
// so both pages render it identically and bug fixes only need to happen once.

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
  return new Intl.DateTimeFormat([], { timeZone: "UTC", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
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
// arrow — a shaft with an arrowhead, pointing up by default — onto a small offscreen canvas
// per color, and use that as a custom pointStyle. Chart.js rotates/positions a canvas
// pointStyle exactly like a built-in one, so dirToArrowRotation's angle math still applies
// unchanged. Cached per color since there are only a handful of distinct wind-speed colors.
const ARROW_CANVAS_CACHE = new Map();

function makeArrowCanvas(color) {
  if (ARROW_CANVAS_CACHE.has(color)) return ARROW_CANVAS_CACHE.get(color);
  const size = 14;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const cx = size / 2;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Shaft
  ctx.beginPath();
  ctx.moveTo(cx, size - 1);
  ctx.lineTo(cx, 4);
  ctx.stroke();

  // Arrowhead
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx - 3.5, 5.5);
  ctx.lineTo(cx + 3.5, 5.5);
  ctx.closePath();
  ctx.fill();

  ARROW_CANVAS_CACHE.set(color, canvas);
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
// competition to the actual data. Colour interpolates smoothly between the
// same five reference colours the badges use, since these scores are
// commonly fractional (e.g. 3.8), not just whole numbers.
const CONDITION_COLOR_STOPS = {
  1: [220, 38, 38],   // --cond-1
  2: [249, 115, 22],  // --cond-2
  3: [234, 179, 8],   // --cond-3
  4: [101, 163, 13],  // --cond-4
  5: [22, 163, 74],   // --cond-5
};
const CONDITION_NONE_COLOR = "rgb(156, 163, 175)"; // --cond-none

function conditionStripColor(value) {
  if (value == null) return CONDITION_NONE_COLOR;
  const clamped = Math.max(1, Math.min(5, value));
  const lower = Math.floor(clamped);
  const upper = Math.min(5, Math.ceil(clamped));
  if (lower === upper) {
    const [r, g, b] = CONDITION_COLOR_STOPS[lower];
    return `rgb(${r}, ${g}, ${b})`;
  }
  const t = clamped - lower;
  const [r1, g1, b1] = CONDITION_COLOR_STOPS[lower];
  const [r2, g2, b2] = CONDITION_COLOR_STOPS[upper];
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

function buildConditionStripsPlugin(rows, isMobile) {
  const stripHeight = isMobile ? 11 : 14;
  const rowGap = isMobile ? 2 : 3;
  const bottomMargin = 4; // small gap above the axis line itself

  return {
    id: "conditionStrips",
    // Drawn INSIDE the plot area, anchored to its bottom edge — deliberately
    // overlapping whatever data lines happen to be low at that point, rather
    // than reserving separate space below the graph. A semi-opaque backing
    // behind each strip keeps it legible against anything crossing behind it.
    afterDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      const xScale = scales.x;
      const { left, right, bottom } = chartArea;

      const fishStripTop = bottom - bottomMargin - stripHeight;
      const locStripTop = fishStripTop - rowGap - stripHeight;

      ctx.save();
      ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
      ctx.fillRect(left, locStripTop - 2, right - left, (fishStripTop + stripHeight) - locStripTop + 4);
      ctx.restore();

      const drawStrip = (field, label, stripTop) => {
        ctx.save();
        ctx.font = `700 ${isMobile ? 8 : 9}px -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.fillStyle = "#475569";
        // Right-aligned, ending just before chartArea.left — sits in the same
        // margin the y-axis's own tick labels/title already reserve.
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(label, left - 4, stripTop + stripHeight / 2);

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
        }
        ctx.restore();
      };

      drawStrip("Condition", "Loc", locStripTop);
      drawStrip("Fishing Condition", "Fish", fishStripTop);
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
    if (h1 === threshold || h2 === threshold || h1 === h2) continue; // avoid degenerate/duplicate crossings
    const above1 = h1 > threshold;
    const above2 = h2 > threshold;
    if (above1 !== above2) {
      const frac = (threshold - h1) / (h2 - h1);
      crossings.push({ t: t1 + frac * (t2 - t1), becomingAccessible: above2 });
    }
  }
  return crossings;
}

function buildNowAndThresholdPlugin(rows, minTideHeight, stopFishingTime) {
  return {
    id: "nowAndThreshold",
    afterDraw(chart) {
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

function buildDayBandPlugin(rows, sunTimes, locationName, moonPhases) {
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
        }

        ctx.fillStyle = "#1f4e78";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";

        const headingText = locationName ? `${locationName} — ${formatDayHeading(g.key)}` : formatDayHeading(g.key);

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

        ctx.fillText(headingText, (xStart + xEnd) / 2, top - 16);

        // Moon phase, one icon per day, drawn ABOVE the day heading (needs
        // its own reserved space — see the increased layout.padding.top
        // where this chart gets built). Custom-drawn to the exact real
        // illumination percentage, not snapped to one of 8 fixed pictures.
        const moonInfo = moonPhases && moonPhases[g.key];
        if (moonInfo && moonInfo.illumination != null) {
          const waxing = moonInfo.phase ? !moonInfo.phase.startsWith("Waning") : true;
          drawMoonIcon(ctx, (xStart + xEnd) / 2, top - 28, 9, moonInfo.illumination, waxing);
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
  "Condition", "Fishing Condition",
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

function renderConditionsChart({ canvas, rows, sunTimes, existingChart, locationName, tideMaxObserved, moonPhases, minTideHeight, stopFishingTime }) {
  if (existingChart) existingChart.destroy();
  if (!rows || rows.length === 0) return null;
  rows = bucketRowsHourly(rows);

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
    ? { tempFcst: "Tmp Fcst", tempNow: "Tmp Now", rain: "Rain %", windFcst: "Wind Fcst", windNow: "Wind Now", tide: "Tide" }
    : { tempFcst: "Temp Forecast (°C)", tempNow: "Temp Realtime (°C)", rain: "Rainfall Probability (%)", windFcst: "Wind Forecast (km/h)", windNow: "Wind Realtime (km/h)", tide: "Tide Height (m)" };

  const pointsFor = (field) => rows.map((r) => ({ x: r._t, y: r[field] ?? null }));

  const datasets = [
    {
      label: L.tempFcst,
      data: pointsFor("Temp Forecast (C)"),
      borderColor: "#f97316",
      borderWidth: 1,
      pointRadius: 2,
      pointBackgroundColor: "#f97316",
      yAxisID: "yTemp",
      tension: 0.3,
    },
    {
      label: L.tempNow,
      data: pointsFor("Temp Realtime (C)"),
      borderColor: "#fdba74",
      borderWidth: 1,
      pointRadius: 0,
      yAxisID: "yTemp",
      tension: 0.3,
    },
    {
      label: L.rain,
      data: pointsFor("Rainfall Probability (%)"),
      borderColor: "#3b82f6",
      pointRadius: 2,
      pointBackgroundColor: "#3b82f6",
      yAxisID: "yRain",
      tension: 0.3,
    },
    {
      label: L.windFcst,
      data: pointsFor("Wind Forecast (km/h)"),
      borderColor: "#16a34a",
      borderWidth: 1,
      pointStyle: rows.map((r) => makeArrowCanvas(windColor(r["Wind Forecast (km/h)"]))),
      pointRadius: rows.map((r) => (r["Wind Forecast (km/h)"] != null ? 7 : 0)),
      pointRotation: rows.map((r) => dirToArrowRotation(r["Wind Forecast Dir"])),
      yAxisID: "yWind",
      tension: 0.3,
    },
    {
      label: L.windNow,
      data: pointsFor("Wind Realtime (km/h)"),
      borderColor: "#86efac",
      borderWidth: 1,
      pointStyle: rows.map((r) => makeArrowCanvas(windColor(r["Wind Realtime (km/h)"]))),
      pointRadius: rows.map((r) => (r["Wind Realtime (km/h)"] != null ? 7 : 0)),
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
  ];

  const minT = rows[0]._t;
  const maxT = rows[rows.length - 1]._t;

  const chart = new Chart(canvas, {
    type: "line",
    data: { datasets },
    plugins: [buildDayBandPlugin(rows, sunTimes, locationName, moonPhases), buildConditionStripsPlugin(rows, isMobile), buildNowAndThresholdPlugin(rows, minTideHeight, stopFishingTime)],
    options: {
      responsive: true,
      spanGaps: true,
      // Extra top padding reserves space for two stacked elements above the
      // plot area: the moon phase glyph (drawn higher up) and the day
      // heading text below it (see buildDayBandPlugin).
      layout: { padding: { top: 40 } },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          type: "linear",
          min: minT,
          max: maxT,
          ticks: { maxTicksLimit: 10, callback: (value) => fmtChartTick(value) },
          grid: { color: "rgba(0,0,0,0.05)" },
        },
        // Each axis's min is pushed well below any realistic data value on
        // purpose — it compresses real data into the upper 60-70% of the
        // chart, leaving genuine clear space at the bottom for the condition
        // strips rather than the strips having to overlap low readings.
        yTemp: { position: "left", min: -5, max: 40, title: { display: true, text: "Temperature (°C)" } },
        yRain: { display: false, min: -10, max: 100 },
        yWind: { position: "right", min: -5, max: 50, grid: { drawOnChartArea: false }, title: { display: true, text: "Wind (km/h)" } },
        yTide: {
          position: "left",
          min: 0,
          max: tideAxisMax,
          grid: { drawOnChartArea: false }, // avoid a second set of gridlines cluttering the plot
          title: { display: true, text: "Tide (m)" },
          ticks: { maxTicksLimit: 5 },
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
        },
        tooltip: {
          callbacks: {
            title: (items) =>
              items.length
                ? new Intl.DateTimeFormat([], { timeZone: "UTC", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(items[0].parsed.x))
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
  // Attach only once per canvas element (guarded via dataset), since the canvas
  // persists in the DOM across repeated calls even as the Chart.js instance itself
  // gets destroyed/recreated on every render — Chart.getChart() always looks up
  // whichever instance is *currently* attached, so a stale closure isn't a risk.
  canvas.style.cursor = "pointer";
  if (!canvas.dataset.legendToggleAttached) {
    canvas.dataset.legendToggleAttached = "true";
    canvas.addEventListener("click", () => {
      const current = Chart.getChart(canvas);
      if (!current) return;
      current.options.plugins.legend.display = !current.options.plugins.legend.display;
      current.update();
    });
  }

  return chart;
}
