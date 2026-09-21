// marks-tools.js
// Fishing marks, part 3: colour-by and filters, box/click selection, bulk edit and delete, and the map click flow that starts a new mark.
// One of the shared scripts split out of the old charts.js. All of them share one global scope; each page loads
// only the ones it needs, in this order (checked by scripts/check-page-scripts.mjs).

// --- Mark display filtering & colour-by-field grouping ---------------------
//
// Two independent, persisted view preferences layered on top of the marks
// layer itself: which field currently determines colour (state.groupByKey
// below) and which values are included/excluded from display at all
// (state.filters below). Both persist to localStorage (see
// loadMarkViewSettings/saveMarkViewSettings below), shared across the
// Location and Live tabs.
// loadAndRenderMarks already threads everywhere marks are touched, and both
// persist to localStorage (see loadMarkViewSettings/saveMarkViewSettings)
// SHARED across the Location and Live tabs — one filter setup follows you
// between them, the same way the GitHub connection itself already does,
// rather than needing to be set up twice.

const MARK_VIEW_STORAGE_KEY = "markViewSettings";

/**
 * Reads {groupByKey, filters} from localStorage — filters as
 * {[fieldKey]: {include: Set<string>, exclude: Set<string>}}, rebuilt from
 * the plain arrays JSON actually stores (see saveMarkViewSettings). Never
 * throws; a missing/corrupt entry just means "start from defaults"
 * (Species, no filters), same as any other first-time-use case on this site.
 */
function loadMarkViewSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(MARK_VIEW_STORAGE_KEY) || "null");
    if (!raw) return { groupByKey: "species", filters: {} };
    const filters = {};
    for (const [key, f] of Object.entries(raw.filters || {})) {
      if (key === "dateTime") {
        filters[key] = { from: f.from || "", to: f.to || "" }; // the Date/Time filter is a range, not include/exclude sets
        continue;
      }
      filters[key] = { include: new Set(f.include || []), exclude: new Set(f.exclude || []) };
    }
    return { groupByKey: raw.groupByKey || "species", filters };
  } catch {
    return { groupByKey: "species", filters: {} };
  }
}

/** Mirror of loadMarkViewSettings — Sets serialized back to plain arrays for
 * JSON.stringify, which doesn't know how to handle a Set on its own. */
function saveMarkViewSettings(state) {
  try {
    const filters = {};
    for (const [key, f] of Object.entries(state.filters)) {
      if (key === "dateTime") {
        filters[key] = { from: f.from || "", to: f.to || "" };
        continue;
      }
      filters[key] = { include: [...(f.include || [])], exclude: [...(f.exclude || [])] };
    }
    Prefs.set(MARK_VIEW_STORAGE_KEY, JSON.stringify({ groupByKey: state.groupByKey, filters }));
  } catch {
    // Same reasoning as saveLastMarkFieldValues' own try/catch above — a
    // localStorage failure here just means this session's filter tweak
    // won't be remembered next time, not worth surfacing as an error.
  }
}

/**
 * Whether one mark should be shown at all, given the current filters —
 * AND across every field that has an active filter, OR within one field's
 * include set (matching ANY of the picked values passes), and the mirror
 * OR within its exclude set (matching ANY of THOSE hides it). A field with
 * no active include/exclude entries is ignored entirely — every mark passes
 * it by default. A mark with no value at all for a field that has an
 * active INCLUDE filter fails that field (nothing to match); a mark with no
 * value for a field with only an EXCLUDE filter passes it trivially
 * (nothing there to be excluded).
 */
function markMatchesFilters(mark, filters) {
  for (const [key, f] of Object.entries(filters)) {
    if (!f) continue;
    if (key === "dateTime") {
      // Date/Time range: {from, to} as datetime-local strings ("YYYY-MM-DDTHH:MM"), either may be blank.
      // Marks store naive "YYYY-MM-DD HH:MM:SS", so plain string comparison orders correctly; "to" is
      // compared at its own precision, so it includes the whole minute it names. A mark with no date
      // fails an active range (nothing to compare).
      if (!f.from && !f.to) continue;
      const dt = String(mark.dateTime || "");
      if (!dt) return false;
      const from = String(f.from || "").replace("T", " ");
      const to = String(f.to || "").replace("T", " ");
      if (from && dt < from) return false;
      if (to && dt.slice(0, to.length) > to) return false;
      continue;
    }
    const value = mark[key];
    if (f.include && f.include.size > 0) {
      if (!value || !f.include.has(value)) return false;
    }
    if (f.exclude && f.exclude.size > 0) {
      if (value && f.exclude.has(value)) return false;
    }
  }
  return true;
}

/**
 * The marks currently visible on the map: every mark in state.marksById that
 * passes state.filters (the same test applyMarkFiltersAndGrouping uses to
 * show/hide markers, so an export and the map always agree).
 */
function getVisibleMarks(state) {
  const visible = [];
  state.marksById.forEach((mark) => {
    if (markMatchesFilters(mark, state.filters)) visible.push(mark);
  });
  return visible;
}

/**
 * Re-applies state.filters and state.groupByKey to every mark currently
 * known about (state.marksById/markersById) — shows/hides each marker on
 * `map` to match the filter, and restyles/re-tooltips whatever's left
 * visible to match the current colour-by field. Called once after the
 * initial load (to respect filters restored from a previous visit) and
 * again every time the group-by select changes, a filter is set/cleared in
 * the modal, or an active-filter chip is removed directly.
 */
function applyMarkFiltersAndGrouping(map, state) {
  const layer = state.markerLayer || map; // markerLayer should always be set by the time this runs; falling back to `map` only as a defensive no-crash guard
  state.marksById.forEach((mark, id) => {
    const marker = state.markersById.get(id);
    if (!marker) return;
    const passes = markMatchesFilters(mark, state.filters);
    const onMap = layer.hasLayer(marker);
    if (passes) {
      if (!onMap) layer.addLayer(marker);
      const style = markStyleFor(mark, state);
      marker.setStyle({ color: style.color, fillColor: style.fillColor, radius: style.radius, weight: style.weight });
      marker.unbindTooltip();
      marker.bindTooltip(markTooltipText(mark, state), { direction: "top" });
    } else if (onMap) {
      layer.removeLayer(marker);
    }
  });
}

/**
 * Small removable-chip summary of whatever filters are currently active —
 * covers both MARK_LIST_FIELDS and MARK_FILTER_ONLY_FIELDS (e.g. Source),
 * since a filter can be active on either kind. "NOT " prefix distinguishes
 * an exclude chip from an include one alongside the include/exclude colour
 * coding (see the inline styles below), since colour alone isn't a safe
 * way to convey that distinction (screen readers, colour-blindness).
 * Renders nothing (empty container) when no filters are active at all,
 * rather than an empty title bar with nothing under it.
 */
