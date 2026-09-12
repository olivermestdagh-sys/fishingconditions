/**
 * user-backend — a second, separate Cloudflare Worker that adds real user
 * accounts on top of the existing free site: Google sign-in, and a
 * per-user list of locations + a check-frequency setting. This is the
 * account/subscription layer discussed separately from the site itself —
 * it does NOT touch config/locations.json, data/conditions.json, or
 * anything the free site currently reads. Those stay exactly as they are,
 * served exactly as they are today, for everyone, logged in or not.
 *
 * WHY A SEPARATE WORKER FROM willyweather-search.js: that Worker is a tiny,
 * stateless proxy with one job (hide the WillyWeather key). This one holds
 * a database, a session store, and an OAuth client secret — genuinely
 * different blast radius and a different secret set. Keeping them separate
 * means a bug or outage in one can't take the other down, and
 * willyweather-search.js's existing, working deploy is never touched by
 * anything below.
 *
 * WHY GOOGLE-ONLY: per the brief — this deliberately skips password
 * storage, password reset flows, and email deliverability (all genuinely
 * hard to get right solo) in exchange for depending on one identity
 * provider. If that's ever a real complaint (someone without/unwilling to
 * use a Google account), the `users` table's google_sub column would need
 * a sibling column for whatever's added — not a rewrite, but not free
 * either.
 *
 * AUTH FLOW (standard OAuth 2.0 "Authorization Code" flow):
 *   1. Browser hits GET /auth/login. This Worker sets a short-lived
 *      `oauth_state` cookie (a random value) and 302s to Google's own
 *      consent screen, passing that same value as the `state` param.
 *   2. User approves on Google's own page (this Worker never sees their
 *      Google password — that's the whole point of OAuth).
 *   3. Google 302s the browser back to GET /auth/callback?code=...&state=...
 *   4. This Worker checks the returned `state` matches the `oauth_state`
 *      cookie (CSRF protection — stops a third party from tricking a
 *      browser into completing a login it didn't start), then exchanges
 *      `code` for tokens directly server-to-server with Google, using this
 *      Worker's own client secret. The `id_token` that comes back is
 *      trusted WITHOUT re-verifying its signature — safe here specifically
 *      because it arrived over a direct, authenticated HTTPS call this
 *      Worker made to Google itself (not something the browser handed us),
 *      so nothing untrusted has touched it. That would NOT be safe if an
 *      id_token were ever accepted from the browser directly instead.
 *   5. The user is upserted into D1 by their Google `sub` (a stable id —
 *      NOT their email, which can change), a session row is created, and
 *      a `session` cookie (HttpOnly, Secure, SameSite=None — see CORS
 *      note below) is set before redirecting to the frontend.
 *
 * COOKIES ARE CROSS-ORIGIN: the frontend lives on GitHub Pages
 * (ALLOWED_ORIGIN), this Worker lives on *.workers.dev — a different
 * origin. That means every browser fetch() to this Worker's /api/* routes
 * needs `credentials: "include"`, and this Worker's CORS response needs
 * Access-Control-Allow-Origin set to the EXACT origin (never "*") plus
 * Access-Control-Allow-Credentials: true, or the browser silently refuses
 * to send/accept the cookie at all. The session cookie itself needs
 * SameSite=None; Secure for the same cross-origin reason.
 *
 * ENDPOINTS
 *   GET  /auth/login              -> 302 to Google
 *   GET  /auth/callback           -> completes login, 302 to the frontend
 *   POST /auth/logout             -> clears the session, 204
 *   GET  /auth/me                 -> { id, email, name } or 401
 *   GET  /api/locations           -> this user's saved locations
 *   POST /api/locations           -> create one
 *   PUT  /api/locations/:id       -> update one (must belong to caller)
 *   DELETE /api/locations/:id     -> delete one (must belong to caller)
 *   GET  /api/settings            -> this user's check-frequency settings
 *                                    (creates a default row on first read)
 *   PUT  /api/settings            -> update check-frequency settings
 *
 * NOT YET BUILT (deliberately — this round is the account/CRUD layer
 * only): nothing here actually calls WillyWeather on a user's behalf yet.
 * schedule_state (see schema.sql) exists so that piece doesn't need a
 * schema migration later, but there's no cron sweep reading it yet, and
 * no Stripe/tier-gating on check_frequency_minutes beyond the sane floor
 * enforced below (stops someone setting a 1-minute interval and burning
 * through API budget before that gating exists). Also not built: any
 * Stripe billing at all — every signed-in user today is functionally on
 * the same untiered plan.
 *
 * DEPLOYING THIS (one-time, dashboard-only — no wrangler CLI, matching
 * how willyweather-search.js is deployed):
 *   1. Google Cloud Console -> APIs & Services -> Credentials -> Create
 *      Credentials -> OAuth client ID -> Web application.
 *      - Authorized redirect URI: this Worker's own URL + "/auth/callback"
 *        (you'll get the Worker's URL in step 3 below; come back and add
 *        this after, then Save).
 *      - Copy the generated Client ID and Client Secret.
 *   2. Same Console, OAuth consent screen: fill in an app name and
 *      support email (needed even for a small/personal app), add scopes
 *      openid, email, profile (the defaults), publish it (or leave in
 *      Testing and add your own Google account under Test users while
 *      you're the only user).
 *   3. Cloudflare dashboard -> Workers & Pages -> Create -> Create Worker
 *      -> name it e.g. "fishingconditions-users" -> Deploy (placeholder)
 *      -> Edit code -> paste this file's contents in -> Save and Deploy.
 *      Copy the Worker's own URL from the top of its dashboard page.
 *   4. Workers & Pages -> D1 -> Create database (see schema.sql for the
 *      table setup) -> back on this Worker -> Settings -> Bindings ->
 *      Add -> D1 database -> variable name DB -> select that database.
 *   5. Settings -> Variables and Secrets -> Add each of:
 *      - GOOGLE_CLIENT_ID (Text)
 *      - GOOGLE_CLIENT_SECRET (Secret)
 *      - ALLOWED_ORIGIN (Text) — e.g. https://olivermestdagh-sys.github.io
 *        (no trailing slash — same value as willyweather-search.js's own)
 *      - FRONTEND_ACCOUNT_URL (Text) — where /auth/callback redirects to
 *        on success, e.g. https://olivermestdagh-sys.github.io/fishingconditions/account.html
 *      - GOOGLE_REDIRECT_URI (Text) — this Worker's own URL + "/auth/callback",
 *        the exact value entered in Google Console step 1
 *      Save and Deploy again so the new bindings/secrets take effect.
 *   6. Paste this Worker's URL into account.js's USER_BACKEND_URL constant,
 *      then deploy account.html/account.js as usual via GitHub's upload
 *      page.
 */

