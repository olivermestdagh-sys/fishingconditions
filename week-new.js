// Week Ahead (new) — row-per-location layout. Every location passing the
// Location/Type filters gets its own always-visible conditions graph,
// spanning the SAME fixed [timelineStart, timelineEnd] range as every
// other row (unlike the earlier per-session-tile version of this page,
// where each tile's own width/range depended on that session's own
// sun-anchored context — the cause of the "long sessions stretch the
// layout" and "things don't quite line up" problems that version had).
// Any qualifying session(s) for a location are shaded on top of its
// always-visible graph via the shared session-span plugin (charts.js),
// which now supports more than one span per chart — a location can have
// zero, one, or several separate qualifying windows across the displayed
// period.
//
// Locations can be pinned (star icon, in both the filter chips and each
// row's own header) to float to the top of the list, ahead of the
// unpinned locations below — a lighter-weight alternative to full
// drag-and-drop reordering. Pin state persists in localStorage, separate
// from the shared location/type/threshold keys (charts.js), since pinning
// is specific to this page's layout.
//
// Still deliberately does NOT have: hover-preview, click-to-open modal,
// the old per-tile sticky-content trick, or trip schedule — none of that
// applies to an always-visible row-per-location layout either.

// Detects "this is a phone-sized device" the same way the CSS
// force-landscape trick in week-new.html does (max-width: 900px) —
// checked against the SHORTER of the two dimensions so it's
// orientation-independent (a phone rotated to landscape is still a phone).
const isMobileDevice = Math.min(window.innerWidth, window.innerHeight) <= 900;

const DATA_URL = "data/conditions.json";
// Half the usual scale on mobile — 32px/hour was sized for a desktop-width
// screen. At that same scale on a phone's much narrower rotated-landscape
// width, a single day took up nearly the entire visible width on its own,
// leaving almost no surrounding context and forcing far more horizontal
// scrolling per day than made sense for the smaller screen.
const PIXELS_PER_HOUR = isMobileDevice ? 16 : 32;
const SIDEBAR_WIDTH = 220; // px — the frozen left-hand column showing each row's location name/pin/sessions

let allRows = [];
let allLocations = [];
let sunTimesData = {};
let moonPhasesData = {};
let selectedLocations = new Set();
let selectedTypes = new Set(["Kayak", "Land based"]);
let pinnedOrder = []; // location NAMES, in the order they were pinned — oldest pin first

// Chart.js instances currently on screen — one per RENDERED location row
// (not necessarily every row that exists — see rowVisibilityObserver
// below). Torn down and rebuilt every renderWeekView() call. Chart.js
// doesn't garbage-collect an instance just because its canvas left the
// DOM, so these must be destroyed explicitly or every re-render leaks
// whatever was already built.
let activeRowCharts = [];

// Lazily builds a row's chart only once that row actually scrolls into
// view, instead of building every location's chart upfront — with 14+
// locations each rendering a several-thousand-pixel-wide, high-resolution
// canvas, building all of them synchronously on load was measured taking
// over a second of blocking main-thread work even on a fast desktop, and
// far longer on mobile (Chart.js scales canvas resolution by
// devicePixelRatio, typically 2–3 on phones, multiplying that cost
// several times over). One observer per renderWeekView() call — reset
// (disconnected) at the start of every render alongside activeRowCharts,
// since it's watching DOM elements that are about to be thrown away.
let rowVisibilityObserver = null;
// Plain-scroll-event fallback for the same job — see the comment where
// this is wired up in renderWeekView for why IntersectionObserver alone
// wasn't reliable enough on its own. Tracked so the old listener can be
// removed before a new one is attached on the next render, same reason
// rowVisibilityObserver gets disconnected rather than left to pile up.
let rowVisibilityScrollTarget = null;
let rowVisibilityScrollHandler = null;

const PINNED_LOCATIONS_STORAGE_KEY = "goodConditionsPinnedLocationsNew";

function loadPinnedOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(PINNED_LOCATIONS_STORAGE_KEY) || "null");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function persistPinnedOrder() {
  localStorage.setItem(PINNED_LOCATIONS_STORAGE_KEY, JSON.stringify(pinnedOrder));
}

/**
 * Pinning is keyed by location NAME, not (name, type) — matching how the
 * existing location filter chips already work (one chip per physical
 * spot, deduped across its Kayak/Land based entries). Pinning "Corinella
 * Boat Ramp" floats BOTH its Kayak and Land based rows to the top
 * together, rather than needing to pin each type separately.
 */
function togglePin(name) {
  const idx = pinnedOrder.indexOf(name);
  if (idx === -1) {
    pinnedOrder.push(name);
  } else {
    pinnedOrder.splice(idx, 1);
  }
  persistPinnedOrder();
  renderLocationChipsWithPins();
  renderWeekView();
}

