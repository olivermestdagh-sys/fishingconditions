// sync.js — the Sync tab (sync.html): import fishing marks from a Garmin
// GPX or Lowrance .usr chartplotter export, review/edit the new ones before
// anything is saved, then commit accepted marks into data/marks.json. Also
// offers the reverse direction: export the current marks.json as a GPX file
// suitable for loading straight back onto either a Garmin or a Lowrance
// unit (Oliver's own Lowrance takes GPX directly — no need to write a real
// binary .usr file back out, which is a much heavier, riskier thing to get
// right without a real unit to test against).
//
// Lives as its own page script (like week.js/live.js/locationsadmin.js),
// reusing the shared plumbing already in charts.js: getConnection/GITHUB_API
// for the read-sha/write pattern, MARKS_FILE_PATH/MARK_LISTS_FILE_PATH,
// makeMarkId, nowAsNaiveString/parseNaive/previewEpochToNaiveString for the
// site's naive-timestamp convention, parseGpxWaypoints for GPX <wpt>
// parsing, and the new saveMarksBatchToGitHub for the actual write.
//
// Gated behind getConnection() the same way every other write-capable page
// on this site is — see canSync() below. A file can still be PARSED without
// a connection (nothing here needs GitHub for that), but there's no point
// showing a review screen for an import that can't be saved anywhere, so
// the whole workflow is hidden until connected, same as Settings/marks
// editing elsewhere.

// ---------------------------------------------------------------------------
// State — module-level, single active import at a time (matches how every
// other admin-y page on this site works: one file, one review pass, no
// multi-tab-juggling of several imports at once).
// ---------------------------------------------------------------------------

let existingMarks = []; // loaded once from data/marks.json — used both to
                         // match new candidates against and (on successful
                         // import) kept in sync locally so a second import
                         // in the same session matches against what was
                         // just added too, without a re-fetch.
let markLists = []; // config/mark_lists.json rows — species pick-list options
let knownSpecies = [];
let candidates = []; // the current file's parsed+deduped candidate marks —
                      // see collapseRawWaypoints/buildCandidatesFromRaw
let visibleCount = 100; // how many of `candidates` (after search filtering)
                         // are actually in the DOM right now — see
                         // renderReviewList/btnShowMore. Kept well below the
                         // full count even for a multi-thousand-waypoint
                         // file: a few thousand real <select>/<input>
                         // elements at once is a genuinely sluggish page,
                         // not just a theoretical concern, and nothing here
                         // needs every row rendered simultaneously — only
                         // whichever ones are currently selected matter, and
                         // `selected` lives on the candidate object itself,
                         // not on the DOM, so it survives regardless of
                         // what's currently drawn.
let searchFilter = "";

// How close two points have to be to count as "the same spot" — both for
// collapsing repeat device saves of one spot into a single candidate, and
// for recognising a candidate that's already tracked in marks.json. Fixed
// at 20m rather than a UI setting for now, per Oliver's own call when this
// tab was being designed — distance alone, no name/species check, so a
// genuinely different catch recorded a few metres from an old one will
// still get folded in as "already tracked" and left out of the review list
// entirely (see reviewableCandidates) — only genuinely new spots are real
// import candidates, so there's nothing for an already-tracked one to do
// there, even unchecked.
const SYNC_MATCH_RADIUS_M = 20;

// Grid cell size for the spatial index below, in degrees — deliberately
// much wider than SYNC_MATCH_RADIUS_M (roughly 1km at Victorian latitudes,
// vs a 20m match radius) so any two points within the match radius are
// GUARANTEED to land in the same or an immediately adjacent cell and never
// get missed by only checking the 3x3 neighbourhood — see nearbyCellIndices.
const SYNC_GRID_DEG = 0.01;

// A handful of device-name -> pick-list-species aliases where the
// chartplotter's own shorthand doesn't match config/mark_lists.json's
// wording exactly (seen directly in Oliver's own export: the unit saves
// "Gummy", the site's pick-list already has the fuller "Gummy Shark").
// Easy to extend later without any code change elsewhere — this is the
// only place that would need a new line.
const SYNC_SPECIES_ALIASES = {
  gummy: "Gummy Shark",
};

// ---------------------------------------------------------------------------
// Lowrance .usr (format 6) binary parser
// ---------------------------------------------------------------------------
//
// Lowrance/Navico chartplotters ("HDS", "Elite", "Solix" etc) export
// waypoints/routes/trails as a flat binary .usr file — format 6 is the
// current version and the only one this parses (GPSBabel 1.9.0, tested
// directly against one of Oliver's real exports, can't even read v6
// trails itself: "Lowrance USR trail version 6 not supported!!" — so
// there's no working off-the-shelf tool to lean on here for the browser
// side either). The field layout below was cross-checked against a real
// export using the `navtools` project's Python implementation
// (https://github.com/slott56/navtools/blob/master/navtools/lowrance_usr.py,
// itself derived from GPSBabel's own lowranceusr.cc) before being ported —
// every field, in the same order, same widths, same little-endian
// encoding.
//
// Deliberately stops reading immediately after the waypoints array. Routes,
// event markers, and trail data all follow in the real file, but this site
// only ever wants waypoints (routes here are just a name + a list of
// waypoint UUIDs, no real additional geometry; trails are GPS tracks, not
// marks) — and stopping early sidesteps needing to fully nail down the
// route/trail layout at all, including whatever exact ambiguity trips up
// GPSBabel's own v6 trail reader.

/** Wraps a DataView with a running byte offset — every usrRead* helper below
 * advances `cursor.offset` itself, so the call sites read top-to-bottom in
 * exactly the same order as the file's own field layout, with no manual
 * offset arithmetic scattered through them. */
function usrCursor(buffer) {
  return { view: new DataView(buffer), offset: 0 };
}

function usrU32(c) {
  const v = c.view.getUint32(c.offset, true);
  c.offset += 4;
  return v;
}
function usrI32(c) {
  const v = c.view.getInt32(c.offset, true);
  c.offset += 4;
  return v;
}
function usrI16(c) {
  const v = c.view.getInt16(c.offset, true);
  c.offset += 2;
  return v;
}
function usrI8(c) {
  const v = c.view.getInt8(c.offset);
  c.offset += 1;
  return v;
}
function usrF32(c) {
  const v = c.view.getFloat32(c.offset, true);
  c.offset += 4;
  return v;
}
function usrBytes(c, n) {
  if (n < 0 || c.offset + n > c.view.byteLength) {
    throw new Error(`Unexpected end of file while reading ${n} bytes at offset ${c.offset} — this file may not be a valid Lowrance .usr export.`);
  }
  const v = new Uint8Array(c.view.buffer, c.view.byteOffset + c.offset, n);
  c.offset += n;
  return v;
}
function usrAscii(c, len) {
  return new TextDecoder("ascii").decode(usrBytes(c, len));
}
/**
 * Reads a name/description field's UTF-16LE bytes. `byteLen` is clamped to
 * 0 (rather than throwing) when negative — a real quirk seen directly in
 * Oliver's own export: roughly 3% of waypt_description_length values come
 * back as -1 (sentinel for "no description", presumably), not a parse
 * error. Confirmed by cross-checking against the `navtools` reference
 * parser's own AtomicField.extract(), which does exactly this same clamp
 * (`value if value >= 0 else 0`) when a length field feeds into a later
 * field's size — without it, one bad length silently corrupts every
 * waypoint read after it for the rest of the file.
 */
function usrUtf16(c, byteLen) {
  return new TextDecoder("utf-16le").decode(usrBytes(c, Math.max(byteLen, 0)));
}
/** Raw hex of a waypoint's 16-byte UUID — NOT the canonical 8-4-4-4-12
 * dashed form (that requires re-ordering some bytes to little/big-endian
 * mixed groups the way the UUID spec, and Python's `uuid.UUID(bytes_le=…)`,
 * do it). Nothing here needs the canonical string — this is only ever used
 * as a stable, reproducible dedupe key (see sourceUuid, matchAgainstExisting
 * below), and the raw bytes reproduce identically on every re-import
 * regardless of how they're formatted. */
function usrHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// WGS84 semi-minor axis — the exact constant Lowrance's own coordinate
// encoding is built on (confirmed against navtools' lon_deg/lat_deg, and
// empirically: decoding real waypoints from Oliver's export lands them
// squarely on known Port Phillip/Western Port fishing spots, not
// somewhere obviously wrong).
const USR_SEMIMINOR_B = 6356752.3142;
function usrLonDeg(mm) {
  return (mm / USR_SEMIMINOR_B) * (180 / Math.PI);
}
function usrLatDeg(mm) {
  return (2 * Math.atan(Math.exp(mm / USR_SEMIMINOR_B)) - Math.PI / 2) * (180 / Math.PI);
}

// Lowrance's per-waypoint creation date is a Julian day NUMBER (whole days,
// paired separately with a milliseconds-into-that-day field for the actual
// time), not a Unix timestamp. 2440588 is the exact whole-day offset
// between that Julian day numbering and 1970-01-01 — verified directly
// against navtools' own Python conversion (which goes via
// datetime.date.fromordinal and a JD_TO_ORDINAL constant of 1721425) run
// against a real waypoint from Oliver's export: both paths land on the
// same date, so this isn't a from-first-principles guess.
const USR_JULIAN_DAY_UNIX_OFFSET = 2440588;
function usrDateTimeToNaiveMs(julianDay, msIntoDay) {
  const dayMs = Date.UTC(1970, 0, 1) + (julianDay - USR_JULIAN_DAY_UNIX_OFFSET) * 86400000;
  return dayMs + msIntoDay;
}

/**
 * Parses a Lowrance .usr (format 6) ArrayBuffer into plain
 * {lat, lng, rawName, notes, createdAtMs, uuid} waypoint objects — the same
 * shape buildCandidatesFromRaw expects regardless of source file type (see
 * handleFileInputChange). Throws a descriptive Error (never returns
 * partial/garbage results) if the format byte isn't 6, or if the file ends
 * unexpectedly partway through a field — both signal this isn't the kind of
 * export this parser understands, rather than something worth silently
 * limping through.
 */
function parseUsrWaypoints(buffer) {
  const c = usrCursor(buffer);
  const format = usrU32(c);
  if (format !== 6) {
    throw new Error(
      `This .usr file is format version ${format}, not 6 — only version 6 ` +
        `(the current Lowrance export format, and the only one Oliver's unit ` +
        `has been seen to produce) is supported here. Older versions (2–5) use ` +
        `a different waypoint layout this parser doesn't implement.`
    );
  }
  usrU32(c); // data_stream_version — unused
  const titleLen = usrI32(c);
  usrAscii(c, titleLen); // file_title — unused (e.g. "Navico export data file")
  const dateTextLen = usrI32(c);
  usrAscii(c, dateTextLen); // file_creation_date_text — unused
  usrU32(c); // file_creation_date — the EXPORT date, not per-waypoint — unused
  usrU32(c); // file_creation_time — unused
  usrI8(c); // unknown
  usrU32(c); // unit_serial_number — unused
  const descLen = usrI32(c);
  usrAscii(c, descLen); // file_description — unused (e.g. "Waypoints, routes, and trails")

  const numWaypoints = usrI32(c);
  const waypoints = [];
  for (let i = 0; i < numWaypoints; i++) {
    const uuidBytes = usrBytes(c, 16);
    usrU32(c); // UID_unit_number
    usrBytes(c, 8); // UID_sequence_number (uint64) — not needed for anything here
    usrI16(c); // waypt_stream_version
    const nameLen = usrI32(c);
    const name = usrUtf16(c, nameLen);
    usrU32(c); // UID_unit_number_2 (repeated)
    const lonRaw = usrI32(c);
    const latRaw = usrI32(c);
    usrU32(c); // flags
    usrI16(c); // icon_id
    usrI16(c); // color_id
    const descriptionLen = usrI32(c);
    const description = usrUtf16(c, descriptionLen);
    usrF32(c); // alarm_radius
    const creationJd = usrU32(c);
    const creationMsIntoDay = usrU32(c);
    usrI8(c); // unknown_2
    usrF32(c); // depth — always 0.0 in every export seen so far; not surfaced
    usrI32(c);
    usrI32(c);
    usrI32(c); // LORAN_GRI/Tda/Tdb — no LORAN use case on this site

    waypoints.push({
      lat: usrLatDeg(latRaw),
      lng: usrLonDeg(lonRaw),
      rawName: name,
      notes: description,
      createdAtMs: usrDateTimeToNaiveMs(creationJd, creationMsIntoDay),
      uuid: usrHex(uuidBytes),
    });
  }
  return waypoints;
}

// ---------------------------------------------------------------------------
// Common candidate-building — shared by both file types once each has been
// reduced to the same plain {lat, lng, rawName, notes, createdAtMs, uuid}
// shape (GPX waypoints never have a uuid; that field stays null for them).
// ---------------------------------------------------------------------------

/** Strips a device's own auto-numbering suffix ("Snapper-13" -> "Snapper")
 * and applies SYNC_SPECIES_ALIASES, then tries to match the result against
 * config/mark_lists.json's actual Species pick-list (case-insensitively).
 * Falls back to the stripped device name itself if nothing matches — still
 * a perfectly editable value in the review row, and a real option Settings
 * can formally add to the pick-list later if it turns out to be a genuine
 * new species rather than a typo. */
function guessSpeciesFromRawName(rawName) {
  const stripped = String(rawName || "").replace(/-\d+$/, "").trim();
  const alias = SYNC_SPECIES_ALIASES[stripped.toLowerCase()];
  if (alias && knownSpecies.includes(alias)) return alias;
  const exact = knownSpecies.find((s) => s.toLowerCase() === stripped.toLowerCase());
  return exact || stripped;
}

/** Lowrance descriptions bundle the real free-text note together with a
 * SEPARATELY maintained "dates this spot was last visited" list, appended
 * after a newline (each date \r-separated, most recent first) — e.g.
 * "Drifting in this area below...\n8/01/2026\r2/01/2026\r26/12/2025\r".
 * That trailing list is redundant with the actual per-waypoint creation
 * timestamp this parser already reads directly (and more precisely, with
 * time-of-day) for every separate waypoint record at that spot — see
 * collapseRawWaypoints, which merges those separate records and keeps their
 * real timestamps rather than re-parsing this text — so it's stripped here
 * rather than carried into a mark's notes. */
function cleanDeviceDescription(desc) {
  if (!desc) return "";
  return desc.replace(/[\r\n]+\s*(?:\d{1,2}\/\d{1,2}\/\d{4}\s*)+$/, "").trim();
}

/** Point-to-point distance in metres, using the same local
 * equirectangular-projection approximation as overpassSegmentDistanceM in
 * charts.js — plenty accurate at the few-hundred-metre scale matching runs
 * at here, far simpler than exact spherical geometry. */
function syncDistanceMeters(lat1, lng1, lat2, lng2) {
  const lat0 = ((lat1 + lat2) / 2) * (Math.PI / 180);
  const kx = 111320 * Math.cos(lat0);
  const ky = 110540;
  const dx = (lng2 - lng1) * kx;
  const dy = (lat2 - lat1) * ky;
  return Math.hypot(dx, dy);
}

function gridCellKey(lat, lng) {
  return `${Math.floor(lat / SYNC_GRID_DEG)}:${Math.floor(lng / SYNC_GRID_DEG)}`;
}

/** Every grid-cell key touching the 3x3 neighbourhood around (lat, lng) —
 * see SYNC_GRID_DEG's own comment for why 3x3 at this cell size is always
 * wide enough to catch every point within SYNC_MATCH_RADIUS_M. */
