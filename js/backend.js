// backend.js
// Talking to the backend and shared helpers: sign-in status (refreshAdminStatus), the worker URL, saving locations, mark pick-lists, escapeHtml, displayNameFor and the WillyWeather location search picker.
// One of the shared scripts split out of the old charts.js. All of them share one global scope; each page loads
// only the ones it needs, in this order (checked by scripts/check-page-scripts.mjs).

// --- GitHub read/write (shared) ---------------------------------------------
//
// Originally lived only in locationsadmin.js (the Settings tab's own
// save flow), then grew a second consumer (the Location tab's "Add as
// permanent location") that's since moved to D1 too (saveNewLocationToD1,
// above) — GITHUB_API/BRANCH/getConnection() below are still genuinely
// used, just narrower now: Home address and the "Refresh data now"
// trigger (locationsadmin.js), Sync (sync.js, still unmigrated). FILE_PATH
// (config/locations.json) specifically is now dead — nothing writes to it
// via this path any more — left in place rather than removed for the same
// low-risk-over-tidiness reasoning the deprecated v1 endpoints get
// (user-backend.js). GROUPS_FILE_PATH and WORKFLOW_FILE stay local to
// locationsadmin.js — nothing outside the Settings page triggers a data
// refresh.

const GITHUB_API = "https://api.github.com";
const FILE_PATH = "config/locations.json"; // dead — see comment above
const BRANCH = "main";

/** Reads the same "ghConnection" localStorage entry the Settings page's
 * own Connect/Disconnect buttons write to (locationsadmin.js) — since
 * localStorage is scoped per-origin, not per-page, a connection made on
 * the Settings tab is already visible here with no extra wiring. Returns
 * null (never throws) if there's no connection, or the stored value is
 * malformed somehow. */
function getConnection() {
  try {
    return JSON.parse(localStorage.getItem("ghConnection") || "null");
  } catch {
    return null;
  }
}

// Offline support (sw.js): the site opens with no signal using the last copy
// of each file. Network-first, so it never serves stale code while online.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.error("Service worker not registered:", err));
  });
}


// ---------------------------------------------------------------------
// Admin-session gating — used for "Add as permanent location" (app.js),
// marks (add/edit/delete a catch or POI), and Sync's own canSync() gate.
// The old GitHub-token concept (getConnection() above) has been fully
// retired for every write-capable feature on this site — see README's
// "A serious bug, found and fixed" and later sections for the full
// migration history. Same USER_BACKEND_URL value as locationsadmin.js's
// own declaration — kept as ONE declaration now, not duplicated (a
// duplicate top-level `const` of the same name across two scripts
// sharing a page is a fatal SyntaxError, not a harmless redeclaration —
// this is exactly what caused that bug).
// ---------------------------------------------------------------------

const USER_BACKEND_URL = "https://fishingconditions-users.oliver-mestdagh.workers.dev";

// --- Sign-in that survives blocked third-party cookies ------------------------------------------------------
// The Worker's session cookie belongs to a different address from this site, so phone browsers increasingly
// refuse to send it on the site's own requests — signing in "worked" but the next page saw nobody signed in.
// So after Google sign-in the Worker redirects here with a one-time code in the URL fragment (#login=...);
// it is swapped once for a token (POST /auth/exchange), kept in localStorage, and every request to the Worker
// that sends credentials also carries it as `Authorization: Bearer <token>`. The cookie still works too.
const AUTH_TOKEN_STORAGE_KEY = "authToken";
const rawFetch = window.fetch.bind(window);
let authExchangePromise = null; // requests to the Worker wait for this while a fresh sign-in is being finalised

