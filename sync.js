// sync.js — the Sync tab (sync.html): import fishing marks from a Garmin
// GPX or Lowrance .usr chartplotter export, review/edit the new ones before
// anything is saved, then commit accepted marks into D1. Also offers the
// reverse direction: export the current marks as a GPX file suitable for
// loading straight back onto either a Garmin or a Lowrance unit (Oliver's
// own Lowrance takes GPX directly — no need to write a real binary .usr
// file back out, which is a much heavier, riskier thing to get right
// without a real unit to test against).
//
// Lives as its own page script (like week.js/live.js/locationsadmin.js),
// reusing the shared plumbing already in charts.js: cachedIsAdmin/
// refreshAdminStatus for the Admin-session gate, MARKS_FILE_PATH/
// MARK_LISTS_FILE_PATH (now live D1 endpoints, not static files —
// see those constants' own comments), makeMarkId,
// nowAsNaiveString/parseNaive/previewEpochToNaiveString for the site's
// naive-timestamp convention, parseGpxWaypoints for GPX <wpt> parsing, and
// saveMarksBatchToD1 for the actual write.
//
// Gated behind cachedIsAdmin (refreshAdminStatus) the same way marks
// editing itself now is — see canSync() below. A file can still be PARSED
// without being signed in (nothing here needs a session for that), but
// there's no point showing a review screen for an import that can't be
// saved anywhere, so the whole workflow is hidden until signed in as
// Admin, same as Settings/marks editing elsewhere.

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

// --- Fishing Sessions (trail import) --------------------------------------
//
// A GPX file's <trk> data — parsed alongside marks whenever the uploaded
// file is GPX (never .usr; see parseGpxTracks's own comment, charts.js, for
// why trail data specifically comes from GPX only). Entirely separate
// state from `candidates` above — a session isn't a mark. Both now share
// ONE map and ONE side-panel column (see reviewMap/renderReviewMap below) —
// this is still the SAME "Import from a device export" flow, expanded, not
// a second one.
let trackData = []; // see buildTrackData's own comment for the exact shape
let selectedCandidateKey = null; // "trackIdx.dayIdx.segIdx.candIdx" of
                                  // whichever candidate point is currently
                                  // highlighted, in the tree AND on the map
                                  // — set from either side, read by both
let reviewMap = null; // the ONE Leaflet map instance shared by both marks
                      // candidates and track data (created once, on first
                      // file load — see renderReviewMap)
let reviewMapLayer = null; // a plain L.LayerGroup holding every polyline/
                          // marker currently drawn — cleared and fully
                          // redrawn on each render rather than patched
                          // incrementally, since a full redraw is simple
                          // and cheap at the point-count a REDUCED (line +
                          // candidate-marker only, not per-point marker)
                          // render actually needs