/**
 * Turns a hidden number input into a stepper: a circular badge (styled
 * like the Location/Fishing rating circles on session rows) showing the
 * current value, with +/− buttons either side. For Min Condition, the
 * badge is colored via conditionColor() — the exact same function that
 * colors those row badges — so a "3.0" here looks like a "3.0" would
 * anywhere else on the page. Min consecutive hours isn't a 1-5 condition
 * rating, so colorFn is null there — same badge shape, fixed neutral color
 * (see .rating-stepper-badge-neutral), purely for visual consistency.
 */
function wireThresholdStepper(id, step, min, max, colorFn) {
  const input = document.getElementById(id);
  const badge = document.getElementById(id + "Badge");
  const upBtn = document.getElementById(id + "Up");
  const downBtn = document.getElementById(id + "Down");

  function updateDisplay() {
    const value = Number(input.value);
    badge.textContent = value.toFixed(1);
    if (colorFn) badge.style.background = colorFn(value);
    downBtn.disabled = value <= min;
    upBtn.disabled = value >= max;
  }

  function changeBy(delta) {
    // Rounded to 1 decimal place — repeated 0.1 increments would otherwise
    // drift via ordinary floating-point error (e.g. 1.1 + 0.1 = 1.2000000000000002).
    const raw = Math.min(max, Math.max(min, Number(input.value) + delta));
    input.value = Math.round(raw * 10) / 10;
    updateDisplay();
    persistThresholds();
    renderWeekView();
  }

  downBtn.addEventListener("click", () => changeBy(-step));
  upBtn.addEventListener("click", () => changeBy(step));
  updateDisplay();
}