const SESSION_COOKIE = "session";
const STATE_COOKIE = "oauth_state";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const STATE_MAX_AGE_SECONDS = 60 * 10; // 10 minutes — just needs to outlive the Google consent screen
const MIN_CHECK_FREQUENCY_MINUTES = 15; // floor only, not tier-aware yet — see NOT YET BUILT above
const MAX_CHECK_FREQUENCY_MINUTES = 1440; // one check a day, the loosest end
const VALID_LOCATION_TYPES = new Set(["Kayak", "Land based"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    try {
      if (url.pathname === "/auth/login" && request.method === "GET") {
        return handleLogin(env);
      }
      if (url.pathname === "/auth/callback" && request.method === "GET") {
        return handleCallback(request, url, env);
      }
      if (url.pathname === "/auth/logout" && request.method === "POST") {
        return handleLogout(request, env);
      }
      if (url.pathname === "/auth/me" && request.method === "GET") {
        return handleMe(request, env);
      }
      if (url.pathname === "/api/locations") {
        return handleLocationsCollection(request, env);
      }
      const locationMatch = url.pathname.match(/^\/api\/locations\/([^/]+)$/);
      if (locationMatch) {
        return handleLocationItem(request, env, locationMatch[1]);
      }
      if (url.pathname === "/api/settings") {
        return handleSettings(request, env);
      }
    } catch (err) {
      // Belt-and-braces: an uncaught exception anywhere above should still
      // come back as a JSON error with CORS headers attached, not a bare
      // Cloudflare 500 page the browser's fetch() can't even read
      // cross-origin (a response without CORS headers is invisible to the
      // calling page's JS, not just an error it can display).
      console.error("Unhandled error:", err);
      return jsonResponse({ error: "Internal error." }, 500, env);
    }

    return jsonResponse({ error: "Not found." }, 404, env);
  },
};

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------

function handleLogin(env) {
  requireEnv(env, ["GOOGLE_CLIENT_ID", "GOOGLE_REDIRECT_URI"]);
  const state = randomToken();

  const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizeUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", env.GOOGLE_REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "openid email profile");
  authorizeUrl.searchParams.set("state", state);
  // access_type=online (not "offline") deliberately — this app never needs
  // to call Google's APIs on the user's behalf later, only to identify them
  // once at login, so there's no reason to request (or have to store) a
  // refresh token.
  authorizeUrl.searchParams.set("access_type", "online");
  authorizeUrl.searchParams.set("prompt", "select_account");

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl.toString(),
      "Set-Cookie": buildCookie(STATE_COOKIE, state, STATE_MAX_AGE_SECONDS, "Lax"),
      ...corsHeaders(env),
    },
  });
}

