// map-core.js
// Leaflet map basics: map pin icons and the map itself (renderLeafletLocationMap) with its saved zoom/position. Used by every page that shows a map.
// One of the shared scripts split out of the old charts.js. All of them share one global scope; each page loads
// only the ones it needs, in this order (checked by scripts/check-page-scripts.mjs).

/**
 * Finds the local peaks (high tide) and troughs (low tide) in the tide
 * curve. A point counts as a candidate peak/trough if it's higher/lower
 * than both its immediate neighbors, but the reported TIME isn't just
 * that sampled hour — real tide peaks/troughs almost never land exactly
 * on the hour, and reporting the raw sample would be visibly wrong (e.g.
 * a true peak at 3:42 showing as "4:00"). Instead, a parabola is fitted
 * through the three hourly samples straddling the peak/trough, and its
 * vertex — the fraction of an hour before/after the middle sample where
 * the curve actually turns — is used to interpolate the real time. The
 * server-side tide curve is itself cosine-shaped (see the tide
 * interpolation in fetch_conditions.py), and a cosine is well approximated
 * by a parabola in the small neighborhood right around its own peak, so
 * this recovers the true peak time closely — verified against a
 * synthetic cosine with a known non-hour peak (3.7h): this method
 * recovered 3.704h, vs. 4h from the raw hourly sample.
 * The very first/last row is never reported: with nothing before/after it
 * to compare against, there's no way to tell whether it's a genuine local
 * extreme or just where the visible data happens to end.
 */
/**
 * Estimates the tide height at targetMs by interpolating within a
 * location's own (unshifted) tide curve — the building block for
 * applyTideOffsetToRows below. Cosine-eased between the two bracketing
 * real samples (slow near each end, faster through the middle) rather
 * than a straight line, matching the same interpolation shape
 * fetch_conditions.py's own server-side tide interpolation already uses
 * (the "Rule of Twelfths" — a real tide curve is smoothly curved, not
 * straight segments meeting at a point), so a shifted curve still looks
 * like a genuine tide curve rather than gaining visible kinks at each
 * original hourly sample.
 */
/**
 * Low-level Leaflet map builder shared by the Location tab (app.js) and
 * the Settings tab (locationsadmin.js) — each page builds its own
 * `points` array (with whatever popup/click behavior makes sense there;
 * see the two call sites for how they differ) and this just handles
 * creating the map, the tile layer, and placing/fitting markers.
 *
 * Uses Leaflet + plain OpenStreetMap tiles specifically because they're
 * free and need no API key, unlike Google Maps — appropriate here since
 * this site otherwise has zero paid mapping dependencies. Both pages load
 * Leaflet itself via CDN in their own <head> (see conditions.html /
 * locations.html) — this function assumes window.L already exists by the
 * time it's called.
 *
 * points: [{ lat, lng, label, onClick?, popupHtml? }]. A marker always
 * gets a hover tooltip (label); onClick fires immediately on click
 * (for a single, unambiguous selection), while popupHtml opens a
 * Leaflet popup instead (for a marker that needs to offer a choice —
 * see app.js's location-with-multiple-types case) — a point supplies
 * one or the other, not normally both.
 *
 * opts.onMapClick(lat, lng), if given, fires when the MAP ITSELF (not a
 * marker) is clicked — used by the Settings tab's "click map to add a
 * location" action (see locationsadmin.js) to capture exactly where the
 * admin clicked. Its presence also changes the empty-map fallback: with no
 * onMapClick, zero valid points means nothing useful can be shown at all,
 * so the function bails to an explanatory message; WITH onMapClick, a
 * genuinely empty map is still shown (centered on Port Phillip/Western
 * Port, since that's this whole site's coverage area) so there's still
 * something clickable to start the very first location from.
 *
 * Returns the Leaflet map instance, or null if Leaflet/the container
 * isn't available, or there are no valid (lat/lng-bearing) points to
 * show AND no onMapClick was given — callers can use that null to fall
 * back to showing an explanatory message instead of an empty map box.
 */
