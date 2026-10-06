// Trip log, reading side: pure helpers (no DOM, no network) that turn the rows of GET /api/triplog into what the Trip Logs tab
// (triplogs.html / triplogs.js) shows. Loaded by that page only; the writing side is js/trip-log.js (conditions.html).
// Unit-tested: tests/trip-log.test.mjs.

const TRIP_LOG_TYPE_LABELS = { trip_start: "Trip started", trip_end: "Trip ended", action_start: "Action started", action_end: "Action ended", change: "Changed", catch: "Catch" };
const TRIP_LOG_CHANGE_LABELS = { rod_setups: "rod setups", water: "water", depth: "depth", action: "action", "water+depth": "water + depth" };

/** "Trip started", "Changed (rod setups)", "Catch" … */
function tripLogEventLabel(e) {
  const label = TRIP_LOG_TYPE_LABELS[e.type] || e.type;
  if (e.type === "change" && e.changeField) return `${label} (${TRIP_LOG_CHANGE_LABELS[e.changeField] || e.changeField})`;
  return label;
}

/** One rod setup in force at an entry, as one text line: "Penn Paternoster — Octopus 3/0 · Squid · Wing Strip" (the setup's name, then its rig options, bait and bait options). */
function tripLogGearLine(r) {
  const label = r.name || [r.rod, r.rig].filter(Boolean).join(" · ") || "Rod";
  const details = [(r.rigOptions || []).join(", "), (r.bait || []).join(", "), (r.baitOptions || []).join(", ")].filter(Boolean).join(" · ");
  return details ? `${label} — ${details}` : label;
}

/** The rod and rig behind a setup's name, for a tooltip ("" when the name already is all there is). */
function tripLogGearTitle(r) {
  return r.name ? [r.rod, r.rig].filter(Boolean).join(" · ") : "";
}

/** Every rod setup in force at an entry, one text line each. */
function tripLogGearLines(rods) {
  return (rods || []).map(tripLogGearLine);
}

/** Water and depth: "Murky, 2.5 m" ("" when neither is known). */
function tripLogWaterText(e) {
  return [e.waterCondition, e.waterDepth != null ? `${e.waterDepth} m` : ""].filter(Boolean).join(", ");
}

/** Tide, weather, wind and temperatures: "Running In (HHW) · Cloudy · 13 km/h SSW · 14.2°C · 1022.9 hPa" ("" while still to be looked up). */
function tripLogConditionsText(e) {
  const tide = e.tideCondition ? `${e.tideCondition}${e.tideExtreme ? ` (${e.tideExtreme})` : ""}` : "";
  const wind = e.windSpeed != null || e.windDirection ? [e.windSpeed != null ? `${e.windSpeed} km/h` : "", e.windDirection].filter(Boolean).join(" ") : "";
  return [tide, e.weatherCondition, wind, e.temperature != null ? `${e.temperature}°C` : "", e.barometer != null ? `${e.barometer} hPa` : ""].filter(Boolean).join(" · ");
}

/** What a catch was: "Bream 31 cm (released)" ("" for any other entry). */
function tripLogCatchText(e) {
  if (e.type !== "catch") return "";
  return [e.species, e.size != null ? `${e.size} cm` : "", e.released ? "(released)" : ""].filter(Boolean).join(" ");
}

/**
 * How long each action ran: Map of entry index -> ms, for every action_start entry that has something after it — from its time to the
 * next action_start / action_end / trip_end of the run (a Change doesn't end it; starting another action ends the previous one). Same rule as
 * the Worker's `fishedMs` (tlogListRuns), so a trip's lines add up to its header. `entries` are in time order.
 */
function tripLogDurations(entries) {
  const out = new Map();
  let open = -1;
  entries.forEach((e, i) => {
    if (e.type !== "action_start" && e.type !== "action_end" && e.type !== "trip_end") return;
    if (open >= 0) out.set(open, Math.max(0, e.ts - entries[open].ts));
    open = e.type === "action_start" ? i : -1;
  });
  return out;
}

/** "45 s", "12 min", "1 h 05 min". */
function tripLogFormatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}

