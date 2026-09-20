// Tide clock (Reports tab): every session laid onto one full tide cycle — hours since the lower low
// water (LLW) — so effort (time spent fishing) and catches can be compared segment by segment of the
// mixed semidiurnal tide (LLW, then a high, a low, and a second high, then the next LLW ~24.8h later).
// The pure logic is at the top (tested in tests/tide-clock.test.mjs); the loader that fetches
// the stored tide events is at the bottom.

const TIDE_CLOCK_BIN_H = 0.5; // width of one column, hours
const TIDE_CLOCK_BINS = 50; // 50 columns x 0.5h covers 0 to 25h, a full LLW-to-LLW cycle (~24.8h)
const TIDE_CLOCK_SLICE_MS = 5 * 60000; // sessions are cut into slices this long to work out where in the tide they were
const TIDE_CLOCK_MAX_GAP_H = 27; // a "last LLW" older than this means the stored events have a hole, so the time is left out
const TIDE_CLOCK_MIN_EFFORT_H = 1; // a column with less effort than this shows no rate (one lucky fish in ten minutes isn't a trend)

/** Hours since the latest LLW (the lower of the day's two lows) at or before tMs, or null when the events don't cover tMs (no LLW before it, no event after it, or a hole in between). */
function tideClockHoursSinceLLW(extrema, tMs) {
  if (!extrema || extrema.length === 0) return null;
  if (extrema[extrema.length - 1].t < tMs) return null;
  let lastLLW = null;
  for (const e of extrema) {
    if (e.t > tMs) break;
    if (e.type === "low" && rankExtremum(extrema, e) === "LLW") lastLLW = e;
  }
  if (!lastLLW) return null;
  const hours = (tMs - lastLLW.t) / 3600000;
  return hours > TIDE_CLOCK_MAX_GAP_H ? null : hours;
}

/** Which column (0..TIDE_CLOCK_BINS-1) an "hours since LLW" falls in; a rare long cycle is folded into the last column. */
function tideClockBinFor(hours) {
  return Math.min(TIDE_CLOCK_BINS - 1, Math.floor(hours / TIDE_CLOCK_BIN_H));
}

/** Hours of fishing in each column for one session, or null if any part of the session lies outside the stored tide events. */
function tideClockSessionEffort(startMs, endMs, extrema) {
  const effort = new Array(TIDE_CLOCK_BINS).fill(0);
  for (let t = startMs; t < endMs; t += TIDE_CLOCK_SLICE_MS) {
    const sliceEnd = Math.min(endMs, t + TIDE_CLOCK_SLICE_MS);
    const h = tideClockHoursSinceLLW(extrema, (t + sliceEnd) / 2);
    if (h === null) return null;
    effort[tideClockBinFor(h)] += (sliceEnd - t) / 3600000;
  }
  return effort;
}

/**
 * The complete LLW-to-LLW cycles in a tide event list: an LLW, then a high, a low and a high, then the
 * next LLW. Each is { t0, points } with points = [{ h (hours since this LLW), height, type }] for those
 * five events. A cycle with a missing or oddly ranked event is left out.
 */
function tideClockCycles(extrema) {
  const cycles = [];
  for (let i = 0; i + 4 < extrema.length; i++) {
    const seq = extrema.slice(i, i + 5);
    if (seq.map((e) => e.type).join() !== "low,high,low,high,low") continue;
    if (rankExtremum(extrema, seq[0]) !== "LLW" || rankExtremum(extrema, seq[4]) !== "LLW") continue;
    cycles.push({ t0: seq[0].t, points: seq.map((e) => ({ h: (e.t - seq[0].t) / 3600000, height: e.height, type: e.type })) });
  }
  return cycles;
}

/** The typical cycle: each of the five events averaged over the cycles. Returns { points, n, lowerHighFirst } (lowerHighFirst = cycles where the first high after the LLW is the lower one), or null with no cycles. */
function tideClockAverageCycle(cycles) {
  if (!cycles || cycles.length === 0) return null;
  const n = cycles.length;
  const points = cycles[0].points.map((p, k) => ({
    type: p.type,
    h: cycles.reduce((a, c) => a + c.points[k].h, 0) / n,
    height: cycles.reduce((a, c) => a + c.points[k].height, 0) / n,
  }));
  const lowerHighFirst = cycles.filter((c) => c.points[1].height < c.points[3].height).length;
  return { points, n, lowerHighFirst };
}

/** Where to mark the segments on the axis: [{ h, label }] for LLW, the first high, the low, the second high and the next LLW. The highs are named by which is usually the lower one first (LHW then HHW), or the other way round if that's what this tide does. */
function tideClockSegments(avg) {
  const lowerFirst = avg.lowerHighFirst * 2 >= avg.n;
  const labels = ["LLW", lowerFirst ? "LHW" : "HHW", "HLW", lowerFirst ? "HHW" : "LHW", "LLW"];
  return avg.points.map((p, k) => ({ h: p.h, label: labels[k] }));
}

/** The typical tide height (m) at the centre of every column: cosine-eased between the average events, like the site's tide curves. */
function tideClockCurve(avg) {
  const p = avg.points;
  const out = [];
  for (let i = 0; i < TIDE_CLOCK_BINS; i++) {
    const x = (i + 0.5) * TIDE_CLOCK_BIN_H;
    if (x <= p[0].h) {
      out.push(p[0].height);
      continue;
    }
    if (x >= p[p.length - 1].h) {
      out.push(p[p.length - 1].height);
      continue;
    }
    let k = 0;
    while (k < p.length - 2 && x > p[k + 1].h) k++;
    const frac = (x - p[k].h) / (p[k + 1].h - p[k].h);
    const eased = (1 - Math.cos(frac * Math.PI)) / 2;
    out.push(p[k].height + (p[k + 1].height - p[k].height) * eased);
  }
  return out;
}

/**
 * Add up every session onto the tide cycle. `sessions` are ribbonBuildSessions() results,
 * `extremaFor(session)` gives that session's tide events (or null), and `catchOk(catch)` says
 * whether a catch passes the report's filters. Returns { bins, used, skipped, catches, cycles } where
 * each bin is { effortH, catches, bySpecies, rate } (rate is catches per hour, null when effort is
 * thin) and cycles are the complete tide cycles seen in the used sessions' events (each counted once).
 */
function tideClockAggregate(sessions, extremaFor, catchOk) {
  const bins = Array.from({ length: TIDE_CLOCK_BINS }, () => ({ effortH: 0, catches: 0, bySpecies: {}, rate: null }));
  const cycleByStart = new Map();
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
    for (const cycle of tideClockCycles(extrema)) cycleByStart.set(cycle.t0, cycle);
    for (const c of s.catches) {
      if (catchOk && !catchOk(c)) continue;
      const h = tideClockHoursSinceLLW(extrema, c._t);
      if (h === null) continue;
      const b = bins[tideClockBinFor(h)];
      const sp = c.species || "Unknown";
      b.catches++;
      b.bySpecies[sp] = (b.bySpecies[sp] || 0) + 1;
      catches++;
    }
  }
  for (const b of bins) b.rate = b.effortH >= TIDE_CLOCK_MIN_EFFORT_H ? b.catches / b.effortH : null;
  return { bins, used, skipped, catches, cycles: Array.from(cycleByStart.values()) };
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
