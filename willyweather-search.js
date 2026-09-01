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

    if (url.pathname !== "/search") {
      return jsonResponse({ error: "Not found. Use GET /search?query=... or /search?lat=..&lng=.." }, 404, env);
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
      upstreamUrl =
        `https://api.willyweather.com.au/v2/${env.WILLYWEATHER_API_KEY}/search.json` +
        `?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&limit=${limit}`;
    } else {
      return jsonResponse({ error: "Provide either ?query=<text> or ?lat=<n>&lng=<n>." }, 400, env);
    }

    let upstreamData;
    try {
      const upstreamRes = await fetch(upstreamUrl, { headers: { "Content-Type": "application/json" } });
      if (!upstreamRes.ok) {
        console.error(`WillyWeather search returned ${upstreamRes.status}`);
        return jsonResponse({ error: "WillyWeather search failed upstream." }, 502, env);
      }
      upstreamData = await upstreamRes.json();
    } catch (err) {
      console.error("WillyWeather search request failed:", err);
      return jsonResponse({ error: "WillyWeather search request failed." }, 502, env);
    }

    // WillyWeather's response is already close to what the browser needs —
    // this just strips it down to exactly the fields locationsadmin.js's
    // candidate popup actually displays/stores, rather than passing
    // through whatever else WillyWeather's response happens to include.
    const candidates = (Array.isArray(upstreamData) ? upstreamData : [])
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
