const DATA_URL = "data/conditions.json";
const LOC_FILTER_STORAGE_KEY = "goodConditionsSelectedLocations";
const TRIP_TIMES_STORAGE_KEY = "goodConditionsTripTimes";

let allRows = [];
let allLocations = [];
let sunTimesData = {};
let selectedLocations = new Set();
let currentDetailChart = null;
let selectedCardEl = null;
let currentSelectedWindow = null;

// parseNaive comes from charts.js (loaded before this file).

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

// Session timestamps (w.from/w.to) use the same "naive local time treated as
// UTC" convention as everything else in this app (see parseNaive in
// charts.js) — they're NOT real UTC instants. To compare one against the
// browser's actual current time, re-interpret those same wall-clock digits
// as the browser's own local time instead (matching the same assumption
// app.js already relies on: the viewer's browser is in the same timezone
// the data represents, i.e. Melbourne).
function naiveMsToLocalDate(ms) {
  const d = new Date(ms);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
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

function computeSchedule(loc, launchStr, homeByStr) {
  const launch = timeToMinutes(launchStr);
  const homeBy = timeToMinutes(homeByStr);
  if (launch == null || homeBy == null || !loc) return null;

  const prep = timeToMinutes(loc.prep) || 0;
  const driveTo = timeToMinutes(loc.driveTo) || 0;
  const paddleOut = timeToMinutes(loc.paddleOut) || 0;
  const driveBack = timeToMinutes(loc.driveBack) || 0;
  const packUp = timeToMinutes(loc.packUp) || 0;
  const paddleBack = timeToMinutes(loc.paddleBack) || 0;

  const arrive = launch - prep;
  const leaveHome = arrive - driveTo;
  const fishAt = launch + paddleOut;
  const driveHome = homeBy - driveBack;
  const headBack = driveHome - packUp - paddleBack;
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
  };
}

function persistTripTimes() {
  const launch = document.getElementById("launchTime").value;
  const homeBy = document.getElementById("homeBy").value;
  localStorage.setItem(TRIP_TIMES_STORAGE_KEY, JSON.stringify({ launch, homeBy }));
}

function renderSchedule() {
  const container = document.getElementById("scheduleContainer");
  if (!currentSelectedWindow) {
    container.innerHTML = "";
    return;
  }

  const loc = allLocations.find((l) => l.name === currentSelectedWindow.locationName);
  const launchStr = document.getElementById("launchTime").value;
  const homeByStr = document.getElementById("homeBy").value;
  const schedule = computeSchedule(loc, launchStr, homeByStr);

  if (!schedule) {
    container.innerHTML = `<p class="footnote" style="margin:14px 0 0;text-align:left;">Set Launch Time and Home By above to see a full trip schedule for this location.</p>`;
    return;
  }

  container.innerHTML = `
    <label class="loc-edit-label" style="display:block;margin:16px 0 8px;">Trip schedule — ${loc.name}</label>
    <div class="schedule-fishing-time ${schedule.fishingTimeNegative ? "negative" : ""}" id="fishingTimeToggle" role="button" tabindex="0">
      Fishing time: <strong>${schedule.fishingTime}</strong>
      <span class="schedule-toggle-hint" id="scheduleToggleHint">▸ tap for times</span>
      ${schedule.fishingTimeNegative ? "<br>times don't add up, check Launch Time / Home By against this location's timings" : ""}
    </div>
    <div class="schedule-timeline collapsed" id="scheduleTimelineWrap">
      <div class="schedule-step"><span class="schedule-time">${schedule.leaveHome}</span><span class="schedule-label">Leave Home</span></div>
      <div class="schedule-step"><span class="schedule-time">${schedule.arrive}</span><span class="schedule-label">Arrive</span></div>
      <div class="schedule-step"><span class="schedule-time">${schedule.launch}</span><span class="schedule-label">Launch</span></div>
      <div class="schedule-step"><span class="schedule-time">${schedule.fishAt}</span><span class="schedule-label">Fish at</span></div>
      <div class="schedule-step"><span class="schedule-time">${schedule.headBack}</span><span class="schedule-label">Head Back</span></div>
      <div class="schedule-step"><span class="schedule-time">${schedule.driveHome}</span><span class="schedule-label">Drive Home</span></div>
      <div class="schedule-step"><span class="schedule-time">${schedule.homeBy}</span><span class="schedule-label">Home By</span></div>
    </div>
  `;

  const toggle = document.getElementById("fishingTimeToggle");
  const wrap = document.getElementById("scheduleTimelineWrap");
  const hint = document.getElementById("scheduleToggleHint");
  const toggleFn = () => {
    const nowCollapsed = wrap.classList.toggle("collapsed");
    hint.textContent = nowCollapsed ? "▸ tap for times" : "▾ hide times";
    requestAnimationFrame(updateStickyOffset);
  };
  toggle.addEventListener("click", toggleFn);
  toggle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleFn(); }
  });
}

