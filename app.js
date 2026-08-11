const DATA_URL = "data/conditions.json";

const CONDITION_COLORS = {
  5: "var(--cond-5)",
  4: "var(--cond-4)",
  3: "var(--cond-3)",
  2: "var(--cond-2)",
  1: "var(--cond-1)",
};

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

function dayKeyOf(iso) {
  return iso.slice(0, 10); // "YYYY-MM-DD" — matches how conditions.json's dateTime strings are formatted
}

function formatDayHeading(dayKey) {
  // dayKey is "YYYY-MM-DD"; parse as UTC purely for formatting, no timezone shift intended
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat([], { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(dt);
}

const DAY_BAND_COLORS = ["rgba(31, 78, 120, 0.055)", "rgba(31, 78, 120, 0)"];
const NIGHT_BAND_COLOR = "rgba(15, 23, 42, 0.10)";
const TWILIGHT_BAND_COLOR = "rgba(15, 23, 42, 0.05)";

function buildDayBandPlugin(rows, sunTimes) {
  // Group rows by calendar day, tracking each day's exact start/end timestamp —
  // now that the x-axis is a true linear time scale, bands are positioned by
  // real elapsed time rather than by row index, so they're pixel-accurate
  // regardless of how densely each day happens to be sampled.
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
        // the range of its actual data points — matches the reference image's day columns.
        const [y, m, d] = g.key.split("-").map(Number);
        const dayStartT = Date.UTC(y, m - 1, d); // Date.UTC month is 0-indexed; g.key's is not
        const dayEndT = dayStartT + 24 * 3600 * 1000;

        const xStart = gi === 0 ? left : xScale.getPixelForValue(dayStartT);
        const xEnd = gi + 1 < dayGroups.length ? xScale.getPixelForValue(dayEndT) : right;

        // Alternating faint day band, so consecutive days are visually distinguishable
        ctx.fillStyle = DAY_BAND_COLORS[gi % 2];
        ctx.fillRect(xStart, top, xEnd - xStart, bottom - top);

        // Night / twilight shading, using this day's actual sunrise & sunset
        const sun = sunByDate.get(g.key);
        if (sun) {
          const xFirstLight = sun.firstLight != null ? xScale.getPixelForValue(parseNaive(sun.firstLight)) : null;
          const xSunrise = sun.sunrise != null ? xScale.getPixelForValue(parseNaive(sun.sunrise)) : null;
          const xSunset = sun.sunset != null ? xScale.getPixelForValue(parseNaive(sun.sunset)) : null;
          const xLastLight = sun.lastLight != null ? xScale.getPixelForValue(parseNaive(sun.lastLight)) : null;

          // Pre-dawn: night from day-start to first light, twilight from first light to sunrise
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

          // Dusk: twilight from sunset to last light, night from last light to day-end
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

        // Day heading, centered in the reserved top margin above this day's band
        ctx.fillStyle = "#1f4e78";
        ctx.font = "600 11px -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(formatDayHeading(g.key), (xStart + xEnd) / 2, top - 16);
      });
      ctx.restore();
    },
  };
}

let state = { data: null, rowsByLocation: {}, chart: null };

async function init() {
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    document.getElementById("updated").textContent = "Could not load data — has the site run its first update yet?";
    console.error(err);
    return;
  }

  groupRowsByLocation();
  renderUpdatedBanner();
  populateLocationPicker();

  document.getElementById("locationSelect").addEventListener("change", (e) => {
    localStorage.setItem("selectedLocation", e.target.value);
    renderLocation(e.target.value);
  });

  const saved = localStorage.getItem("selectedLocation");
  const first = state.data.locations[0]?.name;
  const initial = saved && state.rowsByLocation[saved] ? saved : first;
  if (initial) {
    document.getElementById("locationSelect").value = initial;
    renderLocation(initial);
  }
}

function groupRowsByLocation() {
  state.rowsByLocation = {};
  for (const row of state.data.rows) {
    row._t = parseNaive(row.dateTime);
    const key = row["Location Name"];
    if (!state.rowsByLocation[key]) state.rowsByLocation[key] = [];
    state.rowsByLocation[key].push(row);
  }
  for (const key in state.rowsByLocation) {
    state.rowsByLocation[key].sort((a, b) => a._t - b._t);
  }
}