function renderActiveFilterChips(container, state, onChange) {
  const chips = [];
  for (const { key, label } of [...MARK_LIST_FIELDS, ...MARK_FILTER_ONLY_FIELDS]) {
    const f = state.filters[key];
    if (!f) continue;
    for (const v of f.include || []) chips.push({ key, label, value: v, mode: "include" });
    for (const v of f.exclude || []) chips.push({ key, label, value: v, mode: "exclude" });
  }
  // The Date/Time range is one chip per bound ("from"/"to"), not an include/exclude value.
  const range = state.filters.dateTime;
  if (range && range.from) chips.push({ key: "dateTime", label: "Date/Time", value: `from ${range.from.replace("T", " ")}`, mode: "from" });
  if (range && range.to) chips.push({ key: "dateTime", label: "Date/Time", value: `to ${range.to.replace("T", " ")}`, mode: "to" });
  if (chips.length === 0) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = chips
    .map((c) => {
      const style =
        c.mode === "include"
          ? "background:#dcfce7;border-color:#16a34a;color:#166534;"
          : c.mode === "exclude"
            ? "background:#fee2e2;border-color:#dc2626;color:#991b1b;"
            : "background:#dbeafe;border-color:#2563eb;color:#1e40af;";
      const escValue = escapeHtml(c.value);
      return `<span class="loc-chip" style="display:inline-flex;align-items:center;gap:4px;cursor:default;font-size:0.72rem;padding:3px 8px;${style}">
        ${c.mode === "exclude" ? "NOT " : ""}${escapeHtml(c.label)}: ${escValue}
        <button type="button" data-remove-active-filter data-field="${c.key}" data-value="${escValue}" data-mode="${c.mode}"
          aria-label="Remove filter"
          style="background:none;border:none;color:inherit;cursor:pointer;padding:0;font-size:0.9rem;line-height:1;">×</button>
      </span>`;
    })
    .join("");
  container.querySelectorAll("[data-remove-active-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const { field, value, mode } = btn.dataset;
      if (field === "dateTime") state.filters.dateTime[mode] = "";
      else state.filters[field]?.[mode]?.delete(value);
      onChange();
    });
  });
}

/**
 * Modal for setting filters — one section per MARK_LIST_FIELDS entry that
 * actually has values in mark_lists.json, PLUS one section per
 * MARK_FILTER_ONLY_FIELDS entry (currently just Source) using whatever
 * distinct values are actually present across the loaded marks instead
 * (see distinctValuesForField) — a field with nothing to show either way
 * is skipped outright, not shown as an empty section. Each value is a
 * 3-state chip cycling neutral -> include -> exclude -> neutral on tap.
 * Mutates state.filters directly and live as chips are tapped (no separate
 * "apply" step to remember) — Done/the close button/tapping the backdrop
 * all just close the dialog the same way, since every change already took
 * effect the moment it was tapped. "Clear all" empties every field's
 * filter in one go, for starting over without hunting down each chip.
 *
 * Resolves once closed (no return value — the caller reads state.filters
 * directly afterward, same object that was already being mutated live).
 */
// Which filter groups are expanded in the dialog below — kept across openings (all start collapsed).
const markFilterOpenGroups = new Set();