/** "+0:47" — how far into the trip an entry is. */
function tripLogElapsed(startTs, ts) {
  const min = Math.max(0, Math.round((ts - startTs) / 60000));
  return `+${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}

/** "Sun 4 Oct" from a naive "YYYY-MM-DD HH:MM:SS" — the date as written, no time-zone shifting. */
function tripLogDateLabel(dateTime) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateTime || "");
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/** The header's flags as short words: "approx. times", "weather pending". */
function tripLogFlags(run) {
  return [run.approximate ? "approx. times" : "", run.pending ? "weather pending" : "", run.hasTripEnd ? "" : "no end logged"].filter(Boolean);
}

/** Totals for the summary line over a list of run headers. */
function tripLogTotals(runs) {
  return runs.reduce((t, r) => ({ trips: t.trips + 1, fishedMs: t.fishedMs + (r.fishedMs || 0), catches: t.catches + (r.catches || 0) }), { trips: 0, fishedMs: 0, catches: 0 });
}

/** Whether an entry's time is only approximate: a rebuilt (Backfill) entry with no mark of its own to take the time from (trip start / end, an action end). */
function tripLogIsApprox(e) {
  return e.source === "Backfill" && !e.markId;
}

// --- Editing (the Trip Logs tab's line editor) -----------------------------------------------------------------------

const TRIP_LOG_EVENT_TYPES = ["trip_start", "action_start", "change", "catch", "action_end", "trip_end"];
const TRIP_LOG_CHANGE_FIELDS = ["rod_setups", "action", "water", "depth", "water+depth"];
const TRIP_LOG_TIDE_EXTREMES = ["HHW", "LHW", "HLW", "LLW"];

/** "" (blank) -> null, a number text -> the number, anything else -> undefined (invalid). */
function tripLogParseNumber(text) {
  const t = String(text == null ? "" : text).trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The PATCH / POST body for an edited line, from the editor's form values `f` (text for every input, lists for the chip groups):
 * {body} or {error}. Blank text becomes null (which clears the field on the Worker); catch-only fields are cleared on any other event.
 */
function tripLogBuildPatch(f) {
  const time = String(f.time || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(f.date || "").trim()) || !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) return { error: "Give the line a date and time." };
  const body = { manual: true, dateTime: `${f.date.trim()} ${time.length === 5 ? `${time}:00` : time}`, type: f.type };
  const text = (v) => (String(v == null ? "" : v).trim() === "" ? null : String(v).trim());
  for (const key of ["actionName", "waterCondition", "tideCondition", "tideExtreme", "weatherCondition", "windDirection", "berley"]) body[key] = text(f[key]);
  body.changeField = f.type === "change" ? text(f.changeField) : null;
  const numbers = { waterDepth: "Depth", windSpeed: "Wind speed", temperature: "Air temperature", barometer: "Pressure", waterTemperature: "Water temperature", lat: "Latitude", lng: "Longitude" };
  for (const [key, label] of Object.entries(numbers)) {
    const n = tripLogParseNumber(f[key]);
    if (n === undefined) return { error: `${label} must be a number.` };
    body[key] = n;
  }
  body.fishingMethod = f.fishingMethod || [];
  body.targets = f.targets || [];
  if (f.type === "catch") {
    const size = tripLogParseNumber(f.size);
    if (size === undefined) return { error: "Size must be a number." };
    body.species = text(f.species);
    body.size = size;
    body.released = !!f.released;
  } else {
    body.species = null;
    body.size = null;
    body.released = null;
  }
  body.rods = (f.rods || []).map((r, i) => ({
    slot: i + 1, rodSetupId: text(r.rodSetupId), name: text(r.name), rod: text(r.rod), rig: text(r.rig), rigOptions: r.rigOptions || [], bait: r.bait || [], baitOptions: r.baitOptions || [],
  }));
  return { body };
}

/** A new rod row's values, taken from one of the user's Rod Setups (or blank). */
function tripLogRodFromSetup(setup) {
  if (!setup) return { rodSetupId: "", name: "", rod: "", rig: "", rigOptions: [], bait: [], baitOptions: [] };
  return {
    rodSetupId: setup.id, name: setup.name || "", rod: setup.rod || "", rig: setup.rig || "",
    rigOptions: [...(setup.subListItems || [])], bait: [...(setup.bait || [])], baitOptions: [...(setup.baitOptions || [])],
  };
}

/** The options a Rig / Bait row offers under it: its own sub list, else the person's private one (`overrides`: Map rowId -> names) — tdRigSublist. */
function tripLogSublist(listRow, overrides) {
  if (!listRow) return [];
  if (listRow.hasSublist) return Array.isArray(listRow.subList) ? listRow.subList : [];
  return (overrides && overrides.get(listRow.id)) || [];
}

/** `values` plus `current` entries the list no longer has (an old log can name something since removed from the lists), without repeats. */
function tripLogChoices(values, current) {
  const out = [...new Set(values || [])];
  for (const c of [].concat(current || [])) if (c && !out.includes(c)) out.push(c);
  return out;
}

// --- The Reports tab's source ---------------------------------------------------------------------------------------------------------
// Reports (reports.js, session-ribbon.js, tide-clock.js) work on mark-shaped objects. GET /api/triplog?report=1 returns the log's catch,
// action_start, action_end and trip_end rows; this turns them into that shape so the report code doesn't care where they came from.

const TRIP_LOG_REPORT_CONDITION_FIELDS = ["tideCondition", "tideExtreme", "weatherCondition", "windSpeed", "windDirection", "barometer", "temperature", "waterTemperature"];

/**
 * Log rows -> mark-like objects: every catch row is a "Catch" (its rods' rod / rig / bait joined with commas, as a mark holds them); every
 * action is a "Session Start" + "Session End" pair sharing a sessionGroupId (<runId>:<n>) — an action runs from its action_start to the
 * next action_start / action_end / trip_end of its run (the rule of tripLogDurations); one still running has no End. Rows come in time order.
 */
function tripLogToReportMarks(entries) {
  const out = [];
  const byRun = new Map();
  for (const e of entries || []) {
    if (!byRun.has(e.runId)) byRun.set(e.runId, []);
    byRun.get(e.runId).push(e);
  }
  const joined = (list) => [...new Set(list.filter(Boolean))].join(", ");
  const conditions = (e) => {
    const o = {};
    for (const f of TRIP_LOG_REPORT_CONDITION_FIELDS) if (e[f] != null && e[f] !== "") o[f] = e[f];
    return o;
  };
  for (const [runId, rows] of byRun) {
    let n = 0;
    let open = null;
    const close = (e) => {
      if (!open) return;
      out.push({ id: `${open.groupId}:end`, type: "Session End", name: open.name, sessionGroupId: open.groupId, dateTime: e.dateTime, lat: e.lat, lng: e.lng });
      open = null;
    };
    for (const e of rows) {
      if (e.type === "catch") {
        const rods = e.rods || [];
        out.push({
          id: e.markId || e.id, type: "Catch", name: e.species || "Catch", dateTime: e.dateTime, lat: e.lat, lng: e.lng, species: e.species || "", size: e.size, released: e.released,
          waterCondition: e.waterCondition, waterDepth: e.waterDepth, berley: e.berley || "", fishingMethod: (e.fishingMethod || []).join(", "),
          rod: joined(rods.map((r) => r.rod)), rig: joined(rods.map((r) => r.rig)), bait: joined(rods.flatMap((r) => r.bait || [])), ...conditions(e),
        });
      } else if (e.type === "action_start") {
        close(e);
        open = { groupId: `${runId}:${n++}`, name: e.actionName || e.tripName || "Session" };
        out.push({ id: `${open.groupId}:start`, type: "Session Start", name: open.name, sessionGroupId: open.groupId, dateTime: e.dateTime, lat: e.lat, lng: e.lng, ...conditions(e) });
      } else if (e.type === "action_end" || e.type === "trip_end") {
        close(e);
      }
    }
  }
  return out;
}
