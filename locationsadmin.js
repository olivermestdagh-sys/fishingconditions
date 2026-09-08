// GITHUB_API, FILE_PATH, BRANCH, getConnection, and utf8ToBase64 now live
// in charts.js (loaded before this file) — the Location tab's own "Add as
// permanent location" button (see app.js) needed the same GitHub
// read/write plumbing this file already had, so they're shared rather
// than duplicated. GROUPS_FILE_PATH and WORKFLOW_FILE stay here — nothing
// outside this Settings page touches location GROUPS or triggers a data
// refresh.
const GROUPS_FILE_PATH = "config/location_groups.json";
const SETTINGS_FILE_PATH = "config/settings.json";
const WORKFLOW_FILE = "update.yml";

// Home address — a single lat/lng, stored in config/settings.json
// alongside googleRoutesApiKey (NOT config/locations.json; it isn't a
// fishing location, doesn't need a shore/type/tide config, and shouldn't
// show up in anything that lists "locations"). Set via the map ("Add
// Home" button below), read once on load so its pin can show immediately
// if already set — see loadHomeLocation/saveHomeLocation.
let homeLat = null;
let homeLng = null;

// TYPE_TIME_FIELDS and defaultTypeConfig also now live in charts.js —
// same reasoning, the preview's "Add as permanent location" flow needed
// to build a real types[] entry with the same default timing fields this
// page's own "+ Add location"/map-click flows already use.

// WILLYWEATHER_SEARCH_WORKER_URL, fetchWillyWeatherCandidates,
// showLocationCandidatePicker, and escapeHtml all now live in charts.js
// (loaded before this file) — the Location tab's own "click map to
// preview a spot" feature needed the exact same "click the map, ask
// WillyWeather what's really there, let the person pick from real
// candidates" flow this file originated, so it made more sense to share
// one implementation than maintain two copies that could drift apart. See
// the "WillyWeather search / candidate picker (shared)" section of
// charts.js for the moved code and its comments.

/**
 * Same icon shapes as charts.js's typeIconSvg — duplicated here rather than
 * loading the whole chart-rendering file just for two small icons, since
 * this page has nothing else to do with charts. Keep both copies in sync
 * if either one changes.
 */
