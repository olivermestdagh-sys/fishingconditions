-- schema-v2.sql — replaces schema.sql entirely (v1's user_locations/
-- user_settings tables are superseded by the design below; see README's
-- "User accounts" section for the reasoning trail this came out of).
--
-- CORE IDEA: every user (including a fixed "Public" sentinel account — see
-- below) has their OWN locations-they-track, their OWN type vocabulary,
-- their OWN groups, their OWN mark-list pick-values, and their OWN marks.
-- The free, anonymous site is simply what the Public user's own rows say.
-- A signed-in user's view is their own rows, full stop — there is no
-- separate "defaults vs overrides" merge logic anywhere; Public is just
-- another user_id that happens to be well-known and never logs in.
--
-- THE PUBLIC SENTINEL: insert this fixed-id row once, by hand, right after
-- creating these tables (before running the data migration below) —
--   INSERT INTO users (id, google_sub, email, name, role, created_at)
--   VALUES ('public', 'sentinel-no-login', 'public@system.local', 'Public', 'public', <now-ms>);
-- google_sub is a value Google can never actually issue (real ones are
-- purely numeric), and requireUser()/upsertUser() in user-backend.js must
-- explicitly refuse to ever attach a session to this id — belt-and-braces
-- on top of it being unreachable through a real OAuth flow anyway.
--
-- ROLES: 'admin' can edit ANY user's rows, including Public's (that's how
-- "editing the free site's defaults" works — it's just Admin writing to
-- user_id='public' through the exact same endpoints everyone else uses).
-- 'basic' can only edit their own rows, and is capped at
-- MAX_BASIC_PRIVATE_LOCATIONS (10 — enforced in user-backend.js, not here;
-- SQLite has no clean way to enforce a per-user COUNT(*) constraint
-- declaratively) additional locations beyond whatever they've chosen to
-- pull in from Public's set. 'public' itself is not a role a real session
-- can hold; it exists on the sentinel row purely so a stray permission
-- check that forgets to special-case the sentinel id fails closed (no
-- write access) rather than open.

