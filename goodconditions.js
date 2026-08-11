const DATA_URL = "data/conditions.json";

let allRows = [];

// Parse a naive "YYYY-MM-DDTHH:MM:SS" string into a timezone-neutral ms value
// (treated as UTC purely for arithmetic, so results don't depend on the
// viewer's browser timezone).
function parseNaive(iso) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

function fmtNaive(ms, opts) {
  const d = new Date(ms);
  return new Intl.DateTimeFormat([], { timeZone: "UTC", ...opts }).format(d);
}

function hourOf(ms) {
  return new Date(ms).getUTCHours();
}

function dateOnly(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

async function init() {
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allRows = data.rows.map((r) => ({ ...r, _t: parseNaive(r.dateTime) }));

    if (!data.generatedAt) {
      document.getElementById("updated").textContent = "Not updated yet — waiting on the first scheduled run";
    } else {
      const dt = new Date(data.generatedAt);
      document.getElementById("updated").textContent = `Updated ${dt.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
    }
  } catch (err) {
    document.getElementById("updated").textContent = "Could not load data — has the site run its first update yet?";
    console.error(err);
    return;
  }

  document.getElementById("minCondition").addEventListener("input", render);
  document.getElementById("minHours").addEventListener("input", render);
  render();
}

function computeWindowsForLocation(locRows, minCondition, minHours) {
  // Only "hourly forecast rows" — where Condition is populated — participate in run detection,
  // matching the Excel calc area's P9 FILTER(Conditions[...], Conditions[Condition]<>"")
  const filtered = locRows.filter((r) => r.Condition != null).sort((a, b) => a._t - b._t);
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
    const isSegmentStart = AD[i] > 0 && AE[i] >= minHours && (AD[i] === 1 || hourOf(filtered[i]._t) === 0);
    if (!isSegmentStart) continue;

    const runStartDate = dateOnly(filtered[i]._t - (AD[i] - 1) * 3600 * 1000);
    const runEndDate = dateOnly(filtered[i]._t + (AE[i] - AD[i]) * 3600 * 1000);
    const spansMultipleDays = runStartDate !== runEndDate;

    const naturalEnd = filtered[i]._t + (AE[i] - AD[i]) * 3600 * 1000;
    const endOfDay = dateOnly(filtered[i]._t) + 23 * 3600 * 1000; // matches Excel's INT(date)+23/24
    const segmentEnd = Math.min(naturalEnd, endOfDay);

    const hoursLabel = (AE[i] - 1) + (spansMultipleDays ? "*" : "");

    windows.push({
      locationName: filtered[i]["Location Name"],
      type: filtered[i]["Type"],
      shore: filtered[i]["Shore"],
      from: filtered[i]._t,
      to: segmentEnd,
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

function tidesInWindow(rows, from, to) {
  const events = rows
    .filter((r) => r._t >= from && r._t <= to && (r["Tide Status"] === "High" || r["Tide Status"] === "Low"))
    .sort((a, b) => a._t - b._t)
    .map((r) => `${r["Tide Status"]} ${Number(r["Tide Height (m)"]).toFixed(2)}m @ ${fmtNaive(r._t, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })}`);
  return events.length ? events.join(", ") : "—";
}

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

function render() {
  const minCondition = Number(document.getElementById("minCondition").value) || 1;
  const minHours = Number(document.getElementById("minHours").value) || 1;

  const byLocation = {};
  for (const r of allRows) {
    const key = r["Location Name"];
    (byLocation[key] || (byLocation[key] = [])).push(r);
  }

  let results = [];
  for (const key in byLocation) {
    const locRows = byLocation[key];
    const windows = computeWindowsForLocation(locRows, minCondition, minHours);
    for (const w of windows) {
      results.push({
        ...w,
        avgCondition: average(locRows, "Condition", w.from, w.to),
        avgTemp: average(locRows, "Temp Forecast (C)", w.from, w.to),
        avgWind: average(locRows, "Wind Forecast (km/h)", w.from, w.to),
        avgRain: average(locRows, "Rainfall Probability (%)", w.from, w.to),
        tides: tidesInWindow(locRows, w.from, w.to),
      });
    }
  }

  // SORT by {From, Location Name} ascending, matching the Excel SORT({4,1},{1,1})
  results.sort((a, b) => a.from - b.from || a.locationName.localeCompare(b.locationName));

  const container = document.getElementById("windowsContainer");
  const emptyState = document.getElementById("emptyState");
  container.innerHTML = "";

  if (results.length === 0) {
    emptyState.style.display = "block";
    container.style.display = "none";
    return;
  }
  emptyState.style.display = "none";
  container.style.display = "block";

  // Group by calendar day of "From" — each window's from/to is already clipped to
  // a single day by computeWindowsForLocation, so this grouping is always clean.
  const byDay = new Map();
  for (const w of results) {
    const dayKey = dateOnly(w.from);
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey).push(w);
  }
  const dayKeys = Array.from(byDay.keys()).sort((a, b) => a - b);

  for (const dayKey of dayKeys) {
    const dayGroup = document.createElement("section");
    dayGroup.className = "day-group";

    const heading = document.createElement("h3");
    heading.className = "day-heading";
    heading.textContent = fmtNaive(dayKey, { weekday: "long", day: "numeric", month: "long" });
    dayGroup.appendChild(heading);

    for (const w of byDay.get(dayKey)) {
      const card = document.createElement("div");
      card.className = "window-card";
      const timeRange = `${fmtNaive(w.from, { hour: "2-digit", minute: "2-digit", hour12: false })}–${fmtNaive(w.to, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
      card.innerHTML = `
        <div class="window-card-top">
          <div>
            <div class="window-loc">${w.locationName}</div>
            <div class="window-sub">${w.type || "–"} · shore ${w.shore || "–"} · ${timeRange} · ${w.hoursLabel}h</div>
          </div>
          <div class="condition-badge" style="background:${conditionColor(w.avgCondition)}">
            ${w.avgCondition != null ? w.avgCondition.toFixed(1) : "–"}
          </div>
        </div>
        <div class="stat-grid">
          <div class="stat">
            <div class="label">Avg Temp</div>
            <div class="value">${w.avgTemp != null ? w.avgTemp.toFixed(1) + "°" : "–"}</div>
          </div>
          <div class="stat">
            <div class="label">Avg Wind</div>
            <div class="value">${w.avgWind != null ? Math.round(w.avgWind) + " km/h" : "–"}</div>
          </div>
          <div class="stat">
            <div class="label">Avg Rain</div>
            <div class="value">${w.avgRain != null ? Math.round(w.avgRain) + "%" : "–"}</div>
          </div>
        </div>
        <div class="window-tides">Tides: ${w.tides}</div>
      `;
      dayGroup.appendChild(card);
    }

    container.appendChild(dayGroup);
  }
}

init();
