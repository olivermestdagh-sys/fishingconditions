// marks-layer.js
// Fishing marks, part 2: the marker shapes, loading marks from the worker and drawing them on the map (clustering, session lines, cluster hover tooltip).
// One of the shared scripts split out of the old charts.js. All of them share one global scope; each page loads
// only the ones it needs, in this order (checked by scripts/check-page-scripts.mjs).

/**
 * Loads marks (D1, Public's own rows, via GET /api/public/marks) and
 * config/mark_lists.json's live equivalent (GET /api/public/marklists,
 * for the edit form's dropdown options) and plots every mark on an
 * already-created Leaflet map, each one clickable into a view/edit popup
 * (see buildMarkPopupViewHtml/buildMarkPopupEditHtml above).
 *
 * Gated behind cachedIsAdmin (refreshAdminStatus, above) — the SAME
 * Admin-session flag "Add as permanent location" (app.js) already uses,
 * not a new or separate check. IMPORTANT CAVEAT, worth understanding
 * clearly, carried over unchanged from when this gated on a GitHub
 * connection instead: this only gates whether the JS chooses to RENDER
 * the data — it does not, and genuinely cannot from a static site with no
 * server of its own, restrict who can fetch this data. GET
 * /api/public/marks is deliberately unauthenticated (see its own comment,
 * user-backend.js) — anyone who knows or guesses the endpoint can still
 * fetch it directly, signed in or not. This is a "don't clutter the map
 * with a couple thousand personal points for random visitors" gate, not
 * genuine access control — there never was a way to build one here. If
 * these points need to be genuinely private, they can't be reachable by
 * an unauthenticated endpoint at all, which is a bigger redesign than
 * this migration.
 *
 * Rendered as Leaflet circleMarkers (or the diamond/cross classes built
 * by getDiamondMarkerClass/getCrossMarkerClass above), one
 * shape per Mark Type, matching the same shape convention the Lowrance
 * GPX export uses — see gpxSymForMark, sync.js) on a dedicated canvas
 * renderer (L.canvas()),
 * deliberately NOT the custom SVG divIcon pins (buildMapPinDivIcon) used
 * for tracked fishing LOCATIONS elsewhere on this same map. At this data's
 * actual scale (a couple thousand points from the GPX migration alone, and
 * growing), building and painting that many individual HTML/SVG elements
 * would be meaningfully heavier than Leaflet's own canvas-rendered vector
 * shapes, which are built for exactly this point count — confirmed
 * directly: the full real dataset (2,532 marks) loads and shapes in well
 * under half a second.
 *
 * `state` (see createMarkLayerState) is created by the CALLER, before this
 * resolves, and populated here rather than owned locally — the caller wires
 * its own map-click handler (handleMapClickForMarks, for starting a brand
 * new mark) at map-creation time, before this async load has necessarily
 * finished, and that handler needs somewhere to find markLists/marksById/
 * markersById once they're ready without an awkward second callback. One
 * `state` per map/page load, not shared globally — Location and Live are
 * separate page loads with their own Leaflet map instance, so each gets its
 * own independent copy with no risk of one page's edits leaking into the
 * other's in-memory state before a reload.
 */
/**
 * Two small Leaflet vector-layer subclasses that behave exactly like
 * L.CircleMarker — same "radius defined in pixels, stays a constant
 * screen size regardless of zoom" behaviour, same click/tooltip/popup
 * API, same circular hit-testing for clicks (L.CircleMarker's own
 * _containsPoint, inherited unchanged — close enough at a marker this
 * small, and if anything more forgiving for a Cross shape's empty
 * corners) — but paint a SQUARE or CROSS instead of a circle.
 *
 * Exists so marks on THIS site's own map use the same shape-per-Mark-Type
 * convention as the Lowrance GPX export (see gpxSymForMark, sync.js:
 * POI -> circle, Mark -> square, Catch -> cross) for real visual
 * consistency between the two, not just "both draw dots in roughly the
 * same colour".
 *
 * Colour itself deliberately stays exactly as it already was (see
 * markStyleFor below) — the site's own richer per-species palette, NOT
 * reduced to Lowrance's 7-colour set the way the GPX export's colours
 * are. That reduction only matters for the device's own real hardware
 * limitation; checked directly against real data while building the GPX
 * export, several distinct species with no individually-configured
 * colour already collapse onto the same "blue" fallback once
 * nearest-matched to 7 colours (Snook/Scallops/Trevally/Leather Jacket/
 * Elephant Fish/Wrasse/Garfish/Port Jackson Shark, specifically) — fine
 * for a device that has no way around the limit, but applying that same
 * reduction here would make this map meaningfully worse at telling
 * species apart at a glance for no reason, since this map doesn't share
 * that constraint.
 *
 * ONLY ever created via createMarkShapeLayer below, on the SAME shared
 * Canvas renderer every mark on a given map uses (see
 * state.canvasRenderer) — both this class's own _updatePath (which calls
 * the Canvas renderer's _updatePoly, the same method L.Polygon/L.Polyline
 * use internally) and CircleMarker's default _updatePath (which calls the
 * renderer's _updateCircle) exist ONLY on L.Canvas, not L.SVG — Leaflet's
 * OTHER built-in renderer, which is actually the map's own DEFAULT unless
 * a layer is explicitly told to use L.canvas() the way this site's marks
 * layer always deliberately is (see loadAndRenderMarks's own comment on
 * why marks use canvas specifically). Creating one of these shapes
 * without an explicit canvas renderer would throw once Leaflet tried to
 * actually draw it.
 *
 * BUILT LAZILY (see getDiamondMarkerClass/getCrossMarkerClass below), NOT
 * as plain top-level `const X = L.CircleMarker.extend(...)` the way an
 * earlier version of this had them — that unconditionally touched the
 * Leaflet global the instant charts.js itself was evaluated, which broke
 * outright on any page that loads charts.js without ever loading Leaflet
 * at all. index.html (Week Ahead) is exactly that page — no map, so no
 * `<script src=".../leaflet.js">` tag — and "L is not defined" throwing
 * at module-scope aborts the ENTIRE script, not just the one function
 * that needed it: every other shared function/constant in this file never
 * got defined either, which is what actually broke Week Ahead completely
 * (and looked like unrelated symptoms — filters "not responding" was
 * just as much a casualty, on that same broken page, of the same crash,
 * not a second bug). Deferring the `.extend()` call until a shape is
 * actually first requested — which only ever happens from a page that DID
 * load Leaflet, since that's the only kind of page with a map to put a
 * mark on in the first place — means charts.js itself never touches `L`
 * just by being loaded.
 */
