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
 *      - PIPELINE_API_TOKEN (Secret) — a long, random string you generate
 *        yourself (e.g. `openssl rand -hex 32`, or any password generator).
 *        This is a completely different credential from everything above —
 *        it authenticates fetch_conditions.py (GitHub Actions), which has
 *        no browser and can't hold a session cookie. The SAME value also
 *        needs setting as the PIPELINE_API_TOKEN secret in the site repo's
 *        GitHub Actions settings (Settings -> Secrets and variables ->
 *        Actions), alongside a new PIPELINE_WORKER_URL secret there set to
 *        this Worker's own URL. See the "Pipeline" section further down.
 *      - GH_ACTIONS_TOKEN (Secret) — a GitHub Personal Access Token
 *        (fine-grained, same repo, permissions -> Actions: Read and write,
 *        nothing else — deliberately narrower than the old browser-held
 *        token, which also needed Contents:write). This is what lets
 *        "Refresh data now" (locationsadmin.js) trigger a workflow run
 *        without any GitHub token ever touching the browser — the Worker
 *        holds this one, server-side, instead. See "Admin-only endpoints"
 *        further down.
 *      - GH_REPO_OWNER (Text) — e.g. olivermestdagh-sys
 *      - GH_REPO_NAME (Text) — e.g. fishingconditions
 *      - GH_WORKFLOW_FILE (Text) — the workflow's filename, e.g. update.yml
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

// --- v2 (schema-v2.sql) constants ---
const PUBLIC_USER_ID = "public";
const MAX_BASIC_CREATED_LOCATIONS = 10; // additional private locations beyond
                                         // whatever's inherited from Public —
                                         // counted as locations THIS user
                                         // created (locations.created_by_user_id),
                                         // not total tracked count
const VALID_BEHAVES_LIKE = new Set(["Kayak", "Land based"]); // the only two
                                         // real scoring algorithms — a
                                         // user's own custom type name
                                         // (user_types.name) is free-form,
                                         // but it must declare one of these
                                         // two as what it actually scores like

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

      // --- v2 endpoints below: the unified locations/types/groups/mark-lists/
      // marks model (schema-v2.sql). Deliberately left ALONGSIDE the v1
      // /api/locations and /api/settings routes above rather than replacing
      // them — account.js still talks to v1 today, and cutting it over is
      // its own separate step, not bundled into adding these.
      if (url.pathname === "/api/types") {
        return handleTypesCollection(request, url, env);
      }
      const typeMatch = url.pathname.match(/^\/api\/types\/([^/]+)$/);
      if (typeMatch) {
        return handleTypeItem(request, url, env, typeMatch[1]);
      }
      if (url.pathname === "/api/tracked-locations") {
        return handleTrackedCollection(request, url, env);
      }
      const trackedMatch = url.pathname.match(/^\/api\/tracked-locations\/([^/]+)$/);
      if (trackedMatch) {
        return handleTrackedItem(request, url, env, trackedMatch[1]);
      }
      if (url.pathname === "/api/groups") {
        return handleGroupsCollection(request, url, env);
      }
      const groupMatch = url.pathname.match(/^\/api\/groups\/([^/]+)$/);
      if (groupMatch) {
        return handleGroupItem(request, url, env, groupMatch[1]);
      }
      const groupMembersMatch = url.pathname.match(/^\/api\/locations\/([^/]+)\/groups$/);
      if (groupMembersMatch && request.method === "PUT") {
        return handleLocationGroupMembership(request, url, env, groupMembersMatch[1]);
      }
      if (url.pathname === "/api/marklists") {
        return handleMarkListsCollection(request, url, env);
      }
      const markListMatch = url.pathname.match(/^\/api\/marklists\/([^/]+)$/);
      if (markListMatch) {
        return handleMarkListItem(request, url, env, markListMatch[1]);
      }
      if (url.pathname === "/api/marks") {
        return handleMarksCollection(request, url, env);
      }
      const markMatch = url.pathname.match(/^\/api\/marks\/([^/]+)$/);
      if (markMatch) {
        return handleMarkItem(request, url, env, markMatch[1]);
      }

      // --- Pipeline (GitHub Actions) endpoints below: authenticated by a
      // shared secret header, NOT the session cookie every route above
      // uses — fetch_conditions.py runs server-to-server with no browser,
      // so it can never hold a session. See requirePipelineToken below.
      if (url.pathname === "/api/pipeline/locations" && request.method === "GET") {
        return handlePipelineLocationsList(request, env);
      }
      const pipelineLocMatch = url.pathname.match(/^\/api\/pipeline\/locations\/([^/]+)$/);
      if (pipelineLocMatch && request.method === "PUT") {
        return handlePipelineLocationUpdate(request, env, pipelineLocMatch[1]);
      }

      // --- Public (anonymous) reads below: no session, no token — genuinely
      // open, matching that this is the exact same data anyone could
      // already fetch for free from the static config/mark_lists.json file
      // it replaces. Read-only; there is no public write path anywhere.
      if (url.pathname === "/api/public/marklists" && request.method === "GET") {
        return handlePublicMarkLists(env);
      }
      if (url.pathname === "/api/public/marks" && request.method === "GET") {
        return handlePublicMarks(env);
      }
      if (url.pathname === "/api/public/settings" && request.method === "GET") {
        return handlePublicSettings(env);
      }

      // --- Admin-only endpoints below: not scoped by effective-user-id
      // like the rest of this file — these always act on Public's own row
      // (there's exactly one site-wide home address / refresh trigger, not
      // a per-user concept), and require role === "admin" directly rather
      // than going through resolveEffectiveUserId. See each handler's own
      // comment for why.
      if (url.pathname === "/api/admin/home-location" && request.method === "PUT") {
        return handleAdminHomeLocation(request, env);
      }
      if (url.pathname === "/api/admin/refresh-data-now" && request.method === "POST") {
        const user = await requireUser(request, env);
        if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
        if (user.role !== "admin") return jsonResponse({ error: "Admin only." }, 403, env);
        return handleAdminRefreshDataNow(env);
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
  if (user.id === PUBLIC_USER_ID) {
    // Can't actually happen through a real Google login (Public's
    // google_sub, 'sentinel-no-login', isn't a value Google ever issues —
    // real ones are purely numeric) — this is belt-and-braces only, so a
    // stray future change elsewhere can't accidentally make it possible.
    console.error("Refused to issue a session for the Public sentinel user.");
    return jsonResponse({ error: "Sign-in failed." }, 500, env);
  }
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
  // role included now that it's a real column (schema-v2.sql) — the
  // frontend needs this to decide whether to show any "edit Public's
  // defaults" affordance at all.
  return jsonResponse({ id: user.id, email: user.email, name: user.name, role: user.role }, 200, env);
}

// ---------------------------------------------------------------------
// v1 Locations CRUD (user_locations table) — DEPRECATED, superseded by
// the v2 /api/tracked-locations endpoints below (same table Admin's own
// Locations page and account.js's own "My locations" now both use).
// Kept functional (still scoped correctly, still safe) rather than
// deleted outright — nothing currently calls it, but removing working
// code purely for tidiness isn't worth the risk/diff for a dead path
// that costs nothing left running. Safe to delete in a future round once
// confirmed nothing else depends on it.
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
// v2: Types (schema-v2.sql user_types) — a user's own open-ended vocabulary
// of location types, each declaring which of the two real scoring
// behaviours it uses. See VALID_BEHAVES_LIKE above for why that second
// part is fixed even though the display name isn't.
// ---------------------------------------------------------------------