async function init() {
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allRows = data.rows.map((r) => ({ ...r, _t: parseNaive(r.dateTime) }));
    allLocations = data.locations || [];
    sunTimesData = data.sunTimes || {};

    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(LOC_FILTER_STORAGE_KEY) || "null");
    } catch {
      saved = null;
    }
    const allNames = allLocations.map((l) => l.name);
    if (Array.isArray(saved) && saved.length) {
      // Keep only saved selections that still exist, so a removed/renamed location
      // doesn't leave a phantom entry silently excluding nothing.
      selectedLocations = new Set(saved.filter((n) => allNames.includes(n)));
    } else {
      selectedLocations = new Set(allNames);
    }

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

  renderLocationChips();
  document.getElementById("btnLocAll").addEventListener("click", () => {
    selectedLocations = new Set(allLocations.map((l) => l.name));
    persistSelectedLocations();
    renderLocationChips();
    render();
  });
  document.getElementById("btnLocNone").addEventListener("click", () => {
    selectedLocations = new Set();
    persistSelectedLocations();
    renderLocationChips();
    render();
  });

  const filtersToggle = document.getElementById("filtersToggle");
  const filtersContent = document.getElementById("filtersContent");
  const filtersHint = document.getElementById("filtersToggleHint");
  const toggleFilters = () => {
    const nowCollapsed = filtersContent.classList.toggle("collapsed");
    filtersHint.textContent = nowCollapsed ? "▸ tap to show" : "▾ hide";
  };
  filtersToggle.addEventListener("click", toggleFilters);
  filtersToggle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleFilters(); }
  });

  let savedTripTimes = null;
  try {
    savedTripTimes = JSON.parse(localStorage.getItem(TRIP_TIMES_STORAGE_KEY) || "null");
  } catch {
    savedTripTimes = null;
  }
  if (savedTripTimes) {
    document.getElementById("launchTime").value = savedTripTimes.launch || "";
    document.getElementById("homeBy").value = savedTripTimes.homeBy || "";
  }
  document.getElementById("launchTime").addEventListener("input", () => {
    persistTripTimes();
    renderSchedule();
  });
  document.getElementById("homeBy").addEventListener("input", () => {
    persistTripTimes();
    renderSchedule();
  });

  document.getElementById("minCondition").addEventListener("input", render);
  document.getElementById("minHours").addEventListener("input", render);
  render();
  requestAnimationFrame(updateStickyOffset);
}

function persistSelectedLocations() {
  localStorage.setItem(LOC_FILTER_STORAGE_KEY, JSON.stringify(Array.from(selectedLocations)));
}