let _diamondMarkerClass = null;
function getDiamondMarkerClass() {
  if (!_diamondMarkerClass) {
    _diamondMarkerClass = L.CircleMarker.extend({
      _project() {
        L.CircleMarker.prototype._project.call(this);
        if (!this._point) return;
        const p = this._point;
        const r = this._radius;
        this._parts = [[
          L.point(p.x, p.y - r),
          L.point(p.x + r, p.y),
          L.point(p.x, p.y + r),
          L.point(p.x - r, p.y),
        ]];
      },
      _updatePath() {
        this._renderer._updatePoly(this, true);
      },
    });
  }
  return _diamondMarkerClass;
}

/**
 * A "+" shape (not a diagonal "x") — reads more clearly at this marker's
 * actual on-screen size (a handful of pixels) than a thin diagonal cross
 * would once anti-aliased down that small. Built as one 12-point closed
 * outline (a plus-sign silhouette) rather than two separate crossing
 * strokes, so it still fills/strokes as a single shape the same way
 * getDiamondMarkerClass's diamond and the inherited circle do. See
 * getDiamondMarkerClass's own comment just above for everything else (this
 * shares the identical lazy-creation approach and reasoning, just a
 * different pixel-space outline).
 */
let _crossMarkerClass = null;
function getCrossMarkerClass() {
  if (!_crossMarkerClass) {
    _crossMarkerClass = L.CircleMarker.extend({
      _project() {
        L.CircleMarker.prototype._project.call(this);
        if (!this._point) return;
        const p = this._point;
        const r = this._radius;
        const arm = r * 0.42; // half-thickness of each bar of the plus
        this._parts = [[
          L.point(p.x - arm, p.y - r), L.point(p.x + arm, p.y - r),
          L.point(p.x + arm, p.y - arm), L.point(p.x + r, p.y - arm),
          L.point(p.x + r, p.y + arm), L.point(p.x + arm, p.y + arm),
          L.point(p.x + arm, p.y + r), L.point(p.x - arm, p.y + r),
          L.point(p.x - arm, p.y + arm), L.point(p.x - r, p.y + arm),
          L.point(p.x - r, p.y - arm), L.point(p.x - arm, p.y - arm),
        ]];
      },
      _updatePath() {
        this._renderer._updatePoly(this, true);
      },
    });
  }
  return _crossMarkerClass;
}

// Real, confirmed shape/colour names — see gpxSymForMark's own header
// comment in sync.js for how these were finally nailed down (a real GPX
// export straight off Oliver's own HDS Live-7, after two earlier guesses
// that were each wrong in different ways). "square" here is deliberately
// NOT one of the three — what looked like a separate square on the unit
// turned out to already be this same "diamond" shape.
const LOWRANCE_SHAPE_GETTERS = { circle: () => L.CircleMarker, diamond: getDiamondMarkerClass, cross: getCrossMarkerClass };

// Fallback shape per Mark Type, used ONLY when neither the mark's species
// NOR its own Type has a Mark Shape Format assigned at all (see
// resolveMarkShapeFormat/shapeNameForMark below) — matches this site's
// original hardcoded behaviour from before Mark Formats existed, so a repo
// that hasn't touched any of this yet looks exactly as it always has.
// Mark (or any type not listed here at all — including a genuinely new
// Mark Type someone adds later) intentionally has NO entry, falling
// through to plain "circle" — matches gpxSymForMark's own default.
const MARK_TYPE_DEFAULT_SHAPE_NAME = { POI: "diamond", Catch: "cross", Fish: "cross" };

/**
 * Resolves the Mark SHAPE Format (config/mark_lists.json's field: "Mark
 * Shape Format" entries — see the "Fishing Mark Lists" section,
 * locationsadmin.js) that applies to a given mark, if any. Species' own
 * assignment wins over its Mark Type's when BOTH are set (species is the
 * more specific signal, same reasoning as resolveMarkColorFormat below),
 * but Oliver's own explicit call here is that a species normally has NO
 * shape of its own at all — shape is meant to keep coming from Mark Type
 * day to day (so a Catch still reads as a cross and a Mark still reads as
 * a circle, regardless of species), with a species-level shape being a
 * deliberate override for that one species specifically, the exception
 * rather than the everyday case. Returns null if neither has one
 * assigned — shapeNameForMark below falls back to
 * MARK_TYPE_DEFAULT_SHAPE_NAME in that case, same as before Mark Shape
 * Formats existed.
 */
