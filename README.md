# fish2catch - Conditions, trips and catches for anglers

fish2catch is a personal fishing site: week-ahead tide/wind/weather for a set of
locations, a live "what's happening near me" map, a catch log (marks) with
reports, and import/export with Lowrance and Garmin chartplotters.

Production site: https://fish2catch.app (Cloudflare Pages, rebuilt from `main`); https://yepyepyep.app, the previous name, is still served alongside it during the transition and will later redirect. The GitHub Pages copy at
https://olivermestdagh-sys.github.io/fishingconditions/ is a legacy copy that will be switched off. The repo, the Workers
(`fishingconditions-users`, `fishingconditions-search`), the D1 database and the localStorage keys keep their old
"fishingconditions" names on purpose: they are internal, and renaming them would break things.

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
 triplogs.html Trip Logs            · D1 database (locations, marks,      · writes data/conditions.json
 locations.html Settings              pick-lists, trip logs, users,         and config/locations.json
                                      settings)
                                    · /api/public/locations (live config) · commits them back to the repo
                              ──►  Worker fishingconditions-search
                                    (willyweather-search.js) — keeps the
                                    WillyWeather API key off the browser
```

- **Frontend**: plain HTML/CSS/JS, no build step. The shared code lives in `js/*.js`
  (formerly one 9,600-line `charts.js`; older code comments that say `charts.js` mean
  these files): chart drawing, maps, marks, tide logic, backend helpers. Each page
  loads only the shared files it needs, then its own script (`app.js`, `sync.js`,
  `week.js`, ...). `npm run check-pages` (also run in CI) proves every page loads
  everything it uses.
  The Map tab (`conditions.html`) has two modes on one map: Normal (tracked spots and
  marks), Import (a Garmin/
  Lowrance export under review; `sync.js`). `sync.html` only redirects here (Live mode was removed; trips are recorded on the Trip tab).
  Export writes just the marks the current filters leave visible.
- **Data job** (until the Pipeline Worker below takes over): `scripts/fetch_conditions.py` reads the tracked locations from
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

## Pipeline Worker (built, NOT deployed yet)

`pipeline/` is the scheduled Cloudflare Worker that will replace the GitHub Actions data job (`update.yml` + `scripts/fetch_conditions.py`)
and stop committing generated data to git. It is a **Python Worker** (Pyodide): the scoring script was proven byte-identical there
(stage 0), so it runs **unmodified**. Status: code, config and tests are in `pipeline/`. The **shadow** Worker is deployed (it replays Actions' recorded runs); the **production** pipeline Worker is not. The public R2 bucket `yepyepyep-data-public` (Oceania, Standard, `r2.dev` URL disabled) exists, with the
custom domain `data.fish2catch.app` and a CORS policy for https://fish2catch.app and https://yepyepyep.app (GET/HEAD; stage 3, verified 2026-10-08 with a throwaway
object, bucket left empty). Edge caching on `data.fish2catch.app` is off (responses are `cf-cache-status: DYNAMIC`) until a Cache Rule is added, before stage 4. The site still reads `data/conditions.json` from git and Actions still runs. Cutover stages are in the
plan (shadow runs on replayed responses, 24 clean cycles, then the site switches, then Actions is retired).

How a run works (`pipeline/src/service.py`):

1. take a lock in D1 (`pipeline_lock`, so "Refresh data now" can never overlap the cron);
2. load the locations from the user Worker (`/api/pipeline/locations`, with `PIPELINE_API_TOKEN`), and the previous run from R2 (history rows);
3. **prefetch** every response the script will ask for, asynchronously (`js.fetch`, at most 6 in flight, retries with backoff; `plan.py`
   builds the URLs with the script's own functions, so they cannot drift);
4. run `fetch_conditions.main()` unmodified and synchronously, its HTTP / files / clock redirected (`runner.py`);
5. split the output by owner and keep **Public's only** (`publish.py`; the per-owner private layout is reserved, not built);
6. the **publish gate**, judged on **Public's** output only and on what the script actually produced: refuse when under 80% of public
   location/type pairs have fresh forecast rows, when rows per location fall under 70% of the last run's (so removing locations is not a "drop"), when the
   script asked for responses that were never prefetched (plan drift), or when the output is empty. A refused run writes nothing under `runs/`, leaves
   `latest.json` alone, and sends **no** side effects; an admin override (`POST /run?force=1`) publishes anyway and records `gate.forced`;
7. write the objects one at a time to `runs/<runId>/...` (immutable, cached for a year), then `manifest.json` (sizes + sha-256), re-check the D1 lock still
   belongs to this run, then flip `latest.json` LAST; prune the newest-8 rule's leftovers (only real run ids with a manifest count; unfinished older prefixes are cleaned);
8. **only for a published run**, replay the script's write side effects to the user Worker (the WillyWeather id cache PUTs, the observation archive POSTs, the prune), best
   effort. A PUT that only *clears* a cached id is never sent (an outage would wipe the curated ids);
9. write `status.json` and release the lock.

R2 layout (public bucket `yepyepyep-data-public`): `latest.json` (pointer, 60 s cache), `status.json`, `heartbeat.json`, `runs/<runId>/{conditions,locations,manifest}.json`,
`runs/<runId>/graph/{index,<hash>}.json`. Private owners (later stage) get `owner/<userId>/...` with the same shape in a separate, never-public bucket.

**Safety limits**: at most 100 WillyWeather requests per run (a normal run makes 27; a WillyWeather timeout is not retried because it may already be billed),
an 8-minute run deadline (the lock lease is 15), only the `0 */3 * * *` cron runs the billed pipeline (any other cron string does nothing), and a missing key fails cleanly before
any request. **Public files are Public-scoped**: `manifest.json` and `status.json` carry no all-owner totals, fetch statistics or raw error text, and a non-public location that
shares a name with a public one (the `locations` table has no unique name) causes that public pair to be *withheld* and counted in `counts.ambiguous`, never published mixed.

**Stale-data alert** (required; `pipeline/src/alerts.py`, `service.watchdog`): an hourly watchdog cron, independent of the run cron, compares
`latest.json`'s `generatedAt` with the clock (stale after `STALE_HOURS` = 7, i.e. two missed 3-hourly runs), records it in `status.json`, logs `STALE` and POSTs to
`ALERT_WEBHOOK_URL` (an ntfy / Slack / Discord webhook secret) at most every 6 h. The second signal is an in-site banner the pages show from the same `latest.json`
(built in the stage that moves the site onto R2). Cloudflare Notifications on the Worker's error rate are the third; none of them can look inside an object.

**Refresh data now** keeps working: once the Worker is bound as a service (`[[services]] PIPELINE` in `wrangler.toml`, deliberately commented out until cutover),
the admin button calls the pipeline's `POST /run` (no public route; also needs `X-Pipeline-Token`). Without the binding it dispatches the GitHub workflow as before.

**Same answer on every platform** (found by the first shadow replay): the script runs on Linux CPython 3.11 (Actions), on desktop CPython 3.13 and on CPython 3.13 in WebAssembly
(the Worker), and its output must not depend on which. Two places did, and both now give the SAME values the site has always published, by rules that involve no float rounding:
(1) the direction filled into a gap in the wind readings (`compass_midpoint`, `scripts/fetch_conditions.py`) is worked out in whole compass steps, no sin/cos/atan2. Two readings an even number of
steps apart have a compass point exactly in the middle; two an odd number apart (say N and NNE) or exactly opposite have no single answer, and the old float code picked one by the last bit of
its trig. Those 72 pairs are now a written-down table (`COMPASS_TIE_RESULTS`) of what the old code answered (derived on LINUX CPython 3.11/3.12/3.13, glibc 2.39 = Actions' platform, and independent of which reading
came first; a first Windows-derived table differed on NE|SSW and NE|SW, so never regenerate it from another OS): 58 are "the counter-clockwise point" (E|ESE -> E), 14 are not (N|NNE -> NNE, N|NNW -> N, ...). They are arbitrary but stable, so they must not be "tidied" into a rule;
(2) the means in the observation archive (`_mean`, `scripts/observation_archive.py`) add left to right with a plain loop, exactly what Python 3.11's `sum()` did, because 3.12 made `sum()` a
compensated sum and moved a mean on a rounding tie (10.85) by 0.1. Any new float-sensitive step needs the same treatment; `pipeline/tests/test_platform_determinism.py` pins both (run the
suite on 3.11 and 3.13 when touching either). `pipeline/src/fetch_conditions.py` and `observation_archive.py` stay byte copies of the `scripts/` ones (test-enforced).

**Script hash**: every recording stores `scriptHash` (SHA-256 over the two script files, CRLF read as LF; `scripts/record_run.py`), and the shadow Worker carries the hash it was deployed with as a committed
constant (`pipeline/src/script_hash.py` `SCRIPT_HASH`; a test fails when the scripts change without it, and `python scripts/record_run.py --script-hash` prints the new value). Each index entry records both,
the heartbeat records the deployed one, and `verify-shadow` counts a cycle only when they agree: a recording made with another script (or before the hash existed) is replayed once as information and listed as
**superseded**, never as unclean. A recording is replayed again when its entry was made under a different deployed hash (never counted twice: the entry is replaced), and the shadow takes one recording per fire.

**Memory is judged apart from output** (2026-10-08): the Worker's `heap` figure is the size of Pyodide's wasm linear memory, which only grows, so in a warm isolate it is the high-water mark of everything
replayed. Measured on the deployed shadow (cold isolate, one 9,000-row recording replayed five times back to back): 24 MB at start, 74.9 MB after the first replay, 89.9 MB after the second, then exactly 89.9 MB
for the third to fifth: it plateaus, there is no leak (what a run leaves behind is a couple of GC objects; the script's per-run `ARCHIVE_BY_LOCATION` is cleared after every run and each replay drops its references and runs
`gc.collect()`). Equality alone decides clean/unclean and the streak, with one exception: a peak over the **115 MB ceiling** is unclean. The **90 MB watch level** is only reported. Every index entry records the peak, the
heap before, the growth, and whether the isolate was cold or warm; `verify-shadow` prints the recorded maximum and how many cycles were over each level (`--detail` per cycle). The cutover gate additionally requires
that recorded maximum to stay under the ceiling. A temporary measurement mode (replay one recording N times in one isolate) was used to take those figures and has been removed again. None of this touches the two scripts, so `SCRIPT_HASH` is unchanged.

**Shadow mode** (stage 2; code written, not deployed): before the Worker replaces Actions it replays what Actions already did and proves it gets the same answer.
`scripts/record_run.py` replaces the `python3 scripts/fetch_conditions.py` line of `update.yml`: it runs the same script with its clock pinned to the start of the run and
records every API answer, the locations, the previous output and SHA-256 hashes of every file produced, into `recordings/<runId>.json` (private locations are inside, so it is
git-ignored and uploaded only to a private R2 bucket; if the recorder exits nonzero the workflow falls back to the plain script, and the upload step is `continue-on-error`). The
**shadow Worker** (`wrangler --env shadow` -> `fishingconditions-pipeline-shadow`, crons `*/15 * * * *` and `40 */3 * * *`; it replays on ANY scheduled fire, so the schedule can be changed freely, and a fire with nothing new is a cheap no-op: one list of `recordings/` and one read of `shadow/index.json`, no D1) binds ONLY the private bucket and D1 (its own lock row, `shadow`), has no
secrets and no public route, and its network client (`NullNet`) cannot make a request; it never sends the archive / id-cache / prune writes. For each recording it runs the Worker's
code (`shadow.py` -> `service.run_pipeline(replay=...)`), compares the script's full output with Actions' hashes byte for byte (and the set of writes it would have sent and the
number of calls it made), scans every published object for private names, publishes into `shadow/runs/...`, and appends to `shadow/index.json`. `npm run verify-shadow` prints one
line (`ON TRACK: N of 24 consecutive clean cycles, last clean at ...`, or `UNCLEAN: cycle ... first failing field ...`); an Actions run that failed neither counts nor resets the
streak, and one that succeeded without being replayed is reported as unverified.

The script's output folder (a full copy of every owner's rows, ~7 MB) is **removed** after every run (`runner.cleanup`, called in `service.run_pipeline`'s `finally`, and by `runner.run` itself if the script fails). In the Worker that folder is in Pyodide's in-memory filesystem, so a leftover is isolate memory that would pile up across invocations of a warm isolate. The tests pin this (`pipeline/tests/test_cleanup_and_noop.py`) and confine all their own temp files to one folder removed at exit (`tmpguard.py`).

Deploying it (not done): create the R2 bucket, `CREATE TABLE` `pipeline_lock` on D1 (`schema-v2.sql`), then `cd pipeline && uv sync && uv run pywrangler deploy`, then
enter `WILLYWEATHER_API_KEY`, `PIPELINE_API_TOKEN` (and optionally `ALERT_WEBHOOK_URL`) as secrets yourself. **New or changed cron schedules took about 30 minutes (once
longer) to start firing** in testing, so deploy early. Limits chosen from the gate: CPU limit 300 s (a run uses 5-10 s), Python heap peak about 67 MB cold / 81 MB warm
(limit 128 MB).

Tests: `pipeline/tests/` (unittest) run inside `npm test` through `tests/pipeline.test.mjs` when Python is available. The **parity gate** (`test_parity.py`) needs recorded fixtures
and golden outputs that contain private locations, so it runs only with `PIPELINE_PARITY_DIR` pointing at a folder outside the repo.

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
OpenStreetMap contributors; the optional sea-chart base map is
[Open Waters: Seamap](https://openwaters.io/charts/seamap) (CC BY 4.0, derived from
OpenStreetMap, VersaTiles, Seascape and Mapterhorn data — not for navigation).

> **Domain transition:** fish2catch.app runs side by side with yepyepyep.app (its API is api.fish2catch.app; both are the same Worker and database). Still intentionally on yepyepyep for now: the sign-in fallback URL, the pipeline's `PIPELINE_WORKER_URL`, and the R2 bucket name (the site branding is now fish2catch). See CLAUDE.md.