function neighbourhoodCellKeys(lat, lng) {
  const cx = Math.floor(lat / SYNC_GRID_DEG);
  const cy = Math.floor(lng / SYNC_GRID_DEG);
  const keys = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) keys.push(`${cx + dx}:${cy + dy}`);
  }
  return keys;
}

/**
 * Collapses raw per-waypoint records into one candidate per distinct real
 * spot — a fishing device commonly saves a fresh waypoint every time you're
 * sitting over (or drift back across) the same mark, rather than updating
 * one existing waypoint, so a real file routinely has several separate
 * records for what's genuinely one spot (Oliver's own export: 517 of 2,664
 * waypoints share a coordinate with at least one other). Two raw waypoints
 * are folded together when they're within SYNC_MATCH_RADIUS_M of each other
 * AND resolve to the same guessed species — species is checked here (unlike
 * the existing-marks match below) because this is squarely "the same
 * physical waypoint, saved again", not "a different catch that happens to
 * be nearby", and collapsing across species would wrongly erase a real
 * Squid mark sitting a few metres from an old Snapper one.
 *
 * A grid index (see gridCellKey/neighbourhoodCellKeys) keeps this close to
 * linear in the number of waypoints rather than the O(n²) a naive
 * compare-everything-to-everything scan would be — matters here since a
 * real export can be several thousand waypoints.
 */
function collapseRawWaypoints(rawList) {
  const groups = [];
  const cellIndex = new Map(); // cell key -> [group indices]

  const addToIndex = (groupIdx) => {
    const g = groups[groupIdx];
    const key = gridCellKey(g.lat, g.lng);
    if (!cellIndex.has(key)) cellIndex.set(key, []);
    cellIndex.get(key).push(groupIdx);
  };

  for (const raw of rawList) {
    const species = guessSpeciesFromRawName(raw.rawName);
    let matched = null;
    for (const key of neighbourhoodCellKeys(raw.lat, raw.lng)) {
      const indices = cellIndex.get(key);
      if (!indices) continue;
      for (const gi of indices) {
        const g = groups[gi];
        if (g.species !== species) continue;
        if (syncDistanceMeters(g.lat, g.lng, raw.lat, raw.lng) <= SYNC_MATCH_RADIUS_M) {
          matched = g;
          break;
        }
      }
      if (matched) break;
    }
    if (matched) {
      matched.visitCount += 1;
      if (raw.uuid) matched.uuids.push(raw.uuid);
      // Keep whichever record is most recent as the group's "current"
      // notes/timestamp — matches the same "most recent catch here"
      // convention the old gpx-import batch already established (see the
      // `source` field's schema comment in charts.js).
      if (raw.createdAtMs != null && (matched.latestMs == null || raw.createdAtMs > matched.latestMs)) {
        matched.latestMs = raw.createdAtMs;
        matched.notes = raw.notes || matched.notes;
      }
    } else {
      groups.push({
        lat: raw.lat,
        lng: raw.lng,
        species,
        rawName: raw.rawName,
        notes: raw.notes || "",
        latestMs: raw.createdAtMs,
        visitCount: 1,
        uuids: raw.uuid ? [raw.uuid] : [],
      });
      addToIndex(groups.length - 1);
    }
  }
  return groups;
}

/**
 * Flags each collapsed group with whatever it matches in the ALREADY
 * TRACKED marks.json, if anything — two ways, checked in order:
 *
 *  1. Exact sourceUuid match (Lowrance only) — a re-import of the exact
 *     same device waypoint, recognised with certainty regardless of how far
 *     its coordinate or description might have drifted since. This is
 *     strictly a bonus available because Lowrance's own UUIDs happen to
 *     survive re-export unchanged; it doesn't change the matching Oliver
 *     asked for below, it just catches a case plain distance matching can't
 *     (a waypoint edited/moved on the device between exports).
 *  2. Distance-only fallback (both file types) — nearest existing mark
 *     within SYNC_MATCH_RADIUS_M, no species/name check at all, per
 *     Oliver's own call on how this should work. This is what a Garmin GPX
 *     import always falls back to, since Garmin waypoints carry no
 *     persistent ID this site can key on.
 *
 * A matched candidate is kept on the `candidates` array (see
 * handleFileInputChange) so renderSummary can still report an honest total
 * and matched-count, but reviewableCandidates() (below) filters it out of
 * the actual review list — per Oliver's own call, only genuinely-new spots
 * are real import candidates at all, so there's nothing useful for a
 * matched one to do in that list even unchecked. The trade-off is real:
 * a genuinely different catch recorded a few metres from an old mark would
 * also match here and quietly not appear. Given the 20m radius that's judged
 * an acceptable, deliberate cost — see SYNC_MATCH_RADIUS_M's own comment.
 */
function matchAgainstExisting(groups) {
  const uuidToMark = new Map();
  const cellIndex = new Map();
  existingMarks.forEach((m, idx) => {
    if (m.sourceUuid) uuidToMark.set(m.sourceUuid, m);
    if (typeof m.lat === "number" && typeof m.lng === "number") {
      const key = gridCellKey(m.lat, m.lng);
      if (!cellIndex.has(key)) cellIndex.set(key, []);
      cellIndex.get(key).push(idx);
    }
  });

  for (const g of groups) {
    let exact = null;
    for (const id of g.uuids) {
      if (uuidToMark.has(id)) {
        exact = uuidToMark.get(id);
        break;
      }
    }
    if (exact) {
      g.matchedExisting = { id: exact.id, name: exact.name, species: exact.species, distanceM: 0, exact: true };
      continue;
    }
    let best = null;
    for (const key of neighbourhoodCellKeys(g.lat, g.lng)) {
      const indices = cellIndex.get(key);
      if (!indices) continue;
      for (const idx of indices) {
        const m = existingMarks[idx];
        const d = syncDistanceMeters(g.lat, g.lng, m.lat, m.lng);
        if (d <= SYNC_MATCH_RADIUS_M && (!best || d < best.distanceM)) {
          best = { id: m.id, name: m.name, species: m.species, distanceM: d, exact: false };
        }
      }
    }
    g.matchedExisting = best;
  }
}

// ---------------------------------------------------------------------------
// GPX export — the reverse direction: turn the current data/marks.json into
// a GPX file suitable for loading onto either a Garmin unit or Oliver's
// Lowrance sounder directly (confirmed it accepts GPX import — no need for
// a real binary .usr writer, which would be a much bigger, riskier lift to
// get right without a real unit here to test an exported file against).
// ---------------------------------------------------------------------------

function escapeXml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "YYYY-MM-DD HH:MM:SS" (this site's naive convention — see parseNaive,
 * charts.js) -> "YYYY-MM-DDTHH:MM:SSZ". The trailing "Z" is only there
 * because strict GPX readers expect a real <time> to look UTC-shaped — it's
 * NOT a claim these digits are actually UTC, same "naive digits treated as
 * if they were UTC, purely for encoding" convention as everywhere else on
 * this site. */
function naiveToGpxTime(naive) {
  if (!naive) return "";
  return String(naive).replace(" ", "T") + "Z";
}