/**
 * Map pin icons (Kayak / Land based / both) for renderLeafletLocationMap
 * below. A classic teardrop pin with a small circular window near the top
 * holding the actual symbol — Lucide's own "kayak"/"footprints" icon paths
 * (see iconPathsFor/typeIconSvg in chart-base.js, the shared source of
 * truth for this site's Kayak/Land-based icon pair), recentred and scaled
 * to fit the window.
 */
const MAP_PIN_STYLES = {
  kayak: { fill: KAYAK_ICON_COLOR, light: "#E6F1FB" },
  landBased: { fill: LAND_BASED_ICON_COLOR, light: "#FAEEDA" },
  both: { fill: "#534AB7", light: "#EEEDFE" },
  home: { fill: "#15803D", light: "#DCFCE7" },
};

function typeMapGlyphSvg(type, color, cx, cy, scale) {
  return `
    <g transform="translate(${cx} ${cy}) scale(${scale}) translate(-12 -12)">
      <g fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        ${iconPathsFor(type).map((d) => `<path d="${d}"/>`).join("")}
      </g>
    </g>
  `;
}

// Same hand-drawn-shape convention as the two glyphs above — a simple
// roof-plus-body silhouette with a white door cutout, not an icon font or
// external asset. Used for the single "home" marker (see
// saveHomeLocation/renderSettingsLocationMap in locationsadmin.js) — the
// one map-click-armed pin that isn't a fishing location at all.
function houseGlyphSvg(color, cx, cy, scale) {
  return `
    <g transform="translate(${cx} ${cy}) scale(${scale})">
      <path d="M0 -9 L9 -1.5 L6 -1.5 L6 8 L-6 8 L-6 -1.5 L-9 -1.5 Z" fill="${color}"/>
      <rect x="-2" y="1.5" width="4" height="6.5" fill="white"/>
    </g>
  `;
}


function buildMapPinIconHtml(kind) {
  const { fill, light } = MAP_PIN_STYLES[kind] || MAP_PIN_STYLES.kayak;
  let glyph;
  if (kind === "home") glyph = houseGlyphSvg(fill, 17, 16, 1);
  else if (kind === "landBased") glyph = typeMapGlyphSvg("Land based", fill, 17, 16, 0.82);
  else if (kind === "both") glyph = typeMapGlyphSvg("Kayak", fill, 12.5, 16, 0.5) + typeMapGlyphSvg("Land based", fill, 21.5, 16, 0.5);
  else glyph = typeMapGlyphSvg("Kayak", fill, 17, 16, 0.82);
  return `
    <svg width="34" height="44" viewBox="0 0 34 44" xmlns="http://www.w3.org/2000/svg">
      <path d="M17 2C9.3 2 3 8.3 3 16c0 11 14 26 14 26s14-15 14-26C31 8.3 24.7 2 17 2z" fill="${fill}"/>
      <circle cx="17" cy="16" r="10.5" fill="${light}"/>
      ${glyph}
    </svg>
  `;
}

/**
 * A Leaflet divIcon (arbitrary HTML/SVG rather than an image file) for
 * the given kind — "kayak", "landBased", "both", or "home". className
 * resets Leaflet's own default icon CSS (which otherwise adds a
 * background/border meant for its default image-based marker and would
 * clash with a custom SVG one) — see the .location-map-pin rule in
 * style.css. NOT used for "currentPosition" — see
 * buildCurrentPositionDivIcon below for why that one needs a genuinely
 * different shape, not just a recolored pin.
 */
function buildMapPinDivIcon(kind) {
  return L.divIcon({
    html: buildMapPinIconHtml(kind),
    className: "location-map-pin",
    iconSize: [34, 44],
    iconAnchor: [17, 44],
    popupAnchor: [0, -40],
    tooltipAnchor: [0, -38],
  });
}