function typeIconSvg(type, size) {
  size = size || 16;
  if (type === "Kayak") {
    // Elongated hull + two rods angled outward from distinct mounting
    // points, reading as a fishing kayak rather than a plain kayak.
    return `<svg viewBox="0 0 32 24" width="${size}" height="${size}">
      <path d="M2 16 Q9 12.5 16 12.5 Q23 12.5 30 16 Q23 19 16 19 Q9 19 2 16 Z" fill="#f97316" stroke="#c2410c" stroke-width="0.8"/>
      <line x1="17" y1="14" x2="27" y2="3" stroke="#78350f" stroke-width="1.6" stroke-linecap="round"/>
      <line x1="15" y1="15" x2="5" y2="4" stroke="#78350f" stroke-width="1.6" stroke-linecap="round"/>
    </svg>`;
  }
  // Land based: a rod holder planted in the ground, a rod at an angle,
  // reel, and the line arcing out to the water.
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}">
    <path d="M1 20 L9 20" stroke="#a8a29e" stroke-width="2" stroke-linecap="round"/>
    <path d="M13 20 Q16 18.5 19 20 Q21 21 23 20" fill="none" stroke="#38bdf8" stroke-width="1.3" stroke-linecap="round"/>
    <rect x="7.3" y="14" width="1.4" height="6.5" rx="0.6" fill="#57534e"/>
    <line x1="8" y1="15" x2="20" y2="4" stroke="#92400e" stroke-width="1.2" stroke-linecap="round"/>
    <circle cx="10.3" cy="12.6" r="1" fill="#44403c"/>
    <path d="M20 4 Q19 10 17.5 19" stroke="#0ea5e9" stroke-width="0.6" fill="none" stroke-dasharray="0.5 1"/>
  </svg>`;
}

// TYPE_OPTIONS and SHORE_OPTIONS now live in charts.js (loaded before this
// file) — the Location tab's preview scoring needs the same lists to
// populate its own Shore/Type pickers, so they're shared rather than
// duplicated. See charts.js's "Preview condition scoring" section.

let locations = [];
let currentSha = null;
let locationGroups = [];
let groupsSha = null;

// Name -> {lat, lng}, populated by loadLocationCoords() below. The admin
// config this page edits (config/locations.json, loaded into `locations`
// above) never stores coordinates itself — lat/lng only get resolved by
// fetch_conditions.py via WillyWeather's location search on each scheduled
// run, and are written into the GENERATED data/conditions.json, not back
// into the config file. Without this separate lookup, renderSettingsLocationMap
// below would have no coordinates to plot markers with for ANY location, no
// matter how many are configured — that was the actual cause of the
// Settings map appearing blank ("No locations with coordinates to show
// yet."), not a CDN/network issue with Leaflet itself.
let locationCoords = {};

// Index into `locations` of the single card the Settings list should show,
// or null to show all of them. Set by clicking a marker on the Settings map
// (see jumpToLocationRow) and cleared by the "Show all locations" banner
// button (see applyLocationFilter) — this page can list 15+ locations, each
// with a fairly tall edit card, so once someone's clicked a specific spot
// on the map to find it, cutting the rest of the list out entirely is much
// faster than scrolling+highlighting through everything else to find it.
let selectedLocationIdx = null;

// Persists selectedLocationIdx across page reloads (a plain browser
// refresh — NOT the same thing as fetch_conditions.py's data refresh) so
// clicking a location on the map "sticks": reload the Settings tab and
// it's still filtered to the same one, rather than silently popping back
// to showing everything. Stored by NAME rather than array index — index
// isn't a stable identity across a reload (locations can be added/removed
// elsewhere in the meantime), but name is, for anything actually saved.
const SELECTED_LOCATION_STORAGE_KEY = "settingsSelectedLocationName";

/**
 * The one place selectedLocationIdx should ever be set — keeps it and its
 * localStorage mirror (SELECTED_LOCATION_STORAGE_KEY) from drifting apart.
 * A brand-new, not-yet-named location (idx valid but loc.name === "") is
 * deliberately NOT persisted: it only exists in memory until "Save changes"
 * actually writes it to GitHub, so there's nothing meaningful to restore
 * for it after a reload anyway — persisting nothing here just means a
 * reload correctly falls back to whatever named location (if any) was
 * selected before it.
 */
function selectLocation(idx) {
  selectedLocationIdx = idx;
  const loc = idx != null ? locations[idx] : null;
  try {
    if (loc && loc.name) localStorage.setItem(SELECTED_LOCATION_STORAGE_KEY, loc.name);
    else localStorage.removeItem(SELECTED_LOCATION_STORAGE_KEY);
  } catch {
    // localStorage can throw in rare cases (private browsing quirks on
    // some browsers, storage disabled) — the filter still works for this
    // session via selectedLocationIdx itself, it just won't survive a
    // reload, which is a reasonable degrade rather than something to
    // surface as an error to the user.
  }
  applyLocationFilter();
}

/**
 * Fetches data/conditions.json purely to pick up each location's lat/lng
 * for the Settings tab's map — see the comment on locationCoords above for
 * why this can't just come from the `locations` array already loaded from
 * config/locations.json. A cache-busting query param sidesteps GitHub
 * Pages' CDN cache (same issue/fix as loadTideOffsets in charts.js, just
 * applied to a different file) so a location added and refreshed moments
 * ago shows up on the map without needing a hard refresh. Fails silently —
 * on error, locationCoords just stays empty and every marker falls back to
 * the "no coordinates" case, rather than blocking the rest of the page
 * from working.
 */
async function loadLocationCoords() {
  try {
    const res = await fetch(`data/conditions.json?_=${Date.now()}`, { cache: "no-store" });
    const data = await res.json();
    for (const loc of data.locations || []) {
      // Kayak/Land based variants of the same physical location repeat the
      // same name with the same lat/lng — first one in wins, rest are
      // redundant writes of the same value.
      if (loc.name && !(loc.name in locationCoords)) {
        locationCoords[loc.name] = { lat: loc.lat, lng: loc.lng };
      }
    }
  } catch (err) {
    console.error("Could not load location coordinates for Settings map:", err);
  }
}

function parseHM(value) {
  const m = String(value || "").match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return { h: 0, m: 0 };
  return { h: Math.min(23, Number(m[1])), m: Math.min(59, Number(m[2])) };
}

function formatHM(h, m) {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function setStatus(text, isError) {
  const el = document.getElementById("status");
  el.textContent = text;
  el.style.color = isError ? "#fca5a5" : "";
}

function setSaveStatus(text, isError) {
  const el = document.getElementById("saveStatus");
  el.textContent = text;
  el.style.color = isError ? "#dc2626" : "#16a34a";
}

async function init() {
  const conn = getConnection();
  if (conn) {
    document.getElementById("ghOwner").value = conn.owner || "";
    document.getElementById("ghRepo").value = conn.repo || "";
    document.getElementById("ghToken").value = conn.token || "";
  }

  document.getElementById("btnConnect").addEventListener("click", onConnect);
  document.getElementById("btnDisconnect").addEventListener("click", onDisconnect);
  document.getElementById("btnAddRow").addEventListener("click", () => {
    locations.push({ name: "", shore: "N", types: [defaultTypeConfig("Kayak")] });
    // Show just the new blank card (same as clicking a marker on the map)
    // rather than the whole list — nothing left to persist across a reload
    // for it yet (see selectLocation), but it should still be the ONLY
    // thing visible right now so it's obvious where to start typing.
    selectLocation(locations.length - 1);
    renderRows();
  });
  document.getElementById("btnAddByMapClick").addEventListener("click", toggleAddLocationClickMode);
  document.getElementById("btnAddHome").addEventListener("click", toggleAddHomeClickMode);
  document.getElementById("btnSave").addEventListener("click", () => onSave(false));
  document.getElementById("btnSaveAndRefresh").addEventListener("click", () => onSave(true));

  document.getElementById("btnAddGroup").addEventListener("click", onAddGroup);
  document.getElementById("newGroupInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onAddGroup();
    }
  });
  document.getElementById("btnSaveGroups").addEventListener("click", onSaveGroups);
  document.getElementById("btnSaveMarkLists").addEventListener("click", onSaveMarkLists);

  // Groups, coords, home, and mark lists all need to be ready before the
  // first renderRows() (called at the end of loadLocations, which renders
  // the map too) — well, mark lists don't actually feed renderRows() the
  // way the other three do (nothing on this page reaches into `locations`
  // for them yet), but there's no reason to make it wait its turn behind
  // ones that do. All four are independent of `locations` itself and of
  // each other, so they load in parallel rather than one after another.
  await Promise.all([loadLocationGroups(), loadLocationCoords(), loadHomeLocation(), loadMarkLists()]);
  await loadLocations();
}

/**
 * Reads config/settings.json once on load, purely to show the home pin
 * immediately if one's already set — NOT tracking a sha here the way
 * loadLocationGroups does for GROUPS_FILE_PATH, since this page never
 * edits any OTHER field in settings.json (googleRoutesApiKey) and
 * saveHomeLocation below re-reads the file fresh immediately before
 * writing anyway, same "re-check sha right before a write" reasoning as
 * every other save on this page. A missing file, or no connection yet,
 * just means no home is set yet — not an error worth surfacing.
 */
async function loadHomeLocation() {
  try {
    const conn = getConnection();
    let settings = {};
    if (conn && conn.owner && conn.repo && conn.token) {
      const res = await fetch(`${GITHUB_API}/repos/${conn.owner}/${conn.repo}/contents/${SETTINGS_FILE_PATH}?ref=${BRANCH}`, {
        headers: { Authorization: `Bearer ${conn.token}`, Accept: "application/vnd.github+json" },
      });
      if (res.ok) {
        const json = await res.json();
        const decoded = decodeURIComponent(escape(atob(json.content.replace(/\n/g, ""))));
        settings = JSON.parse(decoded);
      }
    } else {
      const res = await fetch("config/settings.json", { cache: "no-store" });
      if (res.ok) settings = await res.json();
    }
    homeLat = settings.homeLat ?? null;
    homeLng = settings.homeLng ?? null;
  } catch (err) {
    console.error("Could not load home location:", err);
    homeLat = null;
    homeLng = null;
  }
}

async function loadLocationGroups() {
  const conn = getConnection();
  try {
    if (conn && conn.owner && conn.repo && conn.token) {
      const res = await fetch(`${GITHUB_API}/repos/${conn.owner}/${conn.repo}/contents/${GROUPS_FILE_PATH}?ref=${BRANCH}`, {
        headers: { Authorization: `Bearer ${conn.token}`, Accept: "application/vnd.github+json" },
      });
      if (res.status === 404) {
        // File doesn't exist in the repo yet — perfectly normal the first
        // time this feature is used; starts as an empty list and gets
        // created the first time "Save groups" below is used.
        locationGroups = [];
        groupsSha = null;
      } else if (!res.ok) {
        throw new Error(`GitHub returned ${res.status}`);
      } else {
        const json = await res.json();
        groupsSha = json.sha;
        const decoded = decodeURIComponent(escape(atob(json.content.replace(/\n/g, ""))));
        locationGroups = JSON.parse(decoded);
      }
    } else {
      // No connection yet — fall back to the public static file if it
      // exists; a 404 here (file not created yet) is just as normal as
      // above, not worth surfacing as an error.
      const res = await fetch("config/location_groups.json", { cache: "no-store" });
      locationGroups = res.ok ? await res.json() : [];
    }
  } catch (err) {
    console.error(err);
    locationGroups = [];
  }
  document.getElementById("groupsSection").style.display = "block";
  renderGroupsList();
}

function renderGroupsList() {
  const list = document.getElementById("groupsList");
  list.innerHTML = "";
  if (locationGroups.length === 0) {
    list.innerHTML = `<p class="footnote" style="margin:0;text-align:left;">No groups yet — add one below.</p>`;
    return;
  }
  locationGroups.forEach((group, idx) => {
    const chip = document.createElement("span");
    chip.className = "loc-chip";
    chip.style.cssText = "cursor:default;display:inline-flex;align-items:center;gap:6px;";
    chip.innerHTML = `
      <span>${group.replace(/</g, "&lt;")}</span>
      <button type="button" data-remove-group="${idx}" aria-label="Remove ${group.replace(/"/g, "&quot;")}" style="background:none;border:none;color:inherit;cursor:pointer;font-size:0.95rem;line-height:1;padding:0;">×</button>
    `;
    list.appendChild(chip);
  });
  list.querySelectorAll("button[data-remove-group]").forEach((btn) => {
    btn.addEventListener("click", (e) => onRemoveGroup(Number(e.currentTarget.dataset.removeGroup)));
  });
}

function onAddGroup() {
  const input = document.getElementById("newGroupInput");
  const name = input.value.trim();
  if (!name || locationGroups.includes(name)) {
    input.value = "";
    return;
  }
  locationGroups.push(name);
  input.value = "";
  renderGroupsList();
  renderRows(); // each location row's Location Group <select> needs the new option available immediately, not just after a reload
}

function onRemoveGroup(idx) {
  const removed = locationGroups[idx];
  locationGroups.splice(idx, 1);
  // Any location currently tagged with the removed group has it dropped
  // from its list rather than silently keeping a value that no longer
  // appears anywhere as a selectable option — other groups it has stay
  // untouched.
  for (const loc of locations) {
    if (Array.isArray(loc.locationGroups)) {
      loc.locationGroups = loc.locationGroups.filter((g) => g !== removed);
    }
  }
  renderGroupsList();
  renderRows();
}

function setGroupsSaveStatus(text, isError) {
  const el = document.getElementById("groupsSaveStatus");
  el.textContent = text;
  el.style.color = isError ? "#dc2626" : "#16a34a";
}

async function onSaveGroups() {
  const conn = getConnection();
  if (!conn) {
    setGroupsSaveStatus("Connect to GitHub first (above) before saving.", true);
    return;
  }
  setGroupsSaveStatus("Saving…");
  try {
    // Re-check the current sha immediately before writing — same
    // reasoning as onSave() below for locations.json (in case the file
    // changed elsewhere since it was loaded), plus the common case here
    // of this being a brand-new file that doesn't exist in the repo yet.
    const getRes = await fetch(`${GITHUB_API}/repos/${conn.owner}/${conn.repo}/contents/${GROUPS_FILE_PATH}?ref=${BRANCH}`, {
      headers: { Authorization: `Bearer ${conn.token}`, Accept: "application/vnd.github+json" },
    });
    if (getRes.status === 404) {
      groupsSha = null; // creating the file for the first time
    } else if (!getRes.ok) {
      throw new Error(`Could not read current file (${getRes.status})`);
    } else {
      groupsSha = (await getRes.json()).sha;
    }

    const content = JSON.stringify(locationGroups, null, 2) + "\n";
    const body = { message: "Update location groups via site", content: utf8ToBase64(content), branch: BRANCH };
    // sha omitted entirely when creating the file for the first time —
    // GitHub's API rejects an explicit sha:null on a create.
    if (groupsSha) body.sha = groupsSha;

    const putRes = await fetch(`${GITHUB_API}/repos/${conn.owner}/${conn.repo}/contents/${GROUPS_FILE_PATH}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${conn.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!putRes.ok) {
      const errBody = await putRes.json().catch(() => ({}));
      throw new Error(errBody.message || `GitHub returned ${putRes.status}`);
    }
    groupsSha = (await putRes.json()).content.sha;
    setGroupsSaveStatus("Saved to GitHub.");
  } catch (err) {
    console.error(err);
    setGroupsSaveStatus("Save failed: " + err.message, true);
  }
}

