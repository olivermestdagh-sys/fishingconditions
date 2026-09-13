// utf8ToBase64 lives in charts.js (loaded before this file) — no longer
// used here (nothing on this page commits to GitHub any more), left
// there in case another feature needs it later. GROUPS_FILE_PATH stays
// here only as a comment anchor, same reasoning as before.
const GROUPS_FILE_PATH = "config/location_groups.json"; // no longer read/written by
                          // this file (see "v2: Location Groups" below) —
                          // kept only as a comment anchor; GROUPS_FILE_PATH
                          // itself is now unused dead code, left rather than
                          // hunting down whether anything else references it

// v2 user-backend Worker — same URL charts.js's own USER_BACKEND_URL
// declares (loaded before this file on every page that needs it); no
// longer declared here too — a duplicate top-level `const` of the same
// name across two scripts sharing one global scope is a fatal
// SyntaxError, not a harmless redeclaration, and it silently broke this
// entire file for a while (see README's "A serious bug, found and fixed"
// note) until caught by a real page-load test.

// Home address — a single site-wide lat/lng, now stored on Public's own
// D1 row (users.home_lat/home_lng — see schema-v2.sql) alongside
// google_routes_api_key, rather than config/settings.json. Set via the
// map ("Add Home" button below), read once on load so its pin can show
// immediately if already set — see loadHomeLocation/saveHomeLocation.
// This is the LAST piece of this page that used to need the GitHub
// token — see README's "Home address and Refresh data now" section for
// the full story of what replaced it and why.
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
let locationGroups = []; // plain group-name strings — kept in this shape for
                          // backward compat with every other place on this
                          // page that reads it (e.g. the per-location group
                          // tag picker below), even though it's now sourced
                          // from D1's user_location_groups, not GROUPS_FILE_PATH
let groupNameToId = new Map(); // name -> D1 row id, needed only by this
                          // section's own add/remove calls below
let currentUser = null;  // result of checkSignedIn() — null if not signed in
                          // at all, regardless of role. Location Groups,
                          // Fishing Mark Lists, and Locations are now
                          // available to ANY signed-in user (each seeing
                          // their own data by default) — not Admin-only
                          // any more; see isAdmin/viewingAsPublic below
                          // for what IS still Admin-specific.
let isAdmin = false;      // derived from currentUser.role === "admin" — gates
                          // the "View as Public" toggle and the Home
                          // address / Refresh data now sections, nothing else
let viewingAsPublic = false; // Admin-only toggle state — when true, every
                          // section below (Groups/Mark Lists/Locations/
                          // Check frequency) operates on Public's data
                          // instead of the signed-in Admin's own. See
                          // effectiveUserIdParam() and onToggleViewAsPublic.

/**
 * Every fetch to a v2/v1-with-override endpoint appends this instead of a
 * hardcoded ?userId=public — returns "" (meaning "act as myself", the
 * default every endpoint already falls back to when the param is omitted)
 * unless an Admin has flipped viewingAsPublic on, in which case it
 * returns "?userId=public" so every one of those same calls acts on
 * Public's rows instead. A non-admin's viewingAsPublic can never be true
 * (see onToggleViewAsPublic — the button that sets it doesn't render for
 * anyone else), so this is safe to call unconditionally everywhere below.
 */
function effectiveUserIdParam() {
  return isAdmin && viewingAsPublic ? "?userId=public" : "";
}

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



/**
 * Makes a whole <section>'s content foldable — automatically, without
 * needing to hand-restructure that section's own existing HTML:
 * everything inside `sectionEl` AFTER its own heading (its first child)
 * gets moved into one wrapper div the first time this runs, and clicking
 * the heading toggles that wrapper's visibility from then on. Safe to
 * call again on the same element (e.g. every time a dynamically-rendered
 * group gets rebuilt from scratch) — the wrapper is recreated fresh each
 * time regardless, but the COLLAPSED STATE itself lives in localStorage,
 * not in the DOM, so a re-render never loses whether it was open or
 * closed. Remembered per section (`storageKey`) — same "remember what you
 * last had it set to" convention already used elsewhere on this site
 * (view/filter persistence) — the Settings tab's own list of sections and
 * sub-lists keeps growing, so this is about keeping the ones you're not
 * using right now out of the way rather than scrolling past all of them
 * every time.
 */
function makeCollapsible(sectionEl, storageKey, startCollapsed) {
  if (!sectionEl) return;
  const heading = sectionEl.firstElementChild;
  if (!heading) return;

  // Idempotent — safe to call more than once on the SAME persistent DOM
  // element (unlike the MARK_LIST_FIELDS field-groups, which get fully
  // recreated by container.innerHTML on every renderMarkLists() call, the
  // Mark Format group's own outer div is NOT rebuilt, just its inner rows
  // — so this runs again on every render there, and re-wrapping/re-adding
  // a second chevron each time would otherwise nest the content one level
  // deeper and show two chevrons per click.
  let wrapper = sectionEl.querySelector(":scope > .collapsible-content");
  let chevron = heading.querySelector(".collapse-chevron");
  const alreadyWired = wrapper && chevron;

  if (!wrapper) {
    wrapper = document.createElement("div");
    wrapper.className = "collapsible-content";
    Array.from(sectionEl.children)
      .slice(1)
      .forEach((el) => wrapper.appendChild(el));
    sectionEl.appendChild(wrapper);
  }
  if (!chevron) {
    heading.style.cursor = "pointer";
    heading.style.userSelect = "none";
    heading.style.display = "flex";
    heading.style.justifyContent = "space-between";
    heading.style.alignItems = "center";
    chevron = document.createElement("span");
    chevron.className = "collapse-chevron";
    chevron.style.fontSize = "0.75rem";
    chevron.style.fontWeight = "400";
    chevron.style.color = "var(--grey-500)";
    heading.appendChild(chevron);
  }

  const saved = localStorage.getItem(storageKey);
  let collapsed = saved != null ? saved === "1" : !!startCollapsed;
  const apply = () => {
    wrapper.style.display = collapsed ? "none" : "";
    chevron.textContent = collapsed ? "▸ Show" : "▾ Hide";
  };
  apply();
  if (!alreadyWired) {
    heading.addEventListener("click", () => {
      collapsed = !collapsed;
      localStorage.setItem(storageKey, collapsed ? "1" : "0");
      apply();
    });
  }
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
  // Every top-level section on this page, foldable — see makeCollapsible's
  // own comment on why. All start folded — Groups/Mark Lists/Locations are
  // now used by every signed-in user, not just Admin reviewing their own
  // curated set, so there's even less reason to default them open.
  makeCollapsible(document.getElementById("groupsSection"), "settingsCollapsed:groups", true);
  makeCollapsible(document.getElementById("markListsSection"), "settingsCollapsed:markLists", true);
  makeCollapsible(document.getElementById("locationsSection"), "settingsCollapsed:locations", true);

  document.getElementById("btnSignIn").addEventListener("click", () => {
    window.location.href = `${USER_BACKEND_URL}/auth/login`;
  });
  document.getElementById("btnSignOut").addEventListener("click", onSignOut);
  document.getElementById("btnSaveSettings").addEventListener("click", saveSettings);
  document.getElementById("btnToggleViewAsPublic").addEventListener("click", onToggleViewAsPublic);

  document.getElementById("btnAddByMapClick").addEventListener("click", toggleAddLocationClickMode);
  document.getElementById("btnAddHome").addEventListener("click", toggleAddHomeClickMode);
  document.getElementById("btnRefreshDataNow").addEventListener("click", onRefreshDataNow);

  document.getElementById("btnAddGroup").addEventListener("click", onAddGroup);
  document.getElementById("newGroupInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onAddGroup();
    }
  });
  document.getElementById("btnAddMarkShapeFormat").addEventListener("click", () => onAddMarkSubFormat("Mark Shape Format", "newMarkShapeFormatInput"));
  document.getElementById("btnAddMarkColorFormat").addEventListener("click", () => onAddMarkSubFormat("Mark Colour Format", "newMarkColorFormatInput"));

  await refreshPageForCurrentUser();
}