function resolveMarkShapeFormat(mark, markLists) {
  const lists = markLists || [];
  if (mark.species) {
    const speciesEntry = lists.find((r) => r.field === "Species" && r.value === mark.species);
    if (speciesEntry && speciesEntry.shapeFormat) {
      const format = lists.find((r) => r.field === "Mark Shape Format" && r.value === speciesEntry.shapeFormat);
      if (format) return format;
    }
  }
  const typeEntry = lists.find((r) => r.field === "Mark Type" && r.value === mark.type);
  if (typeEntry && typeEntry.shapeFormat) {
    const format = lists.find((r) => r.field === "Mark Shape Format" && r.value === typeEntry.shapeFormat);
    if (format) return format;
  }
  return null;
}

/**
 * Resolves the Mark COLOUR Format (field: "Mark Colour Format") that
 * applies to a given mark, if any — same species-wins-over-type priority
 * as resolveMarkShapeFormat above, but for colour this genuinely IS meant
 * to be the everyday case: colour varying by species, shape staying true
 * to Mark Type, is exactly the split Oliver asked for. Mark Type's own
 * colour assignment is still the fallback (mainly relevant for POI, which
 * has no species to carry a colour of its own at all, or any species that
 * hasn't been given one yet). Returns null if neither is assigned —
 * markStyleFor's own hex-or-hash and gpxSymForMark's own plain default in
 * sync.js fall back in that case, same as before Mark Colour Formats
 * existed.
 */
function resolveMarkColorFormat(mark, markLists) {
  const lists = markLists || [];
  if (mark.species) {
    const speciesEntry = lists.find((r) => r.field === "Species" && r.value === mark.species);
    if (speciesEntry && speciesEntry.colorFormat) {
      const format = lists.find((r) => r.field === "Mark Colour Format" && r.value === speciesEntry.colorFormat);
      if (format) return format;
    }
  }
  const typeEntry = lists.find((r) => r.field === "Mark Type" && r.value === mark.type);
  if (typeEntry && typeEntry.colorFormat) {
    const format = lists.find((r) => r.field === "Mark Colour Format" && r.value === typeEntry.colorFormat);
    if (format) return format;
  }
  return null;
}

/** Resolves whatever Mark Colour Format is assigned DIRECTLY to a single
 * field's own value — no species/type priority, since that relationship
 * is specific to those two fields (see resolveMarkColorFormat above for
 * that one). Used by markStyleFor for every OTHER field's own "colour by
 * X" map view (Weather Condition, Bait, ...), which can each carry a
 * Colour Format the same way Species/Mark Type can, just without a
 * second field to fall back to. */
function resolveColorFormatForFieldValue(fieldLabel, value, markLists) {
  const lists = markLists || [];
  const entry = lists.find((r) => r.field === fieldLabel && r.value === value);
  if (entry && entry.colorFormat) {
    return lists.find((r) => r.field === "Mark Colour Format" && r.value === entry.colorFormat) || null;
  }
  return null;
}

/** Whichever shape NAME applies to a given mark — its resolved Mark Shape
 * Format's own `icon` (see resolveMarkShapeFormat above) if one applies,
 * else the hardcoded per-Type default (MARK_TYPE_DEFAULT_SHAPE_NAME
 * above), same as before Mark Formats existed. `markLists` is whatever's
 * already loaded for this page (see state.markLists) — no separate fetch
 * here. */
function shapeNameForMark(mark, markLists) {
  const format = resolveMarkShapeFormat(mark, markLists);
  if (format && format.icon && LOWRANCE_SHAPE_GETTERS[format.icon]) return format.icon;
  return MARK_TYPE_DEFAULT_SHAPE_NAME[mark.type] || "circle";
}

/** Creates whichever shape layer matches a mark — see shapeNameForMark
 * just above for where that name actually comes from. Always pass a
 * Canvas renderer in `options.renderer` — see getDiamondMarkerClass's own
 * comment on why that's required, not optional, for anything but a plain
 * circle. Tags the returned instance with its own shape name
 * (`_markShapeName`) — cheap to read directly off the marker later rather
 * than re-deriving it, and specifically what createMarkClusterIcon reads
 * to build a cluster's satellite breakdown. Safe to tag once here and
 * never touch again: unlike colour (which setStyle can change later —
 * read that live off marker.options.fillColor instead, never tagged),
 * a mark's shape never changes in place; changing it means creating an
 * entirely new marker instance (see the "Type changed to a different
 * shape" case, wireMarkPopupButtons), so this tag can't go stale. */
function createMarkShapeLayer(latlng, mark, options, markLists) {
  const shapeName = shapeNameForMark(mark, markLists);
  const getShapeClass = LOWRANCE_SHAPE_GETTERS[shapeName];
  const ShapeClass = getShapeClass ? getShapeClass() : L.CircleMarker;
  const layer = new ShapeClass(latlng, options);
  layer._markShapeName = shapeName;
  return layer;
}