// Lowrance's own GPX <sym> vocabulary for waypoint icons — "shape,color",
// e.g. "circle,blue", lowercase, no space. CONFIRMED DIRECTLY against a
// real GPX file Oliver exported from his own HDS Live-7 after manually
// setting 7 waypoints on the unit itself (one of each of its 7 real
// colours, on circle/cross/diamond shapes):
//   circle,blue   circle,yellow   circle,white   circle,green
//   circle,cyan   cross,magenta   diamond,red
// Garmin wants the SAME idea — shape,colour — but in Title Case with a
// space after the comma: "Circle, Yellow", not "circle,yellow". Genuinely
// two different vocabularies for the same concept, confirmed when a GPX
// exported for Lowrance failed to import cleanly on a Garmin unit. That's
// the whole reason every function in this section takes a `device`
// parameter now.
//
// SHAPE and COLOUR are two INDEPENDENT axes, each with its own kind of
// Mark Format (config/mark_lists.json's own field: "Mark Shape Format" /
// "Mark Colour Format" entries — see the "Fishing Mark Lists" section,
// locationsadmin.js), REVISED from an earlier version that bundled both
// into one Format together. Bundling them meant assigning a species a
// colour ALSO silently overrode its shape (species winning over Mark
// Type, same priority either way) — losing the "a Catch reads as a cross,
// a Mark reads as a circle, regardless of species" distinction the moment
// any species got a colour of its own. Splitting them fixes that: shape
// still normally comes from Mark Type day to day (a species-level shape
// assignment is a deliberate override, the exception, not the rule — see
// resolveMarkShapeFormat's own comment), while colour normally DOES vary
// by species, which is the whole point of assigning one. gpxSymForMark
// below resolves each piece independently, then simply concatenates them
// — no separator added by this code at all, since each Format's own
// device text already carries whatever punctuation that device wants
// baked into the fragment itself (Oliver's own call, made once per
// Format).
// Species' own assigned Format wins over its Mark Type's for BOTH axes
// when both are set, mirroring resolveMarkShapeFormat/resolveMarkColorFormat
// in charts.js exactly (kept as separate small copies here rather than
// importing them, since sync.js and charts.js load on different pages).

/** Mirrors resolveMarkShapeFormat in charts.js exactly — see that copy's
 * own comment for the species-then-type priority, and why a species-level
 * shape assignment is meant to stay the exception, not the everyday
 * case. */
function resolveMarkShapeFormat(m) {
  if (m.species) {
    const speciesEntry = markLists.find((r) => r.field === "Species" && r.value === m.species);
    if (speciesEntry && speciesEntry.shapeFormat) {
      const format = markLists.find((r) => r.field === "Mark Shape Format" && r.value === speciesEntry.shapeFormat);
      if (format) return format;
    }
  }
  const typeEntry = markLists.find((r) => r.field === "Mark Type" && r.value === m.type);
  if (typeEntry && typeEntry.shapeFormat) {
    const format = markLists.find((r) => r.field === "Mark Shape Format" && r.value === typeEntry.shapeFormat);
    if (format) return format;
  }
  return null;
}

/** Mirrors resolveMarkColorFormat in charts.js exactly — see that copy's
 * own comment for the species-then-type priority (colour is meant to be
 * the everyday case for a species-level assignment, unlike shape above). */
function resolveMarkColorFormat(m) {
  if (m.species) {
    const speciesEntry = markLists.find((r) => r.field === "Species" && r.value === m.species);
    if (speciesEntry && speciesEntry.colorFormat) {
      const format = markLists.find((r) => r.field === "Mark Colour Format" && r.value === speciesEntry.colorFormat);
      if (format) return format;
    }
  }
  const typeEntry = markLists.find((r) => r.field === "Mark Type" && r.value === m.type);
  if (typeEntry && typeEntry.colorFormat) {
    const format = markLists.find((r) => r.field === "Mark Colour Format" && r.value === typeEntry.colorFormat);
    if (format) return format;
  }
  return null;
}

// Legacy fallback shape per Mark Type, used ONLY when neither a mark's
// species nor its Type has a Mark Shape Format assigned at all (see
// legacyShapeFragment below) — matches this site's original hardcoded
// behaviour from before Mark Formats existed, so a repo that hasn't
// touched any of this yet exports exactly as it always did.
const MARK_TYPE_DEFAULT_SHAPE = { POI: "diamond", Catch: "cross", Fish: "cross" };

function capitalizeWord(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The bare legacy shape WORD for a Mark Type — circle/diamond/cross, no
 * punctuation attached at all. */
function legacyShapeWord(type) {
  return MARK_TYPE_DEFAULT_SHAPE[type] || "circle";
}

/** The legacy SHAPE fragment for a mark with no Mark Shape Format
 * resolved, for the shape+colour CONCATENATION case — every Mark Type
 * concatenates shape and colour now, POI included (see gpxSymForMark
 * below). Same hardcoded shape-by-Mark-Type this always
 * had, but WITH its own trailing separator baked in (a comma for
 * Lowrance, ", " for Garmin) so it still joins correctly with a colour
 * fragment even when BOTH pieces are falling back to their legacy default
 * at once — a bare "circle" next to a bare "blue" would otherwise
 * concatenate into the meaningless "circleblue" with nothing separating
 * them at all. `device` is "lowrance" (lowercase) or "garmin" (Title
 * Case). */
function legacyShapeFragment(type, device) {
  const shape = legacyShapeWord(type);
  return device === "garmin" ? `${capitalizeWord(shape)}, ` : `${shape},`;
}

/** The legacy COLOUR fragment for a mark with no Mark Colour Format
 * resolved — same plain "blue" default this always had, as a bare
 * fragment. */
function legacyColorFragment(device) {
  return device === "garmin" ? "Blue" : "blue";
}

/** The <sym> value for one mark on export, for a given device ("lowrance"
 * or "garmin") — built from two INDEPENDENTLY resolved pieces, shape and
 * colour (see resolveMarkShapeFormat/resolveMarkColorFormat above), then
 * simply concatenated shape-fragment-then-colour-fragment, for EVERY Mark
 * Type including POI (a POI still gets its own colour — from its Mark
 * Type's own colorFormat, since it has no species to override with — the
 * same as Mark/Catch, just resolved through the type branch rather than
 * the species one; there's nothing structurally special about POI here
 * at export time). No separator added here for a RESOLVED Format's own
 * text — each Format's own device text already carries whatever
 * punctuation/spacing that device needs baked in (e.g. a Shape Format's
 * lowranceSym might literally be "circle," with the trailing comma
 * included, joining cleanly with a Colour Format's bare "blue"); this
 * function has no opinion on that itself, it's Oliver's own call, made
 * once per Format rather than guessed at export time. Either piece
 * missing a Format for a mark (or a Format that hasn't had this specific
 * device's text filled in yet) falls back to that piece's own legacy
 * fragment, so a mark never exports with half its <sym> silently blank. */
function gpxSymForMark(m, device) {
  const symField = device === "garmin" ? "garminSym" : "lowranceSym";
  const shapeFormat = resolveMarkShapeFormat(m);
  const shapeFragment = (shapeFormat && shapeFormat[symField]) || legacyShapeFragment(m.type, device);
  const colorFormat = resolveMarkColorFormat(m);
  const colorFragment = (colorFormat && colorFormat[symField]) || legacyColorFragment(device);
  return `${shapeFragment}${colorFragment}`;
}

function buildGpxDocument(marks, device) {
  const wpts = marks
    .map((m) => {
      // Species now goes in <name> (see below), so repeating it here would
      // be redundant — <desc> instead carries the mark's own `name` when
      // it's something DIFFERENT and worth keeping (most of the old
      // gpx-import batch has a real place name here, e.g. "Williamstown"),
      // plus any notes.
      const descParts = [];
      if (m.name && m.name !== m.species) descParts.push(m.name);
      if (m.notes) descParts.push(m.notes);
      const desc = descParts.join(" — ");
      const timeTag = m.dateTime ? `<time>${escapeXml(naiveToGpxTime(m.dateTime))}</time>` : "";
      const descTag = desc ? `<desc>${escapeXml(desc)}</desc>` : "";
      // Species first for a Mark/Catch, per Oliver's own earlier call —
      // most marks' `name` is a place name (Williamstown, Leopold, etc,
      // from the old gpx-import migration), which is far less useful on a
      // chartplotter than the actual catch/species. A POI has no species
      // of its own at all going forward (see the Mark/POI/Catch field
      // split, MARK_TYPE_FIELD_KEYS in charts.js) — its own name IS the
      // point, so it always wins there regardless of anything a stray
      // legacy `species` value on an old record might still hold.
      const nameTag = escapeXml(m.type === "POI" ? (m.name || "Mark") : (m.species || m.name || "Mark"));
      const symTag = `<sym>${escapeXml(gpxSymForMark(m, device))}</sym>`;
      return (
        `  <wpt lat="${m.lat}" lon="${m.lng}">\n` +
        `    <name>${nameTag}</name>\n` +
        (descTag ? `    ${descTag}\n` : "") +
        `    ${symTag}\n` +
        (timeTag ? `    ${timeTag}\n` : "") +
        `  </wpt>`
      );
    })
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="Olie's Kayak and Surf Fishing Conditions" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `${wpts}\n` +
    `</gpx>\n`
  );
}

