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

function buildNowAndThresholdPlugin() {
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
      }
    },
  };
}

function buildDayBandPlugin(rows, sunTimes, locationName) {
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

function renderConditionsChart({ canvas, rows, sunTimes, existingChart, locationName }) {
  if (existingChart) existingChart.destroy();
  if (!rows || rows.length === 0) return null;
  rows = bucketRowsHourly(rows);

  // On mobile, the full descriptive legend labels take up a lot of vertical space
  // under the chart (often wrapping to several lines) — shorten them there, since
  // desktop has plenty of room to keep the fuller, more descriptive text.
  const isMobile = typeof window !== "undefined" && window.innerWidth < 900;
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
    plugins: [buildDayBandPlugin(rows, sunTimes, locationName), buildConditionStripsPlugin(rows, isMobile), buildNowAndThresholdPlugin()],
    options: {
      responsive: true,
      spanGaps: true,
      layout: { padding: { top: 20 } },
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
        yTide: { display: false, min: 0, max: 3.5 },
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