async function loadAndRenderMarks(map, state) {
  if (!cachedIsAdmin) return;

  let marks;
  try {
    const res = await fetch(`${MARKS_FILE_PATH}?_=${Date.now()}`, { cache: "no-store", credentials: "include" });
    if (!res.ok) return; // nothing to show yet, not an error
    marks = await res.json(); // bare array — see handlePublicMarks, user-backend.js
  } catch (err) {
    console.error("Could not load marks:", err);
    return;
  }

  // Best-effort — the edit form's dropdowns just fall back to "no options
  // besides the current value" if this fails, rather than blocking the
  // whole marks layer from rendering over a pick-list fetch problem.
  // fetchUnionedMarkLists (its own comment, above) merges in the signed-in
  // Admin's own personal marklist rows too, not just Public's.
  try {
    state.markLists = await fetchUnionedMarkLists();
  } catch (err) {
    console.error("Could not load mark lists (edit dropdowns will be limited):", err);
  }

  // Every mark marker lives inside this ONE cluster group, never added to
  // `map` directly — real-world mark counts (a couple thousand, all real
  // fishing spots) cluster heavily at anything but the closest zoom, and
  // without this, overlapping pins in the same popular spot would be
  // impossible to see or click individually. See createMarkClusterIcon
  // below for the numbered-circle styling, and zoomToShowLayer's use
  // throughout this file for how a SPECIFIC mark (e.g. one just added)
  // still gets reliably shown un-clustered when that's what's needed.
  // chunkedLoading spreads the initial add of a couple thousand markers
  // over several animation frames instead of doing it all in one go,
  // so the tab doesn't visibly freeze while this first render happens.
  state.markerLayer = L.markerClusterGroup({
    chunkedLoading: true,
    iconCreateFunction: createMarkClusterIcon,
    maxClusterRadius: 30, // px; plugin default is 80, which grouped marks too eagerly
    // No disableClusteringAtZoom here: tried at 16 and marks vanished on zoom-in
    // (this layer holds canvas CircleMarker/Path shapes, not plain L.Markers).
  });
  map.addLayer(state.markerLayer);

  // Hovering a cluster lists the marks inside it. Reuses each child's own
  // already-bound (and already-escaped) tooltip text, so it stays in step
  // with edits — see the unbindTooltip/bindTooltip calls on mark edits.
  const MAX_CLUSTER_TOOLTIP_ROWS = 15;
  state.markerLayer.on("clustermouseover", (e) => {
    const cluster = e.layer;
    const rows = cluster.getAllChildMarkers()
      .map((child) => child.getTooltip && child.getTooltip() && child.getTooltip().getContent())
      .filter(Boolean)
      .sort();
    const shown = rows.slice(0, MAX_CLUSTER_TOOLTIP_ROWS).map((r) => `<div>${r}</div>`).join("");
    const extra = rows.length > MAX_CLUSTER_TOOLTIP_ROWS ? `<div><em>+${rows.length - MAX_CLUSTER_TOOLTIP_ROWS} more</em></div>` : "";
    cluster.unbindTooltip();
    cluster.bindTooltip(shown + extra, { direction: "top", offset: [0, -14] }).openTooltip();
  });
  state.markerLayer.on("clustermouseout", (e) => e.layer.closeTooltip());

  const renderer = L.canvas({ padding: 0.5 });
  state.canvasRenderer = renderer; // reused by startNewMarkEntry below for a freshly-created mark, so every shape on this map — loaded or brand new — draws on the same Canvas renderer (see getDiamondMarkerClass/getCrossMarkerClass's own comment on why that's required)
  for (const mark of marks) {
    if (mark.lat == null || mark.lng == null) continue;
    const style = markStyleFor(mark, state);
    const marker = createMarkShapeLayer([mark.lat, mark.lng], mark, {
      renderer,
      radius: style.radius,
      color: style.color,
      weight: style.weight,
      fillColor: style.fillColor,
      fillOpacity: 0.85,
    }, state.markLists).addTo(state.markerLayer);
    marker.bindTooltip(markTooltipText(mark, state), { direction: "top" });
    marker.bindPopup(buildMarkPopupViewHtml(mark), { maxWidth: 260, autoPanPadding: [20, 20], className: "mark-popup-leaflet", autoPan: false });
    // Ctrl (or Cmd) turns a click into a selection toggle instead of the
    // normal open-the-popup behaviour.
    //
    // REAL BUG, FOUND AND FIXED: stopping propagation on the "click" event
    // alone isn't enough — mousedown always fires before click, and the
    // map's own box-select mousedown handler (initMarkSelectionBoxDrag,
    // below) doesn't know or care whether a mousedown landed on a marker
    // or on open water; it starts a drag either way once it sees Ctrl
    // held. Confirmed directly: without also stopping mousedown here, a
    // held-Ctrl click on a marker was silently swallowed by the box-select
    // logic (a near-zero-movement "drag" it correctly ignores) before this
    // handler's own "click" ever got a chance to fire at all — toggling
    // nothing. Stopping mousedown too prevents the box-select drag from
    // ever starting for a mousedown that began on a specific marker.
    marker._markId = mark.id; // O(1) lookup for cluster-level Ctrl+click (see initMarkSelectionBoxDrag's clustermousedown/clusterclick handlers) — getAllChildMarkers() returns marker objects, not ids
    marker.on("mousedown", (e) => {
      if (isSelectModifierKey(e.originalEvent)) L.DomEvent.stop(e);
    });
    marker.on("click", (e) => {
      if (!isSelectModifierKey(e.originalEvent)) return;
      L.DomEvent.stop(e);
      marker.closePopup();
      toggleMarkSelection(map, state, mark.id);
    });
    // Only fires the actual distance lookups the first time each mark's
    // popup is genuinely opened by a click — with a couple thousand marks
    // loaded, computing this eagerly for every single one regardless of
    // whether it's ever clicked would be wasted work at real scale.
    marker.on("popupopen", () => fillMarkPopupDistances(marker.getPopup().getElement(), mark));
    state.marksById.set(mark.id, mark);
    state.markersById.set(mark.id, marker);
  }

  /**
   * A cluster spiderfied open uses the SAME Canvas-rendered CircleMarkers
   * as everywhere else on this map — and that combination turned out to
   * be unreliable specifically during spiderfy, confirmed directly with
   * a real reproduction: a spiderfied marker could render with literally
   * zero size (no tooltip, unclickable), while the exact same setup
   * using SVG rendering never showed this, run after run. Reported
   * independently too — a session point consistently unusable at one
   * particular spiderfy leg position ("10 o'clock"), across different
   * clusters.
   *
   * Rather than switch every mark on the map to SVG (a real cost at a
   * couple thousand marks — Canvas exists here specifically for that
   * scale), a small SVG-rendered stand-in is drawn on top of each
   * marker for exactly as long as it's actually spiderfied open, always
   * — not just for whichever ones happen to fail at that moment, since
   * the failure wasn't reliably tied to one specific marker or
   * position, only to Canvas rendering during spiderfy in general. The
   * real marker underneath, and every other marker on the map, keeps
   * using Canvas exactly as before; this only ever affects the handful
   * of markers actually spiderfied open at any one moment. Clicking the
   * stand-in fires a real "click" on the ORIGINAL marker (not a
   * separate popup implementation) so Edit/Delete/etc. all keep working
   * completely unchanged, operating on the exact same marker and mark
   * object as ever.
   *
   * REAL BUG, FOUND AND FIXED (round two — the first attempt wasn't
   * enough): confirmed directly with a 3+ marker cluster (the first
   * fix was only ever tested with 2) that a leg close enough to the
   * cluster's own original centre stayed unclickable even with a
   * correctly-sized, correctly-positioned overlay sitting right there —
   * elementFromPoint at that exact point showed why: the cluster's own
   * icon (a plain HTML DIV, left in the DOM at the original centre
   * throughout the whole spiderfy — the faded circle visible in the
   * middle of a spiderfied cluster) lives in Leaflet's markerPane,
   * which sits ABOVE the plain overlayPane an SVG renderer uses by
   * default in Leaflet's own fixed pane ordering
   * (tilePane<overlayPane<shadowPane<markerPane<tooltipPane<popupPane).
   * bringToFront() only reorders layers WITHIN one pane, so it could
   * never have won against a different, higher pane regardless of when
   * or how often it was called. Fixed by giving the overlay its own
   * dedicated pane, explicitly created above markerPane (600) but
   * below tooltipPane (650) in Leaflet's own scheme — high enough to
   * always win against the cluster's own lingering icon, without
   * outranking an actual tooltip.
   */
  if (!map.getPane("spiderfyOverlayPane")) {
    map.createPane("spiderfyOverlayPane");
    map.getPane("spiderfyOverlayPane").style.zIndex = 625;
    map.getPane("spiderfyOverlayPane").style.pointerEvents = "none"; // the pane itself never needs to catch clicks — only the individual marker paths inside it do (Leaflet sets pointer-events back to "auto" per-path automatically)
  }
  state.spiderfyOverlayRenderer = L.svg({ pane: "spiderfyOverlayPane" });
  state.spiderfyOverlayLayer = L.layerGroup().addTo(map);
  state.markerLayer.on("spiderfied", (e) => {
    state.spiderfyOverlayLayer.clearLayers();
    for (const spiderfiedMarker of e.markers) {
      let markId = null;
      for (const [id, m] of state.markersById.entries()) {
        if (m === spiderfiedMarker) {
          markId = id;
          break;
        }
      }
      const mark = markId ? state.marksById.get(markId) : null;
      if (!mark) continue;
      const style = markStyleFor(mark, state);
      // REAL BUG, FOUND AND FIXED: this used to always be a plain
      // L.circleMarker, regardless of the mark's own real shape — so a
      // Catch's own "+" (getCrossMarkerClass) or a POI's own diamond
      // (getDiamondMarkerClass) got replaced with a plain filled circle
      // the instant its cluster spiderfied open, sitting opaquely on top
      // of (and hiding) the real Canvas-rendered shape still underneath
      // it. Reported directly, with a screenshot: a "+" visibly trapped
      // inside a circle. createMarkShapeLayer (used for every REAL
      // marker already, see loadAndRenderMarks below) already knows how
      // to pick the right shape class for a mark — reused directly here
      // instead of hardcoding circleMarker, with only the renderer
      // swapped to this overlay's own SVG one. getDiamondMarkerClass/
      // getCrossMarkerClass are built by overriding L.CircleMarker's own
      // _project/_updatePath — the same methods either renderer calls —
      // so they work identically under SVG, not just Canvas.
      const overlay = createMarkShapeLayer(spiderfiedMarker.getLatLng(), mark, {
        renderer: state.spiderfyOverlayRenderer,
        radius: style.radius,
        color: style.color,
        weight: style.weight,
        fillColor: style.fillColor,
        fillOpacity: 0.85,
      }, state.markLists).addTo(state.spiderfyOverlayLayer);
      overlay.bindTooltip(markTooltipText(mark, state), { direction: "top" });
      // stopPropagation is genuinely required, not just tidy — confirmed
      // directly: without it, this click bubbles up to the map, where
      // Leaflet.markercluster's own "clicked somewhere outside the
      // spiderfied set" handler treats it as exactly that (this overlay
      // is a separate layer of my own, not part of the cluster's own
      // recognized spiderfy legs) and immediately collapses the spiderfy
      // — which closes the popup this same click had just opened, one
      // event later. Net effect looked like the click did nothing at all.
      overlay.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        spiderfiedMarker.fire("click");
      });
    }
    // Added to `map` (not state.markerLayer, which is Canvas-only), so its
    // own SVG pane needs to be explicitly raised above the cluster group's
    // own Canvas pane — otherwise stacking order between the two falls out
    // of whichever happened to attach to the shared overlay pane first,
    // which isn't reliable enough to depend on for "is this actually
    // clickable" to hold every time.
    state.spiderfyOverlayLayer.eachLayer((l) => l.bringToFront());
  });
  state.markerLayer.on("unspiderfied", () => {
    state.spiderfyOverlayLayer.clearLayers();
  });

  // One delegated listener for the whole map rather than one per marker —
  // same reasoning as the canvas renderer above: with a couple thousand
  // points, a per-marker popupopen listener would trade away exactly the
  // performance headroom the canvas renderer was chosen to get back. Popup
  // content only exists in the DOM once a popup actually opens (up until
  // then it's just an HTML string Leaflet is holding onto), so buttons are
  // wired here, not up front — same pattern app.js's own map popups already
  // use for their own (different) buttons.
  map.on("popupopen", (e) => {
    const popupEl = e.popup.getElement();
    const root = popupEl.querySelector("[data-mark-id]");
    if (!root) return; // some other feature's popup, not one of ours
    // Move the popup's own DOM element into the fixed side panel, if this
    // page has one (#markDetailPanel — conditions.html/live.html; a page
    // without one just keeps Leaflet's normal floating popup untouched).
    // The SAME node, not a copy — every listener wireMarkPopupButtons is
    // about to attach (or already has, for a re-render) keeps working
    // exactly as before; only where it visually lives changes. Runs for
    // EVERY one of our mark popups, including a brand-new draft
    // (startNewMarkEntry) — that one never reaches state.marksById until
    // saved, so it has to be handled here, before the mark/marker lookup
    // below, rather than folded into the same guard.
    attachPopupToDetailPanel(e.popup, map, state);
    const mark = state.marksById.get(root.dataset.markId);
    const marker = state.markersById.get(root.dataset.markId);
    // A brand-new draft (see startNewMarkEntry) also has a data-mark-id but
    // isn't in state.marksById until saved — this handler correctly no-ops
    // for it; startNewMarkEntry wires that popup's buttons itself, directly.
    if (!mark || !marker) return;
    wireMarkPopupButtons(popupEl, marker, mark, state.markLists, { state, map });
    // Selecting either half of a Session highlights BOTH markers and the
    // line connecting them (highlightSessionPair) — Oliver's own call,
    // so a session reads as one thing at a glance rather than two
    // separate pins that happen to share a purple line somewhere nearby.
    if (mark.type === "Session" && mark.sessionGroupId) highlightSessionPair(map, state, mark.sessionGroupId);
  });
  map.on("popupclose", (e) => {
    const popupEl = e.popup.getElement();
    const root = popupEl.querySelector("[data-mark-id]");
    if (!root) return;
    detachDetailPanel();
    const mark = state.marksById.get(root.dataset.markId);
    if (mark && mark.type === "Session") clearSessionHighlight(map, state);
  });

  renderSessionLines(map, state, marks);

  initMarkControls(map, state);
  initMarkSelectionBoxDrag(map, state);
}

