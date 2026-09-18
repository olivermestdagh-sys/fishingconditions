# Kayak & Surf Conditions — website

A free, mobile-friendly website version of the Kayak_Conditions.xlsx workbook. A
scheduled job fetches data from WillyWeather and publishes it as a static page —
no server to run, no ongoing cost beyond WillyWeather's own API pricing.

## How it works

```
GitHub Actions (on a schedule)
  -> runs scripts/fetch_conditions.py
  -> calls the WillyWeather API (same logic as the Excel Power Query)
  -> calls Open-Meteo (free, no API key) for barometric pressure, sea
     surface temperature, and ocean current velocity/direction — data
     WillyWeather doesn't offer as a forecast — two things WillyWeather doesn't offer as forecasts
  -> writes data/conditions.json
  -> commits it back to the repo
GitHub Pages
  -> serves index.html (the Good Conditions page — the site's home page), plus
     conditions.html and locations.html, which all read data/conditions.json and render
```

Your WillyWeather API key lives only as a GitHub Actions secret — it's never
sent to anyone's browser, so it's safe to make this repo public if you want.
The Open-Meteo calls need no key or secret at all — nothing to set up for them.

## One-time setup

1. **Create a GitHub account** if you don't have one (free): github.com/signup

2. **Create a new repository** and upload every file in this folder, keeping
   the folder structure intact (the `.github/workflows/update.yml` file must
   stay at that exact path). Easiest way: on the new repo's page, use
   "Add file → Upload files" and drag the whole folder in, or use `git push`
   if you're comfortable with git.

3. **Add your API key as a secret** (this keeps it out of the code):
   Repo → Settings → Secrets and variables → Actions → New repository secret
   - Name: `WILLYWEATHER_API_KEY`
   - Value: your WillyWeather API key

   Your key also needs specific forecast types **enabled** on the
   WillyWeather side (each one is a separate on/off permission on your API
   key, not automatic) — check **Search**, **Forecasts → Temperature,
   Wind, Tides, Rainfall Probability, Sun, Moon Phases**, and
   **Observational Graphs → Temperature, Wind** are all switched on. If any
   one of these isn't enabled, that specific piece of data just quietly
   doesn't appear (no error shown) rather than breaking anything else — so
   a missing moon phase, missing tide line, etc. is often this, not a code
   problem.

4. **Turn on GitHub Pages**:
   Repo → Settings → Pages → Source: "Deploy from a branch" → Branch: `main`,
   folder `/ (root)` → Save.
   GitHub will show you the site's URL (something like
   `https://yourname.github.io/repo-name/`) — that's the link to open on your
   phone or anywhere else, and to bookmark / add to your home screen.

5. **Run the fetch once manually** so the site has data straight away, instead
   of waiting for the first scheduled run:
   Repo → Actions tab → "Update conditions data" workflow → "Run workflow" button.
   Takes under a minute for 15 locations. Refresh the site afterwards.

That's it — from here it updates itself on the schedule below.

## Changing which locations are tracked

Easiest way: use the **Settings** tab on the site itself (see "Editing locations
from the site itself" below) — it now supports toggling which types (Kayak,
Land based) a location is usable for, with the timings for each shown
separately. Or edit `config/locations.json` directly on GitHub (click the
file → pencil icon to edit → commit):

```json
{
  "name": "Lang Lang Boat Ramp, VIC",
  "shore": "E",
  "tidal": true,
  "types": [
    {
      "type": "Kayak",
      "setUp": "00:30",
      "packUp": "00:30",
      "timeToSpot": "00:10",
      "timeFromSpot": "00:10",
      "minTideHeight": 2.1
    },
    {
      "type": "Land based",
      "setUp": "00:00",
      "packUp": "00:00",
      "timeToSpot": "00:15",
      "timeFromSpot": "00:15"
    }
  ]
}
```

A single physical location can have **multiple types** — the same boat ramp
might work for both kayak launching and shore fishing, each scored and
timed independently. `name`/`shore`/`tidal`/coordinates are shared (it's the
same GPS point either way); everything inside each `types[]` entry —
timings, `minTideHeight` — is specific to that one activity. `type` must be
exactly `"Kayak"` or `"Land based"`. `tidal` defaults to `true` if omitted
(every existing coastal location is unaffected without needing to be
individually updated) — set it to `false` for an inland river or lake with
no real tide, and every tide-derived input (tide status/height, tidal
current, the wind-against-current penalty) is stripped from that
location's scoring entirely, regardless of what the tide/marine-current
APIs happen to return for that coordinate. Sea surface temperature (the
Water Temp graph line, see below) is fetched regardless of `tidal` — it
isn't a tide-derived field — so treat it as unreliable for a genuinely
inland location, since Open-Meteo's marine API always snaps to the nearest
sea grid cell however far away that actually is. Land based reuses the same
wind/shore-angle formula that used to be called "Surf" — genuinely the same
scoring, just relabeled; Kayak's formula (wind speed/direction plus the
wind-against-current
penalty) is a different calculation and doesn't apply to Land based at all.
Both types have Time to Spot/Time From Spot — paddling for Kayak, walking
from the carpark to the actual spot for Land based.

The timing fields are `HH:MM` durations — how long each part of a trip
takes — and **feed into** Week Ahead's schedule calculator once you
set a Launch Time/Home By. Drive time isn't one of these fields any more —
see "Live drive-time lookup" below for how that's now calculated instead.
Changes take effect on the next scheduled or manual run.

## How locations get matched to WillyWeather

Every location needs a specific WillyWeather location behind it to actually
fetch data from. `fetch_conditions.py` resolves this once per location and
then **caches it directly onto that location in `config/locations.json`**
(`willyweatherId`, plus `willyweatherName`/`willyweatherRegion`/
`willyweatherState` for reference) — every run after that skips search
entirely for it and calls WillyWeather straight by id, which is both faster
and immune to a name accidentally matching the wrong same-named place
somewhere else in the state.

The very first resolution, before anything's cached, tries in order:

1. **A real, admin-chosen coordinate** — set via the Settings map's "click
   map to add location" action, or picked from the WillyWeather candidate
   popup (see below) — resolved by asking WillyWeather what's nearest that
   exact point.
2. **The location's name**, text-searched against WillyWeather — the
   original behaviour, and still the fallback for anything added via the
   plain "+ Add location" button or from before this feature existed. The
   name needs to reasonably match WillyWeather's own naming for a place —
   use the candidate popup (below) where possible to sidestep this
   entirely, since it locks in the *correct* WillyWeather id directly, no
   name-matching required at all.

If a cached id ever stops returning data (WillyWeather retired or merged
it), the next run automatically drops the stale cache and re-resolves from
scratch — self-healing, no manual intervention needed. Check the Actions
run log for `WARNING:` lines if a location's data ever goes quiet; the
script explains exactly what it tried and why.

### Getting real WillyWeather names via the map (optional)

Clicking the Settings map's "📍 Click map to add location" button and then
the map itself normally starts a blank, manually-named location at that
point. If the small `willyweather-search` Cloudflare Worker (see
`cloudflare-worker/willyweather-search.js`) is deployed and its URL pasted
into `WILLYWEATHER_SEARCH_WORKER_URL` near the top of `locationsadmin.js`,
that same click instead pops up WillyWeather's own real nearby candidates
to choose from — picking one locks in its exact id immediately, so that
location's very first scheduled run already knows precisely what it is,
with no name-matching guesswork at all.

This is optional — everything above works fine without it, just leaning
more on name-search on a location's first run. See the deployment steps in
the comment at the top of `cloudflare-worker/willyweather-search.js` for
how to set the Worker up (a free Cloudflare account, no server to run).
It exists purely so the WillyWeather API key never has to be exposed in
this site's own public, client-side code.

### Live preview from the Location tab (optional, same Worker)

The Location tab's map itself doubles as a live preview tool — separate
from Settings' "click to add", and doesn't create or save anything. Click
anywhere on open map area (clicking an existing marker still selects that
saved location as usual) and it:

1. Asks the Worker's `/search` endpoint what's nearby (same lookup the
   Settings map uses), and if there's more than one candidate, shows the
   same picker to choose between them.
2. Fetches that WillyWeather location's live forecast via the Worker's
   `/weather` endpoint, plus pressure and sea-surface-temperature directly
   from Open-Meteo (no key needed for those), and renders it into the same
   graph panel a saved location uses — labelled "(preview)".

This is a genuinely live look at conditions for a spot that **isn't**
saved anywhere — useful for scouting a new spot before deciding whether
it's worth adding via Settings. It deliberately does **not** show Location
Condition / Fishing Condition scores (the condition strips at the top of
the graph render empty) — those need a saved location's own shore/
threshold config, which doesn't exist yet for a point that's only been
clicked, not added. Everything else on the graph (temperature, wind,
rainfall, tide curve with high/low markers, pressure, water temperature,
sun/moon shading) is real, live data for that exact point.

Requires the same `willyweather-search` Worker as above, redeployed with
its `/weather` endpoint (see the comment at the top of that file) — if the
Worker isn't reachable, clicking the map just shows a friendly "couldn't
load a preview" message rather than breaking anything.



Week Ahead calculates drive time live, via Google's Routes API,
rather than using a fixed value stored per location — the same spot might
be a short drive from home but a much longer one when travelling from
somewhere else. This needs:

1. **Your device's current GPS position** — requested the same way the
   Live page does, with a manual fallback if it's denied.
