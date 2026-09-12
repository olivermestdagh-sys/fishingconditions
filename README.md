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
2. **A Google Routes API key**, kept in its own `config/settings.json` —
   separate from the site's actual code, so it survives untouched whenever
   `week.js` gets updated. Edit that file directly on GitHub
   (there's no Settings-page form for it) with:
   ```json
   { "googleRoutesApiKey": "your-key-here" }
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
- `config/settings.json` — API keys used client-side (currently just the
  Google Routes API key) — kept separate from the site's code so it's
  never overwritten by a code update; edit it from the Settings page
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
  locations/settings backend — see "User accounts" below. `schema.sql` is
  its D1 table setup. `account.html`/`account.js` is the site page that
  talks to it

## GPS fishing marks

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
every mark in `data/marks.json` (see `loadAndRenderMarks` in `charts.js`),
gated behind having a GitHub connection set up on the Settings tab — same
"don't clutter the map for random public visitors, but not real access
control" caveat as the rest of this site's GitHub-gated features (the file
itself is still a plain public URL). Each mark's **shape and colour** come
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
behind having a GitHub connection (same as everywhere else that writes to
this repo) — Edit swaps the popup into the same form `startNewMarkEntry`
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

Gated behind the same GitHub connection as everything else that writes to
this repo (see "Editing locations from the site itself" below) — connect
from Settings first.

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

## Editing locations from the site itself

There's now a **Locations** tab that lets you view and edit `config/locations.json`
without going into GitHub's file editor. Since this is a static site with no server,
saving works by committing directly to your repo from your browser — which needs a
GitHub token with permission to do that.

**Every section on this tab is foldable** — click any heading (GitHub
connection, Location Groups, Fishing Mark Lists, Locations, and each of
Fishing Mark Lists' own eleven sub-lists) to show or hide its content. State
is remembered per section (localStorage), so folding away what you're not
using stays folded next time — this page's own list of settings keeps
growing, and most visits only need one or two of these open at once.

**One-time setup:**

1. On GitHub: your profile photo (top right) → **Settings** → **Developer settings**
   (bottom of the left sidebar) → **Personal access tokens** → **Fine-grained tokens**
   → **Generate new token**.
2. Give it a name (e.g. "Kayak site locations editor"), set an expiration (90 days is
   fine — you'll just regenerate it when it lapses).
3. **Repository access**: "Only select repositories" → choose this repo. Don't grant
   access to your other repos.
4. **Permissions** → **Repository permissions** → set **Contents** to **Read and write**.
   If you also want the "Save & refresh data now" button to work, also set **Actions**
   to **Read and write**.
5. Generate the token, copy it (you won't see it again).
6. On the site's Locations tab: enter your GitHub username, this repo's name, and paste
   the token in, then "Save connection". It's stored only in your browser's local
   storage — never sent anywhere except directly to GitHub's API.

Clicking "Save connection" actually checks the token against GitHub before doing
anything else — a real API call (confirming both that it's valid and that it has
**write** access to this repo specifically), not just "is something typed into the
box". Everything below the connection card (Location Groups, Fishing Mark Lists,
Locations) only ever shows once that check passes — a wrong, expired, or read-only
token leaves the rest of the page hidden with a clear message instead of showing
sections whose Save buttons would just fail. The same check runs again on every page
load for whatever connection's already saved, so a token that's since expired or been
revoked correctly hides everything again rather than leaving the page looking usable.

After that, edit/add/remove locations on that tab and click **Save changes** (or
**Save & refresh data now** to also trigger an immediate data pull instead of waiting
for the next scheduled run).

**If you ever want to revoke access**: either click "Forget token" on the site (clears
it from that device only, and immediately hides every section below the connection
card again), or delete/revoke the token itself from GitHub's Developer settings page
(immediately invalidates it everywhere — the next page load's own check will notice
and hide those sections here too).

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

**Current state, honestly:** this is the account/CRUD layer only. Signing
in and saving your own locations/settings works end-to-end, but nothing
yet actually calls WillyWeather on a user's behalf on that schedule — the
`schedule_state` table exists in `schema.sql` so that piece won't need a
schema migration later, but the cron sweep that would read it, and any
Stripe billing/tier-gating on top of `check_frequency_minutes`, are not
built. Every signed-in user today is functionally on the same untiered
plan, with only a floor (15 minutes) stopping an unreasonably tight
setting.

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