/**
 * Runs the ENTIRE sign-in-dependent page state — called from init() and
 * again from onSignOut/onToggleViewAsPublic, since either one changes
 * what every section below should be showing. Location Groups/Fishing
 * Mark Lists/Locations/Check frequency are now available to ANY signed-in
 * user; Home address/Refresh data now/the View-as-Public toggle itself
 * stay Admin-only (see isAdmin below) — those are site-wide concepts with
 * no per-user meaning, unaffected by viewingAsPublic.
 */
async function refreshPageForCurrentUser() {
  currentUser = await checkSignedIn();
  isAdmin = !!currentUser && currentUser.role === "admin";
  if (!isAdmin) viewingAsPublic = false; // can't be mid-toggle if sign-out happened, or a Basic account somehow reached this state

  const signedOutCard = document.getElementById("signedOutCard");
  const signedInCard = document.getElementById("signedInCard");
  const settingsSection = document.getElementById("settingsSection");
  const adminOnlyControls = document.getElementById("adminOnlyControls");
  const toggleBtn = document.getElementById("btnToggleViewAsPublic");

  if (!currentUser) {
    signedOutCard.style.display = "";
    signedInCard.style.display = "none";
    settingsSection.style.display = "none";
    adminOnlyControls.style.display = "none";
    setStatus("");
  } else {
    signedOutCard.style.display = "none";
    signedInCard.style.display = "";
    settingsSection.style.display = "";
    adminOnlyControls.style.display = isAdmin ? "" : "none";
    toggleBtn.style.display = isAdmin ? "" : "none";
    toggleBtn.textContent = viewingAsPublic ? "← Back to my account" : "View as Public →";
    document.getElementById("whoAmI").textContent = viewingAsPublic
      ? "Viewing as: Public (the free site's own data)"
      : `Signed in as ${currentUser.name ? `${currentUser.name} (${currentUser.email})` : currentUser.email}`;
    setStatus(viewingAsPublic ? "Viewing Public's settings and locations" : "Signed in");
  }

  await Promise.all([loadLocationGroups(), loadMarkLists(), loadLocations(), loadLocationCoords(), loadHomeLocation(), loadSettings()]);
}

async function onSignOut() {
  try {
    await fetch(`${USER_BACKEND_URL}/auth/logout`, { method: "POST", credentials: "include" });
  } catch (err) {
    console.error("Sign-out request failed:", err);
    // Still refresh below — even if the network call failed, re-checking
    // the actual sign-in state is more useful than assuming it worked.
  }
  await refreshPageForCurrentUser();
}

/**
 * Admin-only — flips whether every signed-in-gated section below
 * (Groups/Mark Lists/Locations/Check frequency) operates on Public's
 * data instead of the Admin's own. Nothing server-side changes about
 * WHO can do this — every affected endpoint already enforces the same
 * "only Admin may pass ?userId=public" rule (resolveEffectiveUserId,
 * user-backend.js) regardless of what this button shows; it only
 * controls what effectiveUserIdParam() sends from here on.
 */
async function onToggleViewAsPublic() {
  viewingAsPublic = !viewingAsPublic;
  await refreshPageForCurrentUser();
}

// ---------------------------------------------------------------------
// Check frequency — the v1 user_settings table (check-frequency
// scheduling), now supporting the same Admin ?userId= override as
// everything else (see handleSettings, user-backend.js) even though
// there's no scheduler yet to act on ANY user's setting, Public's
// included — kept consistent with every other toggled section rather
// than being the one exception.
// ---------------------------------------------------------------------

async function loadSettings() {
  if (!currentUser) return;
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/settings${effectiveUserIdParam()}`, { credentials: "include" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const settings = await res.json();
    document.getElementById("checkFrequency").value = settings.checkFrequencyMinutes;
    document.getElementById("windowStart").value = settings.activeWindowStart;
    document.getElementById("windowEnd").value = settings.activeWindowEnd;
  } catch (err) {
    console.error("Failed to load settings:", err);
    setSettingsStatus("Couldn't load settings — try reloading the page.", true);
  }
}

async function saveSettings() {
  const body = {
    checkFrequencyMinutes: parseInt(document.getElementById("checkFrequency").value, 10),
    activeWindowStart: document.getElementById("windowStart").value,
    activeWindowEnd: document.getElementById("windowEnd").value,
  };
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/settings${effectiveUserIdParam()}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `status ${res.status}`);
    }
    setSettingsStatus("Saved.", false);
  } catch (err) {
    console.error("Failed to save settings:", err);
    setSettingsStatus(`Couldn't save: ${err.message}`, true);
  }
}

function setSettingsStatus(text, isError) {
  const el = document.getElementById("settingsStatus");
  el.textContent = text;
  el.style.color = isError ? "var(--red-600, #c0392b)" : "var(--grey-500)";
}

/**
 * Reads Public's own home_lat/home_lng from D1 (GET /api/public/settings,
 * unauthenticated — same trust model config/settings.json always had)
 * once on load, purely to show the home pin immediately if one's already
 * set. A missing/failed read just means no home is set yet — not an
 * error worth surfacing, same as before.
 */
async function loadHomeLocation() {
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/public/settings`, { cache: "no-store" });
    const settings = res.ok ? await res.json() : {};
    homeLat = settings.homeLat ?? null;
    homeLng = settings.homeLng ?? null;
  } catch (err) {
    console.error("Could not load home location:", err);
    homeLat = null;
    homeLng = null;
  }
}

/**
 * v2: Location Groups now live in D1 (user_location_groups, scoped to the
 * 'public' user — see schema-v2.sql and user-backend.js) rather than
 * GROUPS_FILE_PATH, and are gated on Google Admin sign-in (checkAdmin())
 * instead of the GitHub token this page's other sections still use. Every
 * add/remove below hits the API immediately — there's no batch "Save
 * groups" step any more (no sha to track, unlike a GitHub commit).
 *
 * locationGroups itself STAYS a flat array of plain name strings — every
 * other place on this page that reads it (renderRows's per-location group
 * picker, onRemoveGroup's own cleanup of loc.locationGroups below) expects
 * that shape and is untouched this round. groupNameToId is the only new
 * piece of state, holding each name's real D1 id purely so this section's
 * own add/remove calls know which row to hit.
 */
async function loadLocationGroups() {
  if (!currentUser) {
    locationGroups = [];
    groupNameToId = new Map();
    document.getElementById("groupsSection").style.display = "none";
    return;
  }
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/groups${effectiveUserIdParam()}`, { credentials: "include" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const rows = await res.json();
    groupNameToId = new Map(rows.map((r) => [r.name, r.id]));
    locationGroups = rows.map((r) => r.name);
  } catch (err) {
    console.error("Failed to load location groups:", err);
    locationGroups = [];
    groupNameToId = new Map();
    setGroupsSaveStatus("Couldn't load groups — try reloading the page.", true);
  }
  document.getElementById("groupsSection").style.display = "block";
  document.getElementById("groupsSignedOut").style.display = "none";
  document.getElementById("groupsEditor").style.display = "block";
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

async function onAddGroup() {
  const input = document.getElementById("newGroupInput");
  const name = input.value.trim();
  if (!name || locationGroups.includes(name)) {
    input.value = "";
    return;
  }
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/groups${effectiveUserIdParam()}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `status ${res.status}`);
    }
    const created = await res.json();
    groupNameToId.set(created.name, created.id);
    locationGroups.push(created.name);
    input.value = "";
    renderGroupsList();
    renderRows(); // each location row's Location Group <select> needs the new option available immediately, not just after a reload
    setGroupsSaveStatus("", false);
  } catch (err) {
    console.error("Failed to add group:", err);
    setGroupsSaveStatus("Couldn't add group: " + err.message, true);
  }
}

