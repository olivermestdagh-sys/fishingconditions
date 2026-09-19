// gpx-import.js
// GPX import for the Sync page: parsing waypoints and tracks, and working out fishing segments and spots from a track (dwell detection and boundary editing).
// One of the shared scripts split out of the old charts.js. All of them share one global scope; each page loads
// only the ones it needs, in this order (checked by scripts/check-page-scripts.mjs).

/**
 * Parses a GPX file's <wpt> waypoints into plain {lat, lon, name, desc, sym, time}
 * objects, using the browser's own built-in DOMParser rather than a
 * third-party XML/GPX library — GPX is just XML, and this only ever needs
 * <wpt> plus five of its child tags, not the full GPX spec (routes, tracks,
 * extensions, etc., all ignored). Returns [] (not an exception) for
 * anything that fails to parse, since a malformed or empty file should mean
 * "nothing to show", not a page-breaking error.
 *
 * Was unused after the one-off marks.json migration (a script, not this
 * browser code) — reused again by the Sync tab (sync.js) for importing a
 * fresh Garmin export. `time` was added for that: the old migration never
 * needed a per-point timestamp (see MARKS_FILE_PATH's schema comment on why
 * gpx-import marks' dateTime is "most recent catch", not exact), but a live
 * import genuinely wants the device's own per-waypoint timestamp.
 */
function parseGpxWaypoints(gpxText) {
  try {
    const doc = new DOMParser().parseFromString(gpxText, "application/xml");
    if (doc.querySelector("parsererror")) return [];
    const waypoints = [];
    for (const wpt of doc.querySelectorAll("wpt")) {
      const lat = parseFloat(wpt.getAttribute("lat"));
      const lon = parseFloat(wpt.getAttribute("lon"));
      if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
      waypoints.push({
        lat,
        lon,
        name: wpt.querySelector("name")?.textContent || "",
        desc: wpt.querySelector("desc")?.textContent || "",
        sym: wpt.querySelector("sym")?.textContent || "",
        time: wpt.querySelector("time")?.textContent || "",
      });
    }
    return waypoints;
  } catch (err) {
    console.error("Could not parse GPX:", err);
    return [];
  }
}

/**
 * Parses a GPX file's <trk> tracks (Lowrance trail export — see
 * sync.js's own top-of-file comment on why trails come from GPX
 * specifically, never the .usr export marks import already uses) into
 * plain {name, points: [{lat, lon, timeMs, timeNaive}]} objects. One
 * track's own <trkseg> boundaries are NOT treated as meaningful — real
 * Lowrance exports don't reliably split segments at real trip
 * boundaries (confirmed directly: one real export had 5 <trk> elements
 * covering 53 distinct calendar days between them) — every <trkpt>
 * across every <trkseg> in a <trk> is flattened into one ordered list;
 * deriveTrackDayGroups below is what actually splits this into
 * meaningful outings.
 *
 * `timeMs` is a real Unix instant (used for gap/duration math);
 * `timeNaive` is the site's own "YYYY-MM-DD HH:MM:SS" convention,
 * read directly off the string's own digits (GPX times are always
 * "Z"-suffixed UTC, and this site's naive convention already treats
 * digits as local wall-clock — no timezone math either way, same as
 * every other naive-time conversion on this site).
 *
 * Silently drops any point with an unparseable time, OR the specific
 * garbage placeholder Lowrance emits when a fix briefly had no real
 * clock time (`1970-01-01T00:00:01Z` — confirmed directly: about 0.6%
 * of points in a real export carry exactly this value) — a track point
 * with no trustworthy time is useless for every downstream calculation
 * here (gap-splitting, dwell detection, duration), so there's no
 * reasonable partial use for it, unlike a merely-missing name/desc on a
 * waypoint elsewhere in this file.
 */