async function handleCallback(request, url, env) {
  requireEnv(env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "FRONTEND_ACCOUNT_URL"]);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = readCookie(request, STATE_COOKIE);

  if (!code || !state || !cookieState || state !== cookieState) {
    // Never distinguish "missing" from "mismatched" in the response body —
    // both mean the same thing to a caller (start over at /auth/login),
    // and the distinction is only ever useful for an attacker probing this.
    return jsonResponse({ error: "Invalid or expired login attempt. Please try signing in again." }, 400, env);
  }

  let tokenData;
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: env.GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      const bodyText = await tokenRes.text().catch(() => "");
      console.error(`Google token exchange returned ${tokenRes.status}: ${bodyText.slice(0, 300)}`);
      return jsonResponse({ error: "Google sign-in failed. Please try again." }, 502, env);
    }
    tokenData = await tokenRes.json();
  } catch (err) {
    console.error("Google token exchange request failed:", err);
    return jsonResponse({ error: "Google sign-in failed. Please try again." }, 502, env);
  }

  const claims = decodeIdTokenPayload(tokenData.id_token);
  if (!claims || !claims.sub || !claims.email) {
    console.error("Google id_token missing expected claims.");
    return jsonResponse({ error: "Google sign-in failed. Please try again." }, 502, env);
  }
  if (claims.email_verified === false) {
    // Rare in practice for a Google account, but if Google itself says the
    // email isn't verified, don't treat it as a trustworthy identity.
    return jsonResponse({ error: "Your Google account's email is not verified." }, 403, env);
  }

  const user = await upsertUser(env, claims);
  const sessionId = randomToken();
  const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(sessionId, user.id, expiresAt)
    .run();

  const headers = new Headers();
  headers.append("Location", env.FRONTEND_ACCOUNT_URL);
  // Overwrite the state cookie with an immediately-expired one so it can't
  // be reused (Max-Age 0 clears it) — belt-and-braces since the state
  // check above already succeeded, this just tidies up.
  headers.append("Set-Cookie", buildCookie(STATE_COOKIE, "", 0, "Lax"));
  headers.append("Set-Cookie", buildCookie(SESSION_COOKIE, sessionId, SESSION_MAX_AGE_SECONDS, "None"));
  return new Response(null, { status: 302, headers });
}

async function handleLogout(request, env) {
  const sessionId = readCookie(request, SESSION_COOKIE);
  if (sessionId) {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
  }
  return new Response(null, {
    status: 204,
    headers: {
      "Set-Cookie": buildCookie(SESSION_COOKIE, "", 0, "None"),
      ...corsHeaders(env),
    },
  });
}

async function handleMe(request, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  return jsonResponse({ id: user.id, email: user.email, name: user.name }, 200, env);
}

// ---------------------------------------------------------------------
// Locations CRUD — every query is scoped by user_id, always. There is no
// "admin" path here that can see across users; that's the whole point of
// this table existing separately from config/locations.json.
// ---------------------------------------------------------------------