async function onRemoveGroup(idx) {
  const removed = locationGroups[idx];
  const id = groupNameToId.get(removed);
  if (!id) return; // shouldn't happen — nothing sane to do without a real row id
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/groups/${id}${effectiveUserIdParam()}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok && res.status !== 404) throw new Error(`status ${res.status}`);
  } catch (err) {
    console.error("Failed to remove group:", err);
    setGroupsSaveStatus("Couldn't remove group: " + err.message, true);
    return; // local state left untouched — don't drop it from the list if the server call actually failed
  }
  locationGroups.splice(idx, 1);
  groupNameToId.delete(removed);
  // Any location currently tagged with the removed group has it dropped
  // from its list rather than silently keeping a value that no longer
  // appears anywhere as a selectable option — other groups it has stay
  // untouched. (Still the old locations.json in-memory model this round —
  // see the file-level note on why Locations itself isn't migrated yet.)
  for (const loc of locations) {
    if (Array.isArray(loc.locationGroups)) {
      loc.locationGroups = loc.locationGroups.filter((g) => g !== removed);
    }
  }
  renderGroupsList();
  renderRows();
  setGroupsSaveStatus("", false);
}

function setGroupsSaveStatus(text, isError) {
  const el = document.getElementById("groupsSaveStatus");
  el.textContent = text;
  el.style.color = isError ? "#dc2626" : "#16a34a";
}

async function checkSignedIn() {
  try {
    const res = await fetch(`${USER_BACKEND_URL}/auth/me`, { credentials: "include" });
    if (!res.ok) return null; // not signed in — treated the same as any other failure here
    return await res.json();
  } catch (err) {
    console.error("Sign-in check failed:", err);
    return null;
  }
}

// --- Fishing Mark Lists (Settings tab) --------------------------------------
//
// Same read/render/add/remove/save shape as Location Groups just above, just
// two-dimensional: markLists is a flat {field, value, ...} array (see
// MARK_LIST_FIELDS in charts.js) covering ALL nine pick-list fields at
// once, rather than one array per field — one file, one sha, one save
// button, rather than nine of everything. The UI still renders it grouped
// by field (one card sub-section per field) so it reads as nine separate
// lists even though it's a single flat array underneath.
//
// EVERY value on EVERY field picks a Mark Shape Format AND a Mark Colour
// Format (see below) via two small <select>s next to its chip — a value
// with neither chosen just looks like a plain chip; one with a Colour
// Format picked shows that format's own "colour for the website" as its
// background (see resolveTileFormatColor below — shape has no colour of
// its own to contribute to a tile's look). There's no other way to colour
// a tile any more — an earlier version had a separate free hex colour
// picker (click the chip, native <input type="color">) alongside the
// Format picker, which meant a tile's look and its Format could disagree
// with each other; removed in favour of Colour Format being the single
// source of truth for how anything here looks, on this page AND on the
// map.
//
// MARK SHAPE FORMATS and MARK COLOUR FORMATS — two DIFFERENT kinds of
// entry in the same flat array (field: "Mark Shape Format" / "Mark Colour
// Format"), not among MARK_LIST_FIELDS' nine real per-mark fields, since a
// mark itself never HAS either property directly. REVISED from an earlier
// version that bundled shape and colour into a single "Mark Format"
// together — bundling meant assigning a species a colour ALSO silently
// overrode its shape (species winning over Mark Type, same priority
// either way), losing the "a Catch reads as a cross, a Mark reads as a
// circle, regardless of species" distinction the moment any species got a
// colour of its own. Splitting them into two independent lists fixes that
// (see resolveMarkShapeFormat/resolveMarkColorFormat, charts.js, for the
// full resolution logic, and renderMarkSubFormatList below for the shared
// render function both lists go through). Each Shape Format entry is a
// name plus `icon` (one of MARK_ICON_OPTIONS, for this site's own map)
// and `lowranceSym`/`garminSym` (the literal shape-only TEXT FRAGMENT each
// device's export should use); each Colour Format entry is a name plus
// `color` (a free, unrestricted hex — this map has no Lowrance-style
// colour-count limit) and its own `lowranceSym`/`garminSym` (the literal
// colour-only fragment). Both devices' fields are free text for now,
// deliberately, not a constrained picker — Oliver doesn't yet have either
// device's full accepted-value list (see gpxSymForMark's own comment in
// sync.js for why guessing at that list from secondary sources already
// went wrong more than once); a dropdown sourced from a real confirmed
// list is a natural upgrade here later, not a redesign. The two fragments
// get concatenated shape-then-colour with NO separator added by this
// code — each fragment already carries whatever punctuation it needs
// baked in (Oliver's own call, made once per Format).
//
// Species AND Mark Type values each carry `shapeFormat`/`colorFormat`
// properties (see onSetMarkListValueSubFormat below) instead of the
// single `format` an earlier version had them carry. OPT IN, same as
// before: a value with neither chosen keeps exactly the fallback
// behaviour it always had (plain hex `color`/hash on this site's map,
// hardcoded shape-by-Mark-Type and a plain default colour on export — see
// resolveMarkShapeFormat/resolveMarkColorFormat, charts.js, and their
// sync.js equivalents). Whenever BOTH a species and its mark's own Type
// have a Format assigned on the SAME axis, the SPECIES' wins (species is
// the more specific signal) — but Oliver's own explicit call is that a
// species-level SHAPE assignment is meant to stay the exception, not the
// everyday case (leave it unset and shape keeps coming from Mark Type as
// usual — a Catch still reads as a cross, a Mark still reads as a
// circle, regardless of species); a species-level COLOUR assignment, by
// contrast, is the everyday case this whole split exists for. Mark
// Type's own Format assignments (either axis) mainly matter for POI,
// which has no species to carry one of its own at all.

let markLists = []; // v2: sourced from /api/marklists (D1, 'public' user) — see
                     // "v2: Fishing Mark Lists" below. Each entry now also
                     // carries a real `id` from D1, used only by this
                     // section's own add/remove/update calls; every existing
                     // read of this array elsewhere (filter by field/value)
                     // is untouched and still works exactly as before.

/**
 * v2: Fishing Mark Lists now live in D1 (user_mark_lists, scoped to the
 * 'public' user — see schema-v2.sql and user-backend.js) rather than
 * MARK_LISTS_FILE_PATH, gated on Google Admin sign-in (checkAdmin(),
 * shared with Location Groups above — both run from the same adminUser
 * check in init(), not two separate sign-in checks). Every add/remove/
 * edit below hits the API immediately, same as Groups — no more batch
 * "Save mark lists" step.
 *
 * KNOWN GAP, worth being upfront about: charts.js's own mark-rendering
 * code (map icon/colour resolution) still reads MARK_LISTS_FILE_PATH —
 * the static config/mark_lists.json file — directly, completely separate
 * from this admin-editing path. So an edit made here won't show up in how
 * marks actually render on the map/site until something (a future round)
 * either points that rendering code at this same API or writes D1's
 * mark lists back out to the static file. Not addressed this round.
 */
