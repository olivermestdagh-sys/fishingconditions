# Kayak & Surf Conditions — website

A free, mobile-friendly website version of the Kayak_Conditions.xlsx workbook. A
scheduled job fetches data from WillyWeather and publishes it as a static page —
no server to run, no ongoing cost beyond WillyWeather's own API pricing.

## How it works

```
GitHub Actions (on a schedule)
  -> runs scripts/fetch_conditions.py
  -> calls the WillyWeather API (same logic as the Excel Power Query)
  -> writes data/conditions.json
  -> commits it back to the repo
GitHub Pages
  -> serves index.html, which reads data/conditions.json and renders the page
```

Your WillyWeather API key lives only as a GitHub Actions secret — it's never
sent to anyone's browser, so it's safe to make this repo public if you want.

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

Edit `config/locations.json` directly on GitHub (click the file → pencil icon
to edit → commit). Same three fields as the Excel Locations tab:

```json
{"name": "Flinders Pier, VIC", "type": "Kayak", "shore": "W"}
```

`type` must be exactly `"Kayak"` or `"Surf"` for the Condition scoring to work.
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

To adjust: change the `cron:` line, e.g. `0 */6 * * *` for every 6 hours, or
`0 6,18 * * *` for twice a day (6am/6pm UTC — remember GitHub Actions cron
runs in UTC, not Melbourne time). [crontab.guru](https://crontab.guru) is a
handy way to build/check a cron expression.

## Files in this project

- `index.html`, `style.css`, `app.js` — the website itself (no build step, no dependencies)
- `scripts/fetch_conditions.py` — fetches from WillyWeather, writes `data/conditions.json`
  (pure Python standard library only, no `pip install` needed)
- `config/locations.json` — your tracked locations
- `.github/workflows/update.yml` — the schedule that runs the fetch script
- `data/conditions.json` — the generated data file (starts empty; gets
  overwritten automatically by the workflow)

## Troubleshooting

- **Page loads but says "Not updated yet"**: the scheduled job hasn't run
  yet, or the manual run in step 5 wasn't done. Check the Actions tab for
  errors.
- **A location's card is empty**: check `config/locations.json` for a typo in
  the name (it must match a location search on WillyWeather, same as the
  Excel version — include the state, e.g. "VIC", for a good match).
- **Workflow fails with an access/authorization error**: same fix as the
  Excel version — check the enabled services in your WillyWeather API admin
  settings (Search, Forecasts → Temperature/Wind/Tides/Rainfall Probability,
  Observational Graphs → Temperature/Wind).
