# Lang Lang tide-trough correction — field spec (draft)

**Status:** proposed, not yet implemented. Based on 9 days of logged observed-vs-predicted data (26 Sep – 4 Oct 2026) for Lang Lang Boat Ramp, Kayak type.

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
- **`hhwOffset`** / **`lhwOffset`** — same mechanism, mirrored for highs (would narrow/widen around a high rather than a low). No evidence a correction is needed here — every logged high has been within ~10 min, unbiased. **Starting value: 0 for both.**

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
- The low itself: `correctedLowTime = originalLowTime + round(0.3 * O)` (**revised 2026-10-10**; the first version used the full `+ O`). The window edges need the full `O`, but four logged days (6-9 Oct, offset 40 then) showed the printed low about 26 min late (+19, +16, +33, +34), so only ~30% of `O` is applied to the printed low time (`LOW_LABEL_SHIFT_FRACTION` in `js/chart-render.js`; 55 -> 17 min, 30 -> 9 min). The same fraction is used for HLW and LLW (no LLW label data yet). The drawn trough is re-timed to the label (slope 0), so the curve minimum and the printed time agree.
- "High enough" crossing (rising through `minTideHeight`, after the low): `correctedHighEnoughTime = originalHighEnoughTime + O`.
- Everything outside this bracket (the highs, and the bulk of the rise/fall away from the threshold) is untouched.

The mirrored logic (for highs, using `hhwOffset`/`lhwOffset`) would apply the same shape around a high instead — not currently evidenced as needed, but the field exists for when/if it is.

## Still open before implementation

- Confirm current `charts.js` / `fetch_conditions.py` structure (not re-read this session) to pick the correct integration point and function names.
- Decide whether these four fields are hardcoded constants or exposed in the locations editor (`locations.html` / `locationsadmin.js`) — likely exposed, consistent with how `tideOffset`/`minTideHeight` already work.
- No decision yet on what drives the day-to-day magnitude swing (13–100 min) — a single fixed offset will overcorrect on small-range days and undercorrect on large-range ones. Could eventually scale the offset by that day's tidal range (high − low height) rather than using a flat constant, but that's a bigger change — flat constants are the pragmatic first cut.
- `hhwOffset`/`lhwOffset`/`llwOffset` are placeholders with no supporting data yet — don't tune them until there's logged evidence for an HHW/LHW high or an LLW low, per the original "cheap to loosen later" principle.
