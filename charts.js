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
function renderConditionsChart({ canvas, rows, sunTimes, existingChart, locationName }) {
  if (existingChart) existingChart.destroy();
  if (!rows || rows.length === 0) return null;

  // On mobile, the full descriptive legend labels take up a lot of vertical space
  // under the chart (often wrapping to several lines) — shorten them there, since
  // desktop has plenty of room to keep the fuller, more descriptive text.
  const isMobile = typeof window !== "undefined" && window.innerWidth < 900;
  const L = isMobile
    ? { tempFcst: "Tmp Fcst", tempNow: "Tmp Now", rain: "Rain %", windFcst: "Wind Fcst", windNow: "Wind Now", tide: "Tide", condition: "Loc Cond" }
    : { tempFcst: "Temp Forecast (°C)", tempNow: "Temp Realtime (°C)", rain: "Rainfall Probability (%)", windFcst: "Wind Forecast (km/h)", windNow: "Wind Realtime (km/h)", tide: "Tide Height (m)", condition: "Location Condition (1-5)" };

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
    {
      label: L.condition,
      data: pointsFor("Condition"),
      borderColor: "#9333ea",
      borderWidth: 2,
      pointRadius: 2,
      pointBackgroundColor: "#9333ea",
      yAxisID: "yCondition",
      tension: 0.3,
    },
  ];

  const minT = rows[0]._t;
  const maxT = rows[rows.length - 1]._t;

  const chart = new Chart(canvas, {
    type: "line",
    data: { datasets },
    plugins: [buildDayBandPlugin(rows, sunTimes, locationName)],
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
        yTemp: { position: "left", title: { display: true, text: "Temperature (°C)" } },
        yRain: { display: false, min: 0, max: 100 },
        yWind: { position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "Wind (km/h)" } },
        yTide: { display: false, min: 0 },
        yCondition: { display: false, min: 0, max: 5.5 },
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
