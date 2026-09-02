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
// Trip schedule: tapping a qualifying-session chip arms that row for a
// click-drag-release range selection on its own chart (wireSessionRangeSelect)
// — the drag is interpreted per the Schedule Mode toggle (fishing time, or
// home-to-home) and computed via charts.js's computeScheduleFromDragRangeMs,
// then shown as compact flags on the chart and a chip in the sidebar.
// Computed sessions persist across reloads and accumulate until removed —
// this is what lets Week (sessions) eventually retire in favor of this page.

// Detects "this is a phone-sized device" the same way the CSS
// force-landscape trick in week-new.html does (max-width: 900px) —
// checked against the SHORTER of the two dimensions so it's
// orientation-independent (a phone rotated to landscape is still a phone).
const isMobileDevice = Math.min(window.innerWidth, window.innerHeight) <= 900;

const DATA_URL = "data/conditions.json";
const SETTINGS_URL = "config/settings.json";
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
let selectedGroups = new Set();
let selectedDirections = new Set();
let pinnedOrder = []; // location NAMES, in the order they were pinned — oldest pin first

// Computed (drag-derived) sessions — see charts.js's
// computeScheduleFromDragRangeMs for how one of these gets built, and the
// big comment on wireSessionRangeSelect below for the full click-arm/
// drag-compute flow. Persists across reloads (charts.js's
// loadComputedSessions/persistComputedSessions), unlike everything else
// module-level here which is pure in-memory UI state.
let computedSessions = [];

// "fishing" or "onsite" — see computeScheduleFromDragRangeMs (charts.js)
// for exactly what each means; persists across reloads same as filters.
let scheduleMode = "fishing";

// Which row is currently primed for a click-drag-release range selection —
// null when nothing is armed. Sets/cleared by onSessionTileClick and
// wireSessionRangeSelect below; checked by BOTH the tooltip-hold gesture
// and the drag-to-pan gesture so they can get out of the way while a
// session calculation is actually being dragged out (see the big comment
// on wireSessionRangeSelect for why this can't just be three independent
// gesture handlers on the same canvas).
let armedLocationName = null;

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
  const visibleChartWidth = Math.max(100, scrollWrap.clientWidth - SIDEBAR_WIDTH);
  const target = trackPx - visibleChartWidth / 2;
  scrollWrap.scrollLeft = Math.max(0, Math.min(Math.max(0, totalTrackWidth - visibleChartWidth), target));
}

/**
 * Only ever ONE row armed at a time — arming a new one disarms whichever
 * was previously armed first, same "only one X active at a time" pattern
 * as tooltipsArmed/activeTooltipChart above. Tracks the actual DOM
 * elements (not just the location name) so it can strip the "armed"
 * visual state cleanly regardless of which row/chip they belonged to.
 */
let armedRow = null;
let armedChip = null;
let armedCanvas = null;

function disarmSchedule() {
  if (armedRow) armedRow.classList.remove("armed-for-schedule");
  if (armedChip) armedChip.classList.remove("armed");
  // Restored to "" (the CSS default, effectively "auto") rather than left
  // at "none" — an unarmed row's canvas should scroll normally again,
  // same as it always could before this row was ever armed.
  if (armedCanvas) armedCanvas.style.touchAction = "";
  armedLocationName = null;
  armedRow = null;
  armedChip = null;
  armedCanvas = null;
}

/**
 * Tapping a qualifying-session chip is the "arm" step of the whole
 * click-arm-then-drag flow (see wireSessionRangeSelect just below for the
 * drag half). Scrolls to that session first (friction point 2 from the
 * original design discussion — a scrollLeft change, NOT a per-row chart
 * xRange change, since every row deliberately shares one fixed range —
 * see buildLocationRowElement's own header comment for why that matters),
 * then arms this row so its NEXT drag-release on the chart computes a
 * schedule instead of panning/showing the tooltip.
 *
 * Sets this canvas's touch-action to "none" as part of arming — on a
 * touch device, the browser's native "drag on a scrollable area pans it"
 * behavior is decided from touch-action, not from whether JS later calls
 * preventDefault(), so this has to happen here (synchronously, at arm
 * time) rather than only inside wireSessionRangeSelect's own pointerdown
 * handler, which by itself was consistently losing the very first touch
 * of a drag to the board's native horizontal scroll.
 *
 * getRowChart is a () => chart closure rather than the chart directly,
 * because at the moment this listener is attached, the chart may not
 * exist yet (deferred/lazy row rendering — see renderChart's own
 * comment) — reading it lazily, only once actually needed (drag-release,
 * in wireSessionRangeSelect), always gets whatever the CURRENT chart is.
 */