async function loadMarkLists() {
  if (!currentUser) {
    markLists = [];
    document.getElementById("markListsSection").style.display = "none";
    return;
  }
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/marklists${effectiveUserIdParam()}`, { credentials: "include" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    markLists = await res.json();
  } catch (err) {
    console.error("Failed to load mark lists:", err);
    markLists = [];
    setMarkListsSaveStatus("Couldn't load mark lists — try reloading the page.", true);
  }
  document.getElementById("markListsSection").style.display = "block";
  document.getElementById("markListsSignedOut").style.display = "none";
  document.getElementById("markListsEditor").style.display = "block";
  renderMarkLists();
}

// Simple relative-luminance check so a chip's label text stays readable
// against WHATEVER background colour a resolved Mark Format supplies (see
// resolveTileFormatColor above) — light backgrounds get dark text, dark
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
      // Tile colour comes from the assigned Mark COLOUR Format's own
      // "colour for the website" only — shape has no colour of its own to
      // contribute here (see resolveTileFormatColor below).
      const tileColor = resolveTileFormatColor(v);
      const colorStyle = tileColor ? `background:${tileColor};border-color:${tileColor};color:${pickReadableTextColor(tileColor)};` : "";
      // EVERY field's values get BOTH a Shape Format and a Colour Format
      // <select> (Oliver's own call) — though shape only actually
      // AFFECTS anything for Species/Mark Type (see resolveMarkShapeFormat,
      // charts.js): those are the only two fields a mark's actual shape
      // gets resolved from. Assigning a Shape Format to, say, a Weather
      // Condition value is harmless but currently inert — nothing reads
      // it back. Colour, by contrast, genuinely does apply everywhere (see
      // markStyleFor, charts.js) via whichever field the map happens to
      // be grouped by.
      const shapeNames = markLists.filter((r) => r.field === "Mark Shape Format").map((r) => r.value);
      const colorNames = markLists.filter((r) => r.field === "Mark Colour Format").map((r) => r.value);
      const currentShape = v.shapeFormat || "";
      const currentColor = v.colorFormat || "";
      const shapeSelectHtml = `
        <select class="mark-list-shapeformat-select" data-field-label="${label}" data-value="${escAttr}" title="Mark Shape Format (optional)"
          style="font-size:0.7rem;padding:1px 3px;border-radius:5px;border:1px solid var(--grey-200);background:var(--white);color:var(--grey-500);">
          <option value=""${currentShape ? "" : " selected"}>Shape…</option>
          ${shapeNames.map((f) => `<option value="${f.replace(/"/g, "&quot;")}" ${f === currentShape ? "selected" : ""}>${f.replace(/</g, "&lt;")}</option>`).join("")}
        </select>`;
      const colorSelectHtml = `
        <select class="mark-list-colorformat-select" data-field-label="${label}" data-value="${escAttr}" title="Mark Colour Format (optional)"
          style="font-size:0.7rem;padding:1px 3px;border-radius:5px;border:1px solid var(--grey-200);background:var(--white);color:var(--grey-500);">
          <option value=""${currentColor ? "" : " selected"}>Colour…</option>
          ${colorNames.map((f) => `<option value="${f.replace(/"/g, "&quot;")}" ${f === currentColor ? "selected" : ""}>${f.replace(/</g, "&lt;")}</option>`).join("")}
        </select>`;
      return `
      <span class="loc-chip" data-field="${key}" data-value="${escAttr}" style="display:inline-flex;align-items:center;gap:6px;${colorStyle}">
        <span>${escText}</span>
        ${shapeSelectHtml}
        ${colorSelectHtml}
        <button type="button" data-remove-mark-value data-field="${key}" data-value="${escAttr}"
          aria-label="Remove ${escAttr}"
          style="background:none;border:none;color:inherit;cursor:pointer;font-size:0.95rem;line-height:1;padding:0;">×</button>
      </span>
    `;
    }).join("");
  });

  container.querySelectorAll("button[data-remove-mark-value]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      onRemoveMarkListValue(e.currentTarget.dataset.field, e.currentTarget.dataset.value);
    });
  });
  container.querySelectorAll(".mark-list-shapeformat-select").forEach((select) => {
    select.addEventListener("change", (e) => {
      onSetMarkListValueSubFormat(e.currentTarget.dataset.fieldLabel, e.currentTarget.dataset.value, "shapeFormat", e.currentTarget.value);
      renderMarkLists();
    });
  });
  container.querySelectorAll(".mark-list-colorformat-select").forEach((select) => {
    select.addEventListener("change", (e) => {
      onSetMarkListValueSubFormat(e.currentTarget.dataset.fieldLabel, e.currentTarget.dataset.value, "colorFormat", e.currentTarget.value);
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

  renderMarkSubFormatList("Mark Shape Format", "markShapeFormatsRows", "newMarkShapeFormatInput");
  renderMarkSubFormatList("Mark Colour Format", "markColorFormatsRows", "newMarkColorFormatInput");

  // Each of these eleven sub-lists gets its own fold, same reasoning as
  // the top-level sections in init() — this is specifically the "growing
  // list" this whole feature was asked to address, so these default to
  // COLLAPSED regardless of what the top-level Fishing Mark Lists card
  // itself is set to. Re-applied on every render (see makeCollapsible's
  // own comment on why that's safe) since container.innerHTML above just
  // rebuilt these elements from scratch.
  MARK_LIST_FIELDS.forEach(({ key, label }) => {
    const group = container.querySelector(`.mark-list-chip-row[data-field="${key}"]`).closest(".mark-list-field-group");
    makeCollapsible(group, `settingsCollapsed:markListField:${key}`, true);
  });
  makeCollapsible(document.getElementById("markShapeFormatsFieldGroup"), "settingsCollapsed:markShapeFormats", true);
  makeCollapsible(document.getElementById("markColorFormatsFieldGroup"), "settingsCollapsed:markColorFormats", true);
}

async function onAddMarkListValue(key) {
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
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/marklists${effectiveUserIdParam()}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: fieldDef.label, value }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `status ${res.status}`);
    }
    const created = await res.json();
    markLists.push(created);
    input.value = "";
    renderMarkLists();
    setMarkListsSaveStatus("", false);
  } catch (err) {
    console.error("Failed to add mark list value:", err);
    setMarkListsSaveStatus("Couldn't add value: " + err.message, true);
  }
}

// Sets (or clears back to none, if `color` is falsy) the display colour for
// one specific value — e.g. "Whiting" under Species. Purely a local edit
// like Add/Remove above; still needs "Save mark lists" clicked afterward to
// actually commit it to config/mark_lists.json on GitHub. No cleanup of
// existing marks needed here (unlike the location-groups equivalent above):
// a mark just references the value string itself, never the colour, so
// recolouring (or un-colouring) an option doesn't touch anything that
// already used it.
/** Resolves the "colour for the website" a tile should show — the
 * assigned Mark COLOUR Format's own `color` (see this section's own
 * header comment on why that's now the ONLY way a tile gets a colour, no
 * more per-tile hex picker), or null if the value has no Colour Format
 * assigned at all (or the format itself has no colour set). Doesn't fall
 * back to a hash-based colour the way the map's own markStyleFor does in
 * charts.js — this is just for the Settings-tab chip's own look, not
 * trying to make every unconfigured value visually distinct here too. */
function resolveTileFormatColor(entry) {
  if (!entry.colorFormat) return null;
  const format = markLists.find((r) => r.field === "Mark Colour Format" && r.value === entry.colorFormat);
  return format && format.color ? format.color : null;
}

// Website icon choices for a Mark Shape Format — matches
// LOWRANCE_SHAPE_GETTERS/getDiamondMarkerClass/getCrossMarkerClass in
// charts.js exactly (the only three shapes this site's own map actually
// knows how to draw), so an icon choice made here can never reference a
// shape the map has no way to render.
const MARK_ICON_OPTIONS = ["circle", "diamond", "cross"];

/** Sets or clears a pick-list value's `shapeFormat` or `colorFormat`
 * (formatName === "" means "opt out, go back to this value's own
 * fallback" — see resolveMarkShapeFormat/resolveMarkColorFormat,
 * charts.js, and their sync.js equivalents). `fieldLabel` is the field's
 * own label ("Species", "Mark Type", "Bait", ...) directly, not a
 * MARK_LIST_FIELDS key/lookup — the caller already has the label in scope
 * from its own render loop. `prop` is "shapeFormat" or "colorFormat" —
 * the two axes are otherwise identical in how they're set/cleared, so one
 * function handles both rather than two near-duplicates. */
function onSetMarkListValueSubFormat(fieldLabel, value, prop, formatName) {
  const entry = markLists.find((r) => r.field === fieldLabel && r.value === value);
  if (!entry) return;
  // Optimistic: update locally (and the caller re-renders) immediately —
  // this is a <select> the person just changed, waiting on a network
  // round-trip before showing the new choice would feel laggy for
  // something this small. The API call runs in the background; a failure
  // is reported via the status line but doesn't revert the dropdown —
  // same trade-off sync/lowrance text inputs below already make.
  if (formatName) entry[prop] = formatName;
  else delete entry[prop];
  if (!entry.id) return; // shouldn't happen — every loaded/created entry has one
  fetch(`${USER_BACKEND_URL}/api/marklists/${entry.id}${effectiveUserIdParam()}`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [prop]: formatName || null }),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`status ${res.status}`);
      setMarkListsSaveStatus("", false);
    })
    .catch((err) => {
      console.error("Failed to save format assignment:", err);
      setMarkListsSaveStatus("Couldn't save that change: " + err.message, true);
    });
}

/**
 * Renders EITHER the Mark Shape Format list or the Mark Colour Format
 * list — same underlying row shape (a name plus a few properties, not a
 * pill chip the way every other list on this page is), genuinely
 * parameterized rather than writing two nearly-identical functions, since
 * the two differ only in WHICH properties they carry: Shape Format has an
 * `icon` (for this site's own map); Colour Format has a `color` (same
 * purpose, just colour instead of shape). Both carry `lowranceSym`/
 * `garminSym` — the literal device text FRAGMENT this piece contributes
 * to a mark's whole <sym> string on export (see gpxSymForMark's own
 * comment in sync.js for exactly how the shape fragment and colour
 * fragment get concatenated, and why any separator between them is
 * deliberately baked into whichever fragment needs it, Oliver's own call,
 * not decided by this code).
 *
 * REVISED from an earlier version that bundled shape and colour into one
 * "Mark Format" together — bundling meant assigning a species a colour
 * ALSO silently overrode its shape, losing the "a Catch reads as a cross,
 * a Mark reads as a circle, regardless of species" distinction the
 * moment any species got a colour of its own. Splitting them into two
 * independent lists fixes that (see resolveMarkShapeFormat/
 * resolveMarkColorFormat, charts.js, for the full resolution logic).
 */
function renderMarkSubFormatList(fieldName, containerId, newInputId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const isShape = fieldName === "Mark Shape Format";
  const entries = markLists.filter((r) => r.field === fieldName);
  if (entries.length === 0) {
    container.innerHTML = `<p class="footnote" style="margin:0 0 8px;text-align:left;">No ${fieldName}s yet — add one below.</p>`;
  } else {
    container.innerHTML = entries.map((f) => {
      const escAttr = f.value.replace(/"/g, "&quot;");
      const escText = f.value.replace(/</g, "&lt;");
      const escLowrance = (f.lowranceSym || "").replace(/"/g, "&quot;");
      const escGarmin = (f.garminSym || "").replace(/"/g, "&quot;");
      const sitePickerHtml = isShape
        ? `<select class="mark-subformat-icon-select" data-field="${fieldName}" data-value="${escAttr}" title="Icon shape for this site's own map"
            style="font-size:0.8rem;padding:4px 6px;border-radius:5px;border:1px solid var(--grey-200);">
            <option value=""${f.icon ? "" : " selected"}>Icon…</option>
            ${MARK_ICON_OPTIONS.map((i) => `<option value="${i}" ${i === f.icon ? "selected" : ""}>${i}</option>`).join("")}
          </select>`
        : `<input type="color" class="mark-subformat-color-input" data-field="${fieldName}" data-value="${escAttr}" value="${f.color || "#3388ff"}"
            title="Colour for this site's own map" style="width:34px;height:30px;padding:0;border:1px solid var(--grey-200);border-radius:5px;" />`;
      return `
      <div class="mark-subformat-row" data-field="${fieldName}" data-value="${escAttr}" style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px;border:1px solid var(--grey-200);border-radius:8px;margin-bottom:6px;">
        <strong style="min-width:110px;">${escText}</strong>
        ${sitePickerHtml}
        <input type="text" class="mark-subformat-lowrance-input" data-field="${fieldName}" data-value="${escAttr}" value="${escLowrance}"
          placeholder="Lowrance &lt;sym&gt; text fragment, e.g. ${isShape ? "circle," : "yellow"}" title="Exact Lowrance <sym> text fragment"
          style="flex:1;min-width:170px;padding:5px 8px;border-radius:5px;border:1px solid var(--grey-200);font-size:0.8rem;" />
        <input type="text" class="mark-subformat-garmin-input" data-field="${fieldName}" data-value="${escAttr}" value="${escGarmin}"
          placeholder="Garmin &lt;sym&gt; text fragment, e.g. ${isShape ? "Circle, " : "Yellow"}" title="Exact Garmin <sym> text fragment"
          style="flex:1;min-width:170px;padding:5px 8px;border-radius:5px;border:1px solid var(--grey-200);font-size:0.8rem;" />
        <button type="button" data-remove-mark-subformat data-field="${fieldName}" data-value="${escAttr}" aria-label="Remove ${escAttr}"
          style="background:none;border:none;color:var(--grey-500);cursor:pointer;font-size:0.95rem;line-height:1;padding:0 4px;">×</button>
      </div>`;
    }).join("");
  }

  container.querySelectorAll("[data-remove-mark-subformat]").forEach((btn) => {
    btn.addEventListener("click", (e) => onRemoveMarkSubFormat(e.currentTarget.dataset.field, e.currentTarget.dataset.value));
  });
  container.querySelectorAll(".mark-subformat-icon-select").forEach((select) => {
    select.addEventListener("change", (e) => {
      onSetMarkSubFormatProperty(e.currentTarget.dataset.field, e.currentTarget.dataset.value, "icon", e.currentTarget.value);
    });
  });
  container.querySelectorAll(".mark-subformat-color-input").forEach((input) => {
    input.addEventListener("change", (e) => {
      onSetMarkSubFormatProperty(e.currentTarget.dataset.field, e.currentTarget.dataset.value, "color", e.currentTarget.value);
    });
  });
  // "input" (not "change") for the two free-text sym fields — these have
  // no picker to "close", so onSetMarkSubFormatProperty's own debounce
  // (see its comment) is what actually paces the saves; without "input"
  // here, a value typed and never blurred could be lost entirely.
  container.querySelectorAll(".mark-subformat-lowrance-input").forEach((input) => {
    input.addEventListener("input", (e) => {
      onSetMarkSubFormatProperty(e.currentTarget.dataset.field, e.currentTarget.dataset.value, "lowranceSym", e.currentTarget.value);
    });
  });
  container.querySelectorAll(".mark-subformat-garmin-input").forEach((input) => {
    input.addEventListener("input", (e) => {
      onSetMarkSubFormatProperty(e.currentTarget.dataset.field, e.currentTarget.dataset.value, "garminSym", e.currentTarget.value);
    });
  });

  const newInput = document.getElementById(newInputId);
  if (newInput) {
    newInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onAddMarkSubFormat(fieldName, newInputId);
      }
    });
  }
}

const markSubFormatSaveTimers = new Map(); // debounce keys, see onSetMarkSubFormatProperty below

/** Sets or clears one property on a Mark Shape/Colour Format entry itself
 * (icon or color, lowranceSym, garminSym) — value === "" deletes the
 * property (falls back exactly as if it had never been set) rather than
 * storing an empty string. Doesn't re-render — every caller above is a
 * live input the person is actively using (typing text, or a colour/icon
 * they just picked), so redrawing the whole row out from under their
 * cursor would be actively disruptive; the DOM already shows what they
 * just set.
 *
 * The actual save is debounced (600ms of no further calls for this same
 * entry+prop) rather than firing immediately — the two free-text sym
 * inputs above call this on every keystroke ("input", not "change"), so
 * saving on each one would mean a PUT request per character typed.
 * icon-select/colour-input go through the same debounce too, harmlessly,
 * since they only ever fire once per discrete pick anyway. */
function onSetMarkSubFormatProperty(fieldName, formatName, prop, value) {
  const entry = markLists.find((r) => r.field === fieldName && r.value === formatName);
  if (!entry) return;
  if (value) entry[prop] = value;
  else delete entry[prop];
  if (!entry.id) return; // shouldn't happen — every loaded/created entry has one

  const timerKey = `${fieldName}::${formatName}::${prop}`;
  clearTimeout(markSubFormatSaveTimers.get(timerKey));
  markSubFormatSaveTimers.set(
    timerKey,
    setTimeout(() => {
      fetch(`${USER_BACKEND_URL}/api/marklists/${entry.id}${effectiveUserIdParam()}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [prop]: value || null }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`status ${res.status}`);
          setMarkListsSaveStatus("", false);
        })
        .catch((err) => {
          console.error("Failed to save format property:", err);
          setMarkListsSaveStatus("Couldn't save that change: " + err.message, true);
        });
    }, 600)
  );
}