CREATE TABLE IF NOT EXISTS tiers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  max_extra_locations INTEGER NOT NULL DEFAULT 0, -- how many additional
                                     -- private locations (beyond whatever's
                                     -- inherited from Public) a Basic user
                                     -- assigned to this tier may create —
                                     -- replaces the old single hardcoded
                                     -- MAX_BASIC_CREATED_LOCATIONS constant.
                                     -- Meaningless for an Admin (never capped
                                     -- regardless of tier).
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'basic', -- 'admin' | 'basic' | 'public' (Public sentinel only)
  tier_id TEXT REFERENCES tiers(id), -- which tier's max_extra_locations
                                     -- applies to this user — meaningful for
                                     -- Basic users only; NULL for Admin/
                                     -- Public (never capped either way).
                                     -- A Basic user with no tier assigned
                                     -- (shouldn't normally happen — see
                                     -- migration-tiers.sql) is treated as
                                     -- zero extra locations allowed, not
                                     -- unlimited — see handleTrackedCollection.
  home_lat REAL,                    -- ONLY meaningful on the Public sentinel row —
  home_lng REAL,                    -- the site's own configured home address, used for
                                     -- drive-time-to-home on the Live tab; Admin-only to set
  google_routes_api_key TEXT,       -- ditto — the client-side Google Routes API key, same
                                     -- security model as before (referrer-restricted in
                                     -- Google Cloud Console, not secret-by-obscurity — this
                                     -- is served back out through a public, unauthenticated
                                     -- endpoint, same as it was a public static file before)
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- A physical place — deliberately NOT owned per-user in the sense of
-- controlling who SEES it (that's user_location_access below); this is
-- just "known point on the map, matched to a WillyWeather station".
-- created_by_user_id gates who can edit/delete the base record itself —
-- Admin always can; a Basic user only for a location they created.
-- No dedup against existing coordinates on insert (v1 of this design) —
-- two users adding the same real-world spot get two separate rows; only
-- worth revisiting if duplicate WillyWeather lookups become a real cost.
CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  created_by_user_id TEXT REFERENCES users(id), -- NULL for nothing in
                                     -- practice post-migration (even the
                                     -- original curated set gets attributed
                                     -- to 'public' on migration) but left
                                     -- nullable for defensiveness
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  willyweather_id INTEGER,
  willyweather_name TEXT,
  willyweather_region TEXT,
  willyweather_state TEXT,
  shore TEXT,                       -- compass shore-facing direction, e.g. "NW" — feeds Land Based's wind-only shore-angle scoring
  tide_offset REAL,
  tide_max_observed REAL,
  tidal INTEGER NOT NULL DEFAULT 1, -- 0/1 — strips tide/current data at the scoring source for
                                     -- inland rivers/lakes regardless of what the tide/marine
                                     -- APIs return for that coordinate; confirmed against live
                                     -- data (Metung, VIC) rather than assumed — missed in the
                                     -- first pass of this schema
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_locations_created_by ON locations(created_by_user_id);

-- A user's own vocabulary of location types. behaves_like is the ONLY
-- thing scoring code ever actually switches on — it stays a fixed
-- two-value enum ('Kayak' | 'Land based') no matter how many custom
-- display names a user invents (e.g. "Stand-up paddleboard" or "Rock
-- ledge" both have to declare which of the two real scoring behaviors
-- they use). This is what makes "the type list is open/per-user" (as
-- asked for) compatible with the site's scoring logic only ever knowing
-- two actual algorithms — see the Domain logic section of this project's
-- own README/brief, which is NOT something this migration changes.
CREATE TABLE IF NOT EXISTS user_types (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,               -- the user's own display label, e.g. "Kayak", "SUP", "Rock ledge"
  behaves_like TEXT NOT NULL CHECK (behaves_like IN ('Kayak', 'Land based')),
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_user_types_user ON user_types(user_id);

-- THE central table: one row = "this user tracks this location under this
-- (their own) type, with these personal drive/setup/pack-up numbers."
-- Existence of a row is what makes a location show up in a user's own
-- view at all — there is no separate "public" flag on locations; a
-- location is only ever visible to a user because either they or Public
-- has a row here for it (see the merge note in user-backend.js once that's
-- rebuilt against this schema). driveTo/driveBack/setUp/packUp/timeToSpot/
-- timeFromSpot are genuinely personal-workflow numbers (how fast THIS
-- person rigs a kayak, where THEY live) — never location properties.
CREATE TABLE IF NOT EXISTS user_location_access (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  type_id TEXT NOT NULL REFERENCES user_types(id) ON DELETE CASCADE,
  drive_to TEXT NOT NULL DEFAULT '00:00',   -- HH:MM, naive — same convention as the rest of this site
  drive_back TEXT NOT NULL DEFAULT '00:00',
  set_up TEXT NOT NULL DEFAULT '00:00',
  pack_up TEXT NOT NULL DEFAULT '00:00',
  time_to_spot TEXT NOT NULL DEFAULT '00:00',
  time_from_spot TEXT NOT NULL DEFAULT '00:00',
  min_tide_height REAL,             -- nullable — the boat-ramp-access threshold line drawn
                                     -- on this type's own chart (see README's "Boat ramp
                                     -- access height"); confirmed against live data (Lang
                                     -- Lang's Kayak entry) rather than assumed — missed in
                                     -- the first pass of this schema, same as `tidal` above
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, location_id, type_id)
);

CREATE INDEX IF NOT EXISTS idx_ula_user ON user_location_access(user_id);
CREATE INDEX IF NOT EXISTS idx_ula_location ON user_location_access(location_id);

-- A user's own named groups (e.g. "Western Port") — purely a display/
-- filter grouping for the Week Ahead page's chips, carries no scoring
-- weight of its own.
CREATE TABLE IF NOT EXISTS user_location_groups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_ulg_user ON user_location_groups(user_id);

-- Which of a user's own groups a location belongs to, for THAT user's
-- view — a location can sit in more than one of a user's groups at once
-- (matching config/locations.json's old locationGroups[] plural field).
CREATE TABLE IF NOT EXISTS user_location_group_members (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES user_location_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, location_id, group_id)
);

-- One generic table for every pick-list category (Mark Type, Species,
-- Bait, Rig, Weather/Tide/Water Condition, Mark Shape Format, Mark Colour
-- Format) rather than nine separate tables — mirrors config/mark_lists.json's
-- own flat {field, value, shapeFormat, colorFormat, color} shape exactly,
-- just scoped by user_id. `field` is a free string on purpose (matching
-- the JSON it replaces) rather than a CHECK-constrained enum, since the
-- set of list categories has grown before (see README's "Mark Type" history)
-- and shouldn't need a schema migration to grow again.
CREATE TABLE IF NOT EXISTS user_mark_lists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field TEXT NOT NULL,               -- e.g. "Mark Type", "Species", "Bait"
  value TEXT NOT NULL,               -- e.g. "POI", "Whiting"
  shape_format TEXT,                 -- named shape (see README's mark-list section) — nullable, not every field uses one
  color_format TEXT,                 -- named colour — nullable, same reasoning
  color TEXT,                        -- the actual swatch hex behind color_format, kept alongside it exactly as the JSON does
  icon TEXT,                         -- ONLY on a "Mark Shape Format" row itself: which of this site's own map icons
                                      -- (circle/diamond/cross) this shape uses — confirmed against live mark_lists.json,
                                      -- not guessed; missed in the first pass of this schema
  lowrance_sym TEXT,                 -- ONLY on a Format row itself (shape OR colour): the literal Lowrance <sym> text
                                      -- fragment this piece contributes to a mark's export — see gpxSymForMark, sync.js
  garmin_sym TEXT,                   -- same, for Garmin's export format
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, field, value)
);

CREATE INDEX IF NOT EXISTS idx_uml_user_field ON user_mark_lists(user_id, field);

-- A user's own logged fishing marks (catches and points of interest).
-- Columns mirror data/marks.json's own record shape field-for-field
-- (confirmed against the live file, not guessed) rather than normalizing
-- further — this is a wide, mostly-optional-field table by nature, same
-- as the JSON it replaces.
CREATE TABLE IF NOT EXISTS marks (
  id TEXT PRIMARY KEY,               -- keeps the original m_<epoch>_<rand>-style id from the JSON on migration, for traceability
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  name TEXT,
  type TEXT NOT NULL,                -- POI | Mark | Catch (a user_mark_lists "Mark Type" value, not CHECK-constrained here for the same growth reason as `field` above)
  date_time TEXT NOT NULL,           -- naive "YYYY-MM-DD HH:MM:SS", matching the JSON's own dateTime convention
  created_at_naive TEXT,             -- the JSON's own createdAt string, kept distinct from this row's real created_at below
  source TEXT,                       -- e.g. "gpx-import", "manual"
  source_uuid TEXT,                  -- device-side id, for re-sync matching
  species TEXT,
  bait TEXT,
  rig TEXT,
  rod TEXT,
  size REAL,
  released INTEGER,                  -- 0/1
  weather_condition TEXT,
  tide_condition TEXT,
  water_condition TEXT,
  water_depth REAL,
  water_temperature REAL,
  temperature REAL,
  barometer REAL,
  wind_direction TEXT,
  wind_speed REAL,
  created_at INTEGER NOT NULL        -- real UTC ms — this row's own D1 insert time, NOT the same thing as created_at_naive above
);

CREATE INDEX IF NOT EXISTS idx_marks_user ON marks(user_id);

-- Scheduler bookkeeping — keyed by user_location_access's own id rather
-- than a bare location id, since scheduling happens per (user, location,
-- type), not per location alone. Still not wired up to an actual
-- WillyWeather-calling cron.
--
-- REAL BUG, FOUND AND FIXED: this CREATE TABLE IF NOT EXISTS was a
-- silent no-op against an already-deployed D1 — v1's schema.sql already
-- created a schedule_state table (keyed by user_location_id, a
-- user_locations reference — a different, deprecated concept from
-- user_location_access here), so this definition never actually took
-- effect on a real deploy; the live table kept v1's shape. Every DELETE
-- on a tracked location (handleTrackedItem, user-backend.js) referenced
-- the column THIS definition promised (user_location_access_id), which
-- never existed on the real table — a genuine 500 on every delete,
-- confirmed by reproducing it against the real combined v1+v2 schema.
-- Fixed with a migration (ALTER TABLE ADD COLUMN) rather than by
-- changing the code, which was already correct — see
-- migration-fix-schedule-state.sql. This CREATE TABLE statement below is
-- now accurate for a brand-new deploy from scratch; it just was never
-- what actually ran against this project's own real, already-existing
-- database.
CREATE TABLE IF NOT EXISTS schedule_state (
  user_location_access_id TEXT PRIMARY KEY REFERENCES user_location_access(id) ON DELETE CASCADE,
  next_check_due_at INTEGER,
  last_result_json TEXT
);