function onSessionTileClick(loc, session, row, chip, getRowChart, canvas, timelineStart, totalTrackWidth) {
  scrollToCenterSession(session, timelineStart, totalTrackWidth);
  if (armedLocationName === loc.name) {
    // Tapping the already-armed row's own chip again is a cancel, not a
    // re-arm — matches the hold-to-arm tooltip's own "hold again to turn
    // it back off" convention elsewhere on this page.
    disarmSchedule();
    return;
  }
  disarmSchedule();
  armedLocationName = loc.name;
  armedRow = row;
  armedChip = chip;
  armedCanvas = canvas;
  row.classList.add("armed-for-schedule");
  chip.classList.add("armed");
  canvas.style.touchAction = "none";
}

/**
 * The actual click-drag-release gesture, wired to EVERY row's canvas
 * (not just the currently-armed one) — each call only ever acts when
 * armedLocationName matches THIS row's own location, so an unarmed row's
 * canvas behaves completely normally (tooltip-hold, board pan) regardless
 * of some OTHER row being armed elsewhere.
 *
 * Registered before wireSyncedTooltip specifically so it gets first look
 * at every pointer event on this canvas: stopImmediatePropagation() below
 * prevents both wireSyncedTooltip's own listener on this same canvas AND
 * the whole-board drag-to-pan listener (setupDragToScroll, attached to
 * the scrollWrap ancestor) from ever seeing that event once armed. This
 * is the resolution to the very first friction point from the original
 * design discussion — three gestures (hold-to-tooltip, drag-to-pan,
 * drag-to-plan) can't coexist as three independent listeners on the same
 * surface, so arming makes this row's canvas swallow events for its own
 * gesture and nothing else gets a turn until it's disarmed again.
 *
 * stopImmediatePropagation alone isn't enough on a touch device, though:
 * mobile browsers decide whether a touch gesture is a native scroll
 * BEFORE JS's own event handlers necessarily get a meaningful chance to
 * stop it, based on the touched element's CSS touch-action, not on
 * preventDefault() alone. onSessionTileClick sets this canvas's
 * touch-action to "none" the moment it arms (and disarmSchedule restores
 * it), so a touch-drag here never gets interpreted as "scroll the board
 * sideways" in the first place — this is genuinely necessary in addition
 * to, not instead of, the stopImmediatePropagation/preventDefault calls
 * below.
 *
 * dragPreview is a small mutable {hoverXVal, dragStartXVal} object — see
 * buildSessionDragPreviewPlugin (charts.js) for how it's actually drawn.
 * Owned by buildLocationRowElement (one per row, created fresh on every
 * renderWeekView), passed in here so this function can update it live and
 * the plugin can read it live, without either side needing to know about
 * Chart.js internals or re-create anything mid-gesture.
 */
