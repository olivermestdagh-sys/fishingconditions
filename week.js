// Week Ahead — row-per-location layout. Every location passing the
// Location/Type filters gets its own always-visible conditions graph,
// spanning the SAME fixed [timelineStart, timelineEnd] range as every
// other row (a deliberate choice — a per-row/per-tile range that depends
// on that row's own context is what caused "long sessions stretch the
// layout" and "things don't quite line up" problems in an earlier version
// of this page).
// Any qualifying session(s) for a location are shaded on top of its
// always-visible graph via the shared session-span plugin (charts.js),
// which supports more than one span per chart — a location can have
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
// Trip schedule: the "+ Fishing times" / "+ Home to home" buttons at the
// top of a location's session list arm that row for a click-drag-release
// range selection on its own chart (wireSessionRangeSelect) — which
// button was used decides how the drag is interpreted, computed via
// charts.js's computeScheduleFromDragRangeMs, then shown as compact flags
// on the chart and a chip in the sidebar. Computed sessions persist
// across reloads and accumulate until removed.

// Detects "this is a phone-sized device" the same way the CSS
// force-landscape trick in index.html does (max-width: 900px) —
// checked against the SHORTER of the two dimensions so it's
// orientation-independent (a phone rotated to landscape is still a phone).
const isMobileDevice = Math.min(window.innerWidth, window.innerHeight) <= 900;

const DATA_URL = "data/conditions.json";
const SETTINGS_URL = `${USER_BACKEND_URL}/api/public/settings`;
// Points at the live, unauthenticated user-backend endpoint (D1, Public's
// own row) rather than the static config/settings.json file it used to —
// same migration pattern as MARK_LISTS_FILE_PATH/MARKS_FILE_PATH
// (charts.js): same response shape ({googleRoutesApiKey, homeLat,
// homeLng}), so nothing below this constant needed to change at all.
// Half the usual scale on mobile — 32px/hour was sized for a desktop-width
// screen. At that same scale on a phone's much narrower rotated-landscape
// width, a single day took up nearly the entire visible width on its own,
// leaving almost no surrounding context and forcing far more horizontal
// scrolling per day than made sense for the smaller screen.
let PIXELS_PER_HOUR = isMobileDevice ? 16 : 32; // see applyLandscapeScale for the landscape-phone shrink
// px — the frozen left-hand column showing each row's location name/pin/sessions.
// On phones (up to 700px wide, see "compare board" in style.css) that column is
// gone: each row's name is a pill floating on its graph, so the board has no
// sidebar width to reserve.
const COMPACT_LAYOUT_QUERY = "all"; // the compare board (name pills) now applies at every width, desktop included
function isCompactLayout() {
  return window.matchMedia(COMPACT_LAYOUT_QUERY).matches;
}
function sidebarWidth() {
  return isCompactLayout() ? 0 : 220;
}

// A phone held sideways shows the graphs at 75% of their normal size — both
// row height and hours-per-pixel — so more of the week and more locations fit
// on the short screen. Set from JS (not a media query) so it follows the same
// landscape-phone detection as the rest of the site and re-renders on rotation.
const LANDSCAPE_SCALE = 0.75;
let appliedViewScale = null;
function applyLandscapeScale() {
  const scale = isLandscapePhone() ? LANDSCAPE_SCALE : 1;
  if (scale === appliedViewScale) return false;
  appliedViewScale = scale;
  PIXELS_PER_HOUR = (isMobileDevice ? 16 : 32) * scale;
  const board = document.getElementById("weekTimelineScroll");
  if (board) {
    const baseRowHeight = window.innerWidth <= 700 ? 210 : 328; // the two row heights style.css uses
    if (scale < 1) board.style.setProperty("--weeknew-mobile-row-height", Math.round(baseRowHeight * scale) + "px");
    else board.style.removeProperty("--weeknew-mobile-row-height");
  }
  return true;
}
applyLandscapeScale();
function onViewScaleMaybeChanged() {
  if (applyLandscapeScale() && typeof renderWeekView === "function" && document.getElementById("weekTimelineInner") && allRows.length) {
    renderWeekView();
  }
}
window.addEventListener("resize", onViewScaleMaybeChanged);
window.addEventListener("orientationchange", () => setTimeout(onViewScaleMaybeChanged, 200));

// Crossing the phone/desktop width (rotating a tablet, resizing a window)
// changes the layout, so rebuild the board. renderWeekView is a function
// declaration further down, so it exists by the time this ever fires.
window.matchMedia(COMPACT_LAYOUT_QUERY).addEventListener("change", () => {
  if (typeof renderWeekView === "function" && document.getElementById("weekTimelineInner")) renderWeekView();
});