/**
 * Draws a connecting line between a Fishing Session's own Start and End
 * marks (type: "Session", linked by a shared sessionGroupId — see the
 * Sync page's own save flow, sync.js, for where these actually get
 * created). A Session is otherwise just an ordinary mark — same
 * cluster group, same popup, same Edit/Copy/Delete via the exact same
 * generic flow every other mark already uses (deleteMarkFromD1 is
 * keyed only by mark id, with no type-specific handling needed at all)
 * — this is the one piece that genuinely needed new code: two separate
 * markers don't imply a line between them on their own.
 *
 * Deliberately a separate, plain layer (not inside state.markerLayer)
 * — a session's own start/end can sit a real distance apart, and a
 * connecting line shouldn't be subject to marker clustering the way
 * the two endpoint markers themselves are.
 *
 * A group missing one side entirely (the other half was deleted, or
 * only one side was ever imported to begin with) simply draws no line
 * for that group — not an error, just nothing to connect.
 *
 * Whichever session is currently selected (state.highlightedSessionGroupId
 * — set/cleared by the popupopen/popupclose handlers in loadAndRenderMarks,
 * whenever a Session mark's own popup opens or closes) draws its line
 * noticeably thicker and fully opaque, so the pair a person just clicked
 * is obviously the one connected by it, not just "some purple line
 * somewhere nearby".
 */