// --- Fishing Mark Lists (Settings tab) --------------------------------------
//
// Same read/render/add/remove/save shape as Location Groups just above, just
// two-dimensional: markLists is a flat {field, value, color?} array (see
// MARK_LIST_FIELDS in charts.js) covering ALL nine pick-list fields at
// once, rather than one array per field — one file, one sha, one save
// button, rather than nine of everything. The UI still renders it grouped
// by field (one card sub-section per field) so it reads as nine separate
// lists even though it's a single flat array underneath. `color`, when set
// (see onSetMarkListValueColor below), is just a plain hex string — purely
// a display preference for this Settings-tab chip and (for Species) this
// site's own map when nothing more specific has been chosen (see
// markStyleFor, charts.js).
//
// Two fields carry an ADDITIONAL, more specific property, each rendered as
// its own small <select> alongside the existing hex swatch (see
// renderMarkLists below) rather than free text or a colour wheel — a typo
// or an unsupported value here is exactly how two earlier attempts at the
// Lowrance export ended up wrong (see gpxSymForMark's own comment in
// sync.js for the full story):
//   - Species: `lowranceColor`, one of Lowrance's 7 real confirmed
//     waypoint colours (LOWRANCE_COLOR_OPTIONS below). OPT IN — a species
//     with none chosen keeps its plain hex `color` (or the map's hash
//     fallback) exactly as before, on the site's own map; the GPX export
//     falls back to a plain default for it too, same as before this
//     existed.
//   - Mark Type: `shape`, one of Lowrance's 3 real confirmed shapes
//     (LOWRANCE_SHAPE_OPTIONS below). OPT IN the same way — a Mark Type
//     with none chosen keeps the hardcoded default shape it always had
//     (see MARK_TYPE_DEFAULT_SHAPE(_NAME) in sync.js/charts.js).
// Both drive the Lowrance GPX export (sync.js) AND, once set, this site's
// own map (charts.js) — the whole point being that the two stay visually
// consistent with each other once Oliver's deliberately picked something,
// rather than each side guessing independently.

let markLists = [];
let markListsSha = null;

async function loadMarkLists() {
  const conn = getConnection();
  try {
    if (conn && conn.owner && conn.repo && conn.token) {
      const res = await fetch(`${GITHUB_API}/repos/${conn.owner}/${conn.repo}/contents/${MARK_LISTS_FILE_PATH}?ref=${BRANCH}`, {
        headers: { Authorization: `Bearer ${conn.token}`, Accept: "application/vnd.github+json" },
      });
      if (res.status === 404) {
        // Same as groups — perfectly normal the first time this feature is
        // used on a repo; starts empty and gets created on first Save.
        markLists = [];
        markListsSha = null;
      } else if (!res.ok) {
        throw new Error(`GitHub returned ${res.status}`);
      } else {
        const json = await res.json();
        markListsSha = json.sha;
        const decoded = decodeURIComponent(escape(atob(json.content.replace(/\n/g, ""))));
        markLists = JSON.parse(decoded);
      }
    } else {
      // No connection yet — fall back to the public static file, same as groups.
      const res = await fetch("config/mark_lists.json", { cache: "no-store" });
      markLists = res.ok ? await res.json() : [];
    }
  } catch (err) {
    console.error(err);
    markLists = [];
  }
  document.getElementById("markListsSection").style.display = "block";
  renderMarkLists();
}

// Simple relative-luminance check so a chip's label text stays readable
// against WHATEVER background colour was picked (see
// onSetMarkListValueColor below) — light backgrounds get dark text, dark
// backgrounds get white text, rather than picking one fixed text colour
// that would go illegible against roughly half of all possible picks.
function pickReadableTextColor(hex) {
  const c = String(hex || "").replace("#", "");
  if (c.length !== 6) return "#374151"; // not a real hex colour — same grey .loc-chip already defaults to
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#111827" : "#ffffff";
}