function showMarkFilterModal(state) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "ww-candidate-overlay";

    function chipStateFor(key, value) {
      const f = state.filters[key];
      if (f && f.include && f.include.has(value)) return "include";
      if (f && f.exclude && f.exclude.has(value)) return "exclude";
      return "neutral";
    }
    function chipStyleFor(chipState) {
      if (chipState === "include") return "background:#dcfce7;border-color:#16a34a;color:#166534;";
      if (chipState === "exclude") return "background:#fee2e2;border-color:#dc2626;color:#991b1b;";
      if (chipState === "range") return "background:#dbeafe;border-color:#2563eb;color:#1e40af;";
      return "";
    }
    // Every group is collapsible. While collapsed, its header shows whatever is applied in it (see
    // summaryHtmlFor), so a glance down the list says what the filters are without opening anything.
    // Which groups are open is remembered between openings of this dialog (markFilterOpenGroups).
    function groupHtml(key, label, bodyHtml) {
      const open = markFilterOpenGroups.has(key);
      return `
        <div class="mark-filter-group" data-group="${key}" style="margin-bottom:8px;border:1px solid var(--grey-200);border-radius:8px;">
          <button type="button" data-toggle-group="${key}" aria-expanded="${open}"
            style="display:flex;align-items:center;gap:8px;width:100%;background:none;border:none;padding:8px 10px;cursor:pointer;text-align:left;font:inherit;color:inherit;">
            <span data-caret style="display:inline-block;width:0.9em;transition:transform 0.1s;${open ? "" : "transform:rotate(-90deg);"}">▾</span>
            <span style="font-size:0.8rem;font-weight:600;flex-shrink:0;">${label}</span>
            <span data-summary="${key}" style="display:${open ? "none" : "flex"};flex-wrap:wrap;gap:4px;min-width:0;">${summaryHtmlFor(key)}</span>
          </button>
          <div data-group-body="${key}" style="display:${open ? "block" : "none"};padding:0 10px 10px;">${bodyHtml}</div>
        </div>
      `;
    }
    function summaryChip(text, chipState) {
      return `<span class="loc-chip" style="cursor:default;font-size:0.72rem;padding:2px 7px;${chipStyleFor(chipState)}">${text}</span>`;
    }
    // The applied filters of one group as small chips (green = required, red = excluded, blue = a date bound).
    function summaryHtmlFor(key) {
      const f = state.filters[key];
      if (!f) return "";
      const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;");
      if (key === "dateTime") {
        return (f.from ? summaryChip(`from ${esc(f.from.replace("T", " "))}`, "range") : "") + (f.to ? summaryChip(`to ${esc(f.to.replace("T", " "))}`, "range") : "");
      }
      return [...(f.include || [])].map((v) => summaryChip(esc(v), "include")).join("") + [...(f.exclude || [])].map((v) => summaryChip(`NOT ${esc(v)}`, "exclude")).join("");
    }
    function sectionHtml(key, label, values) {
      if (values.length === 0) return ""; // nothing to filter on for this field yet — no point showing an empty section
      const chips = values
        .map((v) => {
          const cs = chipStateFor(key, v);
          const escValue = v.replace(/"/g, "&quot;");
          const escText = v.replace(/</g, "&lt;");
          return `<span class="loc-chip mark-filter-chip" data-field="${key}" data-value="${escValue}" data-state="${cs}"
            style="cursor:pointer;${chipStyleFor(cs)}">${escText}</span>`;
        })
        .join("");
      return groupHtml(key, label, `<div style="display:flex;flex-wrap:wrap;gap:6px;">${chips}</div>`);
    }
    function dateSectionHtml() {
      const r = state.filters.dateTime || { from: "", to: "" };
      const inputStyle = "display:block;margin-top:2px;padding:5px 8px;border-radius:8px;border:1px solid var(--grey-200);font:inherit;";
      return groupHtml(
        "dateTime",
        "Date/Time",
        `<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;">
          <label style="font-size:0.8rem;">From<input type="datetime-local" data-date-bound="from" value="${r.from || ""}" style="${inputStyle}" /></label>
          <label style="font-size:0.8rem;">To<input type="datetime-local" data-date-bound="to" value="${r.to || ""}" style="${inputStyle}" /></label>
          <button type="button" class="btn-secondary" data-date-clear style="padding:4px 10px;font-size:0.8rem;">Clear dates</button>
        </div>`
      );
    }

    const sectionsHtml =
      dateSectionHtml() +
      MARK_LIST_FIELDS.map(({ key, label }) => sectionHtml(key, label, state.markLists.filter((r) => r.field === label).map((r) => r.value))).join("") +
      MARK_FILTER_ONLY_FIELDS.map(({ key, label }) => sectionHtml(key, label, distinctValuesForField(state.marksById, key))).join("");

    overlay.innerHTML = `
      <div class="ww-candidate-dialog">
        <button type="button" class="ww-candidate-close" aria-label="Close">&times;</button>
        <h3 style="margin:0 0 4px;">Filter marks</h3>
        <p class="footnote" style="margin:0 0 12px;">Tap once to require it, tap again to exclude it, tap again to clear.</p>
        ${sectionsHtml || `<p class="footnote" style="margin:0;">No pick-list options set up yet — add some on the Settings tab first.</p>`}
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button type="button" id="markFilterClearAll" class="btn-secondary" style="flex:1;">Clear all</button>
          <button type="button" id="markFilterDone" class="btn-primary" style="flex:1;">Done</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const cleanup = () => {
      overlay.remove();
      resolve();
    };

    function cycleChip(chip) {
      const key = chip.dataset.field;
      const value = chip.dataset.value;
      const current = chip.dataset.state;
      if (!state.filters[key]) state.filters[key] = { include: new Set(), exclude: new Set() };
      const f = state.filters[key];
      let next;
      if (current === "neutral") {
        f.include.add(value);
        next = "include";
      } else if (current === "include") {
        f.include.delete(value);
        f.exclude.add(value);
        next = "exclude";
      } else {
        f.exclude.delete(value);
        next = "neutral";
      }
      chip.dataset.state = next;
      chip.style.cssText = `cursor:pointer;${chipStyleFor(next)}`;
      refreshSummary(key);
    }

    function refreshSummary(key) {
      const el = overlay.querySelector(`[data-summary="${key}"]`);
      if (el) el.innerHTML = summaryHtmlFor(key);
    }

    overlay.querySelectorAll(".mark-filter-chip").forEach((chip) => {
      chip.addEventListener("click", () => cycleChip(chip));
    });

    // Open/close a group. The summary of applied filters only shows while it's closed (open, the chips themselves show it).
    overlay.querySelectorAll("[data-toggle-group]").forEach((head) => {
      head.addEventListener("click", () => {
        const key = head.dataset.toggleGroup;
        const open = head.getAttribute("aria-expanded") !== "true";
        if (open) markFilterOpenGroups.add(key);
        else markFilterOpenGroups.delete(key);
        head.setAttribute("aria-expanded", String(open));
        head.querySelector("[data-caret]").style.transform = open ? "" : "rotate(-90deg)";
        head.querySelector("[data-summary]").style.display = open ? "none" : "flex";
        overlay.querySelector(`[data-group-body="${key}"]`).style.display = open ? "block" : "none";
      });
    });

    // Date/Time range: written straight into state.filters.dateTime as the inputs change.
    const dateInputs = overlay.querySelectorAll("[data-date-bound]");
    dateInputs.forEach((input) => {
      input.addEventListener("input", () => {
        if (!state.filters.dateTime) state.filters.dateTime = { from: "", to: "" };
        state.filters.dateTime[input.dataset.dateBound] = input.value;
        refreshSummary("dateTime");
      });
    });
    const dateClear = overlay.querySelector("[data-date-clear]");
    if (dateClear) {
      dateClear.addEventListener("click", () => {
        state.filters.dateTime = { from: "", to: "" };
        dateInputs.forEach((input) => (input.value = ""));
        refreshSummary("dateTime");
      });
    }

    overlay.querySelector("#markFilterClearAll").addEventListener("click", () => {
      for (const key of Object.keys(state.filters)) {
        state.filters[key] = key === "dateTime" ? { from: "", to: "" } : { include: new Set(), exclude: new Set() };
      }
      overlay.querySelectorAll(".mark-filter-chip").forEach((chip) => {
        chip.dataset.state = "neutral";
        chip.style.cssText = "cursor:pointer;";
      });
      dateInputs.forEach((input) => (input.value = ""));
      overlay.querySelectorAll("[data-summary]").forEach((el) => (el.innerHTML = ""));
    });
    overlay.querySelector("#markFilterDone").addEventListener("click", cleanup);
    overlay.querySelector(".ww-candidate-close").addEventListener("click", cleanup);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup();
    });
  });
}

/**
 * Wires up the small floating control bar (see #markControlsBar in
 * conditions.html/live.html) — the "colour by" select, the Filters
 * button + modal, and the active-filter chip row — and shows it, since
 * it starts hidden in the HTML (nothing to control before marks have
 * loaded at all). Called once, at the end of loadAndRenderMarks, so it
 * only ever appears alongside actual mark data.
 */
function initMarkControls(map, state) {
  const bar = document.getElementById("markControlsBar");
  if (!bar) return; // page doesn't have the controls markup (shouldn't happen on Location/Live, defensive)
  bar.style.display = "block";

  const select = document.getElementById("markGroupBySelect");
  select.innerHTML = MARK_LIST_FIELDS.map(({ key, label }) => `<option value="${key}"${key === state.groupByKey ? " selected" : ""}>${label}</option>`).join("");
  select.addEventListener("change", () => {
    state.groupByKey = select.value;
    refresh();
  });

  const chipsContainer = document.getElementById("markActiveFilterChips");
  const badge = document.getElementById("markFilterBadge");

  function refresh() {
    applyMarkFiltersAndGrouping(map, state);
    renderActiveFilterChips(chipsContainer, state, refresh);
    const activeCount = Object.entries(state.filters).reduce((n, [key, f]) => n + (!f ? 0 : key === "dateTime" ? (f.from ? 1 : 0) + (f.to ? 1 : 0) : f.include.size + f.exclude.size), 0);
    badge.style.display = activeCount > 0 ? "flex" : "none";
    badge.textContent = String(activeCount);
    saveMarkViewSettings(state);
  }

  document.getElementById("markFilterBtn").addEventListener("click", async () => {
    await showMarkFilterModal(state);
    refresh();
  });

  refresh(); // respects whatever was restored from localStorage on load
}

// ---------------------------------------------------------------------
// Multi-select and bulk edit — Ctrl(or Cmd)+click toggles one mark,
// Ctrl+drag on the map itself box-selects (toggling) every mark inside
// it. Shared here rather than built separately for Location/Live and
// the Sync page's own export map, since both need the exact same
// mechanics.
// ---------------------------------------------------------------------

/** Ctrl (or Cmd, for cross-platform parity) is this whole feature's own
 * "select, don't do the normal thing" modifier throughout — checked
 * directly against the raw DOM event (originalEvent), since that's the
 * only place a browser actually exposes it; Leaflet's own event
 * wrapper doesn't add an equivalent of its own. */
function isSelectModifierKey(domEvent) {
  return !!(domEvent && (domEvent.ctrlKey || domEvent.metaKey));
}

/**
 * Visually marks one marker as selected (a plainly bigger, brighter
 * ring) or restores it to its own normal markStyleFor() styling — same
 * idea, and the same real bug already found and worked around, as
 * highlightSessionMarker's own comment: setRadius (not passing radius
 * through setStyle) is what actually resizes a diamond/cross shape
 * correctly, not just a plain circle.
 */
function applyMarkSelectionVisual(marker, mark, state, selected) {
  const style = markStyleFor(mark, state);
  if (selected) {
    marker.setStyle({ color: "#f59e0b", weight: 3, fillColor: style.fillColor });
    marker.setRadius(style.radius + 4);
  } else {
    marker.setStyle({ color: style.color, weight: style.weight, fillColor: style.fillColor });
    marker.setRadius(style.radius);
  }
}

/** Toggles one mark's own selection state, WITHOUT re-rendering the
 * summary panel — used directly by the box-select loop below so
 * selecting many marks at once only re-renders the panel once at the
 * end, not once per mark toggled. toggleMarkSelection (below) is the
 * single-mark version most callers actually want. */
function toggleMarkSelectionSilent(state, markId) {
  const marker = state.markersById.get(markId);
  const mark = state.marksById.get(markId);
  if (!marker || !mark) return;
  if (state.selectedMarkIds.has(markId)) {
    state.selectedMarkIds.delete(markId);
    applyMarkSelectionVisual(marker, mark, state, false);
  } else {
    state.selectedMarkIds.add(markId);
    applyMarkSelectionVisual(marker, mark, state, true);
  }
}

function toggleMarkSelection(map, state, markId) {
  toggleMarkSelectionSilent(state, markId);
  renderSelectionPanel(map, state);
}

/** Deselects everything, restoring every currently-selected marker's
 * own normal styling and hiding the summary panel (renderSelectionPanel
 * itself hides the panel once the selection is empty). */
function clearMarkSelection(map, state) {
  for (const markId of state.selectedMarkIds) {
    const marker = state.markersById.get(markId);
    const mark = state.marksById.get(markId);
    if (marker && mark) applyMarkSelectionVisual(marker, mark, state, false);
  }
  state.selectedMarkIds.clear();
  renderSelectionPanel(map, state);
}

/**
 * Ctrl+drag on the map itself (not on a marker) draws a temporary
 * selection box, and on release TOGGLES every mark whose own lat/lng
 * falls inside it — matched by real geographic position against every
 * loaded mark, not just whichever happen to be individually visible at
 * the current zoom, so a box drawn over a collapsed cluster correctly
 * toggles its members even though it isn't showing them individually
 * right now (Oliver's own call).
 *
 * Deliberately built on raw mousedown/mousemove/mouseup rather than any
 * Leaflet drag-handler class, since this needs to coexist with the
 * map's own normal drag-to-pan — completely unchanged, still works
 * without the modifier — rather than replace it. The map's own
 * dragging is explicitly disabled only for the duration of a held-
 * Ctrl drag and re-enabled the moment it ends, so a plain drag
 * immediately afterwards still pans exactly as it always has.
 */
function initMarkSelectionBoxDrag(map, state) {
  let boxStart = null; // container-point where the drag began
  let boxEl = null; // the temporary visual rectangle, a direct child of the map's own container

  function updateBoxEl(p1, p2) {
    const left = Math.min(p1.x, p2.x);
    const top = Math.min(p1.y, p2.y);
    const width = Math.abs(p2.x - p1.x);
    const height = Math.abs(p2.y - p1.y);
    boxEl.style.left = `${left}px`;
    boxEl.style.top = `${top}px`;
    boxEl.style.width = `${width}px`;
    boxEl.style.height = `${height}px`;
  }

  map.on("mousedown", (e) => {
    if (!isSelectModifierKey(e.originalEvent)) return;
    L.DomEvent.stop(e);
    map.dragging.disable();
    boxStart = e.containerPoint;
    boxEl = document.createElement("div");
    boxEl.className = "mark-select-box";
    map.getContainer().appendChild(boxEl);
    updateBoxEl(boxStart, boxStart);
  });

  map.on("mousemove", (e) => {
    if (!boxStart) return;
    updateBoxEl(boxStart, e.containerPoint);
  });

  map.on("mouseup", (e) => {
    if (!boxStart) return;
    const p1 = boxStart;
    const p2 = e.containerPoint;
    boxStart = null;
    if (boxEl) {
      boxEl.remove();
      boxEl = null;
    }
    map.dragging.enable();
    // Set for BOTH the tiny-drag and the real-box cases below — either way,
    // map.dragging was just disabled and re-enabled for this one gesture,
    // which is exactly what makes Leaflet fire a spurious "click" on
    // mouseup regardless of how far the mouse actually moved (see
    // handleMapClickForMarks's own comment on this same flag for the full
    // explanation). A Ctrl+click on open water with no real drag intended
    // is just as affected as a genuine box-select, so this needs to be set
    // before the tiny-drag early return below, not after it.
    state._justFinishedBoxSelect = true;

    // A genuinely tiny drag (a Ctrl+click on empty water with barely any
    // pointer movement) isn't a meaningful box — toggling nothing is the
    // right behaviour for it, not an accidental single-point selection.
    if (Math.abs(p2.x - p1.x) < 4 && Math.abs(p2.y - p1.y) < 4) return;

    const bounds = L.latLngBounds(map.containerPointToLatLng(p1), map.containerPointToLatLng(p2));
    for (const markId of state.marksById.keys()) {
      const mark = state.marksById.get(markId);
      if (mark.lat == null || mark.lng == null) continue;
      if (bounds.contains([mark.lat, mark.lng])) toggleMarkSelectionSilent(state, markId);
    }
    renderSelectionPanel(map, state);
  });

  /**
   * Ctrl+click on a CLUSTER icon (not an individual marker) selects
   * every mark inside it — including ones several sub-clusters deep,
   * not just whichever are directly shown — instead of the group's own
   * default click behaviour (zoom in, or spiderfy at max zoom).
   *
   * state.markerLayer's own _zoomOrSpiderfy (leaflet.markercluster's own
   * internal handler, bound to "clusterclick" once when the group
   * itself is first created — always registered before anything added
   * here, so it always runs first) decides what to do by reading
   * zoomToBoundsOnClick/spiderfyOnMaxZoom/spiderfyOnEveryZoom directly
   * off state.markerLayer.options at the moment IT runs — a second
   * "clusterclick" listener of this code's own further down couldn't
   * stop it by then, the zoom/spiderfy would already have happened.
   * "clustermousedown" is what actually gives this a chance to act
   * first: leaflet.markercluster forwards raw mouse events on a cluster
   * icon with a "cluster" prefix (see its own overridden fire(), in the
   * plugin's own source), firing before "clusterclick" for the exact
   * same physical click — so the three options are only ever turned off
   * here, then restored the moment this code's own "clusterclick"
   * handler below has used them, never left off longer than that one
   * click needs.
   */
  let clusterZoomOptionsBackup = null;
  state.markerLayer.on("clustermousedown", (e) => {
    if (!isSelectModifierKey(e.originalEvent)) return;
    clusterZoomOptionsBackup = {
      zoomToBoundsOnClick: state.markerLayer.options.zoomToBoundsOnClick,
      spiderfyOnMaxZoom: state.markerLayer.options.spiderfyOnMaxZoom,
      spiderfyOnEveryZoom: state.markerLayer.options.spiderfyOnEveryZoom,
    };
    state.markerLayer.options.zoomToBoundsOnClick = false;
    state.markerLayer.options.spiderfyOnMaxZoom = false;
    state.markerLayer.options.spiderfyOnEveryZoom = false;
  });
  state.markerLayer.on("clusterclick", (e) => {
    if (!isSelectModifierKey(e.originalEvent)) return;
    L.DomEvent.stop(e);
    for (const marker of e.layer.getAllChildMarkers()) {
      if (marker._markId) toggleMarkSelectionSilent(state, marker._markId);
    }
    renderSelectionPanel(map, state);
    if (clusterZoomOptionsBackup) {
      state.markerLayer.options.zoomToBoundsOnClick = clusterZoomOptionsBackup.zoomToBoundsOnClick;
      state.markerLayer.options.spiderfyOnMaxZoom = clusterZoomOptionsBackup.spiderfyOnMaxZoom;
      state.markerLayer.options.spiderfyOnEveryZoom = clusterZoomOptionsBackup.spiderfyOnEveryZoom;
      clusterZoomOptionsBackup = null;
    }
  });
}

/**
 * Shows "N marks selected" plus Bulk edit / Clear selection in the
 * shared #markDetailPanel — the same panel an individual mark's popup
 * already uses (attachPopupToDetailPanel), but written directly into
 * it rather than reparenting a Leaflet popup, since there's no single
 * popup involved for a multi-mark selection. Hides the panel entirely
 * once the selection is empty, rather than showing "0 selected".
 */
function renderSelectionPanel(map, state) {
  const panel = document.getElementById("markDetailPanel");
  if (!panel) return;
  const count = state.selectedMarkIds.size;
  if (count === 0) {
    panel.style.display = "none";
    panel.innerHTML = "";
    return;
  }
  panel.innerHTML = `
    <div data-selection-summary style="padding:4px;">
      <div style="font-weight:700;margin-bottom:10px;">${count} mark${count === 1 ? "" : "s"} selected</div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        <button type="button" class="btn-primary" data-bulk-edit-btn>Bulk edit</button>
        <button type="button" class="btn-secondary" data-bulk-delete-btn style="color:#dc2626;">Delete</button>
        <button type="button" class="btn-secondary" data-clear-selection-btn>Clear selection</button>
      </div>
      <div data-bulk-delete-confirm style="display:none;margin-top:8px;padding:8px;border:1px solid #fecaca;background:#fef2f2;border-radius:6px;font-size:0.85rem;">
        <div data-bulk-delete-confirm-text style="margin-bottom:6px;"></div>
        <button type="button" class="btn-secondary" data-bulk-delete-confirm-yes style="padding:4px 10px;font-size:0.85rem;background:#dc2626;color:#fff;border-color:#dc2626;">Yes, delete</button>
        <button type="button" class="btn-secondary" data-bulk-delete-cancel style="padding:4px 10px;font-size:0.85rem;">Cancel</button>
        <div data-bulk-delete-status style="margin-top:6px;font-size:0.8rem;"></div>
      </div>
    </div>
  `;
  panel.style.display = "block";
  panel.querySelector("[data-bulk-edit-btn]").addEventListener("click", () => renderBulkEditForm(map, state));
  panel.querySelector("[data-clear-selection-btn]").addEventListener("click", () => clearMarkSelection(map, state));

  const deleteBtn = panel.querySelector("[data-bulk-delete-btn]");
  const deleteConfirmBlock = panel.querySelector("[data-bulk-delete-confirm]");
  deleteBtn.addEventListener("click", () => {
    // Session pairs not already in the selection get pulled in too, the
    // same convention the single-mark delete flow already uses (deleting
    // either half of a session removes the whole thing, never leaving an
    // orphaned other half behind) — computed fresh here so the
    // confirmation text is honest about the real number of marks about to
    // be deleted, not just how many were actually clicked.
    const idsToDelete = markIdsToDeleteIncludingSessionPairs(state);
    const extra = idsToDelete.size - count;
    panel.querySelector("[data-bulk-delete-confirm-text]").textContent =
      extra > 0
        ? `Delete ${count} selected mark${count === 1 ? "" : "s"} and ${extra} paired session mark${extra === 1 ? "" : "s"} (${idsToDelete.size} total)? This can't be undone.`
        : `Delete ${count} mark${count === 1 ? "" : "s"}? This can't be undone.`;
    deleteConfirmBlock.style.display = "block";
  });
  panel.querySelector("[data-bulk-delete-cancel]").addEventListener("click", () => {
    deleteConfirmBlock.style.display = "none";
  });
  panel.querySelector("[data-bulk-delete-confirm-yes]").addEventListener("click", () => handleBulkDeleteConfirm(map, state));
}