function renderSessionLines(map, state, marks) {
  if (state.sessionLineLayer) {
    map.removeLayer(state.sessionLineLayer);
  }
  state.sessionLineLayer = L.layerGroup().addTo(map);

  const groups = new Map(); // sessionGroupId -> {start, end}
  for (const mark of marks) {
    if (mark.type !== "Session" || !mark.sessionGroupId || mark.lat == null || mark.lng == null) continue;
    const entry = groups.get(mark.sessionGroupId) || {};
    if (mark.sessionRole === "start" && !entry.start) entry.start = mark;
    else if (mark.sessionRole === "end" && !entry.end) entry.end = mark;
    groups.set(mark.sessionGroupId, entry);
  }

  for (const [groupId, { start, end }] of groups.entries()) {
    if (!start || !end) continue;
    const isHighlighted = groupId === state.highlightedSessionGroupId;
    L.polyline(
      [
        [start.lat, start.lng],
        [end.lat, end.lng],
      ],
      { color: "#7c3aed", weight: isHighlighted ? 6 : 3, opacity: isHighlighted ? 1 : 0.8, dashArray: isHighlighted ? null : "6 4" }
    ).addTo(state.sessionLineLayer);
  }
}

/** The highlight style applied to a Session's own pair of markers while
 * either one's popup is open — a plainly bigger, brighter ring, restored
 * back to markStyleFor's own normal style (clearSessionHighlight) the
 * moment the popup closes. */
