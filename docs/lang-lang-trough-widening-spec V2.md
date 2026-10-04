# Lang Lang tide-trough correction — field spec (draft)

**Status:** implemented (2026-10-05) exactly as specified (low O later, "too low" O earlier, "high enough" O later); only the drawn curve between those points is smoothed. Original status: Based on 9 days of logged observed-vs-predicted data (26 Sep – 4 Oct 2026) for Lang Lang Boat Ramp, Kayak type.

## The finding

Across 9 consecutive days of paired observations (daily high, low, and the two crossings of `minTideHeight` either side of the low — "too low" going down, "high enough" coming back up), the error is the same sign every single time:

| Crossing | Sample size | Direction | Typical magnitude |
|---|---|---|---|
| Daily high | ~15 instances | no consistent bias | within ~10 min either way — no fix needed |
| Daily low (trough) | 7 instances | always **predicted early** | ~20–45 min |
| "High enough" (rising back through `minTideHeight` after the low) | 7 instances | always **predicted early** | ~35–70 min |
| "Too low" (falling through `minTideHeight` before the low) | 12 instances | always **predicted late** | ~15–100 min |

In other words: the predicted too-low window around the low tide is consistently **narrower** than the real one. The site tells Oliver he can still launch later than he actually can (on the way down), and that it's fishable again sooner than it actually is (on the way back up). Both directions are the unsafe direction for a go/no-go call.

**Likely mechanism:** `fetch_conditions.py`'s `interpolate_tide_height()` synthesizes the curve between real WillyWeather high/low extrema using a *symmetric* half-cosine ("Rule of Twelfths"). Real tides here aren't symmetric around the low — the ebb and flood on either side of a shallow low take different amounts of time, especially during bigger tidal ranges. A symmetric curve can't represent that asymmetry, so it rushes through the trough faster than the real tide does.

Day-to-day magnitude varies a lot (13 min to 100 min) and we have NOT pinned down why — floated and ruled out (or at least not confirmed) so far: moon phase / tidal range, and the Oct 4 DST changeover. Treat magnitude as still an open question; only the *direction* is solid.

**Important: a plain timestamp shift of the low doesn't work.** The first draft of this spec proposed shifting the low's own predicted timestamp later (toward the real low). That's wrong: if the low's time moves later while the neighbouring highs (real WillyWeather extrema) stay fixed, the falling leg into the low gets *longer*, which pushes the "too low" crossing on that leg *later* — the opposite of the correction needed (it's already predicted too late). Same problem in reverse on the recovery leg. The real fix has to widen the too-low window symmetrically around the low — not move the low itself and let the interpolation stretch to follow.

## Proposed fields (config/locations.json, per-location)

`tideOffset` is untouched — it keeps doing its existing job as a global, uniform time shift. On top of it, four new optional numeric fields (minutes), one per tide-type classification (HHW/LHW/HLW/LLW), each widening the too-low/launchable window symmetrically around that type of extremum and nudging that extremum's own displayed time by the same amount:

```json
{
  "hhwOffset": 0,
  "lhwOffset": 0,
  "hlwOffset": 40,
  "llwOffset": 0
}
```

- **`hlwOffset`** — the only one with real evidence behind it (every logged low so far has been HLW). Effect: the "too low" crossing before this low moves `hlwOffset` minutes *earlier*, the "high enough" crossing after it moves `hlwOffset` minutes *later*, and the low's own displayed time moves `hlwOffset` minutes later. **Starting value: 40 minutes.**
- **`llwOffset`** — same mechanism, for LLW lows. No data yet. **Starting value: 0.**
- **`hhwOffset`** / **`lhwOffset`** — same *idea* mirrored for highs, but NOT an exact mirror in every respect; see "How `hhwOffset` / `lhwOffset` would affect calculations" below. No evidence a correction is needed here — every logged high has been within ~10 min, unbiased. **Starting value: 0 for both.**

All four default to 0, so every other location is unaffected until tuned, and `hhwOffset`/`lhwOffset`/`llwOffset` stay inert for Lang Lang itself until there's real data behind them.

### Where the 40-minute `hlwOffset` starting value comes from

Three separate measurements all pointed the same way, averaged over the days logged:

| Measurement | Instances | Average |
|---|---|---|
| Low displayed too early | 7 | 29 min |
| "Too low" crossing (falling) too late | 12 | 51 min |
| "High enough" crossing (rising) too early | 7 | 47 min |

`hlwOffset` has to do (an approximation of) all three jobs with one number. The two window-edge numbers (51, 47) are close to each other and bigger than the low's own timestamp error (29) — the low's own display drift is a smaller, separate effect from the window-widening. 40 minutes splits the difference without chasing the biggest (noisiest) of the three. Treat it as a first cut to deploy and keep tuning against future logged days, not a final value — day-to-day error swung from 13 to 100 minutes on the same measurement across the 9 days logged, so no single constant fits every day.

## Where this needs to be applied (needs confirming against current code before building)

Two candidate integration points, and I haven't re-read the live files this session to confirm which is current:

1. **Server-side, in `scripts/fetch_conditions.py`**, inside/after `interpolate_tide_height()`: adjust the synthesized curve itself so `data/conditions.json` already carries the corrected shape. Pro: every page (`week.js`, `app.js`, `live.js`) sees the same corrected curve for free. Con: baked into generated data, so a wrong starting value means waiting for the next 3-hourly refresh to see the effect of a tweak.
2. **Client-side, in `charts.js`**, alongside the existing `tideOffset` handling (`interpolatedTideHeightAt` / `applyTideOffsetToRows`) and the session-window computation that already compares height against `minTideHeight`: apply the per-type offsets only when computing the launchable window, without touching the plotted curve itself. Pro: instantly tunable, no data regen needed to test a new value. Con: the plotted curve and the computed window would visibly disagree (curve says "still above `minTideHeight`" while window says "too low") unless the chart rendering is also corrected to match.

Given the site already has a precedent for a client-side threshold-timing correction (`tideOffset`), (2) is probably the more consistent place, but this should be checked against the actual current `charts.js` session-window code before building — I'm going on the May/earlier description of it, not a fresh read.

## Application logic (conceptual)

This requires knowing each extremum's HHW/LHW/HLW/LLW classification at scoring time (the site already computes this, per the project's domain notes) so the right offset field is picked per extremum.

