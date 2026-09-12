-- schema.sql — D1 schema for the user-backend Worker (user-backend.js).
--
-- WHAT THIS IS FOR: this is the account/subscription-tier layer discussed
-- separately from the existing site — it has nothing to do with the shared
-- config/locations.json list the free site scores conditions FOR. Those
-- stay exactly as they are. This schema is for a NEW, separate concept:
-- a signed-in user's OWN private list of locations and check-frequency
-- settings, sitting behind Google sign-in.
--
-- ONE-TIME SETUP (dashboard, no wrangler CLI needed — matches the
-- no-local-dev-environment workflow the rest of this project uses):
--   1. Cloudflare dashboard -> Workers & Pages -> D1 -> Create database
--      -> name it e.g. "fishingconditions-users".
--   2. Open the new database -> Console tab -> paste this entire file's
--      contents -> Execute. (Console runs multiple statements fine.)
--   3. Worker -> Settings -> Bindings -> Add -> D1 database -> variable
--      name DB -> select this database. (user-backend.js expects env.DB.)

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,              -- our own uuid, not Google's — so
                                     -- nothing else has to change if the
                                     -- auth provider ever did (it won't,
                                     -- Google-only per the brief, but this
                                     -- is the standard reason to not use
                                     -- google_sub itself as the row's own
                                     -- identity elsewhere in the schema)
  google_sub TEXT UNIQUE NOT NULL,  -- Google's stable, unique subject id
                                     -- for this account (the `sub` claim
                                     -- in the ID token) — NOT the email:
                                     -- emails can change, sub cannot
  email TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL       -- real UTC ms (Date.now()) — this is
                                     -- an account-creation timestamp, not
                                     -- tide/weather data, so the site's
                                     -- naive-local-time convention does
                                     -- NOT apply here on purpose
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,              -- random token; this value IS the
                                     -- session cookie's value
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL       -- real UTC ms
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- A signed-in user's OWN locations — deliberately separate from (and
-- structurally simpler than) config/locations.json's shore/types/drive-time
-- scheduling fields. Those exist to drive the site's Week Ahead session
-- planner for a fixed, curated location list; a user's personal list here
-- is just "which spots do I want checked, and how", so it only carries
-- what that actually needs.
CREATE TABLE IF NOT EXISTS user_locations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  willyweather_id INTEGER,          -- nullable: a user can save a point
                                     -- before/without a resolved WillyWeather
                                     -- station match, same "unresolved is
                                     -- allowed" pattern as the admin UI
  type TEXT NOT NULL DEFAULT 'Kayak', -- 'Kayak' | 'Land based' — same two
                                     -- values as config/locations.json's
                                     -- types[].type, kept identical on
                                     -- purpose so scoring logic ported over
                                     -- later doesn't need a translation layer
  tidal INTEGER NOT NULL DEFAULT 1, -- 0/1 (SQLite has no bool) — mirrors
                                     -- config/locations.json's "tidal":
                                     -- false convention for inland
                                     -- rivers/lakes that must never pick up
                                     -- tide/current data regardless of what
                                     -- the marine APIs return for that
                                     -- coordinate
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_locations_user ON user_locations(user_id);

-- One row per user: how often/when THEIR locations get checked. Deliberately
-- one flat row rather than per-location, matching the brief's "tiered based
-- on frequency" framing — the tier is an account-level setting, not
-- something that varies spot-to-spot within one subscription.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  check_frequency_minutes INTEGER NOT NULL DEFAULT 180, -- 180 = matches the
                                     -- free site's existing 3-hourly cadence
  active_window_start TEXT NOT NULL DEFAULT '05:00', -- HH:MM, naive local —
  active_window_end TEXT NOT NULL DEFAULT '20:00'     -- same naive-time
                                     -- convention as the rest of this site;
                                     -- see technical-learnings on
                                     -- parseNaive before ever touching this
);

-- Scheduler bookkeeping — NOT wired up to any actual WillyWeather-calling
-- cron yet (that's the next phase, once the account/CRUD layer below is
-- working end-to-end). Created now so the table shape doesn't need a
-- migration later: the cron sweep this eventually feeds reads
-- next_check_due_at, and on-demand refresh writes it forward by
-- check_frequency_minutes to rate-limit repeat button-mashing per tier.
CREATE TABLE IF NOT EXISTS schedule_state (
  user_location_id TEXT PRIMARY KEY REFERENCES user_locations(id) ON DELETE CASCADE,
  next_check_due_at INTEGER,        -- real UTC ms; NULL = never checked yet
  last_result_json TEXT             -- cached last WillyWeather response,
                                     -- so a page load between due checks
                                     -- doesn't have to wait on nothing
);