function parseGpxTracks(gpxText) {
  try {
    const doc = new DOMParser().parseFromString(gpxText, "application/xml");
    if (doc.querySelector("parsererror")) return [];
    const tracks = [];
    for (const trk of doc.querySelectorAll("trk")) {
      const name = trk.querySelector("name")?.textContent || "Unnamed track";
      const points = [];
      for (const trkpt of trk.querySelectorAll("trkpt")) {
        const lat = parseFloat(trkpt.getAttribute("lat"));
        const lon = parseFloat(trkpt.getAttribute("lon"));
        const timeText = trkpt.querySelector("time")?.textContent || "";
        if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
        if (!timeText || timeText.startsWith("1970-01-01")) continue;
        const timeMs = Date.parse(timeText);
        if (Number.isNaN(timeMs)) continue;
        // Unlike this site's usual "naive" convention (digits already ARE
        // local wall-clock, no conversion — see the top-of-file naive-time
        // note), a Lowrance trail's own <time> is genuine UTC — confirmed
        // directly against real known local fishing times, which were
        // hours off if read the same way GPX waypoint marks already are.
        // Converted here, once, to the browser's OWN local timezone —
        // everything downstream (day-grouping by calendar day, gap
        // detection, every displayed label) then works consistently off
        // this correctly-localized naive string. timeMs itself stays a
        // real UTC epoch (used only for relative gap/duration math, which
        // is unaffected by timezone either way).
        const d = new Date(timeMs);
        const pad = (n) => String(n).padStart(2, "0");
        const timeNaive = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        points.push({ lat, lon, timeMs, timeNaive });
      }
      points.sort((a, b) => a.timeMs - b.timeMs);
      tracks.push({ name, points });
    }
    return tracks;
  } catch (err) {
    console.error("Could not parse GPX tracks:", err);
    return [];
  }
}

// Tuning constants for deriveTrackDayGroups/detectFishingSegments below —
// starting values, not finalized. Agreed up front (see README) that these
// need real calibration against actual trail data once this is live, not
// a one-shot guess to get exactly right before ever seeing real results.
const TRACK_DAY_GAP_MINUTES = 45; // a gap longer than this splits into a
                                   // new day-group even within the same
                                   // calendar day (two separate outings
                                   // on one date shouldn't merge into one)
const DWELL_RADIUS_METERS = 10; // was 100, then 5 (too tight — under-detected on a drifting kayak) — Oliver's own call to start
                                   // experimenting much tighter, after
                                   // seeing real detected segments look
                                   // too generous at 100m. Must stay within a
                                   // point's own position to count as
                                   // "dwelling" there — a drifting kayak
                                   // wanders, doesn't sit at one exact
                                   // coordinate, so this needs to be a
                                   // real radius, not point-equality
const DWELL_WINDOW_MINUTES = 15; // for at least this long, continuously,
                                   // to count as a genuine fishing stop
                                   // rather than a red light or a pause
                                   // to re-rig
const MIN_SEGMENT_MINUTES = 10; // a detected segment shorter than this
                                   // (either kind) gets folded into a
                                   // neighbour rather than standing alone
                                   // as its own noisy sliver

/**
 * Splits one track's flattened, time-sorted points into separate
 * "outings" — by calendar day, AND by any gap longer than
 * TRACK_DAY_GAP_MINUTES even within the same day (the unit being
 * switched off between two separate trips on the same date shouldn't
 * merge them into one). This is what actually defines "a track per
 * day" for the review UI — the GPX file's own <trk>/<trkseg>
 * boundaries don't reliably do this (see parseGpxTracks's own comment).
 */
