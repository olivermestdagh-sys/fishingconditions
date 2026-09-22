// The catch rules built on each species' limits (Settings > Species: Min Size, Max Size, Max Qty, Big Size, Big Max Qty and the
// shared-quantity group). Pure: no DOM, no network, no globals. Tested in tests/catch-limits.test.mjs; used by the Live Catch
// cards (js/live-cards.js, map-live.js) and the mark edit popup (js/marks-core.js).
//
// A "run" is a stretch of fishing: Catch marks chained together while each is within CATCH_RUN_GAP_MS of the next. Counts are of
// the fish KEPT (not released) in the current run, summed across species that share a Max Qty (qtyGroup).
//   limits:  { "<species>": {minSize, maxSize, maxQty, bigSize, bigMaxQty, qtyGroup} } (see limitsFromMarkLists)
//   catches: [{id, species, size, released, tMs}] (see catchesFromMarks)

const CATCH_RUN_GAP_MS = 8 * 3600000;
const CATCH_SIZE_DEFAULT_START_CM = 20; // stepper start when a species has no Min Size set

/** Species limits keyed by species name, from the flat mark list rows ({field, value, minSize, ...}). */
function limitsFromMarkLists(markLists) {
  const limits = {};
  for (const row of markLists || []) {
    if (!row || row.field !== "Species") continue;
    limits[row.value] = {
      minSize: row.minSize ?? null,
      maxSize: row.maxSize ?? null,
      maxQty: row.maxQty ?? null,
      bigSize: row.bigSize ?? null,
      bigMaxQty: row.bigMaxQty ?? null,
      qtyGroup: row.qtyGroup ?? null,
    };
  }
  return limits;
}

/** Catch marks as plain {id, species, size, released, tMs}. `toMs` turns a mark's dateTime into ms (parseNaive in the browser); marks without a usable time are left out. */
function catchesFromMarks(marks, toMs) {
  const out = [];
  for (const m of marks || []) {
    if (!m || m.type !== "Catch") continue;
    const tMs = toMs(m.dateTime);
    if (!Number.isFinite(tMs)) continue;
    const size = m.size == null || m.size === "" ? null : Number(m.size);
    out.push({ id: m.id, species: m.species || "", size: Number.isFinite(size) ? size : null, released: !!m.released, tMs });
  }
  return out;
}

/**
 * The run around `anchorMs` (now, or a catch's own time): every catch time chained to it with gaps of gapMs or less.
 * Returns {start, end} (the first and last catch of the chain) or null when no catch is within gapMs of the anchor.
 */
function catchChain(timesMs, anchorMs, gapMs = CATCH_RUN_GAP_MS) {
  const real = timesMs.filter(Number.isFinite).sort((a, b) => a - b);
  const all = [...real, anchorMs].sort((a, b) => a - b);
  const i = all.indexOf(anchorMs);
  let a = i;
  while (a > 0 && all[a] - all[a - 1] <= gapMs) a--;
  let b = i;
  while (b < all.length - 1 && all[b + 1] - all[b] <= gapMs) b++;
  const chain = all.slice(a, b + 1);
  if (!real.includes(anchorMs)) chain.splice(chain.indexOf(anchorMs), 1); // the anchor itself is not a catch
  return chain.length ? { start: chain[0], end: chain[chain.length - 1] } : null;
}

/** The catches that are part of the run around anchorMs (empty when there is none). */
function runCatches(catches, anchorMs, gapMs = CATCH_RUN_GAP_MS) {
  const chain = catchChain(catches.map((c) => c.tMs), anchorMs, gapMs);
  return chain ? catches.filter((c) => c.tMs >= chain.start && c.tMs <= chain.end) : [];
}

/** The species whose Max Qty is shared with `species` (itself included), in a stable order. */
function speciesGroupNames(limits, species) {
  const lim = limits[species];
  if (!lim || !lim.qtyGroup) return [species];
  return Object.keys(limits).filter((name) => limits[name].qtyGroup === lim.qtyGroup);
}

/** Kept fish in `run` (already the run's catches): {kept: across the shared-quantity group, big: this species' kept fish at or above Big Size, names: the group}. */
function keptCounts(run, limits, species) {
  const names = speciesGroupNames(limits, species);
  const lim = limits[species] || {};
  const keptFish = run.filter((c) => !c.released);
  return {
    kept: keptFish.filter((c) => names.includes(c.species)).length,
    big: lim.bigSize == null ? 0 : keptFish.filter((c) => c.species === species && c.size != null && c.size >= lim.bigSize).length,
    names,
  };
}

/** How a size measures up: {tooSmall, overSlot, big}. Unset limits never trigger. */
function sizeVerdict(lim, size) {
  const l = lim || {};
  const n = Number(size);
  const ok = size != null && size !== "" && Number.isFinite(n);
  return {
    tooSmall: ok && l.minSize != null && n < l.minSize,
    overSlot: ok && l.maxSize != null && n > l.maxSize,
    big: ok && l.bigSize != null && n >= l.bigSize,
  };
}

/**
 * Keep or Release for a fish, with the reason. `tooSmall` = the person chose Too small (no size known).
 * Release when: too small, over the max size, the bag is already full (Max Qty 0 = never keep), or it is a big fish and the
 * big-fish limit is already used. Otherwise Keep. `counts` is from keptCounts, or null when the run isn't known.
 */