function renderMarkLists() {
  const container = document.getElementById("markListsGroups");
  container.innerHTML = MARK_LIST_FIELDS.map(({ key, label }) => `
    <div class="mark-list-field-group" style="margin-bottom:16px;">
      <label class="loc-edit-label" style="display:block;margin-bottom:6px;">${label}</label>
      <div class="mark-list-chip-row" data-field="${key}" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <input type="text" class="mark-list-new-value" data-field="${key}" placeholder="Add a ${label.toLowerCase()} option"
          style="flex:1;min-width:160px;padding:8px 10px;border-radius:8px;border:1px solid var(--grey-200);" />
        <button type="button" class="btn-secondary mark-list-add-btn" data-field="${key}">+ Add</button>
      </div>
    </div>
  `).join("");

  // Filled in a second pass (rather than inline above) purely so each
  // field's "no options yet" empty-state and chip list can be computed
  // from `markLists` without repeating the same filter/join logic inline
  // in the template string eight times over.
  MARK_LIST_FIELDS.forEach(({ key, label }) => {
    const row = container.querySelector(`.mark-list-chip-row[data-field="${key}"]`);
    const values = markLists.filter((r) => r.field === label);
    if (values.length === 0) {
      row.innerHTML = `<p class="footnote" style="margin:0;text-align:left;">No options yet — add one below.</p>`;
      return;
    }
    row.innerHTML = values.map((v) => {
      const escAttr = v.value.replace(/"/g, "&quot;");
      const escText = v.value.replace(/</g, "&lt;");
      // Only overrides the chip's default white/grey look when a colour has
      // actually been picked for this value — an unset one still just looks
      // like every other .loc-chip until clicked.
      const colorStyle = v.color ? `background:${v.color};border-color:${v.color};color:${pickReadableTextColor(v.color)};` : "";
      // Species gets an extra, CONSTRAINED picker for the real Lowrance
      // colour (separate from the free hex `color` swatch above, which
      // keeps driving this chip's own look and the map's fallback colour
      // for anything that hasn't opted into a Lowrance one) — see
      // onSetMarkListValueLowranceColor's own comment for why this is a
      // <select> from a fixed list rather than free text or a colour
      // wheel. Mark Type gets the equivalent for `shape`. Neither renders
      // for any other field — this is squarely about driving the Lowrance
      // export (and, opt-in, this site's own map) consistently, not a
      // general-purpose feature every pick-list field needs.
      let extraPickerHtml = "";
      if (key === "species") {
        const current = v.lowranceColor || "";
        extraPickerHtml = `
        <select class="mark-list-lowrance-color-select" data-value="${escAttr}" title="Lowrance colour (optional)"
          style="font-size:0.7rem;padding:1px 3px;border-radius:5px;border:1px solid var(--grey-200);background:var(--white);color:var(--grey-500);">
          <option value=""${current ? "" : " selected"}>Lowrance colour…</option>
          ${LOWRANCE_COLOR_OPTIONS.map((c) => `<option value="${c}" ${c === current ? "selected" : ""}>${c}</option>`).join("")}
        </select>`;
      } else if (key === "type") {
        const current = v.shape || "";
        extraPickerHtml = `
        <select class="mark-list-shape-select" data-value="${escAttr}" title="Lowrance/map shape (optional)"
          style="font-size:0.7rem;padding:1px 3px;border-radius:5px;border:1px solid var(--grey-200);background:var(--white);color:var(--grey-500);">
          <option value=""${current ? "" : " selected"}>Shape…</option>
          ${LOWRANCE_SHAPE_OPTIONS.map((s) => `<option value="${s}" ${s === current ? "selected" : ""}>${s}</option>`).join("")}
        </select>`;
      }
      return `
      <span class="loc-chip mark-list-color-chip" data-field="${key}" data-value="${escAttr}" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px;${colorStyle}">
        <input type="color" class="mark-list-color-input" data-field="${key}" data-value="${escAttr}" value="${v.color || "#e5e7eb"}"
          aria-label="Pick a colour for ${escAttr}"
          style="position:absolute;width:0;height:0;padding:0;border:0;opacity:0;" />
        <span>${escText}</span>
        ${extraPickerHtml}
        <button type="button" data-remove-mark-value data-field="${key}" data-value="${escAttr}"
          aria-label="Remove ${escAttr}"
          style="background:none;border:none;color:inherit;cursor:pointer;font-size:0.95rem;line-height:1;padding:0;">×</button>
      </span>
    `;
    }).join("");
  });

  container.querySelectorAll("button[data-remove-mark-value]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      // Stops the click from also bubbling up into this same chip's own
      // click-to-open-the-colour-picker handler just below — removing a
      // value and immediately popping a colour picker for the (now gone)
      // chip underneath the cursor would be a confusing double-action from
      // one click.
      e.stopPropagation();
      onRemoveMarkListValue(e.currentTarget.dataset.field, e.currentTarget.dataset.value);
    });
  });
  // Clicking anywhere on a chip OTHER than its × button opens that value's
  // colour picker — done by forwarding the click to a visually-hidden
  // <input type="color"> rather than building a custom swatch picker from
  // scratch; every modern browser already has a perfectly good native one.
  container.querySelectorAll(".mark-list-color-chip").forEach((chip) => {
    chip.addEventListener("click", (e) => {
      // Also guards against a click landing on the new Lowrance
      // colour/shape <select> (species/type chips only) — those need
      // their own native dropdown to open normally, not this chip's hex
      // colour picker firing underneath/instead.
      if (e.target.closest("[data-remove-mark-value]")) return;
      if (e.target.closest(".mark-list-lowrance-color-select, .mark-list-shape-select")) return;
      const colorInput = chip.querySelector(".mark-list-color-input");
      if (colorInput) colorInput.click();
    });
  });
  container.querySelectorAll(".mark-list-color-input").forEach((input) => {
    // "change" (fires once the picker closes with a value committed), not
    // "input" (fires continuously while dragging inside the picker) — one
    // update per pick, not a flood of them.
    input.addEventListener("change", (e) => {
      onSetMarkListValueColor(e.currentTarget.dataset.field, e.currentTarget.dataset.value, e.currentTarget.value);
      renderMarkLists();
    });
  });
  container.querySelectorAll(".mark-list-lowrance-color-select").forEach((select) => {
    select.addEventListener("click", (e) => e.stopPropagation()); // don't also trigger the chip's own hex-picker click handler
    select.addEventListener("change", (e) => {
      onSetMarkListValueLowranceColor(e.currentTarget.dataset.value, e.currentTarget.value);
      renderMarkLists();
    });
  });
  container.querySelectorAll(".mark-list-shape-select").forEach((select) => {
    select.addEventListener("click", (e) => e.stopPropagation());
    select.addEventListener("change", (e) => {
      onSetMarkListValueShape(e.currentTarget.dataset.value, e.currentTarget.value);
      renderMarkLists();
    });
  });
  container.querySelectorAll(".mark-list-add-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => onAddMarkListValue(e.currentTarget.dataset.field));
  });
  // Enter-to-add, same convenience as the Location Groups input — rebound
  // each render since the inputs themselves are recreated by the innerHTML
  // replace above.
  container.querySelectorAll(".mark-list-new-value").forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onAddMarkListValue(e.currentTarget.dataset.field);
      }
    });
  });
}

function onAddMarkListValue(key) {
  const fieldDef = MARK_LIST_FIELDS.find((f) => f.key === key);
  if (!fieldDef) return;
  const input = document.querySelector(`.mark-list-new-value[data-field="${key}"]`);
  const value = input.value.trim();
  // Case-insensitive duplicate check — "whiting" typed after "Whiting"
  // already exists shouldn't silently create a second, near-identical
  // option that later filtering/export would treat as a different value.
  const exists = value && markLists.some((r) => r.field === fieldDef.label && r.value.toLowerCase() === value.toLowerCase());
  if (!value || exists) {
    input.value = "";
    return;
  }
  markLists.push({ field: fieldDef.label, value });
  input.value = "";
  renderMarkLists();
}

// Sets (or clears back to none, if `color` is falsy) the display colour for
// one specific value — e.g. "Whiting" under Species. Purely a local edit
// like Add/Remove above; still needs "Save mark lists" clicked afterward to
// actually commit it to config/mark_lists.json on GitHub. No cleanup of
// existing marks needed here (unlike the location-groups equivalent above):
// a mark just references the value string itself, never the colour, so
// recolouring (or un-colouring) an option doesn't touch anything that
// already used it.
function onSetMarkListValueColor(key, value, color) {
  const fieldDef = MARK_LIST_FIELDS.find((f) => f.key === key);
  if (!fieldDef) return;
  const entry = markLists.find((r) => r.field === fieldDef.label && r.value === value);
  if (entry) entry.color = color;
}

// Lowrance's own 7 real waypoint colours and 3 real shapes — confirmed
// directly against a real GPX export from Oliver's own HDS Live-7 (see
// gpxSymForMark's own header comment in sync.js for the full story). Used
// here to build the two CONSTRAINED pickers below (Species' `lowranceColor`
// and Mark Type's `shape`) — deliberately not free text or a native
// <input type="color">, which could produce a name the device doesn't
// actually recognise (exactly how this went wrong twice already).
const LOWRANCE_COLOR_OPTIONS = ["blue", "magenta", "red", "yellow", "green", "cyan", "white"];
const LOWRANCE_SHAPE_OPTIONS = ["circle", "diamond", "cross"];

/** Sets or clears a Species value's `lowranceColor` (colorName === "" means
 * "opt out, go back to this species' plain hex colour / hash fallback on
 * the map, and a plain default on export" — see markStyleFor, charts.js,
 * and gpxSymForMark, sync.js). Mirrors onSetMarkListValueColor's own shape
 * exactly, just a different property and a constrained value set rather
 * than a free hex string. */
function onSetMarkListValueLowranceColor(value, colorName) {
  const entry = markLists.find((r) => r.field === "Species" && r.value === value);
  if (!entry) return;
  if (colorName) entry.lowranceColor = colorName;
  else delete entry.lowranceColor;
}

/** Sets or clears a Mark Type value's `shape` (shapeName === "" means "opt
 * out, go back to this type's hardcoded default shape" — see
 * MARK_TYPE_DEFAULT_SHAPE(_NAME) in sync.js/charts.js). */
function onSetMarkListValueShape(value, shapeName) {
  const entry = markLists.find((r) => r.field === "Mark Type" && r.value === value);
  if (!entry) return;
  if (shapeName) entry.shape = shapeName;
  else delete entry.shape;
}

// Removing an option here does NOT scrub it from any mark that already used
// it (unlike onRemoveGroup's cleanup of locations above) — there's no marks
// editor on this page yet for it to reach into. That's a fine degrade for
// now: an existing mark keeping a since-removed value just won't offer that
// value as a pick again, it isn't broken or hidden.
function onRemoveMarkListValue(key, value) {
  const fieldDef = MARK_LIST_FIELDS.find((f) => f.key === key);
  if (!fieldDef) return;
  markLists = markLists.filter((r) => !(r.field === fieldDef.label && r.value === value));
  renderMarkLists();
}

function setMarkListsSaveStatus(text, isError) {
  const el = document.getElementById("markListsSaveStatus");
  el.textContent = text;
  el.style.color = isError ? "#dc2626" : "#16a34a";
}

