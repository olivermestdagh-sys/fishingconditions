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
 *
 * NOT YET BUILT (deliberately — this round is the account/CRUD layer
 * only): nothing here actually calls WillyWeather on a user's behalf yet.
 * schedule_state (see schema.sql) exists so that piece doesn't need a
 * schema migration later, but there's no cron sweep reading it yet, and
 * no Stripe/tier-gating. Also not built: any
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
 *        on success, e.g. https://olivermestdagh-sys.github.io/fishingconditions/locations.html
 *        (account.html/account.js were retired — Settings and Account
 *        merged into one page; update this value if it still points at
 *        the old account.html)
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
 *        (fine-grained, same repo, permissions -> Actions: Read and write
 *        is the only ACTUALLY required one — Contents access is not
 *        needed for this (an earlier theory said it was; that turned out
 *        wrong — see README's "Refresh data now" troubleshooting entry
 *        for the real cause, a missing User-Agent header, now fixed
 *        below). Still meaningfully narrower than the old browser-held
 *        token, which needed Contents:WRITE). This is what lets
 *        "Refresh data now" (locationsadmin.js) trigger a workflow run
 *        without any GitHub token ever touching the browser — the Worker
 *        holds this one, server-side, instead. See "Admin-only endpoints"
 *        further down.
 *      - GH_REPO_OWNER (Text) — e.g. olivermestdagh-sys
 *      - GH_REPO_NAME (Text) — e.g. fishingconditions
 *      - GH_WORKFLOW_FILE (Text) — the workflow's filename, e.g. update.yml
 *      Save and Deploy again so the new bindings/secrets take effect.
 *   6. Paste this Worker's URL into locationsadmin.js's USER_BACKEND_URL
 *      constant, then deploy locations.html/locationsadmin.js as usual via
 *      GitHub's upload page.
 */

const SESSION_COOKIE = "session";
const LOGIN_CODE_PREFIX = "lc_"; // one-time login codes live in the sessions table with this prefix and a short expiry
const LOGIN_CODE_TTL_SECONDS = 120;
const STATE_COOKIE = "oauth_state";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const STATE_MAX_AGE_SECONDS = 60 * 10; // 10 minutes — just needs to outlive the Google consent screen