/** Closes any row's ⓘ details popover (phone layout), optionally keeping one open. */
function closeRowDetails(exceptRow) {
  document.querySelectorAll(".weeknew-row.details-open").forEach((r) => {
    if (r === exceptRow) return;
    r.classList.remove("details-open");
    const b = r.querySelector(".weeknew-row-details-btn");
    if (b) b.setAttribute("aria-expanded", "false");
  });
}
// Tapping anywhere outside an open popover closes it.
document.addEventListener("click", (e) => {
  if (!e.target.closest(".weeknew-row-sidebar")) closeRowDetails();
});

let allRows = [];
let allLocations = [];
let sunTimesData = {};
let moonPhasesData = {};
// facetFilters: {type, group, direction, location}, each {include: Set, exclude: Set} — see
// locationMatchesFacetFilters/emptyFacetFilters/migrateLegacyFacetFilters (js/week-tools.js).
let facetFilters = emptyFacetFilters();
let pinnedOrder = []; // location NAMES, in the order they were pinned — oldest pin first

// computedSessions, armedLocationName and armedMode (the click-arm-then-
// drag-to-compute-a-schedule state) now live in js/week-tools.js, shared
// with the Map tab and Map Live mode — see onArmScheduleClick/
// wireSessionRangeSelect there for the full click-arm/drag-compute flow.

// Chart.js instances currently on screen — one per RENDERED location row
// (not necessarily every row that exists — see rowVisibilityObserver
// below). Torn down and rebuilt every renderWeekView() call. Chart.js
// doesn't garbage-collect an instance just because its canvas left the
// DOM, so these must be destroyed explicitly or every re-render leaks
// whatever was already built.
let activeRowCharts = [];

// Deliberately module-level, not per-row — only ONE row's tooltip is ever
// showing at a time (see showTooltipOn below), and which one that is can
// change without needing to re-hold: a quick tap on a DIFFERENT row, while
// armed, moves it there instead of adding a second one.
let tooltipsArmed = false;
let activeTooltipChart = null;

/**
 * Fully hides a chart's tooltip. No opacity juggling needed —
 * buildTooltipCrosshairPlugin (charts.js) draws the whole tooltip itself,
 * straight from getActiveElements(), so clearing that (and repainting) is
 * all this needs to do.
 */
function clearTooltip(chart) {
  chart.tooltip.setActiveElements([], { x: 0, y: 0 });
  chart.draw();
}

/**
 * Shows the tooltip on exactly one chart — the one just held/tapped —
 * clearing it from every OTHER currently-rendered row first, so switching
 * between graphs never leaves more than one tooltip box on screen at once.
 */
function showTooltipOn(chart, xVal) {
  activeTooltipChart = chart;
  for (const c of activeRowCharts) {
    if (c === chart) continue;
    clearTooltip(c);
  }
  const xScale = chart.scales.x;
  if (!xScale) return;
  // Element lookup done directly from the data (nearestIndexForXVal +
  // elementsAtIndex, in charts.js) rather than via
  // chart.getElementsAtEventForMode with a reconstructed clientX — that
  // reconstruction (rect.left + a logical pixel value) breaks under this
  // page's mobile force-landscape rotation, where the canvas's internal
  // drawing buffer and its rotated VISUAL bounding rect end up with their
  // width/height axes effectively swapped. See xValFromEvent in charts.js
  // for the full explanation (same underlying issue, on the input side).
  const index = nearestIndexForXVal(chart, xVal);
  const elements = elementsAtIndex(chart, index);
  if (elements.length === 0) return;
  const px = xScale.getPixelForValue(xVal);
  const chartArea = chart.chartArea;
  const py = chartArea ? (chartArea.top + chartArea.bottom) / 2 : 0;
  chart.tooltip.setActiveElements(elements, { x: px, y: py });
  chart.draw();
}

function hideAllTooltips() {
  activeTooltipChart = null;
  for (const c of activeRowCharts) {
    clearTooltip(c);
  }
}

/**
 * Same hold-for-2s gesture as charts.js's shared wireHoldToShowTooltip,
 * but able to move the tooltip to a DIFFERENT row's graph on a quick tap
 * without needing to re-hold there first — kept as its own page-local
 * version rather than generalizing the shared one, since "any graph can
 * take over from any other" isn't something Live (a single chart) has any
 * use for. Holding again ANYWHERE while armed disarms it everywhere,
 * regardless of which row currently has it.
 */
function wireSyncedTooltip(chart, canvas) {
  const HOLD_MS = 2000;
  const MOVE_CANCEL_PX = 10;
  let pressTimer = null;
  let pressStartX = 0;
  let pressStartY = 0;

  function xValAt(e) {
    // xValFromEvent (charts.js) — prefers e.offsetX (unaffected by this
    // page's mobile rotation) with a rect-based fallback for browsers
    // where offsetX isn't reliably populated on touch events.
    return xValFromEvent(chart, e);
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
      if (tooltipsArmed) {
        tooltipsArmed = false;
        hideAllTooltips();
      } else {
        tooltipsArmed = true;
        showTooltipOn(chart, xValAt(e));
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
    if (tooltipsArmed) showTooltipOn(chart, xValAt(e)); // quick tap while armed — shows here, moving it off whichever row had it before
  });

  canvas.addEventListener("pointercancel", clearPressTimer);
  canvas.addEventListener("pointerleave", clearPressTimer);
}