2. **A Google Routes API key**, stored in D1 (`users.google_routes_api_key`
   on the Public row) rather than a config file — there's no Settings-page
   form for it (it rarely changes), so setting or changing it means a
   direct D1 console `UPDATE`:
   ```sql
   UPDATE users SET google_routes_api_key = 'your-key-here' WHERE id = 'public';
   ```
   To get a key: [console.cloud.google.com](https://console.cloud.google.com/) →
   create a project → **enable billing** (required even for free-tier
   usage — see the note below) → enable **Routes API** specifically (not
   the older "Directions API") → Credentials → Create credentials → API
   key → restrict it to your GitHub Pages domain and to just the Routes
   API before using it in production.

**On the billing requirement**: Google mandates a card on file to use any
Maps Platform API, even entirely within the free tier — this is a Google
policy, not something this site's usage would actually cost you at
personal scale. If that's not something you want to set up, drive-time
fields will just show as unavailable — Arrive/Launch/Fish at/Home by still
calculate fine without it, since only Leave Home/Head Back/Drive Home
specifically depend on drive time.

Both types (Kayak and Land based) have `timeToSpot`/`timeFromSpot` fields
— paddling time for Kayak, walking-from-the-carpark time for Land based —
which still work exactly as before, unrelated to the live drive-time piece.

## Changing the update frequency — and what it costs

The schedule lives in `.github/workflows/update.yml` as a cron expression.
Default is every 3 hours. Each run costs **2 WillyWeather API requests per
location** (a name search + a weather fetch). With your current 15 locations,
that's 30 requests per run. WillyWeather gives 5,000 free requests, then bills
AUD $0.0009945 (~$0.001) per request after that:

| Schedule            | Runs/day | Requests/day | Approx. monthly cost* |
|----------------------|----------|---------------|------------------------|
| Every 30 min          | 48       | 1,440         | ~AUD $43               |
| Every hour             | 24       | 720           | ~AUD $21               |
| Every 3 hours (default)| 8        | 240           | ~AUD $7                |
| Every 6 hours           | 4        | 120           | ~AUD $3.50             |

\*After the free 5,000 requests are used up; check your actual WillyWeather
account billing page for current allowance and pricing, since this can change.
This table only counts WillyWeather requests — the Open-Meteo calls (pressure
and sea temperature) are free with no request limit worth worrying about at
this scale, so they don't add to the cost above.

To adjust: change the `cron:` line, e.g. `0 */6 * * *` for every 6 hours, or
`0 6,18 * * *` for twice a day (6am/6pm UTC — remember GitHub Actions cron
runs in UTC, not Melbourne time). [crontab.guru](https://crontab.guru) is a
handy way to build/check a cron expression.

## Filling gaps in wind data

WillyWeather occasionally has no wind reading (speed and/or direction) for
a specific hour — usually near the far edge of the 6-day forecast window,
or right at the seam between real observational data and forecast data.
Rather than leave that hour blank (which used to show "Insufficient wind
data" wherever the Location Condition tried to explain itself), a missing
hour is filled with the average of the nearest real reading before and
after it — a flat average, not a smoothly-changing interpolation, and only
between two real readings either side, never guessed past the first/last
one available. Direction is averaged as compass bearings properly (as unit
vectors, not the raw numbers), so e.g. NNW and NNE average to N, not S —
naively averaging 337.5° and 22.5° gives 180° (due south), which would be
exactly backwards.

## Tide height between the real high/low points

WillyWeather only gives us the actual tide events (a handful of high/low
readings a day, at whatever specific times the tide turns), not a value
for every hour. The gaps between them are filled in with a cosine curve —
the same math behind the traditional "Rule of Twelfths" navigation
technique, which models a tide's real behaviour (slow near the peaks,
fastest in the middle) rather than a straight line between two points.
This is a visual smoothing between real readings, not a claim of real
precision at those specific in-between hours — it never extrapolates
*beyond* the first/last real event we have, only fills gaps between them.

Today specifically sits at the very edge of the 6-day fetch window, so its
early-morning hours (before the first real tide event of the day) have no
"previous" real event within that fetch to bracket from — but every
scheduled run also carries forward real rows from the previous run (see
"Where the '24 hours before now' data actually comes from" further down),
so a second pass reaches into that history for yesterday's last real event
and uses it as the missing bracket. The very first run ever (no history
yet) still has this small gap; every run after that shouldn't.

Tide has its own labeled axis on the graph (paired with temperature on the
left, in metres), calibrated to each location's own real observed range
rather than a single fixed scale — Western Port's ~3m swings and Port
Phillip Bay's sub-1m ones would otherwise either clip the former or make
the latter unreadable.

## Water temperature on the graph

Sea surface temperature (from Open-Meteo's Marine API, the same source
used for the Fishing Condition's water-temp-trend factor) is drawn as a
thin light blue line on every Conditions graph, sharing the left-hand
Celsius axis with air temperature rather than getting its own axis — same
unit, similar real-world range, and a seventh axis would be one too many.
It's deliberately understated (thin, no point markers) — a line to glance
at alongside air temperature, not something meant to compete visually with
the wind/rain/tide lines that actually drive the Location/Fishing
Condition scores. Like every other hourly field on this site, it's
averaged down to one value per hour when today's readings are denser than
hourly (see "Where the '24 hours before now' data actually comes from"),
and carried forward through the same rolling-history mechanism so the
Live page's "24 hours before now" side has a real line too, not just a gap.

## Barometric pressure on the graph

Mean sea-level pressure (from Open-Meteo, the same hourly series whose
daily average already feeds the Fishing Condition score's pressure
factor) is drawn as a thin black line on every Conditions graph. Unlike
water temperature, pressure doesn't share a unit with anything else
already on the chart (not Celsius, not km/h, not a percentage), so it
gets its own axis rather than piggybacking on an existing one — but like
the tide axis, that axis is hidden. The line's shape is the point, not
readable hPa numbers, and a visible axis for one supplementary trend line
would be more clutter than it's worth. The hidden axis uses a fixed
970–1050hPa range rather than a per-location calibrated one (unlike
tide's own axis) — pressure swings are driven by the weather passing
through, not a property of any particular location, so one sensible fixed
range suits every location equally well.

## Moon phase

A moon icon is drawn above the date heading at the top of every day on
every graph. It's custom-drawn to the *exact* real illumination percentage
WillyWeather gives us (0–100%), not snapped to one of 8 fixed pictures —
the terminator curve (the light/dark boundary) is the actual correct
geometry for that percentage, verified mathematically (the illuminated
area matches the target percentage to within ~0.04% across the full
range, checked with the shoelace formula before this was wired into the
real drawing code). Moon phase is a global astronomical fact, not
location-specific like sunrise/sunset — it's fetched once per run (using
whichever configured location resolves first) and shared across every
location's graph, rather than repeating the fetch per location.

Waxing/waning (which side is lit) is inferred from whether the day's
illumination is trending up or down versus the nearest other day in the
same fetch — this doesn't depend on WillyWeather using any particular
phase-naming convention, just the widely-available illumination
percentage.

## The two condition scores

The site tracks two separate 1–5 scores per location, per hour:

- **Location Condition** — is it comfortable/safe to paddle or launch here?
  Wind speed and direction for Kayak locations (plus a graduated
  minor/medium/major penalty when wind piles onto an opposing tidal
  current — real ocean current data, not a fixed guess), wind-vs-shore
  direction for Land based.
- **Fishing Condition** — are the fish likely to be active? Same formula
  everywhere regardless of type, built from tide strength, tide stage,
  barometric pressure, light (dawn/dusk), and sea surface temperature trend.

Both are plotted on the Conditions graph and shown as separate badges on
each location's summary card. Fishing Condition is the newer of the two and
deliberately leaves out moon-phase/solunar-period scoring — the one
peer-reviewed-adjacent study we found that directly tested it found no
correlation with actual catch rate, so we didn't build on it.

## The Live page

`live.html` is meant for while you're actually out on the water. On load it
asks your phone for GPS location, matches it against whichever of your
tracked locations is physically closest, and shows that location's graph —
but zoomed to just **24 hours before now through 24 hours ahead**, rather
than the full forecast window the other pages show. A solid vertical line
marks the current moment on every graph on the site (not just this page),
and a dashed line marks 15 km/h — the wind speed you've said is your kayak
threshold.

If GPS is denied, unavailable, or just picks the wrong spot (accuracy near
a boundary between two close-together locations, or you're testing this
from somewhere else entirely), a manual location picker is always available
underneath as a fallback — no dependency on GPS actually working to use the
page.

This needs each location's coordinates. As of the WillyWeather id-caching
feature (see "How locations get matched to WillyWeather" below), a
location's coordinates increasingly live directly in `config/locations.json`
itself — either because you set them via the map, or because they got
backfilled there automatically the first time a name-only location was
successfully resolved.

### When to stop fishing

Enter a Home By time and your home address, then **Update timings**, and a
dashed red line appears on the graph marking the latest moment you can
realistically keep fishing. Worked out backward from Home By:

```
Home By − drive time − pack up time − time back to the car = stop fishing by
```

- **Drive time**: fishing location → your home address, via the same
  Google Routes API used by Week Ahead (real traffic-aware driving
  time) — just the reverse direction, since here you're already at the
  water and need to get home, not the other way round.
- **Pack up time**: from that location's own Kayak/Land based timing data
  (whichever type is currently selected).
- **Time back to the car**: a fresh GPS read at the moment you press the
  button, compared against the fishing location's own coordinates, at a
  fixed 6 km/h — a walking/paddling pace, not a road route, since this
  leg isn't on roads at all.

If Home By has already passed for today, it's assumed to mean tomorrow.
Switching location or type clears the calculated line — pack-up time
differs by type, so a stale result would no longer match what's on
screen. Needs the same Google Routes API key as Week Ahead (see
"Live drive-time lookup" below) — without one, drive time can't be
calculated and the line won't appear.

### Where the "24 hours before now" data actually comes from

WillyWeather's forecast only ever looks forward from today — there's no way
to ask it for yesterday directly. So each scheduled run reads its own
*previous* output **before** overwriting it, keeps roughly the last 30
hours of real rows per location (genuine past forecasts, not anything
synthetic), and merges that history in ahead of the fresh forward-looking
fetch — de-duplicating in favour of the fresh data anywhere the two
overlap. Over time this naturally builds a real rolling window without
needing any new API or provider. One honest trade-off: a history row
reflects whichever scoring formula was live when it was originally
fetched, not necessarily the current one — if Location/Fishing Condition's
formula changes, older carried-forward rows won't retroactively update
until they age out of the ~30-hour window.

## Boat ramp access height

Some locations (Lang Lang's ramp is the original example) are only usable
above a certain tide height. Set **Minimum tide height for access** on
that location's **Kayak** timings (only Kayak has this field — Land based
doesn't need it, since you're not launching a boat) and every graph for it
shows a dashed horizontal line at that height, plus a marker and time at
every point the real tide curve actually crosses it — rising through it
and falling back through it are both marked, and a full tide cycle can
cross twice each way. Crossing times use linear interpolation between
consecutive tide readings — the real curve between two readings is a
cosine, not a straight line (see tide interpolation above), so this is a
close approximation rather than exact to the second, but with hourly
sampling the error is small. Leave the field blank for locations without
this restriction — nothing extra is drawn.

## Files in this project

- `live.html`/`live.js` — the Live page (GPS-matched to your nearest tracked
  location, shows a 24-hours-back/24-hours-forward graph), `index.html`/`week.js` —
  Week Ahead (the site's home page — a row per tracked location, each with its
  own always-visible conditions graph and qualifying sessions shaded on it;
  "+ Fishing times"/"+ Home to home" arms a row for a click-drag-release trip
  schedule calculation against that graph), `conditions.html` — the
  per-location table/graph view, `locations.html` — the locations editor,
  `sync.html`/`sync.js` — the Garmin/Lowrance import-export tab (see "Syncing
  marks with a Garmin or Lowrance device" below), `style.css`, `app.js`,
  `locationsadmin.js`, `charts.js` (shared charting code used by `app.js`,
  `week.js`, `live.js`, and `sync.js`) — the website itself (no build step,
  no dependencies)
- `scripts/fetch_conditions.py` — fetches from WillyWeather, writes `data/conditions.json`,
  and also writes back to `config/locations.json` (see "How locations get matched to
  WillyWeather" above) — pure Python standard library only, no `pip install` needed
- `config/locations.json` — your tracked locations. Also doubles as the WillyWeather
  id cache now — don't be surprised to see `willyweatherId`/`willyweatherName` fields
  appear on entries you never typed in yourself; that's the pipeline caching what it
  resolved, not a bug
- `config/settings.json` — **orphaned, safe to delete.** Used to hold the
  Google Routes API key and home address; both now live in D1
  (`users.google_routes_api_key`/`home_lat`/`home_lng`) and are served
  through `GET /api/public/settings` instead. Nothing reads or writes
  this file any more.
- `.github/workflows/update.yml` — the schedule that runs the fetch script; commits
  both `data/conditions.json` and `config/locations.json` now (the latter for the id
  cache above)
- `data/conditions.json` — the generated data file (starts empty; gets
  overwritten automatically by the workflow)
- `data/marks.json` — your GPS fishing marks (catches and points of
  interest), logged by hand while out fishing. Starts empty. See "GPS
  fishing marks" below
- `cloudflare-worker/willyweather-search.js` — optional, separate piece of
  infrastructure (not deployed via GitHub Pages) that powers the WillyWeather
  candidate popup on the Settings map and the Location tab's live preview —
  see "Getting real WillyWeather names via the map" and "Live preview from
  the Location tab" above
- `config/mark_lists.json` — the editable pick-lists (species, bait, rig,
  weather/tide/water condition, etc) offered when logging a mark. Edit from
  the Settings tab's "Fishing Mark Lists" section
- `user-backend.js` — a second, separate Cloudflare Worker (own deploy, own
  secrets, own D1 database) adding Google sign-in and a per-user
  locations/settings backend — see "User accounts" below. `schema.sql`/
  `schema-v2.sql` are its D1 table setup. `locations.html`/`locationsadmin.js`
  (the Settings tab) is what talks to it now — `account.html`/`account.js`
  used to be a separate page for this and have since been retired, merged
  into Settings (see "Settings and Account merged" further down)

## GPS fishing marks

## Fishing Sessions (trail import) — Phase 1 + 2, in progress

A new, separate concept from marks — derived from a Lowrance GPS trail
(GPX export, never `.usr` — see `parseGpxTracks`'s own comment,
`charts.js`, for why: even GPSBabel can't parse `.usr` v6 trail data,
while GPX's `<trk>` data is fully standard). The idea: dwell time (long
stationary stretches) is itself a real data point — "these conditions,
this spot, this duration → this many catches, possibly zero" — which
plain marks alone can never capture, since every mark is a success by
definition.

Built and verified in phases; phases 1–2 are done, phases 3–4 (point
editing/condition auto-fill, and actually saving Sessions anywhere) are
not yet built.

**Phase 1 — parsing and dwell detection** (`charts.js`):
- `parseGpxTracks` — reads every `<trk>`'s `<trkpt>` data, flattening
  `<trkseg>` boundaries (confirmed these don't line up with real trip
  boundaries in a real export — one file had 5 `<trk>` elements
  spanning 53 distinct calendar days between them), converting to the
  site's naive-time convention, and dropping the ~0.6% of points
  carrying Lowrance's `1970-01-01` placeholder timestamp (a real,
  confirmed data quirk, not a hypothetical).
- `deriveTrackDayGroups` — splits into real outings: by calendar day,
  and by any 45+ minute gap even within one day.
- `detectFishingSegments` — dwell detection: stationary within 100m for
  15+ minutes = "fishing"; everything else "transiting". Folds out
  segments shorter than 10 minutes, then merges any now-adjacent
  same-kind segments this folding leaves touching (confirmed directly:
  without this second merge pass, one real continuous 67-minute fishing
  stop was reported as two separate ones, split at an arbitrary
  one-second boundary). Handles a real anomaly gracefully — one group
  had 633 points sharing one identical timestamp (a logging glitch) —
  without dividing by zero.
- All three thresholds (gap/radius/window/minimum-duration) are
  starting values, not final — agreed up front that these need real
  calibration against actual trail data, not a one-shot guess.
- Verified directly against a real 53-day, 82,238-point trail export:
  produces 60 day-groups; a real 4.6-hour outing came back as a
  plausible transit→fish(121min)→transit→fish(67min)→transit→fish(14min)→transit
  sequence.

**Phase 2 — tree panel + map** (`sync.js`, `sync.html`):
- The SAME "Import from a device export" flow on the Sync tab, expanded
  — not a separate page. A GPX upload now parses tracks alongside
  marks (`.usr` is unaffected — marks-only, as always).
- A new "Fishing Sessions" section: a side tree panel (Track → Day →
  Segment → Start/End candidate points for each "fishing" segment) next
  to a Leaflet map scoped ONLY to this import's own data — no existing
  marks or tracked locations shown on it.
- Every level has independent Import/View checkboxes, tri-state
  (checked/unchecked/indeterminate) when children disagree, cascading
  down when toggled.
- The map draws each visible segment as a polyline (amber for fishing,
  grey for transiting) and each visible candidate as a clickable
  marker; clicking a candidate in the tree OR on the map highlights the
  same one in both places.
- **Verified**: uploaded the real 17MB/82,238-point trail file through
  the actual Sync page in a real browser — confirmed 5 tracks/60
  days/288 segments/246 candidates (123 fishing segments × start+end,
  always even) render correctly, 534 map shapes drawn, click-to-select
  works both directions, and checkbox cascade correctly propagates
  whatever value a parent was toggled to down to every descendant —
  zero JS errors throughout.

**Not built yet** (later phases): actually editing a candidate point's
fields (Start/Stop override, Bait/Rig/Rod/Berley carried forward,
Weather/Tide/Barometer auto-filled from the historical lookup already
used elsewhere), promoting an ordinary trackpoint to a new candidate,
linking a Catch mark into whichever segment its timestamp falls
within, and saving any of this anywhere — there is no Session data
model or backend endpoint yet.

**Phase 2 revision — layout, compact candidates, popup editing,
collapsible tree** (real feedback after using Phase 2, all fixed):

- **The map now dominates the page.** `sync.html`'s `<main>` picked up
  the `wide` class (1100px — the same one `index.html`'s Week Ahead
  Gantt chart already uses), and the map/side-panel split changed from
  a loose 3:1 flex ratio to a fixed 280px side column with the map
  taking every remaining pixel. Confirmed directly: went from a
  352px/300px near-even split (the old 720px-capped `<main>` combined
  with the side panel's own `min-width:300px` was forcing them level
  regardless of the flex ratio) to 752px/280px. Deliberately did NOT
  adopt the fully edge-to-edge `map-fullpage-body` pattern
  Location/Live use — this page has real non-map content above the
  review section (file upload, export controls) that needs to stay in
  normal padded-card layout, unlike those two pages which are entirely
  their own map.
- **Marks and tracks now share ONE section, one map, one side column**
  — the previous two separate `<section class="summary-card">` blocks
  ("Review candidates" and "Fishing Sessions") are now one, with two
  collapsible groups (Marks / Trail data) stacked in the same right
  column. `reviewMap`/`reviewMapLayer` replaced the track-only
  `trackMap`/`trackMapLayer` — the same map now draws both track
  polylines/candidates and hosts a mark candidate's edit popup.
- **Candidate mark rows are compact now** — checkbox, name, date, done.
  The entire inline edit form (Type/Species/Bait/Rig/Rod/Berley/
  Size/Barometer/Temperature/Water Temp/Depth/Wind/Notes/Released —
  one full copy per row) is gone from the list. Clicking a row instead
  opens that candidate's full edit form as a **map popup**, reusing
  `buildMarkPopupEditHtml`/`collectMarkFormValues`/
  `applyMarkFieldVisibility` (`charts.js`) directly — the exact same
  form the main marks map already uses, not a second hand-built copy.
  Save writes the result back into `candidates[]` and closes the
  popup; nothing reaches the backend from here — that still only
  happens later, for whatever ends up checked, when "Import selected
  marks" is clicked.
- **The Track → Day → Segment tree is now genuinely collapsible** —
  starts fully collapsed (a 60-day tree rendering all 288 segments and
  246 candidates flat, as Phase 2 originally did, was exactly the
  "busy looking list" this fixes). Each level has its own `expanded`
  boolean and a caret toggle; a transiting segment (no candidates
  under it) shows a disabled, hidden-visibility caret instead of a
  clickable one, since there's nothing to expand into.

**Verified**: re-ran the real 82,238-point trail file through the
actual Sync page. Confirmed the map/side-panel width ratio directly
(752px vs 280px), confirmed compact rows have zero inline `<select>`
elements, confirmed clicking a candidate opens exactly one popup form
and that editing+saving it correctly updates the compact row's own
text, and confirmed the tree starts with zero day/segment/candidate
rows in the DOM and correctly reveals one level at a time as each
parent gets expanded — zero JS errors throughout.

**Phase 3 — point editing** (`sync.js`): clicking a Start/Stop candidate
(tree row or map marker) now opens a real edit popup, on the same
shared map, at that point's own coordinates:
- **Kind** (Start fishing / Stop fishing) is editable — the design
  brief's own "able to override the auto-detection" — a plain label
  change, doesn't move the point or restructure the segment.
- **Bait / Rig / Rod / Berley are genuine multi-selects** — a real
  departure from how a mark's own single-value bait/rig/rod/berley
  works (marks only ever support one each), since one fishing stop can
  plausibly involve trying several. Carries forward: saving a value
  propagates it to every chronologically LATER candidate in the SAME
  day (across all its segments — flattened via `flattenDayCandidates`)
  that doesn't already have its own value there, stopping as soon as it
  reaches one that does (so going back and editing an earlier point
  never silently overwrites a more-recent explicit choice further
  along). Confirmed directly: setting Bait on a segment's Start point
  correctly appeared on its own End point afterward.
- **Weather/Tide/Barometer/Temperature/Water Temp/Wind Speed are
  auto-filled**, not carried forward — the exact same
  `lookupHistoricalMarkConditions` a Catch mark already uses, fired
  once per candidate (an own `historicalLookupDone` flag stops a
  re-open from spending a second billed WillyWeather call), shown
  editable only so a wrong auto-fill can be hand-corrected, not as the
  normal way of setting it.

**Verified**: real browser test (historical lookup stubbed — it hits
real external APIs, not what's under test here) confirmed opening a
candidate correctly auto-fills its weather fields, confirmed setting
Bait on a Start point and saving correctly carries it forward onto
that segment's own End point, and confirmed the Kind dropdown saves —
zero JS errors.

**Still not done**: promoting a raw trackpoint to a new candidate,
linking a Catch mark into whichever segment its timestamp falls
within, and any actual save/storage — still no Session data model or
backend endpoint at all; everything built so far only exists in this
page's own in-memory state until the browser tab closes. Also still
not done: marks candidates have no map markers of their own (they're
accessible via the list + popup-at-their-own-coordinates, not a
permanent pin) — worth flagging in case that's wanted later, since a
candidate list can run into the hundreds and a marker per one would
need its own clustering story, not something to add lightly.

**Phase 3 fixes — real timezone conversion, tree layout** (real
feedback after using Phase 3):

- **Trail timestamps are now converted to the browser's local
  timezone, not left as raw UTC.** A genuine, deliberate exception to
  this site's usual naive-time convention (digits already ARE local,
  no conversion — everywhere else on this site, including GPX
  waypoint marks) — confirmed directly that a Lowrance trail's own
  `<time>` is real UTC, hours off from local when read the same way.
  Converted once, in `parseGpxTracks` (`charts.js`), using the
  browser's own local `Date` getters rather than the UTC ones — `timeMs`
  itself stays a genuine UTC epoch (used only for relative gap/duration
  math, unaffected by timezone), only the derived `timeNaive` (what
  everything else — day-grouping, labels, the point-time display —
  actually uses) reflects local time. `deriveTrackDayGroups`'s calendar-
  day split benefits automatically, since it already grouped by
  whatever `timeNaive`'s own date digits said. Verified with an exact
  cross-check against a real point: raw UTC `00:57:51` correctly became
  `10:57:51` — exactly the +10h AEST offset for a September date (before
  Australian daylight saving starts).
- **Checkbox columns are now genuinely aligned, and the collapse caret
  moved to their right** — previously the caret came first and the
  checkboxes were just inline flex items, so both drifted with each
  tree depth's own indentation rather than forming a clean column.
  Each row's Import/View checkboxes now sit in their own fixed-width
  column (`.tree-checkbox-col`), with the caret and label in a
  separately-indented span after them — confirmed directly: a track
  row's own Import checkbox and a day row's own Import checkbox now
  render at the exact same x-position, regardless of the label's
  indentation.
- **Added a header row** ("Import" / "View") above the tree, in the
  same fixed-width columns, so it's clear what each tick actually does
  — this was in the original mockup but had been dropped along the way.

**Verified**: real browser test, with the browser's own timezone
forced to `Australia/Melbourne` — confirmed the exact +10h conversion
above, confirmed the header row reads "Import"/"View", and confirmed
a track row's and a day row's Import checkboxes align to the same
pixel x-position. Zero JS errors.

**Phase 3 fixes, round 2** (real feedback again):

- **Header text replaced with icons** — "Import"/"View" didn't fit the
  narrow side column comfortably. Both the tree header and marks list
  now use small inline SVGs instead (a floppy disk for Import, an eye
  for View — the same visual language other software already uses for
  these), letting `.tree-checkbox-col` shrink from 32px to 24px per
  column for a noticeably tighter fit.
- **The Marks list now has its own header too** — just the floppy
  disk icon, above its own (now aligned) checkbox column, matching the
  Tracks tree's own header styling rather than being the one list left
  unlabelled.
- **Transiting segments no longer show an Import checkbox at all** —
  they have no candidates and never will (nothing to import), so
  offering a checkbox that could never do anything was pointless
  clutter. Their View checkbox stays, since seeing the travel line
  itself is still useful. This surfaced a real logic gap while fixing
  it: a Day's own aggregate Import tri-state was counting every
  transiting segment as an "unchecked" contributor, meaning a day could
  never show as fully checked even when every one of its actual fishing
  segments was — fixed by excluding transiting segments from that
  specific aggregate entirely (`summariseChecked`), confirmed directly:
  a day with both kinds now correctly shows fully checked once its
  fishing segments are, unaffected by however many transiting ones sit
  alongside them.
- **`DWELL_RADIUS_METERS` dropped from 100 to 5** — Oliver's own call,
  to start tuning the dwell-detection threshold much tighter after
  seeing real segments at 100m look too generous. Confirmed the trail
  still produces real fishing segments at this radius (75 across the
  whole 53-day trail, down from before, as expected for a much
  stricter test) — not zero, so the algorithm still functions
  meaningfully at this setting, just more conservatively.

**Verified**: real browser test — confirmed the headers are icon-only
(no leftover text), confirmed a transiting segment has zero import
checkboxes but still has its view checkbox, confirmed a fishing
segment still has its import checkbox, confirmed a day containing both
kinds shows its Import checkbox as genuinely fully checked (not
indeterminate) once its fishing segments are, and confirmed the new
radius value is live. Zero JS errors.

**Phase 3 fixes, round 3**: `DWELL_RADIUS_METERS` raised from 5 to 10
(5 was too tight — Oliver's own call after trying it against real
days). Both header icon sets are now clickable, acting as a genuine
select-all/deselect-all toggle:

- The Marks header's floppy disk toggles every currently-reviewable,
  search-filtered candidate's own selection — `onToggleAllMarks`, using
  the exact same `reviewableCandidates`/`candidateMatchesSearch` scope
  the existing "Select all new"/"Deselect all" buttons already use, not
  a second definition of that scope.
- The Tracks header's floppy disk and eye each toggle their OWN field
  (Import or View) across the ENTIRE tree at once — `onToggleAllTracks`,
  cascading the opposite of whatever `summariseChecked` currently
  reports for the whole tree.

**A real bug this surfaced and fixed**: the very first version of the
tracks toggle-all did nothing when clicked, because `summariseChecked`
was still only excluding *transiting segments* from the "importChecked"
aggregate (see the previous round's fix) — it wasn't excluding a *day*,
or even a whole *track*, made entirely of segments with nothing
importable in them. With a tight dwell radius, plenty of real days have
zero fishing segments at all, and each one of those was still being
counted as "unchecked" in the whole-tree aggregate — so the tree could
never actually report "fully checked" even when every real fishing
segment already was, and clicking the toggle just silently re-selected
everything that was already selected. Fixed with a proper recursive
check (`hasAnyImportableCandidate`, walking Track → Day → Segment →
candidate) instead of the narrower segment-only filter — confirmed
directly: toggling now correctly flips all 93 real fishing segments'
Import state in one click, both directions.

**Verified**: real browser test — confirmed the new radius value is
live, confirmed the Marks header icon toggles selection for every
reviewable/filtered candidate and flips back on a second click,
confirmed the Tracks header's Import icon does the same across all 93
real fishing segments (catching the bug above before it shipped), and
confirmed the View icon ends in a fully consistent (not partially
mixed) state either way. Zero JS errors.

**Phase 4 — save/storage** (`schema-v2.sql`,
`migration-marks-session-and-berley-fix.sql`, `user-backend.js`,
`sync.js`): a Session is now a real, saveable thing — genuinely just a
mark with `type = "Session"`, not a separate table or save path, per
the original design brief's own call ("save those points as a new type
called Session").

- **A real, unrelated bug found and fixed along the way**: the marks
  table never actually had `berley` or `notes` columns at all, even
  though the client-side form has always collected both — every mark's
  Berley and Notes fields were being silently dropped on save,
  discovered only because Session points needed Berley to persist too.
  Fixed in the same migration.
- **Two new columns link a Session's pair**: `session_role` ('start' |
  'end') and `session_group_id` (shared by one segment's own Start and
  End row — what a future Location/Live map render will use to draw
  the connecting line between them). `insertOrUpdateMark`,
  `mergeMarkFields`, and `rowToMark` (`user-backend.js`) all extended
  to carry all four new fields through create, update, and read.
- **Bait/Rig/Rod/Berley are joined into a single string on save** — a
  Session candidate supports genuine multiple values for these (see
  Phase 3), but the marks schema only ever supports one value per
  field; rather than a schema change affecting every mark on the site,
  the values are comma-joined at save time (e.g. `"Pilchard, Squid"`)
  — good enough for display, not meant to be parsed back apart.
- **The existing "Import selected" button now saves both** — checked
  marks candidates AND every Import-checked session candidate point,
  in the same batch, through the exact same `saveMarksBatchToD1`
  (`charts.js`) every mark import already used; genuinely one save
  path, not two. After a successful save, saved session candidates are
  un-checked (not removed — the tree still shows the whole trail for
  context) so clicking Import again doesn't silently resave the same
  points.

**Verified**: the migration was checked against a simulated real
pre-migration marks table (confirmed the new columns apply cleanly and
an existing row is untouched); the extended insert was verified
directly against real SQLite. End-to-end: uploaded the real trail
file, isolated one real fishing segment, set a multi-select Bait value
on its Start point, clicked Import, and confirmed via the actual
mocked `/api/marks` POST calls that exactly 2 marks were sent, both
`type: "Session"`, sharing the same `sessionGroupId`, with Bait
correctly joined into `"Pilchard, Squid"` — and confirmed the saved
candidates were correctly un-checked afterward. Zero JS errors.

**Phase 5 — add a Catch/POI at any raw trackpoint** (`sync.js`):
clicking anywhere on a drawn trail line (not just an existing Start/End
candidate marker) now opens a small menu — "+ Add Catch here" / "+ Add
POI here" — per the design brief's own "allow us to add to a track
point a Catch or POI, this is a new GPS point, not the same track
point". Deliberately does NOT draw a marker per raw trackpoint (a
single day can have thousands — see `parseGpxTracks`'s own comment on
real point counts); one click handler on the line itself resolves the
click down to the nearest actual raw point (`nearestPointTo`, plain
distance comparison via the existing `distanceMetersBetween`).

Reuses the EXISTING marks-candidate machinery wholesale rather than a
second, Session-specific way to hold a promoted point — a newly-added
Catch/POI is pushed straight into the same `candidates` array marks
import already reviews, pre-filled with the clicked point's own
location and time, historical conditions looked up immediately (same
as every other reviewable candidate), and its full edit popup opens
right away (`openCandidatePopup`, unchanged) so species/etc. can be
filled in on the spot. It saves through the exact same "Import
selected" flow as any other mark — no new save path needed.

**Verified**: real browser test — clicked an ACTUAL rendered trail
polyline on the map (not a simulated event), confirmed the add-mark
menu appeared, clicked "Add Catch here", and confirmed exactly one new
candidate was added with the correct lat/lng/time and that its edit
popup opened automatically. Zero JS errors.

**Phase 6 — editing segment boundaries and inserting new Fishing
segments** (`charts.js`, `sync.js`, `sync.html`): the last big piece of
the Sync page itself.

- **Map zoom/highlight on click** — a Day's own label (not its caret,
  which only expands/collapses it) zooms the map to fit every point
  under that day; a Segment's own label zooms AND highlights it (drawn
  at weight 7 instead of 3 on the map) until another row is clicked.
- **Transiting ↔ Fishing conversion** — a small swap icon to the right
  of every segment row. Converting Transiting → Fishing creates
  Start/End candidates at that window's own extremes, ready to edit
  from there (Oliver's own design: "I will edit the start/end from
  there"); Fishing → Transiting discards its candidates. Deliberately
  NEVER auto-merges with whatever now sits alongside it either
  direction — Oliver's own call ("I may go from stationary fishing
  straight into trawling" — two adjacent same-kind segments can be a
  real, intentional distinction).
- **+/- buttons on every Start/End candidate row** ("− Start 11:38 +"),
  stepping that point ~1 minute later or earlier and reshaping the
  segment structure around it — the genuinely hard part of this whole
  phase. Moving a boundary either gives space to a neighbour (or
  creates a new Transiting segment if none exists) or takes space from
  one; when a move would touch a segment of the SAME kind, a
  confirm() dialog asks to merge (collapse into one, keeping the outer
  Start/End, dropping the two in the middle) or keep separate (any
  now-empty buffer between them still vanishes, but the two segments
  stay separate rather than merging).

**How the boundary-editing logic was built and verified** — worth
recording in full, since this was the highest-risk piece of the whole
Fishing Sessions feature: prototyped first in Python, then fuzz-tested
with 40,000 randomized edit sequences (500 seeds × 80 steps each),
checking full structural correctness (no gaps, no overlaps, every
"fishing" segment's own candidates in lockstep with its own
boundaries) after EVERY single step. That caught two real bugs before
they ever reached real code:
1. A same-kind adjacency could form silently — consuming a tiny middle
   segment and landing directly against a same-kind one beyond it —
   without ever triggering the merge prompt, only discovered (if at
   all) on some later click. Fixed so it's checked before the
   consumption happens, not after.
2. Shrinking a segment could silently extend a DIFFERENT, same-kind
   segment's own boundary without ever asking, since that segment has
   its own separately-tracked Start/End. Fixed so reclaimed space
   always becomes a new Transiting buffer instead of merging into a
   same-kind neighbour.

Only once the Python prototype passed 500 seeds cleanly was the logic
ported to real JavaScript (`stepCandidateTime`/`growSegmentBoundary`/
`shrinkSegmentBoundary`/`confirmBoundaryMerge`, `charts.js`) — then
fuzz-tested AGAIN, in an actual browser, for another 18,000 randomized
operations, zero failures, confirming the port itself introduced
nothing new.

**Verified further**: real browser tests against the actual trail file
confirmed clicking a day's label changes the map's bounds, clicking a
segment's label renders a visibly thicker (weight 7) highlighted line,
converting a Transiting segment to Fishing correctly changes the
segment-kind counts with no auto-merge, and — using a controlled
3-segment scenario (fishing / 1-point-transiting / fishing) matching
one of the algorithm's own verified test cases — clicking a real "+"
button correctly triggers exactly one confirm() dialog and, on accept,
correctly merges all 3 segments into 1. Zero JS errors throughout.

**Still not built**: linking a Catch mark into whichever segment its
timestamp falls within, and — the last planned phase — actually
drawing saved Sessions as connected lines on the Location/Live maps
(the data now persists correctly, but nothing outside the Sync page
renders it yet). Oliver's own call: Location/Live rendering waits
until the Sync page itself is considered done.

**Phase 6 fix — blank labels on newly-created Transiting segments**
(real bug, reported with a screenshot after using Phase 6): converting
two adjacent windows to Fishing, then using +/- to shrink one back
away from the other, correctly created a new Transiting segment
between them — but its own label was blank. Root cause:
`newTransitingSegment` set `label: ""` and nothing ever filled it in
afterward. Investigating turned up the same gap in two more places
that had gone unnoticed: neither `shrinkSegmentBoundary` nor
`growSegmentBoundary` updated a segment's own label after changing its
boundaries (so a Fishing segment's label could ALSO go stale after an
edit, just less visibly than a blank Transiting one), and
`confirmBoundaryMerge`'s "keep separate" path left the surviving
segment's label unrefreshed after it absorbed the deleted buffer.

Fixed with one shared `segmentLabel(kind, points, startIdx, endIdx)`
helper (`charts.js`) now called everywhere a segment's boundaries
change, rather than each site formatting this by hand (or forgetting
to) — `newTransitingSegment`, both branches of `shrinkSegmentBoundary`
and `growSegmentBoundary` (the segment being edited AND whichever
neighbour it just gave space to or took space from), and both
`applyMerge`/`applyKeep` in `confirmBoundaryMerge`. `sync.js`'s
`convertSegmentKind` also switched to the same shared helper instead
of its own separate copy of the same formatting logic.

**Verified**: re-ran the label-correctness check across 100 randomized
edit sequences (50 steps each) built on the same fuzz-testing approach
as the original algorithm, confirming no segment's label ever goes
blank or stale after any sequence of edits. Then reproduced the exact
reported scenario directly — two adjacent Fishing segments, shrinking
one to create a new Transiting segment between them — and confirmed
its label now reads correctly (e.g. "Transiting 13:19–13:20") instead
of blank.

**Phase 6 fix — converting a segment or using +/- reset the map's
zoom** (real bug, reported directly after using the label fix above):
`renderReviewMap` used to unconditionally re-fit the view to
everything currently visible on EVERY redraw — so zooming into a
segment, then converting it or clicking its first +/-, silently
snapped the map back out to the whole day, since both of those actions
redraw the map afterward. Confirmed exactly why: the segment-click
zoom handler called `zoomMapToSegment` (which correctly zooms in) and
then immediately called `renderReviewMap()` right after — which itself
always ended with its own `fitBounds` covering everything, undoing the
zoom one line later.

Fixed by making the auto-fit conditional — `renderReviewMap({
fitBounds: true })` only for the initial file load (where zooming to
show the whole trail IS the right first move) or when the map is being
created for the very first time; every other redraw (a checkbox
change, a conversion, a +/- edit, opening a popup) now redraws the map's
CONTENT only, leaving the camera exactly where it was.

**Verified**: real browser test against the actual trail file —
zoomed into a segment, converted a Transiting segment to Fishing, and
confirmed the zoom level stayed identical; then zoomed into a
(now-Fishing) segment and clicked its "+" button, confirming BOTH the
zoom level and the map's centre point stayed exactly the same
afterward. Zero JS errors.

**Phase 6 fix — hide +/- at a boundary, distinct colours per fishing
segment** (real feedback again):

- **A +/- button no longer renders at all when that move would be
  blocked** — `canStepCandidateTime` (`charts.js`) mirrors every one of
  `stepCandidateTime`'s own blocking checks (own paired candidate,
  already at the day's own edge, or — for a growing move — no segment
  at all on that side) without mutating anything, purely to decide
  whether to show the button in the first place. Oliver's own report:
  clicking a +/- that always failed, even though the failure itself
  was handled quietly, still somehow left the tree looking reset with
  no obvious cause — rather than chase that down, this sidesteps it
  entirely by never offering a click that couldn't do anything. A
  hidden (not removed) placeholder keeps both columns aligned.
