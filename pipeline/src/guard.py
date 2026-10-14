"""Is a production run allowed right now? The check that keeps repeated failures, a mis-set cron or a button held down from burning the
WillyWeather quota (every request is billed). It sits IN FRONT of the lock and the run, and applies only to live runs (replay/shadow
never calls WillyWeather).

State is one D1 row per UTC day in `pipeline_budget` (schema-v2.sql; manual CREATE TABLE): how many attempts started, how many
WillyWeather requests they made, and when the last attempt started. Counting from ATTEMPTS (recorded before the run starts, so a run
that crashes or times out still counts) means a failing run cannot be retried more often than `min_interval_min`.

Rules, in order (the first that refuses wins):
  1. daily cap on billed WillyWeather requests and on attempts  - for everyone, `force` included (it is the last line of defence);
  2. minimum interval since the last ATTEMPT (success or failure)  - 50 min for cron and manual alike; `force` (the admin override) skips it;
  3. "is a run due?"  - cron only: skip while the published data is younger than `due_after_min` (the cron fires every 3 h, so a
     healthy cadence passes with room to spare; a second cron fire, a re-registered schedule, etc. does nothing).
A manual run is never subject to rule 3: asking for a refresh is the point.
"""
from datetime import datetime, timezone

DEFAULTS = dict(
    daily_call_cap=400,      # a normal run makes ~27 requests, so ~216 on a normal day; 400 leaves room for manual refreshes and a re-resolve
    max_attempts_per_day=16,  # 8 cron runs on a normal day
    min_interval_min=50,     # between ATTEMPTS (a failed attempt included)
    due_after_min=150,       # cron: published data younger than this = nothing to do
)


def day_key(now):
    return now.astimezone(timezone.utc).strftime("%Y%m%d")


def decide(trigger, now_ms, latest_ms, row, limits, force=False):
    """Pure. row: {"attempts", "calls", "last_attempt_ms"} for today (zeros when none). latest_ms: generatedAt of the published run, or None.
    Returns (ok, reason). reason is ours and safe to show."""
    if row["calls"] >= limits["daily_call_cap"]:
        return False, "daily cap on WillyWeather requests reached"
    if row["attempts"] >= limits["max_attempts_per_day"]:
        return False, "daily cap on run attempts reached"
    if not force and row["last_attempt_ms"] and now_ms - row["last_attempt_ms"] < limits["min_interval_min"] * 60000:
        wait = int((limits["min_interval_min"] * 60000 - (now_ms - row["last_attempt_ms"])) / 60000) + 1
        return False, f"too soon after the last attempt (try again in about {wait} min)"
    if trigger == "cron" and latest_ms is not None and now_ms - latest_ms < limits["due_after_min"] * 60000:
        return False, "published data is recent: no run due"
    return True, ""


async def _row(db, day):
    await db.prepare("INSERT OR IGNORE INTO pipeline_budget (day, attempts, calls, last_attempt_ms) VALUES (?, 0, 0, 0)").bind(day).run()
    r = await db.prepare("SELECT attempts, calls, last_attempt_ms FROM pipeline_budget WHERE day = ?").bind(day).first()
    if r is None:
        return {"attempts": 0, "calls": 0, "last_attempt_ms": 0}
    g = (lambda k: r[k]) if isinstance(r, dict) else (lambda k: getattr(r, k))
    return {"attempts": int(g("attempts")), "calls": int(g("calls")), "last_attempt_ms": int(g("last_attempt_ms"))}


async def _changes(res):
    meta = res["meta"] if isinstance(res, dict) else res.meta
    return int(meta["changes"] if isinstance(meta, dict) else meta.changes)


async def begin_attempt(db, trigger, now, latest_generated_ms, limits, force=False):
    """Decide AND record the attempt in one compare-and-set, so two simultaneous triggers cannot both pass. Returns (ok, reason)."""
    day, now_ms = day_key(now), int(now.timestamp() * 1000)
    row = await _row(db, day)
    ok, reason = decide(trigger, now_ms, latest_generated_ms, row, limits, force)
    if not ok:
        return False, reason
    res = await db.prepare("UPDATE pipeline_budget SET attempts = attempts + 1, last_attempt_ms = ? WHERE day = ? AND attempts = ? AND last_attempt_ms = ?").bind(
        now_ms, day, row["attempts"], row["last_attempt_ms"]).run()
    if await _changes(res) != 1:
        return False, "another attempt started at the same moment"
    return True, ""


async def record_calls(db, now, calls):
    """Add the WillyWeather requests this attempt actually made (retries included) to today's count."""
    if calls:
        await db.prepare("UPDATE pipeline_budget SET calls = calls + ? WHERE day = ?").bind(int(calls), day_key(now)).run()


def parse_iso_ms(text):
    try:
        return int(datetime.fromisoformat(str(text).replace("Z", "+00:00")).timestamp() * 1000)
    except (TypeError, ValueError):
        return None