/**
 * Scrolls the shared board so a session's midpoint is centered in the
 * visible chart area (clamped at either edge of the whole displayed week
 * — "centered if it can", per the original request; near the very start
 * or end of the week there just isn't a full half-viewport of track on
 * one side to center against, so it scrolls as far as it can and stops).
 * The sidebar's own width doesn't scroll (position:sticky), so it's
 * subtracted from the visible width up front — otherwise "centered" would
 * be centered across the WHOLE viewport including the space the sidebar
 * permanently occupies, not the actual visible chart area.
 */
function scrollToCenterSession(session, timelineStart, totalTrackWidth) {
  const scrollWrap = document.getElementById("weekTimelineScroll");
  if (!scrollWrap) return;
  const midMs = (session.from + session.to) / 2;
  const trackPx = ((midMs - timelineStart) / 3600000) * PIXELS_PER_HOUR;
  const visibleChartWidth = Math.max(100, scrollWrap.clientWidth - sidebarWidth());
  const target = trackPx - visibleChartWidth / 2;
  scrollWrap.scrollLeft = Math.max(0, Math.min(Math.max(0, totalTrackWidth - visibleChartWidth), target));
}

// disarmSchedule, onArmScheduleClick, wireSessionRangeSelect,
// computeAndStoreSession and removeComputedSession all moved to
// js/week-tools.js — shared with the Map tab and Map Live mode. This page's
// own call sites below now pass this page's own scroll-lock element
// (#weekTimelineScroll) and re-render callback (renderWeekView) in, where
// those used to be hardcoded inside those functions.

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
  Prefs.set(PINNED_LOCATIONS_STORAGE_KEY, JSON.stringify(pinnedOrder));
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
  renderWeekView();
}

/**
 * Turns a hidden number input into a stepper: a value display (id+"Badge")
 * showing the current value, with +/− buttons (id+"Up"/id+"Down") either
 * side — purely DOM-id-driven, so it doesn't care what the caller's own
 * markup/classes around those ids look like (showSessionCriteriaModal's
 * .live-card-stepper-value, styled like the Map/Live tab's own numeric
 * steppers). For Min Condition, the value display is colored via
 * conditionColor() — the exact same function that colors the Location/
 * Fishing rating circles on session rows — so a "3.0" here looks like a
 * "3.0" would anywhere else on the page. Min consecutive hours isn't a 1-5
 * condition rating, so colorFn is null there — no background color applied.
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
  // A signed-in user's saved filters, favourites and plans (js/prefs.js) are pulled into localStorage first, so everything
  // below reads them as usual; signed out or offline this returns straight away and the device's own values are used.
  await Prefs.load();

  // Loaded separately from the main data fetch, with its own error handling
  // — a missing/malformed settings file shouldn't break the rest of the
  // page, just leave the drive-time-dependent half of a computed session
  // gracefully unavailable (see computeScheduleFromDragRangeMs's
  // driveTimeUnavailable handling). Same pattern as week.js's own init().
  try {
    const settingsRes = await fetch(SETTINGS_URL, { cache: "no-store", credentials: "include" });
    if (settingsRes.ok) {
      const settings = await settingsRes.json();
      googleRoutesApiKey = settings.googleRoutesApiKey || null;
    }
  } catch (err) {
    console.error("Could not load settings:", err);
  }

  computedSessions = loadComputedSessions();

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
      setUpdatedStamp(document.getElementById("updated"), dt);
    }
    // Awaited — small, fast, local file (not the slow WillyWeather
    // pipeline), so negligible delay; avoids a race where the very first
    // row renders below could happen before tideOffset had been merged in.
    await loadTideOffsets(allLocations);
    // Only Public's and the signed-in person's own locations (locationVisibleToViewer, js/backend.js).
    await refreshAdminStatus();
    await loadMyHomes(); // for the From select (GPS or a home) and trip drive times
    ensureHomeNames(refreshTripOriginSelects); // label homes by their town, if any still has no name
    allLocations = allLocations.filter(locationVisibleToViewer);
    await applyMyLocationTimings(allLocations); // a signed-in person's own times on others' locations
  } catch (err) {
    document.getElementById("updated").textContent = "Could not load data — has the site run its first update yet?";
    console.error(err);
    return;
  }

  // Facet filters (Type/Location Group/Shore Direction/Locations) persist across visits, migrated
  // from whatever's saved under their old plain-array shape (see migrateLegacyFacetFilters's own
  // comment) — same localStorage keys as before, shared with the original Week Ahead page on
  // purpose, since they're the same underlying settings, not a separate copy for this page.
  const allNames = allLocations.map((l) => l.name);
  facetFilters = migrateLegacyFacetFilters(allNames);
  persistFacetFilters(facetFilters); // writes the migrated shape straight back, so a second load doesn't re-migrate

  // Drop any pinned name that no longer exists in the data (a location was
  // renamed/removed in Settings since the last visit) — same defensive
  // pattern as the saved-locations filter above.
  pinnedOrder = loadPinnedOrder().filter((n) => allNames.includes(n));

  initFilterControls();
  renderWeekView();
}

/**
 * One facet's own full-screen selection panel (Location Group, Shore
 * Direction or Locations — each has its own toolbar button now, Type
 * already has its own 3-state toggle button, Min Condition/Min Hours their
 * own popover) — same big-pill-button visual language as the Map/Live tab's
 * "Session defaults" flow (.live-card-* CSS, js/live-cards.js's
 * showCardFlow/showEndSessionConfirm), reused here for a single-screen
 * panel rather than that flow's multi-step Prev/Next wizard: this facet is
 * ALREADY the one screen, there's nothing to page through.
 *
 * `ctx.onChange` is called after every mutating action (a card tap, Clear,
 * a pin toggle) so the caller can persist + re-render whatever it needs to
 * (this facet's own badge count and the week view itself) — this function
 * only ever mutates ctx.facetFilters/pinnedOrder live and re-renders its
 * own body, it never needs to know what else depends on that state.
 *
 * The "location" facet doubles as the pin-to-top picker (★/☆, this page's
 * own togglePin/pinnedOrder) and gets an extra All/None row — the only
 * facet with anything beyond a plain 3-state card grid, since pinning which
 * locations lead the board is otherwise homeless once this row is no
 * longer always visible on the page itself.
 *
 * Page-local (not js/week-tools.js) specifically because it references
 * pinnedOrder/togglePin, both week.js-only — everything ELSE it calls
 * (facetCandidates, facetChipStateFor, FACET_LABELS, displayNameFor,
 * escapeHtml) lives in the shared js/week-tools.js or js/backend.js and is
 * generic.
 */