async function onSaveMarkLists() {
  const conn = getConnection();
  if (!conn) {
    setMarkListsSaveStatus("Connect to GitHub first (above) before saving.", true);
    return;
  }
  setMarkListsSaveStatus("Saving…");
  try {
    // Re-check the current sha immediately before writing — same reasoning
    // as onSaveGroups (in case the file changed elsewhere, or doesn't exist
    // in the repo yet at all).
    const getRes = await fetch(`${GITHUB_API}/repos/${conn.owner}/${conn.repo}/contents/${MARK_LISTS_FILE_PATH}?ref=${BRANCH}`, {
      headers: { Authorization: `Bearer ${conn.token}`, Accept: "application/vnd.github+json" },
    });
    if (getRes.status === 404) {
      markListsSha = null; // creating the file for the first time
    } else if (!getRes.ok) {
      throw new Error(`Could not read current file (${getRes.status})`);
    } else {
      markListsSha = (await getRes.json()).sha;
    }

    const content = JSON.stringify(markLists, null, 2) + "\n";
    const body = { message: "Update fishing mark lists via site", content: utf8ToBase64(content), branch: BRANCH };
    if (markListsSha) body.sha = markListsSha; // omitted entirely on create — GitHub rejects an explicit sha:null

    const putRes = await fetch(`${GITHUB_API}/repos/${conn.owner}/${conn.repo}/contents/${MARK_LISTS_FILE_PATH}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${conn.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!putRes.ok) {
      const errBody = await putRes.json().catch(() => ({}));
      throw new Error(errBody.message || `GitHub returned ${putRes.status}`);
    }
    markListsSha = (await putRes.json()).content.sha;
    setMarkListsSaveStatus("Saved to GitHub.");
  } catch (err) {
    console.error(err);
    setMarkListsSaveStatus("Save failed: " + err.message, true);
  }
}

async function loadLocations() {
  const conn = getConnection();
  try {
    if (conn && conn.owner && conn.repo && conn.token) {
      const res = await fetch(`${GITHUB_API}/repos/${conn.owner}/${conn.repo}/contents/${FILE_PATH}?ref=${BRANCH}`, {
        headers: { Authorization: `Bearer ${conn.token}`, Accept: "application/vnd.github+json" },
      });
      if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
      const json = await res.json();
      currentSha = json.sha;
      const decoded = decodeURIComponent(escape(atob(json.content.replace(/\n/g, ""))));
      locations = JSON.parse(decoded);
      setStatus("Connected — editing live from GitHub");
    } else {
      // No connection yet — fall back to the public static file, read-only until connected
      const res = await fetch("config/locations.json", { cache: "no-store" });
      locations = await res.json();
      setStatus("Viewing current locations — connect above to edit");
    }
  } catch (err) {
    console.error(err);
    setStatus("Could not load locations: " + err.message, true);
    locations = [];
  }

  // Restore whichever location was last clicked/selected, by name — see
  // SELECTED_LOCATION_STORAGE_KEY/selectLocation. Done here (after
  // `locations` is fully populated, before the first renderRows()) rather
  // than in selectLocation itself, since this is the ONE case where
  // selectedLocationIdx is set without going through selectLocation — the
  // value's already in storage, so re-writing it right back via
  // selectLocation would just be a redundant no-op localStorage write on
  // every single page load.
  try {
    const savedName = localStorage.getItem(SELECTED_LOCATION_STORAGE_KEY);
    const idx = savedName ? locations.findIndex((l) => l.name === savedName) : -1;
    selectedLocationIdx = idx >= 0 ? idx : null;
  } catch {
    selectedLocationIdx = null;
  }

  document.getElementById("locationsSection").style.display = "block";
  renderRows();
}

function renderRows() {
  const list = document.getElementById("locationsList");
  list.innerHTML = "";
  locations.forEach((loc, i) => {
    if (!loc.types) loc.types = [];
    const activeTypeNames = loc.types.map((t) => t.type);

    const row = document.createElement("div");
    row.className = "window-card loc-edit-card";
    row.dataset.locRowIdx = i; // targeted by the map's marker clicks to scroll-to/highlight this row — see renderSettingsLocationMap
    row.innerHTML = `
      <div class="loc-edit-top">
        <div style="flex:2;min-width:180px;">
          <label class="loc-edit-label">Location name</label>
          <input type="text" data-field="name" data-idx="${i}" value="${(loc.name || "").replace(/"/g, "&quot;")}" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--grey-200);" />
        </div>
        <div style="min-width:100px;">
          <label class="loc-edit-label">Shore faces</label>
          <select data-field="shore" data-idx="${i}" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--grey-200);">
            ${SHORE_OPTIONS.map((s) => `<option value="${s}" ${loc.shore === s ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </div>
        <div style="min-width:200px;">
          <label class="loc-edit-label">Location Groups</label>
          <div class="grouptag-box" data-grouptag-idx="${i}">${groupTagBoxInnerHtml(i)}</div>
        </div>
        <div style="min-width:140px;display:flex;align-items:flex-end;padding-bottom:8px;">
          <label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;cursor:pointer;">
            <input type="checkbox" data-boolfield="tidal" data-idx="${i}" ${loc.tidal === false ? "" : "checked"} />
            Affected by tides
          </label>
        </div>
        <div style="min-width:130px;">
          <label class="loc-edit-label">Tide offset (min)</label>
          <input type="number" step="1" inputmode="numeric" data-numfield="tideOffset" data-idx="${i}"
            value="${loc.tideOffset != null ? loc.tideOffset : ""}" placeholder="0"
            title="Positive: this location's tide runs later than the matched station. Negative: earlier."
            style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--grey-200);" />
        </div>
        <button data-remove-loc="${i}" class="btn-secondary" style="height:38px;">Remove location</button>
      </div>

      <label class="loc-edit-label" style="display:block;margin:12px 0 6px;">Usable for</label>
      <div class="type-photo-row" style="max-width:340px;">
        ${TYPE_OPTIONS.map((type) => `
          <button type="button" class="type-photo-card${activeTypeNames.includes(type) ? " active" : ""}"
            data-toggle-type="${type}" data-idx="${i}">
            <img src="${type === "Kayak" ? "images/type-kayak.jpg" : "images/type-landbased.jpg"}" alt="${type}" />
            <span>${type}</span>
          </button>
        `).join("")}
      </div>

      <div class="loc-type-sections">
        ${loc.types.map((typeConfig, typeIdx) => renderTypeSection(loc, typeConfig, i, typeIdx)).join("")}
      </div>
    `;
    list.appendChild(row);
  });

  wireRowListeners(list);
  locations.forEach((_, i) => wireGroupTagBox(i));
  renderSettingsLocationMap();
  applyLocationFilter();
}

/**
 * Builds the Settings tab's map (renderLeafletLocationMap, charts.js) —
 * one marker per location (this list is already one entry per name,
 * unlike the Location tab's data, so no type-grouping needed here).
 * Clicking a marker scrolls to and briefly highlights (and filters down
 * to, via jumpToLocationRow/applyLocationFilter) that location's edit card
 * below. Clicking open map area, when "click to add" mode is armed (see
 * addLocationClickArmed / btnAddByMapClick), starts a brand-new location
 * anchored at that exact point instead — see onSettingsMapClick.
 */
function renderSettingsLocationMap() {
  const points = locations.map((loc, i) => {
    const types = (loc.types || []).map((t) => t.type);
    const iconKind = types.includes("Kayak") && types.includes("Land based") ? "both" : types.includes("Land based") ? "landBased" : "kayak";
    // Prefer the location's OWN lat/lng (present on anything added via the
    // map's "click to add" action — see onSettingsMapClick) over
    // locationCoords (data/conditions.json) — it's the admin's own chosen
    // point, available immediately with no refresh needed, and for a
    // brand-new location it's the ONLY coordinate that exists at all until
    // the next "Save & refresh data now" run. Legacy locations (added
    // before this feature existed, no lat/lng in config) still fall back
    // to locationCoords exactly as before.
    const coords = loc.lat != null && loc.lng != null ? loc : locationCoords[loc.name] || {};
    return {
      lat: coords.lat,
      lng: coords.lng,
      label: loc.name || "(unnamed)",
      iconKind,
      onClick: () => jumpToLocationRow(i),
    };
  });
  // Home isn't a fishing location — no edit card to jump to, so its
  // onClick is a no-op rather than pointing at a row that doesn't exist.
  if (homeLat != null && homeLng != null) {
    points.push({ lat: homeLat, lng: homeLng, label: "Home", iconKind: "home", onClick: () => {} });
  }
  renderLeafletLocationMap("settingsLocationMap", points, { onMapClick: onSettingsMapClick });
  document.getElementById("settingsLocationMap").classList.toggle("map-click-armed", addLocationClickArmed || addHomeClickArmed);
}