function renderLocationChips() {
  const container = document.getElementById("locationChips");
  container.innerHTML = "";
  for (const loc of allLocations) {
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
      persistSelectedLocations();
      chip.classList.toggle("active");
      render();
    });
    container.appendChild(chip);
  }
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
  if (events.length) return events.join(", ");

  // No High/Low event actually falls inside this window — describe the trend instead
  // (Incoming/Outgoing), taken from whichever row is closest to the window's start.
  let nearest = null, nearestDiff = Infinity;
  for (const r of rows) {
    if (r["Tide Status"] == null) continue;
    const diff = Math.abs(r._t - from);
    if (diff < nearestDiff) { nearestDiff = diff; nearest = r; }
  }
  return nearest ? nearest["Tide Status"] : "—";
}

const DAY_COLORS = [
  { bg: "#eaf2fb", accent: "#1f4e78" }, // blue
  { bg: "#fef3e0", accent: "#b45309" }, // amber
  { bg: "#e8f7ee", accent: "#15803d" }, // green
  { bg: "#f3e8fd", accent: "#7c3aed" }, // purple
  { bg: "#fde8ec", accent: "#be123c" }, // rose
  { bg: "#e0f6f8", accent: "#0e7490" }, // cyan
  { bg: "#fdf6e3", accent: "#a16207" }, // olive
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

// Measures the sticky graph panel's actual rendered height (varies: short placeholder
// text before any window is clicked, vs. a full chart afterward, and the chart's own
// height varies by viewport width) and exposes it as a CSS variable so the sticky day
// headings in the list below know exactly how far down to stick, without hardcoding
// a guessed pixel value that would drift out of sync on different screens.
function updateStickyOffset() {
  const panel = document.getElementById("detailPanel");
  if (!panel) return;
  const height = panel.getBoundingClientRect().height;
  document.documentElement.style.setProperty("--detail-panel-height", `${height}px`);
}

let stickyOffsetResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(stickyOffsetResizeTimer);
  stickyOffsetResizeTimer = setTimeout(updateStickyOffset, 150);
});

function selectWindow(w, cardEl) {
  if (selectedCardEl) selectedCardEl.classList.remove("selected");
  if (cardEl) {
    cardEl.classList.add("selected");
    selectedCardEl = cardEl;
  }
  currentSelectedWindow = w;

  // Full calendar day for this location — not just the qualifying window's hour
  // span — so the graph shows the whole day's context around the good window.
  const dayStart = dateOnly(w.from);
  const dayRows = allRows
    .filter((r) => r["Location Name"] === w.locationName && dateOnly(r._t) === dayStart)
    .sort((a, b) => a._t - b._t);

  const placeholder = document.getElementById("detailPlaceholder");
  const canvas = document.getElementById("detailChart");

  if (dayRows.length === 0) {
    placeholder.textContent = "No data available for that day.";
    placeholder.style.display = "block";
    canvas.style.display = "none";
    if (currentDetailChart) { currentDetailChart.destroy(); currentDetailChart = null; }
    renderSchedule();
    requestAnimationFrame(updateStickyOffset);
    return;
  }

  placeholder.style.display = "none";
  canvas.style.display = "block";
  currentDetailChart = renderConditionsChart({
    canvas,
    rows: dayRows,
    sunTimes: sunTimesData[w.locationName] || [],
    existingChart: currentDetailChart,
    locationName: w.locationName,
  });
  renderSchedule();

  // Safety net: force Chart.js to re-measure after the browser has actually committed the
  // display:block change and settled layout — guards against the canvas being measured as
  // zero-size if this runs in the same paint tick as becoming visible (seen on some mobile
  // browsers, especially right after scrolling to reveal the panel).
  if (currentDetailChart) {
    requestAnimationFrame(() => {
      currentDetailChart && currentDetailChart.resize();
      updateStickyOffset();
    });
  }
}

