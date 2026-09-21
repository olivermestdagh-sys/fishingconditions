# Olie's Kayak and Surf Fishing Conditions

A personal fishing-conditions site: week-ahead tide/wind/weather for a set of
locations, a live "what's happening near me" map, a catch log (marks) with
reports, and import/export with Lowrance and Garmin chartplotters.

Live site: https://olivermestdagh-sys.github.io/fishingconditions/

> The previous, very detailed README (design history and per-feature notes)
> is kept in [`docs/architecture-notes-archive.md`](docs/architecture-notes-archive.md).
> It predates several changes (marks and locations now live in a database,
> tide extremes, the privacy model below), so treat it as background, not as
> the current reference.

## How it fits together

```
 GitHub Pages (static site)            Cloudflare                        GitHub Actions
 ─────────────────────────            ──────────                        ──────────────
 index.html   Week Ahead     ──►  Worker fishingconditions-users  ◄──  update.yml (every 3 h)
 conditions.html  Map (Live, Import)  (user-backend.js)                    runs scripts/fetch_conditions.py
 reports.html Reports               · Google sign-in + sessions           · WillyWeather + Open-Meteo data
 locations.html Settings            · D1 database (locations, marks,      · writes data/conditions.json
                                      pick-lists, users, settings)          and config/locations.json
                                    · /api/public/locations (live config) · commits them back to the repo
                              ──►  Worker fishingconditions-search
                                    (willyweather-search.js) — keeps the
                                    WillyWeather API key off the browser
```

- **Frontend**: plain HTML/CSS/JS, no build step. The shared code lives in `js/*.js`
  (formerly one 9,600-line `charts.js`; older code comments that say `charts.js` mean
  these files): chart drawing, maps, marks, tide logic, backend helpers. Each page
  loads only the shared files it needs, then its own script (`app.js`, `map-live.js`, `sync.js`,
  `week.js`, ...). `npm run check-pages` (also run in CI) proves every page loads
  everything it uses.
  The Map tab (`conditions.html`) has three modes on one map: Normal (tracked spots and
  marks), Live (GPS, nearest spot, tap to log a catch; `map-live.js`) and Import (a Garmin/
  Lowrance export under review; `sync.js`). `live.html` and `sync.html` only redirect here.
  Export writes just the marks the current filters leave visible.
- **Data job**: `scripts/fetch_conditions.py` reads the tracked locations from
  the worker, fetches forecasts (locations in parallel), scores them and writes
  `data/conditions.json` (compact JSON). The pages load that file for the graphs.
- **Live configuration**: display names, groups, timings, tide offsets etc. are
  read straight from the database at page load (`/api/public/locations`, merged
  by `mergeLiveLocationConfig` in `js/chart-render.js`), so a Settings edit shows up
  without waiting for the data job. Only WillyWeather-derived numbers and
  scores need the job.
- **Database (Cloudflare D1, `fishingconditions-users`)**: schema in
  `schema-v2.sql` (`schema.sql` is the original v1 layout, still the source for
  the settings table).

## Tide condition and tide extreme

Marks record a **Tide Condition** (Slack High/Low, Start/Last Run In/Out,
Running In/Out) and, for the mixed semidiurnal tides in both bays, a **Tide
Extreme**: HHW/LHW (higher/lower high water) or HLW/LLW (higher/lower low
water), ranked against the other high/low of the same day. The extreme is the
one the condition is *at* (Slack), *just left* (Start Run) or *heading to*
(Last Run / Running). Logic: `classifyTideFromExtrema` and `rankExtremum` in
`js/marks-core.js`; used for live quick marks, map clicks and imports.

## Privacy model

- Anonymous visitors see conditions and the list of tracked locations only.
- Marks (`/api/public/marks`) and the home location / Google Routes key
  (`/api/public/settings`) are only returned to a signed-in user, scoped to
  that user's own data (Admin = the shared `public` account).
- Every state-changing request must come from the site's own origin (CSRF guard
  in `user-backend.js`); pipeline endpoints use a shared-secret header instead.
- Tracked locations, including the Admin's, are published in `conditions.json`
  and `config/locations.json`.

## Working on it

```
node --test                      # unit tests (tide logic, worker security rules, stale stamp)
```

- **CI** (`.github/workflows/ci.yml`): syntax-checks every script, runs the
  tests and compile-checks the Python on each push.
- **Deploy the worker**: `npx wrangler deploy` (config in `wrangler.toml`), or
  the `Deploy worker` workflow once `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` are added as repository secrets. The site itself
  deploys by pushing to `main`.
- **Backup the database**: `.\scripts\backup-d1.ps1` (writes a dated SQL export
  outside the repo). Keep exports out of the repo: it is public.
- **Secrets** (never committed): Worker — `GH_ACTIONS_TOKEN`,
  `GOOGLE_CLIENT_SECRET`, `PIPELINE_API_TOKEN`; GitHub Actions —
  `WILLYWEATHER_API_KEY`, `PIPELINE_WORKER_URL`, `PIPELINE_API_TOKEN`.

## Data attribution

Forecast and tide data are from [WillyWeather](https://www.willyweather.com.au/)
and Open-Meteo; WillyWeather's API terms require crediting them by name and logo
wherever their data is shown (see the credit in the page header). Map tiles ©
OpenStreetMap contributors.
