// Trip log, site side (conditions.html). Everything done during a trip run is also written to D1's trip_log / trip_log_rods
// (schema-v2.sql; user-backend.js "Trip log") so reports can be run on it later. The Fishing Controller's events are logged by the Worker
// itself (ctlProcessEvent); this file does the same for what is done on the site's Live page:
//   trip start/end, action start/end, Water / Depth / rod-setup changes, catches.
// Marks are unaffected: the log is written in ADDITION, queued in localStorage and retried, so a failed log never blocks a mark.
// A state (action, rod setups, water, depth) lasts from its row until the next row of the run — see schema-v2.sql — so action starts and
// changes always carry the full state.
// Also: the browser's weather/tide fallback (enrichTripLog). Reading the log is the Trip Logs tab (triplogs.html, js/trip-log-view.js).

const TRIP_LOG_QUEUE_KEY = "tripLogQueue";
const TRIP_LOG_MAX_QUEUE = 500;

// --- Pure helpers (unit-tested: tests/trip-log.test.mjs) -----------------------------------------------------

/** A fresh id for one trip run (Worker twin: ctlNewId("run")). */
function tripLogNewRunId() {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** The rod setups an Action holds as trip_log_rods rows — twin of tlogRodRows in user-backend.js: placed ones take their position (1-4), the rest follow from 5; `onlyId` keeps just that setup. */
function tripLogRodRows(action, rodSetups, onlyId = null) {
  const ids = tdLiveRodSetupIds(action && action.rodSetupIds, rodSetups);
  const slots = (action && action.rodSlots) || [];
  let spare = 5;
  const out = [];
  for (const id of ids) {
    if (onlyId && id !== onlyId) continue;
    const s = rodSetups.find((r) => r.id === id);
    const at = slots.indexOf(id);
    out.push({
      slot: at >= 0 ? at + 1 : spare++, rodSetupId: s.id, name: s.name || null, rod: s.rod || null, rig: s.rig || null,
      rigOptions: s.subListItems || [], bait: s.bait || [], baitOptions: s.baitOptions || [],
    });
  }
  return out;
}

/** The setup a Catch used: the chosen one, else the Action's only one — as tdCatchFieldsFromAction picks it. */
function tripLogCatchRodRows(action, rodSetups, setupId) {
  const ids = tdLiveRodSetupIds(action && action.rodSetupIds, rodSetups);
  const used = setupId || (ids.length === 1 ? ids[0] : null);
  return used ? tripLogRodRows(action, rodSetups, used) : [];
}

/**
 * One entry to post: `fields` are the event's own values (type, lat/lng, tripId/tripName, action..., water, depth, markId, species...).
 * `now` = {dateTime, ts} (site wall-clock text and real UTC ms). The offset is what turns one into the other.
 */
function tripLogBuildEntry(runId, fields, now) {
  const offset = Math.round((parseNaive(now.dateTime) - now.ts) / 60000);
  return { uuid: `site_${now.ts}_${Math.random().toString(36).slice(2, 8)}`, runId, ts: now.ts, dateTime: now.dateTime, tzOffsetMin: offset, ...fields };
}

/** The state-carrying part of an entry for an Action: its berley / method / targets and every rod setup in force. */
function tripLogActionState(action, rodSetups) {
  return { actionId: action.id, actionName: action.name, berley: action.berley || null, fishingMethod: action.fishingMethod || [], targets: action.species || [], rods: tripLogRodRows(action, rodSetups) };
}

// --- Queue + posting -----------------------------------------------------------------------------------------

function tripLogReadQueue() {
  try {
    const q = JSON.parse(localStorage.getItem(TRIP_LOG_QUEUE_KEY));
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}
function tripLogWriteQueue(q) {
  try {
    localStorage.setItem(TRIP_LOG_QUEUE_KEY, JSON.stringify(q.slice(-TRIP_LOG_MAX_QUEUE)));
  } catch {
    // storage unavailable: entries still go out on the first try
  }
}

let tripLogFlushing = false;

/** Posts the queued entries (oldest first, 50 at a time); what the server took or refused leaves the queue, the rest stays for next time. */
async function flushTripLog() {
  if (tripLogFlushing) return;
  tripLogFlushing = true;
  try {
    for (;;) {
      const queue = tripLogReadQueue();
      if (!queue.length) return;
      let results;
      try {
        const res = await fetch(`${USER_BACKEND_URL}/api/triplog`, {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events: queue.slice(0, 50) }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        results = (await res.json()).results || [];
      } catch {
        return; // offline or the Worker is down: everything stays queued for the next flush
      }
      const settled = new Set(results.map((r) => r.uuid));
      // re-read: entries queued while this request was out must not be lost
      tripLogWriteQueue(tripLogReadQueue().filter((e) => !settled.has(e.uuid)));
      if (!results.length) return;
    }
  } finally {
    tripLogFlushing = false;
  }
}

/** Queues one entry and tries to send it. `state` is the running trip ({tripId, runId}); an entry for no trip is not logged. */
function logTripEvent(state, fields) {
  if (!state || !state.tripId || !state.runId) return;
  const ts = Date.now();
  const entry = tripLogBuildEntry(state.runId, fields, { ts, dateTime: nowAsNaiveString() });
  tripLogWriteQueue([...tripLogReadQueue(), entry]);
  flushTripLog();
}

/**
 * Called when something in Trip Defaults was saved: if that changes the Action running now (the Action itself, or one of its Rod Setups),
 * logs a `change` with the whole new state. `path` is the route that was saved ("/api/tripactions" | "/api/rodsetups" | ...), `id` the row.
 */
function tripLogNoteDefaultsEdit(path, id, data, state, position) {
  if (!state || !state.tripId || !state.actionId) return;
  const action = data.actions.find((a) => a.id === state.actionId);
  if (!action) return;
  const hit = path === "/api/tripactions" ? id === action.id : path === "/api/rodsetups" ? tdLiveRodSetupIds(action.rodSetupIds, data.rodSetups).includes(id) : false;
  if (!hit) return;
  const trip = (data.trips || []).find((t) => t.id === action.tripId);
  const d = typeof getLiveMarkDefaults === "function" ? getLiveMarkDefaults() : { water: "", depth: null };
  logTripEvent(state, {
    type: "change", changeField: path === "/api/rodsetups" ? "rod_setups" : "action", tripId: action.tripId, tripName: trip ? trip.name : null,
    sessionGroupId: state.sessionGroupId || null, water: d.water || null, depth: d.depth, lat: position ? position.lat : null, lng: position ? position.lng : null,
    ...tripLogActionState(action, data.rodSetups),
  });
}

// --- Weather / tide backfill ---------------------------------------------------------------------------------

const TRIP_LOG_ENRICH_KEY = "tripLogEnrichTried";

/**
 * Fills the weather/tide of log rows still without them — at an opportune moment (Live's account sync), not when the event is logged.
 * Uses the same lookup as marks (fillBlankMarkConditions); a row is marked done even when nothing came back, so it isn't retried forever.
 */
async function enrichTripLog() {
  if (typeof fillBlankMarkConditions !== "function") return;
  let todo;
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/triplog?needsConditions=1&limit=10&_=${Date.now()}`, { cache: "no-store", credentials: "include" });
    if (!res.ok) return;
    todo = await res.json();
  } catch {
    return;
  }
  let tried = {};
  try {
    tried = JSON.parse(localStorage.getItem(TRIP_LOG_ENRICH_KEY)) || {};
  } catch {
    tried = {};
  }
  for (const row of todo) {
    if ((tried[row.id] || 0) >= 3) continue; // looked up three times without it being saved: leave it
    tried[row.id] = (tried[row.id] || 0) + 1;
    try {
      localStorage.setItem(TRIP_LOG_ENRICH_KEY, JSON.stringify(tried));
    } catch {
      // storage unavailable
    }
    const probe = { lat: row.lat, lng: row.lng, dateTime: row.dateTime };
    try {
      await fillBlankMarkConditions(probe);
    } catch {
      continue; // the lookup failed (offline): retry next time
    }
    const patch = {};
    for (const key of ["tideCondition", "tideExtreme", "weatherCondition", "windDirection", "windSpeed", "barometer", "temperature", "waterTemperature"]) {
      if (probe[key] !== undefined && probe[key] !== null && probe[key] !== "") patch[key] = probe[key];
    }
    try {
      await fetch(`${USER_BACKEND_URL}/api/triplog/${encodeURIComponent(row.id)}`, {
        method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
    } catch {
      // next time
    }
  }
}