// True while the "📍 Add location" button is armed — the
// NEXT click on open map area (not a marker) starts a new location there;
// see onSettingsMapClick. A separate armed step (rather than every map
// click always adding a location) avoids accidentally creating locations
// while just panning/exploring the map, which is the map's much more
// common use on this page.
let addLocationClickArmed = false;

// Same idea as addLocationClickArmed, for the "🏠 Add Home" button — the
// two are mutually exclusive (arming one disarms the other; see both
// toggle functions below), since a single map click can only ever mean
// one or the other.
let addHomeClickArmed = false;

function toggleAddLocationClickMode() {
  addLocationClickArmed = !addLocationClickArmed;
  if (addLocationClickArmed && addHomeClickArmed) {
    addHomeClickArmed = false;
    const homeBtn = document.getElementById("btnAddHome");
    if (homeBtn) {
      homeBtn.textContent = "🏠 Add Home";
      homeBtn.classList.remove("active");
    }
  }
  const btn = document.getElementById("btnAddByMapClick");
  if (btn) {
    btn.textContent = addLocationClickArmed ? "Click the map to place it… (cancel)" : "📍 Add location";
    btn.classList.toggle("active", addLocationClickArmed);
  }
  const mapEl = document.getElementById("settingsLocationMap");
  if (mapEl) mapEl.classList.toggle("map-click-armed", addLocationClickArmed || addHomeClickArmed);
  // Re-run the filter so arming immediately hides whatever location was
  // previously shown (see the "armed" branch in applyLocationFilter) —
  // otherwise the old selection would keep showing right up until the map
  // is actually clicked, which reads as if arming did nothing at all.
  // Deliberately does NOT touch selectedLocationIdx/localStorage itself —
  // canceling (armed -> unarmed without a map click) falls straight back
  // to whatever was selected before arming, exactly as if nothing happened.
  applyLocationFilter();
}

function toggleAddHomeClickMode() {
  addHomeClickArmed = !addHomeClickArmed;
  if (addHomeClickArmed && addLocationClickArmed) {
    addLocationClickArmed = false;
    const locBtn = document.getElementById("btnAddByMapClick");
    if (locBtn) {
      locBtn.textContent = "📍 Add location";
      locBtn.classList.remove("active");
    }
  }
  const btn = document.getElementById("btnAddHome");
  if (btn) {
    btn.textContent = addHomeClickArmed ? "Click the map to place home… (cancel)" : "🏠 Add Home";
    btn.classList.toggle("active", addHomeClickArmed);
  }
  const mapEl = document.getElementById("settingsLocationMap");
  if (mapEl) mapEl.classList.toggle("map-click-armed", addLocationClickArmed || addHomeClickArmed);
  applyLocationFilter();
}

/**
 * Starts a brand-new location anchored at the exact point clicked on the
 * Settings map. If the willyweather-search Worker is configured (see
 * WILLYWEATHER_SEARCH_WORKER_URL), asks it what's actually near this point
 * first and lets the admin pick from real WillyWeather candidates — see
 * showLocationCandidatePicker below — rather than typing a name and hoping
 * it happens to text-match WillyWeather's own naming later. Either way,
 * ends by creating the location via createNewLocationAt.
 */
async function onSettingsMapClick(lat, lng) {
  if (addHomeClickArmed) {
    addHomeClickArmed = false;
    const btn = document.getElementById("btnAddHome");
    if (btn) {
      btn.textContent = "🏠 Add Home";
      btn.classList.remove("active");
    }
    document.getElementById("settingsLocationMap")?.classList.remove("map-click-armed");
    await saveHomeLocation(lat, lng);
    return;
  }

  if (!addLocationClickArmed) return;
  addLocationClickArmed = false;
  const btn = document.getElementById("btnAddByMapClick");
  if (btn) {
    btn.textContent = "📍 Add location";
    btn.classList.remove("active");
  }

  if (!WILLYWEATHER_SEARCH_WORKER_URL) {
    createNewLocationAt(lat, lng);
    return;
  }

  const candidates = await fetchWillyWeatherCandidates(lat, lng);
  if (!candidates || candidates.length === 0) {
    // Worker not reachable, not yet deployed, or genuinely nothing nearby
    // in WillyWeather's own database — fall back to exactly today's
    // behavior rather than blocking location creation on a live network
    // call that may simply not be available right now.
    createNewLocationAt(lat, lng);
    return;
  }

  const result = await showLocationCandidatePicker(candidates);
  if (result.action === "cancel") return;
  if (result.action === "pick") {
    createNewLocationAt(lat, lng, result.candidate);
  } else {
    createNewLocationAt(lat, lng);
  }
}

/**
 * Writes the clicked point to config/settings.json as homeLat/homeLng,
 * preserving whatever else is already in that file (googleRoutesApiKey)
 * — reads the file fresh immediately before writing (same "re-check the
 * sha right before a write, in case it changed elsewhere" reasoning as
 * onSaveGroups/onSave below), merges in the new coordinates, and writes
 * the whole file back. Updates the map immediately on success so the
 * house pin appears without needing a reload.
 */