async function handleLocationsCollection(request, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);

  if (request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM user_locations WHERE user_id = ? ORDER BY created_at ASC"
    )
      .bind(user.id)
      .all();
    return jsonResponse(results.map(rowToLocation), 200, env);
  }

  if (request.method === "POST") {
    const body = await readJsonBody(request);
    const validationError = validateLocationInput(body, { partial: false });
    if (validationError) return jsonResponse({ error: validationError }, 400, env);

    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO user_locations (id, user_id, name, lat, lng, willyweather_id, type, tidal, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        user.id,
        body.name,
        body.lat,
        body.lng,
        body.willyweatherId ?? null,
        body.type ?? "Kayak",
        body.tidal === false ? 0 : 1,
        now
      )
      .run();

    const created = await env.DB.prepare("SELECT * FROM user_locations WHERE id = ?").bind(id).first();
    return jsonResponse(rowToLocation(created), 201, env);
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

async function handleLocationItem(request, env, id) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);

  const existing = await env.DB.prepare("SELECT * FROM user_locations WHERE id = ? AND user_id = ?")
    .bind(id, user.id)
    .first();
  if (!existing) {
    // Same response whether the id genuinely doesn't exist or belongs to
    // someone else — a caller has no legitimate reason to distinguish
    // "not yours" from "not found", and confirming existence of another
    // user's row id would be an information leak either way.
    return jsonResponse({ error: "Location not found." }, 404, env);
  }

  if (request.method === "PUT") {
    const body = await readJsonBody(request);
    const validationError = validateLocationInput(body, { partial: true });
    if (validationError) return jsonResponse({ error: validationError }, 400, env);

    const merged = {
      name: body.name ?? existing.name,
      lat: body.lat ?? existing.lat,
      lng: body.lng ?? existing.lng,
      willyweatherId: body.willyweatherId !== undefined ? body.willyweatherId : existing.willyweather_id,
      type: body.type ?? existing.type,
      tidal: body.tidal !== undefined ? (body.tidal ? 1 : 0) : existing.tidal,
    };
    await env.DB.prepare(
      `UPDATE user_locations SET name = ?, lat = ?, lng = ?, willyweather_id = ?, type = ?, tidal = ?
       WHERE id = ? AND user_id = ?`
    )
      .bind(merged.name, merged.lat, merged.lng, merged.willyweatherId, merged.type, merged.tidal, id, user.id)
      .run();

    const updated = await env.DB.prepare("SELECT * FROM user_locations WHERE id = ?").bind(id).first();
    return jsonResponse(rowToLocation(updated), 200, env);
  }

  if (request.method === "DELETE") {
    // Explicit cleanup of the dependent schedule_state row rather than
    // relying on the schema's ON DELETE CASCADE alone — D1's handling of
    // SQLite foreign-key pragmas wasn't verified against a real deploy, so
    // this doesn't assume it actually cascades.
    await env.DB.prepare("DELETE FROM schedule_state WHERE user_location_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM user_locations WHERE id = ? AND user_id = ?").bind(id, user.id).run();
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

function rowToLocation(row) {
  return {
    id: row.id,
    name: row.name,
    lat: row.lat,
    lng: row.lng,
    willyweatherId: row.willyweather_id,
    type: row.type,
    tidal: !!row.tidal,
    createdAt: row.created_at,
  };
}

function validateLocationInput(body, { partial }) {
  if (!body || typeof body !== "object") return "Request body must be a JSON object.";
  if (!partial || body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) return "name is required.";
  }
  if (!partial || body.lat !== undefined) {
    if (typeof body.lat !== "number" || !Number.isFinite(body.lat) || body.lat < -90 || body.lat > 90) {
      return "lat must be a number between -90 and 90.";
    }
  }
  if (!partial || body.lng !== undefined) {
    if (typeof body.lng !== "number" || !Number.isFinite(body.lng) || body.lng < -180 || body.lng > 180) {
      return "lng must be a number between -180 and 180.";
    }
  }
  if (body.type !== undefined && !VALID_LOCATION_TYPES.has(body.type)) {
    return `type must be one of: ${[...VALID_LOCATION_TYPES].join(", ")}.`;
  }
  if (body.willyweatherId !== undefined && body.willyweatherId !== null && !Number.isInteger(body.willyweatherId)) {
    return "willyweatherId must be an integer or null.";
  }
  return null;
}

// ---------------------------------------------------------------------
// Settings — one row per user, created lazily on first read so there's
// no separate "provision defaults on signup" step to keep in sync.
// ---------------------------------------------------------------------

