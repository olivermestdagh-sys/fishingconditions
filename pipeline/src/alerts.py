"""Stale-data alert: is the newest published run older than it should be, and has anyone been told?

DESIGN (required, not optional). Three independent signals, so no single failure hides a stale site:
  1. WATCHDOG CRON (this Worker, hourly, separate from the run cron): reads latest.json, computes the age, writes the result into
     status.json {freshness: {ageHours, stale, generatedAt, checkedAt}}, and, when stale, POSTs a message to ALERT_WEBHOOK_URL
     (a Worker secret: an ntfy / Slack / Discord incoming-webhook URL) at most once per ALERT_REPEAT_HOURS. The watchdog does not
     depend on the run cron working, which is the point.
  2. IN-SITE BANNER (built in the stage that moves the site onto R2): the pages already fetch latest.json to find the data, so
     they compare its generatedAt with the clock and show "Conditions data is N hours old" when older than STALE_HOURS. This works
     even if the watchdog itself is dead, and also catches R2 / publishing problems the Worker cannot see.
  3. CLOUDFLARE-SIDE: Workers Logs (the run and the watchdog both log "STALE" at error level) and, in the dashboard, a Notification
     on the Worker's error rate. Cloudflare has no alert that looks inside an object, so 1 and 2 are the real checks.
STALE_HOURS default 7: the schedule is every 3 hours, so 7 means two consecutive runs were missed.
"""
from datetime import datetime, timezone

DEFAULT_STALE_HOURS = 7.0
DEFAULT_REPEAT_HOURS = 6.0


def _parse(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def freshness(latest, now, stale_hours=DEFAULT_STALE_HOURS):
    """latest: parsed latest.json or None; now: aware datetime. Returns the block stored under status.json "freshness"."""
    out = {"checkedAt": now.isoformat(), "staleHours": stale_hours}
    if not latest or not latest.get("generatedAt"):
        out.update({"generatedAt": None, "ageHours": None, "stale": True, "reason": "no published run"})
        return out
    gen = _parse(latest["generatedAt"])
    if gen.tzinfo is None:
        gen = gen.replace(tzinfo=timezone.utc)
    age = (now - gen).total_seconds() / 3600
    out.update({"generatedAt": latest["generatedAt"], "ageHours": round(age, 2), "stale": age > stale_hours})
    return out


def should_alert(prev_status, fresh, now, repeat_hours=DEFAULT_REPEAT_HOURS):
    """Alert when stale and nobody was told in the last `repeat_hours` (so a long outage is a reminder every 6 h, not a flood)."""
    if not fresh.get("stale"):
        return False
    last = (prev_status or {}).get("lastAlertAt")
    if not last:
        return True
    return (now - _parse(last)).total_seconds() / 3600 >= repeat_hours


def alert_text(fresh):
    if fresh.get("ageHours") is None:
        return "fish2catch: no conditions data has been published yet."
    return f"fish2catch: conditions data is {fresh['ageHours']:.1f} hours old (alert after {fresh['staleHours']:.0f} h). The 3-hourly update may be failing."