/** Every currently-selected mark's own id, PLUS — for any that's a
 * Session with its pair not already selected — that pair's id too,
 * matching the single-mark delete flow's own established rule that
 * deleting either half of a session always removes the whole thing. */
function markIdsToDeleteIncludingSessionPairs(state) {
  const ids = new Set(state.selectedMarkIds);
  for (const markId of state.selectedMarkIds) {
    const mark = state.marksById.get(markId);
    if (!mark || !isSessionType(mark.type) || !mark.sessionGroupId) continue;
    for (const other of state.marksById.values()) {
      if (other.id !== mark.id && isSessionType(other.type) && other.sessionGroupId === mark.sessionGroupId) {
        ids.add(other.id);
      }
    }
  }
  return ids;
}

/** Deletes every mark returned by markIdsToDeleteIncludingSessionPairs —
 * one DELETE per mark (reusing deleteMarkFromD1, the exact same call
 * the single-mark delete flow already makes), removing each from the
 * map and from state immediately as its own delete succeeds rather
 * than waiting for all of them, so a partial failure still leaves
 * whatever DID succeed visibly gone. Reports a clear count and the
 * real error on partial failure, same as handleBulkEditSave. */
async function handleBulkDeleteConfirm(map, state) {
  const panel = document.getElementById("markDetailPanel");
  const statusEl = panel.querySelector("[data-bulk-delete-status]");
  const yesBtn = panel.querySelector("[data-bulk-delete-confirm-yes]");
  yesBtn.disabled = true;
  const idsToDelete = Array.from(markIdsToDeleteIncludingSessionPairs(state));
  statusEl.textContent = `Deleting ${idsToDelete.length} mark${idsToDelete.length === 1 ? "" : "s"}…`;
  statusEl.style.color = "";

  let succeeded = 0;
  const failures = [];
  for (const markId of idsToDelete) {
    const result = await deleteMarkFromD1(markId);
    if (result.success) {
      succeeded++;
      const marker = state.markersById.get(markId);
      if (marker) state.markerLayer.removeLayer(marker);
      state.marksById.delete(markId);
      state.markersById.delete(markId);
      state.selectedMarkIds.delete(markId);
    } else {
      failures.push({ markId, error: result.error });
    }
  }

  if (failures.length === 0) {
    renderSelectionPanel(map, state); // hides the panel once selectedMarkIds is empty
  } else {
    yesBtn.disabled = false;
    statusEl.textContent = `Deleted ${succeeded} of ${idsToDelete.length} — ${failures.length} failed: ${failures.map((f) => f.error).join("; ")}`;
    statusEl.style.color = "#dc2626";
  }
}

