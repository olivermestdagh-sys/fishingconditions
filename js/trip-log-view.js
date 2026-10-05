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