async function saveHomeLocation(lat, lng) {
  const conn = getConnection();
  if (!conn) {
    alert("Connect to GitHub first (above) before setting a home address.");
    return;
  }
  try {
    const getRes = await fetch(`${GITHUB_API}/repos/${conn.owner}/${conn.repo}/contents/${SETTINGS_FILE_PATH}?ref=${BRANCH}`, {
      headers: { Authorization: `Bearer ${conn.token}`, Accept: "application/vnd.github+json" },
    });
    let currentSettings = {};
    let sha = null;
    if (getRes.status === 404) {
      sha = null; // creating the file for the first time
    } else if (!getRes.ok) {
      throw new Error(`Could not read current settings file (${getRes.status})`);
    } else {
      const json = await getRes.json();
      sha = json.sha;
      const decoded = decodeURIComponent(escape(atob(json.content.replace(/\n/g, ""))));
      currentSettings = JSON.parse(decoded);
    }

    currentSettings.homeLat = lat;
    currentSettings.homeLng = lng;

    const content = JSON.stringify(currentSettings, null, 2) + "\n";
    const body = { message: "Set home location via site", content: utf8ToBase64(content), branch: BRANCH };
    if (sha) body.sha = sha;

    const putRes = await fetch(`${GITHUB_API}/repos/${conn.owner}/${conn.repo}/contents/${SETTINGS_FILE_PATH}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${conn.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!putRes.ok) {
      const errBody = await putRes.json().catch(() => ({}));
      throw new Error(errBody.message || `GitHub returned ${putRes.status}`);
    }

    homeLat = lat;
    homeLng = lng;
    renderSettingsLocationMap();
  } catch (err) {
    alert(`Could not save home location: ${err.message}`);
  }
}

/**
 * The actual location-creation step, shared by both the "picked a real
 * WillyWeather candidate" and "entering a name manually" paths. `lat`/`lng`
 * are always the exact point clicked (see the "click to add" comment
 * above this whole flow) — the admin's own precision beats WillyWeather's
 * station/locality centroid regardless of which path got here. When a
 * candidate is supplied, its id/name/region/state are cached directly onto
 * the new location — see the WillyWeather id-caching tiers in
 * process_location(), fetch_conditions.py — meaning this location's very
 * FIRST scheduled run already has a confirmed id and never needs to search
 * for it at all, not even once.
 */
function createNewLocationAt(lat, lng, candidate) {
  const newLoc = {
    name: candidate ? candidate.name : "",
    shore: "N",
    types: [defaultTypeConfig("Kayak")],
    lat,
    lng,
  };
  if (candidate) {
    newLoc.willyweatherId = candidate.id;
    newLoc.willyweatherName = candidate.name;
    newLoc.willyweatherRegion = candidate.region;
    newLoc.willyweatherState = candidate.state;
  }
  locations.push(newLoc);
  selectLocation(locations.length - 1);
  renderRows();

  // Focus straight into the name field of the new (now the only visible,
  // thanks to selectedLocationIdx/applyLocationFilter) card. When a
  // candidate was picked, the name field is already pre-filled with
  // WillyWeather's own name — still focused (and left editable, not
  // disabled) since a custom personal label is fine too; only the cached
  // willyweatherId above actually matters for data-fetching accuracy, not
  // whatever this field says.
  const newRow = document.querySelector(`.loc-edit-card[data-loc-row-idx="${selectedLocationIdx}"]`);
  const nameInput = newRow && newRow.querySelector('input[data-field="name"]');
  if (nameInput) nameInput.focus();
}

function jumpToLocationRow(idx) {
  selectLocation(idx);
  const row = document.querySelector(`.loc-edit-card[data-loc-row-idx="${idx}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("loc-edit-card-highlight");
  setTimeout(() => row.classList.remove("loc-edit-card-highlight"), 1800);
}

/**
 * Shows only the card matching selectedLocationIdx and hides every other
 * one, plus a small "Show all locations" banner above the list to get back
 * out of the filtered view. While "click map to add location" is armed
 * (addLocationClickArmed), hides EVERY card instead — there's no location
 * to show yet, only a pending click, and leaving the previous selection
 * visible would look like arming did nothing. Pure show/hide against the
 * ALREADY-RENDERED DOM — deliberately not a call to renderRows(), which
 * would also rebuild the Leaflet map (see renderSettingsLocationMap) and
 * reset its pan/zoom on every single marker click, which would fight with
 * the very map click that triggered this in the first place. Called after
 * a marker click (via jumpToLocationRow), after arming/disarming "click to
 * add" (via toggleAddLocationClickMode), and at the end of every
 * renderRows(), so a structural change elsewhere (toggling a type, editing
 * while filtered) re-applies the same filter instead of silently dropping
 * it.
 */
function applyLocationFilter() {
  const list = document.getElementById("locationsList");
  if (!list) return;

  if (addLocationClickArmed) {
    list.querySelectorAll(".loc-edit-card").forEach((card) => {
      card.style.display = "none";
    });
    showLocationFilterBanner(
      "Click the map to place your new location…",
      "Cancel",
      () => toggleAddLocationClickMode()
    );
    return;
  }

  list.querySelectorAll(".loc-edit-card").forEach((card) => {
    const idx = Number(card.dataset.locRowIdx);
    card.style.display = selectedLocationIdx === null || idx === selectedLocationIdx ? "" : "none";
  });

  if (selectedLocationIdx === null || !locations[selectedLocationIdx]) {
    removeLocationFilterBanner();
    return;
  }
  const loc = locations[selectedLocationIdx];
  showLocationFilterBanner(
    `Showing only <strong>${(loc.name || "(unnamed)").replace(/</g, "&lt;")}</strong>`,
    "Show all locations",
    () => selectLocation(null)
  );
}

/**
 * Shared banner element for both applyLocationFilter states above ("armed,
 * waiting for a map click" and "filtered to one saved location") — same
 * spot in the DOM, same look, just different message/button text/action,
 * so there's only ever at most one such banner rather than two competing
 * pieces of UI stacking on top of each other.
 */
function showLocationFilterBanner(messageHtml, buttonLabel, onButtonClick) {
  const list = document.getElementById("locationsList");
  let banner = document.getElementById("locationFilterBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "locationFilterBanner";
    banner.className = "summary-card";
    banner.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px;padding:10px 14px;";
    list.parentNode.insertBefore(banner, list);
  }
  banner.innerHTML = `
    <span style="font-size:0.9rem;">${messageHtml}</span>
    <button type="button" id="locationFilterBannerBtn" class="btn-secondary">${buttonLabel}</button>
  `;
  document.getElementById("locationFilterBannerBtn").addEventListener("click", onButtonClick);
}

function removeLocationFilterBanner() {
  const banner = document.getElementById("locationFilterBanner");
  if (banner) banner.remove();
}

function renderTypeSection(loc, typeConfig, locIdx, typeIdx) {
  const fields = TYPE_TIME_FIELDS[typeConfig.type] || [];
  return `
    <div class="loc-type-section">
      <div class="loc-type-section-header">
        ${typeIconSvg(typeConfig.type, 15)}
        <label class="loc-edit-label" style="margin:0;">${typeConfig.type} timings (duration, hours : minutes)</label>
      </div>
      <div class="loc-time-grid">
        ${fields.map((f) => {
          const { h, m } = parseHM(typeConfig[f.key]);
          return `
          <div>
            <label class="loc-edit-label">${f.label}</label>
            <div class="hm-pair">
              <input type="number" min="0" max="23" step="1" inputmode="numeric" data-hmfield="${f.key}" data-hmpart="h" data-idx="${locIdx}" data-typeidx="${typeIdx}" value="${h}" aria-label="${f.label} hours" />
              <span class="hm-sep">:</span>
              <input type="number" min="0" max="59" step="1" inputmode="numeric" data-hmfield="${f.key}" data-hmpart="m" data-idx="${locIdx}" data-typeidx="${typeIdx}" value="${String(m).padStart(2, "0")}" aria-label="${f.label} minutes" />
            </div>
          </div>
        `;
        }).join("")}
      </div>

      ${typeConfig.type === "Kayak" ? `
      <label class="loc-edit-label" style="display:block;margin:12px 0 6px;">Minimum tide height for access (m) — leave blank if not applicable</label>
      <input type="number" min="0" step="0.1" inputmode="decimal" data-typefield="minTideHeight" data-idx="${locIdx}" data-typeidx="${typeIdx}"
        value="${typeConfig.minTideHeight != null ? typeConfig.minTideHeight : ""}"
        placeholder="e.g. 1.2"
        style="width:140px;padding:8px 10px;border-radius:8px;border:1px solid var(--grey-200);" />
      ` : ""}
    </div>
  `;
}

/**
 * Renders just the INSIDE of one location's Location Groups tag box
 * (existing chips + the empty input + an empty suggestions container) —
 * called both when first building a row (renderRows) and whenever that
 * one location's groups change (refreshGroupTagBox), so adding/removing a
 * tag only ever touches its own box rather than re-rendering every
 * location row on the page (which would lose scroll position/focus
 * elsewhere on a long list).
 */
function groupTagBoxInnerHtml(idx) {
  const loc = locations[idx];
  const groups = Array.isArray(loc.locationGroups) ? loc.locationGroups : [];
  const chipsHtml = groups
    .map(
      (g) => `
    <span class="grouptag-chip">
      ${g.replace(/</g, "&lt;")}
      <button type="button" data-remove-grouptag data-group="${g.replace(/"/g, "&quot;")}" aria-label="Remove ${g.replace(/"/g, "&quot;")}">×</button>
    </span>
  `
    )
    .join("");
  return `
    <div class="grouptag-chips">${chipsHtml}</div>
    <input type="text" class="grouptag-input" placeholder="Add group…" autocomplete="off" />
    <div class="grouptag-suggestions"></div>
  `;
}

function refreshGroupTagBox(idx) {
  const box = document.querySelector(`.grouptag-box[data-grouptag-idx="${idx}"]`);
  if (!box) return;
  box.innerHTML = groupTagBoxInnerHtml(idx);
  wireGroupTagBox(idx);
}

/**
 * Wires up one location's Location Groups tag box: typing filters a
 * dropdown of not-yet-assigned groups (from the master locationGroups
 * list managed in the section above — this is deliberately NOT a free-text
 * field for inventing new group names on the fly, only existing ones are
 * ever suggested), clicking a suggestion adds it, × on a chip removes it.
 */
function wireGroupTagBox(idx) {
  const box = document.querySelector(`.grouptag-box[data-grouptag-idx="${idx}"]`);
  if (!box) return;
  const loc = locations[idx];
  const input = box.querySelector(".grouptag-input");
  const suggestionsEl = box.querySelector(".grouptag-suggestions");

  function currentGroups() {
    if (!Array.isArray(loc.locationGroups)) loc.locationGroups = [];
    return loc.locationGroups;
  }

  function showSuggestions() {
    const query = input.value.trim().toLowerCase();
    const assigned = new Set(currentGroups());
    const matches = locationGroups.filter((g) => !assigned.has(g) && (!query || g.toLowerCase().includes(query)));
    if (matches.length === 0) {
      suggestionsEl.style.display = "none";
      suggestionsEl.innerHTML = "";
      return;
    }
    suggestionsEl.innerHTML = matches
      .map((g) => `<button type="button" class="grouptag-suggestion" data-add-group="${g.replace(/"/g, "&quot;")}">${g.replace(/</g, "&lt;")}</button>`)
      .join("");
    suggestionsEl.style.display = "block";
    suggestionsEl.querySelectorAll("button[data-add-group]").forEach((btn) => {
      // mousedown, not click — fires BEFORE the input's blur, so
      // preventDefault here stops focus ever leaving the input at all,
      // rather than racing a blur handler that would otherwise hide this
      // dropdown before a plain click on it could register.
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const group = e.currentTarget.dataset.addGroup;
        if (!currentGroups().includes(group)) currentGroups().push(group);
        input.value = "";
        refreshGroupTagBox(idx);
      });
    });
  }

  input.addEventListener("input", showSuggestions);
  input.addEventListener("focus", showSuggestions);
  input.addEventListener("blur", () => {
    suggestionsEl.style.display = "none";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      suggestionsEl.style.display = "none";
      input.blur();
    }
  });

  box.querySelectorAll("button[data-remove-grouptag]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const group = e.currentTarget.dataset.group;
      loc.locationGroups = currentGroups().filter((g) => g !== group);
      refreshGroupTagBox(idx);
    });
  });
}