/** One tri-state field for the bulk-edit form below — "No change" is a
 * distinct sentinel from an actual empty value (a real, explicit
 * "clear this field on every selected mark"), which a plain 2-option
 * dropdown can't express. Reuses the exact same pick-list values a
 * single mark's own edit form shows (markListOptionsHtml's own source
 * data), just with this sentinel prepended. */
function bulkEditPicklistFieldHtml(field, markLists) {
  const values = markLists.filter((r) => r.field === field.listLabel).map((r) => r.value);
  return `
    <div style="margin-bottom:8px;">
      <label style="display:block;font-size:0.8rem;font-weight:600;margin-bottom:2px;">${escapeHtml(field.displayLabel)}
        <select name="${field.key}" style="${MARK_POPUP_INPUT_STYLE}">
          <option value="__nochange__" selected>— No change —</option>
          <option value="">(clear)</option>
          ${values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("")}
        </select>
      </label>
    </div>`;
}

/** A plain number input's own blank state already unambiguously means
 * "didn't touch this one" for bulk-edit purposes (there's no realistic
 * need to explicitly blank out a barometer reading across many marks
 * at once the way there is for, say, Species) — so this doesn't need
 * the same explicit tri-state sentinel the picklist fields above do. */
function bulkEditNumericFieldHtml(key, label, step, min) {
  return `
    <div style="margin-bottom:8px;">
      <label style="display:block;font-size:0.8rem;font-weight:600;margin-bottom:2px;">${escapeHtml(label)}
        <input type="number" name="${key}" placeholder="No change" ${min != null ? `min="${min}"` : ""} step="${step}" style="${MARK_POPUP_INPUT_STYLE}" />
      </label>
    </div>`;
}

