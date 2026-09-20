// Reports page — client-side aggregation over the same /api/public/marks
// data every other page already reads, matching this whole site's existing
// architecture (no new backend endpoints). Reports only ever consider
// type === "Catch" marks — Sessions/POI/Mark aren't "a catch" and would
// skew every one of these counts if included.

let reportsAllMarks = [];
let reportsFilteredCatches = [];
let reportsTrackedLocations = [];
let reportTideChartInstance = null;

// ---------------------------------------------------------------------
// Filter definitions and state
// ---------------------------------------------------------------------

// Same pick-list-backed fields already used for marks elsewhere
// (MARK_LIST_FIELDS, charts.js) minus Mark Type (reports are always
// Catch-only, so filtering by type would be redundant) — plus two
// genuinely new numeric range filters this feature specifically asked
// for (temperature, water depth), which don't exist as filters anywhere
// else on the site yet.
const REPORT_PICKLIST_FIELDS = MARK_LIST_FIELDS.filter((f) => f.key !== "type");

let reportsFilters = {
  dateFrom: "",
  dateTo: "",
  picklist: {}, // key -> selected value ("" = any)
  temperatureMin: "",
  temperatureMax: "",
  waterDepthMin: "",
  waterDepthMax: "",
};

function resetReportsFilters() {
  reportsFilters = {
    dateFrom: "",
    dateTo: "",
    picklist: {},
    temperatureMin: "",
    temperatureMax: "",
    waterDepthMin: "",
    waterDepthMax: "",
  };
}

function buildReportsFilterUI() {
  const grid = document.getElementById("reportsFilterGrid");
  let html = "";

  html += `<div class="reports-filter-field">
    <label>From date</label>
    <input type="date" id="reportsFilterDateFrom" />
  </div>
  <div class="reports-filter-field">
    <label>To date</label>
    <input type="date" id="reportsFilterDateTo" />
  </div>`;

  for (const field of REPORT_PICKLIST_FIELDS) {
    const values = Array.from(
      new Set(
        reportsAllMarks
          .filter((m) => m.type === "Catch")
          .flatMap((m) => splitMultiValue(m[field.key]))
          .filter(Boolean)
      )
    ).sort();
    if (values.length === 0) continue;
    html += `<div class="reports-filter-field">
      <label>${escapeHtml(field.label)}</label>
      <select data-report-filter-picklist="${field.key}">
        <option value="">Any</option>
        ${values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("")}
      </select>
    </div>`;
  }

  html += `<div class="reports-filter-field">
    <label>Temperature (°C)</label>
    <div class="reports-range-row">
      <input type="number" id="reportsFilterTempMin" placeholder="Min" />
      <input type="number" id="reportsFilterTempMax" placeholder="Max" />
    </div>
  </div>
  <div class="reports-filter-field">
    <label>Water depth (m)</label>
    <div class="reports-range-row">
      <input type="number" id="reportsFilterDepthMin" placeholder="Min" />
      <input type="number" id="reportsFilterDepthMax" placeholder="Max" />
    </div>
  </div>`;

  grid.innerHTML = html;
}

/** bait/rig/rod/berley store comma-joined multi-values (established
 * convention throughout this codebase — see the Sync page's own carry-
 * forward fields) — this splits and trims them back into a real array
 * for filtering/counting purposes. A single-value field (species,
 * weatherCondition, etc.) just comes back as a one-item array, which
 * every call site here treats identically either way. */
