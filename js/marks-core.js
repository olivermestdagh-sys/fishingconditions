// marks-core.js
// Fishing marks, part 1: how a mark looks (colour/style/tooltip), the popup forms for viewing and editing a mark, quick-entry defaults, and the TIDE LOGIC (rankExtremum, classifyTideFromExtrema) that gives new marks their Tide Condition and Tide Extreme.
// One of the shared scripts split out of the old charts.js. All of them share one global scope; each page loads
// only the ones it needs, in this order (checked by scripts/check-page-scripts.mjs).

// --- Fishing marks map layer -------------------------------------------------
//
// The site owner's own catch/POI history (data/marks.json — see the "GPS
// fishing marks" schema block above) — shown as an extra layer over the
// Location and Live tabs' maps, gated behind having a GitHub connection set
// up (see loadAndRenderMarks).
//
// Previously this read data/personal-spots.gpx directly (a raw export from
// a chartplotter app) and styled each point by its GPX <sym> value — that
// data has since been migrated into data/marks.json as real mark records
// (see the one-off migration this schema was built for), and both the
// Location and Live tabs now read the marks file instead. parseGpxWaypoints
// below is no longer called from anywhere — kept only in case the raw GPX
// ever needs re-parsing (a fresh export, or a fresh device import) — but is
// genuinely orphaned code today; safe to delete once that's confirmed
// unneeded.

/**
 * Deterministic string -> 0-359 hue, so every distinct Species (or Mark
 * Type, for a mark with none) gets its own stable, distinguishable colour
 * on the map WITHOUT a hardcoded per-value styling table — species is an
 * open, Settings-tab-editable list now (see MARK_LIST_FIELDS above), so a
 * fixed lookup table (the old PERSONAL_SPOT_SYM_STYLES's approach) would
 * silently fall back to one dull default colour for every new species added
 * from now on. Not cryptographic, just needs to be stable and reasonably
 * spread out — good enough for "eyeball which colour is which species".
 */