function highlightSessionMarker(marker, mark, state) {
  const style = markStyleFor(mark, state);
  marker.setStyle({ radius: style.radius + 4, color: "#7c3aed", weight: 3, fillColor: style.fillColor });
}

/**
 * Called from loadAndRenderMarks' own popupopen handler whenever a
 * Session mark's popup opens — finds its own pair via sessionGroupId,
 * highlights both markers, and re-renders the session lines so the
 * pair's own connecting line draws with the same emphasis (see
 * renderSessionLines' own comment).
 */
function highlightSessionPair(map, state, groupId) {
  state.highlightedSessionGroupId = groupId;
  for (const [id, mark] of state.marksById.entries()) {
    if (mark.type === "Session" && mark.sessionGroupId === groupId) {
      const marker = state.markersById.get(id);
      if (marker) highlightSessionMarker(marker, mark, state);
    }
  }
  renderSessionLines(map, state, Array.from(state.marksById.values()));
}

/** Reverses highlightSessionPair — restores every Session marker's
 * normal style and redraws session lines with no highlight active. */
function clearSessionHighlight(map, state) {
  const groupId = state.highlightedSessionGroupId;
  state.highlightedSessionGroupId = null;
  if (!groupId) return;
  for (const [id, mark] of state.marksById.entries()) {
    if (mark.type === "Session" && mark.sessionGroupId === groupId) {
      const marker = state.markersById.get(id);
      if (marker) {
        const style = markStyleFor(mark, state);
        marker.setStyle({ radius: style.radius, color: style.color, weight: style.weight, fillColor: style.fillColor });
      }
    }
  }
  renderSessionLines(map, state, Array.from(state.marksById.values()));
}

/**
 * Breaks a cluster's icon down into small "satellite" shapes arranged
 * around a centre — one satellite per distinct (shape, colour)
 * combination actually present among its marks (POI/Mark/Catch shape ×
 * whatever the current "Colour by" field resolves to), each showing a
 * small count badge when more than one mark shares that exact
 * combination. This is deliberately richer than a single aggregate
 * number: at a glance it shows not just HOW MANY marks are grouped here
 * but roughly WHAT KIND, without needing to zoom in or spiderfy first.
 *
 * Reads each child marker's shape straight off `_markShapeName` (tagged
 * once at creation — see createMarkShapeLayer) and its CURRENT colour
 * straight off `marker.options.fillColor` (kept live by setStyle
 * whenever the "Colour by" field changes — see applyMarkFiltersAndGrouping
 * — so this always reflects what's on screen right now, not whatever it
 * was when the mark was first created).
 *
 * Capped at MAX_SATELLITES distinct combinations so a cluster spanning a
 * dozen species doesn't turn into an unreadable ring of slivers — the
 * smallest-count groups beyond that cap collapse into one grey "+N"
 * overflow satellite instead of being dropped silently.
 */
const MAX_CLUSTER_SATELLITES = 6;

function createMarkClusterIcon(cluster) {
  const children = cluster.getAllChildMarkers();
  const groups = new Map(); // "shape|colour" -> {shape, color, count}
  for (const child of children) {
    const shape = child._markShapeName || "circle";
    const color = (child.options && child.options.fillColor) || "#6b7280";
    const key = `${shape}|${color}`;
    const existing = groups.get(key);
    if (existing) existing.count++;
    else groups.set(key, { shape, color, count: 1 });
  }

  let entries = Array.from(groups.values()).sort((a, b) => b.count - a.count);
  if (entries.length > MAX_CLUSTER_SATELLITES) {
    const kept = entries.slice(0, MAX_CLUSTER_SATELLITES - 1);
    const overflowCount = entries.slice(MAX_CLUSTER_SATELLITES - 1).reduce((sum, g) => sum + g.count, 0);
    entries = [...kept, { shape: "circle", color: "#6b7280", count: overflowCount, isOverflow: true }];
  }

  const size = 60;
  const center = size / 2;
  // Fewer, bigger satellites when there's not much to show; smaller once
  // several distinct combinations need to fit around the same ring.
  const satelliteSize = entries.length <= 2 ? 24 : entries.length <= 4 ? 20 : 16;
  const radius = entries.length === 1 ? 0 : center - satelliteSize / 2 - 3;

  const satellitesHtml = entries
    .map((g, i) => {
      const angle = (360 / entries.length) * i - 90; // first satellite straight up, rest clockwise
      const rad = (angle * Math.PI) / 180;
      const x = center + radius * Math.cos(rad) - satelliteSize / 2;
      const y = center + radius * Math.sin(rad) - satelliteSize / 2;
      const badge =
        g.count > 1
          ? `<div class="mark-cluster-satellite-badge" style="position:absolute;bottom:-4px;right:-4px;min-width:14px;height:14px;padding:0 2px;
               border-radius:50%;background:var(--blue-900,#0b2a4a);color:#fff;border:1.5px solid #fff;
               font-size:0.6rem;font-weight:600;line-height:14px;text-align:center;">${g.count}</div>`
          : "";
      return `<div style="position:absolute;left:${x}px;top:${y}px;width:${satelliteSize}px;height:${satelliteSize}px;">
        ${markShapeToCssHtml(g.shape, satelliteSize, g.color)}
        ${badge}
      </div>`;
    })
    .join("");

  return L.divIcon({
    html: `<div style="position:relative;width:${size}px;height:${size}px;">${satellitesHtml}</div>`,
    className: "mark-cluster-icon", // no default plugin styling — see MarkerCluster.Default.css override, style.css
    iconSize: L.point(size, size),
  });
}