async function onAddMarkSubFormat(fieldName, inputId) {
  const input = document.getElementById(inputId);
  const value = input.value.trim();
  const exists = value && markLists.some((r) => r.field === fieldName && r.value.toLowerCase() === value.toLowerCase());
  if (!value || exists) {
    input.value = "";
    return;
  }
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/marklists${effectiveUserIdParam()}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: fieldName, value }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `status ${res.status}`);
    }
    const created = await res.json();
    markLists.push(created);
    input.value = "";
    // Full re-render, not just this one list — every tile's own Shape/
    // Colour Format <select> options are built from the current lists too
    // (see renderMarkLists above), so a newly-added one needs to show up
    // there immediately, not just in this sub-list.
    renderMarkLists();
    setMarkListsSaveStatus("", false);
  } catch (err) {
    console.error("Failed to add format:", err);
    setMarkListsSaveStatus("Couldn't add: " + err.message, true);
  }
}

/** Removing a Shape/Colour Format does NOT clear it off any value that's
 * currently pointing at it (same "removing an option doesn't touch
 * anything that already used it" convention as every other list on this
 * page) — that value just falls back to its own default the next time
 * anything resolves it (see resolveMarkShapeFormat/resolveMarkColorFormat,
 * charts.js), same as if the Format had simply never existed. */