async function init() {
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allRows = data.rows.map((r) => ({ ...r, _t: parseNaive(r.dateTime) }));
    allLocations = data.locations || [];
    sunTimesData = data.sunTimes || {};
    moonPhasesData = data.moonPhases || {};
    if (data.generatedAt) {
      const dt = new Date(data.generatedAt);
      document.getElementById("updated").textContent = `Updated ${dt.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
    }
  } catch (err) {
    document.getElementById("updated").textContent = "Could not load data — has the site run its first update yet?";
    console.error(err);
    return;
  }

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

  // Locations/types filters and Min Condition/Min Hours thresholds persist
  // across visits (same localStorage keys as week.js, via charts.js) —
  // shared with the original Week Ahead page on purpose, since they're the
  // same underlying settings, not a separate copy for this page. Pin
  // order (below) is its own separate key, specific to this page's layout.
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(LOC_FILTER_STORAGE_KEY) || "null");
  } catch {
    saved = null;
  }
  const allNames = allLocations.map((l) => l.name);
  if (Array.isArray(saved) && saved.length) {
    selectedLocations = new Set(saved.filter((n) => allNames.includes(n)));
  } else {
    selectedLocations = new Set(allNames);
  }

  let savedTypes = null;
  try {
    savedTypes = JSON.parse(localStorage.getItem(TYPE_FILTER_STORAGE_KEY) || "null");
  } catch {
    savedTypes = null;
  }
  selectedTypes = Array.isArray(savedTypes) && savedTypes.length ? new Set(savedTypes) : new Set(["Kayak", "Land based"]);

  let savedThresholds = null;
  try {
    savedThresholds = JSON.parse(localStorage.getItem(THRESHOLDS_STORAGE_KEY) || "null");
  } catch {
    savedThresholds = null;
  }
  if (savedThresholds) {
    if (savedThresholds.minCondition != null) document.getElementById("minCondition").value = savedThresholds.minCondition;
    if (savedThresholds.minHours != null) document.getElementById("minHours").value = savedThresholds.minHours;
  }

  // Drop any pinned name that no longer exists in the data (a location was
  // renamed/removed in Settings since the last visit) — same defensive
  // pattern as the saved-locations filter above.
  pinnedOrder = loadPinnedOrder().filter((n) => allNames.includes(n));

  renderLocationChipsWithPins();
  renderTypeChips(selectedTypes, renderWeekView);
  document.getElementById("btnLocAll").addEventListener("click", () => {
    selectedLocations = new Set(allLocations.map((l) => l.name));
    persistSelectedLocations(selectedLocations);
    renderLocationChipsWithPins();
    renderWeekView();
  });
  document.getElementById("btnLocNone").addEventListener("click", () => {
    selectedLocations = new Set();
    persistSelectedLocations(selectedLocations);
    renderLocationChipsWithPins();
    renderWeekView();
  });

  wireThresholdStepper("minCondition", 0.1, 1, 5, conditionColor);
  wireThresholdStepper("minHours", 1, 1, 24, null);

  renderWeekView();
}

/**
 * Same idea as charts.js's shared renderLocationChips, but with a pin/star
 * button on each chip too — kept as its own page-local copy rather than
 * extending the shared function, so week.js (and any other page using the
 * shared chips) is completely unaffected by this page's pinning feature.
 * The star and the chip's own select/deselect are separate click targets
 * (the star calls stopPropagation) so tapping one never triggers the other.
 */
function renderLocationChipsWithPins() {
  const container = document.getElementById("locationChips");
  container.innerHTML = "";
  const seenNames = new Set();
  for (const loc of allLocations) {
    if (seenNames.has(loc.name)) continue;
    seenNames.add(loc.name);

    const chip = document.createElement("span");
    chip.className = "loc-chip weeknew-chip" + (selectedLocations.has(loc.name) ? " active" : "");

    const star = document.createElement("button");
    star.type = "button";
    star.className = "weeknew-pin-btn" + (pinnedOrder.includes(loc.name) ? " pinned" : "");
    star.setAttribute("aria-label", pinnedOrder.includes(loc.name) ? `Unpin ${loc.name}` : `Pin ${loc.name} to top`);
    star.textContent = pinnedOrder.includes(loc.name) ? "★" : "☆";
    star.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePin(loc.name);
    });
    chip.appendChild(star);

    const label = document.createElement("button");
    label.type = "button";
    label.className = "weeknew-chip-label";
    label.textContent = loc.name;
    label.addEventListener("click", () => {
      if (selectedLocations.has(loc.name)) {
        selectedLocations.delete(loc.name);
      } else {
        selectedLocations.add(loc.name);
      }
      persistSelectedLocations(selectedLocations);
      chip.classList.toggle("active");
      renderWeekView();
    });
    chip.appendChild(label);

    container.appendChild(chip);
  }
}

/**
 * Pinned locations first (in the order they were pinned), then everything
 * else in their normal default order — which is simply the order
 * locations already appear in config/locations.json (i.e. whatever order
 * is already maintained via the Settings page), not a new sort invented
 * here. Array.prototype.sort is stable, so within each group (pinned /
 * unpinned) relative order is otherwise preserved.
 */
function sortLocationsForDisplay(locationEntries) {
  const pinned = [];
  const rest = [];
  for (const loc of locationEntries) {
    if (pinnedOrder.includes(loc.name)) pinned.push(loc); else rest.push(loc);
  }
  pinned.sort((a, b) => pinnedOrder.indexOf(a.name) - pinnedOrder.indexOf(b.name));
  return [...pinned, ...rest];
}

/**
 * One entry per (location, type) that passes the current filters, each
 * with its own list of qualifying sessions (zero, one, or several) within
 * the displayed period — computed the same way as the old Week Ahead page
 * (computeWindowsForLocation, shared in charts.js), just no longer
 * collapsed into "one tile per session"; here every session for the same
 * location lands on that location's single row.
 */
function computeLocationRows() {
  const nowLocal = new Date();
  const minCondition = Number(document.getElementById("minCondition").value) || 1;
  const minHours = Number(document.getElementById("minHours").value) || 1;

  const filtered = allLocations.filter((loc) => selectedLocations.has(loc.name) && selectedTypes.has(loc.type));
  const ordered = sortLocationsForDisplay(filtered);

  return ordered.map((loc) => {
    const locRows = allRows.filter((r) => r["Location Name"] === loc.name && r["Type"] === loc.type);
    const windows = computeWindowsForLocation(locRows, minCondition, minHours);
    const seenSpans = new Set();
    const sessions = [];
    for (const w of windows) {
      if (naiveMsToLocalDate(w.to) < nowLocal) continue; // already finished
      const spanKey = `${w.from}::${w.to}`;
      if (seenSpans.has(spanKey)) continue; // same session, different day-anchor duplicate
      seenSpans.add(spanKey);
      sessions.push({
        ...w,
        avgCondition: average(locRows, "Condition", w.from, w.to),
        avgFishingCondition: average(locRows, "Fishing Condition", w.from, w.to),
        tempRange: rangeOf(locRows, "Temp Forecast (C)", w.from, w.to),
        windRange: rangeOf(locRows, "Wind Forecast (km/h)", w.from, w.to),
        maxRain: maxOf(locRows, "Rainfall Probability (%)", w.from, w.to),
      });
    }
    return { loc, locRows, sessions };
  });
}

/**
 * Small sunrise/sunset marker (tick + time label) drawn in the shared
 * timeline header — unchanged from the earlier per-tile version of this
 * page.
 */
function buildSunMarker(x, timeLabel) {
  const wrap = document.createElement("div");
  wrap.className = "week-sun-marker";
  wrap.style.left = x + "px";
  wrap.innerHTML = `<div class="week-sun-tick"></div><div class="week-sun-label">${timeLabel}</div>`;
  return wrap;
}

function renderWeekView() {
  for (const c of activeRowCharts) c.destroy();
  activeRowCharts = [];
  if (rowVisibilityObserver) rowVisibilityObserver.disconnect();
  if (rowVisibilityScrollTarget) {
    rowVisibilityScrollTarget.removeEventListener("scroll", rowVisibilityScrollHandler);
    window.removeEventListener("resize", rowVisibilityScrollHandler);
    rowVisibilityScrollTarget = null;
    rowVisibilityScrollHandler = null;
  }

  const locationRows = computeLocationRows();
  const emptyState = document.getElementById("weekEmptyState");
  const scrollWrap = document.getElementById("weekTimelineScroll");
  const inner = document.getElementById("weekTimelineInner");

  if (locationRows.length === 0) {
    emptyState.style.display = "block";
    scrollWrap.style.display = "none";
    inner.innerHTML = "";
    return;
  }
  emptyState.style.display = "none";
  scrollWrap.style.display = "block";

  // Every row shares this SAME [timelineStart, timelineEnd] range — this
  // is what fixes the earlier per-tile version's "long sessions stretch
  // things" and "doesn't line up" problems: there's no per-row width/range
  // math left to get subtly wrong, every row (and the header above them)
  // is exactly the same width. timelineEnd is simply however far the
  // fetched data actually reaches (data.forecastDays' worth, in practice),
  // not something computed per-tile.
  const nowMs = nowInNaiveEncoding();
  const timelineStart = dateOnly(nowMs);
  const maxRowT = allRows.length ? Math.max(...allRows.map((r) => r._t)) : timelineStart + 86400000;
  const timelineEnd = Math.max(timelineStart + 86400000, maxRowT);
  const totalHours = (timelineEnd - timelineStart) / 3600000;
  const totalTrackWidth = Math.max(1, totalHours) * PIXELS_PER_HOUR;

  inner.innerHTML = "";
  inner.style.width = SIDEBAR_WIDTH + totalTrackWidth + "px";

  // Sun times aren't per-location on the shared header — pick any one
  // location's data as representative (Victorian locations are close
  // enough together that sunrise/sunset times barely differ day to day).
  const sunTimesEntry = Object.values(sunTimesData).find((arr) => arr && arr.length) || [];
  const sunByDate = new Map(sunTimesEntry.map((s) => [s.date, s]));

  // Header row: a blank spacer the width of the sidebar (nothing to freeze
  // there — the day/hour ticks scroll horizontally in sync with the chart
  // columns beneath them, which is exactly what should happen), then the
  // existing day-boundary/date/moon/hour-tick/sunrise-sunset content,
  // unchanged from the old per-tile version. Sticky to the top of
  // weekTimelineScroll's own scroll (position:sticky — see style.css)
  // regardless of how many location rows you've scrolled past below.
  const headerRow = document.createElement("div");
  headerRow.className = "weeknew-header-row";

  const headerSpacer = document.createElement("div");
  headerSpacer.className = "weeknew-header-spacer";
  // The gesture hints live here specifically — top-left, above the first
  // location's name and before the first day column — rather than
  // floating over the graphs themselves, which is where they'd otherwise
  // sit right on top of the data being described.
  headerSpacer.innerHTML = `
    <div class="weeknew-graph-hint" aria-hidden="true">
      <div>Double-tap toggles full screen</div>
      <div>Hold for 2s to toggle data point</div>
    </div>
  `;
  headerRow.appendChild(headerSpacer);

  const headerTrack = document.createElement("div");
  headerTrack.className = "week-track week-header-track";
  headerTrack.style.width = totalTrackWidth + "px";

  for (let dayMs = timelineStart, dayIdx = 0; dayMs <= timelineEnd; dayMs += 86400000, dayIdx++) {
    const leftPx = ((dayMs - timelineStart) / 3600000) * PIXELS_PER_HOUR;
    const dayEndPx = Math.min(totalTrackWidth, leftPx + 24 * PIXELS_PER_HOUR);
    const dateKey = new Date(dayMs).toISOString().slice(0, 10);

    const dayColor = DAY_COLORS[dayIdx % DAY_COLORS.length];
    const dayTint = document.createElement("div");
    dayTint.className = "week-header-day-tint";
    dayTint.style.left = leftPx + "px";
    dayTint.style.width = dayEndPx - leftPx + "px";
    dayTint.style.background = dayColor.bg;
    headerTrack.appendChild(dayTint);

    const boundary = document.createElement("div");
    boundary.className = "week-day-boundary";
    boundary.style.left = leftPx + "px";
    headerTrack.appendChild(boundary);

    const label = document.createElement("div");
    label.className = "week-day-label";
    label.style.left = leftPx + 4 + "px";
    label.textContent = fmtNaive(dayMs, { weekday: "short", day: "numeric", month: "short" });
    headerTrack.appendChild(label);

    const moonInfo = moonPhasesData[dateKey];
    const skipPositions = [];
    if (moonInfo && moonInfo.illumination != null) {
      const moonX = leftPx + 90;
      skipPositions.push(moonX);
      const moonCanvas = document.createElement("canvas");
      moonCanvas.className = "week-moon-icon";
      moonCanvas.width = 14;
      moonCanvas.height = 14;
      moonCanvas.style.left = moonX + "px";
      const mctx = moonCanvas.getContext("2d");
      const waxing = moonInfo.phase ? !moonInfo.phase.startsWith("Waning") : true;
      drawMoonIcon(mctx, 7, 7, 6, moonInfo.illumination, waxing);
      headerTrack.appendChild(moonCanvas);
    }

    const sun = sunByDate.get(dateKey);
    if (sun) {
      if (sun.sunrise != null) {
        const x = leftPx + ((parseNaive(sun.sunrise) - dayMs) / 3600000) * PIXELS_PER_HOUR;
        skipPositions.push(x);
        headerTrack.appendChild(buildSunMarker(x, fmtChartTick(parseNaive(sun.sunrise))));
      }
      if (sun.sunset != null) {
        const x = leftPx + ((parseNaive(sun.sunset) - dayMs) / 3600000) * PIXELS_PER_HOUR;
        skipPositions.push(x);
        headerTrack.appendChild(buildSunMarker(x, fmtChartTick(parseNaive(sun.sunset))));
      }
    }

    const MIN_GAP_PX = 34;
    for (let h = 3; h < 24; h += 3) {
      const hourLeftPx = leftPx + h * PIXELS_PER_HOUR;
      if (hourLeftPx > dayEndPx) break;
      if (skipPositions.some((sx) => Math.abs(sx - hourLeftPx) < MIN_GAP_PX)) continue;
      const tick = document.createElement("div");
      tick.className = "week-hour-tick";
      tick.style.left = hourLeftPx + "px";
      headerTrack.appendChild(tick);
      const hourLabel = document.createElement("div");
      hourLabel.className = "week-hour-label";
      hourLabel.style.left = hourLeftPx + "px";
      hourLabel.textContent = String(h).padStart(2, "0") + ":00";
      headerTrack.appendChild(hourLabel);
    }
  }

  const nowLeftPx = ((nowMs - timelineStart) / 3600000) * PIXELS_PER_HOUR;
  if (nowLeftPx >= 0 && nowLeftPx <= totalTrackWidth) {
    const nowLine = document.createElement("div");
    nowLine.className = "week-now-line";
    nowLine.style.left = nowLeftPx + "px";
    headerTrack.appendChild(nowLine);
  }

  headerRow.appendChild(headerTrack);
  inner.appendChild(headerRow);

  // One row per location — sidebar (name/pin/sessions, frozen to the left
  // edge via position:sticky while the chart beside it scrolls) + a chart
  // spanning the full [timelineStart, timelineEnd] range, identically
  // sized/positioned on every row.
  //
  // Every row's DOM is built and attached immediately, but each row's
  // chartWrap starts at a tiny placeholder width (see buildLocationRowElement)
  // rather than its true, often-several-thousand-pixel width — expanding
  // every row to full width upfront, even ones far below the fold, is
  // real browser layout cost independent of Chart.js itself. Both the
  // width expansion AND the actual Chart.js chart are deferred until the
  // row scrolls into view (via IntersectionObserver below). Building
  // every row's chart eagerly on load measured at over a second of
  // blocking main-thread work even on a fast desktop, before accounting
  // for a real phone's slower CPU and Chart.js scaling canvas resolution
  // by devicePixelRatio (typically 2–3 on mobile, multiplying that cost
  // several times over) — exactly the kind of load-time cost this avoids.
  //
  // The SIDEBAR, not the row itself, is what gets observed for
  // visibility — the row's own width is temporarily tiny (see above)
  // until rendered, which would otherwise make its intersection depend on
  // horizontal scroll position too (a row parked at x:[0,40] only
  // "intersects" a root whose visible x-range happens to include that,
  // e.g. scrolled near day 1 — wrong the moment you've scrolled sideways
  // to look at day 4). The sidebar is pinned to the visible left edge via
  // position:sticky regardless of horizontal scroll, so its intersection
  // reflects vertical scroll position only, exactly what "is this
  // location currently being looked at" should mean here.
  const rowBuilds = locationRows.map((entry) => buildLocationRowElement(entry, timelineStart, timelineEnd, totalTrackWidth));
  for (const { row } of rowBuilds) inner.appendChild(row);

  const builtBySidebar = new Map(rowBuilds.map(({ sidebar, chartWrap, renderChart }) => [sidebar, { chartWrap, renderChart, rendered: false }]));

  function renderIfNeeded(sidebar) {
    const built = builtBySidebar.get(sidebar);
    if (!built || built.rendered) return;
    built.rendered = true;
    if (rowVisibilityObserver) rowVisibilityObserver.unobserve(sidebar); // only ever needs to render once
    // Force layout before Chart.js measures this row's canvas — same
    // reasoning as the old all-at-once version (see the removed comment
    // this replaced): a canvas can measure as zero/stale size if Chart.js
    // reads it before the browser has actually settled layout.
    void built.chartWrap.offsetHeight;
    built.renderChart();
  }

  // IntersectionObserver is the primary mechanism — efficient, and it's
  // what all the earlier testing for this feature was verified against.
  // But it turned out not to fire reliably in every real scroll scenario
  // on a real device (confirmed on a Samsung S21 — rows beyond the
  // initially-visible few stayed permanently blank on scroll, not just
  // slow to appear), so a plain 'scroll'-event fallback below acts as a
  // safety net that doesn't depend on IntersectionObserver working at
  // all — whichever one actually fires first renders a row; renderIfNeeded's
  // own `rendered` flag stops the other from doing anything redundant.
  rowVisibilityObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) renderIfNeeded(entry.target);
      }
    },
    { root: scrollWrap, rootMargin: "400px 0px 400px 0px", threshold: 0 }
  );
  for (const { sidebar } of rowBuilds) rowVisibilityObserver.observe(sidebar);

  // Manual fallback: on every scroll (and resize — covers the
  // enter/exit-fullscreen transition, which can resize the board
  // dramatically without necessarily firing a 'scroll' event on its own),
  // check every not-yet-rendered row's actual position against the
  // scroll container's current visible bounds directly, with the same
  // rootMargin-equivalent buffer as the observer above. rAF-throttled so
  // this doesn't run on every single scroll event, just once per frame.
  let fallbackScheduled = false;
  function checkVisibleRowsManually() {
    fallbackScheduled = false;
    const rootRect = scrollWrap.getBoundingClientRect();
    for (const [sidebar, built] of builtBySidebar) {
      if (built.rendered) continue;
      const rect = sidebar.getBoundingClientRect();
      const verticallyVisible = rect.bottom > rootRect.top - 400 && rect.top < rootRect.bottom + 400;
      if (verticallyVisible) renderIfNeeded(sidebar);
    }
  }
  function scheduleFallbackCheck() {
    if (fallbackScheduled) return;
    fallbackScheduled = true;
    requestAnimationFrame(checkVisibleRowsManually);
  }
  rowVisibilityScrollHandler = scheduleFallbackCheck;
  rowVisibilityScrollTarget = scrollWrap;
  scrollWrap.addEventListener("scroll", rowVisibilityScrollHandler, { passive: true });
  window.addEventListener("resize", rowVisibilityScrollHandler);
  checkVisibleRowsManually(); // catch whatever's already visible immediately, don't wait for the first scroll/resize
}


/**
 * Builds one location's row: a sticky-left sidebar (name, type/shore, pin
 * star, and a small chip per qualifying session) plus its always-visible
 * conditions graph. Every session this location has in the displayed
 * period is shaded on the SAME chart via sessionSpan (now an array — see
 * charts.js's buildSessionSpanPlugin), rather than each session getting
 * its own separate tile/chart the way the earlier version of this page did.
 */
function buildLocationRowElement({ loc, locRows, sessions }, timelineStart, timelineEnd, totalTrackWidth) {
  const row = document.createElement("div");
  row.className = "weeknew-row";

  const sidebar = document.createElement("div");
  sidebar.className = "weeknew-row-sidebar";

  const isPinned = pinnedOrder.includes(loc.name);
  const star = document.createElement("button");
  star.type = "button";
  star.className = "weeknew-pin-btn" + (isPinned ? " pinned" : "");
  star.setAttribute("aria-label", isPinned ? `Unpin ${loc.name}` : `Pin ${loc.name} to top`);
  star.textContent = isPinned ? "★" : "☆";
  star.addEventListener("click", () => togglePin(loc.name));

  const titleWrap = document.createElement("div");
  titleWrap.className = "weeknew-row-title";
  titleWrap.innerHTML = `
    <div class="window-loc">${loc.name}</div>
    <div class="window-sub">${loc.type} · shore ${loc.shore || "–"}</div>
  `;

  const titleRow = document.createElement("div");
  titleRow.className = "weeknew-row-title-line";
  titleRow.appendChild(star);
  titleRow.appendChild(titleWrap);
  sidebar.appendChild(titleRow);

  const sessionsWrap = document.createElement("div");
  sessionsWrap.className = "weeknew-row-sessions";
  if (sessions.length === 0) {
    sessionsWrap.innerHTML = `<p class="footnote weeknew-no-session">No qualifying session in this period.</p>`;
  } else {
    for (const s of sessions) {
      const timeLabel = `${fmtNaive(s.from, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })}–${fmtNaive(s.to, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
      const chip = document.createElement("div");
      chip.className = "weeknew-session-chip";
      chip.innerHTML = `
        <div class="weeknew-session-time">${timeLabel} · ${s.hoursLabel}h</div>
        <div class="badge-stack">
          <div class="badge-item">
            <div class="condition-badge" style="background:${conditionColor(s.avgCondition)}">${s.avgCondition != null ? s.avgCondition.toFixed(1) : "–"}</div>
            <div class="badge-label">Location</div>
          </div>
          <div class="badge-item">
            <div class="condition-badge" style="background:${conditionColor(s.avgFishingCondition)}">${s.avgFishingCondition != null ? s.avgFishingCondition.toFixed(1) : "–"}</div>
            <div class="badge-label">Fishing</div>
          </div>
          <div class="badge-item">
            <div class="condition-badge weeknew-range-badge" style="background:#ea580c">${s.tempRange ? `${Math.round(s.tempRange.min)}–${Math.round(s.tempRange.max)}°` : "–"}</div>
            <div class="badge-label">Temp</div>
          </div>
          <div class="badge-item">
            <div class="condition-badge weeknew-range-badge" style="background:#0ea5e9">${s.windRange ? `${Math.round(s.windRange.min)}–${Math.round(s.windRange.max)}` : "–"}</div>
            <div class="badge-label">Wind</div>
          </div>
          <div class="badge-item">
            <div class="condition-badge weeknew-range-badge" style="background:#64748b">${s.maxRain != null ? `${Math.round(s.maxRain)}%` : "–"}</div>
            <div class="badge-label">Rain</div>
          </div>
        </div>
      `;
      sessionsWrap.appendChild(chip);
    }
  }
  sidebar.appendChild(sessionsWrap);
  row.appendChild(sidebar);

  const chartWrap = document.createElement("div");
  chartWrap.className = "weeknew-row-chart";
  // NOT set to the real totalTrackWidth yet — that's often several
  // thousand pixels, and setting it on every row upfront (even ones whose
  // chart is deferred — see renderChart below) forces the browser to lay
  // out that many extremely wide boxes immediately on load, which is real
  // cost independent of Chart.js itself. A small fixed placeholder for
  // now (not a percentage — .weeknew-row sizes itself to its own content
  // via width:max-content, so a percentage width here has nothing stable
  // to resolve against); renderChart expands it to the true width right
  // before building the chart, once this row is actually about to be shown.
  chartWrap.style.width = "40px";
  const canvas = document.createElement("canvas");
  chartWrap.appendChild(canvas);
  row.appendChild(chartWrap);

  const displayRows = locRows.filter((r) => r._t >= timelineStart && r._t <= timelineEnd).sort((a, b) => a._t - b._t);

  // Chart creation is deferred to a returned function, called by
  // renderWeekView only AFTER this row has been appended to the document
  // — see the comment above the two-pass loop in renderWeekView for why.
  const renderChart = () => {
    chartWrap.style.width = totalTrackWidth + "px"; // now expand to the row's real (wide) width, right before Chart.js needs to measure it
    if (displayRows.length === 0) return;
    const rowChart = renderConditionsChart({
      canvas,
      rows: displayRows,
      sunTimes: sunTimesData[loc.name] || [],
      existingChart: null,
      tideMaxObserved: loc.tideMaxObserved,
      minTideHeight: loc.minTideHeight,
      // Same reasoning as the earlier per-tile version: the date/moon are
      // already shown once in the shared header above every row, so
      // repeating them per row (now potentially many days wide) would
      // just be clutter. Same for sunrise/sunset — the header's own
      // markers are the shared reference point; repeating them inside
      // each row's chart just adds noise across a now-multi-day-wide graph.
      moonPhases: null,
      showDayHeading: false,
      showSunTimes: false,
      compact: true,
      sessionSpan: sessions.map((s) => ({ from: s.from, to: s.to })),
      xRange: { min: timelineStart, max: timelineEnd },
      disableBuiltinEvents: true, // this page drives the tooltip itself — see wireHoldToShowTooltip below
      showFirstBoxIcons: true, // windvane/fish legend on each row's own first condition-strip box
    });
    if (rowChart) {
      activeRowCharts.push(rowChart);
      wireHoldToShowTooltip(rowChart, canvas);
    }
  };

  return { row, sidebar, chartWrap, renderChart };
}