function renderUpdatedBanner() {
  if (!state.data.generatedAt) {
    document.getElementById("updated").textContent = "Not updated yet — waiting on the first scheduled run";
    return;
  }
  const dt = new Date(state.data.generatedAt);
  document.getElementById("updated").textContent = `Updated ${dt.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
}

function populateLocationPicker() {
  const select = document.getElementById("locationSelect");
  select.innerHTML = "";
  const groups = { Kayak: [], Surf: [] };
  for (const loc of state.data.locations) {
    (groups[loc.type] || (groups[loc.type] = [])).push(loc);
  }
  for (const [type, locs] of Object.entries(groups)) {
    if (locs.length === 0) continue;
    const optgroup = document.createElement("optgroup");
    optgroup.label = type;
    for (const loc of locs) {
      const opt = document.createElement("option");
      opt.value = loc.name;
      opt.textContent = loc.name;
      optgroup.appendChild(opt);
    }
    select.appendChild(optgroup);
  }
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

function parseNaive(iso) {
  // Parse "YYYY-MM-DDTHH:MM:SS" (or with a space) into a timezone-neutral ms value,
  // treated as UTC purely for arithmetic/positioning — matches goodconditions.js's approach,
  // so both pages interpret the same conditions.json timestamps identically.
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function fmtChartTick(ms) {
  // Time only — the day is shown as a banner heading by the day-band plugin,
  // so repeating the weekday on every tick would just be redundant clutter.
  return new Intl.DateTimeFormat([], { timeZone: "UTC", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

function conditionPill(value) {
  if (value == null) return `<span class="pill" style="background:var(--cond-none)">–</span>`;
  const color = CONDITION_COLORS[value] || "var(--cond-none)";
  return `<span class="pill" style="background:${color}">${value}/5</span>`;
}

function tidePill(status) {
  const colors = { Low: "#0ea5e9", High: "#1d4ed8", Incoming: "#22c55e", Outgoing: "#f97316" };
  if (!status) return "–";
  return `<span class="pill" style="background:${colors[status] || "var(--cond-none)"}">${status}</span>`;
}

function renderLocation(name) {
  const loc = state.data.locations.find((l) => l.name === name);
  const rows = state.rowsByLocation[name] || [];
  const now = new Date();

  renderSummary(loc, rows, now);
  renderCharts(rows, loc);
  renderTable(rows);
}

function renderSummary(loc, rows, now) {
  const card = document.getElementById("summaryCard");
  if (rows.length === 0) {
    card.innerHTML = `<div class="empty-state">No data yet for this location. It'll appear after the next scheduled update.</div>`;
    return;
  }

  const tempRt = lastNonNullAtOrBefore(rows, "Temp Realtime (C)", now);
  const windRt = lastNonNullAtOrBefore(rows, "Wind Realtime (km/h)", now);
  const conditionRow = nearestRowWithField(rows, "Condition", now);
  const tideRow = nearestRowWithField(rows, "Tide Status", now);
  const tideHeightRow = nearestRowWithField(rows, "Tide Height (m)", now);

  const conditionVal = conditionRow ? conditionRow["Condition"] : null;

  card.innerHTML = `
    <div class="summary-top">
      <div>
        <div class="summary-title">${loc.name}</div>
        <div class="summary-sub">${loc.type} · shore faces ${loc.shore}</div>
      </div>
      <div class="condition-badge" style="background:${conditionVal != null ? (CONDITION_COLORS[conditionVal] || "var(--cond-none)") : "var(--cond-none)"}">
        ${conditionVal != null ? conditionVal + "/5" : "–"}
      </div>
    </div>
    <div class="stat-grid">
      <div class="stat">
        <div class="label">Temp now</div>
        <div class="value">${tempRt ? tempRt["Temp Realtime (C)"] + "°C" : "–"}</div>
      </div>
      <div class="stat">
        <div class="label">Wind now</div>
        <div class="value">${windRt ? Math.round(windRt["Wind Realtime (km/h)"]) + " km/h " + (windRt["Wind Realtime Dir"] || "") : "–"}</div>
      </div>
      <div class="stat">
        <div class="label">Tide</div>
        <div class="value">${tideRow ? tideRow["Tide Status"] : "–"}${tideHeightRow ? " · " + tideHeightRow["Tide Height (m)"] + "m" : ""}</div>
      </div>
    </div>
  `;
}