/**
 * Saves `text` as a file, PREFERRING the File System Access API's native
 * "Save As" dialog (window.showSaveFilePicker) when the browser supports
 * it — Chromium-based browsers only (Chrome, Edge, and similar; not
 * Firefox or Safari, which don't implement this API at all) — since
 * that's genuinely the only way a web page can let someone choose WHERE a
 * file goes, not just what it's named. Plain <a download> (the fallback,
 * and the only option this used before) can only suggest a filename; the
 * actual save location is entirely up to the browser's own download
 * settings, with no way for this page to ask for one.
 *
 * Returns "saved" (via the picker), "saved-fallback" (via plain
 * download), or "cancelled" (the person explicitly backed out of the
 * picker — NOT treated as a failure, and deliberately does NOT fall
 * through to the plain-download fallback in that case: silently
 * downloading anyway after someone hits Cancel would be a confusing "I
 * said no and it saved anyway" experience). A genuine error from the
 * picker (not a cancellation) does fall through to the plain-download
 * fallback, so a real failure in the native dialog still ends with the
 * file actually saved somewhere rather than just lost.
 */
async function saveTextFile(filename, mimeType, text) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "GPX file", accept: { [mimeType]: [".gpx"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return "saved";
    } catch (err) {
      if (err.name === "AbortError") return "cancelled";
      console.error("showSaveFilePicker failed, falling back to plain download:", err);
    }
  }
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return "saved-fallback";
}

/** "fishing-marks-YYYY-MM-DD-HHMM.gpx" — date AND time (not just the date,
 * per Oliver's own call), so exporting more than once in a day doesn't
 * quietly overwrite an earlier download of the same name. Colons are
 * stripped from the time portion since they're one of the characters
 * Windows won't allow in a filename at all (see sanitizeExportFilename's
 * own comment on the rest). */
function defaultExportFilename() {
  const now = nowAsNaiveString(); // "YYYY-MM-DD HH:MM:SS"
  const datePart = now.slice(0, 10);
  const timePart = now.slice(11, 16).replace(":", "");
  return `fishing-marks-${datePart}-${timePart}.gpx`;
}

/** Whatever the person actually typed into the File name field, made safe
 * to save as-is: strips the handful of characters Windows (the strictest
 * common filesystem) won't allow in a filename at all (\/:*?"<>|), and
 * makes sure it ends in .gpx regardless of whether they typed that
 * themselves — a bare "Lang Lang Trip" becomes "Lang Lang Trip.gpx" rather
 * than downloading with no extension at all. Falls back to
 * defaultExportFilename() if the field was left blank or ends up empty
 * after stripping. */
