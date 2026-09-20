// prefs.js
// Saves a signed-in user's filters, favourites and plans to their account (D1, via the Worker's /api/prefs) so they follow them across devices. Signed out, offline, or with third-party cookies blocked, nothing changes: everything still lives in this device's localStorage, exactly as before.
// Existing code keeps reading localStorage directly (synchronously); it writes through Prefs.set / Prefs.remove instead, and each page awaits Prefs.load() at the start of its init. The decisions are pure functions (tested in tests/prefs.test.mjs).
//
// Which settings sync (must match SYNCED_PREF_KEYS in user-backend.js):
//   Week Ahead filters, thresholds, favourites (pins), planned sessions, Live "home by" time, the last-viewed location, the map's colour-by/filters and the last-used mark values.
// Not synced: map position/zoom, collapsed panels, caches and credentials.
//
// Conflicts: the account wins. The first time a device meets an account, values the account has never saved are uploaded from the device once. A change made on this device that hasn't reached the server yet ("pending") wins for that key. If a different person signs in on the same device, the previous person's synced values are cleared first, so they are never uploaded into the wrong account.

const SYNCED_PREF_KEYS = [
  "goodConditionsSelectedLocations",
  "goodConditionsSelectedTypes",
  "goodConditionsSelectedGroups",
  "goodConditionsSelectedDirections",
  "goodConditionsThresholds",
  "goodConditionsPinnedLocationsNew",
  "goodConditionsComputedSessions",
  "liveHomeTimings",
  "selectedLocation",
  "markViewSettings",
  "markLastFieldValues",
];
const PREFS_OWNER_KEY = "prefsOwner"; // which account this device's synced values belong to
const PREFS_PENDING_KEY = "prefsPending"; // keys changed here that the server hasn't confirmed yet
const PREFS_LOAD_TIMEOUT_MS = 2500;

/**
 * What to do when the account's saved values (`server`: {key: string}) meet this device's (`local`: {key: string}).
 * `owner`: the account id the device's values were last synced with (null if never), `userId`: who is signed in now,
 * `pending`: keys changed on this device but not yet sent. Returns
 *   { clearLocal: [keys to remove first], toLocal: {key: value}, toServer: {key: value | null} }
 * Rules: a different owner's values are discarded; a pending local change goes up (null = it was removed);
 * otherwise the account's value wins; a key only the device has is uploaded once.
 */
function prefsMergePlan({ server, local, owner, userId, pending }) {
  const clearLocal = [];
  const toLocal = {};
  const toServer = {};
  const differentPerson = owner != null && owner !== userId;
  const mine = differentPerson ? {} : local;
  const pendingKeys = differentPerson ? [] : pending;
  if (differentPerson) {
    for (const key of SYNCED_PREF_KEYS) if (local[key] != null) clearLocal.push(key);
  }
  for (const key of SYNCED_PREF_KEYS) {
    if (pendingKeys.includes(key)) {
      toServer[key] = mine[key] != null ? mine[key] : null;
    } else if (server[key] != null) {
      if (mine[key] !== server[key]) toLocal[key] = server[key];
    } else if (mine[key] != null) {
      toServer[key] = mine[key];
    }
  }
  return { clearLocal, toLocal, toServer };
}

const Prefs = (() => {
  let signedIn = false;
  let loadPromise = null;
  let flushTimer = null;

  const read = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const write = (key, value) => {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* storage blocked or full — nothing more to do */
    }
  };
  const readPending = () => {
    try {
      const list = JSON.parse(read(PREFS_PENDING_KEY) || "[]");
      return Array.isArray(list) ? list.filter((k) => SYNCED_PREF_KEYS.includes(k)) : [];
    } catch {
      return [];
    }
  };
  const writePending = (list) => write(PREFS_PENDING_KEY, list.length ? JSON.stringify(list) : null);

  /** Sends the given keys' current device values (null = removed) to the account. Keeps them pending if it fails. */
  async function send(keys, keepalive) {
    if (!signedIn || keys.length === 0) return true;
    const changes = {};
    for (const key of keys) changes[key] = read(key);
    try {
      const res = await fetch(`${USER_BACKEND_URL}/api/prefs`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes }),
        keepalive: !!keepalive,
      });
      if (res.status === 401) signedIn = false; // the session ended; carry on with this device only
      if (!res.ok) return false;
      writePending(readPending().filter((k) => !keys.includes(k)));
      return true;
    } catch {
      return false;
    }
  }

  function flush(keepalive) {
    clearTimeout(flushTimer);
    flushTimer = null;
    return send(readPending(), keepalive);
  }

  function changed(key) {
    if (!SYNCED_PREF_KEYS.includes(key) || !signedIn) return;
    const pending = readPending();
    if (!pending.includes(key)) writePending([...pending, key]);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => flush(false), 1000);
  }

  /** Once per page: pulls the account's values into localStorage (and uploads what it lacks). Never rejects; failure just means "this device only". */
  function load() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PREFS_LOAD_TIMEOUT_MS);
      let body = null;
      try {
        const res = await fetch(`${USER_BACKEND_URL}/api/prefs`, { credentials: "include", signal: controller.signal });
        if (res.ok) body = await res.json();
      } catch {
        body = null; // offline, timed out or blocked
      } finally {
        clearTimeout(timer);
      }
      if (!body || !body.userId || !body.prefs) {
        signedIn = false;
        return;
      }
      signedIn = true;
      const server = {};
      for (const [key, entry] of Object.entries(body.prefs)) server[key] = entry.value;
      const local = {};
      for (const key of SYNCED_PREF_KEYS) local[key] = read(key);
      const owner = read(PREFS_OWNER_KEY);
      const plan = prefsMergePlan({ server, local, owner, userId: body.userId, pending: readPending() });
      for (const key of plan.clearLocal) write(key, null);
      if (owner != null && owner !== body.userId) writePending([]); // another person's unsent changes are dropped with their values
      for (const [key, value] of Object.entries(plan.toLocal)) write(key, value);
      write(PREFS_OWNER_KEY, body.userId);
      const upload = Object.keys(plan.toServer);
      if (upload.length) {
        // send() reads the device values, so first make sure a removal (null) is what's on the device
        for (const key of upload) if (plan.toServer[key] == null) write(key, null);
        writePending([...new Set([...readPending(), ...upload])]);
        await send(upload, false);
      }
    })();
    return loadPromise;
  }

  return {
    load,
    /** Same as localStorage.setItem, and saves it to the account when signed in. */
    set(key, value) {
      write(key, value);
      changed(key);
    },
    /** Same as localStorage.removeItem, and removes it from the account when signed in. */
    remove(key) {
      write(key, null);
      changed(key);
    },
    /** Sends anything still waiting right now (used when the page closes or the connection returns). */
    flushNow() {
      return flush(true);
    },
  };
})();

if (typeof window !== "undefined") {
  Prefs.load(); // start the request as early as possible; pages await it before reading their settings
  window.addEventListener("online", () => Prefs.load().then(() => Prefs.flushNow())); // changes made while offline go up when the connection returns
  window.addEventListener("pagehide", () => {
    // best-effort send of anything still waiting (keepalive lets it finish while the page closes)
    try {
      Prefs.flushNow();
    } catch {
      /* ignore */
    }
  });
}
