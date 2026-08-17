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

Easiest way: use the **Locations** tab on the site itself (see "Editing locations
from the site itself" below). Or edit `config/locations.json` directly on GitHub
(click the file → pencil icon to edit → commit):

```json
{
  "name": "Flinders Pier, VIC",
  "type": "Kayak",
  "shore": "W",
  "driveTo": "00:45",
  "driveBack": "00:45",
  "prep": "00:15",
  "packUp": "00:15",
  "paddleOut": "00:20",
  "paddleBack": "00:20"
}
```

`type` must be exactly `"Kayak"` or `"Surf"` for the Condition scoring to work.
The six timing fields (`driveTo`, `driveBack`, `prep`, `packUp`, `paddleOut`,
`paddleBack`) are `HH:MM` durations — how long each part of a trip to that spot
takes. They're not currently used in any calculation on the site, just stored
per location for your own reference (and for anything built on top of them later).
Changes take effect on the next scheduled or manual run.

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

## The two condition scores

The site tracks two separate 1–5 scores per location, per hour:

- **Location Condition** — is it comfortable/safe to paddle or launch here?
  Wind speed and direction for Kayak locations (plus a graduated
  minor/medium/major penalty when wind piles onto an opposing tidal
  current — real ocean current data, not a fixed guess), wind-vs-shore
  direction for Surf.
- **Fishing Condition** — are the fish likely to be active? Same formula
  everywhere regardless of Kayak/Surf, built from tide strength, tide stage,
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

This needs each location's coordinates, which come from the same
WillyWeather search lookup already used for the weather/tide fetch — no new
API calls, and nothing added to `config/locations.json` itself (coordinates
only flow into the generated `data/conditions.json`, so your own location
list stays exactly as you edit it).

## Files in this project

- `live.html`/`live.js` — the Live page (GPS-matched to your nearest tracked
  location, shows a 24-hours-back/24-hours-forward graph), `index.html` —
  Trip Planner (the site's home page), `conditions.html` — the per-location
  table/graph view, `locations.html` — the locations editor, `style.css`,
  `app.js`, `goodconditions.js`, `locationsadmin.js`, `charts.js` (shared
  charting code used by `app.js`, `goodconditions.js`, and `live.js`) — the
  website itself (no build step, no dependencies)
- `scripts/fetch_conditions.py` — fetches from WillyWeather, writes `data/conditions.json`
  (pure Python standard library only, no `pip install` needed)
- `config/locations.json` — your tracked locations
- `.github/workflows/update.yml` — the schedule that runs the fetch script
- `data/conditions.json` — the generated data file (starts empty; gets
  overwritten automatically by the workflow)

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
  Excel version — include the state, e.g. "VIC", for a good match).
- **Workflow fails with an access/authorization error**: same fix as the
  Excel version — check the enabled services in your WillyWeather API admin
  settings (Search, Forecasts → Temperature/Wind/Tides/Rainfall Probability/Sun,
  Observational Graphs → Temperature/Wind).
- **Chart has no night/twilight shading**: the day bands and headings work regardless,
  but shading needs the Sun (sunrise/sunset) forecast type enabled on your WillyWeather
  API key — see the Access error section above.