function sanitizeExportFilename(raw) {
  let name = String(raw || "").trim();
  if (!name) return defaultExportFilename();
  name = name.replace(/[\\/:*?"<>|]/g, "").trim();
  if (!name) return defaultExportFilename();
  if (!/\.gpx$/i.test(name)) name += ".gpx";
  return name;
}

async function handleExportClick(device) {
  const statusEl = document.getElementById("exportStatus");
  statusEl.textContent = "Building export…";
  statusEl.style.color = "";
  try {
    // Fresh fetch rather than reusing the in-memory existingMarks — this
    // button should export whatever is REALLY in the repo right now, not a
    // copy that might be stale if marks were edited elsewhere (another
    // tab, another device) since this page loaded. Cache-busted for the
    // same reason loadAndRenderMarks is (charts.js): GitHub Pages' CDN
    // caches static files for up to 10 minutes.
    const res = await fetch(`${MARKS_FILE_PATH}?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Could not load marks.json (${res.status})`);
    const data = await res.json();
    const marks = Array.isArray(data.marks) ? data.marks : [];
    if (marks.length === 0) {
      statusEl.textContent = "No marks to export yet.";
      return;
    }
    const gpx = buildGpxDocument(marks, device);
    const filenameInput = document.getElementById("exportFilenameInput");
    // Device name goes FIRST (lowrance-fishing-marks-..., not
    // fishing-marks-...-lowrance) — Oliver's own call, and it also means
    // the two exports sort next to each other by device when browsing a
    // downloads folder, rather than by date first. Still tags every
    // export with which device it's for either way — exporting both back
    // to back, a completely reasonable thing to do with two separate
    // buttons now, would otherwise silently overwrite one file with the
    // other if they'd land on the exact same name.
    const baseFilename = sanitizeExportFilename(filenameInput ? filenameInput.value : "");
    const filename = `${device}-${baseFilename}`;
    statusEl.textContent = window.showSaveFilePicker ? "Choose where to save…" : "Downloading…";
    const outcome = await saveTextFile(filename, "application/gpx+xml", gpx);
    if (outcome === "cancelled") {
      statusEl.textContent = "Export cancelled.";
      statusEl.style.color = "";
      return;
    }
    const savedNote = outcome === "saved-fallback" ? " (saved to your browser's default download location — this browser doesn't support choosing a folder)" : "";
    const deviceLabel = device === "garmin" ? "Garmin" : "Lowrance";
    statusEl.textContent = `Exported ${marks.length} marks as ${filename}${savedNote} — load this onto your ${deviceLabel} via its GPX import option.`;
    statusEl.style.color = "#16a34a";
  } catch (err) {
    console.error("GPX export failed:", err);
    statusEl.textContent = "Export failed: " + err.message;
    statusEl.style.color = "#dc2626";
  }
}

// ---------------------------------------------------------------------------
// Review UI
// ---------------------------------------------------------------------------

/** Only genuinely-new candidates are ever reviewable — anything already
 * matched to a mark in data/marks.json (see matchAgainstExisting) isn't a
 * real import candidate at all, so it's excluded here rather than just
 * shown unchecked. This is the ONE place that distinction is applied;
 * every other function below (rendering, search, select-all) works off
 * this list, not the raw `candidates` array, so a matched point can never
 * end up on screen or get imported by accident. renderSummary is the sole
 * exception — it still reports the matched count for transparency, just
 * without listing them individually. */
function reviewableCandidates() {
  return candidates.filter((c) => !c.matchedExisting);
}

function candidateMatchesSearch(c) {
  if (!searchFilter) return true;
  const haystack = `${c.species || ""} ${c.name || ""} ${c.rawName || ""}`.toLowerCase();
  return haystack.includes(searchFilter);
}

function renderSummary() {
  const el = document.getElementById("syncSummary");
  if (!el) return;
  const newCount = reviewableCandidates().length;
  const matchedCount = candidates.length - newCount;
  el.textContent =
    `${candidates.length} distinct spot${candidates.length === 1 ? "" : "s"} found — ` +
    `${newCount} new (listed below), ${matchedCount} already within ${SYNC_MATCH_RADIUS_M}m of an ` +
    `existing mark (not shown — nothing to import there).`;
}

function renderCandidateRow(c, i) {
  const speciesOptions = knownSpecies
    .map((s) => `<option value="${escapeHtml(s)}" ${s === c.species ? "selected" : ""}>${escapeHtml(s)}</option>`)
    .join("");
  const speciesIsKnown = knownSpecies.includes(c.species);
  const extraOption = speciesIsKnown || !c.species ? "" : `<option value="${escapeHtml(c.species)}" selected>${escapeHtml(c.species)} (new)</option>`;

  // No matched-existing badge branch here any more — a row only ever
  // renders at all when reviewableCandidates() included it, i.e. it's
  // always genuinely new. See reviewableCandidates' own comment.
  const visitBadge = c.visitCount > 1 ? `<span class="pill sync-pill-visits">${c.visitCount} visits merged</span>` : "";

  // Mark Type itself is always shown (it's what DRIVES which of the other
  // fields show at all — see applyMarkFieldVisibility, charts.js, reused
  // here unchanged) — split out of the generic pick-list loop below so its
  // own <select> can be found directly (data-mark-type-select) for wiring
  // a change listener, same convention as the main mark-edit popup.
  const typeOptionsHtml = markListOptionsHtml(markLists, "Mark Type", c.type);

  // Every OTHER pick-list field a mark can carry (Weather/Tide/Water
  // Condition, Bait, Rig, Rod, Berley) — driven straight off
  // MARK_LIST_FIELDS/markListOptionsHtml, the exact same list+lookup the
  // main mark-edit popup itself uses (buildMarkPopupEditHtml, charts.js),
  // rather than a second hand-maintained copy that could drift out of
  // sync with it (an earlier version of this row DID drift: Mark Type was
  // hardcoded to just Fish/POI here, ignoring anything else added via the
  // Settings tab, and Water/Bait/Rig/Rod/Berley weren't shown at all).
  // Species is excluded from this loop and handled separately above/below
  // it — it gets its own "(new)" labelling for an unrecognised device
  // species name, which is common and worth flagging distinctly; that
  // doesn't apply to any of these other fields. Each one is wrapped in a
  // `display:contents` span carrying `data-field-group` — contributes no
  // box of its own (so it doesn't disturb the flex layout these sit in),
  // but lets applyMarkFieldVisibility (charts.js) show/hide it exactly the
  // same way it already does in the main mark popup, off the SAME
  // MARK_TYPE_FIELD_KEYS map, rather than a second copy of "which fields
  // go with which type" logic living here too.
  const otherListFieldsHtml = MARK_LIST_FIELDS.filter((f) => f.key !== "species" && f.key !== "type")
    .map(
      (f) => `<span data-field-group="${f.key}" style="display:contents"><select data-role="${f.key}" data-idx="${i}" title="${escapeHtml(f.label)}">${markListOptionsHtml(markLists, f.label, c[f.key])}</select></span>`
    )
    .join("");

  // Wind Direction isn't in MARK_LIST_FIELDS at all — same as the main
  // popup, it's sourced from SHORE_OPTIONS (charts.js's fixed 16-point
  // compass list), not an editable Settings-tab pick-list.
  const windDirectionOptions = SHORE_OPTIONS.map((d) => `<option value="${d}" ${d === c.windDirection ? "selected" : ""}>${d}</option>`).join("");

  return `
    <div class="sync-row" data-idx="${i}">
      <label class="sync-row-check">
        <input type="checkbox" data-role="select" data-idx="${i}" ${c.selected ? "checked" : ""} />
      </label>
      <div class="sync-row-body">
        <div class="sync-row-badges">
          <span class="pill sync-pill-new">new</span>${visitBadge}
          <span class="sync-row-coords">${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}</span>
        </div>
        <div class="sync-row-inputs">
          <input type="text" data-role="name" data-idx="${i}" value="${escapeHtml(c.name)}" placeholder="Display name" title="Name" />
          <input type="datetime-local" data-role="dateTime" data-idx="${i}" step="1" value="${naiveToDatetimeLocal(c.dateTime)}" title="Date/Time" />
          <select data-role="type" data-idx="${i}" data-mark-type-select title="Mark Type">${typeOptionsHtml}</select>
          <span data-field-group="species" style="display:contents">
            <select data-role="species" data-idx="${i}" title="Species">
              <option value="">—</option>${speciesOptions}${extraOption}
            </select>
          </span>
          ${otherListFieldsHtml}
        </div>
        <div class="sync-row-inputs">
          <span data-field-group="size" style="display:contents"><input type="number" data-role="size" data-idx="${i}" value="${c.size != null ? c.size : ""}" min="0" step="1" placeholder="Size (cm)" title="Size (cm)" /></span>
          <span data-field-group="barometer" style="display:contents"><input type="number" data-role="barometer" data-idx="${i}" value="${c.barometer != null ? c.barometer : ""}" min="0" step="0.1" placeholder="hPa" title="Barometer (hPa)" /></span>
          <span data-field-group="temperature" style="display:contents"><input type="number" data-role="temperature" data-idx="${i}" value="${c.temperature != null ? c.temperature : ""}" step="0.1" placeholder="Air °C" title="Temperature (°C)" /></span>
          <span data-field-group="waterTemperature" style="display:contents"><input type="number" data-role="waterTemperature" data-idx="${i}" value="${c.waterTemperature != null ? c.waterTemperature : ""}" step="0.1" placeholder="Water °C" title="Water Temp (°C)" /></span>
          <span data-field-group="waterDepth" style="display:contents"><input type="number" data-role="waterDepth" data-idx="${i}" value="${c.waterDepth != null ? c.waterDepth : ""}" min="0" step="0.1" placeholder="Depth (m)" title="Water Depth (m)" /></span>
          <span data-field-group="windDirection" style="display:contents">
            <select data-role="windDirection" data-idx="${i}" title="Wind Direction">
              <option value=""${c.windDirection ? "" : " selected"}>Wind</option>${windDirectionOptions}
            </select>
          </span>
          <span data-field-group="windSpeed" style="display:contents"><input type="number" data-role="windSpeed" data-idx="${i}" value="${c.windSpeed != null ? c.windSpeed : ""}" min="0" step="1" placeholder="km/h" title="Wind Speed (km/h)" /></span>
        </div>
        <span data-field-group="notes" style="display:contents"><textarea data-role="notes" data-idx="${i}" rows="2" placeholder="Notes">${escapeHtml(c.notes)}</textarea></span>
      </div>
    </div>`;
}

function renderReviewList() {
  const container = document.getElementById("reviewList");
  if (!container) return;
  const filtered = [];
  candidates.forEach((c, i) => {
    if (!c.matchedExisting && candidateMatchesSearch(c)) filtered.push(i);
  });
  const slice = filtered.slice(0, visibleCount);
  container.innerHTML = slice.map((i) => renderCandidateRow(candidates[i], i)).join("");

  // Apply each row's own field visibility for its CURRENT type — the same
  // MARK_TYPE_FIELD_KEYS-driven function the main mark-edit popup uses
  // (charts.js), just run once per row here since sync.js has no per-row
  // "just opened" moment to hook the way a Leaflet popup does.
  container.querySelectorAll(".sync-row").forEach((rowEl) => {
    const idx = Number(rowEl.dataset.idx);
    const c = candidates[idx];
    if (c) applyMarkFieldVisibility(rowEl, c.type);
  });

  const showMoreBtn = document.getElementById("btnShowMore");
  if (showMoreBtn) showMoreBtn.style.display = filtered.length > visibleCount ? "inline-block" : "none";

  const countEl = document.getElementById("reviewCount");
  if (countEl) {
    const totalReviewable = reviewableCandidates().length;
    countEl.textContent =
      `Showing ${slice.length} of ${filtered.length}` +
      (filtered.length !== totalReviewable ? ` (filtered from ${totalReviewable} new)` : "");
  }
}

/**
 * Bulk-selects/deselects, always scoped to whatever the current search
 * filter shows — hitting either button after filtering down to just
 * "Snapper" shouldn't silently touch every Whiting outside the current
 * filter. Only ever touches reviewableCandidates() (see its own comment) —
 * matched-existing candidates are never rendered as rows in the first
 * place now, so there's no separate "onlyNew" safeguard needed here any
 * more; there's simply nothing else in scope to select.
 */
function setAllSelected(value) {
  reviewableCandidates().forEach((c) => {
    if (candidateMatchesSearch(c)) c.selected = value;
  });
  renderReviewList();
}

// How many marks' historical-conditions lookups (see
// lookupHistoricalMarkConditions, charts.js) run at once during an import —
// each one is a real, billed WillyWeather call plus an Open-Meteo call, so
// this deliberately stays modest rather than firing every mark in a batch
// simultaneously. Doesn't need to be tuned per-import-size; a small pool
// just spreads the same total work out over a bit more wall-clock time.
const SYNC_LOOKUP_CONCURRENCY = 4;

/**
 * Runs `worker(item, index)` for every item in `items`, at most `limit` at
 * once, rather than a plain Promise.all firing everything simultaneously.
 * `onProgress(doneCount, total)`, if given, fires after each item finishes
 * (success or failure) — used here to keep the import status text moving
 * instead of sitting on one static message for however long a whole batch
 * takes. A single item throwing is caught and recorded as `null` in that
 * slot rather than aborting the rest of the batch.
 */
async function runWithConcurrencyLimit(items, limit, worker, onProgress) {
  let nextIndex = 0;
  let doneCount = 0;
  const results = new Array(items.length);
  async function runOne() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        console.error("Historical conditions lookup failed for one mark:", err);
        results[i] = null;
      }
      doneCount++;
      if (onProgress) onProgress(doneCount, items.length);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, runOne);
  await Promise.all(runners);
  return results;
}