async function handleSettings(request, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);

  if (request.method === "GET") {
    let row = await env.DB.prepare("SELECT * FROM user_settings WHERE user_id = ?").bind(user.id).first();
    if (!row) {
      await env.DB.prepare("INSERT INTO user_settings (user_id) VALUES (?)").bind(user.id).run();
      row = await env.DB.prepare("SELECT * FROM user_settings WHERE user_id = ?").bind(user.id).first();
    }
    return jsonResponse(rowToSettings(row), 200, env);
  }

  if (request.method === "PUT") {
    const body = await readJsonBody(request);
    const validationError = validateSettingsInput(body);
    if (validationError) return jsonResponse({ error: validationError }, 400, env);

    const existing = await env.DB.prepare("SELECT * FROM user_settings WHERE user_id = ?").bind(user.id).first();
    const merged = {
      checkFrequencyMinutes: body.checkFrequencyMinutes ?? existing?.check_frequency_minutes ?? 180,
      activeWindowStart: body.activeWindowStart ?? existing?.active_window_start ?? "05:00",
      activeWindowEnd: body.activeWindowEnd ?? existing?.active_window_end ?? "20:00",
    };
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, check_frequency_minutes, active_window_start, active_window_end)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         check_frequency_minutes = excluded.check_frequency_minutes,
         active_window_start = excluded.active_window_start,
         active_window_end = excluded.active_window_end`
    )
      .bind(user.id, merged.checkFrequencyMinutes, merged.activeWindowStart, merged.activeWindowEnd)
      .run();

    const updated = await env.DB.prepare("SELECT * FROM user_settings WHERE user_id = ?").bind(user.id).first();
    return jsonResponse(rowToSettings(updated), 200, env);
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

function rowToSettings(row) {
  return {
    checkFrequencyMinutes: row.check_frequency_minutes,
    activeWindowStart: row.active_window_start,
    activeWindowEnd: row.active_window_end,
  };
}

function validateSettingsInput(body) {
  if (!body || typeof body !== "object") return "Request body must be a JSON object.";
  if (body.checkFrequencyMinutes !== undefined) {
    const n = body.checkFrequencyMinutes;
    if (!Number.isInteger(n) || n < MIN_CHECK_FREQUENCY_MINUTES || n > MAX_CHECK_FREQUENCY_MINUTES) {
      return `checkFrequencyMinutes must be an integer between ${MIN_CHECK_FREQUENCY_MINUTES} and ${MAX_CHECK_FREQUENCY_MINUTES}.`;
    }
  }
  for (const field of ["activeWindowStart", "activeWindowEnd"]) {
    if (body[field] !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(body[field])) {
      return `${field} must be HH:MM (24-hour), e.g. "05:00".`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

async function requireUser(request, env) {
  const sessionId = readCookie(request, SESSION_COOKIE);
  if (!sessionId) return null;
  const row = await env.DB.prepare(
    `SELECT users.* FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.id = ? AND sessions.expires_at > ?`
  )
    .bind(sessionId, Date.now())
    .first();
  return row || null;
}

async function upsertUser(env, claims) {
  const existing = await env.DB.prepare("SELECT * FROM users WHERE google_sub = ?").bind(claims.sub).first();
  if (existing) {
    // Email/name can drift on Google's side over time — keep them current
    // rather than freezing whatever was true at first sign-in.
    await env.DB.prepare("UPDATE users SET email = ?, name = ? WHERE id = ?")
      .bind(claims.email, claims.name || null, existing.id)
      .run();
    return { ...existing, email: claims.email, name: claims.name || null };
  }
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, google_sub, email, name, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, claims.sub, claims.email, claims.name || null, Date.now())
    .run();
  return { id, google_sub: claims.sub, email: claims.email, name: claims.name || null };
}

function decodeIdTokenPayload(idToken) {
  // Deliberately NOT verifying the signature here — see the AUTH FLOW
  // comment at the top of this file for why that's safe in this specific
  // context (the token came directly from Google's token endpoint over a
  // server-to-server call authenticated with this Worker's own client
  // secret, not from anything the browser supplied).
  if (!idToken || typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payloadB64 + "===".slice((payloadB64.length + 3) % 4);
    const json = atob(padded);
    return JSON.parse(json);
  } catch (err) {
    console.error("Failed to decode id_token payload:", err);
    return null;
  }
}

function randomToken() {
  // 32 random bytes, hex-encoded — used for both the CSRF state value and
  // the session id itself. crypto.getRandomValues is the Workers runtime's
  // CSPRNG (same underlying primitive Node's crypto.randomBytes uses).
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  const match = header.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function buildCookie(name, value, maxAgeSeconds, sameSite) {
  // SameSite=None is required for the session cookie because the frontend
  // (GitHub Pages) and this Worker are different origins — a same-site
  // cookie would simply never be sent on those cross-origin fetch() calls.
  // SameSite=None cookies MUST also be Secure (the runtime/browser both
  // enforce this) — not an issue here since both origins are always https.
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=${sameSite}`;
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function requireEnv(env, names) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) {
    // Fails loudly at request time rather than silently misbehaving — a
    // missing secret here means every login attempt breaks the same way,
    // so it's better to say so plainly than send someone chasing a
    // mystery 500 through Google's own OAuth error pages instead.
    throw new Error(`Missing required Worker configuration: ${missing.join(", ")}`);
  }
}

function corsHeaders(env) {
  return {
    // Deliberately NOT falling back to "*" the way willyweather-search.js
    // does — a wildcard origin is incompatible with
    // Access-Control-Allow-Credentials: true (browsers reject that
    // combination outright), and every route here needs credentials
    // (the session cookie) to mean anything.
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
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