function splitMultiValue(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function readReportsFilterInputsIntoState() {
  reportsFilters.dateFrom = document.getElementById("reportsFilterDateFrom").value;
  reportsFilters.dateTo = document.getElementById("reportsFilterDateTo").value;
  reportsFilters.temperatureMin = document.getElementById("reportsFilterTempMin").value;
  reportsFilters.temperatureMax = document.getElementById("reportsFilterTempMax").value;
  reportsFilters.waterDepthMin = document.getElementById("reportsFilterDepthMin").value;
  reportsFilters.waterDepthMax = document.getElementById("reportsFilterDepthMax").value;
  reportsFilters.picklist = {};
  document.querySelectorAll("[data-report-filter-picklist]").forEach((el) => {
    if (el.value) reportsFilters.picklist[el.dataset.reportFilterPicklist] = el.value;
  });
}

function catchMatchesReportsFilters(mark) {
  if (mark.type !== "Catch") return false;
  if (reportsFilters.dateFrom && (!mark.dateTime || mark.dateTime.slice(0, 10) < reportsFilters.dateFrom)) return false;
  if (reportsFilters.dateTo && (!mark.dateTime || mark.dateTime.slice(0, 10) > reportsFilters.dateTo)) return false;
  for (const [key, wanted] of Object.entries(reportsFilters.picklist)) {
    const values = splitMultiValue(mark[key]);
    if (!values.includes(wanted)) return false;
  }
  const temp = mark.temperature;
  if (reportsFilters.temperatureMin !== "" && (temp == null || temp < Number(reportsFilters.temperatureMin))) return false;
  if (reportsFilters.temperatureMax !== "" && (temp == null || temp > Number(reportsFilters.temperatureMax))) return false;
  const depth = mark.waterDepth;
  if (reportsFilters.waterDepthMin !== "" && (depth == null || depth < Number(reportsFilters.waterDepthMin))) return false;
  if (reportsFilters.waterDepthMax !== "" && (depth == null || depth > Number(reportsFilters.waterDepthMax))) return false;
  return true;
}

function applyReportsFilters() {
  readReportsFilterInputsIntoState();
  reportsFilteredCatches = reportsAllMarks.filter(catchMatchesReportsFilters);
  renderAllReports();
}

// ---------------------------------------------------------------------
// Report 1 — catch rate by tide stage
// ---------------------------------------------------------------------

// Which dimension forms the main columns; the other is stacked inside each.
// Toggled by the buttons above the chart.
let tideReportGroupBy = "condition"; // "condition" | "extreme"

// Tide Extreme segments — same colours as the Tide Extreme pick-list in D1
// (Higher/Lower High Water in purples, Higher/Lower Low Water in oranges),
// plus grey for catches with no extreme recorded (everything logged before
// that field existed).
const TIDE_EXTREME_ORDER = ["HHW", "LHW", "HLW", "LLW", "(none)"];
const TIDE_EXTREME_COLORS = {
  HHW: "#4723fb",
  LHW: "#a78bfa",
  HLW: "#ee823a",
  LLW: "#b45309",
  "(none)": "#9ca3af",
};
const TIDE_EXTREME_NAMES = {
  HHW: "Higher high water",
  LHW: "Lower high water",
  HLW: "Higher low water",
  LLW: "Lower low water",
  "(none)": "No extreme recorded",
};
const TIDE_EXTREME_MEANINGS = {
  HHW: "the higher of the day's two high tides",
  LHW: "the lower of the day's two high tides",
  HLW: "the higher of the day's two low tides",
  LLW: "the lower of the day's two low tides",
  "(none)": "logged before the extreme was recorded, or it couldn't be ranked",
};

// The 8 Tide Condition values. Slack = within 10 min of an extreme; Start Run
// = first 2 h after leaving one; Last Run = final 2 h before reaching one;
// Running = the middle of the tide. In = rising, Out = falling.
const TIDE_CONDITION_ORDER = [
  "Slack High", "Last Run In", "Running In", "Start Run In",
  "Slack Low", "Last Run Out", "Running Out", "Start Run Out",
  "(not recorded)",
];
const TIDE_CONDITION_COLORS = {
  "Slack High": "#1e3a8a",
  "Last Run In": "#2563eb",
  "Running In": "#60a5fa",
  "Start Run In": "#0e7490",
  "Slack Low": "#7c2d12",
  "Last Run Out": "#ea580c",
  "Running Out": "#fbbf24",
  "Start Run Out": "#65a30d",
  "(not recorded)": "#9ca3af",
};
const TIDE_CONDITION_MEANINGS = {
  "Slack High": "at high tide, water standing still (within 10 min of the peak)",
  "Last Run In": "rising, final 2 h before high tide",
  "Running In": "rising, mid-tide (more than 2 h from either extreme)",
  "Start Run In": "rising, first 2 h after low tide",
  "Slack Low": "at low tide, water standing still (within 10 min of the bottom)",
  "Last Run Out": "falling, final 2 h before low tide",
  "Running Out": "falling, mid-tide (more than 2 h from either extreme)",
  "Start Run Out": "falling, first 2 h after high tide",
  "(not recorded)": "no tide condition was recorded",
};

const TIDE_DIMENSIONS = {
  condition: {
    title: "tide condition",
    order: TIDE_CONDITION_ORDER,
    colors: TIDE_CONDITION_COLORS,
    labelOf: (k) => k,
    meaningOf: (k) => TIDE_CONDITION_MEANINGS[k],
    keyOf: (c) => c.tideCondition || "(not recorded)",
  },
  extreme: {
    title: "tide extreme",
    order: TIDE_EXTREME_ORDER,
    colors: TIDE_EXTREME_COLORS,
    labelOf: (k) => (k === "(none)" ? "Not recorded" : `${k} – ${TIDE_EXTREME_NAMES[k]}`),
    meaningOf: (k) => TIDE_EXTREME_MEANINGS[k],
    keyOf: (c) => c.tideExtreme || "(none)",
  },
};

function renderTideReport() {
  const main = TIDE_DIMENSIONS[tideReportGroupBy];
  const stack = TIDE_DIMENSIONS[tideReportGroupBy === "condition" ? "extreme" : "condition"];

  document.querySelectorAll("[data-tide-group]").forEach((btn) => {
    const on = btn.dataset.tideGroup === tideReportGroupBy;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.className = on ? "btn-primary" : "btn-secondary";
  });
  const note = document.getElementById("reportTideNote");
  if (note) note.textContent = `Columns are ${main.title}; each is stacked by ${stack.title}, biggest at the bottom.`;

  const counts = new Map(); // main key -> total
  const byStack = new Map(); // main key -> Map(stack key -> count)
  for (const c of reportsFilteredCatches) {
    const mk = main.keyOf(c);
    const sk = stack.keyOf(c);
    counts.set(mk, (counts.get(mk) || 0) + 1);
    if (!byStack.has(mk)) byStack.set(mk, new Map());
    const m = byStack.get(mk);
    m.set(sk, (m.get(sk) || 0) + 1);
  }
  const empty = document.getElementById("reportTideEmpty");
  const canvas = document.getElementById("reportTideChart");
  const legend = document.getElementById("reportTideLegend");
  if (counts.size === 0) {
    empty.style.display = "block";
    canvas.style.display = "none";
    if (legend) legend.innerHTML = "";
    if (reportTideChartInstance) {
      reportTideChartInstance.destroy();
      reportTideChartInstance = null;
    }
    return;
  }
  empty.style.display = "none";
  canvas.style.display = "block";

  // Columns in the natural tide order (extremes: HHW..LLW; conditions: high
  // tide, rising, low tide, falling); anything unknown goes last.
  const rankIn = (order, k) => (order.indexOf(k) === -1 ? order.length : order.indexOf(k));
  const labels = Array.from(counts.keys()).sort((a, b) => rankIn(main.order, a) - rankIn(main.order, b));

  // Each column is stacked biggest segment at the bottom, smallest on top.
  // Chart.js stacks whole datasets in order, but the order differs per
  // column, so datasets here are "the Nth-biggest segment of each column"
  // and each point carries its own stack key (for colour and tooltip).
  const segmentsPerLabel = labels.map((l) =>
    Array.from(byStack.get(l).entries()).sort(
      (a, b) => b[1] - a[1] || rankIn(stack.order, a[0]) - rankIn(stack.order, b[0])
    )
  );
  const layers = Math.max(...segmentsPerLabel.map((s) => s.length));
  const datasets = [];
  for (let k = 0; k < layers; k++) {
    datasets.push({
      label: `Segment ${k + 1}`,
      data: segmentsPerLabel.map((s) => (s[k] ? s[k][1] : 0)),
      stackKeys: segmentsPerLabel.map((s) => (s[k] ? s[k][0] : null)),
      backgroundColor: segmentsPerLabel.map((s) => (s[k] ? stack.colors[s[k][0]] || "#9ca3af" : "transparent")),
      borderColor: "#ffffff",
      borderWidth: 1,
    });
  }

  // Legend: only the stacked values actually present, with their meanings.
  if (legend) {
    const present = stack.order.filter((e) => segmentsPerLabel.some((s) => s.some(([x]) => x === e)));
    legend.innerHTML = present
      .map(
        (e) =>
          `<div style="display:flex;align-items:flex-start;gap:6px;margin:0 0 4px;font-size:0.8rem;">` +
          `<span style="flex:none;width:12px;height:12px;margin-top:3px;border-radius:3px;background:${stack.colors[e]};display:inline-block;"></span>` +
          `<span><strong>${escapeHtml(stack.labelOf(e))}</strong> — ${escapeHtml(stack.meaningOf(e))}</span></div>`
      )
      .join("");
  }

  if (reportTideChartInstance) reportTideChartInstance.destroy();
  reportTideChartInstance = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: (item) => item.raw > 0,
          callbacks: {
            title: (items) => {
              if (!items.length) return "";
              const l = items[0].label;
              const name = tideReportGroupBy === "extreme" ? main.labelOf(l) : l;
              return name;
            },
            beforeBody: (items) => {
              if (!items.length) return "";
              const m = main.meaningOf(items[0].label);
              return m ? m.charAt(0).toUpperCase() + m.slice(1) : "";
            },
            label: (item) => `${stack.labelOf(item.dataset.stackKeys[item.dataIndex])}: ${item.raw}`,
            footer: (items) => (items.length ? `Total: ${counts.get(items[0].label)}` : ""),
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          ticks: tideReportGroupBy === "extreme" ? { callback: (v, i) => labels[i] } : {},
        },
        y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  });
}