function renderBulkEditForm(map, state) {
  const panel = document.getElementById("markDetailPanel");
  if (!panel) return;
  const count = state.selectedMarkIds.size;
  const picklistFieldsHtml = MARK_POPUP_OPTIONAL_FIELDS.map((f) => bulkEditPicklistFieldHtml(f, state.markLists)).join("");
  panel.innerHTML = `
    <div data-bulk-edit-form style="padding:4px;">
      <div style="font-weight:700;margin-bottom:6px;">Bulk edit ${count} mark${count === 1 ? "" : "s"}</div>
      <p class="footnote" style="margin:0 0 10px;">Only fields you change here get updated — anything left as "No change" stays exactly as it is on every mark.</p>
      <form data-bulk-edit-form-el onsubmit="return false;">
        ${picklistFieldsHtml}
        ${bulkEditNumericFieldHtml("size", "Size (cm)", "1", "0")}
        ${bulkEditNumericFieldHtml("barometer", "Barometer (hPa)", "0.1", "0")}
        ${bulkEditNumericFieldHtml("temperature", "Temperature (°C)", "0.1")}
        ${bulkEditNumericFieldHtml("waterTemperature", "Water Temp (°C)", "0.1")}
        ${bulkEditNumericFieldHtml("waterDepth", "Water Depth (m)", "0.1", "0")}
        <div style="margin-bottom:8px;">
          <label style="display:block;font-size:0.8rem;font-weight:600;margin-bottom:2px;">Wind Direction
            <select name="windDirection" style="${MARK_POPUP_INPUT_STYLE}">
              <option value="__nochange__" selected>— No change —</option>
              <option value="">(clear)</option>
              ${SHORE_OPTIONS.map((d) => `<option value="${d}">${d}</option>`).join("")}
            </select>
          </label>
        </div>
        ${bulkEditNumericFieldHtml("windSpeed", "Wind Speed (km/h)", "1", "0")}
        <div style="margin-bottom:8px;">
          <label style="display:block;font-size:0.8rem;font-weight:600;margin-bottom:2px;">Released
            <select name="released" style="${MARK_POPUP_INPUT_STYLE}">
              <option value="__nochange__" selected>— No change —</option>
              <option value="1">Yes</option>
              <option value="0">No</option>
            </select>
          </label>
        </div>
        <div style="margin-bottom:8px;">
          <label style="display:block;font-size:0.8rem;font-weight:600;margin-bottom:2px;">Notes
            <textarea name="notes" placeholder="No change" rows="2" style="${MARK_POPUP_INPUT_STYLE}"></textarea>
          </label>
        </div>
        <div data-bulk-edit-status style="margin:8px 0;font-size:0.85rem;"></div>
        <button type="button" data-bulk-edit-save class="btn-primary" style="margin-right:8px;">Save to ${count} mark${count === 1 ? "" : "s"}</button>
        <button type="button" data-bulk-edit-cancel class="btn-secondary">Cancel</button>
      </form>
    </div>
  `;
  panel.style.display = "block";
  panel.querySelector("[data-bulk-edit-cancel]").addEventListener("click", () => renderSelectionPanel(map, state));
  panel.querySelector("[data-bulk-edit-save]").addEventListener("click", () => handleBulkEditSave(map, state));
}

/**
 * Reads the bulk-edit form, returning ONLY the fields actually
 * touched — anything left at its own "No change" sentinel (picklist/
 * tri-state fields) or left blank (numeric/text fields, where blank
 * means "didn't touch this one") is simply omitted from the returned
 * object entirely, never set to null/empty by omission. The backend's
 * own mergeMarkFields (user-backend.js) already treats an omitted key
 * as "leave this exactly as it is on this mark" — confirmed directly
 * against that code before building this — so nothing else is needed
 * on the save side to get "only edited fields get updated" right.
 */
function collectBulkEditFormValues(form) {
  const updates = {};
  for (const field of MARK_POPUP_OPTIONAL_FIELDS) {
    const raw = form.querySelector(`[name="${field.key}"]`).value;
    if (raw === "__nochange__") continue;
    updates[field.key] = raw; // "" here is a deliberate clear, distinct from the __nochange__ sentinel above
  }
  for (const key of ["size", "barometer", "temperature", "waterTemperature", "waterDepth", "windSpeed"]) {
    const raw = form.querySelector(`[name="${key}"]`).value;
    if (raw === "") continue;
    updates[key] = Number(raw);
  }
  const windDirection = form.querySelector('[name="windDirection"]').value;
  if (windDirection !== "__nochange__") updates.windDirection = windDirection;
  const released = form.querySelector('[name="released"]').value;
  if (released !== "__nochange__") updates.released = released === "1";
  const notes = form.querySelector('[name="notes"]').value;
  if (notes !== "") updates.notes = notes;
  return updates;
}

/** Saves the same partial-update body to every selected mark — one PUT
 * per mark (reusing saveMarkToD1, the exact same call a single mark's
 * own edit form already makes; the backend's own partial-merge logic
 * is what actually makes "only touched fields change" work, not
 * anything special here), since there's no bulk-update endpoint and
 * building one wasn't needed once the per-mark merge already worked
 * correctly. Reports a clear count on partial failure rather than
 * silently losing track of which ones didn't save. */
async function handleBulkEditSave(map, state) {
  const panel = document.getElementById("markDetailPanel");
  const form = panel.querySelector("[data-bulk-edit-form-el]");
  const statusEl = panel.querySelector("[data-bulk-edit-status]");
  const saveBtn = panel.querySelector("[data-bulk-edit-save]");
  const updates = collectBulkEditFormValues(form);
  if (Object.keys(updates).length === 0) {
    statusEl.textContent = "Nothing changed — pick at least one field to update.";
    statusEl.style.color = "#dc2626";
    return;
  }
  saveBtn.disabled = true;
  const markIds = Array.from(state.selectedMarkIds);
  statusEl.textContent = `Saving to ${markIds.length} mark${markIds.length === 1 ? "" : "s"}…`;
  statusEl.style.color = "";

  let succeeded = 0;
  const failures = [];
  for (const markId of markIds) {
    const result = await saveMarkToD1({ id: markId, ...updates }, false);
    if (result.success) {
      succeeded++;
      const mark = state.marksById.get(markId);
      if (mark) Object.assign(mark, updates); // keeps local state in sync so a later popup-open shows the fresh values without a full reload
    } else {
      failures.push({ markId, error: result.error });
    }
  }

  saveBtn.disabled = false;
  if (failures.length === 0) {
    statusEl.textContent = `Saved to all ${succeeded} mark${succeeded === 1 ? "" : "s"}.`;
    statusEl.style.color = "#16a34a";
    clearMarkSelection(map, state);
  } else {
    statusEl.textContent = `Saved to ${succeeded} of ${markIds.length} — ${failures.length} failed: ${failures.map((f) => f.error).join("; ")}`;
    statusEl.style.color = "#dc2626";
  }
}

/**
 * Fresh, empty {marksById, markersById, markLists} bag — create ONE per map
 * (Location tab, Live tab), pass the SAME object into both loadAndRenderMarks
 * (which populates it) and into the map's own click handler
 * (handleMapClickForMarks, which reads it) so the click handler always sees
 * whatever's currently loaded rather than a stale empty snapshot taken
 * before the async load finished. groupByKey/filters start from whatever
 * was saved last time (see loadMarkViewSettings) — shared across the
 * Location and Live tabs, since both call this the same way.
 */
function createMarkLayerState() {
  const saved = loadMarkViewSettings();
  return { marksById: new Map(), markersById: new Map(), markLists: [], groupByKey: saved.groupByKey, filters: saved.filters, canvasRenderer: null, highlightedSessionGroupId: null, selectedMarkIds: new Set() };
}

/**
 * Small yes/no-style modal asking whether a plain map click (Location tab
 * only — see handleMapClickForMarks) means "show me the conditions graph
 * for whatever's near here" (the pre-existing preview feature) or "log a
 * new mark right here". Reuses the WillyWeather candidate picker's overlay/
 * dialog frame (.ww-candidate-overlay/.ww-candidate-dialog/.ww-candidate-close,
 * style.css) rather than inventing a new modal shape — same "centered
 * dialog over a dimmed page" need, just two plain buttons instead of a
 * scrollable candidate list.
 *
 * Resolves to "graph", "mark", or "cancel".
 */
