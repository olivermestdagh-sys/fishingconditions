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

function findNearestIndexInRange(rows, targetIso, startIdx, endIdx) {
  if (!targetIso) return null;
  const target = new Date(targetIso.replace(" ", "T")).getTime();
  let best = null, bestDiff = Infinity;
  for (let i = startIdx; i <= endIdx; i++) {
    const t = new Date(rows[i].dateTime).getTime();
    const diff = Math.abs(t - target);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return best;
}

const DAY_BAND_COLORS = ["rgba(31, 78, 120, 0.055)", "rgba(31, 78, 120, 0)"];
const NIGHT_BAND_COLOR = "rgba(15, 23, 42, 0.10)";
const TWILIGHT_BAND_COLOR = "rgba(15, 23, 42, 0.05)";

function buildDayBandPlugin(rows, sunTimes) {
  // Group row indices by calendar day, in the order they already appear (rows are pre-sorted).
  const dayGroups = [];
  let currentKey = null;
  for (let i = 0; i < rows.length; i++) {
    const key = dayKeyOf(rows[i].dateTime);
    if (key !== currentKey) {
      currentKey = key;
      dayGroups.push({ key, startIdx: i, endIdx: i });
    } else {
      dayGroups[dayGroups.length - 1].endIdx = i;
    }
  }
  const sunByDate = new Map((sunTimes || []).map((s) => [s.date, s]));

  return {
    id: "dayBands",
    beforeDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || dayGroups.length === 0) return;
      const xScale = scales.x;
      const { top, bottom, right } = chartArea;
      const oneStep = rows.length > 1 ? xScale.getPixelForValue(1) - xScale.getPixelForValue(0) : 0;

      ctx.save();
      dayGroups.forEach((g, gi) => {
        const xStart = xScale.getPixelForValue(g.startIdx) - oneStep / 2;
        const xEnd = gi + 1 < dayGroups.length
          ? xScale.getPixelForValue(dayGroups[gi + 1].startIdx) - oneStep / 2
          : right;

        // Alternating faint day band, so consecutive days are visually distinguishable
        ctx.fillStyle = DAY_BAND_COLORS[gi % 2];
        ctx.fillRect(xStart, top, xEnd - xStart, bottom - top);

        // Night / twilight shading, using this day's actual sunrise & sunset
        const sun = sunByDate.get(g.key);
        if (sun) {
          const firstLightIdx = findNearestIndexInRange(rows, sun.firstLight, g.startIdx, g.endIdx);
          const sunriseIdx = findNearestIndexInRange(rows, sun.sunrise, g.startIdx, g.endIdx);
          const sunsetIdx = findNearestIndexInRange(rows, sun.sunset, g.startIdx, g.endIdx);
          const lastLightIdx = findNearestIndexInRange(rows, sun.lastLight, g.startIdx, g.endIdx);

          const px = (idx) => (idx == null ? null : xScale.getPixelForValue(idx));
          const xFirstLight = px(firstLightIdx);
          const xSunrise = px(sunriseIdx);
          const xSunset = px(sunsetIdx);
          const xLastLight = px(lastLightIdx);

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
    const key = row["Location Name"];
    if (!state.rowsByLocation[key]) state.rowsByLocation[key] = [];
    state.rowsByLocation[key].push(row);
  }
  for (const key in state.rowsByLocation) {
    state.rowsByLocation[key].sort((a, b) => a.dateTime.localeCompare(b.dateTime));
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

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function fmtChartTick(iso) {
  // Time only — the day is now shown as a banner heading by the day-band plugin,
  // so repeating the weekday on every tick would just be redundant clutter.
  const d = new Date(iso);
  return d.toLocaleString([], { hour: "2-digit", minute: "2-digit" });
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
  const labels = rows.map((r) => fmtChartTick(r.dateTime));
  const sunTimes = (loc && state.data.sunTimes && state.data.sunTimes[loc.name]) || [];

  const datasets = [
    {
      label: "Temp Forecast (°C)",
      data: rows.map((r) => r["Temp Forecast (C)"] ?? null),
      borderColor: "#60a5fa",
      borderDash: [4, 3],
      pointRadius: 2,
      pointBackgroundColor: "#60a5fa",
      yAxisID: "yTemp",
      tension: 0.3,
    },
    {
      label: "Temp Realtime (°C)",
      data: rows.map((r) => r["Temp Realtime (C)"] ?? null),
      borderColor: "#0f172a",
      pointRadius: 0,
      yAxisID: "yTemp",
      tension: 0.3,
    },
    {
      label: "Rainfall Probability (%)",
      data: rows.map((r) => r["Rainfall Probability (%)"] ?? null),
      borderColor: "#eab308",
      pointRadius: 2,
      pointBackgroundColor: "#eab308",
      yAxisID: "yRain",
      tension: 0.3,
    },
    {
      label: "Wind Forecast (km/h)",
      data: rows.map((r) => r["Wind Forecast (km/h)"] ?? null),
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
      data: rows.map((r) => r["Wind Realtime (km/h)"] ?? null),
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
      data: rows.map((r) => r["Tide Height (m)"] ?? null),
      borderColor: "#4f46e5",
      backgroundColor: "rgba(79, 70, 229, 0.15)",
      fill: true,
      pointRadius: 0,
      yAxisID: "yTide",
      tension: 0.4,
    },
  ];

  if (state.chart) state.chart.destroy();
  state.chart = new Chart(document.getElementById("conditionsChart"), {
    type: "line",
    data: { labels, datasets },
    plugins: rows.length > 0 ? [buildDayBandPlugin(rows, sunTimes)] : [],
    options: {
      responsive: true,
      spanGaps: true,
      layout: { padding: { top: 20 } },
      interaction: { mode: "index", intersect: false },
      scales: {
        // Left axis, visible: Temperature. Rainfall shares the visual left side but on its
        // own hidden scale (0-100) so it doesn't get squashed by the temperature range.
        yTemp: { position: "left", title: { display: true, text: "Temperature (°C)" } },
        yRain: { display: false, min: 0, max: 100 },
        // Right axis, visible: Wind speed. Tide shares the visual right side on its own
        // hidden scale so it keeps a sensible 0-few-metres range regardless of wind values.
        yWind: { position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "Wind (km/h)" } },
        yTide: { display: false, min: 0 },
      },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 10 } } } },
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