/**
 * One satellite's own little shape, as a plain absolutely-filled div —
 * matches the three real shapes this site draws on the map itself
 * (circle/diamond/cross — see createMarkShapeLayer/getDiamondMarkerClass/
 * getCrossMarkerClass) as closely as CSS reasonably allows, without
 * pulling in an actual SVG or Canvas render for something this small.
 * Diamond is a rotated square; cross uses a clip-path plus-sign polygon
 * (a standard CSS technique — no image/font dependency).
 */
function markShapeToCssHtml(shape, size, color) {
  const shared = `width:100%;height:100%;background:${color};box-shadow:0 1px 3px rgba(0,0,0,0.45);`;
  if (shape === "diamond") {
    return `<div style="${shared}border:1.5px solid #fff;transform:rotate(45deg);box-sizing:border-box;"></div>`;
  }
  if (shape === "cross") {
    return `<div style="${shared}clip-path:polygon(35% 0%,65% 0%,65% 35%,100% 35%,100% 65%,65% 65%,65% 100%,35% 100%,35% 65%,0% 65%,0% 35%,35% 35%);"></div>`;
  }
  return `<div style="${shared}border:1.5px solid #fff;border-radius:50%;box-sizing:border-box;"></div>`;
}

/**
 * Reliable replacement for calling zoomToShowLayer(marker, callback)
 * directly and trusting its own callback — CONFIRMED not to fire for
 * anything but a plain L.Marker in real-world use (a known,
 * long-standing Leaflet.markercluster limitation: internally it checks
 * for the marker's `_icon` DOM property before firing, which only
 * L.Marker/L.DivIcon layers ever have — see
 * github.com/Leaflet/Leaflet.markercluster/issues/904). Every mark on
 * this site is an L.CircleMarker or a custom Path shape (createMarkShapeLayer)
 * for the Canvas-rendering this whole layer depends on at scale — never
 * a plain L.Marker — so that callback silently never ran, meaning
 * whatever it was supposed to do (openPopup + wireMarkPopupButtons, in
 * every caller here) never happened. This was a REAL, reported bug:
 * copying or creating a mark whose popup never got its Save button
 * wired at all, with no visible error — clicking Save simply did
 * nothing, because nothing had ever attached a listener to it.
 *
 * Still calls zoomToShowLayer for its actual zoom/spiderfy side effect
 * (ignoring its own callback entirely), then polls getVisibleParent
 * until the marker itself — not a cluster standing in for it — is
 * confirmed visible, and only then runs the real callback. Skips the
 * zoom/poll dance entirely when the marker is already visible right
 * now, which is the common case (a spot just clicked, or a copy of a
 * mark that was already visible to click "Copy" on in the first place).
 * Gives up after ~3s (a generous margin over any real zoom/spiderfy
 * animation) and runs the callback anyway rather than leaving a popup
 * permanently unwired if something unexpected prevents the marker from
 * ever reporting visible.
 */
function showMarkerOnceVisible(markerLayer, marker, callback) {
  // Checks marker._map directly — a standard Leaflet property, true only
  // when this SPECIFIC layer is genuinely rendered on the map right now
  // (as opposed to hidden behind a cluster icon standing in for it).
  // Deliberately NOT using Leaflet.markercluster's own getVisibleParent
  // for this: confirmed by direct testing to have the EXACT SAME `_icon`-
  // dependent bug as zoomToShowLayer's callback (it walks up looking for
  // a layer with an `_icon` property, which only L.Marker/L.DivIcon ever
  // have — every mark here is a CircleMarker or custom Path shape, so it
  // always returns null regardless of whether the marker is actually
  // visible, which is exactly how the original bug this function exists
  // to fix went undetected: the "obvious" correct-looking API for this is
  // itself broken for this project's marker types).
  if (marker._map) {
    callback();
    return;
  }
  markerLayer.zoomToShowLayer(marker, () => {}); // side effect only (the actual zoom/spiderfy) — its own callback is never trusted, same reasoning as above
  const startedAt = Date.now();
  const checkVisible = () => {
    if (marker._map) {
      callback();
    } else if (Date.now() - startedAt < 3000) {
      setTimeout(checkVisible, 100);
    } else {
      console.error("showMarkerOnceVisible: gave up waiting for marker to become visible; running callback anyway.");
      callback();
    }
  };
  setTimeout(checkVisible, 150); // give the zoom/spiderfy animation a moment to actually start before the first check
}
