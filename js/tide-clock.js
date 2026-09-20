// Tide clock (Reports tab): every session laid onto one tide cycle — hours since the last low tide —
// so effort (time spent fishing) and catches can be compared hour by hour of the tide.
// The pure logic is at the top (tested in tests/tide-clock.test.mjs); the loader that fetches
// the stored tide events is at the bottom.

const TIDE_CLOCK_BIN_H = 0.5; // width of one column, hours
const TIDE_CLOCK_BINS = 25; // 25 columns x 0.5h covers 0 to 12.5h, one full tide cycle (~12.4h)
const TIDE_CLOCK_SLICE_MS = 5 * 60000; // sessions are cut into slices this long to work out where in the tide they were
const TIDE_CLOCK_MAX_GAP_H = 14; // a "last low" older than this means the stored events have a hole, so the time is left out
const TIDE_CLOCK_MIN_EFFORT_H = 1; // a column with less effort than this shows no rate (one lucky fish in ten minutes isn't a trend)

/** Hours since the latest low tide at or before tMs, or null when the events don't cover tMs (no low before it, no event after it, or a hole in between). */
function tideClockHoursSinceLow(extrema, tMs) {
  if (!extrema || extrema.length === 0) return null;
  if (extrema[extrema.length - 1].t < tMs) return null;
  let lastLow = null;
  for (const e of extrema) {
    if (e.t > tMs) break;
    if (e.type === "low") lastLow = e;
  }
  if (!lastLow) return null;
  const hours = (tMs - lastLow.t) / 3600000;
  return hours > TIDE_CLOCK_MAX_GAP_H ? null : hours;
}

/** Which column (0..TIDE_CLOCK_BINS-1) an "hours since low" falls in; a rare long tide is folded into the last column. */
function tideClockBinFor(hours) {
  return Math.min(TIDE_CLOCK_BINS - 1, Math.floor(hours / TIDE_CLOCK_BIN_H));
}

/** Hours of fishing in each column for one session, or null if any part of the session lies outside the stored tide events. */
function tideClockSessionEffort(startMs, endMs, extrema) {
  const effort = new Array(TIDE_CLOCK_BINS).fill(0);
  for (let t = startMs; t < endMs; t += TIDE_CLOCK_SLICE_MS) {
    const sliceEnd = Math.min(endMs, t + TIDE_CLOCK_SLICE_MS);
    const h = tideClockHoursSinceLow(extrema, (t + sliceEnd) / 2);
    if (h === null) return null;
    effort[tideClockBinFor(h)] += (sliceEnd - t) / 3600000;
  }
  return effort;
}

/**
 * Add up every session onto the tide cycle. `sessions` are ribbonBuildSessions() results,
 * `extremaFor(session)` gives that session's tide events (or null), and `catchOk(catch)` says
 * whether a catch passes the report's filters. Returns { bins, used, skipped, catches } where each
 * bin is { effortH, catches, bySpecies, rate } (rate is catches per hour, null when effort is thin).
 */
function tideClockAggregate(sessions, extremaFor, catchOk) {
  const bins = Array.from({ length: TIDE_CLOCK_BINS }, () => ({ effortH: 0, catches: 0, bySpecies: {}, rate: null }));
  let used = 0;
  let skipped = 0;
  let catches = 0;
  for (const s of sessions) {
    const extrema = extremaFor(s);
    const effort = extrema ? tideClockSessionEffort(s.start, s.end, extrema) : null;
    if (!effort) {
      skipped++;
      continue;
    }
    used++;
    effort.forEach((h, i) => (bins[i].effortH += h));
    for (const c of s.catches) {
      if (catchOk && !catchOk(c)) continue;
      const h = tideClockHoursSinceLow(extrema, c._t);
      if (h === null) continue;
      const b = bins[tideClockBinFor(h)];
      const sp = c.species || "Unknown";
      b.catches++;
      b.bySpecies[sp] = (b.bySpecies[sp] || 0) + 1;
      catches++;
    }
  }
  for (const b of bins) b.rate = b.effortH >= TIDE_CLOCK_MIN_EFFORT_H ? b.catches / b.effortH : null;
  return { bins, used, skipped, catches };
}

/**
 * The stored tide events for each session, keyed by session groupId (null when the archive doesn't
 * cover it or no tracked location is nearby), added to `cache` as it goes. Stored events only — no
 * billed WillyWeather calls. A few sessions are fetched at a time.
 */
async function tideClockLoadExtrema(sessions, cache) {
  const todo = sessions.filter((s) => !cache.has(s.groupId));
  for (let i = 0; i < todo.length; i += 6) {
    await Promise.all(
      todo.slice(i, i + 6).map(async (s) => {
        let extrema = null;
        try {
          const location = typeof s.lat === "number" ? await findNearestTrackedLocation(s.lat, s.lng) : null;
          if (location) extrema = await fetchStoredTideExtrema(location, s.start, s.end);
        } catch (err) {
          console.error("Tide clock: could not load tide events:", err);
        }
        cache.set(s.groupId, extrema);
      })
    );
  }
}
