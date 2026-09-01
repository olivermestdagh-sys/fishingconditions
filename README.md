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
  Week Ahead (the site's home page — a horizontal timeline of upcoming
  sessions across every tracked location), `conditions.html` — the
  per-location table/graph view, `locations.html` — the locations editor,
  `style.css`, `app.js`, `locationsadmin.js`, `charts.js` (shared charting
  code used by `app.js`, `week.js`, and `live.js`) — the
  website itself (no build step, no dependencies)
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
- `cloudflare-worker/willyweather-search.js` — optional, separate piece of
  infrastructure (not deployed via GitHub Pages) that powers the WillyWeather
  candidate popup on the Settings map — see "Getting real WillyWeather names
  via the map" above

## Editing locations from the site itself

There's now a **Locations** tab that lets you view and edit `config/locations.json`
without going into GitHub's file editor. Since this is a static site with no server,
saving works by committing directly to your repo from your browser — which needs a
GitHub token with permission to do that.

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

After that, edit/add/remove locations on that tab and click **Save changes** (or
**Save & refresh data now** to also trigger an immediate data pull instead of waiting
for the next scheduled run).

**If you ever want to revoke access**: either click "Forget token" on the site (clears
it from that device only), or delete/revoke the token itself from GitHub's Developer
settings page (immediately invalidates it everywhere).

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