async function onRemoveMarkSubFormat(fieldName, value) {
  const entry = markLists.find((r) => r.field === fieldName && r.value === value);
  if (!entry || !entry.id) return;
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/marklists/${entry.id}${effectiveUserIdParam()}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok && res.status !== 404) throw new Error(`status ${res.status}`);
  } catch (err) {
    console.error("Failed to remove format:", err);
    setMarkListsSaveStatus("Couldn't remove: " + err.message, true);
    return;
  }
  markLists = markLists.filter((r) => !(r.field === fieldName && r.value === value));
  renderMarkLists(); // same reasoning as onAddMarkSubFormat above
  setMarkListsSaveStatus("", false);
}

// Removing an option here does NOT scrub it from any mark that already used
// it (unlike onRemoveGroup's cleanup of locations above) — there's no marks
// editor on this page yet for it to reach into. That's a fine degrade for
// now: an existing mark keeping a since-removed value just won't offer that
// value as a pick again, it isn't broken or hidden.
async function onRemoveMarkListValue(key, value) {
  const fieldDef = MARK_LIST_FIELDS.find((f) => f.key === key);
  if (!fieldDef) return;
  const entry = markLists.find((r) => r.field === fieldDef.label && r.value === value);
  if (!entry || !entry.id) return;
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/marklists/${entry.id}${effectiveUserIdParam()}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok && res.status !== 404) throw new Error(`status ${res.status}`);
  } catch (err) {
    console.error("Failed to remove mark list value:", err);
    setMarkListsSaveStatus("Couldn't remove: " + err.message, true);
    return;
  }
  markLists = markLists.filter((r) => !(r.field === fieldDef.label && r.value === value));
  renderMarkLists();
  setMarkListsSaveStatus("", false);
}

function setMarkListsSaveStatus(text, isError) {
  const el = document.getElementById("markListsSaveStatus");
  el.textContent = text;
  el.style.color = isError ? "#dc2626" : "#16a34a";
}
// onSaveMarkLists removed entirely — every add/remove/edit above now saves
// immediately via the API, same as Location Groups; there's nothing left
// to batch into one commit.

let viewedTypes = []; // Public's own type vocabulary ({id,name,behavesLike}) —
                       // loaded once alongside locations, used by the
                       // per-location "+ Add type" picker below.

/**
 * v2: Locations now live in D1 (locations + user_types +
 * user_location_access + user_location_group_members, all scoped to the
 * 'public' user — see schema-v2.sql) rather than FILE_PATH, gated on the
 * same Google Admin sign-in as Groups/Mark Lists above. Every field edit
 * below saves immediately (debounced for anything that fires per-
 * keystroke) — there's no more "Save changes"/"Save & refresh data now"
 * batch commit; see onRefreshDataNow further down for what that button
 * does instead.
 *
 * The in-memory `locations` array keeps roughly its OLD shape (name,
 * shore, tidal, tideOffset, lat, lng, willyweatherId/Name/Region/State,
 * tideMaxObserved, locationGroups[], types[] with driveTo/driveBack/
 * setUp/packUp/timeToSpot/timeFromSpot/minTideHeight) so renderRows/
 * renderSettingsLocationMap/renderTypeSection/the group-tag box below
 * are almost entirely UNCHANGED — only load/save mechanics differ. Two
 * NEW internal-only fields track D1 identity: `_id` (null until this
 * location's first save) and, per type entry, `_accessId`/`_typeId`.
 */
async function loadLocations() {
  if (!currentUser) {
    locations = [];
    document.getElementById("locationsSection").style.display = "none";
    return;
  }

  try {
    const [trackedRes, typesRes] = await Promise.all([
      fetch(`${USER_BACKEND_URL}/api/tracked-locations${effectiveUserIdParam()}`, { credentials: "include" }),
      fetch(`${USER_BACKEND_URL}/api/types${effectiveUserIdParam()}`, { credentials: "include" }),
    ]);
    if (!trackedRes.ok) throw new Error(`tracked-locations status ${trackedRes.status}`);
    if (!typesRes.ok) throw new Error(`types status ${typesRes.status}`);
    const tracked = await trackedRes.json();
    viewedTypes = await typesRes.json();

    const byLocation = new Map();
    for (const row of tracked) {
      let loc = byLocation.get(row.location.id);
      if (!loc) {
        loc = {
          _id: row.location.id,
          name: row.location.name,
          shore: row.location.shore,
          tidal: row.location.tidal,
          tideOffset: row.location.tideOffset,
          lat: row.location.lat,
          lng: row.location.lng,
          willyweatherId: row.location.willyweatherId,
          willyweatherName: row.location.willyweatherName,
          willyweatherRegion: row.location.willyweatherRegion,
          willyweatherState: row.location.willyweatherState,
          tideMaxObserved: row.location.tideMaxObserved,
          locationGroups: row.groups.map((g) => g.name),
          types: [],
        };
        byLocation.set(row.location.id, loc);
      }
      loc.types.push({
        _accessId: row.accessId,
        _typeId: row.type.id,
        type: row.type.name,
        behavesLike: row.type.behavesLike,
        driveTo: row.driveTo,
        driveBack: row.driveBack,
        setUp: row.setUp,
        packUp: row.packUp,
        timeToSpot: row.timeToSpot,
        timeFromSpot: row.timeFromSpot,
        minTideHeight: row.minTideHeight,
      });
    }
    locations = [...byLocation.values()];
    setStatus("Signed in as Admin — editing live");
  } catch (err) {
    console.error("Failed to load locations:", err);
    setStatus("Could not load locations: " + err.message, true);
    locations = [];
  }

  // Restore whichever location was last clicked/selected, by name — see
  // SELECTED_LOCATION_STORAGE_KEY/selectLocation.
  try {
    const savedName = localStorage.getItem(SELECTED_LOCATION_STORAGE_KEY);
    const idx = savedName ? locations.findIndex((l) => l.name === savedName) : -1;
    selectedLocationIdx = idx >= 0 ? idx : null;
  } catch {
    selectedLocationIdx = null;
  }

  document.getElementById("locationsSection").style.display = "block";
  document.getElementById("locationsSignedOut").style.display = "none";
  document.getElementById("locationsEditor").style.display = "block";
  renderRows();
}