function wireSessionRangeSelect(chart, canvas, loc, dragPreview) {
  let dragStartXVal = null;

  canvas.addEventListener("pointerdown", (e) => {
    if (armedLocationName !== loc.name) return; // not this row's turn — let tooltip-hold/board-pan handle it normally
    e.stopImmediatePropagation();
    e.preventDefault();
    dragStartXVal = xValFromEvent(chart, e);
    dragPreview.dragStartXVal = dragStartXVal;
    dragPreview.hoverXVal = dragStartXVal;
    chart.draw();
  });

  // Fires on every hover, not just while actually dragging (no button
  // pressed yet) — this is the "hovering over the armed graph shows the
  // time under the mouse" half of the gesture, before any press has
  // happened. Once a drag IS in progress (dragStartXVal set), the same
  // updated hoverXVal is also what the plugin uses as the live end of the
  // shaded range.
  canvas.addEventListener("pointermove", (e) => {
    if (armedLocationName !== loc.name) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    dragPreview.hoverXVal = xValFromEvent(chart, e);
    chart.draw();
  });

  canvas.addEventListener("pointerup", (e) => {
    if (armedLocationName !== loc.name || dragStartXVal == null) return;
    e.stopImmediatePropagation();
    const dragEndXVal = xValFromEvent(chart, e);
    const startMs = Math.min(dragStartXVal, dragEndXVal);
    const endMs = Math.max(dragStartXVal, dragEndXVal);
    dragStartXVal = null;
    dragPreview.dragStartXVal = null;
    dragPreview.hoverXVal = null;
    disarmSchedule();
    // A tap with no real drag (start === end, or too close to mean
    // anything) isn't a range — treat it as "changed my mind", not as a
    // zero-length session.
    if (endMs - startMs < 60000) {
      chart.draw(); // clears the now-stale preview shading/label
      return;
    }
    computeAndStoreSession(loc, startMs, endMs);
  });

  canvas.addEventListener("pointercancel", () => {
    dragStartXVal = null;
    dragPreview.dragStartXVal = null;
    dragPreview.hoverXVal = null;
    chart.draw();
  });
}

/**
 * Resolves live drive time (GPS + Google Routes, charts.js), converts the
 * drag range into a full schedule for the CURRENT Schedule Mode toggle
 * state, stores it, and re-renders — a full renderWeekView() rather than
 * a targeted single-row update, same "just rebuild everything" approach
 * togglePin/the filter handlers already use elsewhere on this page.
 *
 * Stores BOTH locationName and locationType — a location can have
 * separate Kayak and Land based entries sharing the same name but
 * different setUp/timeToSpot/packUp/timeFromSpot values, so a schedule
 * computed for one literally isn't correct for the other; scoping by name
 * alone would show the exact same computed markers on both of that
 * location's rows, which is what caused the duplicate-looking overlapping
 * labels on an unrelated row below the one actually being planned.
 */
async function computeAndStoreSession(loc, dragStartMs, dragEndMs) {
  const driveMinutes = await getDriveTimeMinutes(loc.lat, loc.lng);
  const schedule = computeScheduleFromDragRangeMs(scheduleMode, dragStartMs, dragEndMs, loc, driveMinutes);
  const record = {
    id: `${loc.name}|${loc.type}|${dragStartMs}|${Date.now()}`,
    locationName: loc.name,
    locationType: loc.type,
    ...schedule,
  };
  computedSessions.push(record);
  persistComputedSessions(computedSessions);
  renderWeekView();
}

function removeComputedSession(id) {
  computedSessions = computedSessions.filter((r) => r.id !== id);
  persistComputedSessions(computedSessions);
  renderWeekView();
}

/**
 * The Schedule Mode toggle — two mutually-exclusive chips (reusing the
 * existing .loc-chip/.loc-chip.active look, not a new control style),
 * persisted the same way filters are. Rendered once at startup, not on
 * every renderWeekView() — the mode itself doesn't depend on filters/data,
 * just on what the person last chose.
 */
