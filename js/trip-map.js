// Trips on the Map (Normal mode, signed-in only): a Trips panel lists your trip-log runs grouped by the tracked location they started
// nearest to, and each ticked trip is drawn from the trip log as a line (the phone's GPS track when it has one, else the log's own
// positions) with pins for its start, end, action starts and changes. Catches are NOT drawn here — they stay ordinary marks.
//
// Trips live in their own layer group, outside the mark cluster group, so they never take part in clustering. Pins that land within a
// few pixels of each other are fanned out on a ring (with a leader line back to the true spot) instead of overlaying each other.
// A trip's location is worked out on the fly from its first logged position (`startLat`/`startLng` of GET /api/triplog?list=1);
// nothing is stored. Which trips are ticked is a per-device preference (not synced).
// Pure helpers are at the top (unit-tested: tests/trip-map.test.mjs); the DOM / Leaflet part follows.
// Loaded by conditions.html only, after mark-lookup.js (nearest-location lookup) and trip-log-view.js (labels).

const TRIP_MAP_MAX_LOCATION_M = 5000; // a trip that started further than this from every tracked location is filed under "Other"
const TRIP_MAP_OTHER = "Other";
const TRIP_MAP_COLOURS = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#65a30d"];
const TRIP_MAP_VISIBLE_KEY = "goodConditionsVisibleTrips";

/** Name of the tracked location nearest to (lat, lng) within maxM metres, else null. `locations` = [{name, lat, lng}], variants of one place share a name. */
function tripMapNearestLocationName(lat, lng, locations, maxM) {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  let best = null;
  let bestDist = Infinity;
  for (const loc of locations || []) {
    if (typeof loc.lat !== "number" || typeof loc.lng !== "number") continue;
    const d = distanceMetersBetween(lat, lng, loc.lat, loc.lng);
    if (d < bestDist) {
      bestDist = d;
      best = loc;
    }
  }
  if (!best || bestDist > (maxM == null ? TRIP_MAP_MAX_LOCATION_M : maxM)) return null;
  return best.name;
}

/** Runs (newest first, as the Worker sends them) -> [{name, runs}] — named locations A-Z, "Other" last. */
function tripMapGroupRuns(runs, locations) {
  const groups = new Map();
  for (const run of runs || []) {
    const name = tripMapNearestLocationName(run.startLat, run.startLng, locations, TRIP_MAP_MAX_LOCATION_M) || TRIP_MAP_OTHER;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(run);
  }
  return [...groups.entries()]
    .map(([name, list]) => ({ name, runs: list }))
    .sort((a, b) => (a.name === TRIP_MAP_OTHER) - (b.name === TRIP_MAP_OTHER) || a.name.localeCompare(b.name));
}