function deriveTrackDayGroups(points) {
  if (points.length === 0) return [];
  const groups = [];
  let current = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const point = points[i];
    const gapMinutes = (point.timeMs - prev.timeMs) / 60000;
    const sameCalendarDay = point.timeNaive.slice(0, 10) === prev.timeNaive.slice(0, 10);
    if (gapMinutes > TRACK_DAY_GAP_MINUTES || !sameCalendarDay) {
      groups.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Classifies one day-group's points into alternating "fishing"
 * (stationary — likely actually fishing) and "transiting" (moving
 * between spots) segments, purely from position and time — no marks or
 * user input involved yet, this is just the automatic first pass
 * (fully overridable by hand afterward, per the design brief).
 *
 * For each point, looks forward across a DWELL_WINDOW_MINUTES window
 * and checks whether every point in that window stays within
 * DWELL_RADIUS_METERS of it — if so, this point counts as "dwelling".
 * Consecutive same-classification points become one segment; segments
 * shorter than MIN_SEGMENT_MINUTES get folded into a neighbour, and
 * folding can leave two same-kind segments directly touching (their
 * shared boundary was the thing just folded away) — those get merged
 * into each other too, rather than reported as artificially split
 * (confirmed directly against a real 4.5-hour trail: without this
 * second merge pass, one continuous ~67-minute fishing stop was
 * reported as two separate ones split at an arbitrary one-second
 * boundary).
 *
 * Returns [] for a group with fewer than 2 points (a lone GPS fix isn't
 * a segment of anything) — this also quietly handles the real,
 * confirmed data quirk of a day-group where every point shares the
 * exact same timestamp (a logging glitch, not a real multi-point
 * stop): zero time span means the dwell-window check never finds a
 * window wide enough to judge, so the group falls out as one plain
 * "transiting" segment rather than crashing on a division by zero.
 */
function detectFishingSegments(points) {
  if (points.length < 2) return [];
  const n = points.length;
  const isDwelling = new Array(n).fill(false);

  let windowEnd = 0;
  for (let i = 0; i < n; i++) {
    if (windowEnd < i) windowEnd = i;
    while (windowEnd < n && (points[windowEnd].timeMs - points[i].timeMs) / 60000 < DWELL_WINDOW_MINUTES) {
      windowEnd++;
    }
    const window = points.slice(i, windowEnd);
    if (window.length < 2) continue;
    const spanMinutes = (window[window.length - 1].timeMs - window[0].timeMs) / 60000;
    if (spanMinutes < DWELL_WINDOW_MINUTES * 0.8) continue; // window ran off the end of the group before reaching full length — not enough evidence either way
    const maxDist = Math.max(...window.map((p) => distanceMetersBetween(points[i].lat, points[i].lon, p.lat, p.lon)));
    if (maxDist <= DWELL_RADIUS_METERS) isDwelling[i] = true;
  }

  const rawSegments = [];
  let start = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || isDwelling[i] !== isDwelling[start]) {
      rawSegments.push({ kind: isDwelling[start] ? "fishing" : "transiting", startIdx: start, endIdx: i - 1 });
      start = i;
    }
  }

  const folded = [];
  for (const seg of rawSegments) {
    const durationMinutes = (points[seg.endIdx].timeMs - points[seg.startIdx].timeMs) / 60000;
    if (folded.length > 0 && durationMinutes < MIN_SEGMENT_MINUTES) {
      folded[folded.length - 1].endIdx = seg.endIdx;
    } else {
      folded.push({ ...seg });
    }
  }

  const merged = [];
  for (const seg of folded) {
    if (merged.length > 0 && merged[merged.length - 1].kind === seg.kind) {
      merged[merged.length - 1].endIdx = seg.endIdx;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

// ---------------------------------------------------------------------
// Editing a Fishing segment's Start/End boundary in place (+/- on a
// candidate row, sync.js) and reshaping the segment structure around it
// as needed. Ported from a Python prototype verified against 40,000
// randomized edit sequences (500 seeds x 80 steps each), each one
// checked for full structural consistency after every single step —
// see technical-learnings.md for the two real bugs that prototype
// caught before this ever reached real code (a same-kind adjacency
// that could form silently without ever prompting, and a shrink
// blindly corrupting a DIFFERENT segment's own candidate).
// ---------------------------------------------------------------------

const CANDIDATE_STEP_MS = 60000; // ~1 minute per +/- click — confirmed
                                   // with Oliver directly: literally
                                   // "next raw point" would be far too
                                   // fine-grained where points are only
                                   // a second or two apart

/** The point index reached by walking ~CANDIDATE_STEP_MS of elapsed time
 * from points[fromIdx], in the given direction (+1 later, -1 earlier) —
 * clamped to the day's own first/last point rather than going out of
 * bounds. */
function stepTimeIndex(points, fromIdx, direction) {
  const fromMs = points[fromIdx].timeMs;
  let idx = fromIdx;
  while (true) {
    const next = idx + direction;
    if (next < 0) return 0;
    if (next >= points.length) return points.length - 1;
    idx = next;
    if (Math.abs(points[idx].timeMs - fromMs) >= CANDIDATE_STEP_MS) return idx;
  }
}

/** The exact label format used everywhere a segment's own boundaries
 * are known — shared here so every place that CHANGES startIdx/endIdx
 * (creating a new segment, or reshaping an existing one) can keep its
 * label in sync in one call, rather than each site reformatting this
 * by hand (or forgetting to, which is exactly how a newly-created
 * transiting segment ended up with a blank label — confirmed directly:
 * newTransitingSegment set label:"" and nothing ever filled it in). */
/** A fresh random hue for one new fishing segment — assigned once, at
 * creation (buildTrackData/convertSegmentKind, sync.js, or a boundary-
 * edit merge just below), and kept stable on the segment object from
 * then on, rather than re-randomized on every render (which would make
 * a segment's own colour flicker every time anything redraws). Lives
 * here (not sync.js) since a boundary-edit merge needs it too, and
 * charts.js loads first. Fixed saturation/lightness elsewhere
 * (segmentLineColor/segmentBackgroundTint, sync.js) — only the hue
 * varies, so every segment reads at the same visual "weight" regardless
 * of which random hue it landed on. */
function randomSegmentHue() {
  return Math.floor(Math.random() * 360);
}

function segmentLabel(kind, points, startIdx, endIdx) {
  const kindLabel = kind === "fishing" ? "Fishing" : "Transiting";
  return `${kindLabel} ${points[startIdx].timeNaive.slice(11, 16)}–${points[endIdx].timeNaive.slice(11, 16)}`;
}

function newTransitingSegment(points, startIdx, endIdx) {
  return {
    kind: "transiting",
    startIdx,
    endIdx,
    candidates: [],
    importChecked: false,
    viewChecked: true,
    expanded: false,
    label: segmentLabel("transiting", points, startIdx, endIdx),
  };
}

/**
 * Pure, non-mutating check for whether stepCandidateTime would actually
 * do anything if called right now, in this exact direction — mirrors
 * every one of its own blocking conditions (own paired candidate,
 * already at the day's own edge, and — for a growing move only — no
 * segment at all exists on that side to grow into) without touching
 * any state. Used purely to decide whether to even SHOW a +/- button
 * in the first place (renderTracksTree, sync.js) — a real, reported
 * bug: showing a button that always failed, then handling that failure
 * quietly, still left the tree in a confusing state after the click;
 * simplest fix is to never offer a click that can't do anything.
 */
function canStepCandidateTime(day, segIdx, candIdx, direction) {
  const seg = day.segments[segIdx];
  const cand = seg.candidates[candIdx];
  const isStart = cand.kind === "start";
  const front = isStart;
  const growing = (isStart && direction < 0) || (!isStart && direction > 0);

  const other = seg.candidates[1 - candIdx];
  const newIdx = stepTimeIndex(day.points, cand.pointIdx, direction);

  if (front && newIdx > other.pointIdx) return false;
  if (!front && newIdx < other.pointIdx) return false;
  if (newIdx === cand.pointIdx) return false;

  if (growing) {
    const neighbourIdx = front ? segIdx - 1 : segIdx + 1;
    if (neighbourIdx < 0 || neighbourIdx >= day.segments.length) return false;
  }
  return true;
}

/**
 * Moves one Start or End candidate later or earlier in time by
 * CANDIDATE_STEP_MS, reshaping the segment structure around it as
 * needed. Returns:
 *  - {ok: true} — applied directly, day.segments already updated.
 *  - {ok: false, reason} — blocked (own paired candidate, or genuinely
 *    nowhere left to go — see each reason inline).
 *  - {ok: "confirm", applyMerge, applyKeep} — this move would touch a
 *    same-kind segment; caller must ask the user and invoke exactly one
 *    of the two functions to actually apply anything.
 *
 * Every reshape keeps day.segments as an exact, gapless, non-overlapping
 * partition of day.points, keeps every "fishing" segment's own two
 * candidates' pointIdx in lockstep with its own startIdx/endIdx, AND
 * keeps every touched segment's own label in sync with its (possibly
 * new) boundaries — three invariants everything else (rendering, the
 * tree, saving) depends on.
 */
function stepCandidateTime(day, segIdx, candIdx, direction) {
  const segments = day.segments;
  const seg = segments[segIdx];
  const cand = seg.candidates[candIdx];
  const isStart = cand.kind === "start";
  const front = isStart;
  const growing = (isStart && direction < 0) || (!isStart && direction > 0);

  const other = seg.candidates[1 - candIdx];
  const newIdx = stepTimeIndex(day.points, cand.pointIdx, direction);

  if (front && newIdx > other.pointIdx) return { ok: false, reason: "own-end" };
  if (!front && newIdx < other.pointIdx) return { ok: false, reason: "own-start" };
  if (newIdx === cand.pointIdx) return { ok: false, reason: "no-change" };

  return growing ? growSegmentBoundary(day, segIdx, front, newIdx) : shrinkSegmentBoundary(day, segIdx, front, newIdx);
}

function shrinkSegmentBoundary(day, segIdx, front, newIdx) {
  const segments = day.segments;
  const seg = segments[segIdx];
  const points = day.points;
  if (front) {
    const givenEnd = newIdx - 1;
    const neighbourIdx = segIdx - 1;
    // A same-kind neighbour (reachable via a prior "keep separate"
    // choice, or a manual Transiting<->Fishing conversion) is never a
    // valid destination for reclaimed space — it has its own separately
    // tracked Start/End, and silently moving THOSE to absorb this
    // segment's giveaway would shift a different segment's own boundary
    // without ever asking. Reclaimed space always becomes (or extends)
    // a transiting buffer instead.
    if (neighbourIdx >= 0 && segments[neighbourIdx].kind === seg.kind) {
      segments.splice(neighbourIdx + 1, 0, newTransitingSegment(points, seg.startIdx, givenEnd));
    } else if (neighbourIdx >= 0) {
      segments[neighbourIdx].endIdx = givenEnd;
      segments[neighbourIdx].label = segmentLabel(segments[neighbourIdx].kind, points, segments[neighbourIdx].startIdx, givenEnd);
    } else {
      segments.unshift(newTransitingSegment(points, seg.startIdx, givenEnd));
    }
    seg.startIdx = newIdx;
    seg.candidates[0].pointIdx = newIdx;
  } else {
    const givenStart = newIdx + 1;
    const neighbourIdx = segIdx + 1;
    if (neighbourIdx < segments.length && segments[neighbourIdx].kind === seg.kind) {
      segments.splice(neighbourIdx, 0, newTransitingSegment(points, givenStart, seg.endIdx));
    } else if (neighbourIdx < segments.length) {
      segments[neighbourIdx].startIdx = givenStart;
      segments[neighbourIdx].label = segmentLabel(segments[neighbourIdx].kind, points, givenStart, segments[neighbourIdx].endIdx);
    } else {
      segments.push(newTransitingSegment(points, givenStart, seg.endIdx));
    }
    seg.endIdx = newIdx;
    seg.candidates[1].pointIdx = newIdx;
  }
  seg.label = segmentLabel(seg.kind, points, seg.startIdx, seg.endIdx);
  return { ok: true };
}

function growSegmentBoundary(day, segIdx, front, newIdx) {
  const segments = day.segments;
  const seg = segments[segIdx];
  const points = day.points;
  const neighbourIdx = front ? segIdx - 1 : segIdx + 1;
  if (neighbourIdx < 0 || neighbourIdx >= segments.length) return { ok: false, reason: "edge-of-day" };
  const neighbour = segments[neighbourIdx];

  if (neighbour.kind === seg.kind) {
    // Already directly touching a same-kind segment — nothing to
    // absorb first, so "keep separate" here is simply "don't move".
    return confirmBoundaryMerge(day, segIdx, front, null, neighbourIdx);
  }

  let clampedIdx, fullyConsumed;
  if (front) {
    clampedIdx = Math.max(newIdx, neighbour.startIdx);
    fullyConsumed = clampedIdx === neighbour.startIdx;
  } else {
    clampedIdx = Math.min(newIdx, neighbour.endIdx);
    fullyConsumed = clampedIdx === neighbour.endIdx;
  }

  if (fullyConsumed) {
    const beyondIdx = front ? neighbourIdx - 1 : neighbourIdx + 1;
    if (beyondIdx >= 0 && beyondIdx < segments.length && segments[beyondIdx].kind === seg.kind) {
      // Fully consuming `neighbour` (a different kind) would leave seg
      // directly touching a same-kind segment beyond it — ask BEFORE
      // doing that, not after, so the adjacency never forms unconfirmed
      // even momentarily.
      return confirmBoundaryMerge(day, segIdx, front, neighbourIdx, beyondIdx);
    }
    segments.splice(neighbourIdx, 1);
    if (front) {
      seg.startIdx = neighbour.startIdx;
      seg.candidates[0].pointIdx = neighbour.startIdx;
    } else {
      seg.endIdx = neighbour.endIdx;
      seg.candidates[1].pointIdx = neighbour.endIdx;
    }
  } else if (front) {
    neighbour.endIdx = clampedIdx - 1;
    neighbour.label = segmentLabel(neighbour.kind, points, neighbour.startIdx, neighbour.endIdx);
    seg.startIdx = clampedIdx;
    seg.candidates[0].pointIdx = clampedIdx;
  } else {
    neighbour.startIdx = clampedIdx + 1;
    neighbour.label = segmentLabel(neighbour.kind, points, neighbour.startIdx, neighbour.endIdx);
    seg.endIdx = clampedIdx;
    seg.candidates[1].pointIdx = clampedIdx;
  }
  seg.label = segmentLabel(seg.kind, points, seg.startIdx, seg.endIdx);
  return { ok: true };
}

/**
 * seg at segIdx is touching a same-kind segment at sameKindIdx, either
 * directly (absorbedIdx null) or after fully consuming a different-kind
 * buffer at absorbedIdx. Returns the two callbacks the caller (sync.js)
 * invokes based on the user's own choice — see each one's own comment
 * for exactly what "merge" vs "keep separate" does.
 */
function confirmBoundaryMerge(day, segIdx, front, absorbedIdx, sameKindIdx) {
  function applyMerge() {
    const segments = day.segments;
    const indices = absorbedIdx != null ? [segIdx, absorbedIdx, sameKindIdx] : [segIdx, sameKindIdx];
    const a = Math.min(...indices);
    const b = Math.max(...indices);
    const merged = {
      kind: segments[a].kind,
      startIdx: segments[a].startIdx,
      endIdx: segments[b].endIdx,
      candidates: [segments[a].candidates[0], segments[b].candidates[1]],
      importChecked: true,
      viewChecked: true,
      expanded: false,
      hue: randomSegmentHue(),
    };
    merged.candidates[0].pointIdx = merged.startIdx;
    merged.candidates[1].pointIdx = merged.endIdx;
    merged.label = segmentLabel(merged.kind, day.points, merged.startIdx, merged.endIdx);
    segments.splice(a, b - a + 1, merged);
    return merged;
  }
  // "Keep separate" still lets an absorbed different-kind buffer vanish
  // (that part of the move was never in question) but stops short of
  // merging the two same-kind segments — they stay separate, each
  // keeping their own full Start/End. With no absorbedIdx at all (seg
  // was already directly touching), there's nothing to give up short of
  // the same-kind boundary, so this is a true no-op.
  function applyKeep() {
    if (absorbedIdx == null) return null;
    const segments = day.segments;
    const neighbour = segments[absorbedIdx];
    segments.splice(absorbedIdx, 1);
    const realSegIdx = absorbedIdx < segIdx ? segIdx - 1 : segIdx;
    const seg = segments[realSegIdx];
    if (front) {
      seg.startIdx = neighbour.startIdx;
      seg.candidates[0].pointIdx = neighbour.startIdx;
    } else {
      seg.endIdx = neighbour.endIdx;
      seg.candidates[1].pointIdx = neighbour.endIdx;
    }
    seg.label = segmentLabel(seg.kind, day.points, seg.startIdx, seg.endIdx);
    return null;
  }
  return { ok: "confirm", applyMerge, applyKeep };
}