function hashStringToHue(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/**
 * Map pin style for one mark record, coloured by whichever field
 * `state.groupByKey` currently selects (Species by default — see
 * createMarkLayerState/MARK_LIST_FIELDS) rather than always Species: if
 * that field's value has a colour assigned on the Settings tab's Fishing
 * Mark Lists (see onSetMarkListValueColor, locationsadmin.js), that exact
 * colour is used; otherwise falls back to hashStringToHue on the value
 * itself, so anything not yet given a real colour still gets a stable,
 * distinguishable one for free. A mark with no value at all for the
 * current group field (e.g. grouping by Bait, but this mark has none set)
 * gets MARK_NO_VALUE_STYLE — a neutral grey — rather than hashing an empty
 * string, which would misleadingly paint every "no value" mark the exact
 * same (meaningless) colour as whatever value happens to hash the same.
 *
 * No more hardcoded "POI always gets a flag icon" special case (the
 * previous version of this function had one) — now that any value on any
 * field can be given its own colour from Settings, a POI mark stands out
 * by giving "POI" its own colour there (under Mark Type) same as any other
 * value, rather than code baking in one specific value's appearance.
 */
const MARK_NO_VALUE_STYLE = { color: "#374151", fillColor: "#9ca3af", radius: 4, weight: 1 };

function markStyleFor(mark, state) {
  const groupField = MARK_LIST_FIELDS.find((f) => f.key === state.groupByKey) || MARK_LIST_FIELDS[0];
  const value = mark[state.groupByKey];
  if (!value) return MARK_NO_VALUE_STYLE;
  // A resolved Mark COLOUR Format's own colour (a real hex value — see
  // "an icon + a colour picker for the web site" in locationsadmin.js's
  // Mark Colour Format section) takes priority — every pick-list field's
  // values can have one assigned now, so this applies to whatever field
  // is currently being grouped by. Species/Mark Type specifically go
  // through resolveMarkColorFormat's own species-wins-over-type priority
  // (see its own comment); every OTHER field just checks that field's own
  // value directly (resolveColorFormatForFieldValue), since there's no
  // equivalent priority relationship between two different fields to
  // resolve. Shape is handled entirely separately (see shapeNameForMark)
  // — this function only ever decides colour.
  const format = state.groupByKey === "species" || state.groupByKey === "type"
    ? resolveMarkColorFormat(mark, state.markLists)
    : resolveColorFormatForFieldValue(groupField.label, value, state.markLists);
  if (format && format.color) {
    return { color: "#374151", fillColor: format.color, radius: 5, weight: 1.5 };
  }
  // Legacy hex fallback — a value that hasn't been given a Colour Format
  // at all still respects a plain `color` if one happens to already be
  // sitting on it from before Mark Formats existed (the Settings tab no
  // longer offers a way to SET a new one this way — but old data that
  // already has one keeps working).
  const tileEntry = (state.markLists || []).find((r) => r.field === groupField.label && r.value === value);
  if (tileEntry && tileEntry.color) {
    return { color: "#374151", fillColor: tileEntry.color, radius: 5, weight: 1.5 };
  }
  const hue = hashStringToHue(value);
  return { color: `hsl(${hue}, 70%, 25%)`, fillColor: `hsl(${hue}, 65%, 50%)`, radius: 4, weight: 1 };
}

// "<group value> — Name — Species (YYYY-MM-DD) · source" — the group-value
// prefix is whatever field state.groupByKey currently has selected (see
// markStyleFor's own comment), so the tooltip always names the exact thing
// the colour is standing for, whether that's Species, Tide Condition, or
// anything else. Omitted when this mark has no value for that field, same
// as the trailing "· source" (omitted entirely for the handful of marks
// created before that field existed at all). Plain slice of the naive
// dateTime string rather than a locale-formatted date — unambiguous across
// marks spanning several years, and this data can easily span years once
// real logging starts. escapeHtml throughout: Leaflet's bindTooltip renders
// its string argument as raw HTML (sets innerHTML), so an unescaped "&" or
// "<" anywhere in this would silently break the tooltip rather than just
// display oddly.
/** REAL BUG, FOUND AND FIXED: this used to prefix the current "colour
 * by" group value (species by default — meaning a species-grouped
 * hover often repeated the species twice), append the source, AND
 * duplicate the species again after the name — reported directly as
 * "a lot of redundant info". Now always just "name (date) type" —
 * the mark's own type field (Catch/Mark/POI/Session), not a literal
 * word — regardless of what state.groupByKey is currently set to,
 * since that's a map-display setting, not something this mark's own
 * identity depends on.
 *
 * Admin only, appended: " · <owner>" — who the mark actually belongs to
 * (mark.ownerName, sent only to Admin — see rowToOwnedMark, user-backend.js),
 * "Public" included, not just another real person's name — Oliver's own
 * request, so hovering a point on the Map tab says whose it is without
 * needing to click in. Silently absent for anyone else, or before the
 * marks/admin-status fetch has resolved (mark.ownerName not set yet). */
function markTooltipText(mark, state) {
  const ownerSuffix = cachedIsAdmin && mark.ownerName ? ` · ${escapeHtml(mark.ownerName)}` : "";
  return `${escapeHtml(mark.name)} (${String(mark.dateTime || "").slice(0, 10)}) ${escapeHtml(mark.type || "")}${ownerSuffix}`;
}

// The set of optional, pick-list-backed fields a mark can carry, alongside
// their MARK_LIST_FIELDS label and a short display label for the popup —
// walked by both the view and edit popup builders below so the two stay in
// sync without repeating the same field-by-field list twice.
const MARK_POPUP_OPTIONAL_FIELDS = [
  { key: "species", listLabel: "Species", displayLabel: "Species" },
  { key: "weatherCondition", listLabel: "Weather Condition", displayLabel: "Weather" },
  { key: "tideCondition", listLabel: "Tide Condition", displayLabel: "Tide" },
  { key: "tideExtreme", listLabel: "Tide Extreme", displayLabel: "Tide extreme" },
  { key: "waterCondition", listLabel: "Water Condition", displayLabel: "Water" },
  { key: "bait", listLabel: "Bait", displayLabel: "Bait" },
  { key: "rig", listLabel: "Rig", displayLabel: "Rig" },
  { key: "rod", listLabel: "Rod", displayLabel: "Rod" },
  { key: "berley", listLabel: "Berley", displayLabel: "Berley" },
];

/**
 * Which of the "extra" fields (everything beyond Name/Type/Date-Time,
 * which every mark always has regardless of type, and Source, which is
 * read-only metadata rather than a real content field) apply to a mark of
 * a given Mark Type. Three real types going forward:
 *   - POI: nothing extra at all — just Name/Type/Date-Time, a plain point
 *     of interest with no catch of its own.
 *   - Mark: adds Species only — "I think this species is around here",
 *     without the full detail of an actual logged catch.
 *   - Catch: everything — the full field set this popup can show.
 * "Fish" is the RETIRED predecessor of "Catch" (every mark already in
 * data/marks.json before this distinction existed was migrated from
 * type:"Fish" to type:"Mark" — see the delivered marks.json diff — but
 * the pick-list option itself is only removed from config/mark_lists.json
 * by hand, separately, so it can still be picked for a short window).
 * Aliased to the same full field set as Catch here rather than given its
 * own narrower list, so nothing already-populated on an old record
 * quietly becomes unreachable if it's ever re-selected. Same reasoning
 * covers a genuinely unrecognised future type (see fieldKeysForMarkType's
 * own fallback) — showing extra fields that don't strictly apply is a far
 * smaller problem than silently hiding real data.
 */
const MARK_TYPE_FIELD_KEYS = {
  POI: [],
  Mark: ["species"],
  Catch: [
    "species", "weatherCondition", "tideCondition", "tideExtreme", "waterCondition", "bait", "rig", "rod", "berley",
    "size", "barometer", "temperature", "waterTemperature", "waterDepth", "windDirection", "windSpeed", "notes", "released",
  ],
};
MARK_TYPE_FIELD_KEYS.Fish = MARK_TYPE_FIELD_KEYS.Catch;
// A Session (imported fishing trip, see sync.js) is two marks: "Session Start" and
// "Session End", joined by a shared sessionGroupId. Each carries the full
// Catch-level field set except Size and Released — a Session is a trip, not a
// fish (anything already stored in those is dropped the next time the mark is
// saved). Its Species is different from a Catch's in two ways — see
// typeRequiresSpecies / typeAllowsMultipleSpecies.
// sessionRole ("start"/"end") is kept in step with the type (see sessionRoleForType).
const SESSION_TYPE_ROLES = { "Session Start": "start", "Session End": "end" };
function isSessionType(type) {
  return Object.prototype.hasOwnProperty.call(SESSION_TYPE_ROLES, type);
}
/** "start" / "end" for a Session Start / Session End type, otherwise null. */
function sessionRoleForType(type) {
  return isSessionType(type) ? SESSION_TYPE_ROLES[type] : null;
}
const SESSION_FIELD_KEYS = MARK_TYPE_FIELD_KEYS.Catch.filter((k) => k !== "size" && k !== "released");
MARK_TYPE_FIELD_KEYS["Session Start"] = SESSION_FIELD_KEYS;
MARK_TYPE_FIELD_KEYS["Session End"] = SESSION_FIELD_KEYS;

/** MARK_TYPE_FIELD_KEYS[type], falling back to the full Catch-level field
 * set for anything not explicitly listed there (including "Fish" via the
 * alias just above, and any future type this map hasn't been taught about
 * yet) — see MARK_TYPE_FIELD_KEYS's own comment for why under-hiding is
 * the safer default than over-hiding. */
function fieldKeysForMarkType(type) {
  return MARK_TYPE_FIELD_KEYS[type] || MARK_TYPE_FIELD_KEYS.Catch;
}

/** Catch/Mark/Fish must have a species; a Session need not (its species are
 * optional targets), and it never gates the rest of the form. */
function typeRequiresSpecies(type) {
  return !isSessionType(type) && fieldKeysForMarkType(type).includes("species");
}

/** A Session's species are the TARGETS for the session, so several can be set
 * (stored comma-joined in `species`, the same convention as bait/rig/rod).
 * Every other type holds a single species. */
function typeAllowsMultipleSpecies(type) {
  return typeAllowsMultipleValues(type, "species");
}

/** Fields where a Session can hold several values (stored comma-joined, the
 * same convention the Sync import already uses for bait/rig/rod/berley). */
const SESSION_MULTI_VALUE_FIELDS = ["species", "bait", "rig", "rod", "berley"];
function typeAllowsMultipleValues(type, key) {
  return isSessionType(type) && SESSION_MULTI_VALUE_FIELDS.includes(key);
}

// --- Mark quick-entry defaults ("You are here" click, Live tab only) -------
//
// Two independent default sources, merged by startNewMarkEntry's caller
// (see the "You are here" onClick in live.js): "last value used" for every
// list-driven field (below, Weather Condition deliberately excluded — see
// computeQuickMarkDefaults), and a real-data-driven guess for Tide
// Condition specifically (also computeQuickMarkDefaults). Neither ever
// applies to a plain map click — see handleMapClickForMarks' own comment
// for why that stays blank everywhere else.

const MARK_LAST_VALUES_STORAGE_KEY = "markLastFieldValues";

/** Reads the {type, species, waterCondition, bait, rig, rod, berley, waterDepth} object
 * of whatever value was actually saved for each field LAST — see
 * saveLastMarkFieldValues. Never throws; a missing/corrupt entry just means
 * no defaults for that field, same as any other blank-optional-field case. */
function getLastMarkFieldValues() {
  try {
    return JSON.parse(localStorage.getItem(MARK_LAST_VALUES_STORAGE_KEY) || "null") || {};
  } catch {
    return {};
  }
}

/**
 * Called after EVERY successful mark save — creating a new one or editing
 * an existing one, from any entry point — so "last value used" always
 * tracks the most recent real usage across the whole app, not just quick
 * entries. Merges into whatever was already stored rather than overwriting
 * wholesale: a field left blank on THIS save (so absent from `mark`) simply
 * keeps whatever value was last remembered for it, rather than being wiped.
 */
function saveLastMarkFieldValues(mark) {
  try {
    const current = getLastMarkFieldValues();
    if (mark.type) current.type = mark.type;
    for (const f of MARK_POPUP_OPTIONAL_FIELDS) {
      if (f.key === "weatherCondition" || f.key === "tideCondition" || f.key === "tideExtreme") continue; // tideCondition (and its tideExtreme modifier) has its own real-data defaulting (computeQuickMarkDefaults); weatherCondition deliberately gets no default at all, of either kind — see that same function's comment
      if (isSessionType(mark.type) && typeAllowsMultipleValues(mark.type, f.key)) continue; // a Session's multi-value lists (targets, gear) aren't defaults for the next catch
      if (mark[f.key]) current[f.key] = mark[f.key];
    }
    // Water Depth isn't list-driven (no MARK_POPUP_OPTIONAL_FIELDS entry, always hand-entered — see that field's
    // own comment), but it's still worth remembering the same way: once it's set on a Session Start, End or Catch,
    // the next one of those starts from it too, rather than blank every time (Oliver's own request).
    if (mark.waterDepth != null) current.waterDepth = mark.waterDepth;
    Prefs.set(MARK_LAST_VALUES_STORAGE_KEY, JSON.stringify(current));
  } catch {
    // localStorage can throw in rare cases (private browsing quirks, storage
    // disabled) — worth degrading quietly here, same as elsewhere on this
    // site (see selectLocation's own try/catch, locationsadmin.js): the save
    // to marks.json itself already succeeded by the time this runs, losing
    // just the "remember it for next time" convenience isn't worth surfacing
    // as an error.
  }
}

// Thresholds for computeQuickMarkDefaults below — both given directly:
// ±10 minutes around an actual low/high counts as slack; the 2 hours either
// side of THAT slack window (i.e. from 10 minutes out to 2 hours out) counts
// as the "just started"/"about to finish" run zone. So, relative to one
// extreme E: [E-2h, E-10min) = Last Run *, [E-10min, E+10min] = Slack *,
// (E+10min, E+2h] = Start Run * — a full zone each, not a narrow window
// around a single point.
const TIDE_SLACK_WINDOW_MS = 10 * 60000;
const TIDE_RUN_TRANSITION_ZONE_MS = 2 * 3600000;

/**
 * Ranks one tide extremum against the other extrema of its own type
 * (mixed semidiurnal tides: two unequal highs and lows a day). Returns
 * "HHW"/"LHW" for a high, "HLW"/"LLW" for a low (H = higher of the day's
 * pair, L = lower), or null if there is no same-type peer to compare with.
 * Peers are the other same-type extrema on the same (naive, local)
 * calendar date; if it is the only one that day (a lunar day can skip a
 * high or low) it is compared with the nearest same-type neighbour in the
 * list instead — previous first, then next. A tie counts as the higher.
 */
function rankExtremum(extrema, ex) {
  const sameType = extrema.filter((e) => e.type === ex.type);
  const day = naiveDateOnlyStr(ex.t);
  let peers = sameType.filter((e) => e !== ex && naiveDateOnlyStr(e.t) === day);
  if (peers.length === 0) {
    const idx = sameType.indexOf(ex);
    const neighbour = sameType[idx - 1] || sameType[idx + 1];
    if (!neighbour) return null;
    peers = [neighbour];
  }
  const isHigher = peers.every((p) => ex.height >= p.height);
  if (ex.type === "high") return isHigher ? "HHW" : "LHW";
  return isHigher ? "HLW" : "LLW";
}

/**
 * The pure classification core of "our defined tide rules" — given a
 * sorted list of real tide extrema ({t, height, type}) and a target time,
 * returns one of the Tide Condition pick-list values, or null if there
 * isn't a real low AND high extreme bracketing targetMs to measure
 * against (e.g. right at the edge of whatever window of extrema was
 * supplied). Extracted out of computeQuickMarkDefaults below so the exact
 * same rules can also classify an arbitrary PAST time for a mark (see
 * lookupTideConditionAt) — that caller builds its own `extrema` directly
 * from WillyWeather's real high/low events (already exactly what this
 * function wants, no synthetic hourly grid needed), while
 * computeQuickMarkDefaults keeps building them via findTideExtrema over
 * whatever location rows are already loaded, unchanged.
 *
 * Rules: working outward from whichever extreme (low or high) is closer —
 * within TIDE_SLACK_WINDOW_MS of it, "Slack Low"/"Slack High"; within
 * TIDE_RUN_TRANSITION_ZONE_MS of it (but past the slack window), "Start
 * Run *" if that extreme was just LEFT or "Last Run *" if it's still
 * COMING UP, In/Out matching whether the tide is rising or falling
 * through this stretch; otherwise (more than 2 hours from both
 * surrounding extremes) the plain "Running In"/"Running Out".
 */
function classifyTideConditionFromExtrema(extrema, targetMs) {
  const r = classifyTideFromExtrema(extrema, targetMs);
  return r ? r.condition : null;
}

/**
 * Same rules as above, but returns BOTH parts as { condition, extreme }:
 * `condition` is one of the 8 plain Tide Condition values, `extreme` the
 * ranked Tide Extreme modifier ("HHW"/"LHW"/"HLW"/"LLW") or null when no
 * rank could be worked out. Which extreme is "in play" follows the
 * condition: Slack = the one it is at, Start Run = the one just LEFT,
 * Last Run / Running = the one being APPROACHED (so the direction — at,
 * from, to — is implied by the condition itself and isn't stored).
 */
function classifyTideFromExtrema(extrema, targetMs) {
  let prev = null, next = null;
  for (const ex of extrema) {
    if (ex.t <= targetMs) prev = ex;
    else {
      next = ex;
      break;
    }
  }
  if (!prev || !next) return null;

  const distToPrev = targetMs - prev.t;
  const distToNext = next.t - targetMs;
  const runningIn = prev.type === "low" && next.type === "high";
  const runningOut = prev.type === "high" && next.type === "low";

  // Mixed semidiurnal tides: each high/low is ranked against the other one
  // of its type that day (HHW/LHW/HLW/LLW) — see rankExtremum.
  const prevRank = rankExtremum(extrema, prev);
  const nextRank = rankExtremum(extrema, next);
  if (distToPrev <= TIDE_SLACK_WINDOW_MS) return { condition: prev.type === "high" ? "Slack High" : "Slack Low", extreme: prevRank };
  if (distToNext <= TIDE_SLACK_WINDOW_MS) return { condition: next.type === "high" ? "Slack High" : "Slack Low", extreme: nextRank };
  if (runningIn) {
    if (distToPrev <= TIDE_RUN_TRANSITION_ZONE_MS) return { condition: "Start Run In", extreme: prevRank };
    if (distToNext <= TIDE_RUN_TRANSITION_ZONE_MS) return { condition: "Last Run In", extreme: nextRank };
    return { condition: "Running In", extreme: nextRank };
  }
  if (runningOut) {
    if (distToPrev <= TIDE_RUN_TRANSITION_ZONE_MS) return { condition: "Start Run Out", extreme: prevRank };
    if (distToNext <= TIDE_RUN_TRANSITION_ZONE_MS) return { condition: "Last Run Out", extreme: nextRank };
    return { condition: "Running Out", extreme: nextRank };
  }
  // Two consecutive extrema of the SAME type (two lows/two highs in a row)
  // shouldn't happen with well-formed tide data — null rather than guessed
  // if it ever does.
  return null;
}

/**
 * Best-effort Tide Condition guess for the exact moment someone taps their
 * own position on the Live tab to start a mark (see startNewMarkEntry's
 * `defaults` param, wired up in live.js). `rows` is that location's own
 * real data (see getRowsForCurrentLoc, live.js) — NOT windowed to ±24h,
 * since a tide half-cycle can be close to that on its own and this needs
 * the surrounding low/high safely inside whatever's passed in.
 *
 * Weather Condition is deliberately NOT defaulted here — this function
 * only ever runs synchronously against whatever's already loaded for the
 * CURRENTLY VIEWED location, and conditions.json (what `rows` is built
 * from) never carried real weather-description data (cloud cover, rain
 * probability), only temp/wind/pressure/tide. That gap is now actually
 * closed — see lookupHistoricalMarkConditions below, which DOES fill
 * Weather Condition (and Barometer/Wind) via a real Open-Meteo lookup —
 * but that path is asynchronous (a network round trip), so it's wired up
 * separately in startNewMarkEntry rather than folded into this synchronous
 * function.
 *
 * Tide Condition: derived from the location's own real tide curve
 * (findTideExtrema) relative to right now, via classifyTideConditionFromExtrema
 * above. Left unset (falling back to "last value used") if there isn't a
 * real low AND high surrounding right now to measure any of this against.
 */
function computeQuickMarkDefaults(rows) {
  const defaults = {};
  const nowMs = nowInNaiveEncoding();
  const extrema = findTideExtrema(rows);
  const tide = classifyTideFromExtrema(extrema, nowMs);
  if (tide) {
    defaults.tideCondition = tide.condition;
    if (tide.extreme) defaults.tideExtreme = tide.extreme;
  }
  return defaults;
}

// Shared inline style for every text/select/textarea input in the popup's
// edit form — matches the input styling already used throughout
// locationsadmin.js/live.html, so an edited mark's form doesn't look like a
// different app bolted onto the map.
const MARK_POPUP_INPUT_STYLE = "width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--grey-200);font-size:0.85rem;box-sizing:border-box;";

// "YYYY-MM-DD HH:MM:SS" (this site's naive convention — see parseNaive) <->
// the format a native <input type="datetime-local" step="1"> reads/writes
// ("YYYY-MM-DDTHH:MM:SS"). The only actual difference is the separator, so
// no real date-time library needed for either direction.
function naiveToDatetimeLocal(naive) {
  return String(naive || "").replace(" ", "T");
}
function datetimeLocalToNaive(value) {
  let v = String(value || "").replace("T", " ");
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v)) v += ":00"; // browser omitted seconds (blank/whole-minute entry)
  return v;
}