- **Every fishing segment now gets its own random colour** — a fresh
  hue assigned once at creation (`randomSegmentHue`, `charts.js`,
  called from `buildTrackData`'s initial detection, a Transiting→
  Fishing conversion, and a boundary-edit merge) and kept stable
  afterward, rather than re-rolled on every redraw. Used both for that
  segment's own map line (`segmentLineColor`) and a matching light
  background tint on its own row in the tree (`segmentBackgroundTint`,
  applied via `segmentLabel`'s sibling helpers, `sync.js`) — so a
  fishing segment's line and its list entry are visually tied
  together, and distinct sessions are easy to tell apart at a glance.
  Transiting segments stay the fixed grey either way.

**Verified**: real browser test against the actual trail file —
confirmed 93 real fishing segments received 80 distinct random hues
(not one shared colour), confirmed the map actually draws that many
distinct line colours, confirmed a fishing segment's own row picks up
a matching background tint, and confirmed directly that a candidate
already sitting at the very edge of its day's own points renders its
blocked-direction button as non-clickable rather than present-but-
broken. Zero JS errors.

**Phase 7 — catch-linking**: the last piece of the Sync page itself.
A Catch mark whose own time falls inside a Fishing segment's own time
window, AND whose own location sits within `CATCH_LINK_RADIUS_METERS`
(1000m — Oliver's own starting value, tunable the same way
`DWELL_RADIUS_METERS` already is) of that segment's points, now shows
up nested under it in the tree — `findLinkedCatchIndices`, `sync.js`.

This is a purely computed relationship, recalculated fresh on every
render — nothing new is ever saved. A Catch never gains a "my segment"
field; a segment never gains a "my catches" list. The nested row is
the exact same underlying mark object from the flat `candidates` list
marks-import already reviews — its own checkbox toggles the same
`selected` property the Marks list itself reads, and clicking it opens
the exact same edit popup (`openCandidatePopup`) a Marks-list row
would, not a second, tree-specific view of it. Editing a Catch there
now also re-renders the tree (not just the Marks list), since a
change to its own time/location could affect which segment(s) it
links to.

Cardinality is asymmetric by design, confirmed directly with Oliver: a
day's segments partition time gaplessly with no overlap, so one
catch's own timestamp can only ever fall inside one segment's window
on its own — but as an explicit fallback (in case two different days'
time ranges ever coincide, or a data anomaly slips through), a catch
that matches more than one segment links to ALL of them, not just the
first found. Only Fishing segments get anything nested under them —
Transiting never does.

**Verified**: real browser test against the actual trail file —
confirmed the real dataset's own marks and trail timestamps come from
genuinely unrelated sources (established earlier in this project), so
a real-world match isn't guaranteed to exist by chance; injected a
Catch directly onto a real segment's own path and time, confirmed it
rendered as a linked-catch row, confirmed toggling its checkbox in the
tree updated the SAME candidate object the Marks list reads, and
confirmed clicking it opened the same shared edit popup. Separately
constructed the explicit multi-segment fallback case directly and
confirmed a matching catch links to every matching segment, not just
one. Zero JS errors.

**Phase 7 addendum — persisting a loaded-but-unsaved review across
page navigation** (`sync.js`): a real, reported gap. This site is
genuinely multi-page (every "tab" is its own HTML file), so clicking
Location/Live/anywhere else and back is a real page reload — every
plain JS variable, `candidates`/`trackData` included, is gone the
instant that happens. Checking something on another tab mid-review
meant losing every edit and re-uploading from scratch.

Fixed with IndexedDB, not sessionStorage/localStorage — deliberately:
a genuinely large real trail's own raw points alone already run to
several megabytes (confirmed directly against the actual 82,238-point
trail used throughout this feature's own testing), close to or past
what browsers typically allow the synchronous Web Storage APIs.
IndexedDB's quota is far larger, and it stores structured JS values
natively with no manual serialize/parse step. A debounced save
(`schedulePersistReviewState`) is hooked into the two shared render
functions (`renderReviewList`/`renderTracksTree`) rather than scattered
across every individual mutation site — since nearly every place that
changes `candidates` or `trackData` already calls one or both of those
right afterward, this one hook covers essentially all of them. On page
load, any persisted review is restored automatically, with a status
message naming when it was last saved; a new "Clear saved review"
button (shown whenever there's something to clear) discards it
explicitly, with a confirmation first.

**Verified**: real browser test — uploaded the real trail file, made a
specific edit, confirmed IndexedDB held it, then did exactly what was
reported: navigated to a genuinely different page load of the same
URL (not just a re-render) and confirmed that SPECIFIC edit survived,
the review section was visible again, and the "Clear saved review"
button appeared. Then confirmed clicking that button actually cleared
IndexedDB and hid the review section. Zero JS errors.

**A console diagnostic for catch-linking questions** — reported
directly: two real catches ("Chelsea gummy"/"Chels gummy") expected to
link into a loaded track weren't showing up, with no way to see why
from the UI alone. Added `diagnoseCatchLinking(nameSubstring)`
(`sync.js`, attached to `window` — run from the browser console, not
part of the normal UI), which finds every candidate whose name
contains the given substring (case-insensitive — one call matches
both "Chelsea gummy" and "Chels gummy") and reports, for each: whether
its own type is actually "Catch" at all, and for every currently-
loaded Fishing segment, whether its time falls inside that segment's
window and — if so — exactly how far away it is, so a near-miss on
distance (confirmed, via testing, to be a real and likely cause) is
visible directly instead of a bare "not linking" with nothing to go on.

**Verified**: real browser test constructed three deliberately distinct
cases against the real loaded trail — a catch placed directly on a
real segment's own path and time (confirmed it reports a genuine
link), the same time but 5–6km away (confirmed it reports a clear
distance near-miss with the actual metres shown), and a POI instead of
a Catch (confirmed it reports the type mismatch plainly). Also surfaced
something worth knowing directly: the real uploaded file already has
roughly 200 marks named "Gummy Shark", so searching a bare substring
like "gummy" will report on all of them at once — a more specific term
("Chelsea", "Chels", or the full name) avoids that noise in practice.

**Phase 7 fix — catch-linking never actually checked already-saved
marks** (real bug, reported directly with a console screenshot and a
mark popup): "Chelsea gummy"/"Chels gummy" — real catches that should
have linked to a loaded track — turned up nowhere, including in the
`diagnoseCatchLinking` tool itself. The mark's own popup gave it away:
`Source: Manual`, with Edit/Copy/Delete buttons — an already-saved
mark, logged the ordinary way through the Location/Live map, never
part of this GPX import's own `candidates` list at all. Both
`findLinkedCatchIndices` and `diagnoseCatchLinking` only ever searched
`candidates` — an already-saved mark was structurally invisible to
either one, no matter how well its actual time and location matched.

Fixed by searching `existingMarks` (every mark already in D1, loaded
once at page init for the existing dedup logic) as well as
`candidates` in both places — `findLinkedCatchIndices` now returns
`{source, idx}` pairs so the caller knows which list `idx` indexes
into, since the two need different treatment: a `candidate` match
still shares its checkbox/click with the ordinary Marks-list row; an
`existing` match has nothing to import (it's already saved) — shown
with a "(saved)" tag and no checkbox at all. Clicking it opens a
deliberately simple, read-only popup (`openExistingMarkViewPopup`)
rather than the main map's own full Edit/Copy/Delete flow
(`buildMarkPopupViewHtml`/`wireMarkPopupButtons`) — that flow is
tightly coupled to the main map's own state (`markerLayer`/
`marksById`/`markersById`, a real persistent marker per mark), none of
which this page has; building a second, parallel version of all that
just for this one read-only case wasn't a reasonable trade. The
read-only popup points to the Location/Live tab for any actual edit
or delete.

**Verified**: real browser test — injected an already-saved mark
(`source: "Manual"`, matching exactly what the real report turned out
to be) directly into `existingMarks` at a real segment's own path and
time, confirmed `diagnoseCatchLinking` now finds it and reports a
genuine link labelled "existingMarks (already saved)", confirmed
`findLinkedCatchIndices` returns it with `source: "existing"`,
confirmed its tree row renders with zero checkboxes and a "(saved)"
tag, and confirmed clicking it opens the read-only popup (not an edit
form). Zero JS errors.

**Phase 8 — Location/Live map rendering**: the last planned phase.
`loadAndRenderMarks` (`charts.js`) already loads and renders every
Session mark exactly like any other mark — same cluster group, same
popup, same generic Edit/Copy/Delete via `wireMarkPopupButtons`/
`deleteMarkFromD1` (keyed only by mark id, with no type-specific
handling needed at all). The one genuinely new piece: two separate
markers don't imply a connecting line between them on their own.

`renderSessionLines` groups every loaded `type: "Session"` mark by its
own `sessionGroupId`, and for each group with BOTH a `start` and an
`end` present, draws a dashed line between them (a separate, plain
layer — not inside the marker-cluster group, since a session's own
start/end can sit a real distance apart and clustering shouldn't apply
to the line itself). A group missing one side (the other half deleted,
or only one side ever imported) simply draws no line for it — not an
error, just nothing to connect.

Deleting a mark now also re-runs `renderSessionLines` — confirmed this
was necessary directly: without it, deleting one side of a pair left
the line still pointing at a now-nonexistent mark. Recomputed fresh
from whatever's left in `state.marksById` rather than tracked
incrementally — simple and correct regardless of which half got
deleted, and cheap enough at real mark counts since this only runs on
a deliberate delete action, not on any hot path.

**Verified**: built an isolated test harness (`loadAndRenderMarks`
doesn't need the full Location/Live page, just a real Leaflet map and
its own `state` object) with a real Start/End pair, an intentionally
orphaned Start with no matching End, and an ordinary Catch mark mixed
in. Confirmed a real connecting line rendered between the matched
pair, confirmed the orphan drew nothing and caused no error, then
deleted the Start side of the real pair through the actual Delete
button (via `showMarkerOnceVisible` — a marker inside a cluster isn't
individually poppable until shown, the same real constraint this
codebase already worked around once before for exactly this reason)
and confirmed the line disappeared correctly, while the underlying
mark itself was genuinely removed through the same generic delete flow
every other mark already uses. Zero JS errors.

**That's every phase of Fishing Sessions now built**, from the
original design brief through to this one: parsing and dwell
detection, the tree/map review UI, point editing, save/storage,
adding a Catch/POI at any trackpoint, segment boundary editing,
catch-linking, and now Location/Live rendering.

**Session added to the Mark Type filter** (`migration-session-mark-
type.sql`): the map's own Filters modal (`showMarkFilterModal`,
`charts.js`) only ever shows Mark Type values actually registered in
the Settings-tab pick-list (`user_mark_lists`, `field = "Mark Type"`)
— Session marks already rendered correctly, but "Session" itself was
never added there (it's only ever been a raw string used
programmatically by the Sync page's own save flow), so there was no
way to filter them in or out like any other type. Fixed with a
migration alone — no code change needed at all, since filtering
already works generically off whatever's in the pick-list.
Idempotent (`INSERT OR IGNORE` gated on an existence check) — safe to
run more than once.

**Verified**: real browser test — confirmed "Session" now appears as
a filterable chip under Mark Type, confirmed excluding it via the
filter hides Session marks from the map while leaving other mark
types (a regular Catch, in the test) untouched, matching how every
other Mark Type value already behaves. Zero JS errors.

**Sequence numbers on Fishing sessions** (`sync.js`): "Fishing
11:14–11:57" becomes "Fishing 1 11:14–11:57" — numbered per day, in
time order. `computeFishingSequenceNumbers` computes this fresh every
render rather than storing it on the segment, so it's automatically
correct after a conversion or merge changes how many fishing segments
exist, without needing to touch every one of the many places segments
themselves change. The same numbers, computed the same way, are used
when naming a saved Session ("Session 1 start"/"Session 1 end") — what
gets saved always matches exactly what was on screen at the moment of
saving.

**Verified**: real browser test against the actual trail — confirmed
displayed labels are correctly numbered in time order, confirmed
converting a Transiting segment to Fishing correctly renumbers every
segment after it, and confirmed 188 real saved Session marks were all
named following the exact "Session N start/end" pattern. Zero JS
errors.

**A real, reported carry-forward bug, fixed**: converting a Transiting
segment to Fishing between two already-linked Fishing segments (so
three end up in a row), then editing the new middle one's own Bait/
Rig/Rod/Berley, couldn't make that new value flow through to the last
segment — it kept showing whatever had carried forward from the
FIRST segment instead. Root cause: `propagateCarryForwardFields`
stopped propagating a field the instant it found ANY non-empty value
further along, treating "has a value" as "deliberately set for this
point" — but a value that arrived via an EARLIER propagation pass
isn't a deliberate choice for that specific point, just inherited
stale, and the newly-converted middle segment's own fresh value
correctly should have overwritten it. Fixed by tracking genuine
explicitness separately, per field (`baitsExplicit`/`rigsExplicit`/
`rodsExplicit`/`berleysExplicit`) — set only when a candidate's OWN
popup is saved with a non-empty value for that field, never by
propagation itself; only a genuinely explicit value blocks further
propagation now, a merely-inherited one gets freely overwritten as
propagation continues past it.

**Verified**: reproduced the exact reported scenario directly — two
Fishing segments (A, C) with a Transiting (B) between them; set A's
Bait explicitly (correctly propagates to C, since B has no candidates
yet); converted B to Fishing (fresh, non-explicit, empty candidates);
set B's own Bait to a different value — confirmed it now correctly
flows through B's own End and all the way into C's Start/End,
replacing the previously-stuck stale value from A.

**Location/Live: selecting either half of a session highlights both,
and the line between them** (`charts.js`): clicking a Start or End
marker now highlights BOTH markers in the pair (a bigger, brighter
purple ring) and draws their connecting line noticeably thicker and
fully opaque, so a session reads as one thing at a glance rather than
two pins that happen to share a line somewhere nearby
(`highlightSessionPair`/`clearSessionHighlight`, hooked into
`loadAndRenderMarks`'s own `popupopen`/`popupclose` handlers). Clears
back to normal the moment the popup closes.

**Delete either half, delete the pair**: Oliver's own call, especially
useful while test-importing and cleaning up repeatedly — deleting
either a Session's Start or its End now finds and deletes its own pair
too, in the same action, with an updated confirmation message naming
this explicitly ("Both its Start and End are deleted together").
Handles the edge case where the first delete succeeds but the pair's
own delete fails — reported plainly rather than silently left
ambiguous, since the first one is already gone by that point and
there's no sensible way to undo it automatically.

**Verified**: built an isolated test harness with a real Start/End
pair plus an unrelated Catch mark. Confirmed opening Start's popup
highlights BOTH markers (not the unrelated Catch) and thickens the
connecting line; confirmed closing the popup restores every marker's
normal style; confirmed the delete confirmation names the pair
explicitly; and confirmed deleting Start actually deletes both Start
and End together (leaving the unrelated Catch untouched) and removes
the now-orphaned line. Zero JS errors.

**Sync page label format tweak**: "Fishing 1 11:14–11:57" ->
"Fishing 1 (11:14–11:57)" — the sequence number stays outside the
parentheses, the time range moves inside. Verified directly: the
regex correctly produces `Fishing 1 (11:14–11:57)` from the underlying
`Fishing 11:14–11:57` label.

**A Location/Live spiderfy bug flagged, diagnosed, not caused by
this feature**: reported directly — a session point that had been
selected once showed no tooltip and wasn't clickable afterward. My own
first theory (that highlighting a marker's radius via `setStyle`
somehow corrupted a diamond/cross shape's own custom geometry) turned
out to be wrong on closer inspection — Leaflet 1.9.4's own
`CircleMarker.setStyle` already extracts and applies `radius`
correctly, confirmed directly against the real vendored source, not
just assumed. Real diagnostic answers narrowed it down properly
instead: reloading the page does NOT fix the affected point (rules out
anything to do with this session's own highlight/clear-highlight
code, which can't have run yet on a fresh load, before any selection
has happened), it happens to every session point once selected, and —
the key detail — it's consistently the marker sitting at the "10
o'clock" position once a cluster is expanded/spiderfied, regardless of
which cluster. This points at Leaflet.markercluster's own spiderfy
positioning logic (or its interaction with vector-shape markers at a
specific leg position), not at anything built for Sessions. Parked
for its own dedicated investigation, at Oliver's own request, while
the side panel below was built instead.

**Location/Live: mark editing moved into a fixed side panel, not a
floating popup** (`charts.js`, `conditions.html`, `live.html`,
`style.css`): real, reported friction — a Leaflet popup floats right
above whatever's clicked, and with a busy map (Session lines, nearby
marks), the popup could easily bury the very point — and its
neighbours — someone was trying to look at.

Rather than rewrite `wireMarkPopupButtons` (a large, shared function
with several places that call real Leaflet popup methods — `setPopupContent`,
`closePopup`, a full popup-recreation branch when a mark's Type changes
its own shape) to stop depending on Leaflet's popup system altogether,
the popup's own DOM element is reparented — moved, not copied — into a
new fixed `#markDetailPanel` the moment it opens (`attachPopupToDetailPanel`).
Since it's the same node, every listener already wired onto it (Edit,
Copy, Delete, Save, Cancel — all of `wireMarkPopupButtons`'s own logic)
keeps working completely untouched; only where it visually lives
changes. `autoPan` is turned off on every mark popup now, since
Leaflet's own auto-pan-to-keep-the-popup-visible logic assumes the
popup is still floating near the marker — left on, it would compute
nonsense offsets (and could visibly jerk the map) once the popup is
actually sitting in the fixed panel instead. `detachDetailPanel` hides
the (now-empty, Leaflet cleans up the element itself on close) panel
again once the popup closes. Covers both an existing mark being edited
and a brand-new, not-yet-saved draft (`startNewMarkEntry`) — both flow
through the exact same `popupopen` handler.

The panel sits to the right of the map on wider viewports, matching
the request directly, and drops below the map (capped to under half
the screen height) on narrow ones, where there simply isn't room for
both side by side.

**Verified**: built a real test harness using the actual page markup
and CSS (not a stub), confirmed opening a mark moves its popup content
genuinely inside `#markDetailPanel` (and confirmed it's no longer
sitting in Leaflet's own floating popup pane at all), confirmed the
panel sits to the right of the map without overlapping it, confirmed
Edit → change a field → Save still works correctly end to end, confirmed
Delete still works and the panel hides itself again afterward, confirmed
a brand-new (unsaved) mark also opens in the panel rather than floating,
and confirmed the panel correctly stacks below the map instead of
beside it at phone width. Zero JS errors throughout.

**Side panel: three real bugs it introduced, all reported directly
with screenshots, all fixed**:

1. **Filter box now overlapping the panel** — `.mark-controls-bar`
   (Colour by / Filters) used to float over the map's top-right corner,
   which is exactly where the new side panel now permanently lives
   whenever a mark is open. Moved to the top-left instead, positioned
   to clear Leaflet's own default zoom control (`left: 55px`, roughly
   matching that control's own width plus a clean gap) rather than
   collide with either it or the panel.

2. **Popup content needing horizontal scroll inside the panel** — a
   real, subtle bug, confirmed directly rather than guessed at: `.leaflet-popup`'s
   `position: static` override (to pull it into normal document flow
   inside the panel) was correct, but Leaflet ALSO leaves a
   `transform: translate3d(...)` inline style on the same element for
   its own floating-over-the-map positioning — and a CSS transform
   applies regardless of `position` value, unlike `margin`/`left`/`bottom`
   (which genuinely do stop applying once `position` is `static`).
   Measured directly: every individual piece of content inside the
   popup fit comfortably within the panel's own width on its own — the
   whole popup element itself was simply being dragged several hundred
   pixels sideways by that leftover transform, which is what was
   actually inflating the panel's scrollable width. Fixed with
   `transform: none !important` alongside the existing `position`/`margin`
   overrides.

3. **The Live tab's own conditions-graph panel getting squeezed to a
   sliver** — investigated directly with a real test rather than
   patched blind: the hover panel's own width measured completely
   correctly (full width) even with the mark panel simultaneously open,
   so the two panels' CSS isn't actually fighting over layout the way
   it first looked. The more robust fix — and arguably the right
   behaviour regardless of the exact cause — was to make the two
   mutually exclusive: opening either one now closes the other
   (`closeMarkDetailPanel`, charts.js, wired into both
   `showLocationHoverPanel`/`showLiveHoverPanel`; and the reverse,
   `attachPopupToDetailPanel` now closes whichever hover panel exists
   on the current page). They were never meant to compete for the same
   screen space at once.

**Verified**: real browser tests, all three together — confirmed the
filter box now sits clear of both the zoom control and the panel area;
confirmed the popup's own `scrollWidth` now matches the panel's
`clientWidth` almost exactly (340 vs 339, down from 940 before the
fix); confirmed opening the hover panel closes the mark panel and vice
versa, in both directions. Then re-ran the full existing side-panel
regression suite (Edit → Save, Delete, new-mark creation) to confirm
none of it broke along the way — all still pass. Zero JS errors
throughout.

**Side panel: a fourth bug, same underlying cause as the width one**
— reported directly: in edit mode, the panel's own scrollbar stopped
about three-quarters of the way down, well short of the panel's real
bottom. `.mark-popup-leaflet .leaflet-popup-content` carries a
`max-height: 60vh` — genuinely needed for a FLOATING popup (so a tall
edit form can't render partly off-screen with the Save button
unreachable), but once that same content sits inside
`#markDetailPanel` (which already provides its own full-height scroll
area), the old 60vh cap was still capping the content to 60% of the
*viewport* height, on top of the panel's own scrolling — so the
panel's scrollbar only ever reflected that truncated inner box, never
the panel's actual height. Fixed with a second, more specific rule
(`.mark-detail-panel .mark-popup-leaflet .leaflet-popup-content {
max-height: none; overflow-y: visible; }`) that naturally outranks the
first by specificity — no `!important` needed here, unlike the width
fix, since this is two stylesheet rules settling by normal cascade
rules rather than fighting a leftover inline style.

**Verified**: real browser test with a deliberately tall viewport
(1000px — this is what makes the bug visible; a short window can
hide it), switched a real mark into edit mode, confirmed the cap's
computed `max-height` is now `none` inside the panel, and confirmed
the form's own content genuinely extends to ~1129px — far past where
the old 600px (60vh of 1000px) cap would have cut it off. Screenshot
confirms the full form now visibly fills the panel using its own
scrollbar, all the way down to the last field. Zero JS errors.

**The 10 o'clock spiderfy bug — root-caused and fixed** (`charts.js`):
reported directly, with a screenshot pinpointing the exact broken
point — a spiderfied marker with no tooltip and no click response,
consistently at one particular leg position, across different
clusters. Reproduced properly this time (earlier attempts were mostly
lost to fumbling live-map navigation, not the bug itself): a real
2-marker cluster, spiderfied open, showed one leg rendering with
literally zero width and height — nothing there to hover or click —
while the exact same setup using SVG rendering instead of this map's
usual Canvas renderer never showed it, run after run. Canvas exists
here specifically for performance at real scale (a couple thousand
marks), so the fix isn't "switch everything to SVG" — it's a small
SVG-rendered stand-in drawn on top of a marker for exactly as long as
it's actually spiderfied open, for every spiderfied marker, not just
whichever one happens to fail at that moment (the failure wasn't
reliably tied to one specific marker or position — only to Canvas
rendering during spiderfy in general). Clicking the stand-in fires a
real `"click"` on the ORIGINAL marker, so Edit/Delete/etc. all operate
on the exact same marker and mark object as ever, completely
unchanged.

Two real implementation bugs turned up and got fixed along the way,
not just the rendering one:
1. The `spiderfied`/`unspiderfied` events fire on the marker cluster
   group itself, not the map — confirmed directly against the actual
   plugin source (traced the minified variable to `this._group` in
   both the animated and non-animated spiderfy code paths) after an
   incorrect first guess.
2. The stand-in's own click was bubbling up to the map, where
   Leaflet.markercluster's own "clicked somewhere outside the
   spiderfied set" handling treated it as exactly that and immediately
   collapsed the spiderfy — closing the popup the same click had just
   opened, one event later, so the click looked like it silently did
   nothing. Fixed with `L.DomEvent.stopPropagation`.

**Verified**: real browser tests — 6 fresh trials, each its own clean
page load at a different location, confirmed both spiderfied legs
visible (non-zero size) and clickable in all 6, zero JS errors across
any of them. Separately confirmed both markers show their own correct,
distinct tooltip on hover (matching the exact reported case — "Session
3 start"/"Session 3 end"). Then confirmed normal, non-clustered marker
click/edit still works completely unchanged, with the new listeners in
place.

**Round two — the first fix wasn't actually enough**: reported back
directly, with a real screenshot of a larger (6-7 marker) cluster,
that "1 and 11 o'clock" were still unclickable even with the fix
applied. Reproduced properly this time with 3+ marker clusters (the
first round's testing only ever covered 2) and found a genuine second
bug: a leg close enough to the cluster's own original centre stayed
unclickable even with a correctly-sized, correctly-positioned overlay
sitting right there. `elementFromPoint` at that exact spot showed why —
the cluster's own icon (a plain HTML DIV, left in the DOM at the
original centre for the whole time a cluster is spiderfied open — the
faded circle visible in the middle of the screenshot) lives in
Leaflet's `markerPane`, which sits ABOVE the plain `overlayPane` an SVG
renderer uses by default, in Leaflet's own fixed pane ordering.
`bringToFront()` only reorders layers WITHIN one pane, so it could
never have won against a different, higher pane no matter how or when
it was called — the first fix's `bringToFront()` call was addressing
the wrong problem entirely for this specific case. Fixed by giving the
overlay its own dedicated pane, created explicitly above `markerPane`
(600) but below `tooltipPane` (650) in Leaflet's own numbering — high
enough to always win against the cluster's own lingering icon, without
outranking an actual tooltip.

**Verified**: reproduced the exact regression with a 3-marker cluster
first — confirmed one leg genuinely unclickable, confirmed via
`elementFromPoint` that the cluster's own centre icon DIV was the
element actually receiving the click — then confirmed the pane fix
resolves it (all 3 legs clickable, `elementFromPoint` now correctly
resolves to the overlay itself at all 3 positions). Scaled up to a
7-marker cluster matching the screenshot's own scale — all 7 legs
visible and clickable, zero JS errors. Re-ran the original 2-marker
case to confirm no regression there either. One separate, pre-existing
quirk surfaced along the way and deliberately left alone rather than
folded into this fix without asking first: two markers close enough
together can show both of their tooltips at once on hover, rather than
just the one being pointed at — not the bug that was reported (which
was "no tooltip at all", not "the wrong one too"), and not something
this fix's own code touches (tooltip binding/positioning is completely
unchanged) — more likely something that was always there and simply
harder to notice while one of the two markers was invisible to begin
with. Flagging it rather than fixing it unprompted.

### Settings page: "View as Public" not remembered across reloads (locationsadmin.js)

Reported directly as "not loading any of my settings — missing mark
lists etc", with a screenshot showing Mark Type/Species genuinely
empty and a failed Check Frequency load. Investigated live rather than
guessed at: the Mark Type/Species fetch itself was actually succeeding
(200) — the real cause was that `viewingAsPublic` was a plain variable
that always reset to `false` on every fresh page load, with no memory
of which side was last chosen. Since virtually all of this site's
actual configured data (mark lists, tracked locations, etc.) lives
under Public rather than the Admin's own account, reloading this page
always landed back on the Admin's own, genuinely near-empty account —
looking exactly like real data had gone missing, when clicking "View
as Public" the whole time would have shown it was there all along.

Fixed by persisting the choice to `localStorage`
(`VIEWING_AS_PUBLIC_STORAGE_KEY`), the same pattern already used for
every other per-browser preference on this page — restored once, the
first time `isAdmin` is known to be true on a given page load, so it
doesn't fight with an in-progress toggle on later calls to the same
refresh function (sign-out, or the toggle button itself).

**Verified**: real browser test — confirmed a genuinely fresh load
(no persisted state) still defaults to the Admin's own account,
unchanged from before; confirmed toggling to Public and reloading now
correctly stays on Public instead of resetting; confirmed toggling
back to "my account" and reloading again correctly stays there too,
so this isn't just a one-way stuck state. Zero JS errors.

Separately, live network inspection also turned up a real `503` from
`GET /api/settings` specifically (every other endpoint on the same
page load — `/api/marklists`, `/api/tracked-locations`,
`/api/admin/users`, etc. — succeeded). `handleSettings`
(`user-backend.js`) has no code path that returns a 503 explicitly, so
this is most likely a transient Cloudflare Worker or D1-level issue
rather than an application bug — not something diagnosable further
without the Worker's own server-side logs. Worth watching for whether
it recurs; flagged here rather than guessed at.

### Mark-editing dropdowns only ever showed Public's own options (charts.js, sync.js)

Reported directly: moving a Rod option from Public's account to the
signed-in Admin's own (via the Settings page's Mark Lists editor,
using the "View as Public" toggle fixed just above) made it vanish
from the Rod dropdown entirely when editing a Catch — regardless of
which account a given option actually lives under, every mark-editing
dropdown (Species/Bait/Rig/Rod/Weather/Tide/Water/Berley/Mark Type,
wherever they appear) should show all of them.

Root cause: both `loadAndRenderMarks` (charts.js — Location/Live) and
the Sync page's own init (sync.js) only ever fetched
`/api/public/marklists` — Public's own list, and nothing else. Fixed
with one shared helper, `fetchUnionedMarkLists` (charts.js): fetches
Public's own list AND the signed-in Admin's own personal list (`/api/
marklists`, omitting `?userId=` so it resolves to the current
session's own user), merged by field+value, with the Admin's own copy
winning on a genuine clash between the two — more likely to be the
intentionally-current one, having just been curated or moved there.
Both call sites already only ever run once an admin session is
confirmed (`cachedIsAdmin`/`canSync()`), so the authenticated half of
this fetch is always reachable, never a 401.

**Verified**: real browser test reproducing the exact reported
scenario — a Rod option on Public's own list, a DIFFERENT Rod option
on the Admin's own — confirmed `state.markLists` contains the union of
both, and confirmed the actual, real Rod `<select>` inside a real edit
popup shows both options together. Separately confirmed sync.js's own
`markLists` variable gets the same union. Zero JS errors.

### Clustering when marks overlap (Leaflet.markercluster)

With a couple thousand real marks, plenty of them sit close enough
together (the same popular spot, visited many times) to overlap and
become unclickable at anything but the closest zoom. Every mark marker
now lives inside one `L.markerClusterGroup` (`state.markerLayer`,
`loadAndRenderMarks`, `charts.js`) instead of being added to the map
directly. Clicking a cluster zooms in; at the closest zoom a cluster
can't split any further, it "spiderfies" instead — arranging the
individual marks in a spider-leg pattern radiating out from the
cluster, each independently clickable. Loaded via CDN
(`unpkg.com/leaflet.markercluster@1.5.3`),
same pattern as Leaflet itself.

**Cluster icon design — satellites, not a single number.** Rather than
one aggregate count, a cluster's icon breaks down into small
"satellite" shapes arranged around a centre — one satellite per
distinct (shape, colour) combination actually present among its marks
(POI/Mark/Catch's own shape × whatever the current "Colour by" field
resolves to), each with a small count badge when more than one mark
shares that exact combination (`createMarkClusterIcon`,
`markShapeToCssHtml`). Shows roughly WHAT'S in a cluster at a glance,
not just how many, without zooming in first. Capped at
`MAX_CLUSTER_SATELLITES` (6) distinct combinations — a cluster spanning
a dozen species collapses its smallest groups into one grey "+N"
overflow satellite rather than turning into an unreadable ring of
slivers.

Reads each child marker's shape straight off `_markShapeName` (tagged
once at creation, in `createMarkShapeLayer` — safe, since a mark's
shape never changes in place; changing it means creating an entirely
new marker instance) and its CURRENT colour straight off
`marker.options.fillColor` (kept live by `setStyle` whenever "Colour
by" changes, so a cluster's satellites always match what's actually
selected, not whatever was current when a mark was first loaded).

**Verified**: a real headless-browser test with 6 marks — 3 POI
(diamond), 2 sharing one species/colour, 2 Catch (cross, different
species), 1 Mark (circle) — confirmed exactly 5 satellites rendered
(6 marks, 5 distinct shape+colour combinations) with exactly one badge,
showing "2", on the pair that actually shares both shape and colour —
confirmed visually via screenshot too. The overflow path (>6 distinct
combinations) is reasoned-through and straightforward but wasn't
separately exercised with live test data.

**Every other place a mark marker gets added to or removed from the
map** — delete, cancel, the "Type changed to a different shape"
mid-edit case, and the species/tide/etc filter toggle
(`applyMarkFiltersAndGrouping`) — now goes through this same cluster
group instead of the map directly, so nothing falls outside its
clustering.

**Two real bugs this raised, found from actual use — not caught by the
original testing, both fixed:**

**1. Copying or creating a mark left its Save button completely
unwired — clicking it did nothing at all.** The original fix for "a new
marker can land inside an existing cluster with no visible pin to pop
up from" used the cluster group's own `zoomToShowLayer(marker,
callback)`. That callback turned out to be unreliable in a way that
went undetected until a real report: it's a confirmed, long-standing
Leaflet.markercluster bug — internally it only fires once a layer has
an `_icon` DOM property, which is an `L.Marker`-only thing. Every mark
here is an `L.CircleMarker` or a custom Path shape (never a plain
`L.Marker`, needed for the Canvas rendering this whole layer depends on
at real-world scale), so that callback silently never ran — meaning
`openPopup()` and `wireMarkPopupButtons()` inside it never ran either.
The popup itself could still open in some cases (Leaflet's own default
click-to-open-popup behaviour doesn't depend on this callback), but
nothing had ever attached a listener to its Save button.

Replaced with `showMarkerOnceVisible` — checks `marker._map` directly
(a plain, standard Leaflet property, true only when a layer is
genuinely rendered right now, not hidden behind a cluster icon) instead
of trusting the plugin's own visibility-checking, which has the exact
same `_icon`-dependent flaw (confirmed directly: `getVisibleParent`
returns `null` for these marker types regardless of actual visibility,
for the same reason). Still calls `zoomToShowLayer` for its real zoom/
spiderfy side effect, just never trusts its callback — polls
`marker._map` afterward instead, with a 3-second ceiling before giving
up and running the callback anyway rather than leaving a popup
permanently unwired.

**2. Clicking to close an open mark's popup also started a second,
unrelated action at that same spot** — accidentally clicking off an
open edit form closed it AND immediately triggered "what's here? new
mark, or view location data?" for that same click. Fixed in
`renderLeafletLocationMap`: Leaflet fires a `preclick` event just
before `click`, and before an about-to-be-dismissed popup actually
closes — checking whether a popup is open at `preclick` time reliably
identifies "this click's real purpose is dismissing that popup", even
though by the time `click` itself fires the popup has already closed.
That one click is now suppressed from also reaching `onMapClick`;
normal clicks (no popup open) are unaffected.

**Verified**: real headless-browser tests for both — confirmed the
Save button is wired and a click on it produces a real save
immediately after creating a mark with no clustering/zoom involved (the
exact previously-broken case); confirmed a popup-dismissing click no
longer also opens the "what's here?" dialog, while a genuinely separate
subsequent click still does. Zero JS errors throughout.

Also verified, unrelated to the bugs above: 8 marks placed a few
metres apart correctly collapsed into one numbered cluster; clicking it
split into smaller clusters as expected; repeated clicks at maximum
zoom produced the actual spiderfy effect (confirmed visually via
screenshot — individual marks radiating out from a cluster on visible
spider legs). (This sandbox's own network access to unpkg.com stopped
working partway through this project, unrelated to the code itself —
verified instead by pulling the real published packages through
`registry.npmjs.org` and serving them locally for testing; the
delivered HTML still points at the normal public CDN, which works fine
in an actual browser.)

A **mark** is a single GPS point you drop yourself, out on the water. Three
Mark Types, each showing (and saving) only the fields that actually apply —
see "Which fields show for which type" below:
- **POI** — just a name and when it was found (a snag, a hazard, a ramp not
  otherwise tracked). No species, no catch detail.
- **Mark** — a POI plus Species — "I think this is around here", without
  logging a real catch's full detail.
- **Catch** — the full field set: species, conditions, gear, measurements.

Mark Type is itself just another editable list (see below), so a fourth
type later ("Ramp", say) is a Settings edit, not a code change — though it
defaults to showing the full Catch-level field set until it's specifically
taught otherwise (see `MARK_TYPE_FIELD_KEYS` in `charts.js`). This is
separate from the Locations list above (the fixed handful of spots the site
scores tide/weather/wind conditions FOR) — marks.json is an open-ended,
editable personal log that grows every time you're out.

**One-off migrations**: `data/personal-spots.gpx` — the site owner's
existing catch history exported from C-MAP Embark — has been migrated into
`data/marks.json` as real mark records (2,523 of them). The GPX file itself
is left in the repo untouched for now, but the Location and Live tab maps no
longer read it directly; both now render straight from `data/marks.json`
instead. The old file is effectively retired and safe to delete once you're
happy the migrated data looks right — nothing on the site reads it anymore.
Separately, when the POI/Mark/Catch distinction above replaced the original
two-value Fish/POI Mark Type, every mark that existed with type `"Fish"` was
migrated in one pass to type `"Mark"` — a deliberately conservative rename
(nothing else on those records was touched, even a record that happened to
already carry Catch-level fields from before this distinction existed) — see
this file's own git history for that diff. `"Fish"` stays in
`config/mark_lists.json`'s own pick-list for a short window purely so it
doesn't vanish out from under anything already mid-edit; remove it by hand
once nothing's likely to still pick it.

**Storage**: flat JSON in `data/marks.json` — in `data/` rather than
`config/` despite being written the same browser-to-GitHub-API way as every
config file on this site: `config/` holds settings that configure how the
site/pipeline behaves (which locations to track, which groups exist, API
keys), while `data/` holds the actual content the site renders
(`conditions.json` IS the data every page displays) — and marks are exactly
that, real content that just happens to be authored here instead of by
`fetch_conditions.py`. No separate database. At the scale of one person
logging by hand (realistically low hundreds to a few thousand marks over
years), a flat file stays only a few hundred KB and is trivial for GitHub's
API to read and rewrite whole on every save — introducing a real database
wouldn't earn its cost unless this became multi-user, needed fast live
queries, or needed unattended server-side writes. Worth revisiting only if
this file ever grows past a few MB.

**Fields on a mark**: GPS location (lat/lng), a display name, Mark Type,
and Date/Time (when it happened — separate from when the record was saved,
so a mark logged from memory afterwards still shows the real catch time) —
every mark has these three regardless of type. A Mark additionally carries
Species; a Catch adds Weather Condition, Tide Condition, Water Condition,
Bait, Rig, Rod, Berley, Size (cm), Barometer (hPa), Temperature (°C), Water
Temperature (°C), Water Depth (m), Wind Direction, Wind Speed (km/h),
free-text Notes, and a **Released** checkbox — stored as `released: true`
only when actually checked (never `released: false`; unchecked just means
the property isn't there at all, same "presence means yes" convention as
the rest of this codebase's own optional boolean-shaped fields). The
pick-list fields (Species, and everything from Weather
Condition through Berley) are picked from `config/mark_lists.json` rather
than typed free text, so a value like "Whiting" is always spelled the same
way for filtering/export later rather than drifting into near-duplicates
("whiting", "small whiting"); the plain-measurement fields (Size, Barometer,
Temperature, Water Temperature, Water Depth, Wind Speed) have no such list
behind them — there's nothing to draw a Settings-tab list from for a number.
Wind Direction is the one exception that's neither: its 16 compass points
come from a fixed physical set baked into `charts.js`, not
`config/mark_lists.json`, since a compass point is never something that
would need Settings-tab editing the way Species or Bait might. The full
field-by-field shape, and exactly which fields go with which Mark Type, is
documented as a comment above `MARK_TYPE_FIELD_KEYS`/`MARKS_FILE_PATH` in
`charts.js`.

**Which fields show for which type**: the mark popup (both viewing and
editing) and the Sync tab's review row only ever show the fields that apply
to whatever Mark Type is currently selected — picking Species for a POI, or
Barometer for a Mark, was never possible to begin with rather than just
hidden after the fact. Switching Mark Type live, mid-edit (on an existing
mark, a new one, or a Sync candidate awaiting import), immediately reveals
or hides the relevant fields without needing to save and reopen — and
hitting Save genuinely drops anything that's no longer applicable, not just
visually hides it: turning an existing Catch into a POI clears its Species,
Weather Condition, Barometer, everything, back down to just name/type/time.

**Editing the pick-lists**: the Settings tab's "Fishing Mark Lists" section
lets you add or remove options for each of the pick-list-backed fields above
(Mark Type included), the same way "Location Groups" already works for
location tags — type a new value, hit Add (or Enter), then "Save mark
lists" to commit it. Removing an option doesn't touch any mark that already
used it; it just won't be offered again.

**Mark Shape Formats and Mark Colour Formats — controlling exactly how a
mark looks, on the Lowrance, the Garmin, and this site's own map, all from
one place.** Two separate named lists (their own sub-lists in "Fishing
Mark Lists", alongside Species/Mark Type/etc), REVISED from an earlier
version that bundled shape and colour into one "Mark Format" together:
bundling meant assigning a species a colour ALSO silently overrode its
shape (species winning over Mark Type either way), losing the "a Catch
reads as a cross, a Mark reads as a circle, regardless of species"
distinction the moment any species got a colour of its own. Splitting them
fixes that:
- A **Mark Shape Format** is a name plus an icon (for this site's own map
  — a constrained pick, circle/diamond/cross, the only three shapes this
  site's map and Lowrance both actually support) and the literal shape
  *fragment* of the `<sym>` text each device's export should use.
- A **Mark Colour Format** is a name plus a colour swatch (for this
  site's own map — a free, unrestricted hex, no Lowrance-style colour-
  count limit here) and the literal colour *fragment* of the `<sym>` text.

Both devices' `<sym>` fields are deliberately free text for now rather
than a dropdown — this site doesn't yet know either device's full
accepted-value list (see "Syncing marks with a Garmin or Lowrance device"
below for why guessing at that list has gone wrong twice already), so
getting the exact text right is your own call, made once per Format. On
export, the two fragments are simply concatenated shape-then-colour with
NO separator added by this site at all — each fragment already carries
whatever punctuation it needs baked in (e.g. a Shape Format's Lowrance
text might literally be `circle,` with the trailing comma included, so it
joins cleanly with a Colour Format's bare `yellow`).

**Every value on every one of the nine pick-list fields** gets both a
Shape Format picker and a Colour Format picker next to its own chip — not
just Species and Mark Type. Shape only actually *affects* anything for
Species and Mark Type, though (see "Resolution order" below); assigning
one to, say, a Weather Condition value is harmless but currently inert.
Colour, by contrast, genuinely does apply everywhere, via whichever field
the map happens to be grouped by.

**A tile's colour comes from its assigned Colour Format, full stop** —
pick one, and that Format's own "colour for the website" becomes the
tile's background here. There's no separate way to colour a tile any
more; an earlier version had a free hex colour picker you could open by
clicking the chip itself, which meant a tile's look and its Format could
disagree with each other. One mechanism now, not two.

**Resolution order, when both a mark's species and its own Mark Type have
a Format assigned on the SAME axis**: the **species'** Format wins —
species is the more specific signal. But the two axes are meant to behave
differently in practice: **colour** varying by species, with shape
staying true to Mark Type, is the everyday, intended setup — set a
Colour Format on each species you care about, leave its Shape Format
blank, and a Catch still reads as a cross while a Mark still reads as a
circle, whatever species it is. A species-level **shape** override exists
for the rare case you genuinely want one species to always look a
particular way regardless of Mark Type — the exception, not the rule.
Mark Type's own Format assignments (either axis) mainly matter for POI,
which has no species to carry one of its own at all — POI gets both a
shape AND a colour from its own Mark Type entry the same way a Catch or
Mark would, nothing structurally special about it at export time.
**Everything here is opt-in**: a species or Mark Type with nothing
assigned keeps exactly the fallback it always had — this site's map falls
back to a plain hex colour or its hash-based default; the GPX export
falls back to a hardcoded shape-by-Mark-Type and a plain default colour,
same as before Mark Formats existed. Either axis missing a Format (or a
Format that's only had ONE device's text filled in so far) falls back to
that piece's own legacy default for whichever's still blank, rather than
exporting a broken `<sym>`.

**Displaying marks on the map**: the Location and Live tab maps both plot
every mark (see `loadAndRenderMarks` in `charts.js`), gated behind Admin
sign-in (`cachedIsAdmin`) — same "don't clutter the map for random public
visitors, but not real access control" caveat as before (`GET
/api/public/marks` is itself unauthenticated, same as the old static file
was). Each mark's **shape and colour** come
from its resolved Mark Format (see "Mark Formats" above — species' own
assignment wins over its Mark Type's), the exact same resolution the
Lowrance/Garmin export uses, so the map stays visually consistent with
both once you've deliberately picked something. A mark with nothing
resolved falls back to the same shape-by-Mark-Type default as export, and
to this site's own richer colour palette — a species' plain hex `color`
if it has one, else a stable colour derived from a simple hash — rather
than being forced onto whatever's set for export. Hover/tap a point for
its name, species, and date. Built on two small custom Leaflet layers
(`getDiamondMarkerClass`/`getCrossMarkerClass` in `charts.js`) rather than
switching every mark over to the DOM-based pins used for tracked locations
elsewhere on this map — those would be meaningfully heavier at this data's real scale (a

**Clicking a mark's popup** (Location and Live tabs both) also shows two
distances, filled in a moment after the popup opens rather than blocking
it — a real GPS position and a tracked-location lookup both take a moment,
and most marks are never clicked at all, so this only ever runs for one
that actually is:
- **Nearest loc.** — straight-line distance to whichever tracked location
  (the list above) is physically closest, plus its name — a reference
  point (which location's tide/weather calibration is relevant here), not
  something being travelled to.
- **From you** — straight-line distance from the device's current GPS
  position, plus a rough paddling time at a flat 6 km/h (distance ÷ speed,
  not a real route — see `fillMarkPopupDistances` in `charts.js`). Shows
  "Location unavailable" if GPS is denied or the browser doesn't support
  it, same graceful-degrade as everywhere else this site touches GPS.

**Edit, Copy, and Delete** buttons sit at the bottom of the popup, gated
behind Admin sign-in (same as everywhere else that edits data on this
site now) — Edit swaps the popup into the same form `startNewMarkEntry`
uses for a brand-new mark, Save/Cancel working exactly the same way.
**Copy** starts a brand-new, unsaved mark at the SAME location, with
every applicable field cloned from the original — species, all catch
detail, notes, Released, and its Date/Time too (see
`startCopiedMarkEntry`, `charts.js`) — everything except the identity
fields (this is a genuinely separate mark, not the same record moved).
Opens straight into the same edit form, ready to adjust before saving —
most commonly the Date/Time, for "caught another one here later": **any**
edit form's Date/Time field, changing it re-runs the historical lookup and
OVERWRITES Weather/Tide/Barometer/Temperature/Water Temperature/Wind for
the new moment (see `refreshMarkFormConditionsForNewTime`), rather than
only filling blanks the way a brand-new mark's very first lookup does —
the old values reflect the wrong time the instant it changes, so leaving
them would be actively misleading. A field the fresh lookup doesn't
resolve (a network hiccup, or a date outside Open-Meteo's own archive
coverage) is left exactly as it was rather than blanked out. **Delete**
needs a genuine confirmation step before it does anything — clicking it
just reveals an inline "delete this mark? this can't be undone" block
with its own Yes/Cancel, rather than acting on the first click the way
Cancel or Save do. Confirming removes the mark from `data/marks.json`
outright (see `deleteMarkFromGitHub`, `charts.js` — same GET-current-then-
PUT-whole-file pattern every other write on this site uses) and takes its
marker straight off the map, no page reload needed.
couple thousand points and growing); the custom shapes stay on the same
canvas renderer circles always used here, confirmed against the real
dataset (2,532 marks load and shape in well under half a second).

**Not built yet**: the actual "add a mark while out fishing" UI on the Live
tab, and filtering marks by these fields. Importing/exporting from a
Garmin/Lowrance device now IS built — see "Syncing marks with a Garmin or
Lowrance device" below.

## Syncing marks with a Garmin or Lowrance device

The **Sync** tab reads a device's own waypoint export (Garmin GPX, or a
Lowrance `.usr` format 6 file straight off the chartplotter's "export
waypoints" menu), matches every waypoint against what's already in
`data/marks.json`, and lets you review/edit before anything is saved —
nothing is written until you actually hit Import.

**Matching, in order**:

1. **Exact device ID** (Lowrance only) — each Lowrance waypoint carries a
   persistent UUID that survives re-export. The first time a waypoint is
   imported, that UUID is stored on the mark as `sourceUuid`; re-importing
   the same file later recognises it with certainty, even if its
   coordinate or description drifted slightly on the device since. Garmin
   GPX has no equivalent persistent ID, so this step never applies there.
2. **Distance only** (both device types) — anything within 20m of a mark
   already in `data/marks.json` is treated as already tracked and left out
   of the review list entirely — no name or species check, deliberately
   simple, per how this was designed. Only genuinely new spots are real
   import candidates; the summary line still reports how many were matched
   and skipped, for transparency, without listing them individually.

Before matching, waypoints from the SAME file that sit within 20m of each
other AND resolve to the same species are merged into one candidate —
chartplotters commonly save a fresh waypoint every time you drift back
over a spot rather than updating one, so a real export routinely has
several separate records for what's genuinely one mark.

**Species names** are normalised against `config/mark_lists.json`'s
Species pick-list before being shown — stripping a device's own
auto-numbering (`"Snapper-13"` → `"Snapper"`) and a small hardcoded alias
list (`"Gummy"` → `"Gummy Shark"`, easy to extend in `sync.js` if another
mismatch turns up).

**Every field a mark can carry** is shown per candidate — but, same as the
main mark-edit popup, only the ones that actually apply to whatever Mark
Type is currently selected for that row (see "Which fields show for which
type" above); switching a candidate's own Type live in its row shows or
hides the rest immediately. Name/Type/Date-Time/Species are always
available (Species drops away for a POI); Weather Condition, Tide
Condition, Water Condition, Bait, Rig, Rod, Berley, Size, Barometer,
Temperature, Water Temperature, Water Depth, Wind Direction, and Wind Speed
only show for a Catch. Every candidate defaults to Catch on import (a
device waypoint represents an actual sighting/catch), editable per-row
before you commit. The pick-list ones (Mark Type, Species, and everything
from Weather Condition through Berley) are driven off the exact same
`config/mark_lists.json` options as the main mark-edit popup elsewhere on
the site, so there's only ever one place those lists are maintained.
Weather/Tide/Barometer/Temperature/Water Temperature/Wind additionally come
pre-filled from a real historical lookup for anything Catch-level — see
"Auto-filling Weather/Tide/Barometer/Wind on a mark" below for where that
data comes from and its own caveats.

**Export** downloads every mark in `data/marks.json` as one GPX file. A
**File name** field sets the base name before downloading — pre-filled with
`fishing-marks-YYYY-MM-DD-HHMM.gpx` (date AND time, so exporting more than
once in a day doesn't quietly overwrite an earlier download), editable to
whatever you'd rather call it (e.g. "Lang Lang Trip"). **Two buttons**,
**Export for Lowrance** and **Export for Garmin** — each tags the FRONT of
the base name with which device it's for (`lowrance-fishing-marks-...` /
`garmin-fishing-marks-...`, so exporting both back to back never overwrites
one with the other, and the two sort next to each other by device in a
downloads folder) and writes the `<sym>` text in that device's own
convention (see below).
`.gpx` gets added automatically if you don't type it yourself, and
characters a filename can't contain are stripped. Hitting either button
opens your browser's own native "Save As" dialog (Chrome/Edge and similar
— this needs the File System Access API, which Firefox and Safari don't
implement; those browsers fall back to a plain download to your default
downloads folder, same as before, with a note in the status message
saying so), so you choose the actual save location yourself rather than
always landing in the same default folder. Cancelling that dialog cancels
the export cleanly — nothing gets saved anywhere.

Each waypoint's `<name>` is the mark's **species** (falling back to its
own `name` field, then a generic label, only if there's no species at
all) — most of the old migrated batch has a place name in `name`
("Williamstown", "Leopold"), which is far less useful on a chartplotter
than the actual catch; that place name is kept in `<desc>` instead rather
than lost. Each waypoint also gets a `<sym>` — built from the mark's
resolved **Shape Format** and **Colour Format** (see above), each
supplying its own literal text fragment for whichever device you exported
for, simply concatenated shape-then-colour with no reformatting applied.
A mark with either axis unresolved (neither its species nor its Mark Type
has one assigned on that axis) falls back to a plain default for that
piece specifically — circle/diamond/cross by Mark Type for shape, a flat
"blue" for colour — same as before Mark Formats existed.

**Two real, different conventions, confirmed against real hardware, not
guessed**: Lowrance wants lowercase with no space (`circle,yellow`);
Garmin wants Title Case with a space after the comma (`Circle, Yellow`).
A file built for one device failed to import cleanly on the other, which
is exactly why every Format carries two separate `<sym>` fields (and why
export is now two buttons instead of one) rather than one string this
code tries to reshape automatically — this site doesn't yet know either
device's full accepted-value list well enough to trust an automatic
transform, so getting the exact text right for each device is Oliver's
own call, made once per Format.

Worth knowing: this is a best-effort substitute, not a restoration of
whatever icon a mark literally had on the device originally — the Sync
tab's own `.usr` parser reads past a waypoint's icon/colour bytes without
keeping either value, so that original information is already gone for
every mark imported so far. Getting the shape/colour vocabulary itself
right took a few real attempts, worth being upfront about rather than
glossing over:
1. An early version used Lowrance's "fish" icon with a colour suffix.
   Real testing found the fish icon has no colour option on the device at
   all.
2. The next version switched to `circle`/`square`/`cross`, then
   `diamond`/`x` — both guessed from secondary sources (forum posts, a
   reverse-engineered `.usr`-format icon table) rather than the device
   itself, and both wrong in different ways.
3. Confirmed directly against a real GPX Oliver exported straight from
   his own HDS Live-7 after manually setting 7 waypoints on the unit —
   one of each of its real colours, across circle/cross/diamond shapes:
   `circle,blue` `circle,yellow` `circle,white` `circle,green`
   `circle,cyan` `cross,magenta` `diamond,red`. That confirmed the real
   shape names (what looked like a separate "square" was actually a
   diamond) and caught two wrong colour names (`orange`/`aqua`, should
   have been `red`/`cyan`) that — combined with several species having no
   configured colour and falling back to a hardcoded blue default — was
   enough to look like a total failure ("every mark came through blue")
   rather than a two-word mixup.
4. Loading a Lowrance-formatted file onto a Garmin unit then surfaced the
   casing/spacing difference between the two devices, which is what
   led to Mark Formats carrying a separate `<sym>` per device at all,
   rather than one shared string.
5. The first version of Mark Formats bundled shape and colour into ONE
   named choice — assigning a species a colour also silently overrode its
   shape, since both were resolved together with the same species-wins-
   over-type priority. That meant a Catch of an assigned species stopped
   reading as a cross the moment it got a colour. Split into two
   independent lists (Shape Formats, Colour Formats — see above) so
   colour can vary by species while shape stays true to Mark Type, which
   was the actual intended behaviour all along.

This history is also why nothing here GUESSES a colour or shape from
anything else any more (an earlier version matched a species' hex to the
"nearest" of Lowrance's 7 names, which is exactly how two wrong names went
unnoticed for as long as they did) — every Format's exact text is a
deliberate, once-made choice on the Settings tab, not derived at export
time.

Gated behind Admin sign-in, same as everything else that edits data on
this site now (see "User accounts" below) — sign in from the Account
tab first.

## Auto-filling Weather/Tide/Barometer/Temperature/Wind on a mark

A brand-new **Catch** — created manually on the map, or accepted through
the Sync tab's import — gets a best-effort, real-data guess for Weather
Condition, Tide Condition, Barometer, Temperature, Water Temperature, Wind
Direction, and Wind Speed, looked up for its own exact GPS point and
Date/Time. These are exactly the fields a POI or a plain Mark can't carry
at all (see "Which fields show for which type" above), so the lookup
doesn't run for either — manually starting a new mark as POI or Mark skips
it entirely rather than spending a WillyWeather call and two Open-Meteo
calls on fields nothing will show or save. **Water Depth is the one
exception even for a Catch** — nothing this site already talks to can
supply bathymetry for an arbitrary point, so it stays a manual-only field.
Every auto-filled field stays a normal editable one afterward; the lookup
only ever pre-fills a blank field, it never locks one or overwrites
something already set (by you, or by the Live tab's own "You are here"
tide guess — see below).

On the **Sync tab**, this lookup runs right after a file is parsed and
matched — before the review list even appears — so every new candidate
(which all default to Catch on import) shown for review already has its
own Weather/Tide/Barometer/Temperature/Water Temperature/Wind fields
filled in and editable right there in its row, alongside Species/Name/
Type/Notes. Whatever's showing at the moment you hit Import (looked-up or
hand-edited) is exactly what gets saved; nothing is looked up a second
time at Import itself. Switching a candidate's own Type away from Catch
before importing simply drops those fields at Import (see "Which fields
show for which type" above) — the lookup itself has already run by then
regardless, since it happens once for the whole batch right after parsing.

**Scope, deliberately**: this only ever runs for a NEW mark — never a
retroactive backfill over the marks already sitting in `data/marks.json`.
WillyWeather bills per call, so backfilling thousands of existing marks in
one go would mean thousands of billed calls for a one-off convenience;
only looking this up for candidates actually up for review/creation (and
only when the fields it fills could even apply — see above) keeps it to at
most one WillyWeather call plus two Open-Meteo calls (weather + marine) per
NEW Catch — and on the Sync tab, only for candidates that are actually new
(an already-tracked match is never shown, so never looked up either).

**Where the data comes from**:

- **Wind, Barometer, Temperature, Weather Condition** — Open-Meteo's
  historical archive API (`archive-api.open-meteo.com`), free and
  keyless, hourly data back to 1940. Weather Condition comes from
  Open-Meteo's WMO weather code, collapsed onto this site's own
  Clear/Cloudy/Overcast/Rain pick-list.
- **Water Temperature** — Open-Meteo's separate marine API
  (`marine-api.open-meteo.com`), the same one the Location tab's live
  preview already uses for sea surface temperature, just pointed at a
  past date instead of a forecast window. Open-Meteo's own docs describe
  this endpoint's historical coverage as "limited" without saying exactly
  how limited — unconfirmed against a real call (see the caveat below),
  so a mark from further back may simply come back with Water Temperature
  left blank rather than a wrong guess.
- **Tide Condition** — WillyWeather's real tide predictions for that exact
  past date, via the `willyweather-search` Worker, run through "our
  defined rules" (the same Slack/Running/Last Run/Start Run logic the Live
  tab's own quick-entry already uses — see `classifyTideConditionFromExtrema`
  in `charts.js`). Since an arbitrary mark's coordinate has no
  manually-verified tide offset of its own, this **snaps to whichever
  tracked location (the one above) is physically nearest** and borrows
  its calibration — always, with no distance cutoff.

**Requires a Worker redeploy.** The `willyweather-search` Worker needed a
code change (a `startDate` parameter, so it can fetch a PAST tide window
instead of only "today onward") to make this work at all. Like any other
change to that file, it isn't picked up by the normal GitHub upload flow —
it has to be manually pasted into Cloudflare's dashboard and redeployed
(see the deploy steps at the top of `willyweather-search.js`). Tide
Condition will simply stay blank on new marks until that's done; Weather/
Wind/Barometer/Temperature/Water Temperature don't depend on the Worker at
all and work regardless.

**One assumption worth knowing about**: this relies on WillyWeather's own
API actually honouring that `startDate` parameter for a past date the way
it does for a future one. It's a standard, documented parameter for their
API, but it was never confirmed against a real live call while this was
built. There's a safety check built in — if the tide data that comes back
doesn't actually cover the date that was asked for, Tide Condition is left
blank rather than risking a wrong guess, and a message is logged to the
browser console explaining why. Worth keeping an eye on the first few
marks created after this ships, just to confirm Tide Condition is coming
through as expected.

## Editing locations from the site itself (historical — fully obsolete)

**No GitHub token is used anywhere on this site any more.** This entire
section described a GitHub Personal Access Token flow (create one on
GitHub, paste it into a "GitHub connection" card, it gated Locations/
Groups/Mark Lists/marks/Sync/Home-address/Refresh) that has been fully
retired across the v2 migration — see "User accounts" below for the
complete, current picture. Every one of those features now runs on
Google Admin sign-in (Account tab) instead; the last two holdouts (Home
address, "Refresh data now") were migrated in the same round that also
found and fixed a real bug — see "A serious bug, found and fixed" further
down. There is no GitHub connection card left on the Settings page, and
creating a token for this site serves no purpose any more.

## User accounts (optional, separate backend)

The Account tab (`account.html`/`account.js`) lets someone sign in with
Google and manage their OWN list of locations and a check-frequency
setting. This is entirely separate infrastructure from the free site above
— it never reads or writes `config/locations.json` or
`data/conditions.json`, and signing in changes nothing about what any other
page shows.

It's powered by a second Cloudflare Worker, `user-backend.js` — deliberately
a separate Worker from `willyweather-search.js` rather than added to it,
since it holds a database and OAuth secrets and has a genuinely different
risk profile from the tiny, stateless search proxy. See the long comment
block at the top of `user-backend.js` for the full one-time setup
(Google Cloud OAuth client, Cloudflare D1 database via `schema.sql`, and
the Worker's own secrets), and for exactly what each endpoint does.

### v2: accounts, tiers, and a unified locations model (`schema-v2.sql`)

The original account layer above (`schema.sql`'s `user_locations`/
`user_settings`) has been superseded by a richer model in
`schema-v2.sql`, covering everything the free site's `config/*.json`
files hold today — locations, location groups, the mark-list pick-values,
and marks — plus two roles (`admin`/`basic`).

**The core idea:** every user, including a fixed **Public** sentinel
account (`id = 'public'`, never actually logs in), has their own
locations-they-track, their own type vocabulary, their own groups, their
own mark-list pick-values, and their own marks. The free, anonymous site
is simply what Public's own rows say — there's no separate "defaults vs.
overrides" table anywhere; Public is just another `user_id` that happens
to be well-known. `role = 'admin'` can act on ANY user's rows (most
usefully Public's, via `?userId=public` on any endpoint below) — that's
the entire mechanism for "editing the free site's defaults", the exact
same endpoints a Basic user's own browser calls.

Location **type** (Kayak/Land based) stays a fixed, two-value
`behaves_like` enum under the hood — that's what the actual scoring
logic switches on — but each user has their own open-ended `user_types`
vocabulary of DISPLAY names on top of it (so "Kayak", "SUP", "Rock
ledge" can all exist for one person, each just declaring which of the
two real behaviours it scores like).

New endpoints, all under the same auth/session model as `/api/locations`
above, and all accepting an admin-only `?userId=<id>` to act on someone
else's data:
- `GET/POST /api/types`, `PUT/DELETE /api/types/:id`
- `GET/POST /api/tracked-locations`, `PUT/DELETE /api/tracked-locations/:id`
  — the central one: a row here is a physical place + one of your own
  types + your own drive/setup/pack-up numbers, all at once
- `GET/POST /api/groups`, `PUT/DELETE /api/groups/:id`,
  `PUT /api/locations/:id/groups` (set a location's group membership)
- `GET/POST /api/marklists`, `PUT/DELETE /api/marklists/:id`
- `GET/POST /api/marks`, `PUT/DELETE /api/marks/:id` (`GET` paginates,
  default 200/request, capped 500 — a real history can run into the
  thousands)

A Basic account is capped at 10 *additional* locations — counted as
locations they've personally created (`locations.created_by_user_id`),
never counting anything inherited from Public's set.

**Current state, honestly:**

- **Location Groups and Fishing Mark Lists are fully cut over** —
  `locationsadmin.js` saves both immediately via `/api/groups` and
  `/api/marklists` (scoped to Public), gated on Google Admin sign-in
  rather than the GitHub token. Each add/remove/edit hits the API right
  away; there's no more "Save groups"/"Save mark lists" button for
  either. Verified with a real headless-browser test exercising add/
  remove/edit through the actual UI, not just the API in isolation.
- **The pipeline (`fetch_conditions.py`) is also cut over** — it now
  reads the tracked-locations list from a dedicated Worker endpoint
  (`GET /api/pipeline/locations`) and writes its WillyWeather id/lat/lng/
  tideMaxObserved cache back the same way (`PUT /api/pipeline/locations/
  :id`), instead of reading/writing `config/locations.json` as a local
  file. See "Pipeline endpoints" below for why this needed a completely
  different auth mechanism from everything else here, and the
  `behavesLike` fix that keeps custom location types scoring correctly.
  `config/locations.json` itself is now a generated EXPORT (see
  `export_locations_json()`) so `charts.js`'s own direct client-side
  reads of it (Live page GPS-matching, tide-offset lookups, the
  boat-ramp-access chart threshold) keep working unchanged.
- **The Locations section itself is now fully cut over too** — the last
  and biggest piece. Every field (name, shore, tide offset, "affected by
  tides", group membership, per-type drive/setup/pack-up/time-to-spot/
  minimum-tide-height) saves immediately, debounced where it fires per-
  keystroke. Location **type is now genuinely open-ended** — the old
  fixed Kayak/Land based toggle buttons are replaced by a "+ Add a
  type…" picker sourced from Public's own type vocabulary, with an
  inline "define a new type" option (name + which of the two real
  scoring behaviours it uses). Verified with a real headless-browser
  test: renamed a location (debounced place save), edited a type's
  timing (debounced), removed a type, and added a genuinely custom type
  ("SUP", scoring like Kayak) — confirmed it got its own timing section,
  the right icon, and the minimum-tide-height field, all driven by
  `behavesLike` rather than the display name.

  **Two things changed as a result, worth knowing:**
  - Every new location now has to be added via a map click (📍 Add
    location) — the old "+ Add location" blank-row button is gone,
    since D1's `locations.lat`/`lng` are `NOT NULL` and that button
    never had coordinates to give it.
  - The GitHub connection card has been removed from the Settings page
    entirely (see "Home address and Refresh data now" further down) —
    at the time this specific fix shipped, it had briefly shrunk to just
    Home address and "Refresh data now" before those two were migrated
    too.

  **A real bug fixed along the way**: `packUp` updates via
  `PUT /api/tracked-locations/:id` had silently never applied since
  Stage 2 — the server checked `body.pack_up` (snake_case) when every
  request actually sends `packUp` (camelCase, matching every other
  field). Fixed in `user-backend.js`.
- **`account.js` is now reconciled onto the same v2 model** —
  `/api/locations` (the standalone v1 `user_locations` table) is
  deprecated (kept in `user-backend.js`, functional, but nothing calls
  it any more). `account.js` now talks to `/api/tracked-locations` +
  `/api/types` — the SAME endpoints Admin's own Locations page uses,
  always acting as the signed-in user themselves (no `?userId=`
  override — that's an Admin-only affordance). The UI stays
  deliberately simpler than the admin page (one type per location, no
  drive/setup/pack-up timing fields exposed), a carried-forward
  limitation from the original v1 design, not a new one.

  Every brand-new signed-in user now gets their own Kayak/Land based
  `user_types` seeded automatically on first sign-in
  (`seedDefaultTypes`, `user-backend.js`) — without this, a new
  account's first "Add location" would have no types to pick from at
  all. Accounts created before this shipped (i.e. the Admin account
  itself) needed a one-off backfill —
  `migration-backfill-oliver-types.sql`.

  Changing an existing location's Type dropdown is handled as a
  delete-old-access-row-then-create-new one, not a plain field update —
  v2's access rows are keyed by (user, location, type), so switching
  type genuinely means starting a new tracking relationship, not
  editing the old one in place.

  Verified with a real headless-browser test: an existing location
  loaded with its correct type pre-selected, a brand-new location
  created with the right `typeId` resolved from the dropdown, changing
  an existing location's type correctly triggered delete-then-recreate
  (confirmed both calls happened, in order), and deletion worked
  cleanly — zero JS exceptions throughout.
- `/api/settings` (check-frequency scheduling) is untouched — a
  different concept entirely from locations, with no v2 equivalent.
  No WillyWeather-calling cron exists yet either, same as before.

### Pipeline endpoints (`fetch_conditions.py` / GitHub Actions)

Two endpoints, deliberately NOT using the session-cookie model every
other endpoint above does — GitHub Actions has no browser, so it can
never hold a session. Both are gated on a single shared secret instead
(`X-Pipeline-Token` header, checked against the Worker's own
`PIPELINE_API_TOKEN` setting):

- `GET /api/pipeline/locations` — Public's full tracked-locations list,
  shaped to match the OLD `config/locations.json` array closely (each
  location's `types[]` nested the same way) so `fetch_conditions.py`'s
  existing field access needed minimal changes. Each type entry carries
  BOTH `type` (the admin's own display name) and `behavesLike` (always
  exactly `"Kayak"` or `"Land based"`) — the scoring functions branch on
  `behavesLike` only, never the display name, so a renamed or custom
  type (e.g. "SUP" scoring like Kayak) still scores correctly. Verified
  directly: a synthetic "SUP" type scored identically to "Kayak" while
  keeping its own label in the output.
- `PUT /api/pipeline/locations/:id` — writes the resolved WillyWeather
  id/name/region/state/lat/lng/tideMaxObserved cache back onto a
  location's own row. Runs once per location, every run, unlike the old
  git-commit-if-changed behaviour — D1 writes at this volume are cheap
  enough that this wasn't worth a real changed-since-last-time check.

Needs two new secrets on the site repo (Settings -> Secrets and
variables -> Actions): `PIPELINE_WORKER_URL` (this Worker's own URL) and
`PIPELINE_API_TOKEN` (matching the Worker's own secret of the same
name) — see `update.yml`'s own comments.

**Correction made after this first shipped:** two real fields were
initially missed by `schema-v2.sql` — `tidal` (Metung, VIC is a real,
currently-tracked inland spot with `tidal: false`, stripping tide/
current data from its scoring regardless of what the marine APIs
return) and `minTideHeight` (Lang Lang's Kayak entry uses this for its
chart's boat-ramp-access threshold line). Both were found by checking
every field actually used across the live `config/locations.json`
data, not assumed — see `schema-v2.sql`'s own comments on the `tidal`
and `min_tide_height` columns. `handlePipelineLocationsList` was
hardcoding `tidal: true` for everyone and omitting `minTideHeight`
entirely until this fix.

**Also added: `config/locations.json` is now a generated EXPORT, not a
frozen leftover.** `charts.js` reads that file directly, client-side,
in several places (Live page GPS-matching, tide-offset lookups, the
boat-ramp-access chart threshold) — completely separate from anything
`fetch_conditions.py` itself reads. Once the pipeline stopped writing
to it, those client-side reads would have silently gone stale forever.
`export_locations_json()` (`fetch_conditions.py`) regenerates it every
run from the same D1-sourced list `load_locations()` returns, stripped
of the two fields (`id`, `behavesLike`) that are internal to the D1
model and never existed in the historical file — so `charts.js` needed
zero changes. `update.yml` commits it again alongside
`data/conditions.json`.

### Public reads (`/api/public/marklists`)

Unlike locations (a periodically-regenerated static export — see above),
`config/mark_lists.json`'s CONSUMPTION side is now fully live instead:
`charts.js`'s own map marker icon/colour resolution and `sync.js`'s GPX/
chartplotter export mapping both used to read that static file directly,
client-side — a real gap for a while, since the admin-editing side moved
to D1 (Location Groups/Mark Lists cutover, above) with nothing keeping
that static file in sync. Closed now via a genuinely public,
unauthenticated endpoint on the same Worker: `GET /api/public/marklists`
— no session, no token, same trust level `config/mark_lists.json` already
had as a plain downloadable file (this is read-only; there's no public
write path anywhere). `MARK_LISTS_FILE_PATH` (`charts.js`) now points at
this endpoint instead of the static file — a one-constant change, since
both existing fetch call sites (`charts.js`, `sync.js`, which shares the
same global constant) needed no changes at all. Verified directly: the
endpoint's query/output shape matches `rowToMarkList` exactly, and the
existing fetch code correctly round-trips against it in a real browser.

A short (60s) `Cache-Control` header keeps this from hitting D1 on every
single page load, at the cost of edits taking up to a minute to appear
on the free site — a much shorter lag than locations' ~3-hour pipeline
cycle, and worth knowing if a change seems to not have landed yet.

`config/mark_lists.json` itself is now orphaned the same way
`config/location_groups.json` already was — nothing reads or writes it
any more. Safe to delete from the repo whenever convenient.

### "Add as permanent location" — fixed, and gated on Admin sign-in now

The Location tab's preview feature used to commit a new entry straight
to `config/locations.json` via the GitHub token (`saveNewLocationToGitHub`,
`charts.js`) — a real bug once that file became a generated export (see
"the pipeline is also cut over" above): the commit would succeed, then
get silently overwritten by the next scheduled pipeline run within a
few hours, since it was never actually added to D1 at all.

Fixed by replacing it with `saveNewLocationToD1`, which POSTs through
`/api/tracked-locations?userId=public` — the same endpoint Admin's own
Locations page and `account.js` both use. The button's visibility check
(`canEditLocations`, `app.js`) now reads a cached Admin-session flag
(`cachedIsAdmin`, refreshed once per page load via `refreshAdminStatus()`
— both in `charts.js`) instead of checking for a GitHub connection —
the first place on this site where "signed in as Admin" replaces the
GitHub token as the actual permission gate, rather than just being an
option alongside it.

**This was a narrow fix at the time** — marks and Sync followed in their
own dedicated round, below.

### Marks and Sync — the broader migration, done

Everything "Add as permanent location" started is now finished: marks
(adding/editing/deleting a catch or POI from the map) and the Sync page
(GPX/chartplotter import and export) are both off the GitHub token
entirely, gated on `cachedIsAdmin` the same way.

**What changed:**
- **A new public, unauthenticated endpoint**: `GET /api/public/marks` —
  same pattern as `/api/public/marklists`, deliberately unpaginated
  (unlike `GET /api/marks`, which caps at 500) since the map and Sync's
  own duplicate-matching both assume the whole dataset in one response,
  same as the old static file did.
- **`saveMarkToGitHub`/`deleteMarkFromGitHub`/`saveMarksBatchToGitHub`
  (`charts.js`) replaced** with `saveMarkToD1`/`deleteMarkFromD1`/
  `saveMarksBatchToD1` — POST/PUT/DELETE through `/api/marks`
  (`?userId=public`) instead of the GitHub Contents API's read-sha/
  modify/write-whole-file dance. The batch version has no bulk-create
  endpoint to call, so it issues one POST per mark in small concurrent
  batches (8 at a time) rather than either fully sequential (slow for a
  large import) or fully parallel (too many simultaneous requests at
  once) — and reports a partial success count rather than all-or-nothing,
  since there's no single commit left to roll back if some fail.
- **`POST /api/marks` (`user-backend.js`) now accepts an optional
  client-supplied `id`**, using it when present instead of always
  generating a UUID — this is what lets a mark's id, chosen the moment
  its draft pin is first drawn (`makeMarkId()`, `startNewMarkEntry`),
  stay the same permanent one all the way through saving, with zero
  changes needed to the existing (fairly intricate)
  `marksById`/`markersById` bookkeeping in `wireMarkPopupButtons`.
- **Every render/action gate that checked `getConnection()` now checks
  `cachedIsAdmin` instead**: `loadAndRenderMarks`'s whole marks layer,
  the Edit button inside each popup, the map-click "start a new mark"
  flow (shared between the Location and Live tabs), the "hide Sync nav
  link" check, and `sync.js`'s own `canSync()` gate.
- **The privacy caveat carries over unchanged**: this was never real
  access control (a fully static site can't build one), just a "don't
  clutter the map for random visitors" UI choice — `GET /api/public/marks`
  is deliberately open the same way the static file always was; the
  gate only ever controlled whether the JS chose to render it.

**Data ownership**: the original 2,532 real marks were migrated (very
first migration round) to the Admin's own account, not Public's — they
're genuinely personal catch history, not a "free site default". A
one-time migration (`migration-marks-reattribute-to-public.sql`)
reattributes them to `'public'` specifically so the map's public display
and the Sync page both have one consistent owner to read from, matching
every other public-facing dataset's convention on this site.

**Verified**: a real headless-browser test against the actual
`saveMarkToD1`/`deleteMarkFromD1`/`saveMarksBatchToD1` functions — create
preserves a client-supplied id, update PUTs to the right id, delete hits
the right id, and a 3-mark batch import reports the correct count — plus
`sync.html` loaded as both an Admin (workflow visible, zero JS errors)
and a non-admin (gate shown, zero JS errors) session. Also added a
try/catch around `sync.js`'s own marks/mark-lists fetch that wasn't
there before — these are genuine cross-origin Worker calls now, not
same-origin static files, so a real network failure is a more realistic
possibility than it used to be, and it should degrade gracefully rather
than throw uncaught.

### Home address and Refresh data now — the GitHub token retires entirely

The last two features on this project that needed a GitHub token in the
browser are now off it. The "GitHub connection" card is gone from the
Settings page entirely — there is nothing left on this site that needs
a GitHub personal access token stored in localStorage.

- **Home address**: `users.home_lat`/`home_lng`/`google_routes_api_key`
  (`schema-v2.sql`) hold what `config/settings.json` used to. `GET
  /api/public/settings` serves it back out publicly and unauthenticated
  — the same trust model the static file always had (the Routes API key
  was always meant to be used client-side, protected by an HTTP-referrer
  restriction in Google Cloud Console, not by secrecy). `PUT
  /api/admin/home-location` is Admin-only, checked directly against the
  session's role rather than the usual `?userId=` pattern — there's no
  "act as yourself" case that makes sense for a single, site-wide address.
  `week.js`/`live.js`/`locationsadmin.js` all now read from the live
  endpoint instead of the static file.
- **Refresh data now**: `POST /api/admin/refresh-data-now` — Admin-only,
  and the Worker now holds its own GitHub token (`GH_ACTIONS_TOKEN`, a
  new secret, scoped to Actions:write only — deliberately narrower than
  the old browser-held token, which also needed Contents:write) and
  makes the workflow-dispatch call server-side. No GitHub credential of
  any kind reaches the browser for this any more.

**Verified**: a real headless-browser test confirmed the connection
card is completely absent from the DOM, `saveHomeLocation` posts the
right body to the new endpoint with no GitHub auth header at all, and
`onRefreshDataNow` triggers the server-side dispatch the same way.

### A serious bug, found and fixed, from an earlier round

While testing this round, `locations.html` failed to load at all — a
real `SyntaxError: Identifier 'USER_BACKEND_URL' has already been
declared`. Both `charts.js` and `locationsadmin.js` had their own
top-level `const USER_BACKEND_URL` declaration; `locations.html` loads
both. A duplicate top-level `const` across two `<script>` tags sharing
one global scope isn't a harmless redeclaration — it's a fatal syntax
error that stops the WHOLE second script from running at all, not just
the duplicated line.

This had been silently broken since the "Add as permanent location" fix
added `USER_BACKEND_URL` to `charts.js` — meaning **`locations.html` (the
entire Settings page) and `account.html` (the entire Account page) have
been completely non-functional** since that round shipped, not just
whatever this round happened to touch. It went undetected across two
full rounds because neither round's own tests happened to load
`locations.html`/`account.html` as a real combined page (each tested
`charts.js` alongside only the ONE other file each round actually
changed, never both files that turned out to collide). Fixed by removing
the duplicate declarations from `locationsadmin.js` and `account.js`,
keeping the single one in `charts.js` (which loads first on every page
that needs it) as the only source. Re-verified both pages load cleanly,
zero JS errors, with a real page-load test this time.

**If you deployed anything between the "Add as permanent location" fix
and this round, `locations.html` and `account.html` were broken on your
live site for that whole window** — worth confirming both pages actually
work again once this deploys.

### Settings and Account merged — one page, one script

`account.html`/`account.js` are gone entirely. Everything they did now
lives on the Settings page (`locations.html`/`locationsadmin.js`) — every
other page's nav link to "Account" is gone too, just "Settings" now.

**The bigger change underneath the merge**: Location Groups, Fishing
Mark Lists, and Locations — previously Admin-only, always operating on
Public's data — are now available to **any signed-in user**, each
managing their own by default. This retires the old, simpler "My
locations" card UI account.js had (name/lat/lng/type/tidal only, one
type per location) — the richer editor (map, multiple types per
location, groups, drive-times, minimum tide height) now serves
everyone, since there's no longer a separate simple/rich split to
maintain.

**What's still Admin-only**: a new "View as Public" button (in the
signed-in card) that toggles every one of those sections between the
signed-in user's own data and Public's — clicking it once switches to
Public, again switches back. This is genuinely the same mechanism
that's existed since the v2 migration (`?userId=public`,
`resolveEffectiveUserId`) — the button just makes it a client-side
toggle instead of something hardcoded into every fetch call.
`/api/settings` (check-frequency) was extended to accept the same
`?userId=` override so it toggles too, for consistency, even though no
scheduler exists yet to act on any user's setting, Public's included.

**Home address and "Refresh data now" stay strictly Admin-only and
UNAFFECTED by the toggle** — moved into their own `adminOnlyControls`
block, since both are site-wide concepts with no per-user meaning; they
always act on the real site regardless of whether the Admin is
currently "viewing as Public" or not.

**One real config change needed on deploy**: the Worker's
`FRONTEND_ACCOUNT_URL` secret pointed at `account.html` — update it to
`locations.html` (or wherever Settings lives), or Google sign-in will
redirect to a page that no longer exists.

**Verified**: a real headless-browser test across all three states —
signed out (only the sign-in card shows), a Basic user (their own
settings/locations, no toggle, no admin controls), and an Admin
(toggle visible, clicking it correctly switches every section's
requests to `?userId=public`, clicking again correctly reverts) —
zero JS errors throughout.

### Copy a location to the other account

Each saved location card gets a button, Admin-only: **"Copy to
Public"** when viewing as self, **"Copy to My Account"** when
currently viewing as Public (`copyLocationToOtherAccount`,
`locationsadmin.js`). Copies the place's own fields (name, lat/lng,
shore, tide offset, tidal, WillyWeather match) AND every one of its
type entries (each with its own drive/setup/pack-up/time-to-spot/
minimum-tide-height) — always as a genuinely new location in the
target account (no dedup against an existing same-named one there,
same convention every other location-creation path already follows).

For a location with more than one type, the first type's `POST`
creates the place; every type after that carries that first response's
`location.id` so all of them land on ONE copied place, not one place
per type. Each type is matched by name against the TARGET account's
own existing types first (reusing "Kayak" there if it already has one)
rather than always defining a fresh one, which would otherwise create
duplicate same-named types every time something gets copied.

**Deliberately does not copy group membership** — groups are a
separate, per-account vocabulary, and assuming a same-named group in
the target account means the same thing isn't safe to do silently. A
copied location lands with no groups assigned in its new account; add
them by hand there if needed.

**Verified**: a real headless-browser test with a two-type location —
confirmed the button only appears for Admin and is labelled correctly
for the current viewing mode, and that copying it reuses the target's
existing matching type for the first type while defining a new one for
the second, with both correctly attached to the same newly-created
location.

### Two real bugs found and fixed after deploy

**Deleting any tracked location (or removing a type from one) returned
a 500.** Root cause: `schema-v2.sql`'s `CREATE TABLE IF NOT EXISTS
schedule_state` was a silent no-op against the already-deployed
database — v1's original `schema.sql` had already created a
`schedule_state` table, keyed by `user_location_id` (a reference to the
old, deprecated `user_locations` table). `handleTrackedItem`'s DELETE
handler (`user-backend.js`) correctly referenced
`user_location_access_id`, exactly matching what `schema-v2.sql`
*claimed* to create — but that column never actually existed on the
real table, since the `CREATE TABLE IF NOT EXISTS` did nothing. Every
delete threw a genuine SQL error. Reproduced directly against a
simulation of the real combined v1+v2 schema before fixing — confirmed
the error, applied `migration-fix-schedule-state.sql` (a plain `ALTER
TABLE ADD COLUMN`), confirmed the same delete then succeeds. No code
change needed — `handleTrackedItem` was already correct; the schema was
incomplete. `schema-v2.sql` itself is accurate for a brand-new deploy
from scratch — it just was never what actually ran against this
project's own database.

(Cloudflare's own error page for that particular class of failure
doesn't carry CORS headers, which is why it initially looked like a
CORS misconfiguration in the browser console rather than a server-side
500 — worth knowing if a similar-looking error ever shows up again:
check the actual HTTP status in the Network tab, not just the console's
CORS-shaped wording, before assuming it's a CORS problem.)

**"Refresh data now" returned a 403.** Chased down over two rounds —
worth recording both, since the first theory turned out wrong and the
real fix was something else entirely.

First theory (wrong): the `GH_ACTIONS_TOKEN` setup instructions
originally said Actions-only, explicitly telling you to leave Contents
at no access. Based on community reports of similar 403s, this looked
like the likely cause, so the instructions were updated to require
Contents: Read too. That's still a reasonable permission to have, but
it turned out NOT to be the actual problem here — the token already
had Contents: Read/write from an earlier, broader token, and the 403
persisted anyway.

**Actual cause, confirmed via the Worker's own live logs**: the fetch
call to GitHub's API (`handleAdminRefreshDataNow`, `user-backend.js`)
never set a `User-Agent` header. GitHub's REST API hard-rejects any
request with none at all — a documented requirement, and the exact
wording GitHub returned (surfaced by checking Cloudflare's
Observability → Live log stream, not just the browser's console) named
it directly: *"Request forbidden by administrative rules. Please make
sure your request has a User-Agent header."* Nothing to do with the
token's permissions at all. Fixed with one added header.

**Lesson worth keeping**: the bare status code alone (403) pointed at
completely the wrong fix. Getting GitHub's own response body — via the
Worker's live logs, which this file's own `console.error` on that
failure path already writes to — was what actually solved it. Worth
checking those logs first next time something like this comes up,
rather than reasoning from the status code alone.

### Check frequency is now global and Admin-only; Users and Tiers sections added

Three related changes, all on the Settings page.

**Check frequency** was a per-user setting (anyone signed in could set
their own) — it's now a single site-wide value, Admin-only to even see.
`handleSettings` (`user-backend.js`) dropped the `?userId=` override
entirely and requires `role === "admin"` directly; the D1 row itself
now lives under a fixed sentinel key (`GLOBAL_SETTINGS_KEY = "global"`)
instead of a real user id — there's exactly one row now, not one per
account. The "View as Public" toggle no longer affects it at all, since
there's nothing left to toggle between.

**Users** — a new Admin-only section listing every real account (Public
excluded — it's not a real account to manage this way) with its role
and tier, both editable inline, saving immediately
(`GET /api/admin/users`, `PUT /api/admin/users/:id`). A real safeguard,
verified directly: the backend blocks demoting the *last* remaining
Admin account — whether that's changing your own role or someone
else's — since the site would otherwise have no way back into any
Admin-only section short of editing D1 by hand.

**Tiers** — a new Admin-only section replacing the old fixed
`MAX_BASIC_CREATED_LOCATIONS = 10` constant with editable rows
(`tiers` table: name + `max_extra_locations`). Add, rename, or change a
tier's cap, and it takes effect immediately for every user assigned to
it — no code deploy needed to adjust how many extra locations a Basic
account gets. Deleting a tier is blocked while any user is still
assigned to it (`DELETE /api/admin/tiers/:id` returns a clear error
naming how many); move them to a different tier first. A new
`users.tier_id` column tracks each user's assignment — meaningless for
Admin/Public (never capped either way), and treated as **zero** extra
locations (fails closed, not open) for a Basic user who somehow has
none assigned.

**Migration** (`migration-tiers.sql`) creates the `tiers` table, adds
the `tier_id` column, seeds a "Basic" tier matching the *old* hardcoded
cap (10) so nothing changes in practice for any existing account, and
assigns every existing Basic user to it.

**Verified**: real browser tests confirmed a Basic user sees none of
the three new/changed sections at all, while an Admin sees all three
and can change a user's role, add a tier, edit a tier's cap, and
attempt to remove an in-use tier (correctly blocked, with the backend's
own message surfaced in the UI) — zero JS errors throughout. The
location-cap logic itself (tier lookup, the actual allow/block
decision, a tier's cap being raised and immediately unblocking further
creation with no code change, and the fail-closed behaviour for a
Basic user with no tier) was verified end-to-end against real SQLite.

## Reports (`reports.html`, `reports.js`)

A new tab, added after Sessions/catch-linking/Location-Live rendering
were all settled, per Oliver's own explicit "not yet" earlier in this
project. Client-side aggregation over the same `/api/public/marks`
data every other page already reads — no new backend endpoints, no new
D1 queries, matching this whole site's existing architecture. Admin-
gated the same way Sync is (`cachedIsAdmin`).

Filters cover date range, Species/Weather Condition/Tide Condition/
Water Condition/Bait/Rig/Rod/Berley (built dynamically from whatever
values actually appear in the current data, not a hardcoded list —
so a field with no values recorded yet just doesn't show a filter for
it at all), plus Temperature and Water Depth as genuinely new numeric
range filters, per Oliver's own answer to the original scoping
questions. Every report only ever considers `type: "Catch"` marks —
Sessions/POI/Mark aren't "a catch" and would skew every count if
included.

Three reports for v1, chosen from a longer brainstormed list as the
most "solid" starting set (Oliver's own instruction — a few reports
done well over a flexible axis-picker):

1. **Catch rate by tide stage** — a bar chart (Chart.js, already a
   site dependency) of catch counts grouped by `tideCondition`.
2. **Bait/rig/rod effectiveness** — three side-by-side tables, one per
   field, catch counts per option actually used. Bait/Rig/Rod store
   comma-joined multi-values (established convention throughout this
   codebase, e.g. the Sync page's own carry-forward fields) — each
   value is split and counted individually, so "Pipi, Squid" correctly
   counts toward both Pipi's and Squid's own totals rather than being
   treated as one combined, unmatched string.
3. **Catches by location** — every catch matched to its nearest
   tracked location (`config/locations.json`, the same file
   `findNearestTrackedLocation` already uses for a single popup — this
   report loads that list ONCE itself and does its own bulk nearest-
   match scan locally, rather than repeating that function's own
   per-call fetch-and-scan once per catch, for potentially thousands
   of them).

**Two real bugs found and fixed while building this, neither about
the reports' own data**:
1. Table headers were unreadable — dark text (my own override) on a
   dark blue background (a pre-existing, site-wide `thead th` rule I
   hadn't accounted for). Fixed by removing my own conflicting `color`
   override entirely, letting the existing site-wide table style apply
   cleanly instead of fighting it — same white-on-blue headers every
   other table on the site already uses.
2. Adding "Reports" as a sixth nav tab broke the tab bar at phone
   width, site-wide — confirmed directly by comparing against the
   currently-deployed 5-tab version at 390px (no overflow) versus this
   one before the fix (25px over). Flex items don't shrink below their
   own text's natural width by default; five tabs happened to just fit,
   a sixth didn't. Fixed with `min-width: 0` on `.tabnav a` (lets
   `flex: 1` actually compress each tab, wrapping its label onto a
   second line rather than refusing to shrink at all) plus a tighter
   padding/font-size at ≤480px to keep it comfortable at real phone
   widths, not just technically non-overflowing.

**Verified**: real browser tests with deliberately varied catch data
(different tide stages, comma-joined bait/rig/rod combinations,
several distinct locations, a spread of temperatures) — confirmed the
tide chart's own Chart.js data correctly matches real counts, confirmed
comma-joined multi-values split and count correctly rather than being
tallied as one unmatched combined string, confirmed nearest-location
matching against real distance calculations, confirmed Session/POI
marks are correctly excluded from every count. Confirmed the Species
filter and the Temperature range filter each correctly narrow every
report, and confirmed Reset restores the unfiltered view. Confirmed
the not-signed-in gate hides the whole page correctly. Confirmed zero
horizontal overflow at phone width after the nav fix, and confirmed
the desktop nav is completely unaffected by the mobile-only media
query. Zero JS errors throughout.

## Multi-select and bulk edit (Location/Live maps)

First of a two-part request (the second — filtered/selected export from
the Sync page — is planned but not built yet; see the contentious-points
discussion this was scoped from). Ctrl (or Cmd, for cross-platform
parity) is the modifier throughout: Ctrl+click toggles one mark in or
out of the selection, Ctrl+drag on the map itself draws a box and
toggles every mark whose own lat/lng falls inside it — by real
geographic position, not just whichever happen to be individually
visible at the current zoom, so a box drawn over a collapsed cluster
correctly toggles its members too (Oliver's own call on that point). A
plain click, with or without an active selection, still opens that
mark's normal popup and leaves the selection completely untouched
(also Oliver's own call) — closing that popup reverts the panel back
to showing the selection summary if one is still active, rather than
just going blank.

Once ≥1 marks are selected, the shared side panel
(`#markDetailPanel` — the same one a single mark's own edit popup
already uses) shows "N marks selected" with Bulk edit / Clear
selection. The bulk-edit form gives every field a genuine tri-state:
"No change" (a distinct sentinel from an actual empty value — a plain
2-option dropdown can't tell "leave as-is" apart from "clear it"),
an explicit clear, or a real value — and only ever sends the fields
actually touched. **No backend changes were needed for this at all**:
`mergeMarkFields` (`user-backend.js`) already treats an omitted key in
the request body as "leave this exactly as it is" — confirmed directly
by reading that code before building anything, rather than assumed.
Saving does one `saveMarkToD1` PUT per selected mark (the exact same
call a single mark's own edit form already makes), reports a clear
count on partial failure rather than silently losing track of which
ones didn't save, and only clears the selection on a fully successful
save (a partial failure leaves it in place so the person can retry).

**A real bug found and fixed while building the Ctrl+click side of
this**: stopping propagation on the "click" event alone wasn't
enough — mousedown always fires before click, and the map's own
box-select mousedown handler doesn't know or care whether a mousedown
landed on a marker or on open water; it started a drag either way once
it saw Ctrl held. A held-Ctrl click on a marker was being silently
swallowed by the box-select logic (a near-zero-movement "drag" it
correctly ignores) before the marker's own click handler ever got a
chance to fire — toggling nothing. Confirmed directly by instrumenting
every relevant event and observing the real firing order, rather than
assumed from reading the code. Fixed by also stopping propagation on
the marker's own mousedown, not just its click.

**A significant test-environment limitation, found and worked around
rather than chased as a bug**: a real, physical mouse click on a
Canvas-rendered marker could not be made to register through
Playwright's own synthetic mouse events in this sandbox — confirmed to
be completely unrelated to anything built here by testing the exact
same click against the currently-deployed, completely untouched
`charts.js` and finding the identical failure. Canvas-rendered shapes
have no individual DOM element of their own to click, unlike SVG, and
whatever Playwright's synthetic events don't provide that a real
mouse/browser combination does, no amount of retrying or waiting
resolved it. Rather than leave this logic unverified, the toggle logic
itself was verified by firing the exact same Leaflet events
(`marker.fire('mousedown'/'click', {originalEvent: {ctrlKey: true,
...}})`) that a real click would produce — a deliberate substitution
for the specific part Playwright couldn't drive, not a weaker test
standing in for a real one. The box-select drag itself needed no such
workaround, since it operates on the map's own container-level mouse
events rather than depending on Canvas shape hit-testing — real mouse
drag simulation confirmed it directly.

**Verified**: the selection toggle logic (via direct event firing, for
the reason above) — Ctrl+click selecting, toggling back off, a second
mark added without disturbing the first, the panel's own count
updating correctly including plural/singular wording. A plain click on
an already-selected mark opens its popup without clearing the
selection, and closing that popup correctly reverts the panel back to
the selection summary. Clear selection empties the set and hides the
panel. Separately, box-select verified with real mouse drag
simulation: the visual box appears mid-drag and is removed on release,
selects only the marks actually inside it (confirmed a mark just
outside the box is excluded), and normal drag-to-pan still works
immediately afterwards. The full bulk-edit save flow verified against
mocked PUT requests: only the two fields actually touched appear in
the request body (confirmed by inspecting the real request payload),
identical values sent for every selected mark, untouched fields
(bait, notes, species) remain exactly as they were per-mark after
save with no cross-contamination between marks, and the selection
clears on full success. Partial failure verified separately: the
correct "N of M, showing the real server error" message, the
selection preserved (not cleared) so the person can retry, and only
the mark that actually succeeded has its local state updated.
Finally, confirmed normal single-mark popup/edit/save and the
existing hover-panel mutual exclusivity (`closeMarkDetailPanel`) are
completely unaffected by any of this. Zero JS errors throughout.

### Three follow-up fixes to multi-select (charts.js)

Reported back directly after trying the feature for real: releasing a
box-select drag was popping up "What's here?" immediately afterwards,
Ctrl+clicking a cluster zoomed in instead of selecting it, and bulk
delete wasn't there at all yet.

**Box-select triggering "What's here?" on release** — root cause:
`map.dragging.disable()` (needed for the duration of the drag, so the
map itself doesn't pan underneath it) means Leaflet never registers
the mouse movement as an actual drag in its own right, so with no drag
handler to attribute it to, it fell back to firing a plain "click" on
mouseup regardless of how far the mouse had actually moved — landing
on `handleMapClickForMarks` and popping the dialog immediately after
finishing a selection. Fixed with a flag set the moment
`initMarkSelectionBoxDrag`'s own mouseup handler finishes (for BOTH a
real box and a tiny, click-like movement — both disable/re-enable
dragging for the one gesture, so both are equally affected), checked
and cleared right at the top of `handleMapClickForMarks` before
anything else runs.

**Ctrl+click on a cluster now selects everything inside it, and
doesn't zoom or spiderfy** — `state.markerLayer`'s own
`_zoomOrSpiderfy` (leaflet.markercluster's own internal handler, bound
to `clusterclick` once when the group is first created, always
registered before anything added here) decides what to do by reading
`zoomToBoundsOnClick`/`spiderfyOnMaxZoom`/`spiderfyOnEveryZoom`
directly off `state.markerLayer.options` at the moment it runs — a
second `clusterclick` listener of this code's own further down
couldn't stop it by then, the zoom or spiderfy would already have
happened. `clustermousedown` is what actually gives this code a
chance to act first — leaflet.markercluster forwards raw mouse events
on a cluster icon with a `cluster` prefix (its own overridden `fire()`,
in the plugin's own source), firing before `clusterclick` for the
exact same physical click — so the three options are only ever turned
off there when Ctrl is held, then restored the moment this code's own
`clusterclick` handler has used them (`cluster.getAllChildMarkers()`,
recursing through any sub-clusters, not just whichever marks are
directly shown), never left off longer than that one click needs.
Each marker got a plain `_markId` property at creation, alongside its
existing Ctrl+click wiring, so this loop can look each one up in O(1)
rather than a linear scan over `state.markersById` per marker per
click.

**Bulk delete** — added, reusing `deleteMarkFromD1` (the exact same
call the single-mark delete flow already makes) once per mark, with
the same click-to-reveal confirmation the single-mark delete flow
already uses rather than a browser `confirm()`. Selecting only one
half of a Fishing Session pulls its other half in too, automatically,
matching that same single-mark delete flow's own established rule
that deleting either half removes the whole session rather than
leaving an orphaned other half behind — computed fresh each time the
Delete button is pressed, so the confirmation text is honest about the
real number of marks about to go, not just how many were actually
clicked. Each mark is removed from the map and from state as its own
delete succeeds, rather than waiting for all of them, so a partial
failure still leaves whatever DID succeed visibly gone; the marks that
failed stay selected afterwards so they're easy to retry.

**Verified**: real browser tests for all three. The box-select fix —
confirmed the flag is set after a real Ctrl+drag, confirmed
`handleMapClickForMarks` does nothing when it's set and correctly
clears it afterwards, and separately confirmed a genuine, unrelated
plain click still shows the dialog normally. The cluster fix — a real
Ctrl+click on a cluster icon confirmed to leave the zoom level
completely unchanged and the cluster unspiderfied, confirmed it
selects every mark inside (including one not directly touched),
confirmed clicking the same cluster again toggles them all back off,
and — after an early false alarm traced to the test's own marks being
clustered so tightly they were still one cluster even at the map's own
max zoom (an artifact of the test data, not the fix) — separately
confirmed on a fresh page with normally-spaced marks that a plain,
non-Ctrl click on a cluster still zooms in exactly as it always has.
Bulk delete — confirmed a plain multi-mark delete removes exactly what
was selected; confirmed selecting only one half of a session correctly
deletes both halves; confirmed partial failure reports the real error,
removes only the mark that actually succeeded, and leaves the failed
one selected. Zero JS errors throughout all of it.

### Species-first entry, simpler tooltips, and a cluster-icon CSS fix

Three separate, smaller requests. First two are straightforward and
fully verified; the third is delivered but its actual real-world
effect is honestly uncertain — see its own section below.

**Species-first gate on Catch/Mark entry** (`charts.js`,
`buildMarkPopupEditHtml`/`applySpeciesGate`) — creating or editing a
Catch or Mark with no Species chosen yet now disables every other
field in the form (Name, Date/Time, all the optional fields) except
Type and Species itself, with a short prompt explaining why. Type
stays usable so a Catch/Mark started by mistake can still be switched
away without being stuck; Species obviously has to stay usable so the
gate can ever be cleared. Choosing a species unlocks everything
immediately, live — re-run on every Type change too (alongside the
existing `applyMarkFieldVisibility`, right next to it), so switching
into or out of Catch/Mark re-evaluates the gate rather than leaving it
stuck from before. Save itself is independently blocked while gated
too, not just the disabled button — the same "don't just trust the UI
state" reasoning `handleBulkEditSave` already followed.

Changing Species also now syncs Name: a blank Name is filled with the
species straight away; a non-blank Name instead gets an inline "Change
the Name to '{species}' too?" prompt with Yes/No, rather than being
silently overwritten (or the sync never being offered at all) — using
this form's own existing click-to-reveal confirmation pattern (Delete
already works this way) rather than a native `confirm()`.

**Verified**: real browser tests — confirmed every field except
Type/Species is genuinely disabled (not just visually implied) while
gated, confirmed Save is disabled too, confirmed choosing a species
unlocks everything and correctly fills a blank Name. Separately
confirmed opening an existing mark that already has a species shows no
gate at all. For the Name-sync prompt: confirmed a non-blank Name is
never silently touched, confirmed the prompt's own text names the
actual species, and confirmed both "Yes, change it" and "No, keep it"
do exactly what they say. Zero JS errors throughout.

**Tooltip simplified** (`charts.js`, `markTooltipText`) — reported
directly as showing "a lot of redundant info": the old version
prefixed whatever the current "colour by" grouping was (species by
default, meaning a species-grouped hover often repeated the species
twice), appended the source, and duplicated the species again after
the name. Now always just `name (date) type` — the mark's own type
field (Catch/Mark/POI/Session), not a literal word — regardless of the
current colour-by setting, since that's a map-display setting, not
something a mark's own identity depends on.

**Verified**: confirmed the exact real, bound tooltip content on
actual markers for two different types matches `name (date) type`
precisely, nothing else.

**Cluster icon CSS override, delivered but unconfirmed as the real
fix** (`style.css`) — reported as: a Catch's own "+" shape, inside a
cluster, hard to make out — "shown within a circle and then being
hidden by the circle's colour". `createMarkClusterIcon`'s own comment
claimed a CSS override already existed to strip
leaflet.markercluster's default circular styling from its custom
icon, but it never actually did — added one
(`.mark-cluster-icon`/`.mark-cluster-icon > div`, background and
border-radius stripped, `!important` to beat the plugin's own rules,
scoped with a direct-child selector specifically so the satellite
shapes' own inline background colours — the actual shapes themselves —
don't get wiped out along with it).

Built and applied, but **its real effect is honestly unconfirmed**:
tested a 2-mark mixed Catch+Mark cluster and a 5-mark all-Catch
cluster, and both rendered the "+" shape clearly in every case —
including against the ORIGINAL, unfixed CSS, with no visible
difference either way. leaflet.markercluster's own default classes
weren't even present on the element in this codebase's actual setup
(a custom `iconCreateFunction`, which this project already uses,
appears to bypass the plugin's own class-adding step entirely — a
different conclusion than the original comment assumed). So this is a
reasonable, harmless defensive change — real CSS specificity issue,
genuinely fixed — but not a confirmed fix for the exact reported
visual problem, since that problem couldn't be reproduced in testing
to check against. If the "+" is still hard to make out after this
deploys, a screenshot of the actual cluster would allow a proper
diagnosis rather than another guess.

### The real cluster "+ enclosed in a circle" bug — found from a screenshot

The previous section's guess turned out to be the wrong mechanism
entirely. Sent a screenshot of the actual cluster with hand-drawn
arrows pointing at exactly which shapes looked wrong — dashed lines
radiating from a centre point (a spiderfied cluster, not a collapsed
one) with two "+" marks visibly trapped inside solid circles.

Root cause: the spiderfy overlay (built earlier — see "The 10 o'clock
spiderfy bug" above, the fix for zero-size/unclickable Canvas markers
during spiderfy) always drew a plain `L.circleMarker` for every
spiderfied mark, regardless of what shape that mark actually is. A
Catch's own "+" (`getCrossMarkerClass`) or a POI's own diamond
(`getDiamondMarkerClass`) got replaced with a plain filled circle the
instant its cluster spiderfied open — sitting opaquely on top of, and
hiding, the real Canvas-rendered shape still underneath it. Exactly
matching the screenshot: a "+" visibly enclosed in a circle, the
circle's own colour hiding it.

`createMarkShapeLayer` (used for every real marker already, in
`loadAndRenderMarks`) already knows how to pick the correct shape
class for a mark — the spiderfy overlay now calls that directly
instead of hardcoding `circleMarker`, with only the renderer swapped
to the overlay's own SVG one. `getDiamondMarkerClass`/
`getCrossMarkerClass` are built by overriding `L.CircleMarker`'s own
`_project`/`_updatePath` — the same methods either renderer calls —
so they work identically under SVG, not just Canvas; no separate
SVG-specific shape code was needed.

**Verified**: real browser test — spiderfied a cluster with one Catch,
one POI, and one Mark, confirmed all 3 overlay markers now report
their own correct shape (`cross`/`diamond`/`circle` respectively, the
same `_markShapeName` property every real marker also carries) rather
than all three being circles. Confirmed the cross and circle overlays
have genuinely different rendered SVG path geometry, not just a
different internal label. Screenshot confirms it visually too — the
"+" now renders as a real, distinct plus shape rather than a solid
circle. Zero JS errors.

### Field order in the mark edit form (charts.js)

Requested directly, with an annotated screenshot numbering the wanted
order: Type, Species, Name — Date/Time and everything else following
after, unchanged. Species is no longer rendered through the same loop
as the rest of `MARK_POPUP_OPTIONAL_FIELDS`; it's pulled out and
placed explicitly between Type and Name, which also puts
`applySpeciesGate`'s own prompt right above the one field it's asking
for, rather than at the very top of the form above Type.

**Verified**: real browser test — confirmed the actual DOM order of
form fields is exactly Type, Species, Name, Date/Time (not just visual
position, the real element order), for both a brand-new mark and an
existing one being edited. Separately re-confirmed the species gate
and the Name auto-sync (both added just before this reordering) still
work correctly against the new layout — fields still correctly
disabled while gated, choosing a species still unlocks everything and
still auto-fills a blank Name. Zero JS errors.

## Swell forecast (`fetch_conditions.py`, `charts.js`)

Requested directly, once Oliver enabled the Swell Height/Period forecast
types on the WillyWeather API key: pull swell data where WillyWeather has
it for a location, add it to the graphs — an arrow facing the swell's own
direction with its period as a number inside, when a direction reading
exists, or just the period inside a circle when it doesn't.

**Backend**: `swell` added to the forecast types requested from
WillyWeather (`get_weather`), and a new reading-extraction block in
`build_readings` — Swell Height (m), Swell Period (s), Swell Dir (raw
degrees), Swell Dir Text (compass letters) — following the exact same
`(forecasts.get(X) or {}).get("days")) or []` fallback pattern `wind`
and `tides` already use, so a location WillyWeather has no swell data
for (their own docs: `null` returned for such locations — confirmed
directly against WillyWeather's own real API documentation, which
Oliver supplied directly, rather than the best-effort inference from a
second, independent integration's field names this was first built
against) simply gets no Swell readings at all, never an error. That's
genuinely where "where it exists" ends up being decided — nothing
further downstream needs to know or care whether a location has swell
or not. Direction is stored as its own raw degrees rather than the
compass-letter text wind's own reading uses, specifically because the
chart side needs a real number to point an arrow by — the compass
text is kept as a second, separate reading purely for potential
display/tooltip use. Both new reading keys flow straight through the
existing pivot-into-rows logic with no further script changes needed —
any new key added to a reading tuple already ends up in
`data/conditions.json` automatically.

**Frontend**: a new custom plugin, `buildSwellMarkersPlugin`, following
the exact same structural pattern `buildTideExtremaPlugin` (immediately
above it) already uses — one glyph per point with a real Swell Period
reading, positioned at a y matching that point's own Swell Height (the
same "let the y-position itself carry real information" reasoning
`buildTideExtremaPlugin` already uses for its own tide-height dots,
rather than a fixed row). A filled circle with the period number drawn
upright inside it; when a direction reading exists, a small triangular
pointer on the circle's own edge faces the swell's travel direction —
the exact same "+180° from the compass 'from' direction" convention
`dirToArrowRotation` (used for the existing wind arrows on this same
chart) already applies, so both read the same way: which way it's
headed, not where it came from. No direction reading — WillyWeather can
return a period with no paired direction depending on the model, a
real rather than hypothetical case — means no pointer at all, just the
plain circle with the number, per Oliver's own explicit fallback.

The period number is deliberately its own separate, unrotated
`fillText` call, drawn after the pointer rather than baked into a
single rotated canvas image the way the existing wind arrows are
(`makeArrowCanvas`, used as a Chart.js `pointStyle` that Chart.js
itself rotates) — text baked into a rotated pointStyle image would
rotate right along with the pointer and end up sideways or upside-down
at most directions, defeating the entire point of a number meant to be
read at a glance. A new hidden `ySwell` scale (0–4m, a fixed range in
the same spirit as `yPressure`'s own fixed range — swell is offshore
data from WillyWeather's own WaveWatch III / NOAA source, not
calibrated to any one sheltered bay location the way `yTide`'s own
per-location max already is) gives the plugin something to position
against. Wired into the one shared `renderConditionsChart` function
every page's own graphs already call through (`app.js`, `live.js`,
`week.js`), so this needed exactly one integration point to reach
every graph on the site, not three separate ones.

**Verified**: the plugin's own drawing calls tested directly against a
fake canvas context (this project's own established approach for
canvas-drawing plugins) — confirmed a point with period+height+direction
draws exactly one circle, one pointer path, and the period number as its
own genuinely separate, unrotated `fillText` call; confirmed a point
with no direction draws the plain circle and number with no pointer
path at all; confirmed a point with no period reading draws nothing;
confirmed a point outside the chart's own currently-visible range is
correctly skipped, same as `buildTideExtremaPlugin`'s own equivalent
check; and confirmed the pointer's own angle math genuinely applies the
+180° travel-direction convention (a direction of 0°/due-north
correctly points the pointer south/down, not north/up) — the exact
convention `dirToArrowRotation` already established for wind, checked
by name rather than assumed. Separately rendered a real Chart.js
instance with a mix of directioned, non-directioned, and absent swell
readings and screenshotted it: circles sit at visibly different
heights matching their own swell heights, pointers face visibly
different directions, the one point with no direction shows no
pointer, and every period number stays upright and legible regardless
of its own pointer's angle. Zero JS errors throughout.

Not yet done, and worth naming: the swell reading isn't surfaced in
the chart's own hover tooltip (Chart.js's tooltip only knows about real
datasets, and these markers are drawn by a plugin rather than being
one) — this delivery is the requested visual layer only. Also worth
flagging plainly: the WillyWeather field names themselves are now
confirmed directly against WillyWeather's own real API documentation
(Oliver supplied the actual example response), but the very first live
fetch after this deploys is still the first time this has run against
the real API end to end — worth a glance at that first run's own
output to confirm real swell data is actually coming through for a
coastal location, rather than assumed from here.

## Troubleshooting

- **Page loads but says "Not updated yet"**: the scheduled job hasn't run
  yet, or the manual run in step 5 wasn't done. Check the Actions tab for
  errors.
- **A location's card is empty**: check `config/locations.json` for a typo in
  the name (it must match a location search on WillyWeather, same as the
  Excel version — include the state, e.g. "VIC", for a good match). Also
  check the Actions run log for a `WARNING:` line about that location's name
  or coordinates — the script now explains exactly what it tried and why a
  match wasn't found, rather than failing silently.
- **Workflow fails with an access/authorization error**: same fix as the
  Excel version — check the enabled services in your WillyWeather API admin
  settings (Search, Forecasts → Temperature/Wind/Tides/Rainfall Probability/Sun,
  Observational Graphs → Temperature/Wind).
- **Chart has no night/twilight shading**: the day bands and headings work regardless,
  but shading needs the Sun (sunrise/sunset) forecast type enabled on your WillyWeather
  API key — see the Access error section above.