// ---------------------------------------------------------------------
// Report 2 — bait/rig/rod effectiveness
// ---------------------------------------------------------------------

function renderGearReport() {
  const wrap = document.getElementById("reportGearTables");
  const empty = document.getElementById("reportGearEmpty");
  if (reportsFilteredCatches.length === 0) {
    wrap.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  const fields = [
    { key: "bait", label: "Bait" },
    { key: "rig", label: "Rig" },
    { key: "rod", label: "Rod" },
  ];

  let html = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;">`;
  for (const field of fields) {
    const counts = new Map();
    for (const c of reportsFilteredCatches) {
      for (const v of splitMultiValue(c[field.key])) {
        counts.set(v, (counts.get(v) || 0) + 1);
      }
    }
    const rows = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    html += `<div>
      <table class="report-table" data-gear-table="${field.key}">
        <thead><tr><th>${escapeHtml(field.label)}</th><th style="text-align:right;">Catches</th></tr></thead>
        <tbody>
          ${rows.length > 0 ? rows.map(([name, count]) => `<tr><td>${escapeHtml(name)}</td><td style="text-align:right;">${count}</td></tr>`).join("") : `<tr><td colspan="2" class="footnote">No ${escapeHtml(field.label.toLowerCase())} recorded</td></tr>`}
        </tbody>
      </table>
    </div>`;
  }
  html += `</div>`;
  wrap.innerHTML = html;
}

// ---------------------------------------------------------------------
// Report 3 — catches by location
// ---------------------------------------------------------------------

/** Matches every filtered catch to its nearest tracked location, using
 * ONE shared, pre-loaded location list rather than the one-mark-at-a-
 * time findNearestTrackedLocation (charts.js) that popups use — that
 * version re-fetches (from its own cache) and does its own scan per
 * call, which is fine for a single popup but would mean redoing the
 * same linear scan over every tracked location once per catch here,
 * for potentially thousands of catches. */
function nearestLocationNameBulk(mark) {
  if (mark.lat == null || mark.lng == null || reportsTrackedLocations.length === 0) return "(unknown)";
  let best = null;
  let bestDist = Infinity;
  for (const loc of reportsTrackedLocations) {
    if (typeof loc.lat !== "number" || typeof loc.lng !== "number") continue;
    const d = distanceMetersBetween(mark.lat, mark.lng, loc.lat, loc.lng);
    if (d < bestDist) {
      bestDist = d;
      best = loc;
    }
  }
  return best ? displayNameFor(best) : "(unknown)";
}

function renderLocationReport() {
  const wrap = document.getElementById("reportLocationTableWrap");
  const empty = document.getElementById("reportLocationEmpty");
  if (reportsFilteredCatches.length === 0) {
    wrap.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  const counts = new Map(); // name -> { count, species: Set }
  for (const c of reportsFilteredCatches) {
    const name = nearestLocationNameBulk(c);
    const entry = counts.get(name) || { count: 0, species: new Set() };
    entry.count++;
    if (c.species) entry.species.add(c.species);
    counts.set(name, entry);
  }
  const rows = Array.from(counts.entries())
    .map(([name, entry]) => ({ name, count: entry.count, speciesCount: entry.species.size }))
    .sort((a, b) => b.count - a.count);

  const html = `<table class="report-table">
    <thead><tr><th>Location</th><th style="text-align:right;">Catches</th><th style="text-align:right;">Distinct species</th></tr></thead>
    <tbody>
      ${rows.map((r) => `<tr><td>${escapeHtml(r.name)}</td><td style="text-align:right;">${r.count}</td><td style="text-align:right;">${r.speciesCount}</td></tr>`).join("")}
    </tbody>
  </table>`;
  wrap.innerHTML = html;
}

// ---------------------------------------------------------------------
// Shared render + init
// ---------------------------------------------------------------------

function renderAllReports() {
  document.getElementById("reportsSummaryLine").textContent = `${reportsFilteredCatches.length} catch${reportsFilteredCatches.length === 1 ? "" : "es"} match the current filters (out of ${reportsAllMarks.filter((m) => m.type === "Catch").length} total).`;
  renderTideReport();
  renderGearReport();
  renderLocationReport();
  refreshSessionRibbon(); // the calendar follows the date filters (it ignores the other catch filters)
}

document.addEventListener("DOMContentLoaded", async () => {
  const gateEl = document.getElementById("reportsNotConnected");
  const mainEl = document.getElementById("reportsMain");
  await refreshAdminStatus();
  if (!cachedIsAdmin) {
    gateEl.style.display = "block";
    mainEl.style.display = "none";
    return;
  }
  gateEl.style.display = "none";
  mainEl.style.display = "block";

  const [marksRes] = await Promise.all([fetch(`${MARKS_FILE_PATH}?_=${Date.now()}`, { cache: "no-store", credentials: "include" })]);
  reportsAllMarks = marksRes.ok ? await marksRes.json() : [];
  reportsTrackedLocations = await loadTrackedLocationsForLookup();

  buildReportsFilterUI();
  resetReportsFilters();
  reportsFilteredCatches = reportsAllMarks.filter((m) => m.type === "Catch");
  renderAllReports();
  initSessionRibbon(reportsAllMarks);

  const toggle = document.getElementById("reportsFiltersToggle");
  const content = document.getElementById("reportsFiltersContent");
  const hint = document.getElementById("reportsFiltersToggleHint");
  const toggleFilters = () => {
    const nowCollapsed = content.classList.toggle("collapsed");
    hint.textContent = nowCollapsed ? "▸ tap to show" : "▾ hide";
  };
  toggle.addEventListener("click", toggleFilters);
  toggle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleFilters();
    }
  });

  document.querySelectorAll("[data-tide-group]").forEach((btn) =>
    btn.addEventListener("click", () => {
      tideReportGroupBy = btn.dataset.tideGroup;
      renderTideReport();
    })
  );

  document.getElementById("reportsApplyFiltersBtn").addEventListener("click", applyReportsFilters);
  document.getElementById("reportsResetFiltersBtn").addEventListener("click", () => {
    document.querySelectorAll("#reportsFilterGrid input").forEach((el) => (el.value = ""));
    document.querySelectorAll("#reportsFilterGrid select").forEach((el) => (el.value = ""));
    resetReportsFilters();
    reportsFilteredCatches = reportsAllMarks.filter((m) => m.type === "Catch");
    renderAllReports();
  });
});