/**
 * The "you are here" marker (Live page — see renderLiveMap in live.js) —
 * deliberately NOT a buildMapPinDivIcon variant. It used to just be the
 * same 34x44 teardrop pin silhouette recolored red with a small dot glyph
 * inside (dotGlyphSvg, above), which at a glance read as "another
 * fishing-spot pin", not "this one is different, it's you" — genuinely
 * easy to miss among a map full of real teardrop pins. This is the
 * standard "blue dot with a pulsing halo" treatment instead (Google Maps
 * and similar all use some version of this) — a small circle rather than
 * a pin shape at all, so it's immediately readable as a different KIND of
 * marker, not just a different color of the same one. CSS animation
 * lives in style.css (.current-position-pulse).
 */
function buildCurrentPositionDivIcon() {
  return L.divIcon({
    html: `
      <div class="current-position-marker">
        <div class="current-position-pulse"></div>
        <div class="current-position-dot"></div>
      </div>
    `,
    className: "current-position-icon-wrapper",
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    tooltipAnchor: [0, -11],
  });
}

// Shared between the Location tab's map and the Settings tab's map — both
// show the same geography, so "where was I last looking" is one
// preference, not two separate ones.
const MAP_VIEW_STORAGE_KEY = "goodConditionsLocationMapView";

// Tracks the live Leaflet map instance per container (keyed by containerId)
// across repeated renderLeafletLocationMap calls. The Settings tab in
// particular calls this on every renderRows() — initial load, adding a
// location, removing one, toggling a type, and now the map-click-to-add
// flow — all reusing the SAME #settingsLocationMap div. Leaflet throws
// "Error: Map container is already initialized" if L.map() is called again
// on a container that already has a live map, without tearing the old one
// down first — and since that throw happens mid-function, it silently
// skipped the applyLocationFilter() call right after it in the caller,
// which is what made a fresh "click to add" location appear alongside
// every OTHER location instead of alone. map.remove() is Leaflet's own
// teardown (unbinds events/layers, clears the container's internal
// "already initialized" flag) — calling it first makes every one of these
// re-renders safe.
const leafletMapInstances = {};

/**
 * Fixes a real bug (reported directly: on a small/narrow viewport, a new
 * mark's entry popup rendered BEHIND the Live tab's bottom-sheet hover
 * panel AND behind the mark filter modal) that turned out to need more
 * than "give the popup a higher z-index" — that alone (still worth
 * keeping — see .leaflet-popup-pane's own CSS comment) wasn't enough,
 * because of something more fundamental sitting underneath it:
 *
 * The element passed to L.map() (here, whatever #liveMap/#locationMap/etc
 * IS — Leaflet doesn't create a wrapping div, that exact element becomes
 * .leaflet-container itself) had no `position` set at all in this site's
 * CSS, i.e. it was `position: static`. A static element's entire box —
 * including everything painted inside it, no matter what z-index values
 * exist among ITS OWN descendants — always paints as one unit BELOW any
 * POSITIONED sibling that has its own z-index (like .location-hover-panel
 * or the filter modal's .ww-candidate-overlay). Static elements simply
 * don't participate in z-index comparison against positioned ones at all;
 * raising the popup pane's z-index was rearranging deck chairs one level
 * too deep to matter. (This is also the more likely explanation for it
 * showing up on a narrowed DESKTOP window too, not just real mobile
 * devices — nothing here is actually screen-size-conditional; a narrow
 * viewport just makes the map and hover panel/filter genuinely overlap in
 * the first place, on any device.)
 *
 * The fix (paired with .location-map-fullpage/.location-map's own
 * position:relative in style.css, which makes this next part possible at
 * all) toggles a class on the map's own container for exactly as long as
 * a popup is open on it — raising the WHOLE map (popup included) above
 * every other floating layer only while genuinely needed, rather than
 * permanently (which would otherwise leave the map sitting over the hover
 * panel even with no popup open, defeating the hover panel's own purpose
 * of covering the map). Wired in once, here, for every map this site
 * creates (there's only this one call site for L.map at all) rather than
 * scoped to marks specifically — a popup should always be the topmost
 * thing regardless of which one it is (an existing-location's info
 * popup, a WillyWeather preview popup, not just a mark's), so this isn't
 * narrowed to "only mark popups" on purpose.
 */