async function handleImportClick() {
  const statusEl = document.getElementById("importStatus");
  const toImport = candidates.filter((c) => c.selected);
  if (toImport.length === 0) {
    statusEl.textContent = "Nothing selected to import.";
    statusEl.style.color = "#dc2626";
    return;
  }
  const btn = document.getElementById("btnImportSelected");
  btn.disabled = true;
  statusEl.textContent = `Importing ${toImport.length} mark${toImport.length === 1 ? "" : "s"}…`;
  statusEl.style.color = "";

  // Weather/Tide/Barometer/Wind are already looked up by this point — see
  // handleFileInputChange, which runs lookupHistoricalMarkConditions for
  // every reviewable candidate up front so the review list itself can show
  // it (per Oliver's own call), rather than this function looking it up a
  // second time at Import. Whatever's on each candidate now — including
  // anything edited by hand in the review row — is exactly what gets
  // saved.
  const nowStr = nowAsNaiveString();
  const newMarks = toImport.map((c) => {
    const mark = {
      id: makeMarkId(),
      lat: c.lat,
      lng: c.lng,
      name: c.name || c.species || "Imported mark",
      type: c.type || "Catch",
      dateTime: c.dateTime || nowStr,
      createdAt: nowStr,
      source: c.sourceLabel,
    };
    if (c.sourceUuid) mark.sourceUuid = c.sourceUuid;
    // Only ever includes fields applicable to mark.type — same
    // MARK_TYPE_FIELD_KEYS/fieldKeysForMarkType (charts.js) the main
    // mark-edit popup's own collectMarkFormValues uses, so switching a
    // candidate's Type to POI in the review row and importing it actually
    // omits its Species/etc, not just visually hides the input.
    const applicable = fieldKeysForMarkType(mark.type);
    if (applicable.includes("species") && c.species) mark.species = c.species;
    if (applicable.includes("notes") && c.notes) mark.notes = c.notes;
    if (applicable.includes("waterCondition") && c.waterCondition) mark.waterCondition = c.waterCondition;
    if (applicable.includes("bait") && c.bait) mark.bait = c.bait;
    if (applicable.includes("rig") && c.rig) mark.rig = c.rig;
    if (applicable.includes("rod") && c.rod) mark.rod = c.rod;
    if (applicable.includes("berley") && c.berley) mark.berley = c.berley;
    if (applicable.includes("size") && c.size != null) mark.size = c.size;
    if (applicable.includes("waterDepth") && c.waterDepth != null) mark.waterDepth = c.waterDepth;
    if (applicable.includes("weatherCondition") && c.weatherCondition) mark.weatherCondition = c.weatherCondition;
    if (applicable.includes("tideCondition") && c.tideCondition) mark.tideCondition = c.tideCondition;
    if (applicable.includes("barometer") && c.barometer != null) mark.barometer = c.barometer;
    if (applicable.includes("temperature") && c.temperature != null) mark.temperature = c.temperature;
    if (applicable.includes("waterTemperature") && c.waterTemperature != null) mark.waterTemperature = c.waterTemperature;
    if (applicable.includes("windDirection") && c.windDirection) mark.windDirection = c.windDirection;
    if (applicable.includes("windSpeed") && c.windSpeed != null) mark.windSpeed = c.windSpeed;
    return mark;
  });

  const result = await saveMarksBatchToGitHub(newMarks);
  if (result.success) {
    statusEl.textContent = `Imported ${result.added} mark${result.added === 1 ? "" : "s"} into data/marks.json.`;
    statusEl.style.color = "#16a34a";
    // Keep the local working copy in sync so a second import in the same
    // session (or hitting Export) reflects what was just written, without
    // needing a re-fetch — same reasoning as wireMarkPopupButtons doing the
    // equivalent for a single-mark save (charts.js).
    existingMarks.push(...newMarks);
    candidates = candidates.filter((c) => !c.selected);
    renderSummary();
    renderReviewList();
  } else {
    statusEl.textContent = "Import failed: " + result.error;
    statusEl.style.color = "#dc2626";
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// File handling
// ---------------------------------------------------------------------------

async function handleFileInputChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById("parseStatus");
  statusEl.textContent = "Reading file…";
  statusEl.style.color = "";
  document.getElementById("reviewSection").style.display = "none";

  try {
    const isUsr = /\.usr$/i.test(file.name);
    let rawWaypoints;
    let sourceLabel;

    if (isUsr) {
      const buffer = await file.arrayBuffer();
      rawWaypoints = parseUsrWaypoints(buffer);
      sourceLabel = "lowrance-import";
    } else {
      const text = await file.text();
      const gpxWps = parseGpxWaypoints(text); // shared helper, charts.js
      rawWaypoints = gpxWps.map((w) => ({
        lat: w.lat,
        lng: w.lon,
        rawName: w.name,
        notes: w.desc,
        // Garmin's own <time> is a real ISO string — treated with this
        // site's usual "naive digits, no timezone conversion" convention
        // (see parseNaive, charts.js), so any trailing Z/offset is just
        // dropped rather than converted.
        createdAtMs: w.time ? parseNaive(w.time) : null,
        uuid: null,
      }));
      sourceLabel = "garmin-import";
    }

    if (rawWaypoints.length === 0) {
      statusEl.textContent = "No waypoints found in that file.";
      return;
    }

    statusEl.textContent = `Parsed ${rawWaypoints.length} waypoints — matching against existing marks…`;
    const groups = collapseRawWaypoints(rawWaypoints);
    matchAgainstExisting(groups);

    candidates = groups.map((g, i) => ({
      key: `c${i}`,
      lat: g.lat,
      lng: g.lng,
      rawName: g.rawName,
      species: g.species,
      name: g.species,
      type: "Catch", // a device-imported waypoint IS a logged catch (species/location/time from the device) — see the Mark/POI/Catch schema split, charts.js's MARK_TYPE_FIELD_KEYS
      notes: cleanDeviceDescription(g.notes),
      dateTime: g.latestMs != null ? previewEpochToNaiveString(g.latestMs / 1000) : "",
      visitCount: g.visitCount,
      sourceUuid: g.uuids[0] || null,
      sourceLabel,
      matchedExisting: g.matchedExisting,
      selected: !g.matchedExisting, // only genuinely new spots pre-checked
      // Every other mark field this review row now also exposes for
      // editing (see renderCandidateRow) — blank until either the
      // historical lookup fills some of them in (weatherCondition/
      // tideCondition/barometer/temperature/waterTemperature/
      // windDirection/windSpeed) or the person edits one by hand.
      // waterCondition/bait/rig/rod/berley/size/waterDepth have no lookup
      // source at all (nothing feeds them automatically); they start
      // blank and stay that way unless hand-edited.
      waterCondition: undefined,
      bait: undefined,
      rig: undefined,
      rod: undefined,
      berley: undefined,
      size: undefined,
      waterDepth: undefined,
      // Filled in below, for reviewable candidates only — see
      // lookupHistoricalMarkConditions, charts.js. Left undefined (not
      // shown) for anything the lookup didn't resolve.
      weatherCondition: undefined,
      tideCondition: undefined,
      barometer: undefined,
      temperature: undefined,
      waterTemperature: undefined,
      windDirection: undefined,
      windSpeed: undefined,
    }));

    // Real historical weather/tide/barometer/wind lookup, run up front so
    // the review list can show it directly (per Oliver's own call — this
    // used to run later, only at Import time) — only for candidates
    // actually reviewable (see reviewableCandidates' own comment); a
    // matched-existing one is never shown or imported, so there's no
    // reason to spend a billed WillyWeather call plus an Open-Meteo call
    // looking anything up for it.
    const toLookUp = reviewableCandidates();
    if (toLookUp.length > 0) {
      statusEl.textContent = `Looking up conditions for ${toLookUp.length} new spot${toLookUp.length === 1 ? "" : "s"}…`;
      await runWithConcurrencyLimit(
        toLookUp,
        SYNC_LOOKUP_CONCURRENCY,
        async (c) => {
          const result = await lookupHistoricalMarkConditions(c.lat, c.lng, c.dateTime || nowAsNaiveString());
          Object.assign(c, result);
        },
        (done, total) => {
          statusEl.textContent = `Looking up conditions: ${done} of ${total}…`;
        }
      );
    }

    visibleCount = 100;
    searchFilter = "";
    const searchBox = document.getElementById("syncSearchBox");
    if (searchBox) searchBox.value = "";
    document.getElementById("importStatus").textContent = "";

    renderSummary();
    renderReviewList();
    document.getElementById("reviewSection").style.display = "block";
    statusEl.textContent = `Done — ${candidates.length} distinct spot${candidates.length === 1 ? "" : "s"} found from ${rawWaypoints.length} raw waypoints.`;
    statusEl.style.color = "#16a34a";
  } catch (err) {
    console.error("Import parse failed:", err);
    statusEl.textContent = "Could not read that file: " + err.message;
    statusEl.style.color = "#dc2626";
  }
}

// ---------------------------------------------------------------------------
// Page init
// ---------------------------------------------------------------------------

function canSync() {
  const conn = getConnection();
  return !!(conn && conn.owner && conn.repo && conn.token);
}

document.addEventListener("DOMContentLoaded", async () => {
  const gateEl = document.getElementById("syncNotConnected");
  const mainEl = document.getElementById("syncMain");
  if (!canSync()) {
    gateEl.style.display = "block";
    mainEl.style.display = "none";
    return;
  }
  gateEl.style.display = "none";
  mainEl.style.display = "block";

  // Loaded once, up front — needed both for matching (existingMarks) and
  // for the review row's Species dropdown options (markLists). Cache-busted
  // like every other config/data fetch on this site — see loadAndRenderMarks,
  // charts.js, for why (GitHub Pages' CDN caches static files for up to 10
  // minutes).
  const [marksRes, listsRes] = await Promise.all([
    fetch(`${MARKS_FILE_PATH}?_=${Date.now()}`, { cache: "no-store" }),
    fetch(`${MARK_LISTS_FILE_PATH}?_=${Date.now()}`, { cache: "no-store" }),
  ]);
  existingMarks = marksRes.ok ? (await marksRes.json()).marks || [] : [];
  markLists = listsRes.ok ? await listsRes.json() : [];
  knownSpecies = markLists.filter((r) => r.field === "Species").map((r) => r.value);

  document.getElementById("syncFileInput").addEventListener("change", handleFileInputChange);
  document.getElementById("btnSelectAllNew").addEventListener("click", () => setAllSelected(true));
  document.getElementById("btnDeselectAll").addEventListener("click", () => setAllSelected(false));
  document.getElementById("btnShowMore").addEventListener("click", () => {
    visibleCount += 100;
    renderReviewList();
  });
  document.getElementById("btnImportSelected").addEventListener("click", handleImportClick);
  document.getElementById("btnExportLowrance").addEventListener("click", () => handleExportClick("lowrance"));
  document.getElementById("btnExportGarmin").addEventListener("click", () => handleExportClick("garmin"));
  const filenameInput = document.getElementById("exportFilenameInput");
  if (filenameInput) filenameInput.value = defaultExportFilename();
  document.getElementById("syncSearchBox").addEventListener("input", (e) => {
    searchFilter = e.target.value.trim().toLowerCase();
    visibleCount = 100;
    renderReviewList();
  });

  // Event delegation on the (static) list container — rows themselves get
  // fully replaced on every render (renderReviewList/btnShowMore/search),
  // so listeners attached to the container itself, rather than to
  // individual rows, keep working without needing to be re-wired each time.
  // All the pick-list <select> fields (Mark Type, Species, and everything
  // in MARK_LIST_FIELDS) plus Wind Direction share one plain
  // "just copy the value across" handling — listed explicitly here rather
  // than inferred from the DOM, so a stray/unexpected data-role on some
  // other element can never silently get treated as a mark field.
  const SYNC_SELECT_ROLES = new Set([...MARK_LIST_FIELDS.map((f) => f.key), "windDirection"]);
  document.getElementById("reviewList").addEventListener("change", (e) => {
    const idx = Number(e.target.dataset.idx);
    if (Number.isNaN(idx)) return;
    const c = candidates[idx];
    if (!c) return;
    const role = e.target.dataset.role;
    if (role === "select") c.selected = e.target.checked;
    else if (SYNC_SELECT_ROLES.has(role)) {
      c[role] = e.target.value || undefined;
      // Changing Type live re-applies field visibility on THIS row (same
      // as the main mark-edit popup does) — the actual filtering-out of
      // any now-inapplicable field's stored value happens at Import time
      // (see handleImportClick), not here; this is purely the visual
      // show/hide.
      if (role === "type") {
        const rowEl = e.target.closest(".sync-row");
        if (rowEl) applyMarkFieldVisibility(rowEl, c.type);
      }
    }
  });
  document.getElementById("reviewList").addEventListener("input", (e) => {
    const idx = Number(e.target.dataset.idx);
    if (Number.isNaN(idx)) return;
    const c = candidates[idx];
    if (!c) return;
    const role = e.target.dataset.role;
    if (role === "name") c.name = e.target.value;
    else if (role === "notes") c.notes = e.target.value;
    else if (role === "dateTime") c.dateTime = datetimeLocalToNaive(e.target.value);
    else if (role === "size") {
      const v = e.target.value;
      c.size = v === "" ? undefined : Math.round(Number(v));
    } else if (role === "barometer") {
      const v = e.target.value;
      c.barometer = v === "" ? undefined : Number(v);
    } else if (role === "temperature") {
      const v = e.target.value;
      c.temperature = v === "" ? undefined : Number(v);
    } else if (role === "waterTemperature") {
      const v = e.target.value;
      c.waterTemperature = v === "" ? undefined : Number(v);
    } else if (role === "waterDepth") {
      const v = e.target.value;
      c.waterDepth = v === "" ? undefined : Number(v);
    } else if (role === "windSpeed") {
      const v = e.target.value;
      c.windSpeed = v === "" ? undefined : Math.round(Number(v));
    }
  });
});