function wireRowListeners(list) {
  list.querySelectorAll("input[data-field], select[data-field]").forEach((el) => {
    el.addEventListener("input", (e) => {
      const idx = Number(e.target.dataset.idx);
      const field = e.target.dataset.field;
      locations[idx][field] = e.target.value;
    });
  });

  list.querySelectorAll("input[data-boolfield]").forEach((el) => {
    el.addEventListener("change", (e) => {
      const idx = Number(e.target.dataset.idx);
      const field = e.target.dataset.boolfield;
      locations[idx][field] = e.target.checked;
    });
  });

  // Location-level numeric fields (as opposed to data-typefield, which is
  // per-type) — same "store a real number, not the string every input's
  // .value naturally is" reasoning: fetch_conditions.py does arithmetic
  // with this (a timedelta of minutes), which a quoted JSON string would
  // break.
  list.querySelectorAll("input[data-numfield]").forEach((el) => {
    el.addEventListener("input", (e) => {
      const idx = Number(e.target.dataset.idx);
      const field = e.target.dataset.numfield;
      locations[idx][field] = e.target.value === "" ? null : parseFloat(e.target.value);
    });
  });

  list.querySelectorAll("input[data-typefield]").forEach((el) => {
    el.addEventListener("input", (e) => {
      const idx = Number(e.target.dataset.idx);
      const typeIdx = Number(e.target.dataset.typeidx);
      const field = e.target.dataset.typefield;
      // Store a real number (or null if cleared) rather than the raw
      // string every input's .value naturally is — otherwise this would
      // save as a quoted string in the JSON, breaking numeric comparisons
      // downstream (chart threshold-line math, Python min/max logic).
      locations[idx].types[typeIdx][field] = e.target.value === "" ? null : parseFloat(e.target.value);
    });
  });

  list.querySelectorAll("input[data-hmfield]").forEach((el) => {
    el.addEventListener("input", (e) => {
      const idx = Number(e.target.dataset.idx);
      const typeIdx = Number(e.target.dataset.typeidx);
      const field = e.target.dataset.hmfield;
      const part = e.target.dataset.hmpart;
      const typeConfig = locations[idx].types[typeIdx];
      const current = parseHM(typeConfig[field]);
      const raw = Math.max(0, Math.floor(Number(e.target.value) || 0));
      if (part === "h") current.h = Math.min(23, raw);
      else current.m = Math.min(59, raw);
      typeConfig[field] = formatHM(current.h, current.m);
    });
  });

  list.querySelectorAll("button[data-remove-loc]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = Number(e.currentTarget.dataset.removeLoc);
      locations.splice(idx, 1);
      // Indices shift after a removal, so any active filter would now
      // point at the wrong (or a nonexistent) card — clear it (and its
      // persisted copy, via selectLocation) rather than risk showing the
      // wrong location or an empty filtered view.
      selectLocation(null);
      renderRows();
    });
  });

  list.querySelectorAll("button[data-toggle-type]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = Number(e.currentTarget.dataset.idx);
      const type = e.currentTarget.dataset.toggleType;
      const loc = locations[idx];
      const existingIdx = loc.types.findIndex((t) => t.type === type);
      if (existingIdx >= 0) {
        // Don't allow removing the LAST type — a location needs at least
        // one, otherwise it has no timings/scoring at all.
        if (loc.types.length <= 1) return;
        loc.types.splice(existingIdx, 1);
      } else {
        loc.types.push(defaultTypeConfig(type));
      }
      renderRows();
    });
  });
}

function onConnect() {
  const owner = document.getElementById("ghOwner").value.trim();
  const repo = document.getElementById("ghRepo").value.trim();
  const token = document.getElementById("ghToken").value.trim();
  if (!owner || !repo || !token) {
    setStatus("Fill in username, repo, and token first", true);
    return;
  }
  localStorage.setItem("ghConnection", JSON.stringify({ owner, repo, token }));
  loadLocations();
}

function onDisconnect() {
  localStorage.removeItem("ghConnection");
  document.getElementById("ghOwner").value = "";
  document.getElementById("ghRepo").value = "";
  document.getElementById("ghToken").value = "";
  currentSha = null;
  loadLocations();
}

function validateLocations() {
  for (const loc of locations) {
    if (!loc.name || !loc.name.trim()) return "Every location needs a name";
    if (!SHORE_OPTIONS.includes(loc.shore)) return `"${loc.name}" needs a valid Shore`;
    if (!loc.types || loc.types.length === 0) return `"${loc.name}" needs at least one type (Kayak or Land based)`;
    for (const t of loc.types) {
      if (!TYPE_OPTIONS.includes(t.type)) return `"${loc.name}" has an invalid type`;
    }
  }
  return null;
}

async function onSave(alsoRefresh) {
  const conn = getConnection();
  if (!conn) {
    setSaveStatus("Connect to GitHub first (above) before saving.", true);
    return;
  }
  const problem = validateLocations();
  if (problem) {
    setSaveStatus(problem, true);
    return;
  }

  // Native time inputs return "" if left untouched/cleared — normalize to
  // "00:00" so every saved type variant always has a valid HH:MM value for
  // all of its applicable fields.
  for (const loc of locations) {
    for (const t of loc.types) {
      for (const f of TYPE_TIME_FIELDS[t.type] || []) {
        if (!t[f.key]) t[f.key] = "00:00";
      }
    }
  }

  setSaveStatus("Saving…");
  try {
    // Re-fetch the current sha immediately before writing, in case the file changed elsewhere
    const getRes = await fetch(`${GITHUB_API}/repos/${conn.owner}/${conn.repo}/contents/${FILE_PATH}?ref=${BRANCH}`, {
      headers: { Authorization: `Bearer ${conn.token}`, Accept: "application/vnd.github+json" },
    });
    if (!getRes.ok) throw new Error(`Could not read current file (${getRes.status})`);
    const getJson = await getRes.json();
    currentSha = getJson.sha;

    const content = JSON.stringify(locations, null, 2) + "\n";
    const putRes = await fetch(`${GITHUB_API}/repos/${conn.owner}/${conn.repo}/contents/${FILE_PATH}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${conn.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "Update locations via site",
        content: utf8ToBase64(content),
        sha: currentSha,
        branch: BRANCH,
      }),
    });
    if (!putRes.ok) {
      const errBody = await putRes.json().catch(() => ({}));
      throw new Error(errBody.message || `GitHub returned ${putRes.status}`);
    }
    const putJson = await putRes.json();
    currentSha = putJson.content.sha;
    setSaveStatus("Saved to GitHub.");

    if (alsoRefresh) {
      setSaveStatus("Saved. Triggering data refresh…");
      const dispatchRes = await fetch(
        `${GITHUB_API}/repos/${conn.owner}/${conn.repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${conn.token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ref: BRANCH }),
        }
      );
      if (!dispatchRes.ok) {
        setSaveStatus("Saved, but couldn't trigger the refresh automatically — run it manually from the Actions tab.", true);
      } else {
        setSaveStatus("Saved and refresh triggered — check the Actions tab, then the Conditions tab in a minute or two.");
      }
    }
  } catch (err) {
    console.error(err);
    setSaveStatus("Save failed: " + err.message, true);
  }
}

init();