function renderRows() {
  const list = document.getElementById("locationsList");
  list.innerHTML = "";
  locations.forEach((loc, i) => {
    if (!loc.types) loc.types = [];
    const activeTypeIds = loc.types.map((t) => t._typeId);
    // Public's own types not yet used on THIS location — what the "+ Add
    // type" picker below offers, alongside always offering to define a
    // brand new one. See "v2: Locations" note on loadLocations for why
    // this is open-ended now rather than a fixed Kayak/Land based pair.
    const availableTypes = viewedTypes.filter((t) => !activeTypeIds.includes(t.id));

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
        ${loc._new
          ? `<button data-create-loc="${i}" class="btn-primary" style="height:38px;">Create location</button>`
          : `<button data-remove-loc="${i}" class="btn-secondary" style="height:38px;">Remove location</button>`
        }
      </div>

      <label class="loc-edit-label" style="display:block;margin:12px 0 6px;">Usable for</label>
      <div class="type-add-row" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
        <select class="type-add-select" data-idx="${i}" style="padding:6px 8px;border-radius:8px;border:1px solid var(--grey-200);">
          <option value="">+ Add a type…</option>
          ${availableTypes.map((t) => `<option value="${t.id}">${t.name.replace(/</g, "&lt;")} (${t.behavesLike})</option>`).join("")}
          <option value="__new__">+ Define a new type…</option>
        </select>
        <span class="type-new-form" data-idx="${i}" style="display:none;gap:6px;align-items:center;">
          <input type="text" class="type-new-name" placeholder="Name, e.g. SUP" style="padding:6px 8px;border-radius:8px;border:1px solid var(--grey-200);width:140px;" />
          <select class="type-new-behaveslike" style="padding:6px 8px;border-radius:8px;border:1px solid var(--grey-200);">
            <option value="Kayak">Scores like Kayak</option>
            <option value="Land based">Scores like Land based</option>
          </select>
          <button type="button" class="btn-secondary type-new-confirm" data-idx="${i}">Add</button>
        </span>
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
/**
 * Writes the clicked point to D1 (Public's home_lat/home_lng — PUT
 * /api/admin/home-location, Admin-only) rather than committing to
 * config/settings.json. Updates the map immediately on success so the
 * house pin appears without needing a reload.
 */
async function saveHomeLocation(lat, lng) {
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/admin/home-location`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lng }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `status ${res.status}`);
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
  // No `types` yet (unlike the old defaultTypeConfig("Kayak") default) —
  // `_new` drafts aren't saved to D1 at all until "Create location" is
  // clicked (createLocation), which is what actually adds a default Kayak
  // type as part of that same POST. Nothing renders/edits a type section
  // for a draft in the meantime (renderRows guards with `_new` showing a
  // "Create location" button instead of per-field auto-save).
  const newLoc = {
    _new: true,
    name: candidate ? candidate.name : "",
    shore: "N",
    types: [],
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
  // Falls back to behavesLike when the display name isn't itself a
  // recognized key (any custom type, e.g. "SUP") — TYPE_TIME_FIELDS is a
  // shared charts.js lookup keyed literally on "Kayak"/"Land based" and
  // knows nothing about custom names; behavesLike is always one of those
  // two, so the fallback always resolves. Same reasoning for the icon.
  const fields = TYPE_TIME_FIELDS[typeConfig.type] || TYPE_TIME_FIELDS[typeConfig.behavesLike] || [];
  return `
    <div class="loc-type-section">
      <div class="loc-type-section-header">
        ${typeIconSvg(typeConfig.behavesLike, 15)}
        <label class="loc-edit-label" style="margin:0;">${typeConfig.type.replace(/</g, "&lt;")} timings (duration, hours : minutes)</label>
        <button type="button" data-remove-type data-idx="${locIdx}" data-typeidx="${typeIdx}" class="btn-secondary" style="margin-left:auto;font-size:0.75rem;padding:3px 8px;">Remove type</button>
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

      ${typeConfig.behavesLike === "Kayak" ? `
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
        saveGroupMembership(idx);
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
      saveGroupMembership(idx);
    });
  });
}

const placeSaveTimers = new Map(); // debounce keys: idx
const typeSaveTimers = new Map(); // debounce keys: `${idx}:${typeIdx}`

/**
 * Debounced (600ms) save of a location's PLACE-level fields (name, shore,
 * tideOffset, tidal) — PUT through its first type's accessId, since the
 * API's place-field edit path is reached via any of a location's access
 * rows (see handleTrackedItem, user-backend.js). No-op for a `_new` draft
 * (nothing to save until "Create location" is clicked) or a location with
 * zero types yet (shouldn't happen for a saved location — every creation
 * path requires at least one type).
 */
function schedulePlaceSave(idx) {
  const loc = locations[idx];
  if (!loc || loc._new || !loc._id || !loc.types.length) return;
  clearTimeout(placeSaveTimers.get(idx));
  placeSaveTimers.set(
    idx,
    setTimeout(async () => {
      try {
        const res = await fetch(`${USER_BACKEND_URL}/api/tracked-locations/${loc.types[0]._accessId}${effectiveUserIdParam()}`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: loc.name,
            shore: loc.shore,
            tideOffset: loc.tideOffset,
            tidal: loc.tidal !== false,
          }),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        setSaveStatus("", false);
      } catch (err) {
        console.error("Failed to save location:", err);
        setSaveStatus("Couldn't save: " + err.message, true);
      }
    }, 600)
  );
}

/** Same debounce shape as schedulePlaceSave, for one type's own
 * drive/setup/pack-up/time-to/from-spot/minTideHeight fields. */
function scheduleTypeSave(idx, typeIdx) {
  const loc = locations[idx];
  const typeConfig = loc && loc.types[typeIdx];
  if (!loc || loc._new || !typeConfig || !typeConfig._accessId) return;
  const key = `${idx}:${typeIdx}`;
  clearTimeout(typeSaveTimers.get(key));
  typeSaveTimers.set(
    key,
    setTimeout(async () => {
      try {
        const res = await fetch(`${USER_BACKEND_URL}/api/tracked-locations/${typeConfig._accessId}${effectiveUserIdParam()}`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            driveTo: typeConfig.driveTo,
            driveBack: typeConfig.driveBack,
            setUp: typeConfig.setUp,
            packUp: typeConfig.packUp,
            timeToSpot: typeConfig.timeToSpot,
            timeFromSpot: typeConfig.timeFromSpot,
            minTideHeight: typeConfig.minTideHeight,
          }),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        setSaveStatus("", false);
      } catch (err) {
        console.error("Failed to save type timings:", err);
        setSaveStatus("Couldn't save: " + err.message, true);
      }
    }, 600)
  );
}

/** Immediate (not debounced — triggered by a discrete Create click, not
 * typing) creation of a brand-new `_new` draft location, defaulting to
 * one Kayak-behaving type (matching the old default) — reusing Public's
 * existing "Kayak" type if one exists, defining it fresh otherwise. */
async function createLocation(idx) {
  const loc = locations[idx];
  if (!loc || !loc._new) return;
  if (!loc.name || !loc.name.trim()) {
    setSaveStatus("Name is required.", true);
    return;
  }
  if (typeof loc.lat !== "number" || typeof loc.lng !== "number") {
    setSaveStatus("This location needs coordinates — add it via the map instead of a blank row.", true);
    return;
  }
  const existingKayak = viewedTypes.find((t) => t.behavesLike === "Kayak" && t.name === "Kayak");
  const body = {
    name: loc.name,
    lat: loc.lat,
    lng: loc.lng,
    shore: loc.shore,
    tideOffset: loc.tideOffset,
    tidal: loc.tidal !== false,
    willyweatherId: loc.willyweatherId,
    willyweatherName: loc.willyweatherName,
    willyweatherRegion: loc.willyweatherRegion,
    willyweatherState: loc.willyweatherState,
    driveTo: "00:00",
    driveBack: "00:00",
    setUp: "00:00",
    packUp: "00:00",
    timeToSpot: "00:00",
    timeFromSpot: "00:00",
  };
  if (existingKayak) body.typeId = existingKayak.id;
  else {
    body.newTypeName = "Kayak";
    body.newTypeBehavesLike = "Kayak";
  }
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/tracked-locations${effectiveUserIdParam()}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `status ${res.status}`);
    }
    setSaveStatus("Location created.");
    await loadLocations(); // simplest correct way to pick up the new type/location ids and re-sync viewedTypes
  } catch (err) {
    console.error("Failed to create location:", err);
    setSaveStatus("Couldn't create location: " + err.message, true);
  }
}

/** Deletes a saved location entirely — one DELETE per type's accessId;
 * the LAST one deleted also removes the now-orphaned place row itself
 * server-side (see handleTrackedItem's DELETE branch, user-backend.js). */
async function removeLocation(idx) {
  const loc = locations[idx];
  if (!loc) return;
  if (loc._new) {
    locations.splice(idx, 1);
    selectLocation(null);
    renderRows();
    return;
  }
  if (!confirm(`Delete "${loc.name}" and all its type entries?`)) return;
  try {
    for (const t of loc.types) {
      const res = await fetch(`${USER_BACKEND_URL}/api/tracked-locations/${t._accessId}${effectiveUserIdParam()}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok && res.status !== 404) throw new Error(`status ${res.status}`);
    }
  } catch (err) {
    console.error("Failed to delete location:", err);
    setSaveStatus("Couldn't delete: " + err.message, true);
    return;
  }
  locations.splice(idx, 1);
  selectLocation(null);
  renderRows();
}

/** Adds an existing Public type (typeId) or defines a brand new one
 * (newTypeName/newTypeBehavesLike) to an ALREADY-SAVED location. Disabled
 * for a `_new` draft — see createLocation for how a draft's first type
 * gets attached (as part of the same POST that creates the place itself). */
async function addTypeToLocation(idx, { typeId, newTypeName, newTypeBehavesLike }) {
  const loc = locations[idx];
  if (!loc || loc._new) return;
  const body = {
    locationId: loc._id,
    driveTo: "00:00",
    driveBack: "00:00",
    setUp: "00:00",
    packUp: "00:00",
    timeToSpot: "00:00",
    timeFromSpot: "00:00",
  };
  if (typeId) body.typeId = typeId;
  else {
    body.newTypeName = newTypeName;
    body.newTypeBehavesLike = newTypeBehavesLike;
  }
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/tracked-locations${effectiveUserIdParam()}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `status ${res.status}`);
    }
    setSaveStatus("Type added.");
    await loadLocations(); // re-syncs viewedTypes too, in case a new one was just defined
  } catch (err) {
    console.error("Failed to add type:", err);
    setSaveStatus("Couldn't add type: " + err.message, true);
  }
}