// --- v2 (schema-v2.sql) constants ---
const PUBLIC_USER_ID = "public";
// MAX_BASIC_CREATED_LOCATIONS removed — replaced by the tiers table
// (see handleTrackedCollection's own lookup) so Admin can define and
// adjust per-tier caps from the Settings page instead of a fixed
// constant requiring a code deploy to change.
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

    // CSRF guard. The session cookie is SameSite=None (the site and this
    // Worker are on different origins), so a browser would attach it to a
    // cross-site POST from ANY page — including a "simple" text/plain one that
    // needs no CORS preflight — and readJsonBody parses whatever body it gets.
    // Browsers always send an Origin header on cross-site POST/PUT/DELETE, so
    // requiring it to be exactly our own site for every state-changing request
    // closes that. Exempt: /api/pipeline/* (server-to-server from GitHub
    // Actions, authenticated by a shared-secret header, no cookie, no Origin).
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      !url.pathname.startsWith("/api/pipeline/") &&
      // Also exempt: the Fishing Controller app's calls — they carry a device token ("Bearer fc_…"), no cookie and no Origin,
      // so there is nothing for a cross-site page to ride on (the token routes themselves still require the site's Origin).
      !(url.pathname.startsWith("/api/controller/") && /^Bearer fc_/.test(request.headers.get("Authorization") || "")) &&
      request.headers.get("Origin") !== env.ALLOWED_ORIGIN
    ) {
      return new Response(JSON.stringify({ error: "Cross-origin request blocked." }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      if (url.pathname === "/auth/login" && request.method === "GET") {
        return handleLogin(env);
      }
      if (url.pathname === "/auth/callback" && request.method === "GET") {
        return handleCallback(request, url, env);
      }
      if (url.pathname === "/auth/exchange" && request.method === "POST") {
        return handleExchange(request, env);
      }
      if (url.pathname === "/auth/logout" && request.method === "POST") {
        return handleLogout(request, env);
      }
      if (url.pathname === "/auth/me" && request.method === "GET") {
        return handleMe(request, env);
      }
      if (url.pathname === "/api/prefs") {
        return handlePrefs(request, env);
      }
      if (url.pathname.startsWith("/api/controller/")) {
        return handleControllerApi(request, url, env);
      }

      // --- v2 endpoints below: the unified locations/types/groups/mark-lists/
      // marks model (schema-v2.sql). /api/locations (v1)
      // stays alongside these, fully deprecated (nothing calls it since
      // account.js was reconciled onto v2 and later retired entirely — see
      // "Settings and Account merged" further down). The old check-frequency
      // /api/settings endpoint was removed 2026-09-23: nothing ever read it.
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
      if (url.pathname === "/api/rodsetups") {
        return handleRodSetupsCollection(request, url, env);
      }
      const rodSetupMatch = url.pathname.match(/^\/api\/rodsetups\/([^/]+)$/);
      if (rodSetupMatch) {
        return handleRodSetupItem(request, url, env, rodSetupMatch[1]);
      }
      if (url.pathname === "/api/tripsetups") {
        return handleTripSetupsCollection(request, url, env);
      }
      const tripSetupMatch = url.pathname.match(/^\/api\/tripsetups\/([^/]+)$/);
      if (tripSetupMatch) {
        return handleTripSetupItem(request, url, env, tripSetupMatch[1]);
      }
      if (url.pathname === "/api/tripactions") {
        return handleTripActionsCollection(request, url, env);
      }
      const tripActionMatch = url.pathname.match(/^\/api\/tripactions\/([^/]+)$/);
      if (tripActionMatch) {
        return handleTripActionItem(request, url, env, tripActionMatch[1]);
      }
      if (url.pathname === "/api/rig-sublist-overrides") {
        return handleRigSublistOverridesCollection(request, url, env);
      }
      const rigOverrideMatch = url.pathname.match(/^\/api\/rig-sublist-overrides\/([^/]+)$/);
      if (rigOverrideMatch) {
        return handleRigSublistOverrideItem(request, url, env, rigOverrideMatch[1]);
      }
      if (url.pathname === "/api/marklist-format-overrides") {
        return handleMarklistFormatOverridesCollection(request, url, env);
      }
      const formatOverrideMatch = url.pathname.match(/^\/api\/marklist-format-overrides\/([^/]+)$/);
      if (formatOverrideMatch) {
        return handleMarklistFormatOverrideItem(request, url, env, formatOverrideMatch[1]);
      }
      if (url.pathname === "/api/location-quota" && request.method === "GET") {
        const user = await requireUser(request, env);
        if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
        return jsonResponse(await locationQuotaFor(env, user), 200, env);
      }
      const locationDeleteMatch = url.pathname.match(/^\/api\/locations\/([^/]+)$/);
      if (locationDeleteMatch && request.method === "DELETE") {
        return handleLocationDelete(request, env, locationDeleteMatch[1]);
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
      const rigOptionImageMatch = url.pathname.match(/^\/api\/marklists\/([^/]+)\/options\/([^/]+)\/images(?:\/([^/]+))?$/);
      if (rigOptionImageMatch) {
        return handleRigOptionImages(request, url, env, rigOptionImageMatch[1], decodeURIComponent(rigOptionImageMatch[2]), rigOptionImageMatch[3]);
      }
      const markListImageMatch = url.pathname.match(/^\/api\/marklists\/([^/]+)\/images(?:\/([^/]+))?$/);
      if (markListImageMatch) {
        return handleMarkListImages(request, url, env, markListImageMatch[1], markListImageMatch[2]);
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
      if (url.pathname === "/api/pipeline/observations" && request.method === "POST") {
        return handlePipelineObservations(request, env);
      }
      if (url.pathname === "/api/pipeline/observations/prune" && request.method === "POST") {
        return handlePipelineObservationsPrune(request, env);
      }

      // --- Public (anonymous) reads below: no session, no token — genuinely
      // open, matching that this is the exact same data anyone could
      // already fetch for free from the static config/mark_lists.json file
      // it replaces. Read-only; there is no public write path anywhere.
      if (url.pathname === "/api/public/marklists" && request.method === "GET") {
        return handlePublicMarkLists(env);
      }
      const speciesImageMatch = url.pathname.match(/^\/api\/public\/species-image\/([^/]+)$/);
      if (speciesImageMatch && request.method === "GET") {
        return handlePublicSpeciesImage(speciesImageMatch[1], env);
      }
      if (url.pathname === "/api/public/marks" && request.method === "GET") {
        return handlePublicMarks(request, env);
      }
      if (url.pathname === "/api/public/settings" && request.method === "GET") {
        return handlePublicSettings(request, env);
      }
      if (url.pathname === "/api/public/locations" && request.method === "GET") {
        return handlePublicLocations(env);
      }
      if (url.pathname === "/api/archive/lookups" && request.method === "POST") {
        return handleArchiveLookups(request, env);
      }
      if (url.pathname === "/api/public/observations" && request.method === "GET") {
        return handlePublicObservations(url, env);
      }
      if (url.pathname === "/api/public/tide-events" && request.method === "GET") {
        return handlePublicTideEvents(url, env);
      }

      // --- Admin-only endpoints below: not scoped by effective-user-id
      // like the rest of this file — these always act on Public's own row
      // (there's exactly one site-wide home address / refresh trigger, not
      // a per-user concept), and require role === "admin" directly rather
      // than going through resolveEffectiveUserId. See each handler's own
      // comment for why.
      if ((url.pathname === "/api/home-location" || url.pathname === "/api/admin/home-location") && request.method === "PUT") {
        return handleHomeLocation(request, env);
      }
      if (url.pathname === "/api/homes") {
        return handleHomes(request, env);
      }
      if (url.pathname === "/api/messages") {
        return handleMessages(request, env);
      }
      const ownMessageMatch = url.pathname.match(/^\/api\/messages\/([^/]+)$/);
      if (ownMessageMatch && ownMessageMatch[1] !== "unread" && request.method === "DELETE") {
        return handleOwnMessageDelete(request, env, ownMessageMatch[1]);
      }
      if (url.pathname === "/api/messages/unread" && request.method === "GET") {
        return handleMessagesUnread(request, env);
      }
      if (url.pathname === "/api/admin/messages" && request.method === "GET") {
        return handleAdminMessages(request, env);
      }
      const adminMessageMatch = url.pathname.match(/^\/api\/admin\/messages\/([^/]+)$/);
      if (adminMessageMatch && (request.method === "PATCH" || request.method === "DELETE")) {
        return handleAdminMessageItem(request, env, adminMessageMatch[1]);
      }
      const homeMatch = url.pathname.match(/^\/api\/homes\/([^/]+)$/);
      if (homeMatch && request.method === "DELETE") {
        return handleHomeDelete(request, env, homeMatch[1]);
      }
      if (homeMatch && request.method === "PATCH") {
        return handleHomeRename(request, env, homeMatch[1]);
      }
      if (url.pathname === "/api/admin/refresh-data-now" && request.method === "POST") {
        const user = await requireUser(request, env);
        if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
        if (user.role !== "admin") return jsonResponse({ error: "Admin only." }, 403, env);
        return handleAdminRefreshDataNow(env);
      }
      if (url.pathname === "/api/admin/users" && request.method === "GET") {
        const user = await requireUser(request, env);
        if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
        if (user.role !== "admin") return jsonResponse({ error: "Admin only." }, 403, env);
        return handleAdminListUsers(env);
      }
      const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (adminUserMatch && request.method === "PUT") {
        const user = await requireUser(request, env);
        if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
        if (user.role !== "admin") return jsonResponse({ error: "Admin only." }, 403, env);
        return handleAdminUpdateUser(request, env, user, adminUserMatch[1]);
      }
      const locationOwnerMatch = url.pathname.match(/^\/api\/admin\/locations\/([^/]+)\/owner$/);
      if (locationOwnerMatch && request.method === "PUT") {
        const user = await requireUser(request, env);
        if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
        if (user.role !== "admin") return jsonResponse({ error: "Admin only." }, 403, env);
        return handleAdminLocationOwner(request, env, locationOwnerMatch[1]);
      }
      if (url.pathname === "/api/admin/tiers" && request.method === "GET") {
        const user = await requireUser(request, env);
        if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
        if (user.role !== "admin") return jsonResponse({ error: "Admin only." }, 403, env);
        return handleAdminListTiers(env);
      }
      if (url.pathname === "/api/admin/tiers" && request.method === "POST") {
        const user = await requireUser(request, env);
        if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
        if (user.role !== "admin") return jsonResponse({ error: "Admin only." }, 403, env);
        return handleAdminCreateTier(request, env);
      }
      const adminTierMatch = url.pathname.match(/^\/api\/admin\/tiers\/([^/]+)$/);
      if (adminTierMatch && (request.method === "PUT" || request.method === "DELETE")) {
        const user = await requireUser(request, env);
        if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
        if (user.role !== "admin") return jsonResponse({ error: "Admin only." }, 403, env);
        return request.method === "PUT"
          ? handleAdminUpdateTier(request, env, adminTierMatch[1])
          : handleAdminDeleteTier(env, adminTierMatch[1]);
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

  // Phone browsers increasingly refuse the session cookie on the site's own requests (it belongs to this Worker,
  // a different address from the site, so it is a "third-party" cookie). So the site is also handed a one-time
  // login code in the URL fragment (never sent to any server); it swaps it for a token with POST /auth/exchange
  // and sends that as `Authorization: Bearer` from then on. The cookie below still works wherever it is allowed.
  const loginCode = LOGIN_CODE_PREFIX + randomToken();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(loginCode, user.id, Date.now() + LOGIN_CODE_TTL_SECONDS * 1000)
    .run();
  const headers = new Headers();
  headers.append("Location", `${env.FRONTEND_ACCOUNT_URL}#login=${loginCode}`);
  // Overwrite the state cookie with an immediately-expired one so it can't
  // be reused (Max-Age 0 clears it) — belt-and-braces since the state
  // check above already succeeded, this just tidies up.
  headers.append("Set-Cookie", buildCookie(STATE_COOKIE, "", 0, "Lax"));
  headers.append("Set-Cookie", buildCookie(SESSION_COOKIE, sessionId, SESSION_MAX_AGE_SECONDS, "None"));
  return new Response(null, { status: 302, headers });
}

// POST /auth/exchange {code}: trades the one-time login code from the sign-in redirect for a real session token.
// The code is single-use and expires after LOGIN_CODE_TTL_SECONDS.
async function handleExchange(request, env) {
  const body = await readJsonBody(request);
  const code = typeof body.code === "string" ? body.code : "";
  if (!code.startsWith(LOGIN_CODE_PREFIX)) return jsonResponse({ error: "Invalid or expired login code." }, 400, env);
  const row = await env.DB.prepare("SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?").bind(code, Date.now()).first();
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(code).run(); // single use, whether or not it was valid
  if (!row) return jsonResponse({ error: "Invalid or expired login code." }, 400, env);
  const token = randomToken();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(token, row.user_id, Date.now() + SESSION_MAX_AGE_SECONDS * 1000)
    .run();
  return jsonResponse({ token }, 200, env);
}

async function handleLogout(request, env) {
  const sessionId = readSessionId(request);
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

/**
 * How many locations this person may create: Admin (and the Public account) without limit; a Basic user up to their
 * tier's max_extra_locations — a Basic user with no tier at all gets none (fails closed). `used` counts the locations
 * they created; their own timings on someone else's location never count. GET /api/location-quota returns this so
 * the Map can offer "Add as permanent location" only while there's room.
 */
async function locationQuotaFor(env, user) {
  const { n: used } = await env.DB.prepare("SELECT COUNT(*) as n FROM locations WHERE created_by_user_id = ?").bind(user.id).first();
  if (user.role !== "basic") return { unlimited: true, max: null, used };
  const tier = user.tier_id ? await env.DB.prepare("SELECT max_extra_locations FROM tiers WHERE id = ?").bind(user.tier_id).first() : null;
  return { unlimited: false, max: tier ? tier.max_extra_locations : 0, used };
}

/**
 * DELETE /api/locations/:id — removes a whole location: the place, every account's type entries and timings on it
 * (including other people's own times), their schedule state and group memberships. Only its creator or Admin.
 * (Removing one type entry is DELETE /api/tracked-locations/:accessId, which leaves the place while anyone else
 * still has an entry on it.)
 */
async function handleLocationDelete(request, env, locationId) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const loc = await env.DB.prepare("SELECT id, created_by_user_id FROM locations WHERE id = ?").bind(locationId).first();
  if (!loc) return jsonResponse({ error: "Location not found." }, 404, env);
  if (user.role !== "admin" && loc.created_by_user_id !== user.id) {
    return jsonResponse({ error: "Only the location's owner or Admin can remove it." }, 403, env);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM schedule_state WHERE user_location_access_id IN (SELECT id FROM user_location_access WHERE location_id = ?)").bind(locationId),
    env.DB.prepare("DELETE FROM user_location_access WHERE location_id = ?").bind(locationId),
    env.DB.prepare("DELETE FROM user_location_group_members WHERE location_id = ?").bind(locationId),
    env.DB.prepare("DELETE FROM locations WHERE id = ?").bind(locationId),
  ]);
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}

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
              l.id as location_id, l.name, l.display_name, l.lat, l.lng, l.willyweather_id, l.willyweather_name,
              l.willyweather_region, l.willyweather_state, l.shore, l.tide_offset, l.tide_max_observed,
              l.hhw_offset, l.lhw_offset, l.hlw_offset, l.llw_offset,
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
      // Tier-based cap on how many locations a Basic user may create (see locationQuotaFor) — looked up fresh each
      // time, since Admin can change a tier's cap or a user's tier at any point.
      const quota = await locationQuotaFor(env, user);
      if (!quota.unlimited && quota.used >= quota.max) {
        return jsonResponse({ error: `Your account is limited to ${quota.max} additional private locations.` }, 403, env);
      }
      locationId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO locations (id, created_by_user_id, name, display_name, lat, lng, willyweather_id, willyweather_name,
                                 willyweather_region, willyweather_state, shore, tide_offset, tide_max_observed, tidal, created_at,
                                 hhw_offset, lhw_offset, hlw_offset, llw_offset)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          locationId,
          uid,
          body.name,
          // Falls back to name when a caller doesn't send its own
          // displayName — e.g. the pipeline endpoint's own inline
          // auto-create path (handlePipelineLocationsList below) has no
          // concept of a separate display name at all, so it's never
          // going to send one; a location created that way should still
          // end up with a sensible displayName rather than null.
          body.displayName ?? body.name,
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
          Date.now(),
          body.hhwOffset ?? null,
          body.lhwOffset ?? null,
          body.hlwOffset ?? null,
          body.llwOffset ?? null
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
    const placeFields = ["name", "displayName", "lat", "lng", "willyweatherId", "willyweatherName", "willyweatherRegion", "willyweatherState", "shore", "tideOffset", "hhwOffset", "lhwOffset", "hlwOffset", "llwOffset", "tideMaxObserved", "tidal"];
    const wantsPlaceEdit = placeFields.some((f) => body[f] !== undefined);
    if (wantsPlaceEdit) {
      if (existing.location_owner !== uid) {
        return jsonResponse({ error: "You can't edit this location's base details — you didn't create it." }, 403, env);
      }
      const place = await env.DB.prepare("SELECT * FROM locations WHERE id = ?").bind(existing.location_id).first();
      const merged = {
        name: body.name ?? place.name,
        displayName: body.displayName ?? place.display_name,
        lat: body.lat ?? place.lat,
        lng: body.lng ?? place.lng,
        willyweatherId: body.willyweatherId !== undefined ? body.willyweatherId : place.willyweather_id,
        willyweatherName: body.willyweatherName ?? place.willyweather_name,
        willyweatherRegion: body.willyweatherRegion ?? place.willyweather_region,
        willyweatherState: body.willyweatherState ?? place.willyweather_state,
        shore: body.shore ?? place.shore,
        tideOffset: body.tideOffset ?? place.tide_offset,
        // null clears these (unlike tideOffset above, where null keeps the stored value)
        hhwOffset: body.hhwOffset !== undefined ? body.hhwOffset : place.hhw_offset,
        lhwOffset: body.lhwOffset !== undefined ? body.lhwOffset : place.lhw_offset,
        hlwOffset: body.hlwOffset !== undefined ? body.hlwOffset : place.hlw_offset,
        llwOffset: body.llwOffset !== undefined ? body.llwOffset : place.llw_offset,
        tideMaxObserved: body.tideMaxObserved ?? place.tide_max_observed,
        tidal: body.tidal !== undefined ? (body.tidal ? 1 : 0) : place.tidal,
      };
      await env.DB.prepare(
        `UPDATE locations SET name=?, display_name=?, lat=?, lng=?, willyweather_id=?, willyweather_name=?, willyweather_region=?,
                               willyweather_state=?, shore=?, tide_offset=?, tide_max_observed=?, tidal=?,
                               hhw_offset=?, lhw_offset=?, hlw_offset=?, llw_offset=?
         WHERE id = ?`
      )
        .bind(
          merged.name,
          merged.displayName,
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
          merged.hhwOffset,
          merged.lhwOffset,
          merged.hlwOffset,
          merged.llwOffset,
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
            l.id as location_id, l.name, l.display_name, l.lat, l.lng, l.willyweather_id, l.willyweather_name,
            l.willyweather_region, l.willyweather_state, l.shore, l.tide_offset, l.tide_max_observed,
            l.hhw_offset, l.lhw_offset, l.hlw_offset, l.llw_offset,
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
      // Falls back to name until the one-time migration SQL runs (see
      // migration-display-name.sql) — every location created going
      // forward already gets both set at creation time (createLocation
      // below, and the pipeline's own auto-create path), so this
      // fallback only really matters for the pre-existing rows in the
      // window before that migration is run.
      displayName: row.display_name || row.name,
      lat: row.lat,
      lng: row.lng,
      willyweatherId: row.willyweather_id,
      willyweatherName: row.willyweather_name,
      willyweatherRegion: row.willyweather_region,
      willyweatherState: row.willyweather_state,
      shore: row.shore,
      tideOffset: row.tide_offset,
      hhwOffset: row.hhw_offset ?? null,
      lhwOffset: row.lhw_offset ?? null,
      hlwOffset: row.hlw_offset ?? null,
      llwOffset: row.llw_offset ?? null,
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
  // Any signed-in user may READ Public's own groups (Settings shows them merged into your own,
  // badged and read-only) — writing to userId=public stays Admin-only, per allowPublicRead's own comment.
  const resolved = resolveEffectiveUserId(url, user, { allowPublicRead: request.method === "GET" });
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
// Rod Setups (schema-v2.sql user_rod_setups) — a named rod+rig combo, with
// an optional list of items picked from that rig's own sub list (see the
// Rig `hasSublist`/`subList` fields on user_mark_lists, below). Available
// to any signed-in user, same as Location Groups/Mark Lists (not Admin-only
// like Tiers/Users) — respects effectiveUserIdParam()'s "View as Public".
// ---------------------------------------------------------------------

function rowToRodSetup(row) {
  return { id: row.id, name: row.name, rod: row.rod, rig: row.rig, subListItems: parseSubList(row.sub_list_items) };
}

async function handleRodSetupsCollection(request, url, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const resolved = resolveEffectiveUserId(url, user);
  if (resolved.error) return jsonResponse({ error: resolved.error }, 403, env);
  const uid = resolved.id;

  if (request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM user_rod_setups WHERE user_id = ? ORDER BY name ASC").bind(uid).all();
    return jsonResponse(results.map(rowToRodSetup), 200, env);
  }

  if (request.method === "POST") {
    const body = await readJsonBody(request);
    if (!body || typeof body.name !== "string" || !body.name.trim()) {
      return jsonResponse({ error: "name is required." }, 400, env);
    }
    if (body.subListItems !== undefined && (!Array.isArray(body.subListItems) || body.subListItems.some((v) => typeof v !== "string" || !v.trim()))) {
      return jsonResponse({ error: "subListItems must be a list of option names." }, 400, env);
    }
    const id = crypto.randomUUID();
    try {
      await env.DB.prepare("INSERT INTO user_rod_setups (id, user_id, name, rod, rig, sub_list_items, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(id, uid, body.name, body.rod ?? null, body.rig ?? null, body.subListItems && body.subListItems.length ? JSON.stringify(body.subListItems) : null, Date.now())
        .run();
    } catch (err) {
      return jsonResponse({ error: `You already have a rod setup named "${body.name}".` }, 409, env);
    }
    const created = await env.DB.prepare("SELECT * FROM user_rod_setups WHERE id = ?").bind(id).first();
    return jsonResponse(rowToRodSetup(created), 201, env);
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

async function handleRodSetupItem(request, url, env, id) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const resolved = resolveEffectiveUserId(url, user);
  if (resolved.error) return jsonResponse({ error: resolved.error }, 403, env);
  const uid = resolved.id;

  const existing = await env.DB.prepare("SELECT * FROM user_rod_setups WHERE id = ? AND user_id = ?").bind(id, uid).first();
  if (!existing) return jsonResponse({ error: "Rod setup not found." }, 404, env);

  if (request.method === "PUT") {
    const body = await readJsonBody(request);
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) {
      return jsonResponse({ error: "name is required." }, 400, env);
    }
    if (body.subListItems !== undefined && (!Array.isArray(body.subListItems) || body.subListItems.some((v) => typeof v !== "string" || !v.trim()))) {
      return jsonResponse({ error: "subListItems must be a list of option names." }, 400, env);
    }
    const merged = {
      name: body.name ?? existing.name,
      rod: body.rod !== undefined ? body.rod : existing.rod,
      rig: body.rig !== undefined ? body.rig : existing.rig,
      subListItems: body.subListItems !== undefined ? body.subListItems : parseSubList(existing.sub_list_items),
    };
    try {
      await env.DB.prepare("UPDATE user_rod_setups SET name=?, rod=?, rig=?, sub_list_items=? WHERE id = ? AND user_id = ?")
        .bind(merged.name, merged.rod, merged.rig, merged.subListItems.length ? JSON.stringify(merged.subListItems) : null, id, uid)
        .run();
    } catch (err) {
      return jsonResponse({ error: `You already have a rod setup named "${merged.name}".` }, 409, env);
    }
    const updated = await env.DB.prepare("SELECT * FROM user_rod_setups WHERE id = ?").bind(id).first();
    return jsonResponse(rowToRodSetup(updated), 200, env);
  }

  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM user_rod_setups WHERE id = ? AND user_id = ?").bind(id, uid).run();
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

// ---------------------------------------------------------------------
// Trip Setups (schema-v2.sql user_trip_setups) — a named bundle of Rod
// Setups plus everything else Session Defaults (Map tab, js/live-cards.js
// liveSessionDefaults) controls outside a per-rod rig/bait pick: Species,
// Water Condition, Berley, Fishing Method. rod_setup_ids/species/
// fishing_method are all JSON arrays of strings, reusing parseSubList
// (a generic "JSON array of strings" parser despite its name). Available to
// any signed-in user, same as Rod Setups — not merged with Public's data.
// ---------------------------------------------------------------------

function rowToTripSetup(row) {
  return {
    id: row.id,
    name: row.name,
    rodSetupIds: parseSubList(row.rod_setup_ids),
    species: parseSubList(row.species),
    water: row.water,
    berley: row.berley,
    fishingMethod: parseSubList(row.fishing_method),
  };
}

function validateTripSetupInput(body) {
  for (const key of ["rodSetupIds", "species", "fishingMethod", "bait"]) {
    if (body[key] !== undefined && (!Array.isArray(body[key]) || body[key].some((v) => typeof v !== "string" || !v.trim()))) {
      return `${key} must be a list of option names.`;
    }
  }
  for (const key of ["water", "berley"]) {
    if (body[key] !== undefined && body[key] !== null && typeof body[key] !== "string") {
      return `${key} must be a string, or null to clear it.`;
    }
  }
  return null;
}

async function handleTripSetupsCollection(request, url, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const resolved = resolveEffectiveUserId(url, user);
  if (resolved.error) return jsonResponse({ error: resolved.error }, 403, env);
  const uid = resolved.id;

  if (request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM user_trip_setups WHERE user_id = ? ORDER BY name ASC").bind(uid).all();
    return jsonResponse(results.map(rowToTripSetup), 200, env);
  }

  if (request.method === "POST") {
    const body = await readJsonBody(request);
    if (!body || typeof body.name !== "string" || !body.name.trim()) {
      return jsonResponse({ error: "name is required." }, 400, env);
    }
    const validationError = validateTripSetupInput(body);
    if (validationError) return jsonResponse({ error: validationError }, 400, env);
    const id = crypto.randomUUID();
    const arr = (v) => (v && v.length ? JSON.stringify(v) : null);
    try {
      await env.DB.prepare(
        "INSERT INTO user_trip_setups (id, user_id, name, rod_setup_ids, species, water, berley, fishing_method, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(id, uid, body.name, arr(body.rodSetupIds), arr(body.species), body.water ?? null, body.berley ?? null, arr(body.fishingMethod), Date.now())
        .run();
    } catch (err) {
      return jsonResponse({ error: `You already have a trip setup named "${body.name}".` }, 409, env);
    }
    const created = await env.DB.prepare("SELECT * FROM user_trip_setups WHERE id = ?").bind(id).first();
    return jsonResponse(rowToTripSetup(created), 201, env);
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

async function handleTripSetupItem(request, url, env, id) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const resolved = resolveEffectiveUserId(url, user);
  if (resolved.error) return jsonResponse({ error: resolved.error }, 403, env);
  const uid = resolved.id;

  const existing = await env.DB.prepare("SELECT * FROM user_trip_setups WHERE id = ? AND user_id = ?").bind(id, uid).first();
  if (!existing) return jsonResponse({ error: "Trip setup not found." }, 404, env);

  if (request.method === "PUT") {
    const body = await readJsonBody(request);
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) {
      return jsonResponse({ error: "name is required." }, 400, env);
    }
    const validationError = validateTripSetupInput(body);
    if (validationError) return jsonResponse({ error: validationError }, 400, env);
    const merged = {
      name: body.name ?? existing.name,
      rodSetupIds: body.rodSetupIds !== undefined ? body.rodSetupIds : parseSubList(existing.rod_setup_ids),
      species: body.species !== undefined ? body.species : parseSubList(existing.species),
      water: body.water !== undefined ? body.water : existing.water,
      berley: body.berley !== undefined ? body.berley : existing.berley,
      fishingMethod: body.fishingMethod !== undefined ? body.fishingMethod : parseSubList(existing.fishing_method),
    };
    const arr = (v) => (v && v.length ? JSON.stringify(v) : null);
    try {
      await env.DB.prepare("UPDATE user_trip_setups SET name=?, rod_setup_ids=?, species=?, water=?, berley=?, fishing_method=? WHERE id = ? AND user_id = ?")
        .bind(merged.name, arr(merged.rodSetupIds), arr(merged.species), merged.water ?? null, merged.berley ?? null, arr(merged.fishingMethod), id, uid)
        .run();
    } catch (err) {
      return jsonResponse({ error: `You already have a trip setup named "${merged.name}".` }, 409, env);
    }
    const updated = await env.DB.prepare("SELECT * FROM user_trip_setups WHERE id = ?").bind(id).first();
    return jsonResponse(rowToTripSetup(updated), 200, env);
  }

  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM user_trip_actions WHERE trip_id = ? AND user_id = ?").bind(id, uid).run();
    await env.DB.prepare("DELETE FROM user_trip_setups WHERE id = ? AND user_id = ?").bind(id, uid).run();
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

// ---------------------------------------------------------------------
// Trip Actions (schema-v2.sql user_trip_actions) — the steps within a Trip
// (Map > Trip Defaults, js/trip-defaults.js): a name plus a Fishing Method
// list, a Berley, the Rod Setups in use and the target Species. GET returns
// every action the user has (the client groups them by tripId).
// ---------------------------------------------------------------------

function rowToTripAction(row) {
  return {
    id: row.id,
    tripId: row.trip_id,
    name: row.name,
    fishingMethod: parseSubList(row.fishing_method),
    berley: row.berley,
    bait: parseSubList(row.bait),
    rodSetupIds: parseSubList(row.rod_setup_ids),
    species: parseSubList(row.species),
  };
}

const validateTripActionInput = validateTripSetupInput; // same list/string rules for fishingMethod, rodSetupIds, species, berley

async function handleTripActionsCollection(request, url, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const resolved = resolveEffectiveUserId(url, user);
  if (resolved.error) return jsonResponse({ error: resolved.error }, 403, env);
  const uid = resolved.id;

  if (request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM user_trip_actions WHERE user_id = ? ORDER BY created_at ASC").bind(uid).all();
    return jsonResponse(results.map(rowToTripAction), 200, env);
  }

  if (request.method === "POST") {
    const body = await readJsonBody(request);
    if (!body || typeof body.name !== "string" || !body.name.trim()) {
      return jsonResponse({ error: "name is required." }, 400, env);
    }
    if (typeof body.tripId !== "string" || !body.tripId) return jsonResponse({ error: "tripId is required." }, 400, env);
    const trip = await env.DB.prepare("SELECT id FROM user_trip_setups WHERE id = ? AND user_id = ?").bind(body.tripId, uid).first();
    if (!trip) return jsonResponse({ error: "Trip not found." }, 404, env);
    const validationError = validateTripActionInput(body);
    if (validationError) return jsonResponse({ error: validationError }, 400, env);
    const id = crypto.randomUUID();
    const arr = (v) => (v && v.length ? JSON.stringify(v) : null);
    try {
      await env.DB.prepare(
        "INSERT INTO user_trip_actions (id, user_id, trip_id, name, fishing_method, berley, bait, rod_setup_ids, species, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(id, uid, body.tripId, body.name, arr(body.fishingMethod), body.berley ?? null, arr(body.bait), arr(body.rodSetupIds), arr(body.species), Date.now())
        .run();
    } catch (err) {
      return jsonResponse({ error: `This trip already has an action named "${body.name}".` }, 409, env);
    }
    const created = await env.DB.prepare("SELECT * FROM user_trip_actions WHERE id = ?").bind(id).first();
    return jsonResponse(rowToTripAction(created), 201, env);
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

async function handleTripActionItem(request, url, env, id) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const resolved = resolveEffectiveUserId(url, user);
  if (resolved.error) return jsonResponse({ error: resolved.error }, 403, env);
  const uid = resolved.id;

  const existing = await env.DB.prepare("SELECT a.*, t.name AS trip_name FROM user_trip_actions a LEFT JOIN user_trip_setups t ON t.id = a.trip_id WHERE a.id = ? AND a.user_id = ?").bind(id, uid).first();
  if (!existing) return jsonResponse({ error: "Action not found." }, 404, env);

  if (request.method === "PUT") {
    const body = await readJsonBody(request);
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) {
      return jsonResponse({ error: "name is required." }, 400, env);
    }
    const validationError = validateTripActionInput(body);
    if (validationError) return jsonResponse({ error: validationError }, 400, env);
    const merged = {
      name: body.name ?? existing.name,
      fishingMethod: body.fishingMethod !== undefined ? body.fishingMethod : parseSubList(existing.fishing_method),
      berley: body.berley !== undefined ? body.berley : existing.berley,
      bait: body.bait !== undefined ? body.bait : parseSubList(existing.bait),
      rodSetupIds: body.rodSetupIds !== undefined ? body.rodSetupIds : parseSubList(existing.rod_setup_ids),
      species: body.species !== undefined ? body.species : parseSubList(existing.species),
    };
    const arr = (v) => (v && v.length ? JSON.stringify(v) : null);
    try {
      await env.DB.prepare("UPDATE user_trip_actions SET name=?, fishing_method=?, berley=?, bait=?, rod_setup_ids=?, species=? WHERE id = ? AND user_id = ?")
        .bind(merged.name, arr(merged.fishingMethod), merged.berley ?? null, arr(merged.bait), arr(merged.rodSetupIds), arr(merged.species), id, uid)
        .run();
    } catch (err) {
      return jsonResponse({ error: `This trip already has an action named "${merged.name}".` }, 409, env);
    }
    const updated = await env.DB.prepare("SELECT * FROM user_trip_actions WHERE id = ?").bind(id).first();
    return jsonResponse(rowToTripAction(updated), 200, env);
  }

  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM user_trip_actions WHERE id = ? AND user_id = ?").bind(id, uid).run();
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

// ---------------------------------------------------------------------
// Rig sub-list overrides (schema-v2.sql user_rig_sublist_overrides) — a
// normal user's own private layer on top of a Rig they don't own (i.e.
// one of Public's): lets them keep a personal sub list under a Public rig
// without needing write access to that row. Always scoped to the CALLER's
// own id — there's nothing to "act on someone else's behalf" for a
// per-viewer private layer, so ?userId= is never honored here at all.
// ---------------------------------------------------------------------

async function handleRigSublistOverridesCollection(request, url, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);

  if (request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT rig_id, sub_list, option_images FROM user_rig_sublist_overrides WHERE user_id = ?").bind(user.id).all();
    return jsonResponse(results.map((r) => ({ rigId: r.rig_id, subList: parseSubList(r.sub_list), optionImages: optionImagesForClient(parseOptionImages(r.option_images)) })), 200, env);
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

async function handleRigSublistOverrideItem(request, url, env, rigId) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);

  if (request.method === "PUT") {
    const body = await readJsonBody(request);
    if (!body || !Array.isArray(body.subList) || body.subList.length > 100 || body.subList.some((v) => typeof v !== "string" || !v.trim())) {
      return jsonResponse({ error: "subList must be a list of option names." }, 400, env);
    }
    const rig = await env.DB.prepare("SELECT user_id, field FROM user_mark_lists WHERE id = ?").bind(rigId).first();
    if (!rig || rig.field !== "Rig") return jsonResponse({ error: "Rig not found." }, 404, env);
    if (rig.user_id === user.id) return jsonResponse({ error: "You own this rig — edit its Sub List directly." }, 400, env);
    const existing = await env.DB.prepare("SELECT id, option_images FROM user_rig_sublist_overrides WHERE user_id = ? AND rig_id = ?").bind(user.id, rigId).first();
    let optionImages = {};
    if (existing) {
      await env.DB.prepare("UPDATE user_rig_sublist_overrides SET sub_list = ? WHERE id = ?").bind(JSON.stringify(body.subList), existing.id).run();
      // An option that left the list takes its pictures with it.
      const pruneStatements = optionImagePruneStatements(env, rigId, existing.option_images, body.subList, (text) =>
        env.DB.prepare("UPDATE user_rig_sublist_overrides SET option_images = ? WHERE id = ?").bind(text, existing.id)
      );
      if (pruneStatements.length) await env.DB.batch(pruneStatements);
      optionImages = optionImagesForClient(pruneOptionImages(parseOptionImages(existing.option_images), body.subList).next);
    } else {
      await env.DB.prepare("INSERT INTO user_rig_sublist_overrides (id, user_id, rig_id, sub_list, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), user.id, rigId, JSON.stringify(body.subList), Date.now())
        .run();
    }
    return jsonResponse({ rigId, subList: body.subList, optionImages }, existing ? 200 : 201, env);
  }

  if (request.method === "DELETE") {
    const existing = await env.DB.prepare("SELECT id, option_images FROM user_rig_sublist_overrides WHERE user_id = ? AND rig_id = ?").bind(user.id, rigId).first();
    if (existing) {
      // Its pictures go with it.
      const { removedIds } = pruneOptionImages(parseOptionImages(existing.option_images), []);
      if (removedIds.length) await env.DB.batch(removedIds.map((id) => env.DB.prepare("DELETE FROM species_images WHERE id = ? AND list_id = ?").bind(id, rigId)));
    }
    await env.DB.prepare("DELETE FROM user_rig_sublist_overrides WHERE user_id = ? AND rig_id = ?").bind(user.id, rigId).run();
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

// ---------------------------------------------------------------------
// Mark-list format overrides (schema-v2.sql user_marklist_format_overrides)
// — a normal user's own private pick, on top of a mark-list row they don't
// own (i.e. one of Public's), of either: which Shape/Colour Format a VALUE
// row (Species/Bait/Rig/etc) uses, or what a Mark Shape/Colour Format
// DEFINITION row itself renders as (its icon or hex colour). Same
// caller-always-own-id reasoning as the Rig sub-list overrides above.
// ---------------------------------------------------------------------

function rowToFormatOverride(row) {
  return { publicRowId: row.public_row_id, shapeFormat: row.shape_format, colorFormat: row.color_format, icon: row.icon, colorValue: row.color_value };
}

async function handleMarklistFormatOverridesCollection(request, url, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);

  if (request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM user_marklist_format_overrides WHERE user_id = ?").bind(user.id).all();
    return jsonResponse(results.map(rowToFormatOverride), 200, env);
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

async function handleMarklistFormatOverrideItem(request, url, env, rowId) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);

  const target = await env.DB.prepare("SELECT user_id, field FROM user_mark_lists WHERE id = ?").bind(rowId).first();
  if (!target) return jsonResponse({ error: "Not found." }, 404, env);
  if (target.user_id === user.id) return jsonResponse({ error: "You own this — edit it directly." }, 400, env);

  if (request.method === "PUT") {
    const body = await readJsonBody(request);
    if (!body || typeof body !== "object") return jsonResponse({ error: "Request body must be a JSON object." }, 400, env);
    const isFormatDef = target.field === "Mark Shape Format" || target.field === "Mark Colour Format";
    if ((body.shapeFormat !== undefined || body.colorFormat !== undefined) && isFormatDef) {
      return jsonResponse({ error: "shapeFormat/colorFormat only apply to a value, not a Format definition itself." }, 400, env);
    }
    if (body.icon !== undefined && target.field !== "Mark Shape Format") {
      return jsonResponse({ error: "icon only applies to a Mark Shape Format." }, 400, env);
    }
    if (body.colorValue !== undefined && target.field !== "Mark Colour Format") {
      return jsonResponse({ error: "colorValue only applies to a Mark Colour Format." }, 400, env);
    }
    for (const key of ["shapeFormat", "colorFormat", "icon", "colorValue"]) {
      if (body[key] !== undefined && body[key] !== null && (typeof body[key] !== "string" || !body[key].trim())) {
        return jsonResponse({ error: `${key} must be a non-empty string, or null to clear it.` }, 400, env);
      }
    }
    const existing = await env.DB.prepare("SELECT * FROM user_marklist_format_overrides WHERE user_id = ? AND public_row_id = ?").bind(user.id, rowId).first();
    const merged = {
      shapeFormat: body.shapeFormat !== undefined ? body.shapeFormat : existing?.shape_format ?? null,
      colorFormat: body.colorFormat !== undefined ? body.colorFormat : existing?.color_format ?? null,
      icon: body.icon !== undefined ? body.icon : existing?.icon ?? null,
      colorValue: body.colorValue !== undefined ? body.colorValue : existing?.color_value ?? null,
    };
    const isEmpty = !merged.shapeFormat && !merged.colorFormat && !merged.icon && !merged.colorValue;
    if (isEmpty) {
      if (existing) await env.DB.prepare("DELETE FROM user_marklist_format_overrides WHERE id = ?").bind(existing.id).run();
      return jsonResponse({ publicRowId: rowId, shapeFormat: null, colorFormat: null, icon: null, colorValue: null }, 200, env);
    }
    if (existing) {
      await env.DB.prepare("UPDATE user_marklist_format_overrides SET shape_format=?, color_format=?, icon=?, color_value=? WHERE id = ?")
        .bind(merged.shapeFormat, merged.colorFormat, merged.icon, merged.colorValue, existing.id)
        .run();
    } else {
      await env.DB.prepare(
        "INSERT INTO user_marklist_format_overrides (id, user_id, public_row_id, shape_format, color_format, icon, color_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(crypto.randomUUID(), user.id, rowId, merged.shapeFormat, merged.colorFormat, merged.icon, merged.colorValue, Date.now())
        .run();
    }
    return jsonResponse({ publicRowId: rowId, ...merged }, 200, env);
  }

  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM user_marklist_format_overrides WHERE user_id = ? AND public_row_id = ?").bind(user.id, rowId).run();
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

// ---------------------------------------------------------------------
// v2: Mark lists (schema-v2.sql user_mark_lists) — one generic table for
// every pick-list category (Mark Type, Species, Bait, Rig, conditions,
// shape/colour formats), mirroring mark_lists.json's own flat shape.
// ---------------------------------------------------------------------

async function handleMarkListsCollection(request, url, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  // Any signed-in user may READ Public's own mark lists this way too (they're already fully
  // anonymous-readable via /api/public/marklists, so this adds no new exposure) — writing to
  // userId=public stays Admin-only, per allowPublicRead's own comment on resolveEffectiveUserId.
  const resolved = resolveEffectiveUserId(url, user, { allowPublicRead: request.method === "GET" });
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
    if ((body.hasSublist !== undefined || body.subList !== undefined) && body.field !== "Rig") {
      return jsonResponse({ error: "Only Rig values can have a sub list." }, 400, env);
    }
    const id = crypto.randomUUID();
    try {
      await env.DB.prepare(
        "INSERT INTO user_mark_lists (id, user_id, field, value, shape_format, color_format, color, icon, lowrance_sym, garmin_sym, min_size, max_size, max_qty, big_max_qty, big_size, has_sublist, sub_list, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(
          id, uid, body.field, body.value, body.shapeFormat ?? null, body.colorFormat ?? null, body.color ?? null,
          body.icon ?? null, body.lowranceSym ?? null, body.garminSym ?? null,
          body.minSize ?? null, body.maxSize ?? null, body.maxQty ?? null, body.bigMaxQty ?? null, body.bigSize ?? null,
          body.hasSublist ? 1 : 0, body.subList !== undefined ? JSON.stringify(body.subList) : null, Date.now()
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

// Mark list fields whose values can't be deleted (see the DELETE branch of handleMarkListItem; the Settings tab hides their ×).
const LOCKED_MARK_LIST_FIELDS = ["Mark Type", "Tide Condition", "Tide Extreme"];

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
    if ((body.hasSublist !== undefined || body.subList !== undefined) && (body.field ?? existing.field) !== "Rig") {
      return jsonResponse({ error: "Only Rig values can have a sub list." }, 400, env);
    }
    const merged = {
      field: body.field ?? existing.field,
      value: body.value ?? existing.value,
      shapeFormat: body.shapeFormat !== undefined ? body.shapeFormat : existing.shape_format,
      colorFormat: body.colorFormat !== undefined ? body.colorFormat : existing.color_format,
      color: body.color !== undefined ? body.color : existing.color,
      icon: body.icon !== undefined ? body.icon : existing.icon,
      lowranceSym: body.lowranceSym !== undefined ? body.lowranceSym : existing.lowrance_sym,
      garminSym: body.garminSym !== undefined ? body.garminSym : existing.garmin_sym,
      minSize: body.minSize !== undefined ? body.minSize : existing.min_size,
      maxSize: body.maxSize !== undefined ? body.maxSize : existing.max_size,
      maxQty: body.maxQty !== undefined ? body.maxQty : existing.max_qty,
      bigMaxQty: body.bigMaxQty !== undefined ? body.bigMaxQty : existing.big_max_qty,
      bigSize: body.bigSize !== undefined ? body.bigSize : existing.big_size,
      hasSublist: body.hasSublist !== undefined ? body.hasSublist : !!existing.has_sublist,
      subList: body.subList !== undefined ? body.subList : parseSubList(existing.sub_list),
    };
    try {
      await env.DB.prepare(
        "UPDATE user_mark_lists SET field=?, value=?, shape_format=?, color_format=?, color=?, icon=?, lowrance_sym=?, garmin_sym=?, min_size=?, max_size=?, max_qty=?, big_max_qty=?, big_size=?, has_sublist=?, sub_list=? WHERE id = ? AND user_id = ?"
      )
        .bind(
          merged.field, merged.value, merged.shapeFormat, merged.colorFormat, merged.color, merged.icon, merged.lowranceSym, merged.garminSym,
          merged.minSize ?? null, merged.maxSize ?? null, merged.maxQty ?? null, merged.bigMaxQty ?? null, merged.bigSize ?? null,
          merged.hasSublist ? 1 : 0, merged.subList.length ? JSON.stringify(merged.subList) : null, id, uid
        )
        .run();
    } catch (err) {
      return jsonResponse({ error: `"${merged.value}" already exists under ${merged.field}.` }, 409, env);
    }
    if (body.subList !== undefined) {
      // An option that left the sub list takes its pictures with it.
      const pruneStatements = optionImagePruneStatements(env, id, existing.option_images, merged.subList, (text) =>
        env.DB.prepare("UPDATE user_mark_lists SET option_images = ? WHERE id = ? AND user_id = ?").bind(text, id, uid)
      );
      if (pruneStatements.length) await env.DB.batch(pruneStatements);
    }
    if (body.linkedSpecies !== undefined) {
      // "Combined with" — see planSpeciesLinks. Applied as one batch so a link or unlink is all-or-nothing.
      if (merged.field !== "Species") return jsonResponse({ error: "Only species can be combined." }, 400, env);
      const { results } = await env.DB.prepare("SELECT id, value, qty_group, max_qty FROM user_mark_lists WHERE user_id = ? AND field = 'Species'").bind(uid).all();
      const rows = results.map((r) => ({ id: r.id, value: r.value, qtyGroup: r.qty_group ?? null, maxQty: r.max_qty ?? null }));
      const plan = planSpeciesLinks({ rows, editedId: id, linkedValues: body.linkedSpecies, maxQty: merged.maxQty ?? null, newGroupId: crypto.randomUUID() });
      if (plan.error) return jsonResponse({ error: plan.error }, 400, env);
      if (plan.updates.length) {
        await env.DB.batch(
          plan.updates.map((u) => env.DB.prepare("UPDATE user_mark_lists SET qty_group = ?, max_qty = ? WHERE id = ? AND user_id = ?").bind(u.qtyGroup, u.maxQty, u.id, uid))
        );
      }
    } else if (body.maxQty !== undefined && existing.qty_group) {
      // The combined limit is one number: a new Max Qty on any member goes to the whole group.
      await env.DB.prepare("UPDATE user_mark_lists SET max_qty = ? WHERE user_id = ? AND field = 'Species' AND qty_group = ?")
        .bind(merged.maxQty ?? null, uid, existing.qty_group)
        .run();
    }
    const updated = await env.DB.prepare("SELECT * FROM user_mark_lists WHERE id = ?").bind(id).first();
    return jsonResponse(rowToMarkList(updated), 200, env);
  }

  if (request.method === "DELETE") {
    // Their values carry the shapes and colours marks are drawn with, so they can be added to and restyled but never removed.
    if (LOCKED_MARK_LIST_FIELDS.includes(existing.field)) {
      return jsonResponse({ error: `${existing.field} values can't be deleted — they're kept for shaping and colouring.` }, 409, env);
    }
    await env.DB.prepare("DELETE FROM species_images WHERE list_id = ?").bind(id).run(); // its pictures go with it
    await env.DB.prepare("DELETE FROM user_mark_lists WHERE id = ? AND user_id = ?").bind(id, uid).run();
    if (existing.qty_group) {
      // A combined group left with a single species is no group.
      await env.DB.prepare(
        "UPDATE user_mark_lists SET qty_group = NULL WHERE user_id = ? AND qty_group = ? AND (SELECT COUNT(*) FROM user_mark_lists WHERE user_id = ? AND qty_group = ?) < 2"
      )
        .bind(uid, existing.qty_group, uid, existing.qty_group)
        .run();
    }
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

// --- Species images: several pictures per Species list entry (bytes in species_images, an index on the list row) ---
const MAX_SPECIES_IMAGES = 12;
const MAX_SPECIES_IMAGE_BYTES = 700 * 1024; // the browser shrinks pictures to about 60-150 KB first
const SPECIES_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** The image_index column ("[{id, v}, ...]" text) as an array; never throws. */
function parseImageIndex(text) {
  try {
    const list = JSON.parse(text || "[]");
    return Array.isArray(list) ? list.filter((i) => i && typeof i.id === "string") : [];
  } catch {
    return [];
  }
}

/** The sub_list column (Rig rows only — a JSON array of option strings) as an array; never throws. */
function parseSubList(text) {
  try {
    const list = JSON.parse(text || "[]");
    return Array.isArray(list) ? list.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Mark list fields whose values can carry pictures. A Rig's options (its sub list) carry their own, see handleRigOptionImages.
const IMAGE_FIELDS = ["Species", "Bait", "Rig", "Rod", "Berley", "Fishing Method"];

/** The option_images column ('{"<option>": [{id, v}, ...]}', Rig rows and Rig sub-list overrides) as an object; never throws. */
function parseOptionImages(text) {
  try {
    const obj = JSON.parse(text || "{}");
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    const out = {};
    for (const [option, list] of Object.entries(obj)) {
      const kept = Array.isArray(list) ? list.filter((i) => i && typeof i.id === "string") : [];
      if (kept.length) out[option] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

/** Splits an option_images object into what stays (options still in `keep`) and the ids of the picture rows to delete. */
function pruneOptionImages(index, keep) {
  const next = {};
  const removedIds = [];
  for (const [option, list] of Object.entries(index)) {
    if (keep.includes(option)) next[option] = list;
    else removedIds.push(...list.map((i) => i.id));
  }
  return { next, removedIds };
}

/** An option_images object as sent to the browser: {"<option>": [{id, version}]}. */
function optionImagesForClient(index) {
  return Object.fromEntries(Object.entries(index).map(([option, list]) => [option, list.map((i) => ({ id: i.id, version: i.v ?? null }))]));
}

/**
 * Statements that delete the pictures of options that are no longer in `keep` and store the trimmed option_images
 * (`saveStmt(textOrNull)` builds the UPDATE for whichever row holds it). Empty when nothing was removed.
 */
function optionImagePruneStatements(env, listId, optionImagesText, keep, saveStmt) {
  const { next, removedIds } = pruneOptionImages(parseOptionImages(optionImagesText), keep);
  if (!removedIds.length) return [];
  return [
    ...removedIds.map((id) => env.DB.prepare("DELETE FROM species_images WHERE id = ? AND list_id = ?").bind(id, listId)),
    saveStmt(Object.keys(next).length ? JSON.stringify(next) : null),
  ];
}

/**
 * The add / replace / delete work shared by a list entry's pictures and a Rig option's. `index` is the current picture
 * index ([{id, v}, ...]); `saveIndex(next)` returns the statement that stores a new one. Resolves to a Response when the
 * request is refused, otherwise {status, next} once the picture row and the index have been saved in one batch.
 */
async function applyImageChange(request, env, listId, index, imageId, saveIndex, noun) {
  if (request.method === "DELETE" && imageId) {
    if (!index.some((i) => i.id === imageId)) return jsonResponse({ error: "Image not found." }, 404, env);
    const next = index.filter((i) => i.id !== imageId);
    await env.DB.batch([env.DB.prepare("DELETE FROM species_images WHERE id = ? AND list_id = ?").bind(imageId, listId), saveIndex(next)]);
    return { status: 200, next };
  }
  if ((request.method === "POST" && !imageId) || (request.method === "PUT" && imageId)) {
    const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    if (!SPECIES_IMAGE_TYPES.includes(type)) return jsonResponse({ error: "The image must be a JPEG, PNG or WebP." }, 400, env);
    if (request.method === "POST" && index.length >= MAX_SPECIES_IMAGES) {
      return jsonResponse({ error: `A ${noun} can have at most ${MAX_SPECIES_IMAGES} images.` }, 409, env);
    }
    if (request.method === "PUT" && !index.some((i) => i.id === imageId)) return jsonResponse({ error: "Image not found." }, 404, env);
    if (Number(request.headers.get("Content-Length")) > MAX_SPECIES_IMAGE_BYTES) return jsonResponse({ error: "That image is too large." }, 413, env);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length === 0) return jsonResponse({ error: "The image is empty." }, 400, env);
    if (bytes.length > MAX_SPECIES_IMAGE_BYTES) return jsonResponse({ error: "That image is too large." }, 413, env);
    const id = imageId || crypto.randomUUID();
    const now = Date.now();
    const next = imageId ? index.map((i) => (i.id === imageId ? { id, v: now } : i)) : [...index, { id, v: now }];
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO species_images (id, list_id, content_type, data, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET content_type = excluded.content_type, data = excluded.data, updated_at = excluded.updated_at`
      ).bind(id, listId, type, bytesToBase64(bytes), now),
      saveIndex(next),
    ]);
    return { status: request.method === "POST" ? 201 : 200, next };
  }
  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

/**
 * Add (POST .../images), replace (PUT .../images/:imageId) or remove (DELETE .../images/:imageId) one picture of a list
 * entry (Species, Bait, Rig, Rod, Berley or Fishing Method). Same sign-in and ownership rules as editing the entry itself.
 * The body of an add/replace is the raw image (Content-Type jpeg/png/webp); the table row and the entry's image_index
 * change together in one batch. Returns the updated list row, which lists the pictures as images: [{id, version}].
 */
async function handleMarkListImages(request, url, env, listId, imageId) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const resolved = resolveEffectiveUserId(url, user);
  if (resolved.error) return jsonResponse({ error: resolved.error }, 403, env);
  const uid = resolved.id;

  const list = await env.DB.prepare("SELECT * FROM user_mark_lists WHERE id = ? AND user_id = ?").bind(listId, uid).first();
  if (!list) return jsonResponse({ error: "Mark list entry not found." }, 404, env);
  if (!IMAGE_FIELDS.includes(list.field)) return jsonResponse({ error: "This field can't have images." }, 400, env);

  const saveIndex = (next) => env.DB.prepare("UPDATE user_mark_lists SET image_index = ? WHERE id = ? AND user_id = ?").bind(next.length ? JSON.stringify(next) : null, listId, uid);
  const result = await applyImageChange(request, env, listId, parseImageIndex(list.image_index), imageId, saveIndex, list.field === "Species" ? "species" : "value");
  if (result instanceof Response) return result;

  const updated = await env.DB.prepare("SELECT * FROM user_mark_lists WHERE id = ?").bind(listId).first();
  return jsonResponse(rowToMarkList(updated), result.status, env);
}

/**
 * The same add / replace / delete for one OPTION of a Rig's sub list (/api/marklists/:rigId/options/:option/images[/:imageId]).
 * Options are plain strings, so their pictures are indexed per option in option_images: on the rig row itself (a rig you
 * own, or Public's when acting as Public), or — with ?scope=private — on YOUR private override of a Public rig
 * (user_rig_sublist_overrides), which is always the caller's own, never "on behalf of" anyone. The picture bytes live in
 * species_images against the rig's id either way. Returns the updated rig row (rowToMarkList), or for private scope
 * {rigId, subList, optionImages}.
 */
async function handleRigOptionImages(request, url, env, rigId, option, imageId) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const priv = url.searchParams.get("scope") === "private";

  let all;
  let subList;
  let saveAll;
  if (priv) {
    const rig = await env.DB.prepare("SELECT * FROM user_mark_lists WHERE id = ?").bind(rigId).first();
    if (!rig || rig.field !== "Rig") return jsonResponse({ error: "Rig not found." }, 404, env);
    if (rig.user_id === user.id) return jsonResponse({ error: "You own this rig — add pictures to its options directly." }, 400, env);
    const override = await env.DB.prepare("SELECT * FROM user_rig_sublist_overrides WHERE user_id = ? AND rig_id = ?").bind(user.id, rigId).first();
    subList = override ? parseSubList(override.sub_list) : [];
    if (!override || !subList.includes(option)) return jsonResponse({ error: "Option not found." }, 404, env);
    all = parseOptionImages(override.option_images);
    saveAll = (text) => env.DB.prepare("UPDATE user_rig_sublist_overrides SET option_images = ? WHERE id = ?").bind(text, override.id);
  } else {
    const resolved = resolveEffectiveUserId(url, user);
    if (resolved.error) return jsonResponse({ error: resolved.error }, 403, env);
    const uid = resolved.id;
    const rig = await env.DB.prepare("SELECT * FROM user_mark_lists WHERE id = ? AND user_id = ?").bind(rigId, uid).first();
    if (!rig || rig.field !== "Rig") return jsonResponse({ error: "Rig not found." }, 404, env);
    subList = parseSubList(rig.sub_list);
    if (!subList.includes(option)) return jsonResponse({ error: "Option not found." }, 404, env);
    all = parseOptionImages(rig.option_images);
    saveAll = (text) => env.DB.prepare("UPDATE user_mark_lists SET option_images = ? WHERE id = ? AND user_id = ?").bind(text, rigId, uid);
  }

  let saved = all;
  const saveIndex = (next) => {
    saved = { ...all };
    if (next.length) saved[option] = next;
    else delete saved[option];
    return saveAll(Object.keys(saved).length ? JSON.stringify(saved) : null);
  };
  const result = await applyImageChange(request, env, rigId, all[option] || [], imageId, saveIndex, "option");
  if (result instanceof Response) return result;

  if (priv) return jsonResponse({ rigId, subList, optionImages: optionImagesForClient(saved) }, result.status, env);
  const updated = await env.DB.prepare("SELECT * FROM user_mark_lists WHERE id = ?").bind(rigId).first();
  return jsonResponse(rowToMarkList(updated), result.status, env);
}

/** One species picture, for <img> tags anywhere (public, like the species list itself). The URL carries ?v=<version>, so it can be cached for good. */
async function handlePublicSpeciesImage(imageId, env) {
  const row = await env.DB.prepare("SELECT content_type, data FROM species_images WHERE id = ?").bind(imageId).first();
  const open = { "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin" };
  if (!row) return new Response("Not found", { status: 404, headers: open });
  return new Response(base64ToBytes(row.data), {
    status: 200,
    headers: { ...open, "Content-Type": row.content_type, "Cache-Control": "public, max-age=31536000, immutable" },
  });
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
    minSize: row.min_size ?? null,
    maxSize: row.max_size ?? null,
    maxQty: row.max_qty ?? null,
    bigMaxQty: row.big_max_qty ?? null,
    bigSize: row.big_size ?? null,
    qtyGroup: row.qty_group ?? null,
    images: parseImageIndex(row.image_index).map((i) => ({ id: i.id, version: i.v ?? null })),
    optionImages: optionImagesForClient(parseOptionImages(row.option_images)), // a Rig's per-option pictures, see handleRigOptionImages
    hasSublist: !!row.has_sublist,
    subList: parseSubList(row.sub_list),
  };
}

// Species limits: lengths in cm (any number >= 0), quantities whole numbers >= 0. All optional (null clears).
const MARK_LIST_LIMIT_FIELDS = [
  { key: "minSize", label: "Min Size", integer: false },
  { key: "maxSize", label: "Max Size", integer: false },
  { key: "maxQty", label: "Max Qty", integer: true },
  { key: "bigMaxQty", label: "Big Max Qty", integer: true },
  { key: "bigSize", label: "Big Size", integer: false },
];

function validateMarkListInput(body, { partial }) {
  if (!body || typeof body !== "object") return "Request body must be a JSON object.";
  for (const { key, label, integer } of MARK_LIST_LIMIT_FIELDS) {
    const v = body[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return `${label} must be a number of 0 or more, or blank.`;
    if (integer && !Number.isInteger(v)) return `${label} must be a whole number.`;
  }
  if (body.linkedSpecies !== undefined) {
    const list = body.linkedSpecies;
    if (!Array.isArray(list) || list.length > 50 || list.some((v) => typeof v !== "string" || !v.trim())) {
      return "linkedSpecies must be a list of species names.";
    }
  }
  if (body.subList !== undefined) {
    const list = body.subList;
    if (!Array.isArray(list) || list.length > 100 || list.some((v) => typeof v !== "string" || !v.trim())) {
      return "subList must be a list of option names.";
    }
  }
  if (body.hasSublist !== undefined && typeof body.hasSublist !== "boolean") {
    return "hasSublist must be true or false.";
  }
  if (!partial || body.field !== undefined) {
    if (typeof body.field !== "string" || !body.field.trim()) return "field is required.";
  }
  if (!partial || body.value !== undefined) {
    if (typeof body.value !== "string" || !body.value.trim()) return "value is required.";
  }
  return null;
}

/**
 * Species whose Max Qty is one combined limit share a `qty_group` id. Works out the row changes for "this species is
 * now combined with exactly these others" (pure, so it can be tested without a database).
 *   rows: every Species row of the account, as {id, value, qtyGroup, maxQty}
 *   editedId: the species being edited; linkedValues: the species it is combined with (names, not including itself)
 *   maxQty: the Max Qty to apply to the whole group (the edited species' own); newGroupId: id to use if it needs a new group
 * Rules: the edited species plus the chosen ones form one group; a chosen species already in a different group brings
 * that whole group in (merge); species in the edited species' old group that are no longer chosen leave it; everyone left
 * in the group gets the same Max Qty; a group of one is no group. Returns {updates: [{id, qtyGroup, maxQty}]} listing
 * only rows that change, or {error}.
 */
function planSpeciesLinks({ rows, editedId, linkedValues, maxQty, newGroupId }) {
  const edited = rows.find((r) => r.id === editedId);
  if (!edited) return { error: "Species not found." };
  const byValue = new Map(rows.map((r) => [r.value, r]));
  const chosen = [];
  for (const v of new Set(linkedValues)) {
    const row = byValue.get(v);
    if (!row) return { error: `"${v}" isn't a species.` };
    if (row.id === editedId) return { error: "A species can't be combined with itself." };
    chosen.push(row);
  }
  const members = new Map([[edited.id, edited]]);
  for (const row of chosen) {
    members.set(row.id, row);
    // Already in a different group: that whole group joins (the edited species' own old group is only what was ticked)
    if (row.qtyGroup && row.qtyGroup !== edited.qtyGroup) {
      for (const m of rows) if (m.qtyGroup === row.qtyGroup) members.set(m.id, m);
    }
  }
  const groupId = members.size > 1 ? edited.qtyGroup || newGroupId : null;
  const qty = maxQty ?? null;
  const updates = [];
  for (const r of rows) {
    const inGroup = members.has(r.id);
    const wasInEditedGroup = edited.qtyGroup && r.qtyGroup === edited.qtyGroup;
    if (!inGroup && !wasInEditedGroup) continue;
    const next = inGroup ? { qtyGroup: groupId, maxQty: groupId ? qty : r.maxQty ?? null } : { qtyGroup: null, maxQty: r.maxQty ?? null };
    if ((r.qtyGroup ?? null) !== next.qtyGroup || (r.maxQty ?? null) !== next.maxQty) updates.push({ id: r.id, ...next });
  }
  return { updates };
}

// ---------------------------------------------------------------------
// v2: Marks (schema-v2.sql marks) — a user's own logged fishing marks.
// GET supports simple limit/offset paging (default 200, capped 500) since
// a real history can run into the thousands of rows — see the migration
// notes for how many currently exist.
// ---------------------------------------------------------------------

// Who owns a new mark: whoever creates it, whatever its type (since 2026-09-23 — Admin's Mark/POI points used to go
// to the shared "public" account). Admin can still hand any mark to Public or another user with the Owner field.
function markOwnerFor(user) {
  return user.id;
}

/** The accounts whose marks a caller can SEE: their own plus the shared "public" ones — except Admin, who (as of
 * the map's own owner tooltip/reassignment feature) sees every real user's marks, not just their own, so there's
 * something to review and hand back to the right person. Returns null to mean "no restriction" — see
 * handleMarksCollection/handlePublicMarks, which skip the WHERE entirely in that case rather than building an
 * always-true IN (...) list. Never anyone else's for a non-Admin caller. */
function markReadOwnerIds(user) {
  return user.role === "admin" ? null : [user.id, PUBLIC_USER_ID];
}

/** The accounts whose marks a caller can CHANGE: their own, plus (Admin only) every other account's — same
 * null-means-unrestricted convention as markReadOwnerIds above, and for the same reason: Admin can now see (and
 * so needs to be able to edit/delete/reassign) any mark, not just their own and the shared "public" set. */
function markOwnerIds(user) {
  return user.role === "admin" ? null : [user.id];
}

/** The mark as sent to the caller. `owner` says which of the CALLER's own sets it belongs to: "Mine" (their own
 * account), "Public" (the shared account), or — reachable by Admin only, now that markReadOwnerIds lets them see
 * every account's marks — "Other" for a different real user's own mark. Admin's own response additionally carries
 * the mark's REAL owner identity (ownerUserId/ownerName, from the users JOIN both admin queries below add) so the
 * map can show and change it (see buildMarkPopupEditHtml's Owner field, js/marks-core.js); a non-admin caller never
 * learns another real user's name this way, so those two fields are left off for them. */
function rowToOwnedMark(row, viewer) {
  const mark = rowToMark(row);
  mark.owner = row.user_id === PUBLIC_USER_ID ? "Public" : row.user_id === viewer.id ? "Mine" : "Other";
  if (viewer.role === "admin") {
    mark.ownerUserId = row.user_id;
    mark.ownerName = row.user_id === PUBLIC_USER_ID ? "Public" : row.owner_name || row.owner_email || row.user_id;
  }
  return mark;
}

async function handleMarksCollection(request, url, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);

  if (request.method === "GET") {
    const limit = Math.min(parseInt(url.searchParams.get("limit"), 10) || 200, 500);
    const offset = Math.max(parseInt(url.searchParams.get("offset"), 10) || 0, 0);
    // owners is null for Admin (see markReadOwnerIds) — every real user's marks, no WHERE at all — rather than
    // everyone else's own + the shared "public" set. JOINed to users for owner_name/owner_email either way (cheap,
    // and rowToOwnedMark only actually uses them for an Admin viewer) rather than a second query per row.
    const owners = markReadOwnerIds(user);
    const { results } = await (owners
      ? env.DB.prepare(
          `SELECT marks.*, users.name AS owner_name, users.email AS owner_email FROM marks JOIN users ON users.id = marks.user_id
           WHERE marks.user_id IN (${owners.map(() => "?").join(", ")}) ORDER BY marks.date_time DESC LIMIT ? OFFSET ?`
        ).bind(...owners, limit, offset)
      : env.DB.prepare(
          `SELECT marks.*, users.name AS owner_name, users.email AS owner_email FROM marks JOIN users ON users.id = marks.user_id
           ORDER BY marks.date_time DESC LIMIT ? OFFSET ?`
        ).bind(limit, offset)
    ).all();
    return jsonResponse(results.map((row) => rowToOwnedMark(row, user)), 200, env);
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
      await insertOrUpdateMark(env, id, markOwnerFor(user), body, now);
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

  // Whichever of the caller's accounts holds it (see markOwnerIds; null for Admin means no restriction at all —
  // any mark, any account); uid is that row's real owner.
  const owners = markOwnerIds(user);
  const existing = await (owners
    ? env.DB.prepare(`SELECT * FROM marks WHERE id = ? AND user_id IN (${owners.map(() => "?").join(", ")})`).bind(id, ...owners)
    : env.DB.prepare("SELECT * FROM marks WHERE id = ?").bind(id)
  ).first();
  if (!existing) return jsonResponse({ error: "Mark not found." }, 404, env);
  const uid = existing.user_id;

  if (request.method === "PUT") {
    const body = await readJsonBody(request);
    const validationError = validateMarkInput(body, { partial: true });
    if (validationError) return jsonResponse({ error: validationError }, 400, env);
    const merged = mergeMarkFields(existing, body);
    // An edit keeps the mark with its current owner, whatever changes (type included) — UNLESS Admin explicitly
    // picked a different owner from the map's Owner field (buildMarkPopupEditHtml / bulk edit, js/marks-*.js),
    // which always wins. Only Admin can send this — a non-admin's PUT never even reaches an existing row it
    // doesn't already own (see markOwnerIds above), so there's nothing for them to reassign in the first place.
    let newOwner = uid;
    if (user.role === "admin" && typeof body.ownerUserId === "string" && body.ownerUserId.trim()) {
      const targetId = body.ownerUserId.trim();
      const target = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(targetId).first();
      if (!target) return jsonResponse({ error: "ownerUserId not found." }, 400, env);
      newOwner = target.id;
    }
    await env.DB.prepare(
      `UPDATE marks SET lat=?, lng=?, name=?, type=?, date_time=?, source=?, source_uuid=?, species=?, bait=?, rig=?,
                        rod=?, berley=?, notes=?, size=?, released=?, weather_condition=?, tide_condition=?, tide_extreme=?, water_condition=?,
                        water_depth=?, water_temperature=?, temperature=?, barometer=?, wind_direction=?, wind_speed=?,
                        fishing_method=?, rig_options=?, session_role=?, session_group_id=?, trip_name=?, action_name=?, user_id=?
       WHERE id = ? AND user_id = ?`
    )
      .bind(
        merged.lat, merged.lng, merged.name, merged.type, merged.dateTime, merged.source, merged.sourceUuid,
        merged.species, merged.bait, merged.rig, merged.rod, merged.berley, merged.notes, merged.size, merged.released,
        merged.weatherCondition, merged.tideCondition, merged.tideExtreme, merged.waterCondition, merged.waterDepth,
        merged.waterTemperature, merged.temperature, merged.barometer, merged.windDirection, merged.windSpeed,
        merged.fishingMethod, merged.rigOptions, merged.sessionRole, merged.sessionGroupId, merged.tripName, merged.actionName, newOwner,
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
  await markInsertStatement(env, id, uid, body, now).run();
}

/** The prepared INSERT for one mark (not run), so a caller can include it in a batch — see the Fishing Controller events. */
function markInsertStatement(env, id, uid, body, now) {
  return env.DB.prepare(
    `INSERT INTO marks (id, user_id, lat, lng, name, type, date_time, source, source_uuid, species, bait, rig, rod,
                         berley, notes, size, released, weather_condition, tide_condition, tide_extreme, water_condition, water_depth,
                         water_temperature, temperature, barometer, wind_direction, wind_speed,
                         fishing_method, rig_options, session_role, session_group_id, created_at, trip_run_id, trip_name, action_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id, uid, body.lat, body.lng, body.name ?? null, body.type, body.dateTime, body.source ?? "manual",
      body.sourceUuid ?? null, body.species ?? null, body.bait ?? null, body.rig ?? null, body.rod ?? null,
      body.berley ?? null, body.notes ?? null, body.size ?? null, body.released ? 1 : 0, body.weatherCondition ?? null, body.tideCondition ?? null, body.tideExtreme ?? null,
      body.waterCondition ?? null, body.waterDepth ?? null, body.waterTemperature ?? null, body.temperature ?? null,
      body.barometer ?? null, body.windDirection ?? null, body.windSpeed ?? null,
      body.fishingMethod ?? null, body.rigOptions ?? null, body.sessionRole ?? null, body.sessionGroupId ?? null, now, body.tripRunId ?? null, body.tripName ?? null, body.actionName ?? null
    );
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
    berley: body.berley !== undefined ? body.berley : existing.berley,
    notes: body.notes !== undefined ? body.notes : existing.notes,
    size: body.size !== undefined ? body.size : existing.size,
    released: body.released !== undefined ? (body.released ? 1 : 0) : existing.released,
    weatherCondition: body.weatherCondition !== undefined ? body.weatherCondition : existing.weather_condition,
    tideCondition: body.tideCondition !== undefined ? body.tideCondition : existing.tide_condition,
    tideExtreme: body.tideExtreme !== undefined ? body.tideExtreme : existing.tide_extreme,
    waterCondition: body.waterCondition !== undefined ? body.waterCondition : existing.water_condition,
    fishingMethod: body.fishingMethod !== undefined ? body.fishingMethod : existing.fishing_method,
    rigOptions: body.rigOptions !== undefined ? body.rigOptions : existing.rig_options,
    waterDepth: body.waterDepth !== undefined ? body.waterDepth : existing.water_depth,
    waterTemperature: body.waterTemperature !== undefined ? body.waterTemperature : existing.water_temperature,
    temperature: body.temperature !== undefined ? body.temperature : existing.temperature,
    barometer: body.barometer !== undefined ? body.barometer : existing.barometer,
    windDirection: body.windDirection !== undefined ? body.windDirection : existing.wind_direction,
    windSpeed: body.windSpeed !== undefined ? body.windSpeed : existing.wind_speed,
    sessionRole: body.sessionRole !== undefined ? body.sessionRole : existing.session_role,
    sessionGroupId: body.sessionGroupId !== undefined ? body.sessionGroupId : existing.session_group_id,
    tripName: body.tripName !== undefined ? body.tripName : existing.trip_name,
    actionName: body.actionName !== undefined ? body.actionName : existing.action_name,
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
    berley: row.berley,
    notes: row.notes,
    size: row.size,
    released: !!row.released,
    weatherCondition: row.weather_condition,
    tideCondition: row.tide_condition,
    tideExtreme: row.tide_extreme,
    waterCondition: row.water_condition,
    fishingMethod: row.fishing_method,
    rigOptions: row.rig_options,
    waterDepth: row.water_depth,
    waterTemperature: row.water_temperature,
    temperature: row.temperature,
    barometer: row.barometer,
    windDirection: row.wind_direction,
    windSpeed: row.wind_speed,
    sessionRole: row.session_role,
    sessionGroupId: row.session_group_id,
    tripName: row.trip_name,
    actionName: row.action_name,
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
  for (const key of ["tripName", "actionName"]) {
    const v = body[key];
    if (v !== undefined && v !== null && (typeof v !== "string" || v.trim().length > 100)) return `${key} must be text of up to 100 characters.`;
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
  return jsonResponse(await buildLocationList(env), 200, env);
}

/**
 * Public counterpart to handlePipelineLocationsList — same list, no token.
 * Lets the site's pages read location config (display name, groups,
 * timings, tide offset, ...) LIVE from D1 rather than from whatever the
 * last data/conditions.json run baked in, so a Settings edit shows up on
 * the next page load without waiting for the WillyWeather job. Everything
 * here is already public via conditions.json / config/locations.json.
 */
async function handlePublicLocations(env) {
  return new Response(JSON.stringify(await buildLocationList(env)), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache", // the whole point is seeing an edit immediately
    },
  });
}

async function buildLocationList(env) {
  // Every account's locations — Public's and each user's own — tagged with their owner (`ownerId`), so the data
  // pipeline fetches forecasts for all of them and the pages show only Public's plus the signed-in person's
  // (locationVisibleToViewer, js/backend.js). A location's types, timings and groups are its owner's own entries.
  // NOTE: this list (and data/conditions.json built from it) is public — the pages hide other accounts' locations,
  // they aren't secret.
  const { results: locationRows } = await env.DB.prepare("SELECT * FROM locations ORDER BY name ASC").all();

  const { results: accessRows } = await env.DB.prepare(
    `SELECT ula.location_id, ula.drive_to, ula.drive_back, ula.set_up, ula.pack_up, ula.time_to_spot, ula.time_from_spot,
            ula.min_tide_height, t.name as type_name, t.behaves_like
     FROM user_location_access ula
     JOIN user_types t ON t.id = ula.type_id
     JOIN locations l ON l.id = ula.location_id
     WHERE ula.user_id = COALESCE(l.created_by_user_id, '${PUBLIC_USER_ID}')`
  ).all();
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
     JOIN locations l ON l.id = m.location_id
     WHERE m.user_id = COALESCE(l.created_by_user_id, '${PUBLIC_USER_ID}')`
  ).all();
  const groupsByLocation = new Map();
  for (const row of memberRows) {
    if (!groupsByLocation.has(row.location_id)) groupsByLocation.set(row.location_id, []);
    groupsByLocation.get(row.location_id).push(row.group_name);
  }

  const output = locationRows.map((loc) => {
    const groups = groupsByLocation.get(loc.id) || [];
    return {
      id: loc.id,
      ownerId: loc.created_by_user_id || PUBLIC_USER_ID, // whose location it is — see locationVisibleToViewer, js/backend.js
      name: loc.name,
      displayName: loc.display_name || loc.name, // same fallback rowToTracked uses, above — see this file's other location handlers for why
      shore: loc.shore,
      tidal: !!loc.tidal, // real column now (schema-v2.sql) — confirmed against live
                          // data (Metung, VIC) rather than assumed true for everyone
      locationGroup: groups[0] || null, // legacy singular field, kept for anything that still reads it
      locationGroups: groups,
      tideOffset: loc.tide_offset,
      hhwOffset: loc.hhw_offset ?? null,
      lhwOffset: loc.lhw_offset ?? null,
      hlwOffset: loc.hlw_offset ?? null,
      llwOffset: loc.llw_offset ?? null,
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

  return output;
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

// ---------------------------------------------------------------------
// Per-user saved preferences (table `user_prefs`, schema-v2.sql): the
// filters, favourites and plans the site otherwise keeps only in the
// browser's localStorage (js/prefs.js on the client). One row per user per
// setting; the value is stored exactly as the client sent it (a string —
// usually JSON). Always the REAL signed-in user, never the admin "acts as
// Public" account, so everyone's favourites are their own.
// ---------------------------------------------------------------------

// Must match SYNCED_PREF_KEYS in js/prefs.js. An allowlist, so the table can't be used as free-form storage.
const SYNCED_PREF_KEYS = new Set([
  "goodConditionsSelectedLocations",
  "goodConditionsSelectedTypes",
  "goodConditionsSelectedGroups",
  "goodConditionsSelectedDirections",
  "goodConditionsThresholds",
  "goodConditionsPinnedLocationsNew",
  "goodConditionsComputedSessions",
  "liveHomeTimings",
  "selectedLocation",
  "markViewSettings",
  "markLastFieldValues",
  "liveSessionDefaults",
  "tripOrigin",
  "liveActiveTrip",
]);
const PREF_MAX_VALUE_LENGTH = 64 * 1024;

function prefsResponse(body, status, env) {
  const res = jsonResponse(body, status, env);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}

async function handlePrefs(request, env) {
  const user = await requireUser(request, env);
  if (!user) return prefsResponse({ error: "Not signed in." }, 401, env);

  if (request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT key, value, updated_at FROM user_prefs WHERE user_id = ?").bind(user.id).all();
    const prefs = {};
    for (const r of results) if (SYNCED_PREF_KEYS.has(r.key)) prefs[r.key] = { value: r.value, updatedAt: r.updated_at };
    return prefsResponse({ userId: user.id, prefs }, 200, env);
  }

  if (request.method === "PUT") {
    const body = await readJsonBody(request);
    const changes = body && typeof body.changes === "object" && body.changes !== null && !Array.isArray(body.changes) ? body.changes : null;
    if (!changes) return prefsResponse({ error: "changes must be an object of key: value | null." }, 400, env);
    const entries = Object.entries(changes);
    if (entries.length === 0 || entries.length > SYNCED_PREF_KEYS.size) return prefsResponse({ error: "Wrong number of changes." }, 400, env);
    for (const [key, value] of entries) {
      if (!SYNCED_PREF_KEYS.has(key)) return prefsResponse({ error: `Unknown setting: ${key}` }, 400, env);
      if (value !== null && (typeof value !== "string" || value.length > PREF_MAX_VALUE_LENGTH)) {
        return prefsResponse({ error: `${key} must be text up to ${PREF_MAX_VALUE_LENGTH} characters, or null to remove it.` }, 400, env);
      }
    }
    const now = Date.now();
    await env.DB.batch(
      entries.map(([key, value]) =>
        value === null
          ? env.DB.prepare("DELETE FROM user_prefs WHERE user_id = ? AND key = ?").bind(user.id, key)
          : env.DB.prepare(
              `INSERT INTO user_prefs (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
               ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
            ).bind(user.id, key, value, now)
      )
    );
    return prefsResponse({ saved: entries.length }, 200, env);
  }

  return prefsResponse({ error: "Method not allowed." }, 405, env);
}

// ---------------------------------------------------------------------
// Observed-conditions archive (tables `observations` and `tide_events`,
// schema-v2.sql). Written by the GitHub Actions pipeline every run, read by
// the Reports tab's Session Ribbon so a past session can show the real
// station readings and the tide without a billed WillyWeather call.
//
//   observations: one row per location per COMPLETED hour — station temp/wind
//     (observed), plus Open-Meteo pressure, sea temperature and ocean current.
//     Forecasts and the derived Condition scores are deliberately not stored.
//   tide_events: the high/low tide events, raw from the station (the
//     location's own tideOffset is applied when read). Holds the latest
//     prediction for each event; once an event has passed its value is frozen.
//
// Everything is naive local time ("YYYY-MM-DD HH:00" / "YYYY-MM-DD HH:MM:SS"),
// like the rest of the site. Retention: everything is kept for a month, then
// only rows within N hours (12) of a Session mark survive — see prune below.
// ---------------------------------------------------------------------

const OBS_HOUR_RE = /^\d{4}-\d{2}-\d{2} \d{2}:00$/;
const OBS_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const OBS_MAX_ITEMS = 400; // per request — a location's run sends a few dozen
const OBS_MAX_READ_ROWS = 2000;

function obsNumber(v, min, max) {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

/** A validated observation, or null. `asOfHour` is the current (still incomplete) hour: only earlier hours are stored. */
function cleanObservation(o, asOfHour) {
  if (!o || typeof o.hour !== "string" || !OBS_HOUR_RE.test(o.hour) || o.hour >= asOfHour) return null;
  const clean = {
    hour: o.hour,
    tempC: obsNumber(o.tempC, -60, 70),
    windKmh: obsNumber(o.windKmh, 0, 400),
    windDir: typeof o.windDir === "string" && /^[NESW]{1,3}$/.test(o.windDir) ? o.windDir : null,
    pressureHpa: obsNumber(o.pressureHpa, 850, 1100),
    waterTempC: obsNumber(o.waterTempC, -5, 50),
    currentKmh: obsNumber(o.currentKmh, 0, 50),
    currentDir: obsNumber(o.currentDir, 0, 360),
  };
  // an hour with nothing in it isn't worth a row
  return Object.entries(clean).some(([k, v]) => k !== "hour" && v != null) ? clean : null;
}

function cleanTideEvent(e) {
  if (!e || typeof e.time !== "string" || !OBS_TIME_RE.test(e.time)) return null;
  if (e.type !== "high" && e.type !== "low") return null;
  const heightM = obsNumber(e.heightM, -15, 25);
  return heightM == null ? null : { time: e.time, type: e.type, heightM };
}

/**
 * Writes one location's observations and tide events into the archive tables (shared by the pipeline and the admin's
 * ribbon lookups, so the rules can't drift apart). `asOf` is the caller-trusted "now" ('YYYY-MM-DD HH:MM:SS' local).
 */
async function writeArchive(env, location, asOf, rawObs, rawTide) {
  const asOfHour = asOf.slice(0, 13) + ":00";
  rawObs = Array.isArray(rawObs) ? rawObs.slice(0, OBS_MAX_ITEMS) : [];
  rawTide = Array.isArray(rawTide) ? rawTide.slice(0, OBS_MAX_ITEMS) : [];
  const observations = rawObs.map((o) => cleanObservation(o, asOfHour)).filter(Boolean);
  const tideEvents = rawTide.map(cleanTideEvent).filter(Boolean);

  // An hour that already exists is only ever filled in where a column is still empty (Open-Meteo values can arrive
  // after the station's), never overwritten. `WHERE` keeps an unchanged re-send from counting as a write.
  const fill = (col) => `${col} = COALESCE(observations.${col}, excluded.${col})`;
  const gap = (col) => `(observations.${col} IS NULL AND excluded.${col} IS NOT NULL)`;
  const cols = ["temp_c", "wind_kmh", "wind_dir", "pressure_hpa", "water_temp_c", "current_kmh", "current_dir"];
  const obsSql =
    `INSERT INTO observations (location_name, hour, ${cols.join(", ")}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(location_name, hour) DO UPDATE SET ${cols.map(fill).join(", ")}
     WHERE ${cols.map(gap).join(" OR ")}`;
  const tideSql =
    `INSERT INTO tide_events (location_name, event_time, type, height_m) VALUES (?, ?, ?, ?)
     ON CONFLICT(location_name, event_time, type) DO UPDATE SET height_m = excluded.height_m
     WHERE tide_events.event_time > ? AND tide_events.height_m IS NOT excluded.height_m`;

  const statements = [
    ...observations.map((o) =>
      env.DB.prepare(obsSql).bind(location, o.hour, o.tempC, o.windKmh, o.windDir, o.pressureHpa, o.waterTempC, o.currentKmh, o.currentDir)
    ),
    ...tideEvents.map((e) => env.DB.prepare(tideSql).bind(location, e.time, e.type, e.heightM, asOf)),
  ];
  let observationsWritten = 0;
  let tideEventsWritten = 0;
  if (statements.length > 0) {
    const results = await env.DB.batch(statements); // one round trip per location keeps a free-plan request within its query allowance
    results.forEach((r, i) => {
      const changes = (r && r.meta && r.meta.changes) || 0;
      if (i < observations.length) observationsWritten += changes;
      else tideEventsWritten += changes;
    });
  }
  return {
    location,
    observationsWritten,
    tideEventsWritten,
    skipped: rawObs.length - observations.length + (rawTide.length - tideEvents.length),
  };
}

async function handlePipelineObservations(request, env) {
  if (!requirePipelineToken(request, env)) {
    return jsonResponse({ error: "Invalid or missing pipeline token." }, 401, env);
  }
  const body = await readJsonBody(request);
  const location = typeof body.location === "string" ? body.location.trim() : "";
  if (!location || location.length > 200) return jsonResponse({ error: "location is required." }, 400, env);
  if (typeof body.asOf !== "string" || !OBS_TIME_RE.test(body.asOf)) {
    return jsonResponse({ error: "asOf must be 'YYYY-MM-DD HH:MM:SS' (local time)." }, 400, env);
  }
  return jsonResponse(await writeArchive(env, location, body.asOf, body.observations, body.tideEvents), 200, env);
}

/** Melbourne wall-clock time now, 'YYYY-MM-DD HH:MM:SS' (the archive's naive local time). */
function melbourneNowString() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Melbourne",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/**
 * The admin's Session Ribbon saves what it had to look up live (Open-Meteo hours, WillyWeather tide events) so the next
 * view finds it in the archive. Same tables and rules as the pipeline, but the caller is a signed-in admin (never the
 * pipeline token) and "now" comes from the server clock, not the client's.
 */
async function handleArchiveLookups(request, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  if (user.role !== "admin") return jsonResponse({ error: "Admin only." }, 403, env);
  const body = await readJsonBody(request);
  const location = typeof body.location === "string" ? body.location.trim() : "";
  if (!location || location.length > 200) return jsonResponse({ error: "location is required." }, 400, env);
  return jsonResponse(await writeArchive(env, location, melbourneNowString(), body.observations, body.tideEvents), 200, env);
}

/**
 * Retention: rows older than `keepDays` (30) are deleted unless they lie within
 * `windowHours` (12) of a Session mark (any session's start or end, any
 * location) — the window the Session Ribbon shows. mode "dry" only counts what
 * would go; "run" deletes. Called once per pipeline run, after the writes.
 */
async function handlePipelineObservationsPrune(request, env) {
  if (!requirePipelineToken(request, env)) {
    return jsonResponse({ error: "Invalid or missing pipeline token." }, 401, env);
  }
  const body = await readJsonBody(request);
  if (typeof body.asOf !== "string" || !OBS_TIME_RE.test(body.asOf)) {
    return jsonResponse({ error: "asOf must be 'YYYY-MM-DD HH:MM:SS' (local time)." }, 400, env);
  }
  const mode = body.mode === "run" ? "run" : "dry";
  const keepDays = Number.isInteger(body.keepDays) && body.keepDays >= 7 && body.keepDays <= 365 ? body.keepDays : 30;
  const windowHours = Number.isInteger(body.windowHours) && body.windowHours >= 12 && body.windowHours <= 72 ? body.windowHours : 12;

  const cutoffMod = `-${keepDays} days`;
  const before = `-${windowHours} hours`;
  const after = `+${windowHours} hours`;
  const doomed = (table, timeCol) =>
    `FROM ${table} WHERE datetime(${timeCol}) < datetime(?, ?)
       AND NOT EXISTS (
         SELECT 1 FROM marks m
         WHERE m.type IN ('Session Start', 'Session End') AND datetime(m.date_time) BETWEEN datetime(${table}.${timeCol}, ?) AND datetime(${table}.${timeCol}, ?)
       )`;
  const args = [body.asOf, cutoffMod, before, after];

  const obsCount = await env.DB.prepare(`SELECT COUNT(*) AS n ${doomed("observations", "hour")}`).bind(...args).first();
  const tideCount = await env.DB.prepare(`SELECT COUNT(*) AS n ${doomed("tide_events", "event_time")}`).bind(...args).first();
  const result = { mode, keepDays, windowHours, observations: obsCount ? obsCount.n : 0, tideEvents: tideCount ? tideCount.n : 0 };
  if (mode === "run") {
    await env.DB.batch([
      env.DB.prepare(`DELETE ${doomed("observations", "hour")}`).bind(...args),
      env.DB.prepare(`DELETE ${doomed("tide_events", "event_time")}`).bind(...args),
    ]);
  }
  return jsonResponse(result, 200, env);
}

function publicArchiveResponse(rows) {
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*", // same data the public site already shows; read-only
      "Cache-Control": "public, max-age=300",
    },
  });
}

function archiveQuery(url) {
  const location = (url.searchParams.get("location") || "").trim();
  const norm = (v) => String(v || "").trim().replace("T", " ");
  return { location, from: norm(url.searchParams.get("from")), to: norm(url.searchParams.get("to")) };
}

async function handlePublicObservations(url, env) {
  const { location, from, to } = archiveQuery(url);
  if (!location || location.length > 200 || !/^\d{4}-\d{2}-\d{2}/.test(from) || !/^\d{4}-\d{2}-\d{2}/.test(to)) {
    return new Response(JSON.stringify({ error: "location, from and to are required." }), { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }
  const { results } = await env.DB.prepare(
    `SELECT hour, temp_c, wind_kmh, wind_dir, pressure_hpa, water_temp_c, current_kmh, current_dir
     FROM observations WHERE location_name = ? AND hour >= ? AND hour <= ? ORDER BY hour ASC LIMIT ${OBS_MAX_READ_ROWS}`
  )
    .bind(location, from.slice(0, 13) + ":00", to.slice(0, 13) + ":00")
    .all();
  return publicArchiveResponse(
    results.map((r) => ({
      hour: r.hour,
      tempC: r.temp_c,
      windKmh: r.wind_kmh,
      windDir: r.wind_dir,
      pressureHpa: r.pressure_hpa,
      waterTempC: r.water_temp_c,
      currentKmh: r.current_kmh,
      currentDir: r.current_dir,
    }))
  );
}

async function handlePublicTideEvents(url, env) {
  const { location, from, to } = archiveQuery(url);
  if (!location || location.length > 200 || !/^\d{4}-\d{2}-\d{2}/.test(from) || !/^\d{4}-\d{2}-\d{2}/.test(to)) {
    return new Response(JSON.stringify({ error: "location, from and to are required." }), { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }
  const full = (v) => (v.length === 10 ? v + " 00:00:00" : v.slice(0, 19));
  const { results } = await env.DB.prepare(
    `SELECT event_time, type, height_m FROM tide_events
     WHERE location_name = ? AND event_time >= ? AND event_time <= ? ORDER BY event_time ASC LIMIT ${OBS_MAX_READ_ROWS}`
  )
    .bind(location, full(from), full(to))
    .all();
  return publicArchiveResponse(results.map((r) => ({ time: r.event_time, type: r.type, heightM: r.height_m })));
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
/**
 * PRIVACY CHANGE: this used to be readable by anyone with no sign-in (every
 * mark, exact position and notes). It now needs a signed-in session and
 * returns only the caller's own marks plus the shared "public" ones — never
 * another user's (see markReadOwnerIds). The URL keeps its
 * "public" name only so existing callers didn't need re-pointing; they now
 * send credentials (charts.js, reports.js, sync.js).
 */
async function handlePublicMarks(request, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  // Everyone signed in sees their own marks (Catches, Sessions) together with the shared "public" ones (Mark, POI);
  // Admin sees every real user's marks too, not just their own (owners is null — see markReadOwnerIds) — the Map
  // page's owner tooltip/reassignment feature needs something besides their own account to actually show.
  const owners = markReadOwnerIds(user);
  // ?since=<UTC ms>: only marks this database row was created after (what a Live page that is already open pulls to pick up marks
  // made elsewhere — the Fishing Controller, another device — without downloading every mark again).
  const sinceParam = Number(new URL(request.url).searchParams.get("since"));
  const since = Number.isFinite(sinceParam) && sinceParam > 0 ? sinceParam : null;
  const { results } = await (owners
    ? env.DB.prepare(
        `SELECT marks.*, users.name AS owner_name, users.email AS owner_email FROM marks JOIN users ON users.id = marks.user_id
         WHERE marks.user_id IN (${owners.map(() => "?").join(", ")})${since ? " AND marks.created_at > ?" : ""} ORDER BY marks.date_time DESC`
      ).bind(...owners, ...(since ? [since] : []))
    : env.DB.prepare(
        `SELECT marks.*, users.name AS owner_name, users.email AS owner_email FROM marks JOIN users ON users.id = marks.user_id
         ${since ? "WHERE marks.created_at > ?" : ""} ORDER BY marks.date_time DESC`
      ).bind(...(since ? [since] : []))
  ).all();
  return new Response(JSON.stringify(results.map((row) => rowToOwnedMark(row, user))), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
      ...corsHeaders(env),
    },
  });
}

// The site-wide Google Routes API key lives in site_settings under this key (see schema-v2.sql).
const SITE_ROUTES_KEY_SETTING = "google_routes_api_key";

/**
 * Public counterpart to handlePublicMarkLists/handlePublicMarks above —
 * this is what lets week.js/live.js/locationsadmin.js read the caller's
 * own home address, and the site's Google Routes API key, LIVE from D1
 * instead of the static config/settings.json file they used to. The Routes
 * key is a SITE-WIDE setting (site_settings, key "google_routes_api_key"):
 * every signed-in user gets it so their browser can work out drive times,
 * anonymous visitors never do. It is meant to be used client-side and is
 * also protected by an HTTP-referrer restriction in Google Cloud Console.
 * Read-only; there is no public write path (it is set with a direct D1 update).
 */
async function handlePublicSettings(request, env) {
  // PRIVACY CHANGE: the home coordinates are only returned to the signed-in
  // user they belong to (their own row); the Routes key to any signed-in user.
  // Anonymous visitors get 200 with all nulls, so the pages still load and
  // simply skip home-based drive times.
  const user = await requireUser(request, env);
  const homes = user ? await listHomes(env, user.id) : [];
  const keyRow = user
    ? await env.DB.prepare("SELECT value FROM site_settings WHERE key = ?").bind(SITE_ROUTES_KEY_SETTING).first()
    : null;
  return new Response(
    JSON.stringify({
      homes, // every home of theirs — Live's "Home By" uses whichever is closest to the fishing spot
      homeLat: homes.length ? homes[0].lat : null, // the first one, for any older page still reading a single home
      homeLng: homes.length ? homes[0].lng : null,
      googleRoutesApiKey: keyRow ? keyRow.value : null,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
        ...corsHeaders(env),
      },
    }
  );
}

// --- Messages to the site's owner (messages table). Signed-in users send; Admin reads and replies. Nobody's email is
// shown to a non-admin — the sender only ever sees their own messages and the replies to them. -----------------------

const MESSAGE_MAX_LENGTH = 2000;
const MESSAGES_PER_HOUR = 5;

/** A message as its sender sees it (no admin details at all). */
function messageForSender(r) {
  return { id: r.id, body: r.body, createdAt: r.created_at, reply: r.reply ?? null, repliedAt: r.replied_at ?? null };
}

/** GET /api/messages — the signed-in person's own messages and any replies (newest first; their new replies count as
 * seen from now on). POST {body} — sends one, at most MESSAGES_PER_HOUR an hour. */
async function handleMessages(request, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  if (request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM messages WHERE user_id = ? ORDER BY created_at DESC").bind(user.id).all();
    await env.DB.prepare("UPDATE messages SET reply_seen_at = ? WHERE user_id = ? AND reply IS NOT NULL AND reply_seen_at IS NULL")
      .bind(Date.now(), user.id)
      .run();
    return jsonResponse(results.map(messageForSender), 200, env);
  }
  if (request.method === "POST") {
    const body = await readJsonBody(request);
    const text = body && typeof body.body === "string" ? body.body.trim() : "";
    if (!text) return jsonResponse({ error: "Write a message first." }, 400, env);
    if (text.length > MESSAGE_MAX_LENGTH) return jsonResponse({ error: `Messages can be at most ${MESSAGE_MAX_LENGTH} characters.` }, 400, env);
    const now = Date.now();
    const { n } = await env.DB.prepare("SELECT COUNT(*) as n FROM messages WHERE user_id = ? AND created_at > ?").bind(user.id, now - 3600000).first();
    if (n >= MESSAGES_PER_HOUR) return jsonResponse({ error: "You've sent several messages in the last hour — please try again later." }, 429, env);
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO messages (id, user_id, body, created_at) VALUES (?, ?, ?, ?)").bind(id, user.id, text, now).run();
    return jsonResponse(messageForSender({ id, body: text, created_at: now }), 201, env);
  }
  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

/** DELETE /api/messages/:id — the sender removes one of their own messages (and any reply to it). */
async function handleOwnMessageDelete(request, env, id) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const { meta } = await env.DB.prepare("DELETE FROM messages WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  if (!meta || !meta.changes) return jsonResponse({ error: "Message not found." }, 404, env);
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}

/** GET /api/messages/unread — {count}: for Admin, unread incoming messages; for anyone else, replies they haven't
 * seen yet. Drives the badge on the Settings tab (js/backend.js). */
async function handleMessagesUnread(request, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const row =
    user.role === "admin"
      ? await env.DB.prepare("SELECT COUNT(*) as n FROM messages WHERE read_at IS NULL").first()
      : await env.DB.prepare("SELECT COUNT(*) as n FROM messages WHERE user_id = ? AND reply IS NOT NULL AND reply_seen_at IS NULL").bind(user.id).first();
  return jsonResponse({ count: row.n }, 200, env);
}

/** GET /api/admin/messages — every message, newest first, with who sent it. Admin only. */
async function handleAdminMessages(request, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  if (user.role !== "admin") return jsonResponse({ error: "Admin only." }, 403, env);
  const { results } = await env.DB.prepare(
    `SELECT m.*, u.name AS sender_name, u.email AS sender_email FROM messages m LEFT JOIN users u ON u.id = m.user_id
     ORDER BY m.created_at DESC`
  ).all();
  return jsonResponse(
    results.map((r) => ({
      ...messageForSender(r),
      senderName: r.sender_name ?? null,
      senderEmail: r.sender_email ?? null,
      readAt: r.read_at ?? null,
    })),
    200,
    env
  );
}

/** PATCH /api/admin/messages/:id {read?, reply?} — mark read/unread and/or save a reply (an empty reply removes it);
 * DELETE removes the message. Admin only. */
async function handleAdminMessageItem(request, env, id) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  if (user.role !== "admin") return jsonResponse({ error: "Admin only." }, 403, env);
  const existing = await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(id).first();
  if (!existing) return jsonResponse({ error: "Message not found." }, 404, env);
  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }
  const body = (await readJsonBody(request)) || {};
  const now = Date.now();
  if (body.read !== undefined) {
    await env.DB.prepare("UPDATE messages SET read_at = ? WHERE id = ?").bind(body.read ? now : null, id).run();
  }
  if (body.reply !== undefined) {
    const reply = typeof body.reply === "string" ? body.reply.trim() : "";
    if (reply.length > MESSAGE_MAX_LENGTH) return jsonResponse({ error: `Replies can be at most ${MESSAGE_MAX_LENGTH} characters.` }, 400, env);
    await env.DB.prepare("UPDATE messages SET reply = ?, replied_at = ?, reply_seen_at = NULL, read_at = COALESCE(read_at, ?) WHERE id = ?")
      .bind(reply || null, reply ? now : null, now, id)
      .run();
  }
  return jsonResponse({ id }, 200, env);
}

// --- Homes: a user can have as many as they like (user_homes). Only ever their own. ---------------------------------

async function listHomes(env, userId) {
  const { results } = await env.DB.prepare("SELECT id, lat, lng, name FROM user_homes WHERE user_id = ? ORDER BY created_at ASC").bind(userId).all();
  return results.map((r) => ({ id: r.id, lat: r.lat, lng: r.lng, name: r.name ?? null }));
}

async function addHome(env, userId, body) {
  if (!body || typeof body.lat !== "number" || typeof body.lng !== "number" || !Number.isFinite(body.lat) || !Number.isFinite(body.lng)) {
    return { error: "lat and lng must both be numbers." };
  }
  const name = cleanHomeName(body.name);
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO user_homes (id, user_id, lat, lng, name, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, userId, body.lat, body.lng, name, Date.now())
    .run();
  return { home: { id, lat: body.lat, lng: body.lng, name } };
}

/** A home's label — the closest town, looked up by the page (WillyWeather's nearest place). Trimmed, at most 80
 * characters; anything else becomes null. */
function cleanHomeName(name) {
  return typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : null;
}

/** PATCH /api/homes/:id {name} — sets the label of one of the signed-in user's own homes. */
async function handleHomeRename(request, env, id) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const body = await readJsonBody(request);
  const name = cleanHomeName(body && body.name);
  const { meta } = await env.DB.prepare("UPDATE user_homes SET name = ? WHERE id = ? AND user_id = ?").bind(name, id, user.id).run();
  if (!meta || !meta.changes) return jsonResponse({ error: "Home not found." }, 404, env);
  return jsonResponse({ id, name }, 200, env);
}

/** GET /api/homes — the signed-in user's homes; POST {lat, lng, name?} adds one. */
async function handleHomes(request, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  if (request.method === "GET") return jsonResponse(await listHomes(env, user.id), 200, env);
  if (request.method === "POST") {
    const result = await addHome(env, user.id, await readJsonBody(request));
    if (result.error) return jsonResponse({ error: result.error }, 400, env);
    return jsonResponse(result.home, 201, env);
  }
  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

/** DELETE /api/homes/:id — one of the signed-in user's own homes. */
async function handleHomeDelete(request, env, id) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const { meta } = await env.DB.prepare("DELETE FROM user_homes WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  if (!meta || !meta.changes) return jsonResponse({ error: "Home not found." }, 404, env);
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}

/** PUT /api/home-location {lat, lng} (and the old /api/admin/home-location alias) — older pages' "set home": it now
 * adds another home rather than replacing one. Returns the new home plus the old single-home fields. */
async function handleHomeLocation(request, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const result = await addHome(env, user.id, await readJsonBody(request));
  if (result.error) return jsonResponse({ error: result.error }, 400, env);
  return jsonResponse({ ...result.home, homeLat: result.home.lat, homeLng: result.home.lng }, 200, env);
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
 * the admin checks above, for the same reason.
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
          // GitHub's REST API rejects any request with no User-Agent at
          // all (a documented, hard requirement — see
          // docs.github.com/en/rest/using-the-rest-api/troubleshooting-
          // the-rest-api#user-agent-required) — confirmed directly: this
          // was the actual cause of the 403 here, nothing to do with the
          // token's permissions, which were already correct.
          "User-Agent": "fishingconditions-user-backend-worker",
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
// Admin: Users — list every real account and edit its role/tier. The
// Public sentinel row is deliberately excluded from the listing and
// blocked as a target — it's not a real account to manage this way.
// ---------------------------------------------------------------------

/**
 * Lists every real user (Admin and Basic — Public excluded), each with
 * its assigned tier's name resolved via a LEFT JOIN (tierName is null
 * for Admin accounts, which normally have no tier_id at all — a tier
 * only ever matters for a Basic account's location cap).
 */
async function handleAdminListUsers(env) {
  const { results } = await env.DB.prepare(
    `SELECT users.id, users.email, users.name, users.role, users.tier_id, users.created_at, tiers.name AS tier_name
     FROM users LEFT JOIN tiers ON tiers.id = users.tier_id
     WHERE users.id != ?
     ORDER BY users.created_at ASC`
  )
    .bind(PUBLIC_USER_ID)
    .all();
  return jsonResponse(results.map(rowToAdminUser), 200, env);
}

function rowToAdminUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    tierId: row.tier_id,
    tierName: row.tier_name || null,
    createdAt: row.created_at,
  };
}

/**
 * Updates a user's role and/or tier — either field independently, both
 * at once if both are given. Blocks two things: targeting the Public
 * sentinel (not a real account), and demoting the LAST remaining Admin
 * account (self or anyone else) — the site would otherwise have no way
 * back into any of these Admin-only sections short of editing D1
 * directly. Not blocked: an Admin changing their OWN role, as long as
 * at least one other Admin account would still exist afterward.
 */
/**
 * PUT /api/admin/locations/:id/owner {ownerUserId} — Admin only: hands a location to another account (the Map's
 * location editor, js/location-editor.js). Types and groups are per-account vocabularies, so the old owner's own
 * entries for the place move with it: each type entry is re-pointed at the new owner's type of the same name
 * (created if it has none — same name and scoring), and each group membership at the new owner's group of the same
 * name (also created if missing). If the new owner already tracks the place with that type, theirs is kept and the
 * old owner's duplicate dropped. Anyone else's own entries for the place are left alone. All in one batch.
 */
async function handleAdminLocationOwner(request, env, locationId) {
  const body = await readJsonBody(request);
  const target = body && typeof body.ownerUserId === "string" ? body.ownerUserId.trim() : "";
  if (!target) return jsonResponse({ error: "ownerUserId is required." }, 400, env);
  const loc = await env.DB.prepare("SELECT id, created_by_user_id FROM locations WHERE id = ?").bind(locationId).first();
  if (!loc) return jsonResponse({ error: "Location not found." }, 404, env);
  const targetUser = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(target).first();
  if (!targetUser) return jsonResponse({ error: "ownerUserId not found." }, 400, env);
  const from = loc.created_by_user_id;
  if (from === target) return jsonResponse({ locationId, ownerUserId: target }, 200, env);

  const now = Date.now();
  const stmts = [];
  const { results: access } = await env.DB.prepare(
    `SELECT a.id, a.type_id, t.name AS type_name, t.behaves_like FROM user_location_access a
     JOIN user_types t ON t.id = a.type_id WHERE a.location_id = ? AND a.user_id = ?`
  )
    .bind(locationId, from)
    .all();
  const { results: targetTypes } = await env.DB.prepare("SELECT id, name FROM user_types WHERE user_id = ?").bind(target).all();
  const typeIdByName = new Map(targetTypes.map((t) => [t.name, t.id]));
  const { results: targetAccess } = await env.DB.prepare("SELECT type_id FROM user_location_access WHERE user_id = ? AND location_id = ?")
    .bind(target, locationId)
    .all();
  const alreadyTracked = new Set(targetAccess.map((a) => a.type_id));
  for (const a of access) {
    let typeId = typeIdByName.get(a.type_name);
    if (!typeId) {
      typeId = crypto.randomUUID();
      typeIdByName.set(a.type_name, typeId);
      stmts.push(
        env.DB.prepare("INSERT INTO user_types (id, user_id, name, behaves_like, created_at) VALUES (?, ?, ?, ?, ?)").bind(typeId, target, a.type_name, a.behaves_like, now)
      );
    }
    if (alreadyTracked.has(typeId)) {
      stmts.push(env.DB.prepare("DELETE FROM user_location_access WHERE id = ?").bind(a.id));
    } else {
      alreadyTracked.add(typeId);
      stmts.push(env.DB.prepare("UPDATE user_location_access SET user_id = ?, type_id = ? WHERE id = ?").bind(target, typeId, a.id));
    }
  }

  const { results: members } = await env.DB.prepare(
    `SELECT g.name FROM user_location_group_members m JOIN user_location_groups g ON g.id = m.group_id
     WHERE m.user_id = ? AND m.location_id = ?`
  )
    .bind(from, locationId)
    .all();
  if (members.length) {
    const { results: targetGroups } = await env.DB.prepare("SELECT id, name FROM user_location_groups WHERE user_id = ?").bind(target).all();
    const groupIdByName = new Map(targetGroups.map((g) => [g.name, g.id]));
    stmts.push(env.DB.prepare("DELETE FROM user_location_group_members WHERE user_id = ? AND location_id = ?").bind(from, locationId));
    for (const { name } of members) {
      let groupId = groupIdByName.get(name);
      if (!groupId) {
        groupId = crypto.randomUUID();
        groupIdByName.set(name, groupId);
        stmts.push(env.DB.prepare("INSERT INTO user_location_groups (id, user_id, name, created_at) VALUES (?, ?, ?, ?)").bind(groupId, target, name, now));
      }
      stmts.push(
        env.DB.prepare("INSERT OR IGNORE INTO user_location_group_members (user_id, location_id, group_id) VALUES (?, ?, ?)").bind(target, locationId, groupId)
      );
    }
  }

  stmts.push(env.DB.prepare("UPDATE locations SET created_by_user_id = ? WHERE id = ?").bind(target, locationId));
  await env.DB.batch(stmts);
  return jsonResponse({ locationId, ownerUserId: target }, 200, env);
}

async function handleAdminUpdateUser(request, env, callerUser, targetId) {
  if (targetId === PUBLIC_USER_ID) return jsonResponse({ error: "Not a manageable account." }, 400, env);

  const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(targetId).first();
  if (!target) return jsonResponse({ error: "User not found." }, 404, env);

  const body = await readJsonBody(request);
  const updates = {};

  if (body.role !== undefined) {
    if (body.role !== "admin" && body.role !== "basic") {
      return jsonResponse({ error: "role must be 'admin' or 'basic'." }, 400, env);
    }
    if (target.role === "admin" && body.role !== "admin") {
      const otherAdmins = await env.DB.prepare("SELECT COUNT(*) as n FROM users WHERE role = 'admin' AND id != ?")
        .bind(targetId)
        .first();
      if (otherAdmins.n === 0) {
        return jsonResponse({ error: "Can't remove the last Admin account." }, 400, env);
      }
    }
    updates.role = body.role;
  }

  if (body.tierId !== undefined) {
    if (body.tierId !== null) {
      const tier = await env.DB.prepare("SELECT id FROM tiers WHERE id = ?").bind(body.tierId).first();
      if (!tier) return jsonResponse({ error: "tierId not found." }, 404, env);
    }
    updates.tier_id = body.tierId;
  }

  if (Object.keys(updates).length === 0) return jsonResponse({ error: "Nothing to update." }, 400, env);

  const setClauses = Object.keys(updates)
    .map((k) => `${k} = ?`)
    .join(", ");
  await env.DB.prepare(`UPDATE users SET ${setClauses} WHERE id = ?`)
    .bind(...Object.values(updates), targetId)
    .run();

  const updated = await env.DB.prepare(
    `SELECT users.id, users.email, users.name, users.role, users.tier_id, users.created_at, tiers.name AS tier_name
     FROM users LEFT JOIN tiers ON tiers.id = users.tier_id
     WHERE users.id = ?`
  )
    .bind(targetId)
    .first();
  return jsonResponse(rowToAdminUser(updated), 200, env);
}

// ---------------------------------------------------------------------
// Admin: Tiers — define and adjust the extra-location caps Basic
// accounts are assigned to (see handleTrackedCollection's own lookup
// for where this is actually enforced). Replaces the single fixed
// MAX_BASIC_CREATED_LOCATIONS constant with Admin-editable rows.
// ---------------------------------------------------------------------

async function handleAdminListTiers(env) {
  const { results } = await env.DB.prepare("SELECT * FROM tiers ORDER BY created_at ASC").all();
  return jsonResponse(results.map(rowToTier), 200, env);
}

function rowToTier(row) {
  return { id: row.id, name: row.name, maxExtraLocations: row.max_extra_locations, createdAt: row.created_at };
}

async function handleAdminCreateTier(request, env) {
  const body = await readJsonBody(request);
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return jsonResponse({ error: "name is required." }, 400, env);
  }
  if (typeof body.maxExtraLocations !== "number" || !Number.isInteger(body.maxExtraLocations) || body.maxExtraLocations < 0) {
    return jsonResponse({ error: "maxExtraLocations must be a whole number, zero or more." }, 400, env);
  }
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare("INSERT INTO tiers (id, name, max_extra_locations, created_at) VALUES (?, ?, ?, ?)")
      .bind(id, body.name.trim(), body.maxExtraLocations, Date.now())
      .run();
  } catch (err) {
    return jsonResponse({ error: `A tier named "${body.name.trim()}" already exists.` }, 409, env);
  }
  const created = await env.DB.prepare("SELECT * FROM tiers WHERE id = ?").bind(id).first();
  return jsonResponse(rowToTier(created), 201, env);
}

async function handleAdminUpdateTier(request, env, tierId) {
  const existing = await env.DB.prepare("SELECT * FROM tiers WHERE id = ?").bind(tierId).first();
  if (!existing) return jsonResponse({ error: "Tier not found." }, 404, env);

  const body = await readJsonBody(request);
  const name = body.name !== undefined ? String(body.name).trim() : existing.name;
  const maxExtraLocations = body.maxExtraLocations !== undefined ? body.maxExtraLocations : existing.max_extra_locations;
  if (!name) return jsonResponse({ error: "name cannot be empty." }, 400, env);
  if (typeof maxExtraLocations !== "number" || !Number.isInteger(maxExtraLocations) || maxExtraLocations < 0) {
    return jsonResponse({ error: "maxExtraLocations must be a whole number, zero or more." }, 400, env);
  }

  try {
    await env.DB.prepare("UPDATE tiers SET name = ?, max_extra_locations = ? WHERE id = ?")
      .bind(name, maxExtraLocations, tierId)
      .run();
  } catch (err) {
    return jsonResponse({ error: `A tier named "${name}" already exists.` }, 409, env);
  }
  const updated = await env.DB.prepare("SELECT * FROM tiers WHERE id = ?").bind(tierId).first();
  return jsonResponse(rowToTier(updated), 200, env);
}

/**
 * Blocks deleting a tier that any user is still assigned to, rather
 * than silently orphaning their tier_id (which handleTrackedCollection's
 * own lookup would then treat as "no tier" — zero extra locations,
 * probably not what anyone intended). Move affected users to a
 * different tier first (PUT /api/admin/users/:id) if a tier genuinely
 * needs retiring.
 */
async function handleAdminDeleteTier(env, tierId) {
  const inUse = await env.DB.prepare("SELECT COUNT(*) as n FROM users WHERE tier_id = ?").bind(tierId).first();
  if (inUse.n > 0) {
    return jsonResponse(
      { error: `Can't delete this tier — ${inUse.n} user${inUse.n === 1 ? " is" : "s are"} still assigned to it. Move them to a different tier first.` },
      409,
      env
    );
  }
  await env.DB.prepare("DELETE FROM tiers WHERE id = ?").bind(tierId).run();
  return new Response(null, { status: 204, headers: corsHeaders(env) });
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
 * outright, never silently downgraded to "act as yourself instead" —
 * UNLESS the caller opts in with `allowPublicRead` (only handed `true`
 * from a GET branch, by Groups/Mark Lists collection reads): then any
 * signed-in user may read (never write — callers only pass this for GET)
 * Public's own rows, same as Settings now shows them merged into your
 * own view, badged as Public's and not editable.
 */
function resolveEffectiveUserId(url, callerUser, { allowPublicRead = false } = {}) {
  const requested = url.searchParams.get("userId");
  if (!requested || requested === callerUser.id) return { id: callerUser.id };
  if (allowPublicRead && requested === PUBLIC_USER_ID) return { id: requested };
  if (callerUser.role !== "admin") {
    return { error: "Only Admin can act on another user's data." };
  }
  return { id: requested };
}

// The session id a request carries: `Authorization: Bearer <token>` (what the site sends, since the cookie
// can be blocked as third-party) or, failing that, the session cookie.
function readSessionId(request) {
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return bearer || readCookie(request, SESSION_COOKIE);
}

async function requireUser(request, env) {
  const sessionId = readSessionId(request);
  if (!sessionId || sessionId.startsWith(LOGIN_CODE_PREFIX)) return null; // a login code is only good for /auth/exchange
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
 * types at all to pick from (the type vocabulary is entirely per-user,
 * same as Public's; nothing seeds it automatically otherwise).
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
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS", // PATCH: renaming a home (/api/homes/:id)
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

// ---------------------------------------------------------------------
// Fishing Controller API (/api/controller/*) — see docs/Fishing Controller Design Brief.md, adapted to this site.
//
// A handheld Bluetooth controller talks to an Android app, which talks to these routes. Nothing here is a new data model:
// a controller trip/action/catch becomes the SAME marks and the SAME running-trip setting the website's own Live mode
// makes (Session Start/End and Catch marks; the `liveActiveTrip` preference), so it shows on the map, in Settings and in
// reports like everything else. The builders below are server copies of the browser ones (js/trip-defaults.js,
// js/live-cards.js, js/catch-limits.js) — tests/controller-parity.test.mjs runs both on the same inputs, so they can't drift.
//
// Auth: a per-user device token ("Bearer fc_…", created in Settings, stored only as a sha-256 hash, revocable). It is accepted
// ONLY here, never as a session, and — carrying no cookie and no Origin — is exempt from the CSRF guard in fetch().
// Events are idempotent: each (device, sequence number) is recorded in controller_events in the same batch as the marks it
// created, so replaying a batch never creates anything twice. The controller sends UTC epoch seconds plus its timezone offset;
// they're converted to the site's naive local "YYYY-MM-DD HH:MM:SS" here.
// ---------------------------------------------------------------------

const CONTROLLER_TOKEN_PREFIX = "fc_";
const LIVE_TRIP_PREF = "liveActiveTrip"; // same key as js/prefs.js / map-live.js
const CTL_RUN_GAP_MS = 8 * 3600000; // js/catch-limits.js CATCH_RUN_GAP_MS
const CTL_MAX_BATCH = 100;
// The free Cloudflare plan allows only 50 D1 queries per request, and one event takes up to ~12. So an events request stops taking new
// events once it has used this many and answers the rest "deferred" — the app simply leaves those pending and sends them next time.
const CTL_QUERY_BUDGET = 30;
const CTL_MAX_TRACK_POINTS = 200; // per request; at 14 rows per INSERT statement (D1 allows 100 bound values) that is at most 15 statements
const CTL_EVENT_TYPES = ["trip_start", "trip_end", "action_start", "action_end", "catch", "action_update", "rodsetup_update", "mark_update"];
// Defaults for the controller's number dials until they get a Settings page of their own.
const CTL_DEPTH_VALUES = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20];
const CTL_SIZE_DIAL = { min: 10, max: 120, step: 1, default: 30 };
const CTL_LIST_FIELDS = ["Species", "Berley", "Bait", "Fishing Method", "Water Condition", "Rod", "Rig", "Weather Condition", "Tide Condition", "Tide Extreme"];
const CTL_WIND_DIRECTIONS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]; // SHORE_OPTIONS (js/chart-base.js)

// --- pure helpers (copies of the browser's; see tests/controller-parity.test.mjs) ----------------------------------

function ctlUniq(list) {
  return [...new Set((list || []).filter((v) => v != null && String(v).trim() !== "").map((v) => String(v).trim()))];
}

/** The Rod Setups of an Action that still exist (a deleted one drops out) — tdLiveRodSetupIds. */
function ctlLiveRodSetupIds(ids, rodSetups) {
  const known = new Set((rodSetups || []).map((r) => r.id));
  return (ids || []).filter((id) => known.has(id));
}

/** The Session Start mark for a trip Action — buildSessionStartFromAction (js/trip-defaults.js), minus tide. */
function ctlBuildSessionStart(action, rodSetups, ctx) {
  const setups = (action.rodSetupIds || []).map((rid) => (rodSetups || []).find((r) => r.id === rid)).filter(Boolean);
  const mark = {
    id: ctx.id, lat: ctx.lat, lng: ctx.lng, name: `Session ${ctx.sessionNumber} Start`, type: "Session Start",
    dateTime: ctx.dateTime, createdAt: ctx.createdAt, source: ctx.source || "Manual", sessionRole: "start", sessionGroupId: ctx.sessionGroupId,
  };
  const set = (key, list) => {
    if (list.length) mark[key] = list.join(", ");
  };
  if (ctx.tripName) mark.tripName = ctx.tripName;
  if (action.name) mark.actionName = action.name;
  set("species", ctlUniq(action.species));
  set("fishingMethod", ctlUniq(action.fishingMethod));
  if (action.berley) mark.berley = action.berley;
  set("bait", ctlUniq(action.bait));
  set("rod", ctlUniq(setups.map((s) => s.rod)));
  set("rig", ctlUniq(setups.map((s) => s.rig)));
  set("rigOptions", ctlUniq(setups.flatMap((s) => s.subListItems || [])));
  if (ctx.water) mark.waterCondition = ctx.water;
  if (ctx.waterDepth != null) mark.waterDepth = ctx.waterDepth;
  return mark;
}

const CTL_SESSION_END_CARRIED_FIELDS = ["species", "waterCondition", "berley", "fishingMethod", "waterDepth", "rod", "rig", "bait", "rigOptions", "tideCondition", "tideExtreme", "tripName", "actionName"];

/** The Session End that closes `startMark` — buildSessionEndFromStart (js/live-cards.js). */
function ctlBuildSessionEnd(startMark, { id, lat, lng, dateTime, createdAt, source, water, waterDepth }, sessionNumber) {
  const mark = {
    id, lat, lng, name: `Session ${sessionNumber} End`, type: "Session End", dateTime, createdAt,
    source: source || "Manual", sessionRole: "end", sessionGroupId: startMark.sessionGroupId,
  };
  for (const key of CTL_SESSION_END_CARRIED_FIELDS) {
    if (startMark[key] != null && startMark[key] !== "") mark[key] = startMark[key];
  }
  // the conditions when it ended (the controller's current Water / Depth) win over the ones the session started with
  if (water) mark.waterCondition = water;
  if (waterDepth != null) mark.waterDepth = waterDepth;
  return mark;
}

/** The gear a Catch takes from a trip Action — tdCatchFieldsFromAction (js/trip-defaults.js). */
function ctlCatchFieldsFromAction(action, rodSetups, setupId, tripName) {
  const ids = ctlLiveRodSetupIds(action.rodSetupIds, rodSetups);
  const setup = (rodSetups || []).find((r) => r.id === (setupId || (ids.length === 1 ? ids[0] : null)));
  const out = {};
  if (tripName) out.tripName = tripName;
  if (action.name) out.actionName = action.name;
  if (action.berley) out.berley = action.berley;
  if ((action.fishingMethod || []).length) out.fishingMethod = action.fishingMethod.join(", ");
  if ((action.bait || []).length) out.bait = action.bait.join(", ");
  if (setup) {
    if (setup.rod) out.rod = setup.rod;
    if (setup.rig) out.rig = setup.rig;
    if ((setup.subListItems || []).length) out.rigOptions = setup.subListItems.join(", ");
  }
  return out;
}

/**
 * A Catch mark — what the Live +Catch flow saves on a trip (buildCatchFromCards + tdCatchFieldsFromAction, js/live-cards.js /
 * js/trip-defaults.js, as map-live.js's saveLiveCatch combines them), minus tide. `c`: {id, lat, lng, dateTime, species, size,
 * released, tooSmall, water, waterDepth, setupId, bait, source}; `bait` (the Bait question's answer; "" = none) replaces the
 * action's bait list, undefined keeps it; `action` may be null (a catch with no running action: no gear).
 */
function ctlBuildCatch(c, action, rodSetups) {
  const mark = { id: c.id, lat: c.lat, lng: c.lng, name: c.species, type: "Catch", dateTime: c.dateTime, createdAt: c.dateTime, source: c.source || "Manual", species: c.species };
  const cm = c.size === "" || c.size == null ? NaN : Number(c.size);
  if (Number.isFinite(cm) && !c.tooSmall) mark.size = cm;
  if (c.tooSmall) mark.notes = "Too small";
  if (c.released || c.tooSmall) mark.released = true;
  if (c.water) mark.waterCondition = c.water;
  if (action) {
    if (action.berley) mark.berley = action.berley;
    if (action.fishingMethod && action.fishingMethod.length) mark.fishingMethod = action.fishingMethod.join(", ");
  }
  if (c.waterDepth != null) mark.waterDepth = c.waterDepth;
  if (action) Object.assign(mark, ctlCatchFieldsFromAction(action, rodSetups, c.setupId, c.tripName));
  if (typeof c.bait === "string") {
    if (c.bait) mark.bait = c.bait;
    else delete mark.bait; // the Bait question was answered "none"
  }
  return mark;
}

/** The number in "Session 3 Start"/"Session 3 End", or null — sessionNumberFromName (js/catch-limits.js). */
function ctlSessionNumberFromName(name) {
  const m = /^Session (\d+) (?:Start|End)$/i.exec(String(name || "").trim());
  return m ? Number(m[1]) : null;
}

function ctlCatchChain(timesMs, anchorMs, gapMs = CTL_RUN_GAP_MS) {
  const real = timesMs.filter(Number.isFinite).sort((a, b) => a - b);
  const all = [...real, anchorMs].sort((a, b) => a - b);
  const i = all.indexOf(anchorMs);
  let a = i;
  while (a > 0 && all[a] - all[a - 1] <= gapMs) a--;
  let b = i;
  while (b < all.length - 1 && all[b + 1] - all[b] <= gapMs) b++;
  const chain = all.slice(a, b + 1);
  if (!real.includes(anchorMs)) chain.splice(chain.indexOf(anchorMs), 1);
  return chain.length ? { start: chain[0], end: chain[chain.length - 1] } : null;
}

/** The next "Session N" number — nextSessionNumber (js/catch-limits.js). `starts`: [{tMs, number}]. */
function ctlNextSessionNumber(starts, anchorMs, gapMs = CTL_RUN_GAP_MS) {
  const valid = (starts || []).filter((s) => s && Number.isFinite(s.tMs) && Number.isFinite(s.number));
  const chain = ctlCatchChain(valid.map((s) => s.tMs), anchorMs, gapMs);
  if (!chain) return 1;
  const inChain = valid.filter((s) => s.tMs <= anchorMs && s.tMs >= chain.start && s.tMs <= chain.end);
  return inChain.reduce((max, s) => Math.max(max, s.number), 0) + 1;
}

/** The site's naive local time string for UTC epoch seconds seen on a clock `tzOffsetMin` minutes east of UTC. */
function ctlNaiveFromEpoch(epochSec, tzOffsetMin) {
  const d = new Date((epochSec + (tzOffsetMin || 0) * 60) * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** parseNaive (js/chart-base.js): a naive "YYYY-MM-DD HH:MM:SS" as ms, treating it as UTC purely for arithmetic. */
function ctlParseNaive(text) {
  const m = String(text).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/** Every species for an Action's controller list: its own targets, then the trip's other targets, then the rest (the Catch cards' order). */
function ctlSpeciesOrder(action, actions, allSpecies) {
  const own = ctlUniq(action ? action.species : []);
  const seen = new Set(own);
  const others = [];
  for (const a of actions || []) {
    if (!action || a.tripId !== action.tripId || a.id === action.id) continue;
    for (const s of a.species || []) if (!seen.has(s)) (seen.add(s), others.push(s));
  }
  return [...own, ...others, ...allSpecies.filter((s) => !seen.has(s))];
}

// --- tokens --------------------------------------------------------------------------------------------------------

async function ctlSha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function ctlNewToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return CONTROLLER_TOKEN_PREFIX + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The user a "Bearer fc_…" device token belongs to, or null (unknown, malformed or revoked). Notes when it was last used. */
async function requireControllerUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token.startsWith(CONTROLLER_TOKEN_PREFIX)) return null;
  const hash = await ctlSha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT users.*, controller_tokens.id AS token_id, controller_tokens.last_used_at AS token_last_used FROM controller_tokens
     JOIN users ON users.id = controller_tokens.user_id
     WHERE controller_tokens.token_hash = ? AND controller_tokens.revoked_at IS NULL`
  ).bind(hash).first();
  if (!row) return null;
  const now = Date.now();
  if (!row.token_last_used || now - row.token_last_used > 60000) {
    await env.DB.prepare("UPDATE controller_tokens SET last_used_at = ? WHERE id = ?").bind(now, row.token_id).run();
  }
  return row;
}

async function handleControllerTokens(request, url, env, tokenId) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  if (request.method === "GET" && !tokenId) {
    const { results } = await env.DB.prepare("SELECT id, name, created_at, last_used_at, revoked_at FROM controller_tokens WHERE user_id = ? ORDER BY created_at DESC").bind(user.id).all();
    return jsonResponse(results.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at ?? null, revokedAt: r.revoked_at ?? null })), 200, env);
  }
  if (request.method === "POST" && !tokenId) {
    const body = await readJsonBody(request);
    const name = body && typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 60) return jsonResponse({ error: "name is required (up to 60 characters)." }, 400, env);
    const token = ctlNewToken();
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO controller_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, user.id, name, await ctlSha256Hex(token), Date.now())
      .run();
    return jsonResponse({ id, name, token }, 201, env); // the only time the token itself is ever shown
  }
  if (request.method === "DELETE" && tokenId) {
    await env.DB.prepare("UPDATE controller_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").bind(Date.now(), tokenId, user.id).run();
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }
  return jsonResponse({ error: "Method not allowed." }, 405, env);
}

// --- config and state ----------------------------------------------------------------------------------------------

/** The running trip as stored in prefs: {tripId, actionId?, sessionGroupId?}, tripId null when there isn't one. */
function ctlParseState(text) {
  try {
    const s = JSON.parse(text);
    return s && typeof s === "object" && typeof s.tripId === "string" && s.tripId ? s : { tripId: null };
  } catch {
    return { tripId: null };
  }
}

async function ctlReadState(env, uid) {
  const row = await env.DB.prepare("SELECT value FROM user_prefs WHERE user_id = ? AND key = ?").bind(uid, LIVE_TRIP_PREF).first();
  return ctlParseState(row ? row.value : null);
}

function ctlWriteStateStatement(env, uid, state) {
  const value = JSON.stringify(state && state.tripId ? state : { tripId: null });
  return env.DB.prepare(
    `INSERT INTO user_prefs (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(uid, LIVE_TRIP_PREF, value, Date.now());
}

async function ctlLoadTripData(env, uid) {
  const [trips, actions, rods] = await Promise.all([
    env.DB.prepare("SELECT * FROM user_trip_setups WHERE user_id = ? ORDER BY name ASC").bind(uid).all(),
    env.DB.prepare("SELECT * FROM user_trip_actions WHERE user_id = ?").bind(uid).all(),
    env.DB.prepare("SELECT * FROM user_rod_setups WHERE user_id = ? ORDER BY name ASC").bind(uid).all(),
  ]);
  return { trips: trips.results.map(rowToTripSetup), actions: actions.results.map(rowToTripAction), rodSetups: rods.results.map(rowToRodSetup) };
}

/** Every value of the pick-lists a controller edit may choose from (your own plus Public's): {field: Set of values}. */
async function ctlListValues(env, uid) {
  const { results } = await env.DB.prepare(
    "SELECT field, value FROM user_mark_lists WHERE user_id IN (?, ?) AND field IN ('Species', 'Berley', 'Bait', 'Fishing Method', 'Water Condition', 'Rod', 'Rig', 'Weather Condition', 'Tide Condition', 'Tide Extreme')"
  ).bind(uid, PUBLIC_USER_ID).all();
  const out = {};
  for (const r of results) (out[r.field] ||= new Set()).add(r.value);
  return out;
}

/** A rig's options: its own Sub List, else your private one on a Public rig (nothing when it has none). */
async function ctlRigOptions(env, uid, rigName) {
  const rows = (await env.DB.prepare("SELECT id, user_id, has_sublist, sub_list FROM user_mark_lists WHERE field = 'Rig' AND value = ? AND user_id IN (?, ?)").bind(rigName, uid, PUBLIC_USER_ID).all()).results;
  const row = rows.find((r) => r.user_id === uid) || rows[0]; // your own row wins over Public's
  if (!row) return [];
  if (row.has_sublist) return parseSubList(row.sub_list);
  const o = await env.DB.prepare("SELECT sub_list FROM user_rig_sublist_overrides WHERE user_id = ? AND rig_id = ?").bind(uid, row.id).first();
  return o ? parseSubList(o.sub_list) : [];
}

/** A list of non-empty names, trimmed and without repeats — or null when `v` isn't one. */
function ctlNameList(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim()) ? [...new Set(v.map((x) => x.trim()))] : null;
}

const ctlJsonOrNull = (list) => (list && list.length ? JSON.stringify(list) : null);

/** The UPDATE for an `action_update` event: {actionId, fishingMethod?, berley?, bait?, targets?, rodSetupIds?}. Only existing values may be chosen. */
async function ctlActionUpdateStatements(env, uid, ev) {
  const row = typeof ev.actionId === "string" ? await env.DB.prepare("SELECT a.*, t.name AS trip_name FROM user_trip_actions a LEFT JOIN user_trip_setups t ON t.id = a.trip_id WHERE a.id = ? AND a.user_id = ?").bind(ev.actionId, uid).first() : null;
  if (!row) return { error: "action not found" };
  const cur = rowToTripAction(row);
  const next = { fishingMethod: cur.fishingMethod, berley: cur.berley || null, bait: cur.bait, species: cur.species, rodSetupIds: cur.rodSetupIds };
  const lists = await ctlListValues(env, uid);
  let changed = false;
  const pick = (key, field, column, label) => {
    if (ev[key] === undefined) return null;
    const values = ctlNameList(ev[key]);
    if (!values) return `${key} must be a list of names`;
    const unknown = values.find((v) => !(lists[field] && lists[field].has(v)));
    if (unknown) return `"${unknown}" is not one of your ${label} options`;
    next[column] = values;
    changed = true;
    return null;
  };
  const problem = pick("fishingMethod", "Fishing Method", "fishingMethod", "fishing method") || pick("bait", "Bait", "bait", "bait") || pick("targets", "Species", "species", "species");
  if (problem) return { error: problem };
  if (ev.berley !== undefined) {
    if (ev.berley !== null && typeof ev.berley !== "string") return { error: "berley must be text (empty to clear it)" };
    const b = (ev.berley || "").trim();
    if (b && !(lists.Berley && lists.Berley.has(b))) return { error: `"${b}" is not one of your berley options` };
    next.berley = b || null;
    changed = true;
  }
  if (ev.rodSetupIds !== undefined) {
    const ids = ctlNameList(ev.rodSetupIds);
    if (!ids) return { error: "rodSetupIds must be a list of rod setup ids" };
    const known = new Set((await env.DB.prepare("SELECT id FROM user_rod_setups WHERE user_id = ?").bind(uid).all()).results.map((r) => r.id));
    const stranger = ids.find((id) => !known.has(id));
    if (stranger) return { error: "a rod setup in that list isn't yours" };
    next.rodSetupIds = ids;
    changed = true;
  }
  if (!changed) return { error: "nothing to change" };
  return {
    stmts: [
      env.DB.prepare("UPDATE user_trip_actions SET fishing_method = ?, berley = ?, bait = ?, rod_setup_ids = ?, species = ? WHERE id = ? AND user_id = ?")
        .bind(ctlJsonOrNull(next.fishingMethod), next.berley, ctlJsonOrNull(next.bait), ctlJsonOrNull(next.rodSetupIds), ctlJsonOrNull(next.species), cur.id, uid),
    ],
  };
}

/** The UPDATE for a `rodsetup_update` event: {rodSetupId, rod?, rig?, subListItems?}. Changing the rig clears its options unless new ones are given (as on the website). */
async function ctlRodSetupUpdateStatements(env, uid, ev) {
  const row = typeof ev.rodSetupId === "string" ? await env.DB.prepare("SELECT * FROM user_rod_setups WHERE id = ? AND user_id = ?").bind(ev.rodSetupId, uid).first() : null;
  if (!row) return { error: "rod setup not found" };
  const cur = rowToRodSetup(row);
  const next = { rod: cur.rod || null, rig: cur.rig || null, subListItems: cur.subListItems };
  const lists = await ctlListValues(env, uid);
  let changed = false;
  for (const [key, field] of [["rod", "Rod"], ["rig", "Rig"]]) {
    if (ev[key] === undefined) continue;
    if (ev[key] !== null && typeof ev[key] !== "string") return { error: `${key} must be text (empty to clear it)` };
    const v = (ev[key] || "").trim();
    if (v && !(lists[field] && lists[field].has(v))) return { error: `"${v}" is not one of your ${key} options` };
    if (key === "rig" && (v || null) !== next.rig && ev.subListItems === undefined) next.subListItems = [];
    next[key] = v || null;
    changed = true;
  }
  if (ev.subListItems !== undefined) {
    const items = ctlNameList(ev.subListItems);
    if (!items) return { error: "subListItems must be a list of option names" };
    if (items.length) {
      const options = next.rig ? await ctlRigOptions(env, uid, next.rig) : [];
      const bad = items.find((i) => !options.includes(i));
      if (bad) return { error: `"${bad}" is not an option of ${next.rig || "a rig"}` };
    }
    next.subListItems = items;
    changed = true;
  }
  if (!changed) return { error: "nothing to change" };
  return {
    stmts: [env.DB.prepare("UPDATE user_rod_setups SET rod = ?, rig = ?, sub_list_items = ? WHERE id = ? AND user_id = ?").bind(next.rod, next.rig, ctlJsonOrNull(next.subListItems), cur.id, uid)],
  };
}

async function ctlLoadRodSetups(env, uid) {
  const { results } = await env.DB.prepare("SELECT * FROM user_rod_setups WHERE user_id = ? ORDER BY name ASC").bind(uid).all();
  return results.map(rowToRodSetup);
}

// Fields a `mark_update` may change: key -> [column, kind, list or limits]. Type, GPS and Source are deliberately not editable from the controller.
const CTL_MARK_LIST_FIELDS = {
  species: ["species", "Species"], bait: ["bait", "Bait"], rig: ["rig", "Rig"], rod: ["rod", "Rod"], berley: ["berley", "Berley"],
  fishingMethod: ["fishing_method", "Fishing Method"], weatherCondition: ["weather_condition", "Weather Condition"],
  tideCondition: ["tide_condition", "Tide Condition"], tideExtreme: ["tide_extreme", "Tide Extreme"], waterCondition: ["water_condition", "Water Condition"],
};
const CTL_MARK_SINGLE_FIELDS = new Set(["species", "weatherCondition", "tideCondition", "tideExtreme", "waterCondition"]); // one value even on a Session
const CTL_MARK_NUMBER_FIELDS = {
  size: ["size", 0, 1000], waterDepth: ["water_depth", 0, 1000], barometer: ["barometer", 800, 1200], temperature: ["temperature", -50, 60],
  waterTemperature: ["water_temperature", -5, 50], windSpeed: ["wind_speed", 0, 400],
};

/**
 * The UPDATE for a `mark_update` event: {markId, changes: {name?, dateTime?, species?, size?, released?, notes?, <pick-lists>, rigOptions?, ...}}.
 * Only marks the controller made, and only values that already exist in your lists (no creating), as with action_update.
 */
async function ctlMarkUpdateStatements(env, uid, ev) {
  const row = typeof ev.markId === "string" ? await env.DB.prepare("SELECT * FROM marks WHERE id = ? AND user_id = ? AND source = 'Controller'").bind(ev.markId, uid).first() : null;
  if (!row) return { error: "mark not found" };
  const ch = ev.changes;
  if (!ch || typeof ch !== "object" || Array.isArray(ch)) return { error: "changes must be an object" };
  const isSession = row.type === "Session Start" || row.type === "Session End";
  if (!isSession && row.type !== "Catch") return { error: "only Catch and Session marks can be edited here" };
  const sets = {}; // column -> value
  const lists = await ctlListValues(env, uid);
  const keys = Object.keys(ch);
  if (!keys.length) return { error: "nothing to change" };
  let rigsNow = ctlUniq((row.rig || "").split(","));
  for (const key of keys) {
    const v = ch[key];
    if (CTL_MARK_LIST_FIELDS[key]) {
      const [column, field] = CTL_MARK_LIST_FIELDS[key];
      const values = v === null ? [] : ctlNameList(Array.isArray(v) ? v : typeof v === "string" ? (v.trim() ? [v] : []) : null);
      if (!values) return { error: `${key} must be a name or a list of names` };
      if (values.length > 1 && (CTL_MARK_SINGLE_FIELDS.has(key) || (!isSession && key === "rig"))) return { error: `${key} takes one value` };
      const unknown = values.find((x) => !(lists[field] && lists[field].has(x)));
      if (unknown) return { error: `"${unknown}" is not one of your ${field} options` };
      sets[column] = values.length ? values.join(", ") : null;
      if (key === "rig") {
        rigsNow = values;
        if (ch.rigOptions === undefined) sets.rig_options = null; // changing the rig clears its options, like the site
      }
      if (key === "species" && !isSession) sets.name = values[0] || row.name; // a Catch is named after its species
    } else if (CTL_MARK_NUMBER_FIELDS[key]) {
      if (isSession && (key === "size")) return { error: "a Session has no size" };
      const [column, min, max] = CTL_MARK_NUMBER_FIELDS[key];
      if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)) return { error: `${key} must be a number from ${min} to ${max}` };
      sets[column] = v === null ? null : key === "size" ? Math.round(v) : v;
    } else if (key === "windDirection") {
      if (v !== null && !CTL_WIND_DIRECTIONS.includes(v)) return { error: "windDirection must be a compass point" };
      sets.wind_direction = v;
    } else if (key === "released") {
      if (isSession) return { error: "a Session has no released flag" };
      if (typeof v !== "boolean") return { error: "released must be true or false" };
      sets.released = v ? 1 : 0;
    } else if (key === "tripName" || key === "actionName") {
      // the controller picks from the trips / actions you already have (a dial has no text entry); null clears it
      if (v !== null && typeof v !== "string") return { error: `${key} must be text (null to clear it)` };
      const t = (v || "").trim();
      if (t) {
        const table = key === "tripName" ? "user_trip_setups" : "user_trip_actions";
        const known = await env.DB.prepare(`SELECT 1 AS ok FROM ${table} WHERE user_id = ? AND name = ? LIMIT 1`).bind(uid, t).first();
        if (!known) return { error: `"${t}" is not one of your ${key === "tripName" ? "trips" : "actions"}` };
      }
      sets[key === "tripName" ? "trip_name" : "action_name"] = t || null;
    } else if (key === "notes" || key === "name") {
      if (v !== null && typeof v !== "string") return { error: `${key} must be text` };
      const t = (v || "").trim();
      if (t.length > (key === "name" ? 100 : 2000)) return { error: `${key} is too long` };
      if (key === "name" && !t) return { error: "name can't be empty" };
      sets[key] = t || null;
    } else if (key === "dateTime") {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) || ctlParseNaive(v) == null) return { error: "dateTime must be YYYY-MM-DD HH:MM:SS" };
      sets.date_time = v;
    } else if (key !== "rigOptions") {
      return { error: `${key} can't be edited` };
    }
  }
  if (ch.rigOptions !== undefined) {
    const items = ch.rigOptions === null ? [] : ctlNameList(ch.rigOptions);
    if (!items) return { error: "rigOptions must be a list of option names" };
    if (items.length) {
      const options = new Set();
      for (const rig of rigsNow) for (const o of await ctlRigOptions(env, uid, rig)) options.add(o);
      const stranger = items.find((i) => !options.has(i));
      if (stranger) return { error: `"${stranger}" is not an option of the chosen rig` };
    }
    sets.rig_options = items.length ? items.join(", ") : null;
  }
  const cols = Object.keys(sets);
  if (!cols.length) return { error: "nothing to change" };
  return {
    stmts: [env.DB.prepare(`UPDATE marks SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND user_id = ?`).bind(...cols.map((c) => sets[c]), row.id, uid)],
  };
}

/** Everything the controller's phone app needs to offer choices: your trips, their actions, rod setups and the pick-lists, plus the running trip. */
async function ctlBuildConfig(env, user) {
  const { trips, actions, rodSetups } = await ctlLoadTripData(env, user.id);
  const { results } = await env.DB.prepare(
    `SELECT id, field, value, user_id, min_size, max_size, max_qty, big_max_qty, big_size, qty_group, has_sublist, sub_list, image_index, option_images FROM user_mark_lists
     WHERE user_id IN (?, ?) AND field IN (${CTL_LIST_FIELDS.map(() => "?").join(", ")}) ORDER BY field, value`
  ).bind(user.id, PUBLIC_USER_ID, ...CTL_LIST_FIELDS).all();
  const overrides = await env.DB.prepare("SELECT rig_id, sub_list, option_images FROM user_rig_sublist_overrides WHERE user_id = ?").bind(user.id).all();
  const overrideByRig = new Map(overrides.results.map((o) => [o.rig_id, parseSubList(o.sub_list)]));
  const overrideImagesByRig = new Map(overrides.results.map((o) => [o.rig_id, parseOptionImages(o.option_images)]));
  const byField = {};
  const seen = new Set();
  // Your own rows win over Public's on a clash, same as the site's merged lists.
  for (const row of [...results.filter((r) => r.user_id === user.id), ...results.filter((r) => r.user_id !== user.id)]) {
    const key = `${row.field}|${row.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (byField[row.field] ||= []).push(row);
  }
  const names = (field) => (byField[field] || []).map((r) => r.value).sort((a, b) => a.localeCompare(b));
  const allSpecies = (byField.Species || []).map((r) => r.value);
  const limits = Object.fromEntries(
    (byField.Species || []).map((r) => [r.value, { minSize: r.min_size ?? null, maxSize: r.max_size ?? null, maxQty: r.max_qty ?? null, bigSize: r.big_size ?? null, bigMaxQty: r.big_max_qty ?? null, qtyGroup: r.qty_group ?? null }])
  );
  // The first picture of each value that has one (the controller shows it full screen as you scroll the options): {field: {value: {id, v}}}.
  // The bytes are the site's public picture route (/api/public/species-image/<id>?v=<v>).
  const firstImage = (list) => (list && list.length ? { id: list[0].id, v: list[0].v ?? null } : null);
  const images = {};
  for (const field of ["Species", "Bait", "Rig", "Rod", "Berley", "Fishing Method"]) {
    for (const row of byField[field] || []) {
      const img = firstImage(parseImageIndex(row.image_index));
      if (img) (images[field] ||= {})[row.value] = img;
    }
  }
  // A rig's sub-list options have pictures of their own (your private override of a Public rig wins for an option it has pictures for).
  const rigOptionImages = (row) => {
    const own = parseOptionImages(row.option_images);
    const priv = overrideImagesByRig.get(row.id) || {};
    return Object.fromEntries([...new Set([...Object.keys(own), ...Object.keys(priv)])].map((o) => [o, firstImage(priv[o] || own[o])]).filter(([, img]) => img));
  };
  const config = {
    trips: trips.map((t) => ({ id: t.id, name: t.name })),
    actions: actions.map((a) => ({
      id: a.id,
      tripId: a.tripId,
      name: a.name,
      rodSetupIds: ctlLiveRodSetupIds(a.rodSetupIds, rodSetups),
      species: ctlSpeciesOrder(a, actions, allSpecies),
      // what the controller's "Modify defaults" shows and edits (the website's Trip Defaults): this action's own choices
      fishingMethod: a.fishingMethod,
      berley: a.berley || "",
      bait: a.bait,
      targets: a.species,
    })),
    rodSetups: rodSetups.map((r) => ({ id: r.id, name: r.name, rod: r.rod, rig: r.rig, subListItems: r.subListItems })),
    rods: names("Rod"),
    // A rig's options: its own Sub List, else your private one on a Public rig (same rule as the website's tdRigSublist).
    rigs: (byField.Rig || []).map((r) => ({ name: r.value, options: r.has_sublist ? parseSubList(r.sub_list) : overrideByRig.get(r.id) || [], optionImages: rigOptionImages(r) })).sort((a, b) => a.name.localeCompare(b.name)),
    images,
    species: allSpecies,
    limits,
    berley: names("Berley"),
    bait: names("Bait"),
    fishingMethod: names("Fishing Method"),
    waterCondition: names("Water Condition"),
    weatherCondition: names("Weather Condition"),
    tideCondition: names("Tide Condition"),
    tideExtreme: names("Tide Extreme"),
    windDirections: CTL_WIND_DIRECTIONS,
    depthValues: CTL_DEPTH_VALUES,
    sizeDial: CTL_SIZE_DIAL,
  };
  const configVersion = (await ctlSha256Hex(JSON.stringify(config))).slice(0, 16);
  return { configVersion, ...config, state: await ctlReadState(env, user.id), userId: user.id }; // userId: the controller graph shows Public locations plus yours
}

// --- events --------------------------------------------------------------------------------------------------------

function ctlNewId(prefix = "m") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; // same shape as makeMarkId (js/backend.js)
}

/** The running session: the user's latest Session Start with no Session End sharing its group id (liveActiveSession, map-live.js). */
async function ctlActiveSession(env, uid) {
  const row = await env.DB.prepare("SELECT * FROM marks WHERE user_id = ? AND type = 'Session Start' ORDER BY date_time DESC LIMIT 1").bind(uid).first();
  if (!row || !row.session_group_id) return null;
  const ended = await env.DB.prepare("SELECT 1 AS ok FROM marks WHERE user_id = ? AND type = 'Session End' AND session_group_id = ? LIMIT 1").bind(uid, row.session_group_id).first();
  if (ended) return null;
  const mark = rowToMark(row);
  const number = ctlSessionNumberFromName(mark.name);
  return number == null ? null : { mark, number };
}

/** The numbers of Session Starts in the last week, for naming the next one. */
async function ctlRecentStarts(env, uid, anchorNaive) {
  const { results } = await env.DB.prepare("SELECT name, date_time FROM marks WHERE user_id = ? AND type = 'Session Start' AND date_time >= ? ORDER BY date_time ASC")
    .bind(uid, ctlNaiveFromEpoch(ctlParseNaive(anchorNaive) / 1000 - 7 * 86400, 0)).all();
  const out = [];
  for (const r of results) {
    const number = ctlSessionNumberFromName(r.name);
    const tMs = ctlParseNaive(r.date_time);
    if (number != null && Number.isFinite(tMs)) out.push({ tMs, number });
  }
  return out;
}

/**
 * Applies ONE event: returns {status, markIds, error?}. Everything it changes (marks, the running-trip setting and the
 * "this event was processed" record) goes in one batch, so a retry after a failure can't half-apply it.
 */
async function ctlProcessEvent(env, user, ev) {
  const bad = (error) => ({ seq: ev && ev.seq, status: "rejected", error });
  if (!ev || typeof ev !== "object") return bad("not an event");
  if (typeof ev.deviceId !== "string" || !ev.deviceId.trim() || ev.deviceId.length > 64) return bad("deviceId is required");
  if (!Number.isInteger(ev.seq) || ev.seq < 0) return bad("seq must be a whole number");
  if (!CTL_EVENT_TYPES.includes(ev.type)) return bad("unknown type");
  if (typeof ev.ts !== "number" || !Number.isFinite(ev.ts) || ev.ts <= 0) return bad("ts must be UTC epoch seconds");
  const tz = ev.tzOffsetMin == null ? 0 : ev.tzOffsetMin;
  if (typeof tz !== "number" || !Number.isFinite(tz) || Math.abs(tz) > 840) return bad("tzOffsetMin is out of range");
  const uid = user.id;
  const deviceId = ev.deviceId.trim();

  const done = await env.DB.prepare("SELECT 1 AS ok FROM controller_events WHERE user_id = ? AND device_id = ? AND seq = ?").bind(uid, deviceId, ev.seq).first();
  if (done) return { seq: ev.seq, status: "duplicate", markIds: [] };

  const dateTime = ctlNaiveFromEpoch(ev.ts, tz);
  const havePosition = typeof ev.lat === "number" && typeof ev.lng === "number" && Math.abs(ev.lat) <= 90 && Math.abs(ev.lng) <= 180;
  const source = "Controller";
  const stmts = [];
  const markIds = [];
  const now = Date.now();
  const addMark = (mark, suffix = "") => {
    markIds.push(mark.id);
    stmts.push(markInsertStatement(env, mark.id, uid, { ...mark, sourceUuid: `fc:${deviceId}:${ev.seq}${suffix}`, tripRunId }, now));
  };
  const state = await ctlReadState(env, uid);
  // a trip started on the site has no run id: its first action gets one, so its marks still list on the log
  const tripRunId = state.runId || (state.tripId ? ctlNewId("run") : null);
  const position = { lat: ev.lat, lng: ev.lng };

  // Ends whatever session is running, at this event's time and place.
  // the water condition / depth the controller currently has set: on Session Start, Session End and Catch marks
  const evWater = typeof ev.water === "string" ? ev.water : "";
  const evDepth = typeof ev.depth === "number" && Number.isFinite(ev.depth) && ev.depth >= 0 && ev.depth <= 1000 ? ev.depth : null;
  const closeRunning = async () => {
    const active = await ctlActiveSession(env, uid);
    if (!active) return null;
    if (!havePosition) return { error: "a position is needed to end the running session" };
    addMark(ctlBuildSessionEnd(active.mark, { id: ctlNewId(), ...position, dateTime, createdAt: dateTime, source, water: evWater, waterDepth: evDepth }, active.number), ":end");
    return { ended: true };
  };

  let nextState = null; // set when the running trip changes
  if (ev.type === "trip_start") {
    const trip = typeof ev.tripId === "string" ? await env.DB.prepare("SELECT id FROM user_trip_setups WHERE id = ? AND user_id = ?").bind(ev.tripId, uid).first() : null;
    if (!trip) return bad("trip not found");
    nextState = { tripId: trip.id, runId: ctlNewId("run") }; // the run id stamps every mark this trip makes (the controller's log lists them)
  } else if (ev.type === "trip_end") {
    // Like the site's End Trip: closes the session this trip's action started (if still running), then clears the trip.
    if (state.sessionGroupId) {
      const active = await ctlActiveSession(env, uid);
      if (active && active.mark.sessionGroupId === state.sessionGroupId) {
        const closed = await closeRunning();
        if (closed && closed.error) return bad(closed.error);
      }
    }
    nextState = { tripId: null };
  } else if (ev.type === "action_start") {
    if (!havePosition) return bad("lat/lng are required");
    const row = typeof ev.actionId === "string" ? await env.DB.prepare("SELECT a.*, t.name AS trip_name FROM user_trip_actions a LEFT JOIN user_trip_setups t ON t.id = a.trip_id WHERE a.id = ? AND a.user_id = ?").bind(ev.actionId, uid).first() : null;
    if (!row) return bad("action not found");
    const action = rowToTripAction(row);
    const rodSetups = await ctlLoadRodSetups(env, uid);
    const closed = await closeRunning(); // starting an action ends the running one first, like tapping another action pill
    if (closed && closed.error) return bad(closed.error);
    const anchorMs = ctlParseNaive(dateTime);
    const sessionNumber = ctlNextSessionNumber(await ctlRecentStarts(env, uid, dateTime), anchorMs);
    const sessionGroupId = ctlNewId();
    addMark(ctlBuildSessionStart(action, rodSetups, {
      id: ctlNewId(), ...position, dateTime, createdAt: dateTime, sessionGroupId, sessionNumber, source,
      water: evWater, waterDepth: evDepth, tripName: row.trip_name || "",
    }), ":start");
    nextState = { tripId: action.tripId, actionId: action.id, sessionGroupId, runId: tripRunId };
  } else if (ev.type === "action_end") {
    const closed = await closeRunning();
    if (closed && closed.error) return bad(closed.error);
    nextState = { tripId: state.tripId, ...(state.runId ? { runId: state.runId } : {}) };
  } else if (ev.type === "catch") {
    if (!havePosition) return bad("lat/lng are required");
    if (typeof ev.species !== "string" || !ev.species.trim()) return bad("species is required");
    if (ev.size != null && (typeof ev.size !== "number" || !Number.isFinite(ev.size) || ev.size < 0 || ev.size > 1000)) return bad("size must be a number of cm");
    if (ev.depth != null && (typeof ev.depth !== "number" || !Number.isFinite(ev.depth) || ev.depth < 0 || ev.depth > 1000)) return bad("depth must be a number of metres");
    // the bait used (the controller's last catch question): a list of names; [] = none; absent = keep the action's bait
    const catchBait = ev.bait == null ? null : ctlNameList(ev.bait);
    if (ev.bait != null && (!catchBait || catchBait.length > 10)) return bad("bait must be a list of names");
    let action = null;
    let tripName = "";
    let rodSetups = [];
    if (typeof ev.actionId === "string") {
      const row = await env.DB.prepare("SELECT a.*, t.name AS trip_name FROM user_trip_actions a LEFT JOIN user_trip_setups t ON t.id = a.trip_id WHERE a.id = ? AND a.user_id = ?").bind(ev.actionId, uid).first();
      if (row) {
        action = rowToTripAction(row);
        tripName = row.trip_name || "";
        rodSetups = await ctlLoadRodSetups(env, uid);
      }
    }
    addMark(
      ctlBuildCatch(
        {
          id: ctlNewId(), ...position, dateTime, species: ev.species.trim(), size: ev.size ?? null, released: ev.fate === "release", tooSmall: !!ev.tooSmall,
          water: typeof ev.water === "string" ? ev.water : "", waterDepth: ev.depth ?? null, setupId: typeof ev.rodSetupId === "string" ? ev.rodSetupId : null, source, tripName,
          bait: catchBait ? catchBait.join(", ") : undefined,
        },
        action,
        rodSetups
      )
    );
  }

  // Edits made on the controller's "Modify defaults" screens: they change the website's Trip Defaults (an Action, a Rod Setup) and
  // may only choose values that already exist.
  if (ev.type === "action_update" || ev.type === "rodsetup_update") {
    const edit = ev.type === "action_update" ? await ctlActionUpdateStatements(env, uid, ev) : await ctlRodSetupUpdateStatements(env, uid, ev);
    if (edit.error) return bad(edit.error);
    stmts.push(...edit.stmts);
  }

  if (ev.type === "mark_update") {
    const edit = await ctlMarkUpdateStatements(env, uid, ev);
    if (edit.error) return bad(edit.error);
    stmts.push(...edit.stmts);
  }

  if (nextState) stmts.push(ctlWriteStateStatement(env, uid, nextState));
  stmts.push(env.DB.prepare("INSERT INTO controller_events (user_id, device_id, seq, type, received_at) VALUES (?, ?, ?, ?, ?)").bind(uid, deviceId, ev.seq, ev.type, now));
  await env.DB.batch(stmts);
  return { seq: ev.seq, status: "created", markIds };
}

// --- GPS track (controller_track): the phone's position every ~20 s while a trip runs -------------------------------------

/**
 * POST /api/controller/track (device token): {deviceId, tripId?, points: [{ts, lat, lng, acc?}]}. Idempotent on (user, device, ts), so
 * a batch whose answer was lost can simply be sent again. Answers {saved, duplicates}.
 */
async function handleControllerTrackWrite(request, env, user) {
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object") return jsonResponse({ error: "Request body must be a JSON object." }, 400, env);
  const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
  if (!deviceId || deviceId.length > 64) return jsonResponse({ error: "deviceId is required." }, 400, env);
  const tripId = body.tripId == null ? null : typeof body.tripId === "string" && body.tripId.length <= 64 ? body.tripId : undefined;
  if (tripId === undefined) return jsonResponse({ error: "tripId must be text up to 64 characters." }, 400, env);
  const points = body.points;
  if (!Array.isArray(points) || points.length === 0 || points.length > CTL_MAX_TRACK_POINTS) return jsonResponse({ error: `points must be a list of 1 to ${CTL_MAX_TRACK_POINTS}.` }, 400, env);
  for (const p of points) {
    const ok = p && Number.isInteger(p.ts) && p.ts > 0 && typeof p.lat === "number" && Math.abs(p.lat) <= 90 && typeof p.lng === "number" && Math.abs(p.lng) <= 180 &&
      (p.acc == null || (typeof p.acc === "number" && Number.isFinite(p.acc) && p.acc >= 0 && p.acc <= 100000));
    if (!ok) return jsonResponse({ error: "Each point needs ts (UTC epoch seconds), lat, lng and optionally acc." }, 400, env);
  }
  const stmts = [];
  for (let i = 0; i < points.length; i += 14) {
    const chunk = points.slice(i, i + 14);
    stmts.push(
      env.DB.prepare(`INSERT OR IGNORE INTO controller_track (user_id, device_id, ts, lat, lng, acc, trip_id) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")}`).bind(
        ...chunk.flatMap((p) => [user.id, deviceId, p.ts, p.lat, p.lng, p.acc ?? null, tripId])
      )
    );
  }
  const out = await env.DB.batch(stmts);
  const saved = out.reduce((n, r) => n + ((r && r.meta && r.meta.changes) || 0), 0);
  return jsonResponse({ saved, duplicates: points.length - saved }, 200, env);
}

/** GET /api/controller/track?from=<epoch s>&to=<epoch s>[&tripId=] (signed-in site visitor): your own track points in that window, oldest first. */
async function handleControllerTrackRead(request, url, env) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ error: "Not signed in." }, 401, env);
  const from = Number(url.searchParams.get("from"));
  const to = Number(url.searchParams.get("to"));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 31 * 86400) return jsonResponse({ error: "from and to (UTC epoch seconds, at most 31 days apart) are required." }, 400, env);
  const tripId = url.searchParams.get("tripId");
  const { results } = await env.DB.prepare(
    `SELECT device_id, ts, lat, lng, acc, trip_id FROM controller_track WHERE user_id = ? AND ts BETWEEN ? AND ?${tripId ? " AND trip_id = ?" : ""} ORDER BY ts ASC LIMIT 20000`
  ).bind(user.id, from, to, ...(tripId ? [tripId] : [])).all();
  return jsonResponse(results.map((r) => ({ deviceId: r.device_id, ts: r.ts, lat: r.lat, lng: r.lng, acc: r.acc ?? null, tripId: r.trip_id ?? null })), 200, env);
}

async function handleControllerApi(request, url, env) {
  const tokenMatch = url.pathname.match(/^\/api\/controller\/tokens(?:\/([^/]+))?$/);
  if (tokenMatch) return handleControllerTokens(request, url, env, tokenMatch[1]);

  if (url.pathname === "/api/controller/track" && request.method === "GET") return handleControllerTrackRead(request, url, env);

  const user = await requireControllerUser(request, env);
  if (!user) return jsonResponse({ error: "Invalid or revoked controller token." }, 401, env);

  if (url.pathname === "/api/controller/track" && request.method === "POST") return handleControllerTrackWrite(request, env, user);

  if (url.pathname === "/api/controller/config" && request.method === "GET") {
    return jsonResponse(await ctlBuildConfig(env, user), 200, env);
  }
  if (url.pathname === "/api/controller/state") {
    if (request.method === "GET") return jsonResponse(await ctlReadState(env, user.id), 200, env);
    if (request.method === "PUT") {
      const body = await readJsonBody(request);
      if (!body || typeof body !== "object") return jsonResponse({ error: "Request body must be a JSON object." }, 400, env);
      if (body.tripId === null || body.tripId === undefined) {
        await ctlWriteStateStatement(env, user.id, { tripId: null }).run();
        return jsonResponse({ tripId: null }, 200, env);
      }
      const trip = typeof body.tripId === "string" ? await env.DB.prepare("SELECT id FROM user_trip_setups WHERE id = ? AND user_id = ?").bind(body.tripId, user.id).first() : null;
      if (!trip) return jsonResponse({ error: "Trip not found." }, 404, env);
      const next = { tripId: trip.id };
      if (typeof body.actionId === "string" && typeof body.sessionGroupId === "string") Object.assign(next, { actionId: body.actionId, sessionGroupId: body.sessionGroupId });
      if (typeof body.runId === "string" && body.runId) next.runId = body.runId;
      await ctlWriteStateStatement(env, user.id, next).run();
      return jsonResponse(next, 200, env);
    }
  }
  if (url.pathname === "/api/controller/marks" && request.method === "GET") {
    // the marks the running trip has made (Session Start/End and Catches), oldest first, for the controller's log
    const runId = url.searchParams.get("runId") || (await ctlReadState(env, user.id)).runId || null;
    if (!runId) return jsonResponse({ runId: null, marks: [] }, 200, env);
    const { results } = await env.DB.prepare("SELECT * FROM marks WHERE user_id = ? AND trip_run_id = ? ORDER BY date_time ASC, created_at ASC LIMIT 500").bind(user.id, runId).all();
    return jsonResponse({ runId, marks: results.map(rowToMark) }, 200, env);
  }
  if (url.pathname === "/api/controller/events" && request.method === "POST") {
    const body = await readJsonBody(request);
    const events = body && Array.isArray(body.events) ? body.events : null;
    if (!events || events.length === 0 || events.length > CTL_MAX_BATCH) return jsonResponse({ error: `events must be a list of 1 to ${CTL_MAX_BATCH}.` }, 400, env);
    // In order, one at a time: a later event reads the trip and running session the earlier ones just made. Queries are counted so a
    // long backlog can't run into the per-request limit half way through an event: past the budget, the rest are "deferred".
    const budget = { used: 0 };
    const counted = { ...env, DB: { prepare: (sql) => (budget.used++, env.DB.prepare(sql)), batch: (stmts) => env.DB.batch(stmts) } };
    const results = [];
    for (const ev of events) {
      if (budget.used >= CTL_QUERY_BUDGET) results.push({ seq: ev && ev.seq, status: "deferred" });
      else results.push(await ctlProcessEvent(counted, user, ev));
    }
    return jsonResponse({ results }, 200, env);
  }
  return jsonResponse({ error: "Not found." }, 404, env);
}