function renderCharts(rows, loc) {
  const sunTimes = (loc && state.data.sunTimes && state.data.sunTimes[loc.name]) || [];

  // {x, y} points on a true linear time axis, so equal elapsed time gets equal pixel
  // width regardless of how densely each day happens to be sampled (today's rows include
  // 10-min realtime readings; other days are hourly-forecast-only, so row *counts* per
  // day vary a lot — a category axis would stretch today's column wide to fit them all).
  const pointsFor = (field) => rows.map((r) => ({ x: r._t, y: r[field] ?? null }));

  const datasets = [
    {
      label: "Temp Forecast (°C)",
      data: pointsFor("Temp Forecast (C)"),
      borderColor: "#60a5fa",
      borderDash: [4, 3],
      pointRadius: 2,
      pointBackgroundColor: "#60a5fa",
      yAxisID: "yTemp",
      tension: 0.3,
    },
    {
      label: "Temp Realtime (°C)",
      data: pointsFor("Temp Realtime (C)"),
      borderColor: "#0f172a",
      pointRadius: 0,
      yAxisID: "yTemp",
      tension: 0.3,
    },
    {
      label: "Rainfall Probability (%)",
      data: pointsFor("Rainfall Probability (%)"),
      borderColor: "#eab308",
      pointRadius: 2,
      pointBackgroundColor: "#eab308",
      yAxisID: "yRain",
      tension: 0.3,
    },
    {
      label: "Wind Forecast (km/h)",
      data: pointsFor("Wind Forecast (km/h)"),
      borderColor: "#fca5a5",
      borderWidth: 1,
      pointStyle: "triangle",
      pointRadius: rows.map((r) => (r["Wind Forecast (km/h)"] != null ? 5 : 0)),
      pointRotation: rows.map((r) => dirToArrowRotation(r["Wind Forecast Dir"])),
      pointBackgroundColor: rows.map((r) => windColor(r["Wind Forecast (km/h)"])),
      pointBorderColor: rows.map((r) => windColor(r["Wind Forecast (km/h)"])),
      yAxisID: "yWind",
      tension: 0.3,
    },
    {
      label: "Wind Realtime (km/h)",
      data: pointsFor("Wind Realtime (km/h)"),
      borderColor: "#86efac",
      borderWidth: 1,
      pointStyle: "triangle",
      pointRadius: rows.map((r) => (r["Wind Realtime (km/h)"] != null ? 5 : 0)),
      pointRotation: rows.map((r) => dirToArrowRotation(r["Wind Realtime Dir"])),
      pointBackgroundColor: rows.map((r) => windColor(r["Wind Realtime (km/h)"])),
      pointBorderColor: rows.map((r) => windColor(r["Wind Realtime (km/h)"])),
      yAxisID: "yWind",
      tension: 0.3,
    },
    {
      label: "Tide Height (m)",
      data: pointsFor("Tide Height (m)"),
      borderColor: "#4f46e5",
      backgroundColor: "rgba(79, 70, 229, 0.15)",
      fill: true,
      pointRadius: 0,
      yAxisID: "yTide",
      tension: 0.4,
    },
  ];

  const minT = rows.length ? rows[0]._t : undefined;
  const maxT = rows.length ? rows[rows.length - 1]._t : undefined;

  if (state.chart) state.chart.destroy();
  state.chart = new Chart(document.getElementById("conditionsChart"), {
    type: "line",
    data: { datasets },
    plugins: rows.length > 0 ? [buildDayBandPlugin(rows, sunTimes)] : [],
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
          ticks: {
            maxTicksLimit: 10,
            callback: (value) => fmtChartTick(value),
          },
          grid: { color: "rgba(0,0,0,0.05)" },
        },
        // Left axis, visible: Temperature. Rainfall shares the visual left side but on its
        // own hidden scale (0-100) so it doesn't get squashed by the temperature range.
        yTemp: { position: "left", title: { display: true, text: "Temperature (°C)" } },
        yRain: { display: false, min: 0, max: 100 },
        // Right axis, visible: Wind speed. Tide shares the visual right side on its own
        // hidden scale so it keeps a sensible 0-few-metres range regardless of wind values.
        yWind: { position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "Wind (km/h)" } },
        yTide: { display: false, min: 0 },
      },
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 10 } } },
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? new Intl.DateTimeFormat([], { timeZone: "UTC", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(items[0].parsed.x)) : ""),
          },
        },
      },
    },
  });
}

function renderTable(rows) {
  const tbody = document.querySelector("#dataTable tbody");
  tbody.innerHTML = "";

  for (const r of rows) {
    const temp = r["Temp Forecast (C)"] ?? r["Temp Realtime (C)"];
    const wind = r["Wind Forecast (km/h)"] ?? r["Wind Realtime (km/h)"];
    const windDir = r["Wind Forecast Dir"] ?? r["Wind Realtime Dir"];

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtTime(r.dateTime)}</td>
      <td>${temp != null ? temp + "°" : "–"}</td>
      <td>${wind != null ? Math.round(wind) + " km/h " + (windDir || "") : "–"}</td>
      <td>${r["Rainfall Probability (%)"] != null ? r["Rainfall Probability (%)"] + "%" : "–"}</td>
      <td>${tidePill(r["Tide Status"])}${r["Tide Height (m)"] != null ? " " + r["Tide Height (m)"] + "m" : ""}</td>
      <td>${conditionPill(r["Condition"])}</td>
    `;
    tbody.appendChild(tr);
  }
}

init();