/** Removes one type from a location — refuses to remove the last one
 * (same rule the old toggle-button UI enforced), same as before. */
async function removeTypeFromLocation(idx, typeIdx) {
  const loc = locations[idx];
  const typeConfig = loc && loc.types[typeIdx];
  if (!loc || !typeConfig) return;
  if (loc.types.length <= 1) {
    setSaveStatus("A location needs at least one type — add another before removing this one.", true);
    return;
  }
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/tracked-locations/${typeConfig._accessId}${effectiveUserIdParam()}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok && res.status !== 404) throw new Error(`status ${res.status}`);
  } catch (err) {
    console.error("Failed to remove type:", err);
    setSaveStatus("Couldn't remove type: " + err.message, true);
    return;
  }
  loc.types.splice(typeIdx, 1);
  renderRows();
}

/** Immediate (not debounced) save of a location's full group-membership
 * list — called after any add/remove in the group-tag box below. */
async function saveGroupMembership(idx) {
  const loc = locations[idx];
  if (!loc || loc._new || !loc._id) return;
  const groupIds = (loc.locationGroups || []).map((name) => groupNameToId.get(name)).filter(Boolean);
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/locations/${loc._id}/groups${effectiveUserIdParam()}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupIds }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (err) {
    console.error("Failed to save group membership:", err);
    setSaveStatus("Couldn't save groups: " + err.message, true);
  }
}

function wireRowListeners(list) {
  list.querySelectorAll("input[data-field], select[data-field]").forEach((el) => {
    el.addEventListener("input", (e) => {
      const idx = Number(e.target.dataset.idx);
      const field = e.target.dataset.field;
      locations[idx][field] = e.target.value;
      schedulePlaceSave(idx);
    });
  });

  list.querySelectorAll("input[data-boolfield]").forEach((el) => {
    el.addEventListener("change", (e) => {
      const idx = Number(e.target.dataset.idx);
      const field = e.target.dataset.boolfield;
      locations[idx][field] = e.target.checked;
      schedulePlaceSave(idx);
    });
  });

  // Location-level numeric fields (as opposed to data-typefield, which is
  // per-type) — same "store a real number, not the string every input's
  // .value naturally is" reasoning: the API stores this as a REAL column,
  // which a quoted JSON string would break.
  list.querySelectorAll("input[data-numfield]").forEach((el) => {
    el.addEventListener("input", (e) => {
      const idx = Number(e.target.dataset.idx);
      const field = e.target.dataset.numfield;
      locations[idx][field] = e.target.value === "" ? null : parseFloat(e.target.value);
      schedulePlaceSave(idx);
    });
  });

  list.querySelectorAll("input[data-typefield]").forEach((el) => {
    el.addEventListener("input", (e) => {
      const idx = Number(e.target.dataset.idx);
      const typeIdx = Number(e.target.dataset.typeidx);
      const field = e.target.dataset.typefield;
      locations[idx].types[typeIdx][field] = e.target.value === "" ? null : parseFloat(e.target.value);
      scheduleTypeSave(idx, typeIdx);
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
      scheduleTypeSave(idx, typeIdx);
    });
  });

  list.querySelectorAll("button[data-remove-loc]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = Number(e.currentTarget.dataset.removeLoc);
      removeLocation(idx);
    });
  });

  list.querySelectorAll("button[data-create-loc]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = Number(e.currentTarget.dataset.createLoc);
      createLocation(idx);
    });
  });

  list.querySelectorAll("button[data-remove-type]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = Number(e.currentTarget.dataset.idx);
      const typeIdx = Number(e.currentTarget.dataset.typeidx);
      removeTypeFromLocation(idx, typeIdx);
    });
  });

  list.querySelectorAll(".type-add-select").forEach((select) => {
    select.addEventListener("change", (e) => {
      const idx = Number(e.currentTarget.dataset.idx);
      const value = e.currentTarget.value;
      const formEl = list.querySelector(`.type-new-form[data-idx="${idx}"]`);
      if (value === "__new__") {
        formEl.style.display = "inline-flex";
        return;
      }
      if (value) {
        addTypeToLocation(idx, { typeId: value });
      }
      e.currentTarget.value = "";
      formEl.style.display = "none";
    });
  });

  list.querySelectorAll(".type-new-confirm").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = Number(e.currentTarget.dataset.idx);
      const formEl = e.currentTarget.closest(".type-new-form");
      const name = formEl.querySelector(".type-new-name").value.trim();
      const behavesLike = formEl.querySelector(".type-new-behaveslike").value;
      if (!name) return;
      addTypeToLocation(idx, { newTypeName: name, newTypeBehavesLike: behavesLike });
    });
  });
}

// onConnect/onDisconnect removed entirely — there's no GitHub connection
// left on this page to manage. See README's "Home address and Refresh
// data now" section for what replaced them.

// validateLocations/onSave removed entirely — every field edit above now
// saves immediately (or via createLocation/removeLocation/
// addTypeToLocation/removeTypeFromLocation), same as Groups/Mark Lists;
// there's nothing left to validate-then-batch-commit.

/**
 * "Refresh data now" — triggers the site's GitHub Actions workflow
 * immediately rather than waiting for the next scheduled run, via
 * POST /api/admin/refresh-data-now. The Worker holds its own GitHub
 * token (a secret, scoped to Actions:write only) and makes the actual
 * dispatch call server-side — no GitHub token of any kind touches this
 * browser any more. Admin-gated (checked server-side against the
 * session's own role), matching everything else on this page now.
 */
async function onRefreshDataNow() {
  setSaveStatus("Triggering data refresh…");
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/admin/refresh-data-now`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `status ${res.status}`);
    }
    setSaveStatus("Refresh triggered — check the Actions tab, then the Conditions tab in a minute or two.");
  } catch (err) {
    console.error("Failed to trigger refresh:", err);
    setSaveStatus("Couldn't trigger the refresh automatically — run it manually from the Actions tab: " + err.message, true);
  }
}

init();