/**
 * <option> list for one pick-list field, sourced from config/mark_lists.json
 * rows matching `listLabel` (see MARK_LIST_FIELDS above for the field/label
 * convention). The mark's CURRENT value is always included as an option
 * even if it's since been removed from the list on the Settings tab —
 * otherwise editing an old mark whose value predates a list edit would
 * silently blank that field out the moment the dropdown renders.
 */
function markListOptionsHtml(markLists, listLabel, currentValue) {
  const values = markLists.filter((r) => r.field === listLabel).map((r) => r.value);
  if (currentValue && !values.includes(currentValue)) values.unshift(currentValue);
  const opts = values.map((v) => `<option value="${escapeHtml(v)}"${v === currentValue ? " selected" : ""}>${escapeHtml(v)}</option>`);
  return `<option value="">—</option>${opts.join("")}`;
}

/** A pick-list as checkboxes (a Session's multiple species/bait/rig/rod/berley);
 * `current` is the stored comma-joined value, any entry not on the list is kept. */
function multiCheckboxesHtml(markLists, listLabel, current, key) {
  const chosen = String(current || "").split(",").map((s) => s.trim()).filter(Boolean);
  const values = markLists.filter((r) => r.field === listLabel).map((r) => r.value);
  for (const c of chosen) if (!values.includes(c)) values.unshift(c);
  return values
    .map(
      (v) =>
        `<label style="display:flex;align-items:center;gap:6px;font-size:0.8rem;font-weight:400;margin:2px 0;"><input type="checkbox" data-multi-check="${key}" value="${escapeHtml(v)}"${chosen.includes(v) ? " checked" : ""} />${escapeHtml(v)}</label>`
    )
    .join("");
}

/** The inner controls of a pick-list field: the usual single dropdown, plus a
 * tick-box list that replaces it for a Session (see applyMultiControlModes). A
 * stored multi-value (contains a comma) can't be shown in the single dropdown. */
function multiCapableControlsHtml(f, markLists, current, multiHeading) {
  const singleValue = String(current || "").includes(",") ? "" : current;
  return `
      <div data-multi-single="${f.key}">
        <label style="display:block;font-size:0.8rem;font-weight:600;margin:6px 0 2px;">${escapeHtml(f.displayLabel)}
          <select name="${f.key}" style="${MARK_POPUP_INPUT_STYLE}">${markListOptionsHtml(markLists, f.listLabel, singleValue)}</select>
        </label>
      </div>
      <div data-multi-multi="${f.key}" style="display:none;">
        <div style="font-size:0.8rem;font-weight:600;margin:6px 0 2px;">${escapeHtml(multiHeading || f.displayLabel)}</div>
        <div style="max-height:120px;overflow-y:auto;border:1px solid var(--grey-200);border-radius:6px;padding:4px 6px;">${multiCheckboxesHtml(markLists, f.listLabel, current, f.key)}</div>
      </div>`;
}

/**
 * Read-only popup content shown on first clicking a mark — every populated
 * field as a plain label/value row (empty/undefined fields simply omitted,
 * rather than shown blank), plus the Edit button. `data-mark-id` on the
 * root element is how the map-level popupopen handler (see
 * loadAndRenderMarks) knows which mark a given open popup belongs to.
 *
 * The Edit button only renders at all when cachedIsAdmin is true — with
 * no Admin session there's no way to actually WRITE a change back to D1
 * (saveMarkToD1 would just fail server-side), so offering an Edit button
 * that can only ever end in a save error is worse than not offering one.
 * In practice this whole popup already only ever renders behind that same
 * Admin check one level up (loadAndRenderMarks won't even load marks
 * without it today), so this is currently a belt-and-braces check rather
 * than one closing a live gap — but it keeps the button itself correct on
 * its own terms, independent of whatever gates marks display further up,
 * rather than relying on that outer gate alone.
 */
/** "95" -> "1h 35m"; under an hour stays as "42 min". Rounds to the
 * nearest minute — this is a rough distance÷speed estimate to begin with
 * (see fillMarkPopupDistances), false precision down to seconds wouldn't
 * mean anything real. */