function render() {
  const minCondition = Number(document.getElementById("minCondition").value) || 1;
  const minHours = Number(document.getElementById("minHours").value) || 1;

  const byLocation = {};
  for (const r of allRows) {
    const key = r["Location Name"];
    if (!selectedLocations.has(key)) continue;
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
        avgFishingCondition: average(locRows, "Fishing Condition", w.from, w.to),
        avgTemp: average(locRows, "Temp Forecast (C)", w.from, w.to),
        avgWind: average(locRows, "Wind Forecast (km/h)", w.from, w.to),
        avgRain: average(locRows, "Rainfall Probability (%)", w.from, w.to),
        tides: tidesInWindow(locRows, w.from, w.to),
      });
    }
  }

  // SORT by {From, Location Name} ascending, matching the Excel SORT({4,1},{1,1})
  results.sort((a, b) => a.from - b.from || a.locationName.localeCompare(b.locationName));

  // Don't show sessions that have already finished — no point suggesting a
  // trip window that's already in the past.
  const nowLocal = new Date();
  results = results.filter((w) => naiveMsToLocalDate(w.to) >= nowLocal);

  const container = document.getElementById("windowsContainer");
  const emptyState = document.getElementById("emptyState");
  container.innerHTML = "";

  if (results.length === 0) {
    emptyState.textContent = selectedLocations.size === 0
      ? "No locations selected — pick some above to see qualifying windows."
      : "No sessions meet the criteria";
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

  dayKeys.forEach((dayKey, dayIndex) => {
    const colors = DAY_COLORS[dayIndex % DAY_COLORS.length];

    const dayGroup = document.createElement("section");
    dayGroup.className = "day-group";

    const heading = document.createElement("h3");
    heading.className = "day-heading";
    heading.textContent = fmtNaive(dayKey, { weekday: "long", day: "numeric", month: "long" });
    heading.style.color = colors.accent;
    heading.style.borderBottomColor = colors.accent;
    dayGroup.appendChild(heading);

    // If the same location has more than one qualifying session today (e.g.
    // a morning window and a separate evening window), combine them into ONE
    // card listing every session, rather than showing duplicate cards for
    // the same spot.
    const byLocationThisDay = new Map();
    for (const w of byDay.get(dayKey)) {
      if (!byLocationThisDay.has(w.locationName)) byLocationThisDay.set(w.locationName, []);
      byLocationThisDay.get(w.locationName).push(w);
    }

    for (const [, sessions] of byLocationThisDay) {
      const first = sessions[0];
      const card = document.createElement("div");
      card.className = "window-card";
      card.style.background = colors.bg;
      card.style.borderLeft = `4px solid ${colors.accent}`;

      const sessionsHtml = sessions.map((w, idx) => {
        const timeRange = `${fmtNaive(w.from, { hour: "2-digit", minute: "2-digit", hour12: false })}–${fmtNaive(w.to, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
        return `
        <div class="session-block" data-session-idx="${idx}">
          <div class="window-card-top">
            <div class="window-sub">${timeRange} · ${w.hoursLabel}h</div>
            <div class="badge-stack">
              <div class="badge-item">
                <div class="condition-badge" style="background:${conditionColor(w.avgCondition)}">
                  ${w.avgCondition != null ? w.avgCondition.toFixed(1) : "–"}
                </div>
                <div class="badge-label">Location</div>
              </div>
              <div class="badge-item">
                <div class="condition-badge" style="background:${conditionColor(w.avgFishingCondition)}">
                  ${w.avgFishingCondition != null ? w.avgFishingCondition.toFixed(1) : "–"}
                </div>
                <div class="badge-label">Fishing</div>
              </div>
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
        </div>`;
      }).join("");

      card.innerHTML = `
        <div class="window-loc">${first.locationName}</div>
        <div class="window-sub" style="margin-bottom:8px;">${first.type || "–"} · shore ${first.shore || "–"}</div>
        ${sessionsHtml}
      `;

      // One click target for the whole card (heading + every session), not
      // per-session — every session in a merged card is the same calendar
      // day, so selectWindow's "full day" graph comes out identical no
      // matter which specific session triggered it. Uses the first session
      // as the representative window passed to selectWindow.
      card.addEventListener("click", () => selectWindow(sessions[0], card));

      dayGroup.appendChild(card);
    }

    container.appendChild(dayGroup);
  });
}

init();