function wireMapPopupZIndexToggle(map) {
  map.on("popupopen", () => {
    map.getContainer().classList.add("map-has-open-popup");
  });
  map.on("popupclose", () => {
    map.getContainer().classList.remove("map-has-open-popup");
  });
}

const PIN_HOLD_MS = 2000;

/** Runs `onFire` when a marker is held down (mouse or touch) for PIN_HOLD_MS without moving more than a few pixels —
 * moving further (a map pan) or letting go early cancels it. While held, the icon gets .pin-holding (style.css) so
 * it visibly "charges up". Sets marker._longPressFired so the click from the release can be ignored. */
function wireMarkerLongPress(marker, onFire) {
  // Leaflet only creates a marker's element once the map is ready (setView), which is after the markers are built —
  // so wire it up when it's actually added.
  const el = marker.getElement();
  if (!el) {
    marker.once("add", () => wireMarkerLongPress(marker, onFire));
    return;
  }
  let timer = null;
  let startX = 0;
  let startY = 0;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    el.classList.remove("pin-holding");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", cancel);
  };
  const onMove = (e) => {
    const t = e.touches ? e.touches[0] : e;
    if (t && Math.hypot(t.clientX - startX, t.clientY - startY) > 8) cancel();
  };
  const start = (e) => {
    if (e.type === "mousedown" && e.button !== 0) return;
    const t = e.touches ? e.touches[0] : e;
    startX = t.clientX;
    startY = t.clientY;
    marker._longPressFired = false;
    el.classList.add("pin-holding");
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      el.classList.remove("pin-holding");
      marker._longPressFired = true;
      onFire();
    }, PIN_HOLD_MS);
    if (e.type === "mousedown") {
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", cancel);
    }
  };
  el.addEventListener("mousedown", start);
  el.addEventListener("touchstart", start, { passive: true });
  el.addEventListener("touchmove", onMove, { passive: true });
  el.addEventListener("touchend", cancel);
  el.addEventListener("touchcancel", cancel);
  // A long touch would otherwise bring up the phone's own "save image" style menu.
  el.addEventListener("contextmenu", (e) => {
    if (timer || marker._longPressFired) e.preventDefault();
  });
}