For the bracket between the high immediately before a low and the high immediately after it, using that low's classification's offset (call it `O`, e.g. `hlwOffset`):
- "Too low" crossing (falling through `minTideHeight`, before the low): `correctedTooLowTime = originalTooLowTime - O`.
- The low itself: `correctedLowTime = originalLowTime + O`.
- "High enough" crossing (rising through `minTideHeight`, after the low): `correctedHighEnoughTime = originalHighEnoughTime + O`.
- Everything outside this bracket (the highs, and the bulk of the rise/fall away from the threshold) is untouched.

The mirrored logic for highs (`hhwOffset`/`lhwOffset`) is specified in the next section — it differs from this in a few places, so don't just copy-paste this block.

## How `hhwOffset` / `lhwOffset` would affect calculations (if implemented)

**Status: design only. Nothing here is evidenced for Lang Lang — logged highs are accurate to ~10 min with no bias — so both stay 0 here. This section exists so whoever implements the four-field model knows what the two high-side fields would do, and what to decide, rather than leaving them as vague placeholders.**

### Semantics: "widen the feature" around the extremum

The low-side fields widen the **too-low trough**. The high-side equivalent is to widen the **high-water plateau** — the period the water stays near its peak. For a high `H` at time `tH` with offset `O` (minutes):

- The **rising-side** crossing of any height threshold on the leg *into* `H` moves `O` minutes *earlier*.
- The **falling-side** crossing of any height threshold on the leg *out of* `H` moves `O` minutes *later*.
- Net effect: the time spent *above* a given threshold around that high grows by `2 × O`. (For a low it's the time spent *below* the threshold that grows by `2 × O` — same operation, opposite side of the threshold.)

A negative value would narrow the plateau instead (sharper peak).

### Which offset "owns" a threshold crossing

Every `minTideHeight` crossing sits on a leg between a high and a low, so it's ambiguous whether the high's offset or the low's offset applies. **Proposed rule: split each leg at its height-midpoint** (halfway between the two extremum heights). A crossing above the midpoint belongs to the high at that leg's top; a crossing below the midpoint belongs to the low at that leg's bottom. Deterministic, no double-application, no blending.

*Alternatives, if the midpoint rule feels wrong:* attribute by whichever extremum is nearer the threshold in height (similar result in practice), or split by time rather than height (worse — legs are time-asymmetric in exactly the way this whole spec is about).

**Consequence for Lang Lang today:** with `minTideHeight` = 1.2 m and highs ~2.4–2.5 m, every leg's midpoint is ~1.7–1.9 m, so the 1.2 m threshold is always *below* the midpoint → always owned by the low. Checked against 25 Sep: HHW 2.49 m (11:25) → HLW 1.22 m (17:19) midpoint 1.855 m; HLW 1.22 m → LHW 2.37 m (23:41) midpoint 1.795 m. Both legs: 1.2 m < midpoint → low-owned. **So `hhwOffset`/`lhwOffset` would not change the launchable window at all for Lang Lang at its current `minTideHeight`**, even if set non-zero. They only start to matter for a location where `minTideHeight` sits *above* the leg midpoints (a high-water-only launch, e.g. a shallow ramp that's only usable near the top of the tide) — and in that case the roles flip: the high-side fields become the main knobs and the low-side ones go inert.