function showFacetCardPanel(facet, ctx) {
  const { allLocations, facetFilters, onChange } = ctx;
  const isLocation = facet === "location";
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "live-card-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    document.body.appendChild(overlay);
    document.body.classList.add("live-card-open");

    const close = () => {
      overlay.remove();
      document.body.classList.remove("live-card-open");
      resolve();
    };

    function candidateValues() {
      return facetCandidates(facet, allLocations, facetFilters);
    }

    function choiceHtml(value) {
      const cs = facetChipStateFor(facetFilters, facet, value);
      const stateClass = cs === "include" ? " selected" : cs === "exclude" ? " excluded" : "";
      const loc = isLocation ? allLocations.find((l) => l.name === value) : null;
      const label = isLocation ? displayNameFor(loc) || value : value;
      const escLabel = escapeHtml(label);
      const choiceBtn = `<button type="button" class="live-card-choice${stateClass}" data-choice="${escapeHtml(value)}" aria-pressed="${cs === "include"}"><span>${escLabel}</span></button>`;
      if (!isLocation) return choiceBtn;
      const pinned = pinnedOrder.includes(value);
      return `<div class="live-card-choice-wrap">
        ${choiceBtn}
        <button type="button" class="live-card-pin-btn${pinned ? " pinned" : ""}" data-pin-location="${escapeHtml(value)}"
          aria-label="${pinned ? "Unpin" : "Pin"} ${escLabel}">${pinned ? "★" : "☆"}</button>
      </div>`;
    }

    function render() {
      const values = candidateValues();
      overlay.innerHTML = `
        <div class="live-card">
          <div class="live-card-head">
            <h2 class="live-card-title">${escapeHtml(FACET_LABELS[facet])}</h2>
            <p class="live-card-prompt">Tap once to require it, tap again to exclude it, tap again to clear.</p>
            ${isLocation ? `<div class="live-card-nav live-card-nav-2" style="margin-top:8px;">
              <button type="button" class="live-card-nav-btn" data-loc-all>All</button>
              <button type="button" class="live-card-nav-btn" data-loc-none>None</button>
            </div>` : ""}
          </div>
          <div class="live-card-grid">
            ${values.length ? values.map(choiceHtml).join("") : `<p class="live-card-empty">Nothing to choose yet — add options for this on the Settings tab.</p>`}
          </div>
          <div class="live-card-nav live-card-nav-2">
            <button type="button" class="live-card-nav-btn live-card-close" data-nav="clear">Clear</button>
            <button type="button" class="live-card-nav-btn live-card-next" data-nav="done">Done</button>
          </div>
        </div>`;
      overlay.querySelectorAll("[data-choice]").forEach((btn) => {
        btn.addEventListener("click", () => cycleFacetChip(btn.dataset.choice));
      });
      if (isLocation) {
        overlay.querySelectorAll("[data-pin-location]").forEach((btn) => {
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            togglePin(btn.dataset.pinLocation);
            render();
          });
        });
        overlay.querySelector("[data-loc-all]").addEventListener("click", () => {
          facetFilters.location = { include: new Set(), exclude: new Set() };
          onChange();
          render();
        });
        overlay.querySelector("[data-loc-none]").addEventListener("click", () => {
          facetFilters.location = { include: new Set(), exclude: new Set(candidateValues()) };
          onChange();
          render();
        });
      }
      overlay.querySelector('[data-nav="clear"]').addEventListener("click", () => {
        facetFilters[facet] = { include: new Set(), exclude: new Set() };
        onChange();
        render();
      });
      overlay.querySelector('[data-nav="done"]').addEventListener("click", close);
    }

    function cycleFacetChip(value) {
      const f = facetFilters[facet];
      const current = facetChipStateFor(facetFilters, facet, value);
      if (current === "neutral") {
        f.include.add(value);
      } else if (current === "include") {
        f.include.delete(value);
        f.exclude.add(value);
      } else {
        f.exclude.delete(value);
      }
      onChange();
      render();
    }

    render();
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
  });
}