function recommendFate({ lim, size, counts, tooSmall }) {
  const l = lim || {};
  if (tooSmall) return { fate: "Release", reason: l.minSize != null ? `Too small (under ${l.minSize} cm)` : "Too small" };
  const v = sizeVerdict(l, size);
  if (v.tooSmall) return { fate: "Release", reason: `Under the minimum size (${l.minSize} cm)` };
  if (v.overSlot) return { fate: "Release", reason: `Over the maximum size (${l.maxSize} cm)` };
  if (l.maxQty === 0) return { fate: "Release", reason: "No bag allowed for this species" };
  if (counts && l.maxQty != null && counts.kept >= l.maxQty) return { fate: "Release", reason: `Bag full: ${counts.kept} of ${l.maxQty} kept` };
  if (counts && v.big && l.bigMaxQty != null && counts.big >= l.bigMaxQty) {
    return { fate: "Release", reason: `Big fish limit reached: ${counts.big} of ${l.bigMaxQty} kept` };
  }
  if (counts && l.maxQty != null) {
    const bigNote = v.big && l.bigMaxQty != null ? `, big ${counts.big + 1} of ${l.bigMaxQty}` : "";
    return { fate: "Keep", reason: `Keeping this makes ${counts.kept + 1} of ${l.maxQty}${bigNote}` };
  }
  return { fate: "Keep", reason: l.maxQty == null ? "No bag limit set" : "" };
}

/** Where the size stepper starts: the species' own Min Size, or CATCH_SIZE_DEFAULT_START_CM if none is set. */
function stepperStartSize(lim) {
  return lim && lim.minSize != null ? lim.minSize : CATCH_SIZE_DEFAULT_START_CM;
}

/**
 * The two blurb lines shown under a species: its limits, and how many are kept so far ("" when counts are unknown), and
 * a tone: "full" (bag reached), "warn" (one left) or "".
 */
function speciesLimitLines(lim, counts) {
  const l = lim || {};
  const parts = [];
  if (l.minSize != null) parts.push(`Min ${l.minSize} cm`);
  if (l.maxSize != null) parts.push(`Max ${l.maxSize} cm`);
  if (l.maxQty != null) parts.push(`Max qty ${l.maxQty}`);
  if (l.bigSize != null) parts.push(`Big ${l.bigSize}+ cm${l.bigMaxQty != null ? ` (${l.bigMaxQty})` : ""}`);
  const line1 = parts.length ? parts.join(" · ") : "No limits set";
  if (!counts) return { line1, line2: "", tone: "" };
  const shared = counts.names.length > 1 ? ` (shared with ${counts.names.filter((n) => n !== counts.self).join(", ")})` : "";
  const kept = l.maxQty != null ? `Kept ${counts.kept}/${l.maxQty}` : `Kept ${counts.kept}`;
  const big = l.bigSize != null && l.bigMaxQty != null ? ` · big ${counts.big}/${l.bigMaxQty}` : "";
  let tone = "";
  if (l.maxQty != null) tone = counts.kept >= l.maxQty ? "full" : counts.kept === l.maxQty - 1 ? "warn" : "";
  return { line1, line2: kept + shared + big, tone };
}

/** Everything the species blurb needs for one species: keptCounts plus the species itself (to leave it out of "shared with"). */
function speciesCounts(run, limits, species) {
  return { ...keptCounts(run, limits, species), self: species };
}

/**
 * Warnings for a Catch as edited in the mark popup: kept but under the min size, over the max size, over the bag limit, or over
 * the big-fish limit. `mark` = {id, species, size, released, tMs}; `catches` = every catch INCLUDING the saved version of this one
 * (which is left out and replaced by the values being edited). Returns an array of messages (empty when all is well).
 */
function catchLimitWarnings(mark, limits, catches) {
  const lim = limits[mark.species];
  if (!lim || mark.released) return [];
  const warnings = [];
  const v = sizeVerdict(lim, mark.size);
  if (v.tooSmall) warnings.push(`Kept, but under the minimum size (${lim.minSize} cm).`);
  if (v.overSlot) warnings.push(`Kept, but over the maximum size (${lim.maxSize} cm).`);
  const others = catches.filter((c) => c.id !== mark.id);
  const self = { id: mark.id, species: mark.species, size: mark.size ?? null, released: false, tMs: mark.tMs };
  const run = runCatches([...others, self], mark.tMs);
  const counts = keptCounts(run, limits, mark.species);
  if (lim.maxQty != null && counts.kept > lim.maxQty) {
    const shared = counts.names.length > 1 ? ` (shared with ${counts.names.filter((n) => n !== mark.species).join(", ")})` : "";
    warnings.push(`Over the bag limit: ${counts.kept} kept, Max qty ${lim.maxQty}${shared}.`);
  }
  if (v.big && lim.bigMaxQty != null && counts.big > lim.bigMaxQty) {
    warnings.push(`Over the big-fish limit: ${counts.big} kept at ${lim.bigSize}+ cm, allowed ${lim.bigMaxQty}.`);
  }
  return warnings;
}