### Hypothetical worked example (NOT Lang Lang's real setting)

Same 25 Sep curve, but pretend `minTideHeight` = 2.0 m so the high owns the crossings, with `hhwOffset` = 40 on the 11:25 HHW (2.49 m):

| | Unmodified (from the site's own 10-min data) | With `hhwOffset` = 40 |
|---|---|---|
| Rises through 2.0 m | ~08:45 | ~08:05 (40 min earlier) |
| Falls through 2.0 m | ~13:56 | ~14:36 (40 min later) |
| Time above 2.0 m | ~5 h 11 m | ~6 h 31 m (+80 min) |

### What else a high-side offset would touch

1. **The high's own displayed time / "High" marker.** If implemented as an exact mirror of the low-side behaviour (shift the displayed extremum later by `O`), a non-zero value would move a displayed high that is *currently accurate* — logged highs are within ~10 min with no bias, and that's the one thing we know confidently about highs. **Recommendation: for `hhwOffset`/`lhwOffset`, widen the plateau only; do NOT shift the displayed high time.** This is a deliberate asymmetry with `hlwOffset`, whose bundled time shift *is* supported by data (lows displayed ~29 min early). If the implementer prefers strict symmetry across all four fields, say so explicitly in the code comments, since it makes highs less accurate by construction.
2. **Tide Status flip times.** Rows in `data/conditions.json` carry `Tide Status` (`Incoming` / `Outgoing` / `High` / `Low`) flipping at the extremum timestamps. If a high's time were shifted, the Incoming→Outgoing flip moves with it. Anything keyed on that status moves too — **needs checking against the real code, I haven't verified how these are consumed**: the Kayak wind-against-tide-current penalty (depends on current direction) and the Fishing Condition tide stage/strength inputs.
3. **Tide strength near the peak.** A flatter plateau means a lower rate of change around the high, so any "tide strength"/"moving water" scoring that uses rate of change would score the widened period as weaker (more slack water). That's physically reasonable — slack at the top of the tide is real — but it would visibly shift Fishing Condition scores around highs when the field is non-zero. Again unverified how the score is computed; check before enabling.
4. **The plotted curve vs the computed window.** Same caveat as the integration-point discussion above: if applied only client-side to window computation, the drawn curve won't show the widened plateau.

### Edge cases the implementation must handle

- **Clamping.** `O` must stay well under half the duration of either adjacent leg, or shifted crossings on the same leg can pass each other (e.g. an LHW's falling-side shift and the next HLW's rising-side shift both acting on the short LHW→HLW leg in a mixed tide). Suggest clamping each side's shift to ≤ 50% of that leg's duration.
- **No crossing to shift.** All of this shifts crossings that *already exist* in the unmodified curve. It cannot create one. See the near-miss gap below — it applies to highs too (a high that peaks just barely above or below the threshold).
- **Mixed-tide day with one high only.** Some days have a single high; classification can fall back to the plain HHW/LHW rules the site already uses. Don't invent a classification here.

## Still open before implementation

- Confirm current `charts.js` / `fetch_conditions.py` structure (not re-read this session) to pick the correct integration point and function names.
- Decide whether these four fields are hardcoded constants or exposed in the locations editor (`locations.html` / `locationsadmin.js`) — likely exposed, consistent with how `tideOffset`/`minTideHeight` already work.
- No decision yet on what drives the day-to-day magnitude swing (13–100 min) — a single fixed offset will overcorrect on small-range days and undercorrect on large-range ones. Could eventually scale the offset by that day's tidal range (high − low height) rather than using a flat constant, but that's a bigger change — flat constants are the pragmatic first cut.
- `hhwOffset`/`lhwOffset`/`llwOffset` are placeholders with no supporting data yet — don't tune them until there's logged evidence for an HHW/LHW high or an LLW low, per the original "cheap to loosen later" principle.
- **Near-miss gap (applies to the low-side fields too, found while writing the high-side section).** Shifting an existing crossing can't fix a day where the predicted curve *never crosses* `minTideHeight` but the real tide does. This already happened: on 25 Sep the predicted afternoon low was 1.22 m against the 1.2 m threshold — never crossed — while the real window closed at 15:15. A time-shift offset does nothing on such a day. Possible fix for the implementer to consider: apply the widening as a **height margin** (treat the state as too-low when `height < minTideHeight + margin` near the low) instead of, or in addition to, shifting crossing times — a margin catches near-misses, a time shift can't. Not designed here; flagging so it isn't discovered after building.
- Decide the high-side questions above: crossing-ownership rule (midpoint-split recommended), and whether `hhwOffset`/`lhwOffset` shift the displayed high time (recommended: no).