/**
 * "Session Criteria" panel (Min Condition rating, Min consecutive hours — together they define
 * what counts as a qualifying session, hence the name; "Thresholds" was the old, less clear
 * label) — split out of showThresholdFilterModal (now showFacetCardPanel's three buttons) into
 * its own toolbar button so the two values people adjust most often don't need a bigger modal
 * open. Same .live-card-* visual language as showFacetCardPanel and the Map/Live tab's own
 * Session defaults cards — the two steppers are modeled directly on js/live-cards.js's Water
 * depth card (renderWaterDepth), the existing precedent for a numeric stepper in this shell.
 *
 * wireThresholdStepper (week.js) and persistThresholds/THRESHOLDS_STORAGE_KEY (js/week-tools.js)
 * are unchanged — they only look up elements by id (minCondition/minConditionBadge/.../minHours*),
 * so restyling the markup around those same ids needed no changes to that logic at all.
 */
function showSessionCriteriaModal() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "live-card-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = `
      <div class="live-card">
        <div class="live-card-head">
          <h2 class="live-card-title">Session Criteria</h2>
          <p class="live-card-prompt">Every hourly forecast row that sits inside a run of consecutive hours meeting both minimums below counts as a qualifying session (evaluated per location).</p>
        </div>
        <div class="live-card-grid">
          <div class="live-card-stepper">
            <div class="live-card-digit-caption">Min Condition rating</div>
            <div class="live-card-stepper-row">
              <button type="button" class="live-card-choice live-card-step-btn" id="minConditionDown" aria-label="Decrease min condition rating">&minus;</button>
              <div class="live-card-stepper-value" id="minConditionBadge">3.0</div>
              <button type="button" class="live-card-choice live-card-step-btn" id="minConditionUp" aria-label="Increase min condition rating">+</button>
            </div>
            <input type="hidden" id="minCondition" min="1" max="5" value="3" />
          </div>
          <div class="live-card-stepper">
            <div class="live-card-digit-caption">Min consecutive hours</div>
            <div class="live-card-stepper-row">
              <button type="button" class="live-card-choice live-card-step-btn" id="minHoursDown" aria-label="Decrease min consecutive hours">&minus;</button>
              <div class="live-card-stepper-value" id="minHoursBadge">3.0</div>
              <button type="button" class="live-card-choice live-card-step-btn" id="minHoursUp" aria-label="Increase min consecutive hours">+</button>
            </div>
            <input type="hidden" id="minHours" min="1" max="24" value="3" />
          </div>
        </div>
        <p class="live-card-prompt" style="font-size:0.8rem;opacity:0.75;">"Min consecutive hours" is a genuine clock-duration minimum — matches the session lengths shown.</p>
        <div class="live-card-nav live-card-nav-1">
          <button type="button" class="live-card-nav-btn live-card-next" data-nav="done">Done</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.body.classList.add("live-card-open");

    // Restore the currently-saved thresholds onto this fresh copy of the inputs before wiring the steppers,
    // so the badges/buttons reflect reality immediately rather than the placeholder defaults above.
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
    wireThresholdStepper("minCondition", 0.1, 1, 5, conditionColor);
    wireThresholdStepper("minHours", 1, 1, 24, null);

    const cleanup = () => {
      overlay.remove();
      document.body.classList.remove("live-card-open");
      resolve();
    };
    overlay.querySelector('[data-nav="done"]').addEventListener("click", cleanup);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup();
    });
  });
}

/**
 * The Type toolbar button's icon — a small self-contained SVG mirroring typeIconSvg
 * (js/chart-base.js), using the SAME kayak/footprints glyphs and colors as the Map's own
 * location pins. "All" (no filter) has no map-pin equivalent, so it shows both glyphs
 * side-by-side in a neutral grey, matching the layout of the map's "both" pin icon but
 * purely as a placeholder graphic — there's no functional "both" filter state.
 */