/** Douglas-Peucker on [[lat, lng], ...] with a tolerance in metres; always keeps the first and last point. */
function tripMapSimplify(points, tolM) {
  if (!points || points.length < 3) return points ? points.slice() : [];
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const lat0 = points[0][0];
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const xy = points.map((p) => [p[1] * kx, p[0] * 110540]);
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let far = -1;
    let farD = tolM;
    const [ax, ay] = xy[lo];
    const [bx, by] = xy[hi];
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
    for (let i = lo + 1; i < hi; i++) {
      const [px, py] = xy[i];
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2));
      const d = Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = true;
      stack.push([lo, far], [far, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** The line to draw for a trip: the GPS track ([{lat, lng}], oldest first) when it has 2+ points, else the log entries' own positions. */
function tripMapPath(track, entries) {
  const pick = (list) => (list || []).filter((p) => typeof p.lat === "number" && typeof p.lng === "number").map((p) => [p.lat, p.lng]);
  const fromTrack = pick(track);
  if (fromTrack.length >= 2) return { points: fromTrack, source: "track" };
  return { points: pick(entries), source: "log" };
}

const TRIP_MAP_PIN_TYPES = { trip_start: "S", trip_end: "E", action_start: "A", change: "C", catch: "F" };

/** The pins to draw for a trip's log lines that carry a position: start, end, action starts, changes and catches (kind "F", drawn with the catch's own mark shape inside). A change keeps the line it changed from (`prev`: the last action start / change before it) so its hover can say what changed. */
function tripMapPins(entries) {
  const pins = [];
  let state = null;
  for (const e of entries || []) {
    const kind = TRIP_MAP_PIN_TYPES[e.type];
    if (kind && typeof e.lat === "number" && typeof e.lng === "number") pins.push({ kind, lat: e.lat, lng: e.lng, ts: e.ts, entry: e, prev: e.type === "change" ? state : null });
    if (e.type === "action_start" || e.type === "change") state = e;
  }
  return pins;
}

/** What a Change line changed, one text line each, by comparing it with `prev` (the line whose state it replaced): "Water: Clear → Murky", "Depth: 2 → 3 m", "Rod setups: added X · removed Y", "Action: A → B". */
function tripMapChangeLines(e, prev) {
  const lines = [];
  const p = prev || {};
  const show = (v) => (v == null || v === "" ? "none" : v);
  if (prev && (e.actionName || null) !== (p.actionName || null)) lines.push(`Action: ${show(p.actionName)} → ${show(e.actionName)}`);
  if (prev && (e.waterCondition || null) !== (p.waterCondition || null)) lines.push(`Water: ${show(p.waterCondition)} → ${show(e.waterCondition)}`);
  if (prev && (e.waterDepth ?? null) !== (p.waterDepth ?? null)) {
    lines.push(`Depth: ${p.waterDepth != null ? p.waterDepth : "none"} → ${e.waterDepth != null ? `${e.waterDepth} m` : "none"}`);
  }
  const gear = (x) => (x.rods || []).map(tripLogGearLine);
  const now = gear(e);
  const was = gear(p);
  const added = now.filter((g) => !was.includes(g));
  const removed = was.filter((g) => !now.includes(g));
  if (prev && (added.length || removed.length)) lines.push(`Rod setups: ${[added.length ? `added ${added.join("; ")}` : "", removed.length ? `removed ${removed.join("; ")}` : ""].filter(Boolean).join(" · ")}`);
  if (!lines.length) {
    // nothing earlier to compare with: say what it is now
    const now2 = e.changeField === "water" ? e.waterCondition : e.changeField === "depth" ? (e.waterDepth != null ? `${e.waterDepth} m` : "") : e.changeField === "water+depth" ? tripLogWaterText(e) : e.changeField === "rod_setups" ? gear(e).join("; ") : e.changeField === "action" ? e.actionName : "";
    lines.push(`${TRIP_LOG_CHANGE_LABELS[e.changeField] || e.changeField || "Settings"} changed${now2 ? ` to ${now2}` : ""}`);
  }
  return lines;
}

/** Inline SVG (16x16 box) of a mark shape name (circle, diamond, square, triangle, cross) — the catch pin's inner mark. */
function tripMapShapeSvg(shape, fill) {
  const body = {
    diamond: `<polygon points="8,1.5 14.5,8 8,14.5 1.5,8"/>`,
    square: `<rect x="2.5" y="2.5" width="11" height="11"/>`,
    triangle: `<polygon points="8,2 14.5,13.5 1.5,13.5"/>`,
    cross: `<path d="M6.3 1.5h3.4v4.8h4.8v3.4H9.7v4.8H6.3V9.7H1.5V6.3h4.8z"/>`,
  }[shape] || `<circle cx="8" cy="8" r="5.5"/>`;
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="${fill}" stroke="#fff" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** Groups items [{x, y}] (screen pixels) that sit within eps px of a group's first item. Returns arrays of indexes; every item is in exactly one group. */
function tripMapGroupByDistance(items, eps) {
  const groups = [];
  items.forEach((it, i) => {
    const g = groups.find((grp) => Math.hypot(items[grp[0]].x - it.x, items[grp[0]].y - it.y) <= eps);
    if (g) g.push(i);
    else groups.push([i]);
  });
  return groups;
}

/** [dx, dy] pixel offsets that spread n pins evenly round a ring wide enough that they don't touch (pinPx apart). */
function tripMapRingOffsets(n, pinPx) {
  if (n <= 1) return [[0, 0]];
  const radius = Math.max(pinPx * 1.1, (n * pinPx * 1.15) / (2 * Math.PI));
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return [Math.cos(a) * radius, Math.sin(a) * radius];
  });
}

/** A stable colour for a run (same trip, same colour every visit). */
function tripMapColour(runId) {
  let h = 0;
  for (const ch of String(runId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TRIP_MAP_COLOURS[h % TRIP_MAP_COLOURS.length];
}

// --- Leaflet / DOM part ------------------------------------------------------------------------------------------------

const tripMapState = { map: null, layer: null, runs: [], groups: [], locations: [], visible: new Set(), data: new Map(), loading: new Set(), focus: null, token: 0 };
const TRIP_MAP_PIN_PX = 20;

function tripMapLoadVisible() {
  try {
    const raw = JSON.parse(localStorage.getItem(TRIP_MAP_VISIBLE_KEY) || "[]");
    return new Set(Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function tripMapSaveVisible() {
  try {
    localStorage.setItem(TRIP_MAP_VISIBLE_KEY, JSON.stringify([...tripMapState.visible]));
  } catch {
    // device-local convenience only
  }
}

/** Called each time the Normal-mode map is (re)built (app.js). */
async function initTripMap(map) {
  tripMapTeardown();
  if (!cachedIsSignedIn || !map) return;
  const token = ++tripMapState.token;
  tripMapState.map = map;
  tripMapState.layer = L.layerGroup().addTo(map);
  tripMapState.visible = tripMapLoadVisible();
  map.on("zoomend", tripMapRedraw);
  const btn = document.getElementById("tripMapBtn");
  if (btn) {
    btn.style.display = "";
    btn.onclick = () => tripMapTogglePanel();
  }
  try {
    const [res, locations] = await Promise.all([
      fetch(`${USER_BACKEND_URL}/api/triplog?list=1&_=${Date.now()}`, { cache: "no-store", credentials: "include" }),
      loadTrackedLocationsForLookup(),
    ]);
    if (token !== tripMapState.token) return; // the map was rebuilt or left meanwhile
    if (!res.ok) return;
    tripMapState.runs = await res.json();
    const seen = new Set();
    tripMapState.locations = (locations || []).filter((l) => (seen.has(l.name) ? false : seen.add(l.name)));
    tripMapState.groups = tripMapGroupRuns(tripMapState.runs, tripMapState.locations);
    const known = new Set(tripMapState.runs.map((r) => r.runId));
    tripMapState.visible = new Set([...tripMapState.visible].filter((id) => known.has(id)));
    tripMapRenderLists();
    await Promise.all([...tripMapState.visible].map((id) => tripMapEnsureData(id)));
    if (token === tripMapState.token) tripMapRedraw();
  } catch (err) {
    console.error("Could not load trips for the map:", err);
  }
}

/** Leaving Normal mode / rebuilding the map. */
function tripMapTeardown() {
  const s = tripMapState;
  s.token++;
  if (s.map) s.map.off("zoomend", tripMapRedraw);
  if (s.layer && s.map) s.map.removeLayer(s.layer);
  s.map = s.layer = null;
  const btn = document.getElementById("tripMapBtn");
  if (btn) btn.style.display = "none";
  const panel = document.getElementById("tripMapPanel");
  if (panel) panel.style.display = "none";
}

/** Fetches (once) a trip's log lines and GPS track. */
async function tripMapEnsureData(runId) {
  const s = tripMapState;
  if (s.data.has(runId) || s.loading.has(runId)) return;
  const run = s.runs.find((r) => r.runId === runId);
  if (!run) return;
  s.loading.add(runId);
  try {
    const endTs = Math.min(run.endTs, run.startTs + 31 * 86400000);
    const [logRes, trackRes] = await Promise.all([
      fetch(`${USER_BACKEND_URL}/api/triplog?runId=${encodeURIComponent(runId)}`, { cache: "no-store", credentials: "include" }),
      fetch(`${USER_BACKEND_URL}/api/controller/track?from=${Math.floor(run.startTs / 1000) - 60}&to=${Math.ceil(endTs / 1000) + 60}`, { cache: "no-store", credentials: "include" }),
    ]);
    const entries = logRes.ok ? (await logRes.json()).entries || [] : [];
    const track = trackRes.ok ? await trackRes.json() : [];
    s.data.set(runId, { entries, track });
  } catch (err) {
    console.error("Could not load trip", runId, err);
  } finally {
    s.loading.delete(runId);
  }
}

/** The mark a catch pin shows inside its circle: the linked Catch mark when it is loaded, else a Catch of that species, styled and shaped as the Map would. */
function tripMapCatchMark(entry) {
  const st = typeof currentMarkLayerState === "object" ? currentMarkLayerState : null;
  if (!st || !st.marksById) return { shape: "cross", fill: "#ffffff" };
  const mark = (entry.markId && st.marksById.get(entry.markId)) || { type: "Catch", species: entry.species || "" };
  return { shape: shapeNameForMark(mark, st.markLists), fill: markStyleFor(mark, st).fillColor };
}

function tripMapPinIcon(pin, colour) {
  const size = pin.kind === "F" ? TRIP_MAP_PIN_PX + 4 : TRIP_MAP_PIN_PX;
  let inner = pin.kind;
  if (pin.kind === "F") {
    const m = tripMapCatchMark(pin.entry);
    inner = tripMapShapeSvg(m.shape, m.fill);
  }
  return L.divIcon({
    className: "trip-pin-wrap",
    html: `<span class="trip-pin trip-pin-${pin.kind}" style="--trip-c:${colour};width:${size}px;height:${size}px">${inner}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/** Hover text: the event, its time and action; a Change says what changed, a Catch what was caught. */
function tripMapPinTooltip(run, pin) {
  const e = pin.entry;
  const when = String(e.dateTime || "").slice(11, 16);
  const head = `<strong>${escapeHtml(tripLogEventLabel(e))}</strong> ${escapeHtml(when)}`;
  const extra = e.type === "change" ? tripMapChangeLines(e, pin.prev) : e.type === "catch" ? [tripLogCatchText(e)] : [];
  const lines = [e.actionName ? escapeHtml(e.actionName) : "", ...extra.filter(Boolean).map(escapeHtml)].filter(Boolean);
  return head + lines.map((l) => `<br>${l}`).join("");
}

function tripMapPinPopup(run, pin) {
  return `<strong>${escapeHtml(run.tripName || "Trip")}</strong><br>${escapeHtml(tripLogDateLabel(run.startDateTime))}<br>${tripMapPinTooltip(run, pin)}` +
    `<br><a href="triplogs.html#run=${encodeURIComponent(run.runId)}">Open trip log</a>`;
}

/** Clears and redraws every ticked trip (also on zoom: the pin fan-out is in screen pixels, and when the marks finish loading: a catch pin wears its mark). */
function tripMapRedraw() {
  const s = tripMapState;
  if (!s.map || !s.layer) return;
  s.layer.clearLayers();
  const pins = [];
  for (const runId of s.visible) {
    const run = s.runs.find((r) => r.runId === runId);
    const data = s.data.get(runId);
    if (!run || !data) continue;
    const colour = tripMapColour(runId);
    const path = tripMapPath(data.track, data.entries);
    if (path.points.length >= 2) {
      L.polyline(tripMapSimplify(path.points, 4), { color: colour, weight: 3, opacity: 0.85, dashArray: path.source === "track" ? null : "6 5", interactive: false }).addTo(s.layer);
    }
    for (const pin of tripMapPins(data.entries)) pins.push({ ...pin, run, colour });
  }
  if (pins.length === 0) return;
  const pts = pins.map((p) => s.map.latLngToLayerPoint([p.lat, p.lng]));
  for (const group of tripMapGroupByDistance(pts, TRIP_MAP_PIN_PX * 0.7)) {
    const offsets = tripMapRingOffsets(group.length, TRIP_MAP_PIN_PX);
    // earliest first, so the ring reads clockwise in time order
    group.sort((a, b) => pins[a].ts - pins[b].ts);
    group.forEach((idx, k) => {
      const pin = pins[idx];
      const at = group.length > 1 ? s.map.layerPointToLatLng(L.point(pts[group[0]].x + offsets[k][0], pts[group[0]].y + offsets[k][1])) : L.latLng(pin.lat, pin.lng);
      if (group.length > 1) L.polyline([[pin.lat, pin.lng], at], { color: "#6b7280", weight: 1, opacity: 0.8, interactive: false }).addTo(s.layer);
      L.marker(at, { icon: tripMapPinIcon(pin, pin.colour), keyboard: false, zIndexOffset: 500 }).bindTooltip(tripMapPinTooltip(pin.run, pin), { direction: "top", offset: [0, -10] }).bindPopup(tripMapPinPopup(pin.run, pin)).addTo(s.layer);
    });
  }
}

function tripMapFitTrip(runId) {
  const s = tripMapState;
  const data = s.data.get(runId);
  if (!s.map || !data) return;
  const path = tripMapPath(data.track, data.entries);
  if (path.points.length) s.map.fitBounds(L.latLngBounds(path.points), { padding: [40, 40], maxZoom: 16 });
}

async function tripMapSetVisible(runIds, on, fit) {
  const s = tripMapState;
  for (const id of runIds) (on ? s.visible.add(id) : s.visible.delete(id));
  tripMapSaveVisible();
  tripMapRenderLists();
  if (on) await Promise.all(runIds.map((id) => tripMapEnsureData(id)));
  tripMapRedraw();
  if (on && fit && runIds.length === 1) tripMapFitTrip(runIds[0]);
}

// --- Lists (the toolbar panel and the location panel share one renderer) ---------------------------------------------------

function tripMapRunRow(run) {
  const on = tripMapState.visible.has(run.runId);
  const dur = run.endTs > run.startTs ? tripLogFormatDuration(run.endTs - run.startTs) : "";
  const bits = [tripLogDateLabel(run.startDateTime), run.tripName || "Trip", dur, run.catches ? `${run.catches} catch${run.catches === 1 ? "" : "es"}` : ""].filter(Boolean);
  return `<label class="trip-map-row"><input type="checkbox" data-trip-run="${escapeHtml(run.runId)}"${on ? " checked" : ""}>` +
    `<span class="trip-map-swatch" style="background:${tripMapColour(run.runId)}"></span><span class="trip-map-row-text">${bits.map(escapeHtml).join(" · ")}</span>` +
    `<a class="trip-map-log-link" href="triplogs.html#run=${encodeURIComponent(run.runId)}" title="Open this trip's log">log</a></label>`;
}

/** The location's display name when it has one. */
function tripMapLabel(name) {
  const loc = tripMapState.locations.find((l) => l.name === name);
  return (loc && loc.displayName) || name;
}

function tripMapGroupHtml(group, open) {
  const ids = group.runs.map((r) => r.runId);
  return `<details class="trip-map-group"${open ? " open" : ""}><summary>${escapeHtml(tripMapLabel(group.name))} <span class="trip-map-count">(${group.runs.length})</span></summary>` +
    `<div class="trip-map-group-actions"><button type="button" class="btn-secondary" data-trip-all="${escapeHtml(ids.join(","))}">Show all</button><button type="button" class="btn-secondary" data-trip-none="${escapeHtml(ids.join(","))}">Hide all</button></div>` +
    group.runs.map(tripMapRunRow).join("") + `</details>`;
}

function tripMapWireList(container) {
  container.querySelectorAll("input[data-trip-run]").forEach((cb) => {
    cb.onchange = () => tripMapSetVisible([cb.dataset.tripRun], cb.checked, true);
  });
  container.querySelectorAll("button[data-trip-all]").forEach((b) => (b.onclick = () => tripMapSetVisible(b.dataset.tripAll.split(","), true, false)));
  container.querySelectorAll("button[data-trip-none]").forEach((b) => (b.onclick = () => tripMapSetVisible(b.dataset.tripNone.split(","), false, false)));
}

/** Re-renders both lists: the toolbar panel (every location) and the location panel's own section (the selected location only). */
function tripMapRenderLists() {
  const s = tripMapState;
  const panelBody = document.getElementById("tripMapPanelBody");
  if (panelBody) {
    panelBody.innerHTML = s.groups.length ? s.groups.map((g) => tripMapGroupHtml(g, s.focus === g.name)).join("") : `<p class="footnote">No trips logged yet.</p>`;
    tripMapWireList(panelBody);
  }
  const hover = document.getElementById("hoverPanelTrips");
  if (hover) {
    const group = s.focus ? s.groups.find((g) => g.name === s.focus) : null;
    hover.style.display = group ? "" : "none";
    hover.innerHTML = group ? tripMapGroupHtml(group, false) : "";
    if (group) tripMapWireList(hover);
  }
}

/** The location panel opened for `locationName` (display name or name): lists its trips there. */
function tripMapFocusLocation(locationName) {
  tripMapState.focus = locationName || null;
  tripMapRenderLists();
}

function tripMapTogglePanel() {
  const panel = document.getElementById("tripMapPanel");
  if (!panel) return;
  const show = panel.style.display === "none" || !panel.style.display;
  panel.style.display = show ? "block" : "none";
  const btn = document.getElementById("tripMapBtn");
  if (btn) btn.setAttribute("aria-pressed", show ? "true" : "false");
}
