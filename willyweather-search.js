/**
 * willyweather-search — a tiny Cloudflare Worker whose only job is to hold
 * the WillyWeather API key somewhere the browser can never see it, while
 * still letting the Settings tab's "click map to add location" popup ask
 * WillyWeather "what's near this point" live.
 *
 * WHY THIS HAS TO EXIST AT ALL: the site itself (locationsadmin.js et al.)
 * is served as plain static files from GitHub Pages — anyone can view
 * source. If the WillyWeather key were embedded there directly, it would
 * be sitting in public view for anyone to lift and burn through Oliver's
 * paid, metered quota. This Worker runs on Cloudflare's own servers
 * instead: the browser calls THIS Worker's URL, this Worker (and only this
 * Worker) holds the real key as a Cloudflare secret, and it forwards just
 * the search results back — never the key itself.
 *
 * ENDPOINTS
 *   GET /search?query=<text>&limit=<n>
 *   GET /search?lat=<lat>&lng=<lng>&limit=<n>
 *     Exactly one of `query` or (`lat` AND `lng`) is required. Returns a
 *     JSON array of candidate locations:
 *       [{ id, name, region, state, lat, lng }, ...]
 *     `limit` is optional, defaults to 8, capped at 15 — this endpoint is
 *     for a human to visually pick from a short list, not for bulk data.
 *     IMPORTANT (confirmed against WillyWeather's own docs): the lat/lng
 *     form can only ever return ZERO or ONE entry — WillyWeather's own
 *     coordinate search returns a single closest match, not several
 *     nearby candidates to choose between, unlike the text-query form.
 *     The array shape here is kept the same for both anyway (so the
 *     browser side only handles one response shape either way), but a map
 *     click will never actually trigger the "pick one of several" UI —
 *     only a text-query search (locationsadmin.js's manual-name fallback)
 *     realistically can.
 *
 *       [{ id, name, region, state, lat, lng }, ...]
 *     `limit` is optional, defaults to 8, capped at 15 — this endpoint is
 *     for a human to visually pick from a short list, not for bulk data.
 *
 *   GET /weather?id=<willyweatherId>&days=<n>
 *     Proxies WillyWeather's own locations/{id}/weather.json for exactly
 *     the forecast groups the site's chart needs (temperature, wind,
 *     rainfall probability, tides, sunrise/sunset, plus today's realtime
 *     observational graphs) and returns the response basically as-is —
 *     the browser-side build (see fetchWillyWeatherPreviewRows, charts.js)
 *     ports fetch_conditions.py's own build_readings() to pivot this into
 *     rows, so the shape has to stay close to WillyWeather's own. Powers
 *     the Location tab's "click map to preview a spot" feature — a live
 *     look at an UNSAVED point's conditions, no location config needed.
 *     `days` is optional, defaults to 6 (matching fetch_conditions.py's
 *     own FORECAST_DAYS default), capped at 6 — the client (charts.js's
 *     PREVIEW_FORECAST_DAYS) always passes this explicitly, so the default
 *     here is really just a fallback for a malformed/missing request.
 *
 * DEPLOYING THIS (one-time — see also the README.md section this links
 * from):
 *   1. Free account at https://dash.cloudflare.com/sign-up (no card needed).
 *   2. Workers & Pages → Create → Create Worker → give it a name (e.g.
 *      "fishingconditions-search") → Deploy (creates a placeholder first).
 *   3. Edit code → paste this file's contents in, replacing the default
 *      sample → Save and Deploy.
 *   4. Settings → Variables and Secrets → Add → name it
 *      WILLYWEATHER_API_KEY, type "Secret", paste in the SAME key already
 *      used as the WILLYWEATHER_API_KEY GitHub Actions secret → Save.
 *   5. Settings → Variables and Secrets → Add another → name it
 *      ALLOWED_ORIGIN, type "Text", value the site's own origin, e.g.
 *      https://olivermestdagh-sys.github.io (no trailing slash) → Save.
 *   6. Copy the Worker's own URL (shown at the top of its dashboard page,
 *      looks like https://fishingconditions-search.<your-subdomain>.workers.dev)
 *      and paste it into locationsadmin.js's WILLYWEATHER_SEARCH_WORKER_URL
 *      constant, then deploy that file as usual via GitHub's upload page.
 *
 * COST / ABUSE NOTE: this Worker's URL ends up visible in locationsadmin.js's
 * source, same as any client-side fetch target — CORS (the ALLOWED_ORIGIN
 * check below) stops a *browser* on another site from calling it, but
 * doesn't stop someone hitting it directly with curl if they go looking
 * for the URL. Cloudflare's free tier includes basic abuse protection, and
 * realistically this URL is never advertised anywhere and gets maybe a
 * handful of calls a week from actual use — if it's ever abused, the fix
 * is the same as any leaked key: rotate WILLYWEATHER_API_KEY here and in
 * the GitHub Actions secret, done in a couple of minutes, no code changes
 * needed.
 */

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 15;
const DEFAULT_WEATHER_DAYS = 6;
const MAX_WEATHER_DAYS = 6;
// WillyWeather's coordinate search needs an explicit search radius
// (its `range` parameter, paired with a `units` declaration) or it
// rejects the request outright — see the range/units comment on the
// lat/lng branch below for how that was actually pinned down. 25km
// comfortably covers "which real beach/ramp/river mouth is this map
// click nearest to" for this site's whole Port Phillip/Western Port
// coverage area without pulling in matches from an entirely different bay.
const DEFAULT_SEARCH_RANGE_KM = 25;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Cloudflare requires an explicit response to the CORS preflight
    // request browsers send before any actual cross-origin GET with
    // custom handling — without this, every real request would be
    // silently blocked by the browser before it even reaches here.
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (url.pathname === "/weather") {
      return handleWeather(url, env);
    }

    if (url.pathname !== "/search") {
      return jsonResponse({ error: "Not found. Use GET /search?query=... or /search?lat=..&lng=.. or /weather?id=.." }, 404, env);
    }

    if (!env.WILLYWEATHER_API_KEY) {
      // Deliberately vague to the caller (never echo config state to an
      // untrusted request) — the real detail goes to Cloudflare's own logs
      // (visible in the dashboard), not the HTTP response body.
      console.error("WILLYWEATHER_API_KEY is not configured on this Worker.");
      return jsonResponse({ error: "Search is not configured." }, 500, env);
    }

    const query = url.searchParams.get("query");
    const lat = url.searchParams.get("lat");
    const lng = url.searchParams.get("lng");
    const limit = clampLimit(url.searchParams.get("limit"));

    let upstreamUrl;
    if (query) {
      upstreamUrl =
        `https://api.willyweather.com.au/v2/${env.WILLYWEATHER_API_KEY}/search.json` +
        `?query=${encodeURIComponent(query)}&limit=${limit}`;
    } else if (lat && lng && isFiniteNumber(lat) && isFiniteNumber(lng)) {
      // WillyWeather's coordinate search requires a `range` value plus a
      // `units` declaration for it — confirmed via THREE rounds of live
      // 400 errors: "distance is a mandatory field" (missing entirely),
      // then "distance parameter has an invalid value" (present as
      // `distance`, which isn't a real option), then finally WillyWeather
      // spelling out its actual valid options directly: lat, limit, lng,
      // query, range, units. "distance" in the first two error messages
      // was WillyWeather describing the CONCEPT, not the parameter's real
      // name — worth remembering next time an error here looks solved but
      // isn't; take the API's own error text over an assumed match to its
      // own wording.
      upstreamUrl =
        `https://api.willyweather.com.au/v2/${env.WILLYWEATHER_API_KEY}/search.json` +
        `?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&range=${DEFAULT_SEARCH_RANGE_KM}&units=distance:km&limit=${limit}`;
    } else {
      return jsonResponse({ error: "Provide either ?query=<text> or ?lat=<n>&lng=<n>." }, 400, env);
    }

    let upstreamData;
    try {
      const upstreamRes = await fetch(upstreamUrl, { headers: { "Content-Type": "application/json" } });
      if (!upstreamRes.ok) {
        // Includes the upstream status/body snippet directly in the
        // response — never the API key itself, just WillyWeather's own
        // complaint (invalid key, rate limit, bad params, etc.) — so
        // whoever's debugging this can read the real cause straight out
        // of the browser's Network tab instead of hunting through
        // Cloudflare's own log UI, which doesn't reliably surface a
        // Worker's console.error() text in one place.
        const bodyText = await upstreamRes.text().catch(() => "");
        console.error(`WillyWeather search returned ${upstreamRes.status}: ${bodyText.slice(0, 300)}`);
        return jsonResponse({ error: "WillyWeather search failed upstream.", status: upstreamRes.status, detail: bodyText.slice(0, 300) }, 502, env);
      }
      upstreamData = await upstreamRes.json();
    } catch (err) {
      console.error("WillyWeather search request failed:", err);
      return jsonResponse({ error: "WillyWeather search request failed.", detail: String(err) }, 502, env);
    }

    // WillyWeather's two search modes return genuinely different shapes —
    // confirmed against WillyWeather's own docs (not guessed): "Search By
    // Query" returns a plain array of candidates, but "Search By
    // Coordinates" returns a SINGLE object ({ location: {...}, units:
    // {...} }) — there is no "several nearby candidates" available from a
    // raw lat/lng at all, only WillyWeather's own single closest match.
    // Normalized to always-an-array here so the browser side (candidate
    // picker / fetchWillyWeatherCandidates, charts.js) only ever has to
    // handle one shape regardless of which search mode ran — a coordinate
    // search's "array" is just zero or one entries, meaning the picker UI
    // for choosing between several candidates is only ever actually shown
    // for a text-query search (locationsadmin.js's manual-name fallback),
    // never for a map click.
    const rawEntries = query ? (Array.isArray(upstreamData) ? upstreamData : []) : upstreamData && upstreamData.location ? [upstreamData.location] : [];

    // This just strips WillyWeather's response down to exactly the fields
    // the candidate popup actually displays/stores, rather than passing
    // through whatever else the response happens to include.
    const candidates = rawEntries
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        region: entry.region,
        state: entry.state,
        lat: entry.lat,
        lng: entry.lng,
      }))
      .filter((c) => c.id != null && c.name);

    return jsonResponse(candidates, 200, env);
  },
};

function clampLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function clampWeatherDays(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_WEATHER_DAYS;
  return Math.min(n, MAX_WEATHER_DAYS);
}

/**
 * GET /weather?id=<willyweatherId>&days=<n> — see the ENDPOINTS comment at
 * the top of this file. Unlike /search's trimmed-down response, this
 * passes WillyWeather's weather.json through close to verbatim (just
 * unwrapped from the outer fetch/parse machinery) — the browser-side
 * build_readings() port needs the same nested forecasts/observationalGraphs
 * shape WillyWeather itself returns, not a hand-picked subset of fields.
 */
async function handleWeather(url, env) {
  if (!env.WILLYWEATHER_API_KEY) {
    console.error("WILLYWEATHER_API_KEY is not configured on this Worker.");
    return jsonResponse({ error: "Search is not configured." }, 500, env);
  }

  const id = url.searchParams.get("id");
  if (!id || !/^\d+$/.test(id)) {
    return jsonResponse({ error: "Provide ?id=<willyweatherId> (numeric)." }, 400, env);
  }
  const days = clampWeatherDays(url.searchParams.get("days"));

  const upstreamUrl =
    `https://api.willyweather.com.au/v2/${env.WILLYWEATHER_API_KEY}/locations/${id}/weather.json` +
    `?forecasts=temperature,wind,rainfallprobability,tides,sunrisesunset&days=${days}&observationalGraphs=temperature,wind`;

  try {
    const upstreamRes = await fetch(upstreamUrl, { headers: { "Content-Type": "application/json" } });
    if (!upstreamRes.ok) {
      const bodyText = await upstreamRes.text().catch(() => "");
      console.error(`WillyWeather weather.json returned ${upstreamRes.status}: ${bodyText.slice(0, 300)}`);
      return jsonResponse({ error: "WillyWeather weather lookup failed upstream.", status: upstreamRes.status, detail: bodyText.slice(0, 300) }, 502, env);
    }
    const upstreamData = await upstreamRes.json();
    return jsonResponse(upstreamData, 200, env);
  } catch (err) {
    console.error("WillyWeather weather.json request failed:", err);
    return jsonResponse({ error: "WillyWeather weather lookup request failed.", detail: String(err) }, 502, env);
  }
}

function isFiniteNumber(str) {
  const n = Number(str);
  return Number.isFinite(n);
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(env),
    },
  });
}