function typeFilterButtonIconSvg(typeState) {
  if (typeState === "Kayak" || typeState === "Land based") return typeIconSvg(typeState, 16);
  const grey = "#94a3b8";
  return `<svg width="32" height="16" viewBox="0 0 48 24" fill="none" stroke="${grey}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <g>${KAYAK_ICON_PATHS.map((d) => `<path d="${d}"/>`).join("")}</g>
    <g transform="translate(24,0)">${FOOTPRINTS_ICON_PATHS.map((d) => `<path d="${d}"/>`).join("")}</g>
  </svg>`;
}

const TYPE_FILTER_STATES = [null, "Kayak", "Land based"];

function currentTypeFilterState() {
  const include = facetFilters.type.include;
  if (include.has("Kayak")) return "Kayak";
  if (include.has("Land based")) return "Land based";
  return null;
}

function setTypeFilterState(state) {
  facetFilters.type = state ? { include: new Set([state]), exclude: new Set() } : { include: new Set(), exclude: new Set() };
}

function renderTypeFilterButton() {
  const btn = document.getElementById("filtersTypeBtn");
  const state = currentTypeFilterState();
  const label = state || "All";
  btn.innerHTML = typeFilterButtonIconSvg(state);
  btn.title = `Type: ${label}`;
  btn.setAttribute("aria-label", `Type filter: ${label}. Tap to change.`);
}

// One badge count per facet, now that Group/Direction/Locations each have their own toolbar
// button (filtersCount(facetFilters.group) etc.) instead of one shared gear badge.
function facetCount(f) {
  return f.include.size + f.exclude.size;
}