function renderScheduleModeChips() {
  const container = document.getElementById("scheduleModeChips");
  if (!container) return;
  const options = [
    { value: "fishing", label: "Fishing time" },
    { value: "onsite", label: "Home to home" },
  ];
  container.innerHTML = "";
  for (const { value, label } of options) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "loc-chip" + (scheduleMode === value ? " active" : "");
    chip.textContent = label;
    chip.addEventListener("click", () => {
      scheduleMode = value;
      persistScheduleMode(scheduleMode);
      renderScheduleModeChips();
    });
    container.appendChild(chip);
  }
}

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
  // Loaded separately from the main data fetch, with its own error handling
  // — a missing/malformed settings file shouldn't break the rest of the
  // page, just leave the drive-time-dependent half of a computed session
  // gracefully unavailable (see computeScheduleFromDragRangeMs's
  // driveTimeUnavailable handling). Same pattern as week.js's own init().
  try {
    const settingsRes = await fetch(SETTINGS_URL, { cache: "no-store" });
    if (settingsRes.ok) {
      const settings = await settingsRes.json();
      googleRoutesApiKey = settings.googleRoutesApiKey || null;
    }
  } catch (err) {
    console.error("Could not load settings.json:", err);
  }

  computedSessions = loadComputedSessions();
  scheduleMode = loadScheduleMode();
  renderScheduleModeChips();

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
      document.getElementById("updated").textContent = `Updated ${dt.toLocaleString([], { dateStyle: "medium", timeStyle: "short", hour12: false })}`;
    }
    // Awaited — small, fast, local file (not the slow WillyWeather
    // pipeline), so negligible delay; avoids a race where the very first
    // row renders below could happen before tideOffset had been merged in.
    await loadTideOffsets(allLocations);
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

  // Location Group defaults to EMPTY — the opposite of selectedLocations
  // above, and deliberately so: this filter is opt-in OR-style tag
  // matching (see groupsMatchFilter in charts.js) where checking a chip
  // ADDS AN ACCEPTABLE OPTION rather than including a category, so no
  // chips checked correctly means no requirement applied yet (show
  // everything), not "select every group" the way Location/Type default
  // to. Defaulting to all-checked here — the naive parallel to those
  // other two filters — would mean a location needs to carry whichever
  // single group happens to be the only one that exists just to show up
  // on a fresh visit.
  let savedGroups = null;
  try {
    savedGroups = JSON.parse(localStorage.getItem(GROUP_FILTER_STORAGE_KEY) || "null");
  } catch {
    savedGroups = null;
  }
  const allGroups = Array.from(new Set(allLocations.flatMap((l) => locationGroupsOf(l))));
  selectedGroups = new Set(Array.isArray(savedGroups) ? savedGroups.filter((g) => allGroups.includes(g)) : []);

  // Direction defaults to EMPTY for the same reason Location Group does
  // (see groupsMatchFilter/directionsMatchFilter in charts.js) — it's an
  // opt-in OR-style facet, not a select-all-by-default category filter.
  let savedDirections = null;
  try {
    savedDirections = JSON.parse(localStorage.getItem(DIRECTION_FILTER_STORAGE_KEY) || "null");
  } catch {
    savedDirections = null;
  }
  selectedDirections = new Set(Array.isArray(savedDirections) ? savedDirections.filter((d) => CARDINAL_DIRECTIONS.includes(d)) : []);

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

  // Cross-filtering: changing Type narrows which Location Group, Direction,
  // AND Location chips are even offered; changing Group narrows which
  // Direction and Location chips are offered; changing Direction narrows
  // which Group and Location chips are offered — see charts.js's
  // renderGroupChips/renderDirectionChips/renderLocationChips for the full
  // reasoning (same approach here, just via this page's own pin-aware
  // renderLocationChipsWithPins instead of the shared renderLocationChips).
  function refreshGroupChips() {
    renderGroupChips(allLocations, selectedGroups, onGroupFilterChanged, selectedTypes, selectedDirections);
  }
  function refreshDirectionChips() {
    renderDirectionChips(allLocations, selectedDirections, onDirectionFilterChanged, selectedTypes, selectedGroups);
  }
  function onGroupFilterChanged() {
    refreshDirectionChips(); // Group narrows which Direction tiles are offered, in turn
    renderLocationChipsWithPins();
    renderWeekView();
  }
  function onDirectionFilterChanged() {
    refreshGroupChips(); // Direction narrows which Group chips are offered, in turn
    renderLocationChipsWithPins();
    renderWeekView();
  }
  function onTypeFilterChanged() {
    refreshGroupChips();
    refreshDirectionChips();
    renderLocationChipsWithPins();
    renderWeekView();
  }

  renderLocationChipsWithPins();
  renderTypeChips(selectedTypes, onTypeFilterChanged);
  refreshGroupChips();
  refreshDirectionChips();
  document.getElementById("btnLocAll").addEventListener("click", () => {
    // Selects every CURRENTLY OFFERED (narrowed by Type+Group+Direction)
    // location, not literally every location regardless of the active
    // filters — matches what's actually shown as a chip right now.
    selectedLocations = new Set(
      allLocations
        .filter(
          (l) =>
            selectedTypes.has(l.type) &&
            groupsMatchFilter(locationGroupsOf(l), selectedGroups) &&
            directionsMatchFilter(l.shore, selectedDirections)
        )
        .map((l) => l.name)
    );
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
 *
 * Narrowed by the current Type, Location Group, and Direction filters —
 * same "restrict which chips are offered, don't touch what's actually
 * selected" approach as charts.js's own renderLocationChips.
 */
function renderLocationChipsWithPins() {
  const container = document.getElementById("locationChips");
  container.innerHTML = "";
  const seenNames = new Set();
  for (const loc of allLocations) {
    if (!selectedTypes.has(loc.type)) continue;
    if (!groupsMatchFilter(locationGroupsOf(loc), selectedGroups)) continue;
    if (!directionsMatchFilter(loc.shore, selectedDirections)) continue;
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

  const filtered = allLocations.filter(
    (loc) =>
      selectedLocations.has(loc.name) &&
      selectedTypes.has(loc.type) &&
      groupsMatchFilter(locationGroupsOf(loc), selectedGroups) &&
      directionsMatchFilter(loc.shore, selectedDirections)
  );
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
  // Same photo treatment as Week (sessions)' own tiles (see
  // buildTileElement/.week-tile-bg in week.js) — reusing those same two
  // images rather than a separate icon set, so a location reads the same
  // way regardless of which of the two pages you're looking at it from.
  // Lighter wash than that page's own 0.88 (photo shows through more here)
  // per feedback that the first pass looked too washed-out.
  const photoUrl = loc.type === "Kayak" ? "images/type-kayak.jpg" : "images/type-landbased.jpg";
  sidebar.style.backgroundImage = `linear-gradient(rgba(255,255,255,0.65), rgba(255,255,255,0.65)), url(${photoUrl})`;

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
  chartWrap.appendChild(canvas);
  let rowChartRef = null;

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
            <div class="badge-label">Loc</div>
          </div>
          <div class="badge-item">
            <div class="condition-badge" style="background:${conditionColor(s.avgFishingCondition)}">${s.avgFishingCondition != null ? s.avgFishingCondition.toFixed(1) : "–"}</div>
            <div class="badge-label">Fish</div>
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
      chip.addEventListener("click", () => {
        onSessionTileClick(loc, s, row, chip, () => rowChartRef, canvas, timelineStart, totalTrackWidth);
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
    sessionsWrap.appendChild(buildComputedSessionChip(record));
  }

  sidebar.appendChild(sessionsWrap);
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
      wireSessionRangeSelect(rowChart, canvas, loc, dragPreview);
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

/**
 * One sidebar chip for an already-computed (drag-derived) session — full
 * text breakdown of every schedule instant that resolved (see
 * computeScheduleFromDragRangeMs; a null field is simply skipped, not
 * shown as a blank/placeholder), plus a remove button. Deliberately plain
 * text here rather than icons — the icon+time compact treatment lives on
 * the chart itself (buildComputedSessionMarkersPlugin); repeating icons
 * in this already-narrow sidebar column would mean wrapping constantly.
 */
function buildComputedSessionChip(record) {
  const chip = document.createElement("div");
  chip.className = "weeknew-computed-session";
  const fmt = (ms) => fmtNaive(ms, { hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = SCHEDULE_INSTANT_DISPLAY.filter(({ key }) => record[key] != null).map(({ key, label }) => `${label} ${fmt(record[key])}`);
  const modeLabel = record.mode === "fishing" ? "Fishing time" : "Home to home";
  chip.innerHTML = `
    <div class="weeknew-session-time">${modeLabel}</div>
    <div class="weeknew-computed-session-line">${parts.join(" · ")}</div>
    ${record.driveTimeUnavailable ? `<div class="weeknew-computed-session-note">Drive time unavailable — showing what could be calculated without it.</div>` : ""}
    <button type="button" class="weeknew-computed-session-remove" aria-label="Remove this planned session">×</button>
  `;
  chip.querySelector(".weeknew-computed-session-remove").addEventListener("click", (e) => {
    e.stopPropagation();
    removeComputedSession(record.id);
  });
  return chip;
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
setupFullscreenToggle("weekTimelineScroll");
setupDragToScroll(document.getElementById("weekTimelineScroll"));