function readAuthToken() {
  try {
    return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}
function writeAuthToken(token) {
  try {
    if (token) localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    /* storage blocked — the cookie may still work */
  }
}

(function finishSignInFromUrl() {
  const match = /^#login=([^&]+)/.exec(window.location.hash || "");
  if (!match) return;
  const code = decodeURIComponent(match[1]);
  // Take the code out of the address bar and history straight away.
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  authExchangePromise = (async () => {
    try {
      const res = await rawFetch(`${USER_BACKEND_URL}/auth/exchange`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (res.ok) writeAuthToken((await res.json()).token);
      else console.error("Sign-in code was not accepted:", res.status);
    } catch (err) {
      console.error("Sign-in code exchange failed:", err);
    } finally {
      authExchangePromise = null;
    }
  })();
})();

window.fetch = async function (input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
  if (!url || !url.startsWith(USER_BACKEND_URL)) return rawFetch(input, init);
  if (authExchangePromise) await authExchangePromise;
  // Only requests that send credentials get the token: the open, read-only endpoints (wildcard CORS) don't need it.
  const token = init && init.credentials === "include" ? readAuthToken() : null;
  if (token) {
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    init = { ...init, headers };
  }
  const res = await rawFetch(input, init);
  if (url.startsWith(`${USER_BACKEND_URL}/auth/logout`)) writeAuthToken(null);
  else if (token && res.status === 401 && url.startsWith(`${USER_BACKEND_URL}/auth/me`)) writeAuthToken(null); // expired or revoked
  return res;
};

let cachedIsAdmin = false; // refreshed once via refreshAdminStatus() at page
                           // init (see app.js/locationsadmin.js) — read
                           // synchronously everywhere else (canEditLocations,
                           // app.js) so every EXISTING call site (several of
                           // them synchronous) needed zero restructuring into
                           // async, at the cost of a small (one page-load)
                           // staleness window: signing in/out on the
                           // Settings tab in another tab won't be reflected
                           // here until this page's own next load.
let cachedIsSignedIn = false; // set by the same refreshAdminStatus() call: anyone signed in, admin or not
let cachedUserId = null; // the signed-in person's own real users.id (or null, signed out) — set by the same call; used to tell "Mine" apart from someone else's mark now that Admin can see everyone's (see markOwnerOptionsHtml/collectMarkFormValues, js/marks-core.js)
async function refreshAdminStatus() {
  try {
    const res = await fetch(`${USER_BACKEND_URL}/auth/me`, { credentials: "include" });
    if (!res.ok) {
      cachedIsAdmin = false;
      cachedIsSignedIn = false;
      cachedUserId = null;
      return;
    }
    const user = await res.json();
    cachedIsSignedIn = true;
    cachedIsAdmin = user.role === "admin";
    cachedUserId = user.id;
  } catch (err) {
    console.error("Admin status check failed:", err);
    cachedIsAdmin = false;
    cachedIsSignedIn = false;
    cachedUserId = null;
  }
}

// --- Homes (shared by the Map — js/homes.js — and Week Ahead): anything worked out from "home" uses whichever of the
// signed-in person's homes is closest to where the trip is going (nearestHome).
let myHomes = []; // [{id, lat, lng}] — the signed-in person's own
let myHomesPromise = null;
let homesMap = null; // the map the pins are on (null in Import mode, or signed out)
let homesLayer = null;
let homeAddArmed = false;

/** The signed-in person's homes, fetched once per page (or again with `force`); [] when signed out. */
function loadMyHomes(force) {
  if (typeof cachedIsSignedIn === "undefined" || !cachedIsSignedIn) {
    myHomes = [];
    return Promise.resolve(myHomes);
  }
  if (!myHomesPromise || force) {
    myHomesPromise = (async () => {
      try {
        const res = await fetch(`${USER_BACKEND_URL}/api/homes`, { credentials: "include" });
        myHomes = res.ok ? await res.json() : [];
      } catch (err) {
        console.error("Could not load your homes:", err);
        myHomes = [];
      }
      return myHomes;
    })();
  }
  return myHomesPromise;
}

/** Of `homes` (default: the loaded ones), the one closest to lat/lng as the crow flies — null when there are none. */
function nearestHome(lat, lng, homes = myHomes) {
  let best = null;
  let bestD = Infinity;
  const rad = Math.PI / 180;
  for (const h of homes || []) {
    const x = (h.lng - lng) * rad * Math.cos(((h.lat + lat) / 2) * rad);
    const y = (h.lat - lat) * rad;
    const d = x * x + y * y;
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}


/** The closest town to a point — WillyWeather's nearest place, via the search Worker (fetchWillyWeatherCandidates);
 * null when it can't be found. Used to label homes. */
async function homeTownName(lat, lng) {
  const candidates = await fetchWillyWeatherCandidates(lat, lng);
  return candidates && candidates[0] && candidates[0].name ? candidates[0].name : null;
}

/** A home's label: its town, or "Home" until one is known. */
function homeLabel(home) {
  return (home && home.name) || "Home";
}

/** Looks up and saves a town name for any of the signed-in person's homes that has none yet (homes added before
 * names existed, or when the look-up failed). Resolves once done; `onNamed` runs if any name was filled in. */
async function ensureHomeNames(onNamed) {
  await loadMyHomes();
  let named = false;
  for (const home of myHomes) {
    if (home.name) continue;
    const name = await homeTownName(home.lat, home.lng);
    if (!name) continue;
    try {
      const res = await fetch(`${USER_BACKEND_URL}/api/homes/${encodeURIComponent(home.id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        home.name = name;
        named = true;
      }
    } catch (err) {
      console.error("Could not save a home's name:", err);
    }
  }
  if (named && onNamed) onNamed();
}

/** How many locations the signed-in person may still create — GET /api/location-quota ({unlimited, max, used}), or
 * null signed out / unknown. Refreshed by refreshLocationQuota (the Map's init, and after adding a location). */
let cachedLocationQuota = null;
async function refreshLocationQuota() {
  cachedLocationQuota = null;
  if (!cachedIsSignedIn) return;
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/location-quota`, { credentials: "include" });
    if (res.ok) cachedLocationQuota = await res.json();
  } catch (err) {
    console.error("Could not load the location allowance:", err);
  }
}
/** Whether the signed-in person may add a location: Admin always (it goes to Public — see saveNewLocationToD1),
 * anyone else while their tier's extra-location allowance has room. The server enforces the same limit. */
function canAddOwnLocation() {
  if (cachedIsAdmin) return true;
  const q = cachedLocationQuota;
  return !!q && (q.unlimited || q.used < q.max);
}

/**
 * Every real account (Admin and Basic — Public excluded), Admin only — same GET /api/admin/users
 * locationsadmin.js's own Users panel already calls, cached here as a plain global rather than
 * threaded through `state` (same reasoning as cachedIsAdmin above): buildMarkPopupEditHtml's new
 * Owner field (js/marks-core.js) needs it from every call site that builds a mark's edit popup,
 * several of which never receive `state` at all (e.g. sync.js's own import-review popup).
 *
 * Best-effort like fetchUnionedMarkLists — a failed fetch just leaves the Owner picker showing
 * only "Public" and whoever's already on the mark, rather than blocking the marks layer itself
 * from loading. A no-op (and clears any stale list) for a non-admin or signed-out caller, since
 * only Admin can reach /api/admin/users at all.
 */
let cachedAdminUsers = []; // [{id, email, name, role, tierId, tierName, createdAt}]
async function fetchAdminUsersList() {
  if (!cachedIsAdmin) {
    cachedAdminUsers = [];
    return;
  }
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/admin/users`, { credentials: "include" });
    if (res.ok) cachedAdminUsers = await res.json();
  } catch (err) {
    console.error("Could not load the user list (owner reassignment will show fewer options):", err);
  }
}

/**
 * Replaces saveNewLocationToGitHub for "Add as permanent location"
 * (app.js) — POSTs through the same /api/tracked-locations endpoint
 * the Settings page's own Locations editor uses, as Public
 * (?userId=public), rather than committing straight to
 * config/locations.json. This is the actual bug fix: that file is now a
 * generated EXPORT (see fetch_conditions.py's export_locations_json()) —
 * a raw GitHub commit to it would have been silently overwritten by the
 * next scheduled pipeline run within a few hours, since it was never
 * actually added to D1 at all. Requires the caller to already know
 * they're signed in as Admin (cachedIsAdmin) — checked here again anyway
 * (server-side, via requireUser/role) since a stale client-side cache is
 * never trusted for the actual permission, only for whether to show the
 * button at all.
 *
 * newLoc is the same minimal shape onAddPreviewAsLocation (app.js) always
 * built for the old GitHub path — name/shore/types (exactly one entry,
 * this feature only ever offers a single Kayak-or-Land-based type, not
 * several)/lat/lng/tidal/willyweatherId/Name/Region/State. Returns
 * { success: true } or { success: false, error }, same contract the old
 * function had, so app.js's own calling code needed no changes beyond the
 * function name itself.
 */
async function saveNewLocationToD1(newLoc) {
  // Admin adds to Public (as before); anyone else to their own account, within their tier's allowance.
  const accountParam = cachedIsAdmin ? "?userId=public" : "";
  try {
    const typesRes = await fetch(`${USER_BACKEND_URL}/api/types${accountParam}`, { credentials: "include" });
    if (!typesRes.ok) throw new Error(`Could not load types (${typesRes.status})`);
    const publicTypes = await typesRes.json();
    const typeName = newLoc.types[0].type;
    const existing = publicTypes.find((t) => t.name === typeName);

    const body = {
      name: newLoc.name,
      displayName: newLoc.displayName,
      lat: newLoc.lat,
      lng: newLoc.lng,
      shore: newLoc.shore,
      tidal: newLoc.tidal,
      willyweatherId: newLoc.willyweatherId,
      willyweatherName: newLoc.willyweatherName,
      willyweatherRegion: newLoc.willyweatherRegion,
      willyweatherState: newLoc.willyweatherState,
    };
    if (existing) body.typeId = existing.id;
    else {
      // Shouldn't happen for Kayak/Land based specifically (seeded for
      // Public in the very first migration) — falls back to defining it
      // fresh rather than failing outright if it somehow comes up empty.
      body.newTypeName = typeName;
      body.newTypeBehavesLike = typeName;
    }

    const res = await fetch(`${USER_BACKEND_URL}/api/tracked-locations${accountParam}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `status ${res.status}`);
    }
    return { success: true };
  } catch (err) {
    console.error("Failed to save new location:", err);
    return { success: false, error: err.message };
  }
}

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

// Which timing fields apply to each type. Drive time is no longer a static
// setting here at all — Week Ahead calculates it live from the device's
// current location. Both types have a "getting to/from the actual spot"
// step now — paddling for Kayak, walking from the carpark for Land based
// (a real case: walking along the beach to a specific spot).
const TYPE_TIME_FIELDS = {
  Kayak: [
    { key: "setUp", label: "Set up" },
    { key: "packUp", label: "Pack up" },
    { key: "timeToSpot", label: "Time to Spot" },
    { key: "timeFromSpot", label: "Time From Spot" },
  ],
  "Land based": [
    { key: "setUp", label: "Set up" },
    { key: "packUp", label: "Pack up" },
    { key: "timeToSpot", label: "Time to Spot" },
    { key: "timeFromSpot", label: "Time From Spot" },
  ],
};

function defaultTypeConfig(type) {
  const config = { type };
  for (const f of TYPE_TIME_FIELDS[type]) config[f.key] = "00:00";
  return config;
}

/**
 * saveNewLocationToGitHub removed entirely — replaced by saveNewLocationToD1
 * above, which POSTs through /api/tracked-locations?userId=public instead
 * of committing straight to config/locations.json (now a generated export,
 * not a source of truth — a raw commit here would have been silently
 * overwritten within a few hours by the next scheduled pipeline run).
 */

// --- GPS fishing marks (shared) ---------------------------------------------
//
// A "mark" is a single manually-placed GPS point recorded while out fishing.
// Three real types (see MARK_TYPE_FIELD_KEYS below for exactly what each one
// carries): a plain POI (a snag, a hazard, a ramp not otherwise tracked —
// just a name and a time, no species), a Mark ("I think this species is
// around here" — species only, no other detail), or a real Catch (species
// plus the full weather/tide/gear/measurement detail this popup can show).
// Kept as its own small file (data/marks.json) rather than folded into
// config/locations.json: locations.json describes the fixed handful of spots
// this whole site scores tide/weather/wind conditions FOR, while marks are an
// open-ended, ever-growing personal log added to constantly out on the
// water — mixing the two would make every locations-list load (and every
// diff of that file) balloon over time for no reason, and conflates two
// genuinely different concerns (site scoring config vs. personal catch diary).
// Also distinct from the personal-spots GPX layer above: that's a static,
// read-only file exported from a device and dropped in as-is, while marks
// are entered directly on this site and editable here.
//
// Lives in data/ rather than config/ despite being written the same
// browser->GitHub-API way as config/locations.json etc: config/ is for
// settings that configure how the site/pipeline behaves (which locations to
// track, which groups exist, API keys), while data/ is the actual content
// the site renders (conditions.json IS the data every page displays) — and
// marks are exactly that: real content, not a setting, that just happens to
// be authored here instead of by fetch_conditions.py. mark_lists.json stays
// in config/ since IT genuinely is a settings file (the set of options
// offered), the same role config/location_groups.json already plays.
//
// Stored as flat JSON, written via the exact same GitHub Contents API
// read-sha/write pattern as locations.json/location_groups.json above (see
// getConnection/GITHUB_API) rather than standing up any real database. At
// personal-log scale — one person, logged by hand while fishing, realistically
// low hundreds to a few thousand entries over years — even a few thousand
// marks is only a few hundred KB of JSON, trivial for the GitHub API to read
// and rewrite whole on every save, and consistent with how every other piece
// of site-authored config already works here (no build step, no server). A
// real database would only start to earn its added cost/complexity if this
// became multi-user/concurrent writers, needed live queries at a scale where
// fetching the whole file each time was actually slow, or needed writes from
// an unattended server process (like fetch_conditions.py) — none of which
// apply. Revisit this if marks.json ever grows past a few MB or a few tens
// of thousands of rows; until then a flat file keeps the whole architecture
// (and the deploy-by-drag-and-drop workflow) one consistent shape.

const MARKS_FILE_PATH = "https://fishingconditions-users.oliver-mestdagh.workers.dev/api/public/marks";
// Points at the live, unauthenticated user-backend endpoint (D1, Public's
// own rows, reattributed there from the Admin's own account by a one-time
// migration — see handlePublicMarks's own comment for why) rather than the
// static data/marks.json file it used to. Same migration pattern as
// MARK_LISTS_FILE_PATH above: this constant swap plus the render-gate and
// write-path changes below are the ENTIRE migration — sync.js's own two
// fetch call sites needed no changes at all, same as it didn't for mark
// lists.
// Points at the live, unauthenticated user-backend endpoint (D1, Public's
// own rows) rather than the static config/mark_lists.json file it used to
// — see user-backend.js's handlePublicMarkLists for why this is safe to
// leave wide open (read-only, same data the static file already made
// freely downloadable). Both fetch call sites below/in sync.js are
// UNCHANGED — this constant swap is the entire migration; the cache-
// busting `?_=${Date.now()}` and `cache:"no-store"` on those calls are
// harmless no-ops against a live API rather than a static file, not worth
// removing just for tidiness.
const MARK_LISTS_FILE_PATH = "https://fishingconditions-users.oliver-mestdagh.workers.dev/api/public/marklists";

/**
 * Public's own mark-list vocabulary, UNIONED with the signed-in Admin's
 * own personal marklist rows (via /api/marklists, omitting ?userId= so
 * it resolves to the current session's own user — resolveEffectiveUserId,
 * user-backend.js) — every call site here (loadAndRenderMarks, sync.js's
 * own init) already only ever runs once cachedIsAdmin is confirmed true,
 * so this authenticated fetch is always reachable, never a 401.
 *
 * REAL BUG, FOUND AND FIXED: every mark-editing dropdown (Species/Bait/
 * Rig/Rod/etc, wherever they appear) used to read ONLY Public's own
 * list — reported directly: moving a Rod option from Public's account
 * to the Admin's own (via the Settings page's Mark Lists editor) made
 * it vanish from the Rod dropdown entirely when editing a Catch,
 * regardless of which account a given option techically lives under.
 * Deduplicated by field+value; the Admin's own copy wins on a genuine
 * clash between the two — more likely to be the intentionally-current
 * one, having just been curated or moved there.
 */
async function fetchUnionedMarkLists() {
  let publicList = [];
  let ownList = [];
  try {
    const res = await fetch(`${MARK_LISTS_FILE_PATH}?_=${Date.now()}`, { cache: "no-store" });
    if (res.ok) publicList = await res.json();
  } catch (err) {
    console.error("Could not load Public's mark lists:", err);
  }
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/marklists?_=${Date.now()}`, { credentials: "include", cache: "no-store" });
    if (res.ok) ownList = await res.json();
  } catch (err) {
    console.error("Could not load the signed-in account's own mark lists:", err);
  }
  const merged = new Map(); // "field|value" -> row, own account wins on a clash
  for (const row of publicList) merged.set(`${row.field}|${row.value}`, row);
  for (const row of ownList) merged.set(`${row.field}|${row.value}`, row);
  return Array.from(merged.values());
}

/**
 * Shape of one entry in data/marks.json's `marks` array:
 *
 *   {
 *     id:        string — e.g. "m_1730962345123_a1b2c" (see makeMarkId
 *                below). A timestamp+random suffix rather than an array
 *                index, so edit/delete/export/dedupe all have something
 *                stable to key on that survives re-ordering or a future
 *                Garmin/Lowrance import mixing in externally-created ids.
 *     lat, lng:  number — WGS84 decimal degrees, same convention as every
 *                other coordinate on this site.
 *     name:      string — short display label for the pin.
 *     type:      string — from config/mark_lists.json's "Mark Type" list.
 *                Three real values going forward: "POI" (just a point of
 *                interest, no species), "Mark" (species only, no other
 *                catch detail), "Catch" (the full field set — see
 *                MARK_TYPE_FIELD_KEYS/fieldKeysForMarkType above for
 *                exactly which of the fields below apply to which type,
 *                and buildMarkPopupViewHtml/buildMarkPopupEditHtml for
 *                where that's actually enforced in the UI). "Fish" is the
 *                RETIRED predecessor of "Catch" — every mark that existed
 *                before this three-way distinction was introduced got
 *                migrated from type:"Fish" to type:"Mark" in one pass (see
 *                the delivered marks.json diff), and the pick-list option
 *                itself gets removed from config/mark_lists.json by hand,
 *                separately, once nothing's likely to pick it by accident.
 *                Still an editable list like any other below, not a
 *                hardcoded enum — adding a fourth type later is just
 *                adding a row to mark_lists.json, though it'll default to
 *                the full Catch-level field set until MARK_TYPE_FIELD_KEYS
 *                is taught about it specifically (see that map's own
 *                comment on why that's the safe default).
 *     dateTime:  string — naive "YYYY-MM-DD HH:MM:SS" (see parseNaive
 *                above) — the time the mark is actually ABOUT (when the
 *                catch happened / the spot was found).
 *     createdAt: string — naive "YYYY-MM-DD HH:MM:SS" — when the record was
 *                actually saved. Kept separate from dateTime for the same
 *                reason a paper logbook has both a "when it happened" and a
 *                "when I wrote it down" column: a mark logged from memory
 *                after getting home should show the real catch time on the
 *                chart/map, while createdAt stays useful for sanity-checking
 *                a backfilled entry later. Never shown as the primary time.
 *     notes:     string, optional — free text.
 *     released:  boolean, optional — present and `true` if the catch was
 *                released, absent otherwise (never stored as `false` —
 *                same "presence means yes, absence means no/unknown"
 *                convention as every other optional boolean-shaped field
 *                on this site would use, keeping an unset mark's JSON
 *                free of a field that never actually applied). Catch-only
 *                (see MARK_TYPE_FIELD_KEYS above) — a Mark or POI has no
 *                catch outcome to record in the first place.
 *     size:      number, optional — whole centimetres. Deliberately just a
 *                plain number, not a pick-list field — a measurement, not a
 *                category, so there's nothing to draw a Settings-tab list
 *                from and no colour-by-field/filter support for it either
 *                (see MARK_LIST_FIELDS/MARK_FILTER_ONLY_FIELDS below —
 *                neither includes it).
 *     barometer: number, optional — barometric pressure in hPa at the time
 *                of the mark (typically low-to-high 1000s, e.g. 1013).
 *                Same reasoning as size just above: a plain measurement,
 *                not a pick-list field, so it's absent from
 *                MARK_LIST_FIELDS/MARK_FILTER_ONLY_FIELDS too. Unlike size,
 *                not rounded to a whole number on save — a barometer or
 *                sounder reading is often given to one decimal place (e.g.
 *                1013.2), and there was no "whole units only" convention
 *                asked for here the way there was for size in centimetres.
 *     temperature: number, optional — air temperature in °C at the time of
 *                the mark. Same plain-measurement reasoning as barometer;
 *                not rounded, and (unlike size/barometer/waterDepth) has no
 *                min="0" on its input — a genuinely sub-zero reading is
 *                physically real even if unlikely at these coastal
 *                Victorian marks, so nothing here should silently reject it.
 *     waterTemperature: number, optional — sea surface temperature in °C at
 *                the mark's own point, same units/reasoning as temperature
 *                just above (and as the existing "Water Temp (°C)" series
 *                already used elsewhere on this site's own charts).
 *     waterDepth: number, optional — depth in metres at the mark's own
 *                point. Same plain-measurement reasoning as the others; has
 *                no real automatic source (no lookup fills this in — see
 *                lookupHistoricalMarkConditions's own comment on why), so
 *                it's always hand-entered.
 *     windDirection: string, optional — one of the 16 compass points (e.g.
 *                "SW"). NOT sourced from MARK_LIST_FIELDS/mark_lists.json —
 *                the compass is a fixed physical set, not an editable
 *                Settings-tab pick-list the way Species/Bait/etc are, so
 *                its <select> options come straight from COMPASS_DEGREES
 *                instead (see buildMarkPopupEditHtml).
 *     windSpeed: number, optional — whole km/h, matching this site's wind
 *                units everywhere else (KAYAK_WIND_THRESHOLD_KMH, the
 *                "Wind Forecast (km/h)" chart series, etc).
 *     (windDirection, windSpeed, barometer, temperature, waterTemperature,
 *     weatherCondition, and tideCondition can all be auto-filled via a real
 *     historical lookup — see lookupHistoricalMarkConditions below — but
 *     every one of them stays a normal editable field afterward; the
 *     lookup only ever pre-fills, it never locks a field or marks it as
 *     machine-sourced. waterDepth is the one exception with no lookup at
 *     all — nothing this site already talks to can supply bathymetry for
 *     an arbitrary point, so it's always a manual entry.)
 *     source:    string, optional — "Manual" for any mark created through
 *                this site's own UI (see startNewMarkEntry), "gpx-import"
 *                on the batch migrated once from the old
 *                data/personal-spots.gpx waypoint file (kept distinguishable
 *                since that file only ever recorded ONE date per spot even
 *                when re-caught there many times, so an imported mark's
 *                dateTime is really "most recent catch here", not
 *                necessarily "the only catch here"), or "lowrance-import" /
 *                "garmin-import" from the Sync tab (sync.js) — same
 *                "most recent catch" caveat applies there too when several
 *                device waypoints at the same spot get merged into one
 *                mark on import. Shown on the popup — view mode as a plain
 *                row, edit mode as a read-only field — but never an input
 *                the person can change: it's a record of how the mark came
 *                to exist, not a fact about the mark itself, so editing it
 *                wouldn't mean anything. Genuinely unset (rather than
 *                "Manual") only for the handful of marks created before
 *                this field existed at all. Filterable (see
 *                MARK_FILTER_ONLY_FIELDS) even though it's not one of the
 *                Settings-tab pick-list fields.
 *     sourceUuid: string, optional — the persistent per-waypoint UUID a
 *                Lowrance .usr export embeds (raw hex, not the canonical
 *                8-4-4-4-12 string form — nothing here needs that, just a
 *                stable key). Only ever set on a "lowrance-import" mark.
 *                Lets a LATER re-import of the same device data recognise
 *                "this exact waypoint was already brought in" with
 *                certainty, rather than falling back to the same
 *                distance-based fuzzy match used for Garmin GPX (which has
 *                no persistent per-point ID at all) — see matchAgainstExisting
 *                in sync.js. Never shown or editable in the popup; purely
 *                bookkeeping for the Sync tab's own dedupe.
 *
 *     // Fish-only fields — all optional (a POI mark has none of these; a
 *     // Fish mark may leave any blank too, e.g. a throwback not worth full
 *     // detail). Each value should come from config/mark_lists.json (see
 *     // MARK_LIST_FIELDS below) rather than free text, so filtering and
 *     // export later can group on exact matches instead of near-duplicate
 *     // strings ("Whiting" vs "whiting" vs "small whiting"). "Only make
 *     // sense for a Fish-type mark" is a UI convention, not something
 *     // enforced by this file — a non-Fish mark type added later is free
 *     // to use these fields too if that ever makes sense:
 *     species, weatherCondition, tideCondition, waterCondition,
 *     bait, rig, rod, berley: string
 *   }
 *
 * Deliberately NOT storing yet: photos. Every reader of this array already
 * has to tolerate missing fields (POIs don't have catch fields at all), so
 * adding one more later is a non-breaking change — just not asked for yet.
 */

/**
 * The fixed set of mark fields that draw from an editable pick-list rather
 * than free text — maintained on the Settings tab ("Mark Lists" section,
 * locationsadmin.js) and stored as flat {field, value} rows in
 * config/mark_lists.json, one row per selectable option (`field` matching
 * `label` below exactly, e.g. {"field":"Species","value":"Whiting"}).
 * `key` is the property name actually written onto a mark record above.
 * Kept as a single shared list — rather than duplicated per page — since
 * both the future "add mark" UI on the Live tab and this Settings-tab list
 * editor need to agree on exactly the same set of fields and the same
 * field/record-key mapping, or a value picked on one page could save under
 * a key the other page doesn't know to look for.
 *
 * "type" (Mark Type) is listed first and is the odd one out — every other
 * field here is optional catch detail, while this is the field that decides
 * what KIND of mark it is at all. Made list-driven rather than a hardcoded
 * enum for the same reason the rest are: so a new mark type (a boat ramp, a
 * snag, a bait ground) is a Settings-tab edit, not a code change — currently
 * POI/Mark/Catch as the three real values, plus the retired "Fish" (see
 * MARK_TYPE_FIELD_KEYS, above where `type` gets used) kept around only until
 * it's removed from config/mark_lists.json by hand.
 */
const MARK_LIST_FIELDS = [
  { key: "type", label: "Mark Type" },
  { key: "species", label: "Species" },
  { key: "weatherCondition", label: "Weather Condition" },
  { key: "tideCondition", label: "Tide Condition" },
  { key: "tideExtreme", label: "Tide Extreme" },
  { key: "waterCondition", label: "Water Condition" },
  { key: "bait", label: "Bait" },
  { key: "rig", label: "Rig" },
  { key: "rod", label: "Rod" },
  { key: "berley", label: "Berley" },
];

/**
 * Fields that can be FILTERED on the map (see showMarkFilterModal,
 * markMatchesFilters) but, unlike MARK_LIST_FIELDS above, have no
 * Settings-tab pick-list behind them and aren't shown as an editable
 * dropdown in the mark popup — currently just Source, which is read-only
 * everywhere it appears (see buildMarkPopupEditHtml). Its filter options
 * come from distinctValuesForField, scanning whatever source values
 * actually exist across the loaded marks, rather than a fixed list — so a
 * future new source (e.g. a Garmin import) becomes filterable automatically
 * the moment a mark with that value exists, no code change needed.
 */
const MARK_FILTER_ONLY_FIELDS = [
  { key: "source", label: "Source" },
  { key: "owner", label: "Mark Owner" }, // "Mine", "Public" (Mark, POI) or, Admin only, "Other" (a different real user's own mark, now that Admin can see those too) — see markOwnerLabel
];

// Whose set a mark belongs to, from the CALLER's own point of view: "Mine" (their own account), "Public" (the
// shared set everyone sees) or — reachable by Admin only, who can now see every real user's marks (see
// markReadOwnerIds, user-backend.js), not just their own + Public — "Other" for a different real user's own mark.
// The Worker says so on every mark it sends (`mark.owner`; rowToOwnedMark there computes the exact same three
// buckets). A mark not yet saved is "Mine", the same default the Worker's own markOwnerFor applies: a new mark
// belongs to whoever creates it, whatever its type. Used by the map's Mark Owner filter and to decide
// who may edit a mark. (Its real per-account identity — an actual name, not just this three-way bucket — is a
// separate pair of fields, mark.ownerUserId/mark.ownerName, Admin only: see buildMarkPopupEditHtml's Owner field
// and markTooltipText, js/marks-core.js.)
function markOwnerLabel(mark) {
  return mark.owner || "Mine";
}
/** Whether the signed-in person may edit or delete this mark: Admin any, everyone else only their own (the shared ones are read-only for them). */
function canEditMark(mark) {
  return cachedIsAdmin || (cachedIsSignedIn && markOwnerLabel(mark) === "Mine");
}
/** A mark's value for a filterable field — "owner" is derived from its type, every other field is stored on the mark. */
function markFieldValue(mark, key) {
  return key === "owner" ? markOwnerLabel(mark) : mark[key];
}

/** Sorted list of every distinct non-empty value a given field actually
 * has across the currently-loaded marks — see MARK_FILTER_ONLY_FIELDS. */
function distinctValuesForField(marksById, key) {
  const values = new Set();
  marksById.forEach((mark) => {
    const value = markFieldValue(mark, key);
    if (value) values.add(value);
  });
  return [...values].sort();
}

/**
 * m_<ms since epoch>_<5 random base36 chars> — the random suffix (rather
 * than the timestamp alone) avoids a collision if two marks somehow get
 * created within the same millisecond (e.g. a future bulk import), without
 * needing a real UUID library for what's otherwise a plain string id.
 */
function makeMarkId() {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// --- WillyWeather search / candidate picker (shared) -----------------------
//
// Originally lived only in locationsadmin.js (the Settings tab's "click map
// to add location" flow) — moved here once app.js's Location tab needed the
// exact same "click the map, ask WillyWeather what's really there, let the
// person pick from real candidates" flow for its own "click map to preview
// a spot" feature (see fetchWillyWeatherPreviewRows below, and
// onLocationMapClickForPreview in app.js). Both callers now share one
// implementation instead of two copies that could drift apart.
//
// URL of the willyweather-search Cloudflare Worker (see
// willyweather-search.js) — deliberately empty until it's actually
// deployed. The Worker exists purely to keep the WillyWeather API key off
// this public site (every page here is served as-is by GitHub Pages;
// anyone can view source) while still letting these map-click flows ask
// WillyWeather what's really at a given point. Left blank, both callers
// simply skip the live-suggestion step and fall back to their own
// no-Worker behavior — nothing breaks, it just doesn't get live data until
// this is set. Paste in the Worker's own URL after following the deploy
// steps at the top of willyweather-search.js, e.g.
// "https://fishingconditions-search.your-subdomain.workers.dev" — note the
// "https://" is required; a bare hostname here is a relative path as far
// as fetch() is concerned, not an absolute URL, and would silently 404
// against this site's own origin instead of ever reaching the Worker.
const WILLYWEATHER_SEARCH_WORKER_URL = "https://fishingconditions-search.oliver-mestdagh.workers.dev";

/**
 * Calls the willyweather-search Worker's coordinate-search endpoint.
 * Returns an array (possibly empty) on success, or null on any failure
 * (network error, non-OK response, Worker not yet deployed at this URL,
 * malformed response) — null is the signal callers use to fall back to
 * their own no-Worker behavior rather than getting stuck. Never throws.
 */
async function fetchWillyWeatherCandidates(lat, lng) {
  if (!WILLYWEATHER_SEARCH_WORKER_URL) return null;
  try {
    const res = await fetch(`${WILLYWEATHER_SEARCH_WORKER_URL}/search?lat=${lat}&lng=${lng}`);
    if (!res.ok) {
      console.error("willyweather-search Worker returned", res.status);
      return null;
    }
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch (err) {
    console.error("willyweather-search Worker request failed:", err);
    return null;
  }
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * What the person actually sees as a location's own name, everywhere on
 * the site — Oliver's own request, a new displayName field distinct from
 * loc.name (relabeled "Willyweather search name" in the Settings editor,
 * unchanged in the data itself — still the string every WillyWeather
 * lookup, and every internal matching/grouping key across marks, sun
 * times, pinned/selected location lists, session-window computation etc,
 * continues to use exactly as before). Falls back to loc.name whenever
 * displayName isn't set yet — every pre-existing location until the
 * one-time migration runs (locationsadmin.js's own "Migrate now" button),
 * and defensively forever after for any location that somehow still
 * lacks one. Never itself used as a lookup/matching key anywhere — call
 * sites that need to identify or group a location keep reading loc.name
 * directly, exactly as they did before this existed.
 */
/** Whether the person viewing may see this tracked location: Public's always, and the signed-in person's own —
 * never another account's (their forecasts are in the public data file too, the pages just don't show them). A
 * location with no owner recorded (an older data file) counts as Public's. Needs refreshAdminStatus to have run
 * for a signed-in person's own to show. */
function locationVisibleToViewer(loc) {
  const owner = loc && loc.ownerId;
  return !owner || owner === "public" || (typeof cachedUserId !== "undefined" && cachedUserId != null && owner === cachedUserId);
}

function displayNameFor(loc) {
  return (loc && (loc.displayName || loc.name)) || "";
}

/**
 * Shows a small modal listing WillyWeather's candidate locations near a
 * map click, and resolves once the person picks one, chooses to enter/skip
 * manually instead, or cancels outright. Built fresh each call and torn
 * down on any exit path.
 *
 * opts.allowManual (default true) controls whether the "None of these"
 * button appears at all — the Settings tab's "click to add" flow has a
 * genuine manual-entry fallback to offer (createNewLocationAt with no
 * candidate), but the Location tab's "click to preview" flow has nothing
 * meaningful to fall back to (there's no location to preview without a
 * real WillyWeather match) — see onLocationMapClickForPreview, app.js.
 *
 * Resolves to one of:
 *   { action: "pick", candidate }  — chose a specific WillyWeather match
 *   { action: "manual" }           — "None of these" (only when allowManual)
 *   { action: "cancel" }           — closed without choosing anything
 */
function showLocationCandidatePicker(candidates, opts = {}) {
  const allowManual = opts.allowManual !== false;
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "ww-candidate-overlay";

    const items = candidates
      .map(
        (c, i) => `
      <button type="button" class="ww-candidate-item" data-candidate-idx="${i}">
        <span class="ww-candidate-name">${escapeHtml(c.name || "(unnamed)")}</span>
        <span class="ww-candidate-meta">${escapeHtml([c.region, c.state].filter(Boolean).join(", "))}</span>
      </button>`
      )
      .join("");

    overlay.innerHTML = `
      <div class="ww-candidate-dialog">
        <button type="button" class="ww-candidate-close" aria-label="Cancel">&times;</button>
        <h3 style="margin:0 0 4px;">What's here on WillyWeather?</h3>
        <p class="footnote" style="margin:0 0 12px;">Pick the real match so weather/tide data resolves correctly.</p>
        <div class="ww-candidate-list">${items}</div>
        ${allowManual ? `<button type="button" id="wwCandidateManual" class="btn-secondary" style="margin-top:12px;width:100%;">None of these — enter a name manually</button>` : ""}
      </div>
    `;
    document.body.appendChild(overlay);

    const cleanup = (result) => {
      overlay.remove();
      resolve(result);
    };

    overlay.querySelector(".ww-candidate-close").addEventListener("click", () => cleanup({ action: "cancel" }));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup({ action: "cancel" });
    });
    const manualBtn = overlay.querySelector("#wwCandidateManual");
    if (manualBtn) manualBtn.addEventListener("click", () => cleanup({ action: "manual" }));
    overlay.querySelectorAll(".ww-candidate-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.candidateIdx);
        cleanup({ action: "pick", candidate: candidates[idx] });
      });
    });
  });
}