function showMapClickChoiceDialog() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "ww-candidate-overlay";
    overlay.innerHTML = `
      <div class="ww-candidate-dialog">
        <button type="button" class="ww-candidate-close" aria-label="Cancel">&times;</button>
        <h3 style="margin:0 0 4px;">What's here?</h3>
        <p class="footnote" style="margin:0 0 14px;">This spot isn't one of your tracked locations or an existing mark.</p>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <button type="button" class="btn-primary" data-map-click-choice="mark" style="width:100%;">Add a new mark here</button>
          <button type="button" class="btn-secondary" data-map-click-choice="graph" style="width:100%;">View the conditions graph for this spot</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const cleanup = (result) => {
      overlay.remove();
      resolve(result);
    };
    overlay.querySelector(".ww-candidate-close").addEventListener("click", () => cleanup("cancel"));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup("cancel");
    });
    overlay.querySelectorAll("[data-map-click-choice]").forEach((btn) => {
      btn.addEventListener("click", () => cleanup(btn.dataset.mapClickChoice));
    });
  });
}

/**
 * Starts a brand-new, unsaved mark at (lat, lng) — drops a circleMarker
 * straight away with its popup already open in edit mode (see
 * buildMarkPopupEditHtml), pre-filled with the coordinates, the current
 * date/time, source:"Manual" (see the schema comment above
 * MARKS_FILE_PATH), and whatever `defaults` supplies (see
 * computeQuickMarkDefaults and getLastMarkFieldValues — only the Live tab's
 * "You are here" click passes anything here; every other entry point
 * starts fully blank). Nothing is written to data/marks.json until Save is
 * actually pressed — Cancel (see wireMarkPopupButtons' isNew branch) just
 * removes this temporary marker again, leaving marks.json untouched.
 *
 * Separately, and asynchronously, Weather/Tide/Barometer/Wind get a
 * best-effort real-data fill-in a moment after the popup opens — see
 * fillMarkFormFromHistoricalLookup just below — without blocking the popup
 * itself on that network round trip.
 *
 * `state` is the same object loadAndRenderMarks populates for this map (see
 * createMarkLayerState) — on a successful save, wireMarkPopupButtons adds
 * the new mark/marker into it, so it behaves exactly like any other mark
 * from then on (clickable, re-editable) without needing a page reload.
 */
function startNewMarkEntry(map, lat, lng, state, defaults = {}) {
  const draft = {
    id: makeMarkId(),
    lat,
    lng,
    name: "",
    type: defaults.type || "",
    dateTime: nowAsNaiveString(),
    createdAt: null, // set for real only once actually saved — see wireMarkPopupButtons
    source: "Manual", // any mark created through this site's own UI — see the schema comment above MARKS_FILE_PATH
  };
  for (const f of MARK_POPUP_OPTIONAL_FIELDS) {
    if (defaults[f.key]) draft[f.key] = defaults[f.key];
  }
  const style = markStyleFor(draft, state);
  // Reuses the same Canvas renderer loadAndRenderMarks already created for
  // this map (stashed on state.canvasRenderer) rather than letting Leaflet
  // fall back to its own default renderer (SVG, since this map is never
  // created with preferCanvas) — required for anything but a plain circle,
  // see getDiamondMarkerClass/getCrossMarkerClass's own comment in
  // createMarkShapeLayer.
  // Falls back to creating one fresh here only if somehow called before
  // loadAndRenderMarks has run at all (defensive; shouldn't happen in
  // practice, since marks can't be clicked-to-create before the layer
  // that would receive the click has loaded).
  if (!state.canvasRenderer) state.canvasRenderer = L.canvas({ padding: 0.5 });
  const marker = createMarkShapeLayer([lat, lng], draft, {
    renderer: state.canvasRenderer,
    radius: style.radius,
    color: style.color,
    weight: style.weight,
    fillColor: style.fillColor,
    fillOpacity: 0.85,
  }, state.markLists).addTo(state.markerLayer);
  marker.bindPopup(buildMarkPopupEditHtml(draft, state.markLists), { maxWidth: 260, autoPanPadding: [20, 20], className: "mark-popup-leaflet", autoPan: false });
  // showMarkerOnceVisible (not zoomToShowLayer directly, and not a plain
  // openPopup) — a spot just clicked on the map is usually already
  // zoomed in enough that this resolves immediately with no visible
  // zoom, but if several existing marks already sit at/near this exact
  // point, the new one could otherwise land straight inside a cluster
  // with no visible pin to open a popup from at all — AND
  // zoomToShowLayer's own callback is confirmed unreliable for this
  // project's marker types (see showMarkerOnceVisible's own comment for
  // why: a real, previously-reported bug — Save silently doing nothing
  // because this callback never ran, so nothing ever wired it).
  // Everything that needs the popup's own DOM element has to wait for
  // this callback — it doesn't exist before the popup actually opens.
  showMarkerOnceVisible(state.markerLayer, marker, () => {
    marker.openPopup();
    const popupEl = marker.getPopup().getElement();
    wireMarkPopupButtons(popupEl, marker, draft, state.markLists, { isNew: true, map, state });

    // Best-effort auto-fill of Weather/Tide/Barometer/Wind from a real
    // historical lookup (see lookupHistoricalMarkConditions above) —
    // fired off in the background rather than awaited, since it's a
    // network round trip and the popup should open immediately regardless
    // of how long that takes. Skipped entirely for a POI or Mark-level
    // draft (checking whether ANY of this lookup's own fields even apply
    // to the type — see MARK_TYPE_FIELD_KEYS: those fields only ever ALL
    // apply together, on a Catch, never partially) — a WillyWeather call
    // plus two Open-Meteo calls would otherwise fire for every new mark
    // regardless of type, even though POI/Mark can't show or save a
    // single one of those fields.
    if (fieldKeysForMarkType(draft.type).includes("weatherCondition")) {
      fillMarkFormFromHistoricalLookup(popupEl, lat, lng, draft.dateTime);
    }
  });
}

/**
 * Starts a new, unsaved DRAFT mark at the SAME location as an existing
 * one, with every applicable field cloned from it (species, all catch
 * detail, notes, released, and its Date/Time too) — the "Copy" button on
 * a mark's own view popup. Deliberately does NOT copy the identity-ish
 * fields (id, createdAt, source, sourceUuid) — this is a genuinely new,
 * separate mark, not the same record moved to a new time. Opens directly
 * in edit mode, exactly like a brand-new mark from startNewMarkEntry, so
 * every field — most commonly Date/Time, for "I caught another one here
 * later" — can be adjusted before anything is actually saved. Changing
 * Date/Time in the form that opens re-runs the historical lookup and
 * OVERWRITES Weather/Tide/Barometer/etc for the new moment (see
 * refreshMarkFormConditionsForNewTime, wired in wireMarkPopupButtons) —
 * this function does NOT run that lookup itself at open time, since the
 * copy already carries the source mark's own real values for its
 * original time; only actually changing the time makes those stale
 * enough to be worth refetching.
 */
function startCopiedMarkEntry(map, sourceMark, state) {
  const draft = {
    id: makeMarkId(),
    lat: sourceMark.lat,
    lng: sourceMark.lng,
    name: sourceMark.name || "",
    type: sourceMark.type || "",
    dateTime: sourceMark.dateTime || nowAsNaiveString(),
    createdAt: null, // set for real only once actually saved — see wireMarkPopupButtons
    source: "Manual", // this copy is authored through this site's own UI, regardless of how the ORIGINAL mark got here
  };
  const applicable = fieldKeysForMarkType(draft.type);
  const COPYABLE_KEYS = [
    "species", "weatherCondition", "tideCondition", "tideExtreme", "waterCondition", "bait", "rig", "rod", "berley",
    "size", "barometer", "temperature", "waterTemperature", "waterDepth", "windDirection", "windSpeed",
    "notes", "released",
  ];
  for (const key of COPYABLE_KEYS) {
    if (applicable.includes(key) && sourceMark[key] != null) draft[key] = sourceMark[key];
  }

  const style = markStyleFor(draft, state);
  if (!state.canvasRenderer) state.canvasRenderer = L.canvas({ padding: 0.5 });
  const marker = createMarkShapeLayer([draft.lat, draft.lng], draft, {
    renderer: state.canvasRenderer,
    radius: style.radius,
    color: style.color,
    weight: style.weight,
    fillColor: style.fillColor,
    fillOpacity: 0.85,
  }, state.markLists).addTo(state.markerLayer);
  marker.bindPopup(buildMarkPopupEditHtml(draft, state.markLists), { maxWidth: 260, autoPanPadding: [20, 20], className: "mark-popup-leaflet", autoPan: false });
  // showMarkerOnceVisible — same reasoning as startNewMarkEntry's own
  // copy of this comment: this copy lands at the SAME point as its
  // source mark, which by definition already has at least one mark
  // there, so the odds of landing inside a cluster are if anything
  // higher than for a brand-new point. Also the exact call that first
  // surfaced the real zoomToShowLayer-callback bug this helper works
  // around — copying a mark, then finding its Save button silently did
  // nothing at all.
  showMarkerOnceVisible(state.markerLayer, marker, () => {
    marker.openPopup();
    const popupEl = marker.getPopup().getElement();
    wireMarkPopupButtons(popupEl, marker, draft, state.markLists, { isNew: true, map, state });
  });
}

/**
 * See startNewMarkEntry's own call site, just above. Only ever fills a
 * field that's STILL BLANK by the time the lookup resolves — checked
 * live against the form's own current value at that moment, not a
 * snapshot taken earlier, so it never clobbers anything the "You are
 * here" quick-entry already set (see computeQuickMarkDefaults/defaults
 * above) or anything the person already typed while waiting.
 *
 * `popupEl` is captured at call time in startNewMarkEntry — if that
 * popup's content has since been replaced (saved back to view mode) or
 * removed entirely (cancelled), the `[name="..."]` queries below simply
 * find nothing on this now-stale element and quietly no-op; there's no
 * separate "is this still the same open popup" check needed beyond that.
 */
async function fillMarkFormFromHistoricalLookup(popupEl, lat, lng, dateTimeNaive) {
  const result = await lookupHistoricalMarkConditions(lat, lng, dateTimeNaive);
  const form = popupEl && popupEl.querySelector("[data-mark-form]");
  if (!form) return;

  const fillIfBlank = (name, value) => {
    if (value == null || value === "") return;
    const el = form.querySelector(`[name="${name}"]`);
    if (el && !el.value) el.value = value;
  };
  fillIfBlank("weatherCondition", result.weatherCondition);
  fillIfBlank("tideCondition", result.tideCondition);
  fillIfBlank("tideExtreme", result.tideExtreme);
  fillIfBlank("barometer", result.barometer);
  fillIfBlank("temperature", result.temperature);
  fillIfBlank("waterTemperature", result.waterTemperature);
  fillIfBlank("windDirection", result.windDirection);
  fillIfBlank("windSpeed", result.windSpeed);
}

/**
 * REFRESHES Weather/Tide/Barometer/Temperature/Water Temperature/Wind on
 * an already-open mark EDIT form after its own Date/Time field changes —
 * unlike fillMarkFormFromHistoricalLookup above (which only fills a field
 * that's STILL BLANK, for a brand-new mark that's never had a real value
 * at all), this OVERWRITES whatever's currently in each field, since the
 * whole point of changing the time is that the OLD values reflect the
 * WRONG moment now. Most useful right after "Copy" on an existing mark
 * (same location, same everything, but a different time — see
 * startCopiedMarkEntry below), though it fires for ANY edit's date/time
 * change, new mark or existing. A field the fresh lookup DIDN'T resolve
 * (a network hiccup, or a date past Open-Meteo's own archive coverage)
 * is left exactly as it was rather than being blanked out — a partial
 * lookup failure should never destroy a value that was already there.
 * Skipped entirely for a POI/Mark-level form the same way the initial
 * fill is (see fieldKeysForMarkType's own check at the call site below)
 * — nothing to refresh if the form can't show or save a single one of
 * these fields in the first place.
 */
async function refreshMarkFormConditionsForNewTime(formEl, lat, lng, dateTimeNaive) {
  const result = await lookupHistoricalMarkConditions(lat, lng, dateTimeNaive);
  // A plain <input> (barometer, temperature, ...) accepts any value directly.
  // A <select> (weatherCondition, tideCondition, windDirection) does NOT —
  // setting .value to something with no matching <option> silently no-ops,
  // leaving the field blank rather than showing the new value. The initial
  // render (markListOptionsHtml) already handles this by adding the
  // current value as its own <option> if it's missing from the official
  // list; this does the same thing here, so a freshly-looked-up value (say
  // a weather condition Open-Meteo returned that isn't in
  // config/mark_lists.json's own Weather Condition list) still actually
  // shows and gets saved, instead of silently vanishing.
  const overwriteIfResolved = (name, value) => {
    if (value == null || value === "") return;
    const el = formEl.querySelector(`[name="${name}"]`);
    if (!el) return;
    if (el.tagName === "SELECT" && !Array.from(el.options).some((opt) => opt.value === String(value))) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = value;
      el.appendChild(opt);
    }
    el.value = value;
  };
  overwriteIfResolved("weatherCondition", result.weatherCondition);
  overwriteIfResolved("tideCondition", result.tideCondition);
  overwriteIfResolved("tideExtreme", result.tideExtreme);
  if (result.tideCondition && !result.tideExtreme) {
    // The tide state was re-resolved for the new time but no extreme could be
    // ranked — clear the old one rather than leave it describing the wrong tide.
    const extremeEl = formEl.querySelector('[name="tideExtreme"]');
    if (extremeEl) extremeEl.value = "";
  }
  overwriteIfResolved("barometer", result.barometer);
  overwriteIfResolved("temperature", result.temperature);
  overwriteIfResolved("waterTemperature", result.waterTemperature);
  overwriteIfResolved("windDirection", result.windDirection);
  overwriteIfResolved("windSpeed", result.windSpeed);
}

/**
 * What a plain click on empty map area (i.e. not on an existing marker)
 * should do — shared by the Location and Live tabs, since both maps now
 * carry the marks layer on top of whatever else they already show.
 *
 * onLocationPreviewClick, if given (Location tab only — see app.js), is the
 * PRE-EXISTING "click map to preview a tracked location's conditions" flow
 * (onLocationMapClickForPreview). When present, a click has to ASK which of
 * the two the person actually meant rather than guessing, since both are
 * now genuinely plausible reasons to click empty water — see
 * showMapClickChoiceDialog. The Live tab passes null here: it never had a
 * "preview a location" click feature to begin with, so there's no ambiguity
 * to resolve and a click goes straight to starting a new mark.
 *
 * `defaults`, if given, is passed straight through to startNewMarkEntry —
 * only the Live tab's "You are here" click (live.js) actually supplies one
 * (see computeQuickMarkDefaults); a plain click through this same function
 * always starts blank.
 *
 * Marks are gated behind Admin sign-in everywhere else on this site (see
 * loadAndRenderMarks) — without it, "add a mark" isn't a real option to
 * offer, so a click just falls back to whatever this map's plain-click
 * behaviour was before marks existed (the Location tab's preview, or
 * nothing at all on Live).
 */
async function handleMapClickForMarks(map, lat, lng, state, onLocationPreviewClick, defaults = {}) {
  // REAL BUG, FOUND AND FIXED: a Ctrl+drag box-select (initMarkSelectionBoxDrag)
  // disables the map's own dragging for the duration of the drag, so Leaflet
  // never registers the mouse movement as an actual "drag" in its own
  // right — with no drag handler to attribute it to, it fell back to firing
  // a plain "click" on mouseup regardless of how much the mouse had actually
  // moved, landing right here and popping up "What's here?" immediately
  // after finishing a selection. initMarkSelectionBoxDrag's own mouseup
  // handler sets this flag the moment a real box (not a tiny, click-like
  // movement it already ignores) completes; checking and clearing it here,
  // before anything else, is what stops that same drag's own tail end from
  // being treated as a second, unrelated click.
  if (state._justFinishedBoxSelect) {
    state._justFinishedBoxSelect = false;
    return;
  }
  if (!cachedIsAdmin) {
    if (onLocationPreviewClick) onLocationPreviewClick(lat, lng);
    return;
  }
  if (onLocationPreviewClick) {
    const choice = await showMapClickChoiceDialog();
    if (choice === "graph") {
      onLocationPreviewClick(lat, lng);
      return;
    }
    if (choice !== "mark") return; // cancelled
  }
  startNewMarkEntry(map, lat, lng, state, defaults);
}