function formatDurationMinutes(totalMinutes) {
  const mins = Math.round(totalMinutes);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Fills in "Nearest location" and "From you" on an already-open mark VIEW
 * popup — two pieces of orientation context that need a live lookup (the
 * tracked-locations list, and the browser's own GPS position) rather than
 * anything already sitting on the mark object itself, so — same pattern as
 * fillMarkFormFromHistoricalLookup above — they're filled in a moment
 * after the popup shows rather than blocking it opening at all.
 *
 * "From you" includes an estimated travel time at a flat 6 km/h (a rough
 * kayak-paddling speed) — genuinely just distance÷speed, a straight-line
 * estimate that doesn't account for current, wind, or the real paddling
 * route, not a real routing lookup the way getDriveTimeMinutes above is
 * for an actual road destination (most fishing marks aren't one). Good
 * enough for "is this close or a proper trip", not meant as a precise ETA.
 * "Nearest location" gets the same paddling-time estimate too (Oliver's
 * own call) — it's still a reference point (which tracked location's
 * tide/weather calibration is relevant here) rather than somewhere
 * actually being travelled to from your current position, but knowing
 * roughly how far that is in time terms is still useful on its own.
 *
 * `popupEl` is captured at call time by whichever caller invokes this
 * (either a popupopen handler for a freshly-bound, never-yet-opened
 * popup, or explicitly right after an already-open popup's content is
 * swapped back to view mode) — if the popup's since closed or been
 * replaced, the querySelector calls below simply find nothing on this
 * now-stale element and quietly no-op, same reasoning as the historical-
 * lookup fill above.
 */
async function fillMarkPopupDistances(popupEl, mark) {
  if (!popupEl || mark.lat == null || mark.lng == null) return;
  const [nearest, gps] = await Promise.all([
    findNearestTrackedLocation(mark.lat, mark.lng),
    requestGpsPosition(),
  ]);

  const nearestEl = popupEl.querySelector('[data-mark-distance-row="nearest"] span:last-child');
  if (nearestEl) {
    if (nearest && nearest.lat != null && nearest.lng != null) {
      const km = distanceMetersBetween(mark.lat, mark.lng, nearest.lat, nearest.lng) / 1000;
      const minutes = (km / 6) * 60;
      nearestEl.textContent = `${km.toFixed(1)} km (~${formatDurationMinutes(minutes)} paddling) — ${nearest.name}`;
    } else {
      nearestEl.textContent = "Unavailable";
    }
  }

  const fromYouEl = popupEl.querySelector('[data-mark-distance-row="fromyou"] span:last-child');
  if (fromYouEl) {
    if (gps) {
      const km = distanceMetersBetween(mark.lat, mark.lng, gps.lat, gps.lng) / 1000;
      const minutes = (km / 6) * 60;
      fromYouEl.textContent = `${km.toFixed(1)} km (~${formatDurationMinutes(minutes)} paddling)`;
    } else {
      fromYouEl.textContent = "Location unavailable";
    }
  }
}

function buildMarkPopupViewHtml(mark) {
  const rows = [];
  const row = (label, value) => {
    if (value == null || value === "") return;
    rows.push(`<div style="display:flex;gap:6px;font-size:0.85rem;margin-bottom:3px;"><span style="font-weight:600;min-width:64px;">${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`);
  };
  const applicable = fieldKeysForMarkType(mark.type);
  row("Name", mark.name);
  row("Type", mark.type);
  row("Date/Time", mark.dateTime);
  const gpsRow = markGpsRowHtml(mark);
  if (gpsRow) rows.push(gpsRow);
  // Admin only — who this mark actually belongs to (see markTooltipText's own comment for why/where this
  // comes from). Absent for anyone else, and for a brand-new draft popup (buildMarkPopupEditHtml is what's
  // shown for those, never this view — see startNewMarkEntry/startCopiedMarkEntry).
  if (cachedIsAdmin) row("Owner", mark.ownerName);
  for (const f of MARK_POPUP_OPTIONAL_FIELDS) {
    if (applicable.includes(f.key)) row(f.displayLabel, mark[f.key]);
  }
  if (applicable.includes("size")) row("Size", mark.size != null ? `${mark.size} cm` : null);
  if (applicable.includes("barometer")) row("Barometer", mark.barometer != null ? `${mark.barometer} hPa` : null);
  if (applicable.includes("temperature")) row("Temperature", mark.temperature != null ? `${mark.temperature}°C` : null);
  if (applicable.includes("waterTemperature")) row("Water Temp", mark.waterTemperature != null ? `${mark.waterTemperature}°C` : null);
  if (applicable.includes("waterDepth")) row("Water Depth", mark.waterDepth != null ? `${mark.waterDepth} m` : null);
  if (applicable.includes("windDirection") || applicable.includes("windSpeed")) {
    const windParts = [mark.windDirection, mark.windSpeed != null ? `${mark.windSpeed} km/h` : null].filter(Boolean);
    row("Wind", windParts.length ? windParts.join(" ") : null);
  }
  if (applicable.includes("notes")) row("Notes", mark.notes);
  if (applicable.includes("released")) row("Released", mark.released ? "Yes" : null);
  row("Source", mark.source);
  // Filled in asynchronously right after this popup actually shows — see
  // fillMarkPopupDistances above for why these two can't just be plain
  // row() calls like everything above (they need a live GPS/lookup, not
  // anything already sitting on `mark`).
  rows.push(`<div data-mark-distance-row="nearest" style="display:flex;gap:6px;font-size:0.85rem;margin-bottom:3px;"><span style="font-weight:600;min-width:64px;">Nearest loc.</span><span>Calculating…</span></div>`);
  rows.push(`<div data-mark-distance-row="fromyou" style="display:flex;gap:6px;font-size:0.85rem;margin-bottom:3px;"><span style="font-weight:600;min-width:64px;">From you</span><span>Calculating…</span></div>`);
  const canEdit = canEditMark(mark);
  return `
    <div data-mark-id="${escapeHtml(mark.id)}" style="min-width:200px;">
      ${rows.join("")}
      ${canEdit ? `
      <div style="margin-top:8px;display:flex;gap:6px;align-items:center;">
        <button type="button" class="btn-secondary" data-mark-edit style="padding:4px 10px;font-size:0.85rem;">Edit</button>
        <button type="button" class="btn-secondary" data-mark-copy style="padding:4px 10px;font-size:0.85rem;">Copy</button>
        <button type="button" class="btn-secondary" data-mark-delete style="padding:4px 10px;font-size:0.85rem;color:#dc2626;">Delete</button>
      </div>
      <div data-mark-delete-confirm style="display:none;margin-top:8px;padding:8px;border:1px solid #fecaca;background:#fef2f2;border-radius:6px;font-size:0.85rem;">
        <div style="margin-bottom:6px;">${isSessionType(mark.type) ? "Delete this Fishing Session? Both its Start and End are deleted together. This can't be undone." : "Delete this mark? This can't be undone."}</div>
        <button type="button" class="btn-secondary" data-mark-delete-confirm-yes style="padding:4px 10px;font-size:0.85rem;background:#dc2626;color:#fff;border-color:#dc2626;">Yes, delete</button>
        <button type="button" class="btn-secondary" data-mark-delete-cancel style="padding:4px 10px;font-size:0.85rem;">Cancel</button>
      </div>
      <div data-mark-delete-status style="margin-top:6px;font-size:0.8rem;"></div>
      ` : ""}
    </div>
  `;
}

// The Public account's own sentinel id — matches PUBLIC_USER_ID in user-backend.js exactly (not
// imported; this file has no build step to share it from). Only ever used client-side
// to pick out (and offer) the "Public (shared)" option in the Owner field below.
const CLIENT_PUBLIC_USER_ID = "public";

/** Leaflet options for every mark popup: it floats over the map next to its point and is panned into view (its
 * content scrolls past 60% of the window height — see .mark-popup-leaflet in style.css). */
function markPopupOptions() {
  return { maxWidth: 300, autoPan: true, autoPanPadding: [20, 20], className: "mark-popup-leaflet" };
}

/**
 * The Owner field's own <option> list — Admin only (see buildMarkPopupEditHtml), one real account
 * per row of cachedAdminUsers (js/backend.js, refreshed once per page load by loadAndRenderMarks)
 * plus a fixed "Public (shared)" entry for the shared account every Mark/POI otherwise lives under.
 * `currentOwnerId` is the mark's OWN real owner (mark.ownerUserId) — whichever option matches it is
 * pre-selected. If it isn't in the list at all (a stale/failed cachedAdminUsers fetch, or the account
 * itself has since been removed), an extra "(unknown account)" option is added and pre-selected instead
 * — so the picker still shows SOMETHING selected and never silently offers to move the mark to the wrong
 * account just because its real current owner didn't happen to be in the list this page load.
 */
function markOwnerOptionsHtml(currentOwnerId) {
  const options = [
    { id: CLIENT_PUBLIC_USER_ID, label: "Public (shared)" },
    ...cachedAdminUsers.map((u) => ({ id: u.id, label: u.name || u.email || u.id })),
  ];
  if (!options.some((o) => o.id === currentOwnerId)) options.push({ id: currentOwnerId, label: "(unknown account)" });
  return options
    .map((o) => `<option value="${escapeHtml(o.id)}" ${o.id === currentOwnerId ? "selected" : ""}>${escapeHtml(o.label)}</option>`)
    .join("");
}

// Which edit-form sections are open — kept across openings (all start collapsed), like the filter dialog's groups.
const markEditOpenGroups = new Set();

/** One collapsible section of the mark edit form, styled like the filter dialog's groups (see showMarkFilterModal,
 * js/marks-tools.js). While closed, its header shows what's set inside (syncMarkFormPills fills that in).
 * `fieldGroup` makes the whole section a `data-field-group`, so applyMarkFieldVisibility hides it for a type it
 * doesn't apply to. */
function markEditGroupHtml(key, label, bodyHtml, fieldGroup) {
  const open = markEditOpenGroups.has(key);
  return `
        <div class="mark-edit-group" data-edit-group="${key}"${fieldGroup ? ` data-field-group="${fieldGroup}"` : ""}>
          <button type="button" class="mark-edit-group-head" data-edit-toggle="${key}" aria-expanded="${open}">
            <span class="mark-edit-caret" aria-hidden="true">▾</span>
            <span class="mark-edit-group-label">${escapeHtml(label)}</span>
            <span class="mark-edit-summary" data-edit-summary="${key}"></span>
          </button>
          <div class="mark-edit-group-body" data-edit-body="${key}"${open ? "" : " hidden"}>${bodyHtml}</div>
        </div>`;
}

/** An empty pill row for the <select name="name"> (or a Session's tick-box list) in the same form — the pills are
 * drawn from that control's own options by syncMarkFormPills, so the hidden control stays the one real value.
 * `required`: tapping the selected pill keeps it (Type, Owner); otherwise it clears the field. */
function markPillRowHtml(name, required) {
  return `<div class="mark-pill-row" data-pills-for="${name}"${required ? ' data-pills-required="1"' : ""}></div>`;
}

/** "-38.123456, 145.123456" — the form Google Maps and most apps accept when pasted. */
function markGpsText(mark) {
  if (mark.lat == null || mark.lng == null) return "";
  return `${Number(mark.lat).toFixed(6)}, ${Number(mark.lng).toFixed(6)}`;
}

/** The GPS line with its Copy button (view and edit popups). The click is handled by the document-level listener
 * below (data-copy-gps), so it works wherever the popup lives. */
function markGpsRowHtml(mark) {
  const gps = markGpsText(mark);
  if (!gps) return "";
  return `<div class="mark-gps-row"><span class="mark-gps-label">GPS</span><span class="mark-gps-value">${gps}</span>
    <button type="button" class="btn-secondary mark-gps-copy" data-copy-gps="${gps}" title="Copy the GPS coordinates">Copy</button></div>`;
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers / non-secure contexts: the classic hidden-textarea copy.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-1000px;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** The pill values and which are selected, for one field of a mark edit form: the hidden <select>'s own options
 * (so a value added on the fly — see refreshMarkFormConditionsForNewTime — shows too), plus, while a Session's
 * tick-box list is the active control (applyMultiControlModes), the ticked boxes instead of the select. */
function markPillState(form, name) {
  const select = form.querySelector(`select[name="${name}"]`);
  if (!select) return null;
  const multiWrap = form.querySelector(`[data-multi-multi="${name}"]`);
  const multi = !!multiWrap && multiWrap.dataset.active === "1";
  const boxes = multiWrap ? Array.from(multiWrap.querySelectorAll("[data-multi-check]")) : [];
  const values = [];
  for (const o of select.options) if (o.value && !values.includes(o.value)) values.push(o.value);
  for (const b of boxes) if (!values.includes(b.value)) values.push(b.value);
  const selected = multi ? boxes.filter((b) => b.checked).map((b) => b.value) : select.value ? [select.value] : [];
  const labelFor = (v) => {
    const opt = Array.from(select.options).find((o) => o.value === v);
    return opt ? opt.textContent : v;
  };
  return { select, multi, boxes, values, selected, labelFor, disabled: select.disabled };
}

/** Redraws every pill row and section summary of a mark edit form from its hidden controls. Called after anything
 * that may change them: a pill tap, any change/input in the form (document listeners below), the initial render
 * (wireMarkPopupButtons, sync.js) and the async condition look-ups that fill fields in (js/marks-tools.js). */
function syncMarkFormPills(form) {
  if (!form) return;
  form.querySelectorAll("[data-pills-for]").forEach((row) => {
    const s = markPillState(form, row.dataset.pillsFor);
    if (!s) return;
    row.innerHTML = s.values
      .map((v) => {
        const on = s.selected.includes(v);
        return `<span class="loc-chip mark-pill${on ? " is-on" : ""}" data-pill-value="${escapeHtml(v)}" role="button" aria-pressed="${on}"${s.disabled ? ' aria-disabled="true"' : ""}>${escapeHtml(s.labelFor(v))}</span>`;
      })
      .join("");
  });
  form.querySelectorAll("[data-edit-summary]").forEach((el) => {
    const group = el.closest("[data-edit-group]");
    const body = group && group.querySelector("[data-edit-body]");
    if (!body) return;
    const parts = [];
    body.querySelectorAll("[data-pills-for]").forEach((row) => {
      const s = markPillState(form, row.dataset.pillsFor);
      if (s) parts.push(...s.selected.map((v) => s.labelFor(v)));
    });
    body.querySelectorAll("input[name]:not([type=checkbox]), textarea[name]").forEach((input) => {
      const holder = input.closest("[data-field-group]");
      if (holder && holder !== group && holder.style.display === "none") return; // a field the current type hides
      const v = (input.value || "").trim();
      if (!v) return;
      const unit = input.dataset.unit || "";
      parts.push(input.tagName === "TEXTAREA" && v.length > 24 ? `${v.slice(0, 24)}…` : `${v}${unit}`);
    });
    body.querySelectorAll('input[type=checkbox][name]').forEach((box) => {
      const holder = box.closest("[data-field-group]");
      if (holder && holder !== group && holder.style.display === "none") return;
      if (box.checked) parts.push(box.dataset.summary || box.name);
    });
    el.innerHTML = parts.map((p) => `<span class="loc-chip mark-edit-summary-chip">${escapeHtml(p)}</span>`).join("");
    // A section with nothing left to show for this type (e.g. Measurements on a Mark) disappears entirely.
    if (!group.dataset.fieldGroup) {
      const inner = Array.from(body.querySelectorAll("[data-field-group]"));
      if (inner.length) group.style.display = inner.some((g) => g.style.display !== "none") ? "" : "none";
    }
  });
  // While Species has to be chosen first (applySpeciesGate), its section opens so the prompt can be acted on.
  const prompt = form.querySelector("[data-species-first-prompt]");
  if (prompt && prompt.style.display === "block") setMarkEditGroupOpen(form, "species", true);
}

function setMarkEditGroupOpen(form, key, open) {
  const head = form.querySelector(`[data-edit-toggle="${key}"]`);
  const body = form.querySelector(`[data-edit-body="${key}"]`);
  if (!head || !body) return;
  if (open) markEditOpenGroups.add(key);
  else markEditOpenGroups.delete(key);
  head.setAttribute("aria-expanded", String(open));
  body.hidden = !open;
}

// One set of document-level listeners serves every mark edit form, wherever it's rendered (a map popup, the Sync
// page's review popup) — capture phase for clicks, since Leaflet stops click propagation at the popup itself.
document.addEventListener(
  "click",
  (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    const copyBtn = target.closest("[data-copy-gps]");
    if (copyBtn) {
      e.preventDefault();
      copyTextToClipboard(copyBtn.dataset.copyGps).then((ok) => {
        copyBtn.textContent = ok ? "Copied" : "Copy failed";
        setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
      });
      return;
    }

    const toggle = target.closest("[data-edit-toggle]");
    if (toggle) {
      const form = toggle.closest("form");
      setMarkEditGroupOpen(form, toggle.dataset.editToggle, toggle.getAttribute("aria-expanded") !== "true");
      return;
    }

    const pill = target.closest("[data-pill-value]");
    if (!pill) return;
    const row = pill.closest("[data-pills-for]");
    const form = pill.closest("form");
    const s = row && form && markPillState(form, row.dataset.pillsFor);
    if (!s || s.disabled) return;
    const value = pill.dataset.pillValue;
    if (s.multi) {
      const box = s.boxes.find((b) => b.value === value);
      if (box) {
        box.checked = !box.checked;
        box.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } else {
      const next = s.select.value === value ? (row.dataset.pillsRequired ? value : "") : value;
      if (next !== s.select.value) {
        s.select.value = next;
        s.select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    syncMarkFormPills(form);
  },
  true
);
for (const type of ["change", "input"]) {
  document.addEventListener(type, (e) => {
    const form = e.target instanceof Element ? e.target.closest("form[data-mark-form]") : null;
    if (form) syncMarkFormPills(form);
  });
}

/**
 * Editable form version of the same popup, laid out like the filter dialog: Name, Date/Time and the (read-only)
 * GPS position with its Copy button at the top, then one collapsible section per field — pick-lists as pills —
 * each showing what's set while closed. Repositioning a mark's GPS point isn't offered here (fat-finger a
 * coordinate and the pin silently jumps oceans); Source is read-only metadata.
 *
 * Every pick-list still has its real <select> (and, for a Session, its tick-box list — see
 * multiCapableControlsHtml) in the form, hidden: the pills only drive them (see syncMarkFormPills and the
 * document listeners above), so collectMarkFormValues, applySpeciesGate, applyMultiControlModes and the
 * condition look-ups keep working on the same controls as before.
 *
 * Every field beyond Name/Type/Date-Time/Source sits in a `data-field-group="<key>"` element, always rendered
 * but shown/hidden by applyMarkFieldVisibility (called on render and on every Type change — see
 * wireMarkPopupButtons), so switching Type mid-edit reveals/hides fields live.
 */
function buildMarkPopupEditHtml(mark, markLists) {
  const hiddenSelect = (name, optionsHtml, extra = "") =>
    `<select name="${name}" ${extra} hidden tabindex="-1" aria-hidden="true">${optionsHtml}</select>`;
  const pickListGroup = (f, heading) =>
    markEditGroupHtml(
      f.key,
      heading || f.displayLabel,
      `${markPillRowHtml(f.key)}<div class="mark-edit-hidden-controls">${multiCapableControlsHtml(f, markLists, mark[f.key], heading)}</div>`,
      f.key
    );
  const numberField = (key, label, unit, attrs) => `
          <div data-field-group="${key}">
            <label class="mark-edit-field">${label}
              <input type="number" name="${key}" ${attrs} data-unit="${unit}" value="${mark[key] != null ? mark[key] : ""}" style="${MARK_POPUP_INPUT_STYLE}" />
            </label>
          </div>`;
  const speciesField = MARK_POPUP_OPTIONAL_FIELDS.find((f) => f.key === "species");
  const otherPickLists = MARK_POPUP_OPTIONAL_FIELDS.filter((f) => f.key !== "species").map((f) => pickListGroup(f)).join("");
  const windOptions = `<option value=""></option>${SHORE_OPTIONS.map((d) => `<option value="${d}" ${mark.windDirection === d ? "selected" : ""}>${d}</option>`).join("")}`;

  return `
    <div data-mark-id="${escapeHtml(mark.id)}" class="mark-edit" style="min-width:230px;max-width:280px;">
      <form data-mark-form class="mark-edit-form" onsubmit="return false;">
        <label class="mark-edit-field" style="margin-top:0;">Name
          <input type="text" name="name" value="${escapeHtml(mark.name || "")}" style="${MARK_POPUP_INPUT_STYLE}" />
        </label>
        <div data-species-name-sync-confirm style="display:none;margin:6px 0;padding:6px 8px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;font-size:0.8rem;">
          <div data-species-name-sync-text style="margin-bottom:4px;"></div>
          <button type="button" class="btn-secondary" data-species-name-sync-yes style="padding:2px 8px;font-size:0.8rem;">Yes, change it</button>
          <button type="button" class="btn-secondary" data-species-name-sync-no style="padding:2px 8px;font-size:0.8rem;">No, keep it</button>
        </div>
        <label class="mark-edit-field">Date/Time
          <input type="datetime-local" name="dateTime" step="1" value="${naiveToDatetimeLocal(mark.dateTime)}" style="${MARK_POPUP_INPUT_STYLE}" />
        </label>
        ${markGpsRowHtml(mark)}
        <div data-species-first-prompt style="display:none;margin:6px 0;padding:6px 8px;background:#fef9c3;border:1px solid #fde68a;border-radius:6px;font-size:0.8rem;color:#854d0e;">Choose a species first — the rest of the form unlocks once it's set.</div>
        <div class="mark-edit-groups">
        ${markEditGroupHtml("type", "Type", markPillRowHtml("type", true) + hiddenSelect("type", markListOptionsHtml(markLists, "Mark Type", mark.type), "data-mark-type-select"))}
        ${cachedIsAdmin && mark.ownerUserId != null ? markEditGroupHtml("owner", "Owner", markPillRowHtml("ownerUserId", true) + hiddenSelect("ownerUserId", markOwnerOptionsHtml(mark.ownerUserId))) : ""}
        ${pickListGroup(speciesField)}
        ${otherPickLists}
        ${markEditGroupHtml("windDirection", "Wind Direction", markPillRowHtml("windDirection") + hiddenSelect("windDirection", windOptions), "windDirection")}
        ${markEditGroupHtml(
          "measurements",
          "Measurements",
          numberField("size", "Size (cm)", " cm", 'min="0" step="1"') +
            numberField("barometer", "Barometer (hPa)", " hPa", 'min="0" step="0.1"') +
            numberField("temperature", "Temperature (°C)", "°C", 'step="0.1"') +
            numberField("waterTemperature", "Water Temp (°C)", "°C water", 'step="0.1"') +
            numberField("waterDepth", "Water Depth (m)", " m", 'min="0" step="0.1"') +
            numberField("windSpeed", "Wind Speed (km/h)", " km/h", 'min="0" step="1"') +
            `
          <div data-field-group="released">
            <label class="mark-edit-field" style="display:flex;align-items:center;gap:6px;">
              <input type="checkbox" name="released" data-summary="Released" ${mark.released ? "checked" : ""} />
              Released
            </label>
          </div>`
        )}
        ${markEditGroupHtml(
          "notes",
          "Notes",
          `<textarea name="notes" rows="3" style="${MARK_POPUP_INPUT_STYLE}resize:vertical;">${escapeHtml(mark.notes || "")}</textarea>`,
          "notes"
        )}
        </div>
        <div data-limit-warning class="mark-limit-warning" role="status" style="display:none;"></div>
        <div class="mark-edit-source">Source: ${escapeHtml(mark.source || "—")}</div>
      </form>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button type="button" class="btn-primary" data-mark-save style="padding:4px 10px;font-size:0.85rem;">Save</button>
        <button type="button" class="btn-secondary" data-mark-cancel style="padding:4px 10px;font-size:0.85rem;">Cancel</button>
      </div>
      <div data-mark-save-status style="margin-top:6px;font-size:0.8rem;"></div>
    </div>
  `;
}

/**
 * Shows/hides each `data-field-group` in a mark's edit form based on which
 * fields apply to `type` (see MARK_TYPE_FIELD_KEYS/fieldKeysForMarkType) —
 * called once right after the edit form is inserted (for whatever type the
 * mark currently has) and again every time the Type <select> itself
 * changes (see wireMarkPopupButtons), so switching from POI to Catch
 * mid-edit immediately reveals the extra fields rather than needing to
 * save/reopen the popup to see them.
 */
function applyMarkFieldVisibility(formEl, type) {
  const applicable = fieldKeysForMarkType(type);
  formEl.querySelectorAll("[data-field-group]").forEach((group) => {
    group.style.display = applicable.includes(group.dataset.fieldGroup) ? "" : "none";
  });
}

/**
 * For each multi-capable field (see typeAllowsMultipleValues), shows the
 * tick-box checklist for a Session and the single dropdown for everything
 * else, carrying the choice across when the Type is switched (single ->
 * ticked box, first ticked box -> single).
 */
function applyMultiControlModes(formEl, type) {
  for (const key of SESSION_MULTI_VALUE_FIELDS) {
    const single = formEl.querySelector(`[data-multi-single="${key}"]`);
    const multi = formEl.querySelector(`[data-multi-multi="${key}"]`);
    const select = formEl.querySelector(`[name="${key}"]`);
    if (!single || !multi || !select) continue;
    const wantMulti = typeAllowsMultipleValues(type, key);
    const wasMulti = multi.dataset.active === "1";
    if (wantMulti && !wasMulti && select.value) {
      const box = Array.from(multi.querySelectorAll("[data-multi-check]")).find((el) => el.value === select.value);
      if (box) box.checked = true;
    } else if (!wantMulti && wasMulti && !select.value) {
      const first = multi.querySelector("[data-multi-check]:checked");
      if (first && Array.from(select.options).some((o) => o.value === first.value)) select.value = first.value;
    }
    multi.dataset.active = wantMulti ? "1" : "0";
    single.style.display = wantMulti ? "none" : "";
    multi.style.display = wantMulti ? "" : "none";
  }
}

/**
 * Oliver's own request: when creating or editing a Catch/Mark, Species
 * has to be set before anything else in the form is usable — not just
 * another field somewhere in the list. Locks every field except Type
 * and Species itself (Type stays usable so a Catch/Mark started by
 * mistake can still be switched away without being stuck; Species
 * obviously has to stay usable so the gate can ever be cleared) and
 * shows a short prompt explaining why, for as long as the current type
 * needs a species and doesn't have one yet. Re-run on every Type change
 * (alongside applyMarkFieldVisibility, which this runs right next to)
 * and every Species change, so switching types or picking a species
 * unlocks the rest of the form immediately, live, without needing to
 * save/reopen. Save itself is also blocked while gated, as a second,
 * independent check — not just the fields being disabled — for the
 * same "don't just trust the UI state" reason handleBulkEditSave
 * re-checks rather than assuming its own form only ever describes
 * legal states.
 */
function applySpeciesGate(formEl, type, species) {
  const needsGate = typeRequiresSpecies(type) && !species;
  const promptEl = formEl.querySelector("[data-species-first-prompt]");
  if (promptEl) promptEl.style.display = needsGate ? "block" : "none";
  formEl.querySelectorAll("input, select, textarea").forEach((el) => {
    if (el.name === "type" || el.name === "species") return;
    el.disabled = needsGate;
  });
  const wrapper = formEl.parentElement;
  const saveBtn = wrapper ? wrapper.querySelector("[data-mark-save]") : null;
  if (saveBtn) saveBtn.disabled = needsGate;
}

/**
 * Reads the edit form's current values back into a full mark object ready
 * to save — id/lat/lng/createdAt/source carried over unchanged from the
 * original (see buildMarkPopupEditHtml's own comment on why lat/lng, and
 * separately source, aren't editable here), everything else pick-list/
 * optional/size fields included only when non-blank, keeping the same
 * sparse-object convention the rest of marks.json already uses (an unset
 * field is simply absent, not `""`). Size is rounded to a whole number —
 * the schema only ever stores whole centimetres — rather than silently
 * accepting a decimal a numeric input would otherwise happily produce.
 */
function collectMarkFormValues(form, originalMark) {
  const val = (name) => (form.querySelector(`[name="${name}"]`).value || "").trim();
  const type = val("type");
  // Only ever collects fields applicable to the CURRENTLY SELECTED type
  // (not just whatever's visible — the same check, read fresh from the
  // form, rather than trusting applyMarkFieldVisibility's hide/show to
  // have already blanked anything). That matters concretely: switching an
  // existing Catch mark's Type to POI and hitting Save should genuinely
  // strip its weatherCondition/barometer/etc from the saved mark, not
  // just visually hide inputs that still silently carry their old values
  // underneath. The existing "delete mark.field if not in updated" cleanup
  // in wireMarkPopupButtons' save handler does the actual stripping; this
  // is what makes sure those keys are never IN updated in the first place
  // for a type they don't apply to.
  const applicable = fieldKeysForMarkType(type);
  const updated = {
    id: originalMark.id,
    lat: originalMark.lat,
    lng: originalMark.lng,
    name: val("name"),
    type,
    dateTime: datetimeLocalToNaive(form.querySelector('[name="dateTime"]').value),
    createdAt: originalMark.createdAt,
  };
  if (originalMark.source) updated.source = originalMark.source;
  // A mark stays with its current owner (a new one belongs to whoever creates it); the Worker makes the same call on
  // save. An explicit pick from the Owner field
  // (Admin only — see buildMarkPopupEditHtml/markOwnerOptionsHtml) overrides that on the Worker, same three
  // "Mine"/"Public"/"Other" buckets rowToOwnedMark computes there — mirrored here so the popup/tooltip read right
  // immediately after Save, without waiting on a reload to hear the Worker's own version back.
  const ownerSelect = form.querySelector('[name="ownerUserId"]');
  if (ownerSelect) {
    updated.ownerUserId = ownerSelect.value;
    // "Public" alone — matching the Worker's own rowToOwnedMark exactly — not the picker's own friendlier
    // "Public (shared)" option label, which only exists to read well inside the <select> itself.
    if (updated.ownerUserId === CLIENT_PUBLIC_USER_ID) {
      updated.ownerName = "Public";
    } else {
      const chosen = ownerSelect.options[ownerSelect.selectedIndex];
      updated.ownerName = chosen ? chosen.textContent : updated.ownerUserId;
    }
    updated.owner = updated.ownerUserId === CLIENT_PUBLIC_USER_ID ? "Public" : updated.ownerUserId === cachedUserId ? "Mine" : "Other";
  } else {
    updated.owner = originalMark.owner || "Mine";
  }
  // The role follows the type (Session Start / Session End); a mark switched out of a session type leaves its pair.
  const role = sessionRoleForType(type);
  if (role) {
    updated.sessionRole = role;
    if (originalMark.sessionGroupId) updated.sessionGroupId = originalMark.sessionGroupId;
  } else if (originalMark.sessionRole || originalMark.sessionGroupId) {
    updated.sessionRole = null;
    updated.sessionGroupId = null;
  }
  for (const f of MARK_POPUP_OPTIONAL_FIELDS) {
    if (!applicable.includes(f.key)) continue;
    let v = val(f.key);
    if (typeAllowsMultipleValues(type, f.key)) {
      v = Array.from(form.querySelectorAll(`[data-multi-check="${f.key}"]:checked`)).map((el) => el.value).join(", ");
    }
    if (v) updated[f.key] = v;
  }
  if (applicable.includes("size")) {
    const sizeRaw = val("size");
    if (sizeRaw) {
      const sizeNum = Math.round(Number(sizeRaw));
      if (Number.isFinite(sizeNum)) updated.size = sizeNum; // whole cm — see the field's own schema comment
    }
  }
  if (applicable.includes("barometer")) {
    const barometerRaw = val("barometer");
    if (barometerRaw) {
      const barometerNum = Number(barometerRaw);
      if (Number.isFinite(barometerNum)) updated.barometer = barometerNum; // hPa, not rounded — see the field's own schema comment
    }
  }
  if (applicable.includes("temperature")) {
    const temperatureRaw = val("temperature");
    if (temperatureRaw) {
      const temperatureNum = Number(temperatureRaw);
      if (Number.isFinite(temperatureNum)) updated.temperature = temperatureNum; // °C, not rounded — see the field's own schema comment
    }
  }
  if (applicable.includes("waterTemperature")) {
    const waterTemperatureRaw = val("waterTemperature");
    if (waterTemperatureRaw) {
      const waterTemperatureNum = Number(waterTemperatureRaw);
      if (Number.isFinite(waterTemperatureNum)) updated.waterTemperature = waterTemperatureNum; // °C, not rounded — see the field's own schema comment
    }
  }
  if (applicable.includes("waterDepth")) {
    const waterDepthRaw = val("waterDepth");
    if (waterDepthRaw) {
      const waterDepthNum = Number(waterDepthRaw);
      if (Number.isFinite(waterDepthNum)) updated.waterDepth = waterDepthNum; // metres, not rounded — see the field's own schema comment
    }
  }
  if (applicable.includes("windDirection")) {
    const windDirectionRaw = val("windDirection");
    if (windDirectionRaw) updated.windDirection = windDirectionRaw; // already one of SHORE_OPTIONS' 16 compass points — the <select> only ever offers those
  }
  if (applicable.includes("windSpeed")) {
    const windSpeedRaw = val("windSpeed");
    if (windSpeedRaw) {
      const windSpeedNum = Math.round(Number(windSpeedRaw));
      if (Number.isFinite(windSpeedNum)) updated.windSpeed = windSpeedNum; // whole km/h — see the field's own schema comment
    }
  }
  if (applicable.includes("notes")) {
    const notes = val("notes");
    if (notes) updated.notes = notes;
  }
  if (applicable.includes("released")) {
    const releasedInput = form.querySelector('[name="released"]');
    if (releasedInput && releasedInput.checked) updated.released = true;
  }
  return updated;
}

/**
 * Writes one mark to D1 via POST or PUT /api/marks (the Worker decides whose
 * account it belongs to: a new mark is the signed-in person's own, whatever its type;
 * see markOwnerFor in user-backend.js) — replaces saveMarkToGitHub's read-sha/modify/write-
 * whole-file pattern with a single REST call per save. `isNew` (passed by
 * the caller — see wireMarkPopupButtons's own options.isNew) decides
 * POST vs PUT directly, rather than this function re-deriving it by
 * searching for an existing entry the way the old GitHub version had to
 * (there's no "whole array to search" any more, just one row to write).
 *
 * updatedMark.id is passed through as-is on a POST — see
 * handleMarksCollection's own comment (user-backend.js) for why the
 * server accepts and keeps a client-supplied id rather than generating
 * its own: it's what lets the SAME id chosen when a draft pin is first
 * drawn (makeMarkId(), startNewMarkEntry) still be the real, permanent
 * one once saved, with no extra bookkeeping needed here to reconcile a
 * server-assigned id back into marksById/markersById.
 *
 * Returns { success: true } or { success: false, error: "..." } — never
 * throws, same contract saveMarkToGitHub had, so the popup's own Save
 * handler needed no changes beyond the function name itself.
 */
async function saveMarkToD1(updatedMark, isNew) {
  try {
    // A new mark gets its blank conditions filled from looked-up data first (mark-lookup.js; it can
    // only leave them blank, never fail the save). Editing an existing mark never re-fills a field
    // that was cleared on purpose.
    if (isNew && typeof fillBlankMarkConditions === "function") await fillBlankMarkConditions(updatedMark);
    const url = isNew
      ? `${USER_BACKEND_URL}/api/marks`
      : `${USER_BACKEND_URL}/api/marks/${updatedMark.id}`;
    const res = await fetch(url, {
      method: isNew ? "POST" : "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updatedMark),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `status ${res.status}`);
    }
    return { success: true };
  } catch (err) {
    console.error("saveMarkToD1 failed:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Deletes one mark from D1 — replaces deleteMarkFromGitHub's read-sha/
 * filter/write-whole-file pattern with a single DELETE call. Same
 * never-throws convention (returns {success:false, error} instead), same
 * reasoning as saveMarkToD1 above.
 */
async function deleteMarkFromD1(markId) {
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/marks/${markId}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok && res.status !== 404) throw new Error(`status ${res.status}`);
    return { success: true };
  } catch (err) {
    console.error("deleteMarkFromD1 failed:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Creates MANY new marks in D1 — the Sync tab's bulk-import save (see
 * sync.js), as opposed to saveMarkToD1 just above, which is a single
 * add-or-update used by the interactive map popup. There is no bulk-
 * create endpoint (unlike the old GitHub version, which could fold
 * hundreds of new marks into one commit) — this issues one POST per
 * mark instead, in small concurrent batches (CONCURRENCY below) rather
 * than either fully sequential (slow for a large import) or fully
 * parallel (hundreds of simultaneous requests hitting the Worker/D1 at
 * once). A partial failure part-way through does NOT roll back whatever
 * already succeeded — same trade-off the old version's single big commit
 * never had to make, but an import is rare enough, and each mark
 * independent enough, that "some of these saved, here's exactly how
 * many and what went wrong" is more useful than an all-or-nothing commit
 * would be here anyway.
 *
 * Returns { success: true, added: n } (added may be less than
 * newMarks.length if some failed — check the console for which) or
 * { success: false, error } if NONE succeeded. Never throws.
 */
async function saveMarksBatchToD1(newMarks) {
  if (!newMarks || newMarks.length === 0) {
    return { success: false, error: "Nothing selected to import." };
  }
  const CONCURRENCY = 4; // each mark may also look up its blank conditions first
  let added = 0;
  const errors = [];
  for (let i = 0; i < newMarks.length; i += CONCURRENCY) {
    const batch = newMarks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((mark) =>
        // Blank conditions are filled from looked-up data just before each mark is saved (see saveMarkToD1).
        (typeof fillBlankMarkConditions === "function" ? fillBlankMarkConditions(mark) : Promise.resolve(mark))
          .then(() =>
            fetch(`${USER_BACKEND_URL}/api/marks`, {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(mark),
            })
          )
          .then(async (res) => {
            if (!res.ok) {
              const errBody = await res.json().catch(() => ({}));
              throw new Error(errBody.error || `status ${res.status}`);
            }
            return true;
          })
          .catch((err) => {
            console.error(`Failed to import mark "${mark.name || mark.id}":`, err);
            errors.push(err.message);
            return false;
          })
      )
    );
    added += results.filter(Boolean).length;
  }
  if (added === 0) return { success: false, error: errors[0] || "Import failed." };
  return { success: true, added };
}

/**
 * Wires whichever buttons currently exist inside one open mark popup — only
 * ever one of Edit (view mode) or Save/Cancel (edit mode) at a time, so at
 * most one of the two branches below actually finds anything. Called both
 * from the map's own popupopen event (see loadAndRenderMarks) AND, directly,
 * every time this same code swaps the popup's content between view and edit
 * mode — popupopen only fires when a popup first OPENS, not on a later
 * setPopupContent, so switching modes has to re-wire itself rather than
 * relying on that event a second time.
 *
 * Every button handler below starts with L.DomEvent.stop(e) (stopPropagation
 * + preventDefault). Leaflet already calls disableClickPropagation on a
 * popup's own container to stop exactly this — a click inside the popup
 * reaching the map underneath and re-triggering whatever the map's own click
 * does (here: onLocationMapClickForPreview's "look up what's at this spot"
 * flow) — but that alone wasn't enough to stop it in practice (most likely a
 * touch/tap timing quirk on mobile rather than plain desktop click bubbling,
 * given this project's history of exactly that kind of Leaflet-on-mobile
 * gap). Stopping it explicitly, right at the button, doesn't depend on
 * pinning down which exact mechanism let it through.
 *
 * `options.isNew` (default false) is set only for a mark started via
 * startNewMarkEntry — one that doesn't exist in marks.json yet at all.
 * Changes two things while true: Cancel discards the whole marker instead
 * of reverting to a view mode that has nothing real to show yet, and a
 * successful Save also registers the new mark into `options.state`
 * (marksById/markersById) and flips isNew back to false — from that point
 * on this exact same popup behaves exactly like one opened on an
 * already-existing mark, Cancel included.
 */
/**
 * Runs when a mark popup opens. The popup itself stays a normal floating Leaflet popup next to its point (it used
 * to be moved into #markDetailPanel; since 2026-09-23 that panel only holds the multi-select summary and bulk
 * edit). This just closes the page's conditions-graph hover panel, and remembers the map so
 * closeMarkDetailPanel can close the popup when that panel opens again.
 */
let markDetailPanelMap = null; // the map whose mark popup is currently open, if any — set/cleared below, used by closeMarkDetailPanel
let markDetailPanelState = null; // that map's own state object, alongside markDetailPanelMap

function attachPopupToDetailPanel(popup, map, state) {
  // Same mutual-exclusivity fix as closeMarkDetailPanel's own comment,
  // the other direction — opening a mark now closes whichever hover
  // panel this page has, if either is currently showing. Page-specific
  // function names (conditions.html vs live.html), so both are checked
  // defensively rather than assuming which one exists here.
  // (looked up on `window`: top-level functions are properties of it, and this
  // makes it explicit to tools that these are optional per-page hooks)
  if (typeof window.hideLocationHoverPanel === "function") window.hideLocationHoverPanel();
  if (typeof window.hideLiveHoverPanel === "function") window.hideLiveHoverPanel();
  markDetailPanelMap = map;
  markDetailPanelState = state;
}

/** Reverses attachPopupToDetailPanel's bookkeeping — called on popupclose. */
function detachDetailPanel() {
  markDetailPanelMap = null;
  markDetailPanelState = null;
}

/**
 * Closes whichever mark popup is currently shown in the side panel, if
 * any — called from showLocationHoverPanel (app.js) and
 * showLiveHoverPanel (live.js) right before either one opens its own
 * conditions-graph panel. Real, reported bug: both panels open at the
 * same time left the graph squeezed into whatever width the mark panel
 * hadn't already taken, rather than its own intended full width — the
 * two were never meant to compete for the same space simultaneously.
 * A plain no-op when nothing is currently open.
 *
 * Directly hides the panel too, not just via closing a popup — a
 * selection summary or bulk-edit form can also be showing in there
 * with no popup involved at all, and closePopup() alone wouldn't touch
 * that. The underlying selection itself is left completely alone
 * either way (marks stay highlighted on the map) — this only ever
 * affects what the panel is currently showing.
 */
function closeMarkDetailPanel() {
  if (markDetailPanelMap) markDetailPanelMap.closePopup();
  const panel = document.getElementById("markDetailPanel");
  if (panel) panel.style.display = "none";
}


function wireMarkPopupButtons(popupEl, marker, mark, markListsCache, options = {}) {
  // Belt-and-braces alongside Leaflet's own automatic handling of the same
  // popup container — see this function's own comment above.
  L.DomEvent.disableClickPropagation(popupEl);

  // Only present in edit mode (buildMarkPopupEditHtml) — sets up the
  // initial field visibility for whatever type the mark currently has,
  // and re-applies it live every time the Type <select> itself changes.
  // See applyMarkFieldVisibility's own comment for why this needs to be
  // dynamic rather than just baked into the initial render once.
  const form = popupEl.querySelector("[data-mark-form]");
  if (form) {
    const typeSelect = form.querySelector("[data-mark-type-select]");
    const speciesSelect = form.querySelector('[name="species"]');

    // A Catch that breaks a limit (kept but under the min size, over the max size, over the bag or the big-fish limit) gets
    // a warning under the form, refreshed as the species, size, date/time or Released change. Needs js/catch-limits.js
    // and the loaded marks (options.state), so it is quietly absent on pages without them.
    const warnEl = form.querySelector("[data-limit-warning]");
    const refreshLimitWarning = () => {
      if (!warnEl) return;
      let messages = [];
      if (typeof catchLimitWarnings === "function" && options.state && typeSelect && typeSelect.value === "Catch") {
        const species = form.querySelector('[name="species"]').value;
        const sizeRaw = form.querySelector('[name="size"]').value;
        const tMs = parseNaive(datetimeLocalToNaive(form.querySelector('[name="dateTime"]').value));
        if (species && Number.isFinite(tMs)) {
          const limits = limitsFromMarkLists(options.state.markLists || []);
          const catches = catchesFromMarks(options.state.marksById.values(), parseNaive);
          messages = catchLimitWarnings(
            { id: mark.id, species, size: sizeRaw === "" ? null : Number(sizeRaw), released: form.querySelector('[name="released"]').checked, tMs },
            limits,
            catches
          );
        }
      }
      warnEl.textContent = messages.join(" ");
      warnEl.style.display = messages.length ? "" : "none";
    };
    form.addEventListener("input", refreshLimitWarning);
    form.addEventListener("change", refreshLimitWarning);
    if (typeSelect) refreshLimitWarning();
    if (typeSelect) {
      applyMarkFieldVisibility(form, typeSelect.value);
      applyMultiControlModes(form, typeSelect.value);
      if (speciesSelect) applySpeciesGate(form, typeSelect.value, speciesSelect.value);
      typeSelect.addEventListener("change", () => {
        applyMarkFieldVisibility(form, typeSelect.value);
        applyMultiControlModes(form, typeSelect.value);
        const syncBlockOnType = form.querySelector("[data-species-name-sync-confirm]");
        if (syncBlockOnType) syncBlockOnType.style.display = "none";
        if (speciesSelect) applySpeciesGate(form, typeSelect.value, speciesSelect.value);
      });
    }

    // Oliver's own request: changing Species auto-fills a blank Name
    // with it; a NON-blank Name instead gets an inline yes/no prompt
    // rather than being overwritten silently (or never offered at
    // all) — matching this form's own click-to-reveal confirmation
    // pattern elsewhere (Delete) rather than a native confirm().
    if (speciesSelect) {
      const nameInput = form.querySelector('[name="name"]');
      const syncBlock = form.querySelector("[data-species-name-sync-confirm]");
      const syncText = form.querySelector("[data-species-name-sync-text]");
      const syncYes = form.querySelector("[data-species-name-sync-yes]");
      const syncNo = form.querySelector("[data-species-name-sync-no]");
      speciesSelect.addEventListener("change", () => {
        if (typeSelect) applySpeciesGate(form, typeSelect.value, speciesSelect.value);
        const species = speciesSelect.value;
        if (syncBlock) syncBlock.style.display = "none";
        // A Session's Name is never driven by its species (they are its targets).
        if (typeSelect && isSessionType(typeSelect.value)) return;
        if (!species || !nameInput) return;
        const currentName = nameInput.value.trim();
        if (!currentName) {
          nameInput.value = species;
        } else if (currentName !== species && syncBlock && syncText) {
          syncText.textContent = `Change the Name to "${species}" too?`;
          syncBlock.style.display = "block";
        }
      });
      if (syncYes && syncBlock) {
        syncYes.addEventListener("click", () => {
          if (nameInput) nameInput.value = speciesSelect.value;
          syncBlock.style.display = "none";
        });
      }
      if (syncNo && syncBlock) {
        syncNo.addEventListener("click", () => {
          syncBlock.style.display = "none";
        });
      }
    }

    // Refreshes Weather/Tide/Barometer/Temperature/Water Temperature/Wind
    // for whatever the Date/Time field's just been changed TO — see
    // refreshMarkFormConditionsForNewTime's own comment above for why
    // this overwrites rather than only filling blanks. Most useful right
    // after "Copy" (same location, new time), but wired here generally —
    // any edit's date/time change gets the same refresh. Skipped for a
    // POI/Mark-level form, same cost-conscious check the initial fill
    // uses (see startNewMarkEntry's own comment) — nothing to refresh if
    // the form can't show a single one of these fields to begin with.
    const dateTimeInput = form.querySelector('[name="dateTime"]');
    if (dateTimeInput) {
      dateTimeInput.addEventListener("change", () => {
        const currentType = typeSelect ? typeSelect.value : mark.type;
        if (!fieldKeysForMarkType(currentType).includes("weatherCondition")) return;
        const naive = datetimeLocalToNaive(dateTimeInput.value);
        if (!naive) return;
        refreshMarkFormConditionsForNewTime(form, mark.lat, mark.lng, naive);
      });
    }
    syncMarkFormPills(form);
  }

  const editBtn = popupEl.querySelector("[data-mark-edit]");
  if (editBtn) {
    editBtn.addEventListener("click", (e) => {
      L.DomEvent.stop(e);
      marker.setPopupContent(buildMarkPopupEditHtml(mark, markListsCache));
      wireMarkPopupButtons(popupEl, marker, mark, markListsCache, options);
    });
  }

  // Copy — starts a brand-new draft at the same location, pre-filled from
  // this mark, in its own edit popup (see startCopiedMarkEntry above).
  // Needs a real map reference, which isn't in `options` for the plain
  // "existing mark, editing" call path the way it is for a NEW mark (see
  // startNewMarkEntry's own options.map) — options.map was added
  // specifically so this (and the Delete flow above) can reach it; see
  // loadAndRenderMarks's own popupopen wiring, which passes it through.
  const copyBtn = popupEl.querySelector("[data-mark-copy]");
  if (copyBtn) {
    copyBtn.addEventListener("click", (e) => {
      L.DomEvent.stop(e);
      if (options.map && options.state) startCopiedMarkEntry(options.map, mark, options.state);
    });
  }

  // Delete needs an inline are-you-sure step rather than acting on a
  // single click — this is the only genuinely irreversible action
  // anywhere on a mark's own popup (Cancel just discards unsaved edits;
  // this removes the mark from data/marks.json outright). Clicking
  // Delete just reveals the confirm block below (data-mark-delete-
  // confirm) rather than deleting anything yet.
  const deleteBtn = popupEl.querySelector("[data-mark-delete]");
  const deleteConfirmBlock = popupEl.querySelector("[data-mark-delete-confirm]");
  if (deleteBtn && deleteConfirmBlock) {
    deleteBtn.addEventListener("click", (e) => {
      L.DomEvent.stop(e);
      deleteConfirmBlock.style.display = "block";
    });
  }
  const deleteCancelBtn = popupEl.querySelector("[data-mark-delete-cancel]");
  if (deleteCancelBtn && deleteConfirmBlock) {
    deleteCancelBtn.addEventListener("click", (e) => {
      L.DomEvent.stop(e);
      deleteConfirmBlock.style.display = "none";
    });
  }
  const deleteConfirmYesBtn = popupEl.querySelector("[data-mark-delete-confirm-yes]");
  if (deleteConfirmYesBtn) {
    deleteConfirmYesBtn.addEventListener("click", async (e) => {
      L.DomEvent.stop(e);
      const statusEl = popupEl.querySelector("[data-mark-delete-status]");
      deleteConfirmYesBtn.disabled = true;

      // A Session's own pair (same sessionGroupId, the OTHER role) is
      // deleted together with it — Oliver's own call: deleting either
      // half of a session should remove the whole thing, not leave an
      // orphaned other half behind (especially useful while testing —
      // repeated imports/deletes shouldn't need two separate delete
      // actions for what's really one thing).
      let pairedMark = null;
      if (isSessionType(mark.type) && mark.sessionGroupId && options.state) {
        for (const other of options.state.marksById.values()) {
          if (other.id !== mark.id && isSessionType(other.type) && other.sessionGroupId === mark.sessionGroupId) {
            pairedMark = other;
            break;
          }
        }
      }

      if (statusEl) statusEl.textContent = pairedMark ? "Deleting both…" : "Deleting…";
      const result = await deleteMarkFromD1(mark.id);
      if (!result.success) {
        deleteConfirmYesBtn.disabled = false;
        if (statusEl) {
          statusEl.textContent = "Delete failed: " + result.error;
          statusEl.style.color = "#dc2626";
        }
        return;
      }

      let pairResult = { success: true };
      if (pairedMark) {
        pairResult = await deleteMarkFromD1(pairedMark.id);
        if (!pairResult.success && statusEl) {
          // The clicked mark is already gone at this point — no sensible
          // way to "undo" that, so this is reported plainly rather than
          // retried automatically; the person can delete the remaining
          // orphaned half manually if this happens.
          statusEl.textContent = `Deleted this one, but couldn't delete its pair: ${pairResult.error}`;
          statusEl.style.color = "#dc2626";
        }
      }

      // Success — remove the marker from the map and both of state's own
      // lookup maps (marksById/markersById), same bookkeeping loadAndRenderMarks
      // itself does when a mark is first added, just in reverse. isNew marks
      // (created via startNewMarkEntry, never actually saved) never reach this
      // code path at all — Cancel is what removes those, not Delete.
      marker.closePopup();
      if (options.state && options.state.markerLayer) options.state.markerLayer.removeLayer(marker);
      if (options.state) {
        options.state.marksById.delete(mark.id);
        options.state.markersById.delete(mark.id);
        if (pairedMark && pairResult.success) {
          const pairedMarker = options.state.markersById.get(pairedMark.id);
          if (pairedMarker) {
            if (options.state.markerLayer) options.state.markerLayer.removeLayer(pairedMarker);
            options.state.markersById.delete(pairedMark.id);
          }
          options.state.marksById.delete(pairedMark.id);
        }
        // A deleted Session mark's own connecting line (renderSessionLines,
        // just above) would otherwise still point at it — recomputed from
        // whatever's left in marksById now that this one's gone, rather
        // than tracked incrementally; cheap enough at real mark counts and
        // correct regardless of which half of a pair got deleted. Runs
        // unconditionally (not just for a Session type) since a stray
        // mismatch there is exactly the kind of thing worth being
        // defensive about rather than trusting the type check alone.
        if (options.map) renderSessionLines(options.map, options.state, Array.from(options.state.marksById.values()));
      }
    });
  }

  const cancelBtn = popupEl.querySelector("[data-mark-cancel]");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", (e) => {
      L.DomEvent.stop(e);
      if (options.isNew) {
        // Nothing was ever saved — there's no "view mode" to revert to,
        // just remove the draft pin entirely.
        marker.closePopup();
        if (options.state && options.state.markerLayer) options.state.markerLayer.removeLayer(marker);
        return;
      }
      marker.setPopupContent(buildMarkPopupViewHtml(mark));
      fillMarkPopupDistances(popupEl, mark);
      wireMarkPopupButtons(popupEl, marker, mark, markListsCache, options);
    });
  }

  const saveBtn = popupEl.querySelector("[data-mark-save]");
  if (saveBtn) {
    saveBtn.addEventListener("click", async (e) => {
      L.DomEvent.stop(e);
      const form = popupEl.querySelector("[data-mark-form]");
      const statusEl = popupEl.querySelector("[data-mark-save-status]");
      const updated = collectMarkFormValues(form, mark);
      // Second, independent check alongside the disabled-button gate
      // itself (applySpeciesGate) — not just trusting the UI state, the
      // same reasoning handleBulkEditSave's own re-check follows.
      if (typeRequiresSpecies(updated.type) && !updated.species) {
        statusEl.textContent = "Choose a species first.";
        statusEl.style.color = "#dc2626";
        return;
      }
      if (options.isNew) {
        // createdAt is set for real only now, at the actual moment of
        // saving — the draft's own dateTime (defaulted to "now" at
        // creation, editable in the form) is what the user is asserting
        // this mark is ABOUT, which may drift from the literal save moment
        // by however long they spent filling the form in.
        updated.createdAt = nowAsNaiveString();
        if (!updated.name) updated.name = updated.type || "Mark"; // never save a genuinely blank label
      }
      saveBtn.disabled = true;
      statusEl.textContent = "Saving…";
      statusEl.style.color = "";

      const result = await saveMarkToD1(updated, options.isNew);
      if (result.success) {
        // Mutate the SAME object every closure here already holds a
        // reference to (marksById's entry, this popup's `mark`) rather than
        // replacing it — swapping in a new object would leave marksById
        // pointing at stale data for any OTHER popup opened on this mark
        // later without a full page reload.
        Object.assign(mark, updated);
        for (const f of MARK_POPUP_OPTIONAL_FIELDS) if (!(f.key in updated)) delete mark[f.key];
        if (!("notes" in updated)) delete mark.notes;
        if (!("released" in updated)) delete mark.released;
        if (!("size" in updated)) delete mark.size;
        if (!("barometer" in updated)) delete mark.barometer;
        if (!("temperature" in updated)) delete mark.temperature;
        if (!("waterTemperature" in updated)) delete mark.waterTemperature;
        if (!("waterDepth" in updated)) delete mark.waterDepth;
        if (!("windDirection" in updated)) delete mark.windDirection;
        if (!("windSpeed" in updated)) delete mark.windSpeed;
        saveLastMarkFieldValues(mark); // every successful save, create or edit — see that function's own comment

        // An edit (not a brand-new mark, which would otherwise vanish the moment it's saved if the current filters
        // don't cover it) re-applies the map filters, same as bulk edit — see refreshAfterEdit's calls below.
        const wasEdit = !options.isNew;
        const refreshAfterEdit = () => {
          if (wasEdit && options.state && options.state.refreshMarkControls) options.state.refreshMarkControls();
        };
        if (options.isNew && options.state) {
          options.state.marksById.set(mark.id, mark);
          options.state.markersById.set(mark.id, marker);
          options.isNew = false; // this popup now behaves like any other existing mark's
        }

        // If Type changed to something needing a different SHAPE (see
        // shapeNameForMark/createMarkShapeLayer above — POI/Mark/
        // Catch each draw as a different shape now, not just a colour),
        // Leaflet has no way to swap an existing layer's class in place —
        // the only option is tearing down the old marker and creating a
        // fresh one of the right shape at the same spot, then repointing
        // every reference at it (state's own markersById map, and
        // everything below) so nothing keeps working with the now-removed
        // old instance. Reopens the popup fresh on the new marker rather
        // than the setPopupContent used for the common case (same shape,
        // just new field values) — an existing OPEN popup can be updated
        // in place without disturbing it, but a brand new layer has no
        // popup bound to update in the first place. A visible popup
        // "blink" here is an acceptable trade — changing a mark's own
        // Type mid-edit is a rare action, nowhere near as common as
        // everything else this save handler already does silently.
        const markListsForShape = (options.state && options.state.markLists) || [];
        const desiredShapeName = shapeNameForMark(mark, markListsForShape);
        const desiredShapeGetter = LOWRANCE_SHAPE_GETTERS[desiredShapeName];
        const desiredShapeClass = desiredShapeGetter ? desiredShapeGetter() : L.CircleMarker;
        let effectivePopupEl = popupEl;
        if (marker.constructor !== desiredShapeClass && options.state && options.state.markerLayer) {
          const latlng = marker.getLatLng();
          const freshStyle = markStyleFor(mark, options.state);
          options.state.markerLayer.removeLayer(marker);
          marker = createMarkShapeLayer(latlng, mark, {
            renderer: (options.state && options.state.canvasRenderer) || undefined,
            radius: freshStyle.radius,
            color: freshStyle.color,
            weight: freshStyle.weight,
            fillColor: freshStyle.fillColor,
            fillOpacity: 0.85,
          }, markListsForShape).addTo(options.state.markerLayer);
          marker.bindPopup(buildMarkPopupViewHtml(mark), markPopupOptions());
          marker.unbindTooltip();
          marker.bindTooltip(markTooltipText(mark, options.state), { direction: "top" });
          // Same Ctrl/Cmd-click-to-select wiring loadAndRenderMarks gives
          // every marker at creation (including the same real mousedown-
          // vs-click ordering fix — see that code's own comment for why
          // stopping propagation on "click" alone isn't enough) — this one
          // just got torn down and recreated (a Type change needing a
          // different shape), so it needs it wired again from scratch; the
          // old marker's own listeners went with it.
          if (options.map) {
            marker._markId = mark.id; // same O(1) cluster-lookup reason as loadAndRenderMarks's own marker creation
            marker.on("mousedown", (e) => {
              if (isSelectModifierKey(e.originalEvent)) L.DomEvent.stop(e);
            });
            marker.on("click", (e) => {
              if (!isSelectModifierKey(e.originalEvent)) return;
              L.DomEvent.stop(e);
              marker.closePopup();
              toggleMarkSelection(options.map, options.state, mark.id);
            });
          }
          if (options.state) options.state.markersById.set(mark.id, marker);
          refreshAfterEdit();
          if (!options.state.markerLayer.hasLayer(marker)) return; // the edit filtered it off the map — nothing to reopen
          // showMarkerOnceVisible (not zoomToShowLayer directly, and not a
          // plain openPopup) — the freshly re-created marker could easily
          // land inside a cluster if other marks sit nearby, in which
          // case a plain openPopup() would silently do nothing (a
          // clustered marker has no visible DOM to pop up from) — AND
          // zoomToShowLayer's own callback is confirmed unreliable for
          // this project's marker types (see showMarkerOnceVisible's own
          // comment for why). Everything depending on the NEW popup's own
          // DOM element has to wait for this callback too, since it
          // doesn't exist before the popup actually opens.
          showMarkerOnceVisible(options.state.markerLayer, marker, () => {
            marker.openPopup();
            const newPopupEl = marker.getPopup().getElement();
            fillMarkPopupDistances(newPopupEl, mark);
            wireMarkPopupButtons(newPopupEl, marker, mark, markListsCache, options);
          });
          return; // the tail below (same fillMarkPopupDistances/wireMarkPopupButtons
                   // calls, plus tooltip/style already applied above) is redundant
                   // for this branch — it's all handled inside the callback instead,
                   // once the popup can actually exist
        }
        marker.setPopupContent(buildMarkPopupViewHtml(mark));
        fillMarkPopupDistances(effectivePopupEl, mark);
        wireMarkPopupButtons(effectivePopupEl, marker, mark, markListsCache, options);
        marker.unbindTooltip();
        marker.bindTooltip(markTooltipText(mark, options.state), { direction: "top" });
        const style = markStyleFor(mark, options.state);
        marker.setStyle({ color: style.color, fillColor: style.fillColor, radius: style.radius, weight: style.weight });
        refreshAfterEdit(); // if the edit no longer matches the filters, the marker (and its popup) leave the map
      } else {
        statusEl.textContent = "Save failed: " + result.error;
        statusEl.style.color = "#dc2626";
        saveBtn.disabled = false;
      }
    });
  }
}