async function handleTypesCollection(request, url, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const resolved = resolveEffectiveUserId(url, user);
  if (resolved.error) return jsonResponse({ error: resolved.error }, 403, env);
  const uid = resolved.id;

  if (request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM user_types WHERE user_id = ? ORDER BY created_at ASC")
      .bind(uid)
      .all();
    return jsonResponse(results.map(rowToType), 200, env);
  }

  if (request.method === "POST") {
    const body = await readJsonBody(request);
    const validationError = validateTypeInput(body, { partial: false });
    if (validationError) return jsonResponse({ error: validationError }, 400, env);

    const id = crypto.randomUUID();
    const now = Date.now();
    try {
      await env.DB.prepare("INSERT INTO user_types (id, user_id, name, behaves_like, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, uid, body.name, body.behavesLike, now)
        .run();
    } catch (err) {
      // UNIQUE(user_id, name) — the friendliest way to surface this without
      // a separate pre-check query is to just try the insert and translate
      // the constraint failure.
      return jsonResponse({ error: `You already have a type named "${body.name}".` }, 409, env);
    }
    const created = await env.DB.prepare("SELECT * FROM user_types WHERE id = ?").bind(id).first();
    return jsonResponse(rowToType(created), 201, env);
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

async function handleTypeItem(request, url, env, id) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const resolved = resolveEffectiveUserId(url, user);
  if (resolved.error) return jsonResponse({ error: resolved.error }, 403, env);
  const uid = resolved.id;

  const existing = await env.DB.prepare("SELECT * FROM user_types WHERE id = ? AND user_id = ?").bind(id, uid).first();
  if (!existing) return jsonResponse({ error: "Type not found." }, 404, env);

  if (request.method === "PUT") {
    const body = await readJsonBody(request);
    const validationError = validateTypeInput(body, { partial: true });
    if (validationError) return jsonResponse({ error: validationError }, 400, env);
    const merged = {
      name: body.name ?? existing.name,
      behavesLike: body.behavesLike ?? existing.behaves_like,
    };
    try {
      await env.DB.prepare("UPDATE user_types SET name = ?, behaves_like = ? WHERE id = ? AND user_id = ?")
        .bind(merged.name, merged.behavesLike, id, uid)
        .run();
    } catch (err) {
      return jsonResponse({ error: `You already have a type named "${merged.name}".` }, 409, env);
    }
    const updated = await env.DB.prepare("SELECT * FROM user_types WHERE id = ?").bind(id).first();
    return jsonResponse(rowToType(updated), 200, env);
  }

  if (request.method === "DELETE") {
    // Explicit in-use check rather than letting ON DELETE CASCADE silently
    // wipe every tracked location that used this type — same "explicit
    // cleanup over silent cascade" reasoning as the rest of this file.
    const inUse = await env.DB.prepare("SELECT COUNT(*) as n FROM user_location_access WHERE type_id = ?")
      .bind(id)
      .first();
    if (inUse.n > 0) {
      return jsonResponse(
        { error: `This type is used by ${inUse.n} tracked location(s) — remove those first.` },
        409,
        env
      );
    }
    await env.DB.prepare("DELETE FROM user_types WHERE id = ? AND user_id = ?").bind(id, uid).run();
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

function rowToType(row) {
  return { id: row.id, name: row.name, behavesLike: row.behaves_like };
}

function validateTypeInput(body, { partial }) {
  if (!body || typeof body !== "object") return "Request body must be a JSON object.";
  if (!partial || body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) return "name is required.";
  }
  if (!partial || body.behavesLike !== undefined) {
    if (!VALID_BEHAVES_LIKE.has(body.behavesLike)) {
      return `behavesLike must be one of: ${[...VALID_BEHAVES_LIKE].join(", ")}.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// v2: Tracked locations (the union of locations + user_location_access +
// user_types) — this is the central table. A row's existence is what
// makes a physical place show up in a user's own view at all; there is
// no separate "public" flag anywhere in this schema (see schema-v2.sql's
// own top-of-file comment for the reasoning).
// ---------------------------------------------------------------------

async function handleTrackedCollection(request, url, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const resolved = resolveEffectiveUserId(url, user);
  if (resolved.error) return jsonResponse({ error: resolved.error }, 403, env);
  const uid = resolved.id;

  if (request.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT ula.id as access_id, ula.drive_to, ula.drive_back, ula.set_up, ula.pack_up,
              ula.time_to_spot, ula.time_from_spot, ula.min_tide_height,
              l.id as location_id, l.name, l.lat, l.lng, l.willyweather_id, l.willyweather_name,
              l.willyweather_region, l.willyweather_state, l.shore, l.tide_offset, l.tide_max_observed,
              l.tidal, l.created_by_user_id,
              t.id as type_id, t.name as type_name, t.behaves_like
       FROM user_location_access ula
       JOIN locations l ON l.id = ula.location_id
       JOIN user_types t ON t.id = ula.type_id
       WHERE ula.user_id = ?
       ORDER BY l.name ASC`
    )
      .bind(uid)
      .all();

    // Group memberships fetched separately and merged in-process rather
    // than a second JOIN in the query above — a location can belong to
    // several of this user's groups at once, which would otherwise
    // multiply the main result's rows per group.
    const { results: memberRows } = await env.DB.prepare(
      `SELECT m.location_id, g.id as group_id, g.name as group_name
       FROM user_location_group_members m
       JOIN user_location_groups g ON g.id = m.group_id
       WHERE m.user_id = ?`
    )
      .bind(uid)
      .all();
    const groupsByLocation = new Map();
    for (const m of memberRows) {
      if (!groupsByLocation.has(m.location_id)) groupsByLocation.set(m.location_id, []);
      groupsByLocation.get(m.location_id).push({ id: m.group_id, name: m.group_name });
    }

    return jsonResponse(
      results.map((row) => rowToTracked(row, groupsByLocation.get(row.location_id) || [])),
      200,
      env
    );
  }

  if (request.method === "POST") {
    const body = await readJsonBody(request);
    const validationError = validateTrackedInput(body);
    if (validationError) return jsonResponse({ error: validationError }, 400, env);

    // Resolve the type: either an existing one of this user's, or create a
    // new one inline.
    let typeId = body.typeId;
    if (!typeId) {
      const newId = crypto.randomUUID();
      try {
        await env.DB.prepare("INSERT INTO user_types (id, user_id, name, behaves_like, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(newId, uid, body.newTypeName, body.newTypeBehavesLike, Date.now())
          .run();
      } catch (err) {
        return jsonResponse({ error: `You already have a type named "${body.newTypeName}".` }, 409, env);
      }
      typeId = newId;
    } else {
      const type = await env.DB.prepare("SELECT * FROM user_types WHERE id = ? AND user_id = ?").bind(typeId, uid).first();
      if (!type) return jsonResponse({ error: "typeId not found." }, 404, env);
    }

    // Resolve the location: attach to an existing one, or create a new
    // private one (subject to the Basic-tier cap on how many THIS user has
    // created — inherited/Public locations never count against it).
    let locationId = body.locationId;
    if (!locationId) {
      if (user.role === "basic") {
        const countRow = await env.DB.prepare("SELECT COUNT(*) as n FROM locations WHERE created_by_user_id = ?")
          .bind(uid)
          .first();
        if (countRow.n >= MAX_BASIC_CREATED_LOCATIONS) {
          return jsonResponse(
            { error: `Basic accounts are limited to ${MAX_BASIC_CREATED_LOCATIONS} additional private locations.` },
            403,
            env
          );
        }
      }
      locationId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO locations (id, created_by_user_id, name, lat, lng, willyweather_id, willyweather_name,
                                 willyweather_region, willyweather_state, shore, tide_offset, tide_max_observed, tidal, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          locationId,
          uid,
          body.name,
          body.lat,
          body.lng,
          body.willyweatherId ?? null,
          body.willyweatherName ?? null,
          body.willyweatherRegion ?? null,
          body.willyweatherState ?? null,
          body.shore ?? null,
          body.tideOffset ?? null,
          body.tideMaxObserved ?? null,
          body.tidal === false ? 0 : 1,
          Date.now()
        )
        .run();
    } else {
      const loc = await env.DB.prepare("SELECT id FROM locations WHERE id = ?").bind(locationId).first();
      if (!loc) return jsonResponse({ error: "locationId not found." }, 404, env);
    }

    const accessId = crypto.randomUUID();
    try {
      await env.DB.prepare(
        `INSERT INTO user_location_access
           (id, user_id, location_id, type_id, drive_to, drive_back, set_up, pack_up, time_to_spot, time_from_spot, min_tide_height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          accessId,
          uid,
          locationId,
          typeId,
          body.driveTo ?? "00:00",
          body.driveBack ?? "00:00",
          body.setUp ?? "00:00",
          body.packUp ?? "00:00",
          body.timeToSpot ?? "00:00",
          body.timeFromSpot ?? "00:00",
          body.minTideHeight ?? null,
          Date.now()
        )
        .run();
    } catch (err) {
      return jsonResponse({ error: "You're already tracking this location under that type." }, 409, env);
    }

    if (Array.isArray(body.groupIds) && body.groupIds.length) {
      await insertGroupMemberships(env, uid, locationId, body.groupIds);
    }

    return jsonResponse(await fetchOneTracked(env, accessId), 201, env);
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

async function handleTrackedItem(request, url, env, accessId) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const resolved = resolveEffectiveUserId(url, user);
  if (resolved.error) return jsonResponse({ error: resolved.error }, 403, env);
  const uid = resolved.id;

  const existing = await env.DB.prepare(
    `SELECT ula.*, l.created_by_user_id as location_owner
     FROM user_location_access ula
     JOIN locations l ON l.id = ula.location_id
     WHERE ula.id = ? AND ula.user_id = ?`
  )
    .bind(accessId, uid)
    .first();
  if (!existing) return jsonResponse({ error: "Tracked location not found." }, 404, env);

  if (request.method === "PUT") {
    const body = await readJsonBody(request);

    const scheduling = {
      driveTo: body.driveTo ?? existing.drive_to,
      driveBack: body.driveBack ?? existing.drive_back,
      setUp: body.setUp ?? existing.set_up,
      packUp: body.packUp ?? existing.pack_up, // was body.pack_up (snake_case) — a bug since
                                                 // Stage 2 that meant this field silently never
                                                 // updated; every request body uses camelCase,
                                                 // same as every other field here
      timeToSpot: body.timeToSpot ?? existing.time_to_spot,
      timeFromSpot: body.timeFromSpot ?? existing.time_from_spot,
      minTideHeight: body.minTideHeight !== undefined ? body.minTideHeight : existing.min_tide_height,
    };
    await env.DB.prepare(
      `UPDATE user_location_access
       SET drive_to = ?, drive_back = ?, set_up = ?, pack_up = ?, time_to_spot = ?, time_from_spot = ?, min_tide_height = ?
       WHERE id = ? AND user_id = ?`
    )
      .bind(
        scheduling.driveTo, scheduling.driveBack, scheduling.setUp, scheduling.packUp,
        scheduling.timeToSpot, scheduling.timeFromSpot, scheduling.minTideHeight, accessId, uid
      )
      .run();

    // Editing the PLACE's own base fields (name/lat/lng/etc) is only
    // allowed for whoever created it — tracking a location (having an
    // access row) is not the same as owning its base record. An admin
    // reaches this by passing ?userId=<the owner>, same as everywhere else.
    const placeFields = ["name", "lat", "lng", "willyweatherId", "willyweatherName", "willyweatherRegion", "willyweatherState", "shore", "tideOffset", "tideMaxObserved", "tidal"];
    const wantsPlaceEdit = placeFields.some((f) => body[f] !== undefined);
    if (wantsPlaceEdit) {
      if (existing.location_owner !== uid) {
        return jsonResponse({ error: "You can't edit this location's base details — you didn't create it." }, 403, env);
      }
      const place = await env.DB.prepare("SELECT * FROM locations WHERE id = ?").bind(existing.location_id).first();
      const merged = {
        name: body.name ?? place.name,
        lat: body.lat ?? place.lat,
        lng: body.lng ?? place.lng,
        willyweatherId: body.willyweatherId !== undefined ? body.willyweatherId : place.willyweather_id,
        willyweatherName: body.willyweatherName ?? place.willyweather_name,
        willyweatherRegion: body.willyweatherRegion ?? place.willyweather_region,
        willyweatherState: body.willyweatherState ?? place.willyweather_state,
        shore: body.shore ?? place.shore,
        tideOffset: body.tideOffset ?? place.tide_offset,
        tideMaxObserved: body.tideMaxObserved ?? place.tide_max_observed,
        tidal: body.tidal !== undefined ? (body.tidal ? 1 : 0) : place.tidal,
      };
      await env.DB.prepare(
        `UPDATE locations SET name=?, lat=?, lng=?, willyweather_id=?, willyweather_name=?, willyweather_region=?,
                               willyweather_state=?, shore=?, tide_offset=?, tide_max_observed=?, tidal=?
         WHERE id = ?`
      )
        .bind(
          merged.name,
          merged.lat,
          merged.lng,
          merged.willyweatherId,
          merged.willyweatherName,
          merged.willyweatherRegion,
          merged.willyweatherState,
          merged.shore,
          merged.tideOffset,
          merged.tideMaxObserved,
          merged.tidal,
          existing.location_id
        )
        .run();
    }

    if (Array.isArray(body.groupIds)) {
      await env.DB.prepare("DELETE FROM user_location_group_members WHERE user_id = ? AND location_id = ?")
        .bind(uid, existing.location_id)
        .run();
      if (body.groupIds.length) await insertGroupMemberships(env, uid, existing.location_id, body.groupIds);
    }

    return jsonResponse(await fetchOneTracked(env, accessId), 200, env);
  }

  if (request.method === "DELETE") {
    // Explicit cleanup, in order, rather than trusting cascade alone (same
    // reasoning as v1's location delete): schedule_state row first, then
    // this access row, then — only if this user created the place AND no
    // other access row anywhere still references it — the place itself
    // and its now-orphaned group memberships.
    await env.DB.prepare("DELETE FROM schedule_state WHERE user_location_access_id = ?").bind(accessId).run();
    await env.DB.prepare("DELETE FROM user_location_access WHERE id = ? AND user_id = ?").bind(accessId, uid).run();

    if (existing.location_owner === uid) {
      const remaining = await env.DB.prepare("SELECT COUNT(*) as n FROM user_location_access WHERE location_id = ?")
        .bind(existing.location_id)
        .first();
      if (remaining.n === 0) {
        await env.DB.prepare("DELETE FROM user_location_group_members WHERE location_id = ?").bind(existing.location_id).run();
        await env.DB.prepare("DELETE FROM locations WHERE id = ?").bind(existing.location_id).run();
      }
    }

    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

async function fetchOneTracked(env, accessId) {
  const row = await env.DB.prepare(
    `SELECT ula.id as access_id, ula.drive_to, ula.drive_back, ula.set_up, ula.pack_up,
            ula.time_to_spot, ula.time_from_spot, ula.min_tide_height,
            l.id as location_id, l.name, l.lat, l.lng, l.willyweather_id, l.willyweather_name,
            l.willyweather_region, l.willyweather_state, l.shore, l.tide_offset, l.tide_max_observed,
            l.tidal, l.created_by_user_id,
            t.id as type_id, t.name as type_name, t.behaves_like
     FROM user_location_access ula
     JOIN locations l ON l.id = ula.location_id
     JOIN user_types t ON t.id = ula.type_id
     WHERE ula.id = ?`
  )
    .bind(accessId)
    .first();
  return rowToTracked(row, []); // group list omitted on this single-row echo — the
                                 // list view is what actually needs it; callers
                                 // that need fresh groups here can re-GET the collection
}

function rowToTracked(row, groups) {
  return {
    accessId: row.access_id,
    location: {
      id: row.location_id,
      name: row.name,
      lat: row.lat,
      lng: row.lng,
      willyweatherId: row.willyweather_id,
      willyweatherName: row.willyweather_name,
      willyweatherRegion: row.willyweather_region,
      willyweatherState: row.willyweather_state,
      shore: row.shore,
      tideOffset: row.tide_offset,
      tideMaxObserved: row.tide_max_observed,
      tidal: !!row.tidal,
      createdByUserId: row.created_by_user_id,
    },
    type: { id: row.type_id, name: row.type_name, behavesLike: row.behaves_like },
    driveTo: row.drive_to,
    driveBack: row.drive_back,
    setUp: row.set_up,
    packUp: row.pack_up,
    timeToSpot: row.time_to_spot,
    timeFromSpot: row.time_from_spot,
    minTideHeight: row.min_tide_height,
    groups,
  };
}

function validateTrackedInput(body) {
  if (!body || typeof body !== "object") return "Request body must be a JSON object.";
  if (!body.typeId && !(body.newTypeName && body.newTypeBehavesLike)) {
    return "Provide either typeId or (newTypeName and newTypeBehavesLike).";
  }
  if (body.newTypeBehavesLike && !VALID_BEHAVES_LIKE.has(body.newTypeBehavesLike)) {
    return `newTypeBehavesLike must be one of: ${[...VALID_BEHAVES_LIKE].join(", ")}.`;
  }
  if (!body.locationId) {
    if (typeof body.name !== "string" || !body.name.trim()) return "name is required for a new location.";
    if (typeof body.lat !== "number" || !Number.isFinite(body.lat) || body.lat < -90 || body.lat > 90) {
      return "lat must be a number between -90 and 90.";
    }
    if (typeof body.lng !== "number" || !Number.isFinite(body.lng) || body.lng < -180 || body.lng > 180) {
      return "lng must be a number between -180 and 180.";
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// v2: Groups (schema-v2.sql user_location_groups / _group_members)
// ---------------------------------------------------------------------

async function handleGroupsCollection(request, url, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const resolved = resolveEffectiveUserId(url, user);
  if (resolved.error) return jsonResponse({ error: resolved.error }, 403, env);
  const uid = resolved.id;

  if (request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM user_location_groups WHERE user_id = ? ORDER BY name ASC")
      .bind(uid)
      .all();
    return jsonResponse(results.map((r) => ({ id: r.id, name: r.name })), 200, env);
  }

  if (request.method === "POST") {
    const body = await readJsonBody(request);
    if (!body || typeof body.name !== "string" || !body.name.trim()) {
      return jsonResponse({ error: "name is required." }, 400, env);
    }
    const id = crypto.randomUUID();
    try {
      await env.DB.prepare("INSERT INTO user_location_groups (id, user_id, name, created_at) VALUES (?, ?, ?, ?)")
        .bind(id, uid, body.name, Date.now())
        .run();
    } catch (err) {
      return jsonResponse({ error: `You already have a group named "${body.name}".` }, 409, env);
    }
    return jsonResponse({ id, name: body.name }, 201, env);
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

async function handleGroupItem(request, url, env, id) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const resolved = resolveEffectiveUserId(url, user);
  if (resolved.error) return jsonResponse({ error: resolved.error }, 403, env);
  const uid = resolved.id;

  const existing = await env.DB.prepare("SELECT * FROM user_location_groups WHERE id = ? AND user_id = ?").bind(id, uid).first();
  if (!existing) return jsonResponse({ error: "Group not found." }, 404, env);

  if (request.method === "PUT") {
    const body = await readJsonBody(request);
    if (!body || typeof body.name !== "string" || !body.name.trim()) {
      return jsonResponse({ error: "name is required." }, 400, env);
    }
    try {
      await env.DB.prepare("UPDATE user_location_groups SET name = ? WHERE id = ? AND user_id = ?").bind(body.name, id, uid).run();
    } catch (err) {
      return jsonResponse({ error: `You already have a group named "${body.name}".` }, 409, env);
    }
    return jsonResponse({ id, name: body.name }, 200, env);
  }

  if (request.method === "DELETE") {
    // No in-use check here, unlike types — a group membership row (schema's
    // user_location_group_members) has no meaning at all without its
    // group, so letting ON DELETE CASCADE clear those is the right call,
    // not a silent data-loss risk the way cascading a type or a place would be.
    await env.DB.prepare("DELETE FROM user_location_groups WHERE id = ? AND user_id = ?").bind(id, uid).run();
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

async function handleLocationGroupMembership(request, url, env, locationId) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const resolved = resolveEffectiveUserId(url, user);
  if (resolved.error) return jsonResponse({ error: resolved.error }, 403, env);
  const uid = resolved.id;

  const body = await readJsonBody(request);
  if (!Array.isArray(body.groupIds)) return jsonResponse({ error: "groupIds must be an array." }, 400, env);

  await env.DB.prepare("DELETE FROM user_location_group_members WHERE user_id = ? AND location_id = ?").bind(uid, locationId).run();
  if (body.groupIds.length) await insertGroupMemberships(env, uid, locationId, body.groupIds);

  return jsonResponse({ locationId, groupIds: body.groupIds }, 200, env);
}

async function insertGroupMemberships(env, uid, locationId, groupIds) {
  for (const groupId of groupIds) {
    // Silently skips a groupId that isn't actually this user's own — never
    // trust an id passed in a request body without checking ownership,
    // even for a low-stakes join table like this one.
    const owns = await env.DB.prepare("SELECT 1 FROM user_location_groups WHERE id = ? AND user_id = ?").bind(groupId, uid).first();
    if (!owns) continue;
    await env.DB.prepare("INSERT OR IGNORE INTO user_location_group_members (user_id, location_id, group_id) VALUES (?, ?, ?)")
      .bind(uid, locationId, groupId)
      .run();
  }
}

// ---------------------------------------------------------------------
// v2: Mark lists (schema-v2.sql user_mark_lists) — one generic table for
// every pick-list category (Mark Type, Species, Bait, Rig, conditions,
// shape/colour formats), mirroring mark_lists.json's own flat shape.
// ---------------------------------------------------------------------

async function handleMarkListsCollection(request, url, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const resolved = resolveEffectiveUserId(url, user);
  if (resolved.error) return jsonResponse({ error: resolved.error }, 403, env);
  const uid = resolved.id;

  if (request.method === "GET") {
    const field = url.searchParams.get("field");
    const stmt = field
      ? env.DB.prepare("SELECT * FROM user_mark_lists WHERE user_id = ? AND field = ? ORDER BY value ASC").bind(uid, field)
      : env.DB.prepare("SELECT * FROM user_mark_lists WHERE user_id = ? ORDER BY field ASC, value ASC").bind(uid);
    const { results } = await stmt.all();
    return jsonResponse(results.map(rowToMarkList), 200, env);
  }

  if (request.method === "POST") {
    const body = await readJsonBody(request);
    const validationError = validateMarkListInput(body, { partial: false });
    if (validationError) return jsonResponse({ error: validationError }, 400, env);
    const id = crypto.randomUUID();
    try {
      await env.DB.prepare(
        "INSERT INTO user_mark_lists (id, user_id, field, value, shape_format, color_format, color, icon, lowrance_sym, garmin_sym, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(
          id, uid, body.field, body.value, body.shapeFormat ?? null, body.colorFormat ?? null, body.color ?? null,
          body.icon ?? null, body.lowranceSym ?? null, body.garminSym ?? null, Date.now()
        )
        .run();
    } catch (err) {
      return jsonResponse({ error: `"${body.value}" already exists under ${body.field}.` }, 409, env);
    }
    const created = await env.DB.prepare("SELECT * FROM user_mark_lists WHERE id = ?").bind(id).first();
    return jsonResponse(rowToMarkList(created), 201, env);
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

async function handleMarkListItem(request, url, env, id) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const resolved = resolveEffectiveUserId(url, user);
  if (resolved.error) return jsonResponse({ error: resolved.error }, 403, env);
  const uid = resolved.id;

  const existing = await env.DB.prepare("SELECT * FROM user_mark_lists WHERE id = ? AND user_id = ?").bind(id, uid).first();
  if (!existing) return jsonResponse({ error: "Mark list entry not found." }, 404, env);

  if (request.method === "PUT") {
    const body = await readJsonBody(request);
    const validationError = validateMarkListInput(body, { partial: true });
    if (validationError) return jsonResponse({ error: validationError }, 400, env);
    const merged = {
      field: body.field ?? existing.field,
      value: body.value ?? existing.value,
      shapeFormat: body.shapeFormat !== undefined ? body.shapeFormat : existing.shape_format,
      colorFormat: body.colorFormat !== undefined ? body.colorFormat : existing.color_format,
      color: body.color !== undefined ? body.color : existing.color,
      icon: body.icon !== undefined ? body.icon : existing.icon,
      lowranceSym: body.lowranceSym !== undefined ? body.lowranceSym : existing.lowrance_sym,
      garminSym: body.garminSym !== undefined ? body.garminSym : existing.garmin_sym,
    };
    try {
      await env.DB.prepare(
        "UPDATE user_mark_lists SET field=?, value=?, shape_format=?, color_format=?, color=?, icon=?, lowrance_sym=?, garmin_sym=? WHERE id = ? AND user_id = ?"
      )
        .bind(merged.field, merged.value, merged.shapeFormat, merged.colorFormat, merged.color, merged.icon, merged.lowranceSym, merged.garminSym, id, uid)
        .run();
    } catch (err) {
      return jsonResponse({ error: `"${merged.value}" already exists under ${merged.field}.` }, 409, env);
    }
    const updated = await env.DB.prepare("SELECT * FROM user_mark_lists WHERE id = ?").bind(id).first();
    return jsonResponse(rowToMarkList(updated), 200, env);
  }

  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM user_mark_lists WHERE id = ? AND user_id = ?").bind(id, uid).run();
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

function rowToMarkList(row) {
  return {
    id: row.id,
    field: row.field,
    value: row.value,
    shapeFormat: row.shape_format,
    colorFormat: row.color_format,
    color: row.color,
    icon: row.icon,
    lowranceSym: row.lowrance_sym,
    garminSym: row.garmin_sym,
  };
}

function validateMarkListInput(body, { partial }) {
  if (!body || typeof body !== "object") return "Request body must be a JSON object.";
  if (!partial || body.field !== undefined) {
    if (typeof body.field !== "string" || !body.field.trim()) return "field is required.";
  }
  if (!partial || body.value !== undefined) {
    if (typeof body.value !== "string" || !body.value.trim()) return "value is required.";
  }
  return null;
}

// ---------------------------------------------------------------------
// v2: Marks (schema-v2.sql marks) — a user's own logged fishing marks.
// GET supports simple limit/offset paging (default 200, capped 500) since
// a real history can run into the thousands of rows — see the migration
// notes for how many currently exist.
// ---------------------------------------------------------------------

async function handleMarksCollection(request, url, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const resolved = resolveEffectiveUserId(url, user);
  if (resolved.error) return jsonResponse({ error: resolved.error }, 403, env);
  const uid = resolved.id;

  if (request.method === "GET") {
    const limit = Math.min(parseInt(url.searchParams.get("limit"), 10) || 200, 500);
    const offset = Math.max(parseInt(url.searchParams.get("offset"), 10) || 0, 0);
    const { results } = await env.DB.prepare(
      "SELECT * FROM marks WHERE user_id = ? ORDER BY date_time DESC LIMIT ? OFFSET ?"
    )
      .bind(uid, limit, offset)
      .all();
    return jsonResponse(results.map(rowToMark), 200, env);
  }

  if (request.method === "POST") {
    const body = await readJsonBody(request);
    const validationError = validateMarkInput(body, { partial: false });
    if (validationError) return jsonResponse({ error: validationError }, 400, env);
    // Accepts an optional client-supplied id (charts.js's own makeMarkId()
    // scheme, already proven unique across 2,500+ real marks) rather than
    // always generating one server-side — this is what lets a mark created
    // through the map's own draft-pin flow keep the SAME id from the
    // moment it's drawn through to being saved, matching how that existing
    // client-side code already tracks marks locally (marksById/markersById,
    // charts.js) before a save round-trip ever completes. Falls back to a
    // fresh UUID when omitted (e.g. a future caller with no id scheme of
    // its own). A collision (reusing an id that already exists) fails on
    // the PRIMARY KEY constraint below rather than silently overwriting —
    // callers are expected to generate genuinely unique ids up front.
    const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : crypto.randomUUID();
    const now = Date.now();
    try {
      await insertOrUpdateMark(env, id, uid, body, now);
    } catch (err) {
      return jsonResponse({ error: "A mark with that id already exists." }, 409, env);
    }
    const created = await env.DB.prepare("SELECT * FROM marks WHERE id = ?").bind(id).first();
    return jsonResponse(rowToMark(created), 201, env);
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

async function handleMarkItem(request, url, env, id) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const resolved = resolveEffectiveUserId(url, user);
  if (resolved.error) return jsonResponse({ error: resolved.error }, 403, env);
  const uid = resolved.id;

  const existing = await env.DB.prepare("SELECT * FROM marks WHERE id = ? AND user_id = ?").bind(id, uid).first();
  if (!existing) return jsonResponse({ error: "Mark not found." }, 404, env);

  if (request.method === "PUT") {
    const body = await readJsonBody(request);
    const validationError = validateMarkInput(body, { partial: true });
    if (validationError) return jsonResponse({ error: validationError }, 400, env);
    const merged = mergeMarkFields(existing, body);
    await env.DB.prepare(
      `UPDATE marks SET lat=?, lng=?, name=?, type=?, date_time=?, source=?, source_uuid=?, species=?, bait=?, rig=?,
                        rod=?, size=?, released=?, weather_condition=?, tide_condition=?, water_condition=?,
                        water_depth=?, water_temperature=?, temperature=?, barometer=?, wind_direction=?, wind_speed=?
       WHERE id = ? AND user_id = ?`
    )
      .bind(
        merged.lat, merged.lng, merged.name, merged.type, merged.dateTime, merged.source, merged.sourceUuid,
        merged.species, merged.bait, merged.rig, merged.rod, merged.size, merged.released,
        merged.weatherCondition, merged.tideCondition, merged.waterCondition, merged.waterDepth,
        merged.waterTemperature, merged.temperature, merged.barometer, merged.windDirection, merged.windSpeed,
        id, uid
      )
      .run();
    const updated = await env.DB.prepare("SELECT * FROM marks WHERE id = ?").bind(id).first();
    return jsonResponse(rowToMark(updated), 200, env);
  }

  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM marks WHERE id = ? AND user_id = ?").bind(id, uid).run();
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

async function insertOrUpdateMark(env, id, uid, body, now) {
  await env.DB.prepare(
    `INSERT INTO marks (id, user_id, lat, lng, name, type, date_time, source, source_uuid, species, bait, rig, rod,
                         size, released, weather_condition, tide_condition, water_condition, water_depth,
                         water_temperature, temperature, barometer, wind_direction, wind_speed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id, uid, body.lat, body.lng, body.name ?? null, body.type, body.dateTime, body.source ?? "manual",
      body.sourceUuid ?? null, body.species ?? null, body.bait ?? null, body.rig ?? null, body.rod ?? null,
      body.size ?? null, body.released ? 1 : 0, body.weatherCondition ?? null, body.tideCondition ?? null,
      body.waterCondition ?? null, body.waterDepth ?? null, body.waterTemperature ?? null, body.temperature ?? null,
      body.barometer ?? null, body.windDirection ?? null, body.windSpeed ?? null, now
    )
    .run();
}

function mergeMarkFields(existing, body) {
  return {
    lat: body.lat ?? existing.lat,
    lng: body.lng ?? existing.lng,
    name: body.name !== undefined ? body.name : existing.name,
    type: body.type ?? existing.type,
    dateTime: body.dateTime ?? existing.date_time,
    source: body.source !== undefined ? body.source : existing.source,
    sourceUuid: body.sourceUuid !== undefined ? body.sourceUuid : existing.source_uuid,
    species: body.species !== undefined ? body.species : existing.species,
    bait: body.bait !== undefined ? body.bait : existing.bait,
    rig: body.rig !== undefined ? body.rig : existing.rig,
    rod: body.rod !== undefined ? body.rod : existing.rod,
    size: body.size !== undefined ? body.size : existing.size,
    released: body.released !== undefined ? (body.released ? 1 : 0) : existing.released,
    weatherCondition: body.weatherCondition !== undefined ? body.weatherCondition : existing.weather_condition,
    tideCondition: body.tideCondition !== undefined ? body.tideCondition : existing.tide_condition,
    waterCondition: body.waterCondition !== undefined ? body.waterCondition : existing.water_condition,
    waterDepth: body.waterDepth !== undefined ? body.waterDepth : existing.water_depth,
    waterTemperature: body.waterTemperature !== undefined ? body.waterTemperature : existing.water_temperature,
    temperature: body.temperature !== undefined ? body.temperature : existing.temperature,
    barometer: body.barometer !== undefined ? body.barometer : existing.barometer,
    windDirection: body.windDirection !== undefined ? body.windDirection : existing.wind_direction,
    windSpeed: body.windSpeed !== undefined ? body.windSpeed : existing.wind_speed,
  };
}

function rowToMark(row) {
  return {
    id: row.id,
    lat: row.lat,
    lng: row.lng,
    name: row.name,
    type: row.type,
    dateTime: row.date_time,
    source: row.source,
    sourceUuid: row.source_uuid,
    species: row.species,
    bait: row.bait,
    rig: row.rig,
    rod: row.rod,
    size: row.size,
    released: !!row.released,
    weatherCondition: row.weather_condition,
    tideCondition: row.tide_condition,
    waterCondition: row.water_condition,
    waterDepth: row.water_depth,
    waterTemperature: row.water_temperature,
    temperature: row.temperature,
    barometer: row.barometer,
    windDirection: row.wind_direction,
    windSpeed: row.wind_speed,
  };
}

function validateMarkInput(body, { partial }) {
  if (!body || typeof body !== "object") return "Request body must be a JSON object.";
  if (!partial || body.lat !== undefined) {
    if (typeof body.lat !== "number" || !Number.isFinite(body.lat)) return "lat must be a number.";
  }
  if (!partial || body.lng !== undefined) {
    if (typeof body.lng !== "number" || !Number.isFinite(body.lng)) return "lng must be a number.";
  }
  if (!partial || body.type !== undefined) {
    if (typeof body.type !== "string" || !body.type.trim()) return "type is required.";
  }
  if (!partial || body.dateTime !== undefined) {
    if (typeof body.dateTime !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(body.dateTime)) {
      return 'dateTime must be "YYYY-MM-DD HH:MM:SS" (naive, matching the rest of this site).';
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// Pipeline (GitHub Actions / fetch_conditions.py) endpoints — a
// completely different trust model from everything above: no session, no
// per-user scoping, just a shared secret this Worker and the GitHub
// Actions secret both hold. This is what replaces fetch_conditions.py's
// old direct read/write of config/locations.json — see that file's own
// updated comments for the other half of this.
//
// SHAPE NOTE: the GET below deliberately mirrors the OLD config/
// locations.json array shape as closely as possible (types[] nested
// under each location, driveTo/driveBack/etc. spelled the same way) so
// fetch_conditions.py's existing field-access code needed minimal
// changes — only load_locations()/write back needed touching, not the
// scoring logic itself.
//
// CRITICAL: each type entry includes BOTH `type` (the admin's own
// display name — e.g. could be renamed, or a custom type like "SUP") AND
// `behavesLike` (always exactly "Kayak" or "Land based"). This is why
// both fields exist rather than just one: fetch_conditions.py's scoring
// functions do a literal string comparison against "Kayak"/"Land based"
// and know nothing about custom type names — they need `behavesLike`.
// Everything ELSE (the output "Type" label users see, this row's own
// dict key) has to keep using the display name `type`, since two
// different custom types could share the same `behavesLike` (a "SUP"
// and a "Kayak" both scoring like Kayak) — using `behavesLike` as a key
// anywhere would silently collide those together.
// ---------------------------------------------------------------------

function requirePipelineToken(request, env) {
  const token = request.headers.get("X-Pipeline-Token");
  return !!token && !!env.PIPELINE_API_TOKEN && token === env.PIPELINE_API_TOKEN;
}

async function handlePipelineLocationsList(request, env) {
  if (!requirePipelineToken(request, env)) {
    return jsonResponse({ error: "Invalid or missing pipeline token." }, 401, env);
  }

  const { results: locationRows } = await env.DB.prepare(
    "SELECT * FROM locations WHERE created_by_user_id = ? ORDER BY name ASC"
  )
    .bind(PUBLIC_USER_ID)
    .all();

  const { results: accessRows } = await env.DB.prepare(
    `SELECT ula.location_id, ula.drive_to, ula.drive_back, ula.set_up, ula.pack_up, ula.time_to_spot, ula.time_from_spot,
            ula.min_tide_height, t.name as type_name, t.behaves_like
     FROM user_location_access ula
     JOIN user_types t ON t.id = ula.type_id
     WHERE ula.user_id = ?`
  )
    .bind(PUBLIC_USER_ID)
    .all();
  const typesByLocation = new Map();
  for (const row of accessRows) {
    if (!typesByLocation.has(row.location_id)) typesByLocation.set(row.location_id, []);
    typesByLocation.get(row.location_id).push({
      type: row.type_name, // display name — see file-level note above
      behavesLike: row.behaves_like,
      driveTo: row.drive_to,
      driveBack: row.drive_back,
      setUp: row.set_up,
      packUp: row.pack_up,
      timeToSpot: row.time_to_spot,
      timeFromSpot: row.time_from_spot,
      minTideHeight: row.min_tide_height,
    });
  }

  const { results: memberRows } = await env.DB.prepare(
    `SELECT m.location_id, g.name as group_name
     FROM user_location_group_members m
     JOIN user_location_groups g ON g.id = m.group_id
     WHERE m.user_id = ?`
  )
    .bind(PUBLIC_USER_ID)
    .all();
  const groupsByLocation = new Map();
  for (const row of memberRows) {
    if (!groupsByLocation.has(row.location_id)) groupsByLocation.set(row.location_id, []);
    groupsByLocation.get(row.location_id).push(row.group_name);
  }

  const output = locationRows.map((loc) => {
    const groups = groupsByLocation.get(loc.id) || [];
    return {
      id: loc.id,
      name: loc.name,
      shore: loc.shore,
      tidal: !!loc.tidal, // real column now (schema-v2.sql) — confirmed against live
                          // data (Metung, VIC) rather than assumed true for everyone
      locationGroup: groups[0] || null, // legacy singular field, kept for anything that still reads it
      locationGroups: groups,
      tideOffset: loc.tide_offset,
      willyweatherId: loc.willyweather_id,
      willyweatherName: loc.willyweather_name,
      willyweatherRegion: loc.willyweather_region,
      willyweatherState: loc.willyweather_state,
      lat: loc.lat,
      lng: loc.lng,
      tideMaxObserved: loc.tide_max_observed,
      types: typesByLocation.get(loc.id) || [],
    };
  });

  return jsonResponse(output, 200, env);
}

async function handlePipelineLocationUpdate(request, env, id) {
  if (!requirePipelineToken(request, env)) {
    return jsonResponse({ error: "Invalid or missing pipeline token." }, 401, env);
  }
  const existing = await env.DB.prepare("SELECT * FROM locations WHERE id = ?").bind(id).first();
  if (!existing) return jsonResponse({ error: "Location not found." }, 404, env);

  const body = await readJsonBody(request);
  const merged = {
    willyweatherId: body.willyweatherId !== undefined ? body.willyweatherId : existing.willyweather_id,
    willyweatherName: body.willyweatherName !== undefined ? body.willyweatherName : existing.willyweather_name,
    willyweatherRegion: body.willyweatherRegion !== undefined ? body.willyweatherRegion : existing.willyweather_region,
    willyweatherState: body.willyweatherState !== undefined ? body.willyweatherState : existing.willyweather_state,
    lat: body.lat !== undefined ? body.lat : existing.lat,
    lng: body.lng !== undefined ? body.lng : existing.lng,
    tideMaxObserved: body.tideMaxObserved !== undefined ? body.tideMaxObserved : existing.tide_max_observed,
  };
  await env.DB.prepare(
    `UPDATE locations SET willyweather_id=?, willyweather_name=?, willyweather_region=?, willyweather_state=?,
                           lat=?, lng=?, tide_max_observed=?
     WHERE id = ?`
  )
    .bind(
      merged.willyweatherId, merged.willyweatherName, merged.willyweatherRegion, merged.willyweatherState,
      merged.lat, merged.lng, merged.tideMaxObserved, id
    )
    .run();

  return jsonResponse({ id, ...merged }, 200, env);
}

/**
 * The public, unauthenticated counterpart to /api/marklists?userId=public —
 * same data, same rowToMarkList shape (field/value/shapeFormat/colorFormat/
 * color/icon/lowranceSym/garminSym), but reachable by anyone, no session
 * required. This is what lets charts.js/sync.js (loaded on the free,
 * anonymous site) read Public's mark-list vocabulary LIVE from D1 instead
 * of a periodically-regenerated static file — see README's "Public reads"
 * section for why this is safe to leave wide open: it's read-only, and
 * it's the exact same data config/mark_lists.json already made freely
 * downloadable with zero auth.
 */
async function handlePublicMarkLists(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM user_mark_lists WHERE user_id = ? ORDER BY field ASC, value ASC"
  )
    .bind(PUBLIC_USER_ID)
    .all();
  return new Response(JSON.stringify(results.map(rowToMarkList)), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // Deliberately a real wildcard, unlike corsHeaders()'s own
      // env.ALLOWED_ORIGIN — this endpoint carries no session cookie and
      // never will, so the browser-security reason every other response
      // in this file avoids "*" (it's incompatible with
      // Access-Control-Allow-Credentials: true) simply doesn't apply here.
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=60", // light caching — this changes rarely enough that a live edit being up to a minute stale on the free site is a fine trade for not hammering D1 on every page load
    },
  });
}

/**
 * Public counterpart to handlePublicMarkLists above, for the `marks`
 * table — this is what lets charts.js's map (add/edit/delete a catch or
 * POI) and sync.js (GPX/chartplotter import) read Public's marks LIVE
 * from D1 instead of the static data/marks.json file they used to.
 * Deliberately unpaginated (unlike GET /api/marks, which caps at 500) —
 * this mirrors the old file-based behaviour of loading the WHOLE dataset
 * in one response, which the map rendering and the Sync page's own
 * duplicate-matching logic both already assume; at real-world scale (a
 * few thousand marks) one D1 query returning everything is still cheap,
 * especially with the same 60s Cache-Control as mark lists above.
 *
 * NOTE ON WHAT COUNTS AS "PUBLIC" HERE: unlike locations/groups/mark-
 * lists, marks were never seeded as Public's own data — the original
 * 2,532 real marks were migrated to the Admin's own account (they're
 * genuinely personal catch history, not a "free site default"). A
 * one-time migration reattributes them to 'public' specifically so this
 * endpoint (and the map's own display of them) has one consistent owner
 * to read, matching every other public-facing dataset's convention.
 */
async function handlePublicMarks(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM marks WHERE user_id = ? ORDER BY date_time DESC"
  )
    .bind(PUBLIC_USER_ID)
    .all();
  return new Response(JSON.stringify(results.map(rowToMark)), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=60",
    },
  });
}

/**
 * Public counterpart to handlePublicMarkLists/handlePublicMarks above —
 * this is what lets week.js/live.js/locationsadmin.js read the site's own
 * home address and Google Routes API key LIVE from D1 instead of the
 * static config/settings.json file they used to. Same trust model as
 * before: the Routes API key was already sitting in a public, unauthenticated
 * static file — it's meant to be used client-side and protected by an
 * HTTP-referrer restriction in Google Cloud Console, not by secrecy, so
 * serving it back out through an open endpoint changes nothing about its
 * actual security. Read-only; there is no public write path.
 */
async function handlePublicSettings(env) {
  const row = await env.DB.prepare("SELECT home_lat, home_lng, google_routes_api_key FROM users WHERE id = ?")
    .bind(PUBLIC_USER_ID)
    .first();
  return new Response(
    JSON.stringify({
      homeLat: row ? row.home_lat : null,
      homeLng: row ? row.home_lng : null,
      googleRoutesApiKey: row ? row.google_routes_api_key : null,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=60",
      },
    }
  );
}

/**
 * Sets the site's own home address (Public's home_lat/home_lng) —
 * replaces locationsadmin.js's old saveHomeLocation, which committed to
 * config/settings.json via the GitHub Contents API. Admin-only, checked
 * directly against the session's own role rather than going through
 * resolveEffectiveUserId/?userId= — there's no "act as yourself" case
 * that makes sense here (a Basic user setting their OWN home address
 * would do nothing; there is no per-user home address anywhere on this
 * site, only the one site-wide value everyone's drive-time-to-home
 * calculation on the Live tab actually uses).
 */
async function handleAdminHomeLocation(request, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  if (user.role !== "admin") return jsonResponse({ error: "Admin only." }, 403, env);

  const body = await readJsonBody(request);
  if (typeof body.lat !== "number" || typeof body.lng !== "number") {
    return jsonResponse({ error: "lat and lng must both be numbers." }, 400, env);
  }
  await env.DB.prepare("UPDATE users SET home_lat = ?, home_lng = ? WHERE id = ?")
    .bind(body.lat, body.lng, PUBLIC_USER_ID)
    .run();
  return jsonResponse({ homeLat: body.lat, homeLng: body.lng }, 200, env);
}

/**
 * Triggers the site's GitHub Actions data-refresh workflow — replaces
 * locationsadmin.js's old onRefreshDataNow, which called GitHub's
 * workflow-dispatch API directly from the BROWSER using the same PAT
 * stored in localStorage as everything else on the old GitHub-connection
 * card. That PAT no longer needs to exist in the browser at all: this
 * Worker holds its own GitHub token (GH_ACTIONS_TOKEN, scoped to Actions:
 * write only — deliberately narrower than the old browser-held token,
 * which also needed Contents:write for everything else that token used
 * to do) as a secret, and makes the dispatch call server-side on the
 * Admin session's behalf. Admin-only, same direct role check as
 * handleAdminHomeLocation above, for the same reason.
 */
async function handleAdminRefreshDataNow(env) {
  requireEnv(env, ["GH_ACTIONS_TOKEN", "GH_REPO_OWNER", "GH_REPO_NAME", "GH_WORKFLOW_FILE"]);
  // NOTE: this function is only ever reached via the route above, which
  // does not itself check requireUser/role — callers MUST check before
  // calling it. Kept as a plain export-free helper rather than duplicating
  // the auth check here since the one route above is its only caller.
  try {
    const dispatchRes = await fetch(
      `https://api.github.com/repos/${env.GH_REPO_OWNER}/${env.GH_REPO_NAME}/actions/workflows/${env.GH_WORKFLOW_FILE}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GH_ACTIONS_TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      }
    );
    if (!dispatchRes.ok) {
      const text = await dispatchRes.text().catch(() => "");
      console.error(`GitHub workflow dispatch returned ${dispatchRes.status}: ${text.slice(0, 300)}`);
      return jsonResponse({ error: `GitHub returned ${dispatchRes.status}.` }, 502, env);
    }
    return jsonResponse({ triggered: true }, 200, env);
  } catch (err) {
    console.error("Failed to trigger workflow dispatch:", err);
    return jsonResponse({ error: "Could not reach GitHub." }, 502, env);
  }
}

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

/**
 * Every v2 endpoint operates on an "effective" user id — normally the
 * caller's own, but an Admin may pass ?userId=<id> (most usefully
 * ?userId=public) to act on someone else's rows through the exact same
 * endpoint. This is the ONLY mechanism for editing Public's defaults —
 * there is no separate "edit the defaults" code path anywhere in this
 * file. A non-admin passing a userId that isn't their own is rejected
 * outright, never silently downgraded to "act as yourself instead".
 */
function resolveEffectiveUserId(url, callerUser) {
  const requested = url.searchParams.get("userId");
  if (!requested || requested === callerUser.id) return { id: callerUser.id };
  if (callerUser.role !== "admin") {
    return { error: "Only Admin can act on another user's data." };
  }
  return { id: requested };
}

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
  await seedDefaultTypes(env, id);
  return { id, google_sub: claims.sub, email: claims.email, name: claims.name || null };
}

/**
 * Every brand-new user gets their own Kayak/Land based user_types rows —
 * without this, a new signed-in user's first location-add would have no
 * types at all to pick from (account.js's own vocabulary is entirely
 * per-user, same as Public's; nothing seeds it automatically otherwise).
 * Uses INSERT OR IGNORE — harmless if ever called twice for the same
 * user (e.g. a retry), since UNIQUE(user_id, name) would just reject the
 * second attempt rather than error the whole request.
 */
async function seedDefaultTypes(env, userId) {
  const now = Date.now();
  for (const name of ["Kayak", "Land based"]) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO user_types (id, user_id, name, behaves_like, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(crypto.randomUUID(), userId, name, name, now)
      .run();
  }
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