function renderLeafletLocationMap(containerId, points, opts = {}) {
  const container = document.getElementById(containerId);
  if (!container || typeof L === "undefined") return null;

  if (leafletMapInstances[containerId]) {
    leafletMapInstances[containerId].remove();
    delete leafletMapInstances[containerId];
  }

  const valid = points.filter((p) => p.lat != null && p.lng != null);
  if (valid.length === 0 && !opts.onMapClick) {
    container.innerHTML = `<p class="footnote" style="margin:0;">No locations with coordinates to show yet.</p>`;
    return null;
  }

  const map = L.map(container, { scrollWheelZoom: true });
  leafletMapInstances[containerId] = map;
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 18,
  }).addTo(map);

  wireMapPopupZIndexToggle(map);

  const persistView = opts.persistView !== false;
  const bounds = [];
  for (const p of valid) {
    bounds.push([p.lat, p.lng]);
    // "currentPosition" gets the distinct pulsing-dot marker
    // (buildCurrentPositionDivIcon) instead of a teardrop pin — see that
    // function's own comment for why.
    const icon = p.iconKind === "currentPosition" ? buildCurrentPositionDivIcon() : buildMapPinDivIcon(p.iconKind || "kayak");
    const marker = L.marker([p.lat, p.lng], { icon }).addTo(map);
    // Lets a caller keep hold of one specific marker it cares about (currently just Live mode's own "You are
    // here" pin, so it can be repositioned in place later without rebuilding the whole map — see
    // liveRefreshGpsPosition, map-live.js). Every other caller leaves opts.onMarkerCreated unset, so this is a
    // pure no-op for them.
    if (opts.onMarkerCreated) opts.onMarkerCreated(p, marker);
    if (p.label) marker.bindTooltip(p.label, { direction: "top" });
    if (p.popupHtml) marker.bindPopup(p.popupHtml);
    // A 2-second hold (p.onLongPress — the Map's "pick up a pin to move it", js/location-move.js) swallows the click
    // its own release would otherwise send, so it doesn't also open the location.
    if (p.onLongPress) wireMarkerLongPress(marker, () => p.onLongPress(marker));
    if (p.onClick) {
      marker.on("click", (e) => {
        if (marker._longPressFired) {
          marker._longPressFired = false;
          return;
        }
        p.onClick(e);
      });
    }
  }

  // Restores the last-viewed position/zoom if one was saved, rather than
  // always resetting to "fit every marker" on every page load — once
  // someone's zoomed in on their own local patch, they shouldn't have to
  // re-zoom back in every time they open this page. Falls back to the
  // original "fit everything" behavior the first time, before anything's
  // ever been saved.
  // A function, not inline, because it may have to run a second time: a map
  // built inside a hidden (display:none / collapsed) container is 0x0, and
  // fitBounds against a 0x0 map gives a meaningless view — see the
  // ResizeObserver at the end of this function.
  const applyInitialView = () => {
    let savedView = null;
    try {
      // persistView:false (Live and Import modes on the Map tab) neither
      // restores nor overwrites the shared saved view — those modes set
      // their own view and shouldn't change where Normal mode reopens.
      savedView = persistView ? JSON.parse(localStorage.getItem(MAP_VIEW_STORAGE_KEY) || "null") : null;
    } catch {
      savedView = null;
    }
    if (savedView && typeof savedView.lat === "number" && typeof savedView.lng === "number" && typeof savedView.zoom === "number") {
      map.setView([savedView.lat, savedView.lng], savedView.zoom, { animate: false });
    } else if (bounds.length === 0) {
      // Only reachable via the onMapClick early-return bypass above (a
      // genuinely empty map, no locations with coordinates at all yet) —
      // fitBounds([]) has nothing to fit, so center on Port Phillip/Western
      // Port generally, since that's this whole site's coverage area, rather
      // than Leaflet's default (mid-Atlantic, lat/lng 0,0).
      map.setView([-38.2, 145.1], 9, { animate: false });
    } else if (bounds.length === 1) {
      // A single marker has no useful "bounds" to fit (fitBounds on one
      // point zooms in to the max level, which is usually too tight) —
      // center on it at a reasonable fixed zoom instead.
      map.setView(bounds[0], 12, { animate: false });
    } else {
      map.fitBounds(bounds, { padding: [24, 24], animate: false });
    }
  };
  const startedHidden = container.clientWidth === 0 || container.clientHeight === 0;
  let reapplyingInitialView = false;
  let userMovedMap = false; // set once the user pans/zooms, so a late re-fit never undoes their view
  applyInitialView();

  // Saves the current position/zoom whenever the user finishes panning or
  // zooming — registered after the initial setView/fitBounds above
  // deliberately, so restoring (or setting) the starting view doesn't
  // itself immediately re-trigger a save; only genuine user interaction
  // does.
  const saveCurrentView = () => {
    if (reapplyingInitialView) return; // the late re-fit isn't the user's own choice of view
    const center = map.getCenter();
    localStorage.setItem(MAP_VIEW_STORAGE_KEY, JSON.stringify({ lat: center.lat, lng: center.lng, zoom: map.getZoom() }));
  };
  if (persistView) {
    map.on("moveend", saveCurrentView);
    map.on("zoomend", saveCurrentView);
  }

  if (opts.onMapClick) {
    // A click that's only dismissing an already-open popup shouldn't ALSO
    // be treated as "click on empty map area" (starting a new mark, or
    // asking "new mark or view location?" — handleMapClickForMarks) — a
    // real, previously-reported bug: accidentally clicking off an open
    // mark's edit form closed it AND immediately started a second,
    // unrelated action at that same point. Leaflet fires 'preclick' just
    // before 'click' for the exact same physical click, and BEFORE any
    // popup that click is about to auto-close actually closes — so
    // checking "is a popup currently open" at 'preclick' time reliably
    // means "yes, THIS click is the one dismissing it", even though by
    // the time 'click' itself fires the popup has already closed (and
    // 'popupclose' already fired) as part of the very same click.
    let popupWasOpenForThisClick = false;
    let aPopupIsCurrentlyOpen = false;
    map.on("popupopen", () => {
      aPopupIsCurrentlyOpen = true;
    });
    map.on("popupclose", () => {
      aPopupIsCurrentlyOpen = false;
    });
    map.on("preclick", () => {
      popupWasOpenForThisClick = aPopupIsCurrentlyOpen;
    });
    // Fires on a genuine click on open map area. Leaflet doesn't bubble
    // marker clicks up to this handler by default, so clicking an existing
    // pin correctly triggers ONLY that marker's own onClick (set above),
    // never both.
    map.on("click", (e) => {
      if (popupWasOpenForThisClick) return; // this click's real purpose was closing that popup — nothing more
      opts.onMapClick(e.latlng.lat, e.latlng.lng);
    });
  }

  // Leaflet sizes its internal tile grid ONCE, from the container's
  // dimensions at the exact moment L.map() was called above — it has no
  // way to know the container later changed size unless explicitly told
  // via invalidateSize(). On mobile specifically, the browser's address
  // bar is commonly still fully expanded at page-load time and collapses
  // a moment later (a well-documented, ordinary mobile browser behavior),
  // which — on this page's fullscreen map layout (.map-fullpage-body,
  // height:100dvh) — silently leaves the map sized for the SMALLER,
  // address-bar-still-showing viewport even after the real one grows.
  // The short delay catches that one-time settle shortly after load; the
  // resize/orientationchange listeners catch it happening again later
  // (rotating the device, or the address bar toggling on scroll).
  //
  // A container that is hidden when the map is built (the Settings tab's
  // Locations section starts folded, so its map is built at 0x0) never
  // fires any of those, and is only re-measured when it's shown — so a
  // ResizeObserver on the container itself does the re-measuring, and
  // re-applies the starting view once, the first time the map gets a real
  // size (unless the user has already moved it). The listeners are removed
  // when the map is (Settings rebuilds its map on every change).
  map.on("dragstart zoomstart", () => {
    userMovedMap = true;
  });
  let fitAtRealSize = startedHidden;
  const remeasure = () => {
    const nowSized = fitAtRealSize && container.clientWidth > 0 && container.clientHeight > 0;
    if (nowSized) fitAtRealSize = false;
    const refit = nowSized && !userMovedMap;
    // The flag covers invalidateSize too: it fires its own moveend, which would otherwise save the meaningless 0x0 view just before the re-fit reads the saved view.
    if (refit) reapplyingInitialView = true;
    map.invalidateSize();
    if (refit) {
      applyInitialView();
      reapplyingInitialView = false;
    }
  };
  // The window listeners stay too: a page can un-hide the container and fire
  // a "resize" itself (Settings' folding sections do), and browsers without
  // ResizeObserver only have these.
  const observer = window.ResizeObserver ? new ResizeObserver(remeasure) : null;
  if (observer) observer.observe(container);
  setTimeout(remeasure, 300);
  window.addEventListener("resize", remeasure);
  window.addEventListener("orientationchange", remeasure);
  map.on("unload", () => {
    if (observer) observer.disconnect();
    window.removeEventListener("resize", remeasure);
    window.removeEventListener("orientationchange", remeasure);
  });

  return map;
}