function initFilterControls() {
  const typeBtn = document.getElementById("filtersTypeBtn");
  const sessionCriteriaBtn = document.getElementById("filtersThresholdsBtn");
  const facetButtons = {
    group: { btn: document.getElementById("filtersGroupBtn"), badge: document.getElementById("filtersGroupBadge") },
    direction: { btn: document.getElementById("filtersDirectionBtn"), badge: document.getElementById("filtersDirectionBadge") },
    location: { btn: document.getElementById("filtersLocationsBtn"), badge: document.getElementById("filtersLocationsBadge") },
  };

  function refresh() {
    renderTypeFilterButton();
    for (const facet of Object.keys(facetButtons)) {
      const count = facetCount(facetFilters[facet]);
      facetButtons[facet].badge.textContent = count > 0 ? `(${count})` : "";
    }
    persistFacetFilters(facetFilters);
    renderWeekView();
  }

  for (const [facet, { btn }] of Object.entries(facetButtons)) {
    btn.addEventListener("click", async () => {
      await showFacetCardPanel(facet, { allLocations, facetFilters, onChange: refresh });
      refresh();
    });
  }
  sessionCriteriaBtn.addEventListener("click", async () => {
    await showSessionCriteriaModal();
  });
  typeBtn.addEventListener("click", () => {
    const current = currentTypeFilterState();
    const next = TYPE_FILTER_STATES[(TYPE_FILTER_STATES.indexOf(current) + 1) % TYPE_FILTER_STATES.length];
    setTypeFilterState(next);
    refresh();
  });

  refresh();
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
  // Thresholds are read from storage (via computeQualifyingSessions's own null-means-"read the
  // saved values" fallback), not from #minCondition/#minHours directly — those inputs only exist
  // while the Session Criteria panel happens to be open, so a DOM read here would break the
  // moment it's closed.
  const filtered = allLocations.filter((loc) => locationMatchesFacetFilters(loc, facetFilters));
  const ordered = sortLocationsForDisplay(filtered);

  return ordered.map((loc) => {
    const locRows = allRows.filter((r) => r["Location Name"] === loc.name && r["Type"] === loc.type);
    const sessions = computeQualifyingSessions(locRows, null, null);
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
  inner.style.width = sidebarWidth() + totalTrackWidth + "px";

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
    <div class="graph-gesture-hint" aria-hidden="true">
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
  // The pills stick just below the sticky day header while their row is on screen.
  scrollWrap.style.setProperty("--weeknew-header-h", headerRow.offsetHeight + "px");

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
 * star, a small chip per qualifying session, and any computed/planned
 * sessions for this location) plus its always-visible conditions graph.
 * Every session this location has in the displayed period is shaded on
 * the SAME chart via sessionSpan (now an array — see charts.js's
 * buildSessionSpanPlugin), rather than each session getting its own
 * separate tile/chart the way the earlier version of this page did.
 *
 * Tapping a qualifying-session chip arms THIS row for a click-drag-release
 * schedule calculation (see wireSessionRangeSelect below) — the resulting
 * computed session is stored (charts.js's persistComputedSessions) and
 * shown both as compact flags on this row's own chart
 * (buildComputedSessionMarkersPlugin) and as its own chip here in the
 * sidebar, so several planned options for the same or different locations
 * can sit side by side for comparison.
 */
function buildLocationRowElement({ loc, locRows, sessions }, timelineStart, timelineEnd, totalTrackWidth) {
  const row = document.createElement("div");
  row.className = "weeknew-row";

  const sidebar = document.createElement("div");
  sidebar.className = "weeknew-row-sidebar";
  // Per-location Kayak/Land based photo, reused from the two shared
  // images rather than a separate icon set. Lighter wash (0.65) than a
  // full-opacity overlay so the photo still shows through, per feedback
  // that a heavier wash looked too washed-out.
  const photoUrl = loc.type === "Kayak" ? "images/type-kayak.jpg" : "images/type-landbased.jpg";
  sidebar.style.backgroundImage = `linear-gradient(rgba(255,255,255,0.65), rgba(255,255,255,0.65)), url(${photoUrl})`;
  // Phone layout: the sidebar photo is switched off, but the expanded ⓘ tile
  // (sessions and planning buttons) uses the same photo as its background.
  row.style.setProperty("--tile-photo", `url(${photoUrl})`);

  const isPinned = pinnedOrder.includes(loc.name);
  const star = document.createElement("button");
  star.type = "button";
  star.className = "weeknew-pin-btn" + (isPinned ? " pinned" : "");
  star.setAttribute("aria-label", isPinned ? `Unpin ${displayNameFor(loc)}` : `Pin ${displayNameFor(loc)} to top`);
  star.textContent = isPinned ? "★" : "☆";
  star.addEventListener("click", () => togglePin(loc.name));

  const titleWrap = document.createElement("div");
  titleWrap.className = "weeknew-row-title";
  titleWrap.innerHTML = `
    <div class="window-loc">${escapeHtml(displayNameFor(loc))}</div>
    <div class="window-sub">${loc.type} · shore ${loc.shore || "–"}</div>
  `;

  const titleRow = document.createElement("div");
  titleRow.className = "weeknew-row-title-line";
  titleRow.appendChild(star);
  titleRow.appendChild(titleWrap);
  // Phone layout only (hidden by CSS otherwise): the ⓘ button on the name pill
  // opens this row's session chips and planning buttons in a popover.
  const detailsBtn = document.createElement("button");
  detailsBtn.type = "button";
  detailsBtn.className = "weeknew-row-details-btn";
  detailsBtn.textContent = "ⓘ";
  detailsBtn.setAttribute("aria-label", `Sessions and planning for ${displayNameFor(loc)}`);
  detailsBtn.setAttribute("aria-expanded", "false");
  detailsBtn.addEventListener("click", () => {
    const opening = !row.classList.contains("details-open");
    closeRowDetails(opening ? row : null);
    row.classList.toggle("details-open", opening);
    detailsBtn.setAttribute("aria-expanded", String(opening));
  });
  titleRow.appendChild(detailsBtn);
  // The pill (and its ⓘ popover) ride in a zero-width sticky wrapper so they stay pinned
  // under the day header while the row is scrolled past, then leave with the row.
  const stickyWrap = document.createElement("div");
  stickyWrap.className = "weeknew-row-sticky";
  stickyWrap.appendChild(titleRow);
  sidebar.appendChild(stickyWrap);

  // Declared here (not down where they used to sit, right before being
  // appended) so the session-chip click handlers just below — created
  // before the chart itself exists yet, since chart creation is deferred
  // (see renderChart further down) — can still close over the eventual
  // canvas/chart via these same variables. A closure captures the
  // VARIABLE, not its value at closure-creation time, so this is safe
  // even though rowChartRef is still null when the click handlers below
  // are wired up.
  const chartWrap = document.createElement("div");
  chartWrap.className = "weeknew-row-chart";
  chartWrap.style.width = "40px"; // placeholder — see the renderChart comment further down for why
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `Chart of tide, wind, pressure and fishing condition ratings for ${displayNameFor(loc)} (${loc.type})`);
  chartWrap.appendChild(canvas);
  let rowChartRef = null;

  const sessionsWrap = document.createElement("div");
  sessionsWrap.className = "weeknew-row-sessions";

  // "+ Fishing times" / "+ Home to home" — the arm step of the
  // click-arm-then-drag flow (see onArmScheduleClick/wireSessionRangeSelect),
  // one button per Schedule Mode (see computeScheduleFromDragRangeMs,
  // charts.js, for what each actually means). Always first in the list,
  // regardless of how many qualifying/computed sessions this location
  // has (including zero) — arming isn't tied to any particular session,
  // so neither button needs one to exist first. No longer a separate
  // persisted "mode" setting (that used to live in the Thresholds &
  // filters panel) — picking a button IS picking the mode, fresh each
  // time, since which one makes sense can genuinely differ per session.
  const addBtnsRow = document.createElement("div");
  addBtnsRow.className = "weeknew-add-buttons-row";
  addBtnsRow.appendChild(buildTripOriginSelect());
  for (const { mode, label } of [
    { mode: "fishing", label: "+ Fishing times" },
    { mode: "onsite", label: "+ Home to home" },
  ]) {
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "weeknew-add-fishing-times";
    addBtn.textContent = label;
    addBtn.addEventListener("click", () => {
      onArmScheduleClick(loc, row, addBtn, mode, () => rowChartRef, canvas, document.getElementById("weekTimelineScroll"));
      closeRowDetails(); // phone layout: get the popover out of the way so the graph can be dragged
    });
    addBtnsRow.appendChild(addBtn);
  }
  sessionsWrap.appendChild(addBtnsRow);

  if (sessions.length === 0) {
    sessionsWrap.insertAdjacentHTML("beforeend", `<p class="footnote weeknew-no-session">No qualifying session in this period.</p>`);
  } else {
    for (const s of sessions) {
      const chip = buildSessionChipElement(s);
      // Just scrolls the board to center this session now — arming moved
      // to the dedicated "+ Fishing times" button above, so tapping a
      // qualifying-session chip is purely navigational.
      chip.addEventListener("click", () => {
        scrollToCenterSession(s, timelineStart, totalTrackWidth);
        closeRowDetails(); // phone layout: close the popover to show the session on the graph
      });
      sessionsWrap.appendChild(chip);
    }
  }

  // Computed (planned) sessions for THIS location — a separate visual
  // family from the qualifying-session chips above (see the
  // .weeknew-computed-session CSS comment for why), each with its own
  // remove button since these accumulate over time and aren't
  // auto-recomputed from the conditions data the way qualifying sessions
  // are. Scoped by locationType as well as locationName — a location can
  // have separate Kayak/Land based entries sharing the same name but
  // different setUp/timeToSpot/packUp/timeFromSpot, so a session computed
  // for one type genuinely doesn't apply to the other's row.
  const thisLocComputed = computedSessions.filter((r) => r.locationName === loc.name && r.locationType === loc.type);
  for (const record of thisLocComputed) {
    sessionsWrap.appendChild(buildComputedSessionChip(record, renderWeekView));
  }

  stickyWrap.appendChild(sessionsWrap);
  row.appendChild(sidebar);
  row.appendChild(chartWrap);

  const displayRows = locRows.filter((r) => r._t >= timelineStart && r._t <= timelineEnd).sort((a, b) => a._t - b._t);

  // Mutable, read live by buildSessionDragPreviewPlugin on every redraw —
  // see wireSessionRangeSelect for how this gets updated as the person
  // hovers/drags on this row's own canvas.
  const dragPreview = { hoverXVal: null, dragStartXVal: null };

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
      computedSessionMarkers: thisLocComputed,
      dragPreviewState: () => dragPreview,
      xRange: { min: timelineStart, max: timelineEnd },
      disableBuiltinEvents: true, // this page drives the tooltip itself — see wireSyncedTooltip below
      showFirstBoxIcons: true, // windvane/fish legend on each row's own first condition-strip box
      tideOffsetMinutes: loc.tideOffset,
    });
    rowChartRef = rowChart;
    if (rowChart) {
      activeRowCharts.push(rowChart);
      // Registered BEFORE wireSyncedTooltip specifically — both listen on
      // the same canvas, and wireSessionRangeSelect needs first refusal
      // (via stopImmediatePropagation) on any pointer event while this
      // row is armed, so the tooltip-hold gesture and the whole-board
      // drag-to-pan gesture never also see that same press. See its own
      // comment for the full reasoning.
      wireSessionRangeSelect(() => rowChartRef, canvas, () => loc, dragPreview, renderWeekView);
      wireSyncedTooltip(rowChart, canvas);
      // Deliberately no "already armed elsewhere, so show here too" logic
      // — only one row's tooltip is ever showing at a time (see
      // showTooltipOn), and a row that's only just scrolled into view
      // wasn't the one actually tapped/held, so it stays blank until it is.
    }
    // A full renderWeekView() rebuilds every row from scratch (including
    // this one), so if THIS location was the one armed before the rebuild
    // (e.g. a filter changed while a row was still armed, before any
    // drag happened), the freshly-created row/canvas need the "armed"
    // state — and its touch-action override — re-applied to the NEW
    // elements; armedRow/armedCanvas are updated to point at them too, so
    // a later disarmSchedule() acts on what's actually on screen rather
    // than on nodes this rebuild just destroyed.
    if (armedLocationName === loc.name) {
      row.classList.add("armed-for-schedule");
      canvas.style.touchAction = "none";
      armedRow = row;
      armedCanvas = canvas;
    }
  };

  return { row, sidebar, chartWrap, renderChart };
}

// buildTripOriginSelect, fillTripOriginSelect, refreshTripOriginSelects and
// buildComputedSessionChip all moved to js/week-tools.js — shared with the
// Map tab and Map Live mode. buildComputedSessionChip now takes an
// onChanged callback (this page passes renderWeekView) instead of always
// re-rendering the Week Ahead board directly.


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
setupFullscreenToggle("weekTimelineScroll");
setupDragToScroll(document.getElementById("weekTimelineScroll"));