/**
 * Replaces Chart.js's default "tap anywhere to show the tooltip" behavior
 * (disabled per-chart via disableBuiltinEvents above) with a hold-to-show
 * gesture, better suited to a board where every row is also a horizontally
 * scrollable, pinch/pan-able surface: a quick tap doesn't show anything
 * until the tooltip has been explicitly turned on. Behavior:
 *   - Hold (press and don't move) for 2 seconds: shows the tooltip at that
 *     point, and "arms" the chart so it stays responsive to quick taps.
 *   - While armed, a quick tap anywhere moves the tooltip to that point —
 *     ordinary tap-to-inspect, same as Chart.js's own default behavior,
 *     just gated behind the initial hold.
 *   - Holding for 2 seconds again disarms it and hides the tooltip,
 *     returning to the initial "tap does nothing" state.
 * A press that moves more than a few pixels before the hold completes is
 * treated as a scroll/pan gesture, not a hold, and cancels the timer —
 * this canvas lives inside a horizontally (and, in fullscreen, vertically)
 * scrollable board, and a hold-timer that fired despite the person
 * actually trying to scroll would be exactly the wrong moment to pop up a
 * tooltip.
 */
function wireHoldToShowTooltip(chart, canvas) {
  const HOLD_MS = 2000;
  const MOVE_CANCEL_PX = 10;
  let pressTimer = null;
  let pressStartX = 0;
  let pressStartY = 0;
  let armed = false;

  function elementsAt(e) {
    const mode = chart.options.interaction ? chart.options.interaction.mode : "index";
    const intersect = chart.options.interaction ? chart.options.interaction.intersect : false;
    return chart.getElementsAtEventForMode(e, mode, { intersect }, true);
  }

  function showTooltipAt(e) {
    const elements = elementsAt(e);
    if (elements.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    chart.tooltip.setActiveElements(elements, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    chart.update();
  }

  function hideTooltip() {
    chart.tooltip.setActiveElements([], { x: 0, y: 0 });
    chart.update();
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
    if (armed) showTooltipAt(e); // ordinary quick tap while armed — move the tooltip, same as Chart.js's own default tap behavior
    // else: not armed yet — a plain quick tap does nothing, exactly the suppression that was asked for.
  });

  canvas.addEventListener("pointercancel", clearPressTimer);
  canvas.addEventListener("pointerleave", clearPressTimer);
}


/**
 * Double-tap (or double-click, for free — the same detector handles
 * mouse pointers too) #weekTimelineScroll — "the frame that contains all
 * the days/locations/graphs" — to toggle real browser fullscreen on it.
 *
 * This exists alongside the CSS rotate-for-landscape trick (week-new.html
 * / style.css), not instead of it: neither the Fullscreen API nor
 * screen.orientation.lock() can fire outside a genuine user gesture —
 * that's exactly why the base landscape behavior had to be a CSS trick
 * rather than a real orientation lock in the first place. A double-tap
 * IS a real user gesture, so both become available at that moment —
 * fullscreen hands the WHOLE physical screen to the board (hiding the
 * browser's own address bar too, something no CSS trick can do), and a
 * successful orientation lock gives a genuine landscape view instead of
 * a simulated one. See the matching #weekTimelineScroll:fullscreen rules
 * in style.css for what happens if the lock isn't available or fails.
 *
 * Double-tap is detected manually (two pointerup events close together in
 * both time and position) rather than relying on the browser's native
 * 'dblclick' event, which fires inconsistently for touch input across
 * browsers. touch-action:manipulation on the target (set below) disables
 * the browser's own native double-tap-to-zoom so it doesn't fire at the
 * same time as — or instead of — this.
 */
function setupFullscreenToggle() {
  const target = document.getElementById("weekTimelineScroll");
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
    // orientation lock (see the CSS fallback rotation in style.css).
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
    // Ignore taps that landed on an actual control (pin buttons, +/−
    // steppers) — someone double-tapping a button wants to activate the
    // button twice, not also toggle fullscreen underneath it.
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
 * Click-and-drag-to-pan for desktop (mouse) — grab the board anywhere
 * (background, a chart, the sidebar) and drag to scroll it, rather than
 * needing a trackpad/scrollbar. Filtered to e.pointerType === "mouse"
 * specifically — touch already has native drag-to-scroll, and re-doing
 * it here too would double up with (and likely fight) that, plus the
 * hold-to-show-tooltip gesture on each chart. A genuine click (not a
 * drag) is left alone — this only ever engages once the pointer has
 * actually moved past a small threshold, so a plain click still reaches
 * whatever it would normally reach (a pin button, the fullscreen
 * double-tap detector, hold-to-show-tooltip's own tap handling).
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
      scrollWrap.classList.add("weeknew-dragging");
    }
    e.preventDefault(); // stop text selection while actively dragging
    scrollWrap.scrollLeft = startScrollLeft - dx;
    scrollWrap.scrollTop = startScrollTop - dy;
  });

  function endDrag() {
    isDown = false;
    draggedPastThreshold = false;
    scrollWrap.classList.remove("weeknew-dragging");
  }
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
}

init();
setupFullscreenToggle();
setupDragToScroll(document.getElementById("weekTimelineScroll"));