let sideGroupCollapsed = { marks: false, tracks: false }; // the two side-
                          // panel section headers (Marks / Trail data)

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
    // button should export whatever is REALLY in D1 right now, not a copy
    // that might be stale if marks were edited elsewhere (another tab,
    // another device) since this page loaded. Cache-busted for the same
    // reason loadAndRenderMarks is (charts.js) — the endpoint's own 60s
    // Cache-Control could otherwise serve a just-edited mark's old value.
    const res = await fetch(`${MARKS_FILE_PATH}?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Could not load marks (${res.status})`);
    const marks = await res.json(); // bare array — see handlePublicMarks, user-backend.js
    if (!Array.isArray(marks) || marks.length === 0) {
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

/**
 * A single compact row — checkbox, name, date only (per Oliver's own
 * call: the previous version put the ENTIRE mark-edit form inline, one
 * copy per row, which turned a review of a couple hundred candidates
 * into an extremely busy page). Clicking the row (not the checkbox)
 * opens the full edit form as a map popup instead — see
 * openCandidatePopup, which reuses buildMarkPopupEditHtml/
 * collectMarkFormValues (charts.js) directly rather than a second,
 * inline-specific copy of that form.
 */
function renderCandidateRow(c, i) {
  const visitBadge = c.visitCount > 1 ? `<span class="pill sync-pill-visits">${c.visitCount}×</span>` : "";
  return `
    <div class="candidate-row-compact" data-idx="${i}">
      <span class="tree-checkbox-col"><input type="checkbox" data-role="select" data-idx="${i}" ${c.selected ? "checked" : ""} /></span>
      <span data-role="open-candidate" data-idx="${i}" style="flex:1;">
        ${escapeHtml(c.name || "(unnamed)")} — ${escapeHtml((c.dateTime || "").slice(0, 16))}
      </span>
      ${visitBadge}
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

  container.querySelectorAll('input[data-role="select"]').forEach((el) => {
    el.addEventListener("change", (e) => {
      const idx = Number(e.currentTarget.dataset.idx);
      if (candidates[idx]) candidates[idx].selected = e.currentTarget.checked;
    });
  });
  container.querySelectorAll('[data-role="open-candidate"]').forEach((el) => {
    el.addEventListener("click", (e) => openCandidatePopup(Number(e.currentTarget.dataset.idx)));
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
 * Opens a candidate's full edit form as a Leaflet popup on the shared
 * reviewMap — the SAME buildMarkPopupEditHtml (charts.js) the main
 * marks map already uses, not a second hand-built form. Panned/centred
 * to the candidate's own coordinates so the popup has somewhere
 * sensible to anchor even though there's no permanent marker sitting
 * there under it (candidates aren't drawn as their own map markers —
 * there can be a couple hundred of them, and they're not spatially
 * interesting the way a trail is; the list IS their real home).
 *
 * Save writes the form's values back into candidates[idx] directly (via
 * collectMarkFormValues, charts.js) and closes the popup — nothing is
 * sent to the backend from here; that only happens later, for whatever
 * ends up checked, when "Import selected marks" is actually clicked.
 */
function openCandidatePopup(idx) {
  const c = candidates[idx];
  if (!c) return;
  if (!reviewMap) renderReviewMap(); // first candidate opened before any file-driven render — make sure the map exists
  const popup = L.popup({ maxWidth: 260, autoPanPadding: [20, 20], className: "mark-popup-leaflet" })
    .setLatLng([c.lat, c.lng])
    .setContent(buildMarkPopupEditHtml(c, markLists))
    .openOn(reviewMap);

  const popupEl = popup.getElement();
  applyMarkFieldVisibility(popupEl, c.type);
  const typeSelect = popupEl.querySelector("[data-mark-type-select]");
  if (typeSelect) typeSelect.addEventListener("change", () => applyMarkFieldVisibility(popupEl, typeSelect.value));

  popupEl.querySelector("[data-mark-save]").addEventListener("click", () => {
    const form = popupEl.querySelector("[data-mark-form]");
    const updated = collectMarkFormValues(form, c);
    Object.assign(c, updated);
    reviewMap.closePopup(popup);
    renderReviewList();
  });
  popupEl.querySelector("[data-mark-cancel]").addEventListener("click", () => reviewMap.closePopup(popup));
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
    if (applicable.includes("released") && c.released) mark.released = true;
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

  const result = await saveMarksBatchToD1(newMarks);
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

/**
 * Builds the full display tree from parseGpxTracks' output — Track ->
 * Day-group -> Segment -> (for a "fishing" segment only) Start/End
 * candidate points. Everything defaults to checked (both Import and
 * View) — there's no "already imported?" dedup against past Sessions
 * yet, since nothing about Sessions is actually SAVED anywhere yet (see
 * this feature's own phased build plan); once save/storage exists,
 * this default should change to "unchecked if this day looks like one
 * already saved", matching how marks import already behaves.
 *
 * Condition-change checkpoints (weather/tide/barometer shifting
 * mid-session) and linking a Catch mark into whichever segment its
 * timestamp falls within are BOTH deliberately not built yet either —
 * next phases, once this tree/map layer itself is confirmed working.
 */
function buildTrackData(gpxText) {
  const rawTracks = parseGpxTracks(gpxText);
  return rawTracks
    .map((track) => {
      const dayGroups = deriveTrackDayGroups(track.points).map((points) => {
        const segments = detectFishingSegments(points).map((seg) => {
          const startPoint = points[seg.startIdx];
          const endPoint = points[seg.endIdx];
          const timeLabel = `${startPoint.timeNaive.slice(11, 16)}–${endPoint.timeNaive.slice(11, 16)}`;
          const candidates =
            seg.kind === "fishing"
              ? [
                  { kind: "start", pointIdx: seg.startIdx, importChecked: true, viewChecked: true, baits: [], rigs: [], rods: [], berleys: [] },
                  { kind: "end", pointIdx: seg.endIdx, importChecked: true, viewChecked: true, baits: [], rigs: [], rods: [], berleys: [] },
                ]
              : [];
          return {
            kind: seg.kind,
            startIdx: seg.startIdx,
            endIdx: seg.endIdx,
            label: `${seg.kind === "fishing" ? "Fishing" : "Transiting"} ${timeLabel}`,
            importChecked: seg.kind === "fishing",
            viewChecked: true,
            expanded: false, // segments start collapsed too — a day with several stops shouldn't dump every one of their Start/End rows straight into view
            candidates,
          };
        });
        // Derived directly from the naive string's own digits (now the
        // browser's local calendar date — see parseGpxTracks's own
        // comment, charts.js) rather than re-parsing timeMs as a real
        // Date — timeMs is still a genuine UTC epoch, and formatting
        // THAT with any timezone other than "UTC" would silently
        // re-shift it a second time; simplest and correct is to just
        // read the digits already sitting in timeNaive.
        const [y, m, d] = points[0].timeNaive.slice(0, 10).split("-");
        const dayLabel = new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
        return { label: dayLabel, points, segments, importChecked: true, viewChecked: true, expanded: false };
      });
      return { name: track.name, dayGroups, importChecked: true, viewChecked: true, expanded: false };
    })
    .filter((t) => t.dayGroups.length > 0);
}

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

      // Trail data (Fishing Sessions) — GPX only, never .usr (see
      // parseGpxTracks's own comment, charts.js). Built alongside the
      // marks candidates above, entirely separate state — see trackData's
      // own comment for why. A file with no <trk> data at all (a pure
      // waypoints-only export) just leaves trackData empty; the Tracks
      // section stays hidden in that case (see the render call below).
      trackData = buildTrackData(text);
    }

    if (rawWaypoints.length === 0 && trackData.length === 0) {
      statusEl.textContent = "No waypoints or tracks found in that file.";
      return;
    }

    let candidateStatusPrefix = "";
    if (rawWaypoints.length > 0) {
      statusEl.textContent = `Parsed ${rawWaypoints.length} waypoints — matching against existing marks…`;
      const groups = collapseRawWaypoints(rawWaypoints);
      matchAgainstExisting(groups);

      candidates = groups.map((g, i) => ({
      key: `c${i}`,
      id: `c${i}`, // alias of key — buildMarkPopupEditHtml/collectMarkFormValues (charts.js) expect `id`, reused directly for the candidate edit popup rather than a second copy of that form
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
      released: undefined,
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
      candidateStatusPrefix = `${candidates.length} distinct spot${candidates.length === 1 ? "" : "s"} found from ${rawWaypoints.length} raw waypoints`;
    }

    // ONE combined section now covers both marks candidates and track data
    // — shown whenever EITHER has something in it (a trail-only export
    // with no waypoints at all is a completely normal thing to upload
    // here, and vice versa).
    document.getElementById("reviewSection").style.display = rawWaypoints.length > 0 || trackData.length > 0 ? "block" : "none";
    document.getElementById("marksGroupBody").style.display = sideGroupCollapsed.marks ? "none" : "block";
    document.getElementById("tracksGroupBody").style.display = sideGroupCollapsed.tracks ? "none" : "block";
    if (trackData.length > 0) {
      selectedCandidateKey = null;
      renderTracksTree();
    }
    if (rawWaypoints.length > 0 || trackData.length > 0) renderReviewMap();

    const totalDays = trackData.reduce((sum, t) => sum + t.dayGroups.length, 0);
    const trackStatusSuffix = trackData.length > 0 ? `${totalDays} track day${totalDays === 1 ? "" : "s"} found` : "";
    statusEl.textContent =
      "Done — " + [candidateStatusPrefix, trackStatusSuffix].filter(Boolean).join("; ") + ".";
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

// ---------------------------------------------------------------------------
// Fishing Sessions — tree panel + scoped map (Phase 2: display and
// selection only; point editing, condition-checkpoint auto-fill, catch-
// linking, and actually saving anything are all later phases — see this
// feature's own design brief).
// ---------------------------------------------------------------------------

/** A stable string key identifying one candidate point, used both as a
 * DOM data-attribute and as selectedCandidateKey's own value — so a
 * click on either the tree row or the map marker can find and highlight
 * the same candidate from the other side. */
function candidateKey(trackIdx, dayIdx, segIdx, candIdx) {
  return `${trackIdx}.${dayIdx}.${segIdx}.${candIdx}`;
}

/**
 * Every candidate in one day-group, in chronological order, regardless
 * of which segment it belongs to — segments are already produced in
 * time order (detectFishingSegments, charts.js) and each one's own
 * [start, end] pair is naturally ordered too, so flattening in place is
 * enough; no separate sort needed. This is what "carried forward"
 * (Bait/Rig/Rod/Berley) is actually relative to — one real fishing
 * trip's worth of gear choices, not the whole multi-day track.
 */
function flattenDayCandidates(day) {
  const flat = [];
  day.segments.forEach((seg, segIdx) => {
    seg.candidates.forEach((cand, candIdx) => flat.push({ segIdx, candIdx, cand }));
  });
  return flat;
}

/**
 * Applies a just-saved candidate's Bait/Rig/Rod/Berley to every
 * chronologically LATER candidate in the same day that doesn't already
 * have its own value for that field — matching the design brief's own
 * "carried forward to every point after, unless changed at a later
 * point" rule. Stops propagating a given field as soon as it reaches a
 * candidate that already has a non-empty value there, since that value
 * was set more recently (by definition — it's already there) and
 * shouldn't be silently overwritten by going back and editing an
 * earlier point.
 */
function propagateCarryForwardFields(day, fromSegIdx, fromCandIdx, savedCandidate) {
  const flat = flattenDayCandidates(day);
  const fromIndex = flat.findIndex((f) => f.segIdx === fromSegIdx && f.candIdx === fromCandIdx);
  if (fromIndex === -1) return;
  for (const field of ["baits", "rigs", "rods", "berleys"]) {
    const value = savedCandidate[field];
    if (!value || value.length === 0) continue;
    for (let i = fromIndex + 1; i < flat.length; i++) {
      const target = flat[i].cand;
      if (target[field] && target[field].length > 0) break; // already explicitly set further along — don't overwrite it
      target[field] = [...value];
    }
  }
}

/** Same idea as markListOptionsHtml (charts.js), but for a <select
 * multiple> — every known value for this list, marking any that are in
 * `currentValues` (an array) as selected, rather than a single value. */
function multiSelectOptionsHtml(markLists, listLabel, currentValues) {
  const values = markLists.filter((r) => r.field === listLabel).map((r) => r.value);
  for (const v of currentValues || []) {
    if (!values.includes(v)) values.push(v);
  }
  return values.map((v) => `<option value="${escapeHtml(v)}"${(currentValues || []).includes(v) ? " selected" : ""}>${escapeHtml(v)}</option>`).join("");
}

/**
 * The edit popup for a track candidate (Start/Stop fishing point) —
 * genuinely different fields from a mark's own popup: Kind (Start/Stop,
 * overridable — see the design brief's own wording), multi-select
 * Bait/Rig/Rod/Berley (carried forward — see propagateCarryForwardFields
 * above; marks only ever support ONE value per field, but one fishing
 * stop can genuinely involve trying several), and Weather/Tide/
 * Barometer/Temperature/Water Temp/Wind — auto-filled from the same
 * historical lookup a Catch mark already uses (see openTrackCandidatePopup),
 * shown editable here only so an auto-filled value can be corrected by
 * hand if it's ever wrong, not because it's meant to be set manually as
 * a matter of course.
 */
function buildTrackCandidatePopupHtml(candidate, point, markLists) {
  const weatherFieldsHtml = [
    { key: "weatherCondition", label: "Weather", list: "Weather Condition" },
    { key: "tideCondition", label: "Tide", list: "Tide Condition" },
  ]
    .map(
      (f) => `<label style="display:block;font-size:0.8rem;font-weight:600;margin:6px 0 2px;">${f.label}
        <select name="${f.key}" style="${MARK_POPUP_INPUT_STYLE}">${markListOptionsHtml(markLists, f.list, candidate[f.key])}</select>
      </label>`
    )
    .join("");
  const numericFieldsHtml = [
    { key: "barometer", label: "Barometer (hPa)", step: "0.1" },
    { key: "temperature", label: "Air Temp (°C)", step: "0.1" },
    { key: "waterTemperature", label: "Water Temp (°C)", step: "0.1" },
    { key: "windSpeed", label: "Wind Speed (km/h)", step: "1" },
  ]
    .map(
      (f) => `<label style="display:block;font-size:0.8rem;font-weight:600;margin:6px 0 2px;">${f.label}
        <input type="number" name="${f.key}" step="${f.step}" value="${candidate[f.key] != null ? candidate[f.key] : ""}" style="${MARK_POPUP_INPUT_STYLE}" />
      </label>`
    )
    .join("");

  return `
    <div data-candidate-popup style="min-width:230px;max-width:270px;">
      <form data-candidate-form onsubmit="return false;">
        <label style="display:block;font-size:0.8rem;font-weight:600;margin:0 0 2px;">Point time
          <input type="text" readonly value="${escapeHtml(point.timeNaive)}" style="${MARK_POPUP_INPUT_STYLE}background:var(--grey-100);color:var(--grey-500);" />
        </label>
        <label style="display:block;font-size:0.8rem;font-weight:600;margin:6px 0 2px;">This point is
          <select name="kind" style="${MARK_POPUP_INPUT_STYLE}">
            <option value="start"${candidate.kind === "start" ? " selected" : ""}>Start fishing</option>
            <option value="end"${candidate.kind === "end" ? " selected" : ""}>Stop fishing</option>
          </select>
        </label>
        <label style="display:block;font-size:0.8rem;font-weight:600;margin:6px 0 2px;">Bait (carries forward until changed)
          <select name="baits" multiple size="3" style="${MARK_POPUP_INPUT_STYLE}">${multiSelectOptionsHtml(markLists, "Bait", candidate.baits)}</select>
        </label>
        <label style="display:block;font-size:0.8rem;font-weight:600;margin:6px 0 2px;">Rig (carries forward)
          <select name="rigs" multiple size="3" style="${MARK_POPUP_INPUT_STYLE}">${multiSelectOptionsHtml(markLists, "Rig", candidate.rigs)}</select>
        </label>
        <label style="display:block;font-size:0.8rem;font-weight:600;margin:6px 0 2px;">Rod (carries forward)
          <select name="rods" multiple size="3" style="${MARK_POPUP_INPUT_STYLE}">${multiSelectOptionsHtml(markLists, "Rod", candidate.rods)}</select>
        </label>
        <label style="display:block;font-size:0.8rem;font-weight:600;margin:6px 0 2px;">Berley (carries forward)
          <select name="berleys" multiple size="3" style="${MARK_POPUP_INPUT_STYLE}">${multiSelectOptionsHtml(markLists, "Berley", candidate.berleys)}</select>
        </label>
        <div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--grey-200);">
          <div class="footnote" style="margin:0 0 4px;">Auto-filled — correct by hand if needed</div>
          ${weatherFieldsHtml}
          ${numericFieldsHtml}
        </div>
      </form>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button type="button" class="btn-primary" data-candidate-save style="padding:4px 10px;font-size:0.85rem;">Save</button>
        <button type="button" class="btn-secondary" data-candidate-cancel style="padding:4px 10px;font-size:0.85rem;">Cancel</button>
      </div>
      <div data-candidate-save-status style="margin-top:6px;font-size:0.8rem;"></div>
    </div>
  `;
}

/**
 * Opens a track candidate's edit popup on the shared reviewMap, at its
 * own point's coordinates. Fires the same historical-lookup
 * (lookupHistoricalMarkConditions, charts.js) a Catch mark already gets,
 * but only the FIRST time this exact candidate is opened (its own
 * `historicalLookupDone` flag) — re-opening an already-looked-up
 * candidate shouldn't spend another billed WillyWeather call.
 */
async function openTrackCandidatePopup(trackIdx, dayIdx, segIdx, candIdx) {
  const day = trackData[trackIdx].dayGroups[dayIdx];
  const seg = day.segments[segIdx];
  const candidate = seg.candidates[candIdx];
  const point = day.points[candidate.pointIdx];

  if (!candidate.historicalLookupDone) {
    candidate.historicalLookupDone = true; // set before the await — never fire twice even if a user double-opens while the first lookup is still in flight
    try {
      const result = await lookupHistoricalMarkConditions(point.lat, point.lon, point.timeNaive);
      Object.assign(candidate, result);
    } catch (err) {
      console.error("Historical lookup failed for a track candidate:", err);
    }
  }

  if (!reviewMap) renderReviewMap();
  const popup = L.popup({ maxWidth: 260, autoPanPadding: [20, 20], className: "mark-popup-leaflet" })
    .setLatLng([point.lat, point.lon])
    .setContent(buildTrackCandidatePopupHtml(candidate, point, markLists))
    .openOn(reviewMap);

  const popupEl = popup.getElement();
  popupEl.querySelector("[data-candidate-save]").addEventListener("click", () => {
    const form = popupEl.querySelector("[data-candidate-form]");
    const val = (name) => form.querySelector(`[name="${name}"]`).value;
    const multiVal = (name) => Array.from(form.querySelectorAll(`[name="${name}"] option:checked`)).map((o) => o.value);

    candidate.kind = val("kind");
    candidate.baits = multiVal("baits");
    candidate.rigs = multiVal("rigs");
    candidate.rods = multiVal("rods");
    candidate.berleys = multiVal("berleys");
    for (const key of ["weatherCondition", "tideCondition"]) {
      candidate[key] = val(key) || undefined;
    }
    for (const key of ["barometer", "temperature", "waterTemperature", "windSpeed"]) {
      const raw = val(key);
      candidate[key] = raw === "" ? undefined : Number(raw);
    }

    propagateCarryForwardFields(day, segIdx, candIdx, candidate);
    reviewMap.closePopup(popup);
    renderTracksTree();
  });
  popupEl.querySelector("[data-candidate-cancel]").addEventListener("click", () => reviewMap.closePopup(popup));
}

/** Cascades a new checked value down to every descendant of a tree node —
 * ticking/unticking a Track, Day, or Segment row applies the same value
 * to everything nested under it, rather than leaving children stranded
 * at whatever they were previously set to. */
function cascadeChecked(node, field, value) {
  node[field] = value;
  if (node.dayGroups) node.dayGroups.forEach((d) => cascadeChecked(d, field, value));
  if (node.segments) node.segments.forEach((s) => cascadeChecked(s, field, value));
  if (node.candidates) node.candidates.forEach((c) => (c[field] = value));
}

/**
 * Tri-state summary of a node's own children for one field — "checked"/
 * "unchecked" when every child agrees, "indeterminate" when they don't.
 * A leaf node (a candidate, or a transiting segment with no candidates)
 * has no children to summarise — callers should read its own stored
 * boolean directly instead of calling this.
 *
 * For the "importChecked" field specifically, a transiting segment is
 * excluded from the aggregate entirely (not just treated as
 * "unchecked") — it has nothing importable at all (no candidates, no
 * checkbox even shown any more — see renderTracksTree), so it
 * shouldn't be able to drag an otherwise-fully-checked day down to
 * "indeterminate" just by existing. Safe to apply this filter
 * unconditionally: day-groups and candidates never have kind ===
 * "transiting" (only segments do), so this only ever actually removes
 * anything from a list of segments.
 */
function summariseChecked(children, field) {
  const relevant = field === "importChecked" ? children.filter((c) => c.kind !== "transiting") : children;
  if (relevant.length === 0) return "unchecked";
  const values = relevant.map((c) => childCheckedState(c, field));
  if (values.every((v) => v === "checked")) return "checked";
  if (values.every((v) => v === "unchecked")) return "unchecked";
  return "indeterminate";
}
function childCheckedState(node, field) {
  if (node.dayGroups) return summariseChecked(node.dayGroups, field);
  if (node.segments) return summariseChecked(node.segments, field);
  if (node.candidates && node.candidates.length > 0) return summariseChecked(node.candidates, field);
  return node[field] ? "checked" : "unchecked";
}

function applyTriState(checkboxEl, state) {
  checkboxEl.checked = state === "checked";
  checkboxEl.indeterminate = state === "indeterminate";
}

function renderTracksTree() {
  const container = document.getElementById("tracksTree");
  if (!container) return;

  let html = "";
  trackData.forEach((track, trackIdx) => {
    const trackCaret = `<span class="caret${track.expanded ? "" : " collapsed"}">▾</span>`;
    html += `<div class="tracks-tree-node" data-level="track" data-track="${trackIdx}" data-role="toggle-expand">
      <span class="tree-checkbox-col"><input type="checkbox" data-role="import" data-track="${trackIdx}" /></span>
      <span class="tree-checkbox-col"><input type="checkbox" data-role="view" data-track="${trackIdx}" /></span>
      <span class="tree-node-label">${trackCaret}<span>${escapeHtml(track.name)}</span></span>
    </div>`;
    if (!track.expanded) return;
    track.dayGroups.forEach((day, dayIdx) => {
      const dayCaret = `<span class="caret${day.expanded ? "" : " collapsed"}">▾</span>`;
      html += `<div class="tracks-tree-node" data-level="day" data-track="${trackIdx}" data-day="${dayIdx}" data-role="toggle-expand">
        <span class="tree-checkbox-col"><input type="checkbox" data-role="import" data-track="${trackIdx}" data-day="${dayIdx}" /></span>
        <span class="tree-checkbox-col"><input type="checkbox" data-role="view" data-track="${trackIdx}" data-day="${dayIdx}" /></span>
        <span class="tree-node-label" style="padding-left:14px;">${dayCaret}<span>${escapeHtml(day.label)}</span></span>
      </div>`;
      if (!day.expanded) return;
      day.segments.forEach((seg, segIdx) => {
        const segCaret = seg.candidates.length > 0 ? `<span class="caret${seg.expanded ? "" : " collapsed"}">▾</span>` : `<span class="caret" style="visibility:hidden;">▾</span>`;
        // A transiting segment has no candidates — nothing to import — so
        // its Import column stays genuinely empty (not just unchecked)
        // rather than offering a checkbox that can never do anything.
        const segImportCol = seg.kind === "transiting" ? `<span class="tree-checkbox-col"></span>` : `<span class="tree-checkbox-col"><input type="checkbox" data-role="import" data-track="${trackIdx}" data-day="${dayIdx}" data-seg="${segIdx}" /></span>`;
        html += `<div class="tracks-tree-node" data-level="segment" data-track="${trackIdx}" data-day="${dayIdx}" data-seg="${segIdx}" data-role="toggle-expand">
          ${segImportCol}
          <span class="tree-checkbox-col"><input type="checkbox" data-role="view" data-track="${trackIdx}" data-day="${dayIdx}" data-seg="${segIdx}" /></span>
          <span class="tree-node-label" style="padding-left:28px;">${segCaret}<span>${escapeHtml(seg.label)}</span></span>
        </div>`;
        if (!seg.expanded) return;
        seg.candidates.forEach((cand, candIdx) => {
          const key = candidateKey(trackIdx, dayIdx, segIdx, candIdx);
          const isSelected = key === selectedCandidateKey;
          const candLabel = `${cand.kind === "start" ? "Start" : "End"} ${day.points[cand.pointIdx].timeNaive.slice(11, 16)}`;
          html += `<div class="tracks-tree-node${isSelected ? " tracks-tree-node-selected" : ""}" data-level="candidate" data-track="${trackIdx}" data-day="${dayIdx}" data-seg="${segIdx}" data-cand="${candIdx}">
            <span class="tree-checkbox-col"><input type="checkbox" data-role="import" data-track="${trackIdx}" data-day="${dayIdx}" data-seg="${segIdx}" data-cand="${candIdx}" /></span>
            <span class="tree-checkbox-col"><input type="checkbox" data-role="view" data-track="${trackIdx}" data-day="${dayIdx}" data-seg="${segIdx}" data-cand="${candIdx}" /></span>
            <span class="tree-node-label" style="padding-left:42px;"><span class="caret" style="visibility:hidden;">▾</span><span data-role="select-candidate">${candLabel}</span></span>
          </div>`;
        });
      });
    });
  });
  container.innerHTML = html;

  // Apply each visible row's own checked/indeterminate display — done as
  // a second pass, after the HTML is in the DOM, since indeterminate isn't
  // settable via a plain HTML attribute, only the live DOM property. Only
  // ever queries for rows that are ACTUALLY in the DOM right now (a
  // collapsed parent's children were never rendered above) — querySelector
  // returning null for a currently-hidden node is expected, not an error.
  trackData.forEach((track, trackIdx) => {
    setRowCheckboxes(container, `[data-track="${trackIdx}"][data-level="track"]`, track);
    track.dayGroups.forEach((day, dayIdx) => {
      setRowCheckboxes(container, `[data-track="${trackIdx}"][data-day="${dayIdx}"][data-level="day"]`, day);
      day.segments.forEach((seg, segIdx) => {
        setRowCheckboxes(container, `[data-track="${trackIdx}"][data-day="${dayIdx}"][data-seg="${segIdx}"][data-level="segment"]`, seg);
        seg.candidates.forEach((cand, candIdx) => {
          setRowCheckboxes(container, `[data-track="${trackIdx}"][data-day="${dayIdx}"][data-seg="${segIdx}"][data-cand="${candIdx}"][data-level="candidate"]`, cand);
        });
      });
    });
  });

  container.querySelectorAll('input[data-role="import"]').forEach((el) => el.addEventListener("change", onTreeCheckboxChange));
  container.querySelectorAll('input[data-role="view"]').forEach((el) => el.addEventListener("change", onTreeCheckboxChange));
  container.querySelectorAll('[data-role="toggle-expand"]').forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.matches('input[type="checkbox"]')) return; // clicking a checkbox shouldn't ALSO toggle expand/collapse
      const { track, day, seg } = e.currentTarget.dataset;
      let node = trackData[Number(track)];
      if (day !== undefined) node = node.dayGroups[Number(day)];
      if (seg !== undefined) {
        node = node.segments[Number(seg)];
        if (node.candidates.length === 0) return; // a transiting segment has nothing to expand into
      }
      node.expanded = !node.expanded;
      renderTracksTree();
    });
  });
  container.querySelectorAll('[data-role="select-candidate"]').forEach((el) => {
    el.addEventListener("click", (e) => {
      const row = e.currentTarget.closest(".tracks-tree-node");
      const { track, day, seg, cand } = row.dataset;
      selectedCandidateKey = candidateKey(track, day, seg, cand);
      renderTracksTree();
      renderReviewMap();
      openTrackCandidatePopup(Number(track), Number(day), Number(seg), Number(cand));
    });
  });

  const countEl = document.getElementById("marksGroupCount");
  if (countEl) countEl.textContent = String(reviewableCandidates().length);
}

function setRowCheckboxes(container, selector, node) {
  const row = container.querySelector(selector);
  if (!row) return;
  const importBox = row.querySelector('input[data-role="import"]'); // null for a transiting segment — its Import column is deliberately empty, nothing to import there
  const viewBox = row.querySelector('input[data-role="view"]');
  const isLeaf = !node.dayGroups && !node.segments && !(node.candidates && node.candidates.length > 0);
  if (isLeaf) {
    if (importBox) importBox.checked = !!node.importChecked;
    if (viewBox) viewBox.checked = !!node.viewChecked;
  } else {
    if (importBox) applyTriState(importBox, childCheckedState(node, "importChecked"));
    if (viewBox) applyTriState(viewBox, childCheckedState(node, "viewChecked"));
  }
}

function onTreeCheckboxChange(e) {
  const el = e.currentTarget;
  const field = el.dataset.role === "import" ? "importChecked" : "viewChecked";
  const { track, day, seg, cand } = el.dataset;
  let node = trackData[Number(track)];
  if (day !== undefined) node = node.dayGroups[Number(day)];
  if (seg !== undefined) node = node.segments[Number(seg)];
  if (cand !== undefined) node = node.candidates[Number(cand)];
  cascadeChecked(node, field, el.checked);
  renderTracksTree();
  renderReviewMap();
}

const SEGMENT_COLORS = { fishing: "#d97706", transiting: "#6b7280" }; // amber for likely-fishing stretches, grey for travel — deliberately distinct from any mark colour on the shared map, since this is a different kind of thing being shown

/**
 * The ONE shared map for this whole review page — track segments (as
 * polylines) and candidate points, both drawn here; marks candidates
 * don't get their own permanent markers (there can be a couple hundred
 * of them, and the list is their real home — see openCandidatePopup),
 * but a mark's edit popup still opens ON this same map, at its own
 * coordinates, when a candidate row is clicked.
 */
function renderReviewMap() {
  const mapEl = document.getElementById("reviewMap");
  if (!mapEl) return;

  if (!reviewMap) {
    reviewMap = L.map("reviewMap");
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors" }).addTo(reviewMap);
    reviewMapLayer = L.layerGroup().addTo(reviewMap);
  }

  reviewMapLayer.clearLayers();
  const allShownLatLngs = [];

  trackData.forEach((track, trackIdx) => {
    track.dayGroups.forEach((day, dayIdx) => {
      day.segments.forEach((seg, segIdx) => {
        if (!seg.viewChecked) return;
        const segPoints = day.points.slice(seg.startIdx, seg.endIdx + 1);
        const latLngs = segPoints.map((p) => [p.lat, p.lon]);
        if (latLngs.length >= 2) {
          L.polyline(latLngs, { color: SEGMENT_COLORS[seg.kind], weight: 3 }).addTo(reviewMapLayer);
          allShownLatLngs.push(...latLngs);
        }
        seg.candidates.forEach((cand, candIdx) => {
          if (!cand.viewChecked) return;
          const point = day.points[cand.pointIdx];
          const key = candidateKey(trackIdx, dayIdx, segIdx, candIdx);
          const isSelected = key === selectedCandidateKey;
          const marker = L.circleMarker([point.lat, point.lon], {
            radius: isSelected ? 9 : 6,
            color: "#fff",
            weight: 2,
            fillColor: cand.kind === "start" ? "#16a34a" : "#dc2626",
            fillOpacity: 1,
          }).addTo(reviewMapLayer);
          marker.bindTooltip(`${cand.kind === "start" ? "Start" : "End"} — ${point.timeNaive}`);
          marker.on("click", () => {
            selectedCandidateKey = key;
            renderTracksTree();
            renderReviewMap();
            openTrackCandidatePopup(trackIdx, dayIdx, segIdx, candIdx);
          });
          allShownLatLngs.push([point.lat, point.lon]);
        });
      });
    });
  });

  if (allShownLatLngs.length > 0) {
    reviewMap.fitBounds(allShownLatLngs, { padding: [20, 20] });
  } else {
    reviewMap.setView([-38.1, 145.1], 9); // Port Phillip/Western Port default — nothing to show yet
  }
}

function canSync() {
  return cachedIsAdmin;
}

document.addEventListener("DOMContentLoaded", async () => {
  const gateEl = document.getElementById("syncNotConnected");
  const mainEl = document.getElementById("syncMain");
  await refreshAdminStatus();
  if (!canSync()) {
    gateEl.style.display = "block";
    mainEl.style.display = "none";
    return;
  }
  gateEl.style.display = "none";
  mainEl.style.display = "block";

  // Loaded once, up front — needed both for matching (existingMarks) and
  // for the review row's Species dropdown options (markLists). Cache-busted
  // like every other data fetch on this site — see loadAndRenderMarks,
  // charts.js — the endpoints' own 60s Cache-Control could otherwise serve
  // a just-edited value.
  // Wrapped in try/catch (unlike before) — these are now genuine cross-
  // origin calls to the Worker rather than same-origin static files, so a
  // real network failure (not just a non-2xx response) is a realistic
  // possibility worth degrading gracefully from, same as
  // loadAndRenderMarks's own try/catch (charts.js) already does for the
  // identical fetch pair.
  let existingMarksRes = { ok: false };
  let listsRes = { ok: false };
  try {
    [existingMarksRes, listsRes] = await Promise.all([
      fetch(`${MARKS_FILE_PATH}?_=${Date.now()}`, { cache: "no-store" }),
      fetch(`${MARK_LISTS_FILE_PATH}?_=${Date.now()}`, { cache: "no-store" }),
    ]);
  } catch (err) {
    console.error("Could not reach the marks/mark-lists endpoints:", err);
  }
  existingMarks = existingMarksRes.ok ? await existingMarksRes.json() : []; // bare array now — see handlePublicMarks, user-backend.js
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

  document.querySelectorAll('[data-role="toggle-group"]').forEach((el) => {
    el.addEventListener("click", () => {
      const group = el.dataset.group;
      sideGroupCollapsed[group] = !sideGroupCollapsed[group];
      el.classList.toggle("collapsed", sideGroupCollapsed[group]);
      const bodyId = group === "marks" ? "marksGroupBody" : "tracksGroupBody";
      document.getElementById(bodyId).style.display = sideGroupCollapsed[group] ? "none" : "block";
    });
  });
});
