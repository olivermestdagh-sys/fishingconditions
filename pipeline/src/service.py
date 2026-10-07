"""The pipeline run, end to end, with every outside dependency injected (net, store, db, clock) so tests can run the WHOLE flow
against recorded responses and in-memory fakes. entry.py wires the real Cloudflare bindings.

    lock (D1) -> locations (user Worker) -> previous run (R2) -> prefetch (async, <=6 in flight) -> fetch_conditions.main()
    (unmodified, synchronous) -> Public-only objects -> publish GATE -> re-check the lock -> put objects one at a time under
    runs/<runId>/ -> manifest -> latest.json LAST -> prune old runs -> replay the script's write side effects (ONLY when published)
    -> status.json -> unlock

If the gate says no (or the run fails, or overruns its time budget), nothing under runs/ is written, latest.json is untouched and NO
side effect is sent: the site keeps serving the last good run and the user Worker's database is not touched by a bad run.
"""
import gc
import json
import time

import alerts
import locking
import plan
import publish
import runner

CRON_RUN = "0 */3 * * *"
CRON_WATCHDOG = "15 * * * *"


def dispatch_cron(cron):
    """Which job a cron string means. ONLY the run cron runs the billed pipeline; an unknown string does nothing, so a schedule
    change or a differently formatted cron can never turn the hourly watchdog into a full run."""
    cron = (cron or "").strip()
    if cron == CRON_RUN:
        return "run"
    if cron == CRON_WATCHDOG:
        return "watchdog"
    return "ignore"


class PipelineError(Exception):
    """A failure whose message is ours (safe to show): it contains no key, URL or location name."""


class Config:
    def __init__(self, *, api_key, pipeline_url, pipeline_token, obs_prune="dry", forecast_days=6, keep_runs=8,
                 stale_hours=alerts.DEFAULT_STALE_HOURS, concurrency=6, alert_webhook=None, willyweather_budget=100, deadline_s=480):
        self.api_key, self.pipeline_url, self.pipeline_token = api_key, pipeline_url.rstrip("/"), pipeline_token
        self.obs_prune, self.forecast_days, self.keep_runs = obs_prune, forecast_days, keep_runs
        self.stale_hours, self.concurrency, self.alert_webhook = stale_hours, concurrency, alert_webhook
        # A normal run makes 27 WillyWeather requests; 100 leaves room for re-resolving many new locations but caps any runaway.
        self.willyweather_budget = willyweather_budget
        # A run takes about 20-40 s; 8 minutes is far past anything normal and well inside the 15-minute lock lease.
        self.deadline_s = deadline_s


def public_error(e):
    """What may be written to a public file about a failure: our own messages, or just the exception type. Never str(e) of anything else:
    it could carry a URL (with the API key) or a location name."""
    return str(e)[:200] if isinstance(e, PipelineError) else type(e).__name__


async def _json(store, key):
    text = await store.get_text(key)
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


async def load_locations(cfg, net):
    status, text = await net.request("GET", f"{cfg.pipeline_url}/api/pipeline/locations", "pipeline", {"X-Pipeline-Token": cfg.pipeline_token, "Accept": "application/json"})
    if not (200 <= status < 300) or not text:
        raise PipelineError(f"could not load locations from the user Worker (status {status})")
    locations = json.loads(text)
    if not isinstance(locations, list) or not locations:
        raise PipelineError("the user Worker returned no locations")
    return locations


def effects_to_send(effects):
    """Of the script's recorded write side effects, those safe to send. A PUT that only CLEARS a location's cached WillyWeather id is
    dropped: the script does that whenever a cached id returns nothing and the re-search finds no match, which during a WillyWeather
    outage would wipe the curated ids (and the next run's searches could then pick a different, nearest WillyWeather place for good)."""
    keep, skipped = [], 0
    for e in effects:
        if e["method"] == "PUT" and isinstance(e.get("body"), dict) and "willyweatherId" in e["body"] and e["body"]["willyweatherId"] is None:
            skipped += 1
        else:
            keep.append(e)
    return keep, skipped


async def replay_effects(cfg, net, effects):
    """Send the id-cache PUTs, the observation archive POSTs and the prune POST the script would have sent. Best effort, same as today:
    a failure is skipped, never fails the run. Returns {"sent", "failed", "skipped"}."""
    to_send, skipped = effects_to_send(effects)
    sent = failed = 0
    for e in to_send:
        body, status = await net.send_json(e["method"], e["url"], e["body"], cfg.pipeline_token, tries=e.get("retries", 3))
        if body is None and not (200 <= status < 300):
            failed += 1
        else:
            sent += 1
    return {"sent": sent, "failed": failed, "skipped": skipped}


async def run_pipeline(cfg, net, store, db, now, trigger, *, run_id=None, frozen_iso=None, python_version="", log=print, clock=None, force=False):
    """now: aware UTC datetime. Returns a summary dict (never raises for an ordinary failed run: it reports it).

    force: publish even if the gate objects (an admin override, recorded in the manifest as gate.forced)."""
    if clock is not None:
        net.clock = clock
    clock = clock or net.clock or time.time
    t0 = clock()
    run_id = run_id or publish.make_run_id(now)
    now_ms = int(now.timestamp() * 1000)
    if db is not None and not await locking.acquire(db, run_id, now_ms):
        log("pipeline: another run holds the lock, skipping")
        return {"ok": False, "skipped": "locked", "runId": run_id}
    summary = {"runId": run_id, "trigger": trigger, "ok": False, "published": False}
    net.deadline = t0 + cfg.deadline_s
    net.budgets["willyweather"] = cfg.willyweather_budget

    def over_budget():
        return clock() > t0 + cfg.deadline_s

    try:
        if not cfg.api_key:
            raise PipelineError("WILLYWEATHER_API_KEY is not set")
        locations = await load_locations(cfg, net)
        latest = await _json(store, "latest.json")
        prev_manifest = await _json(store, latest["manifest"]) if latest and latest.get("manifest") else None
        prev_text = await store.get_text(latest["conditions"]) if latest and latest.get("conditions") else None

        attempted = set()
        raw = await plan.prefetch(net.get_text, locations, cfg.api_key, cfg.forecast_days, cfg.concurrency, attempted)
        summary["fetch"] = {"responses": len(raw), "calls": net.stats.total_calls()}  # internal only: never written to the public bucket
        if over_budget():
            raise PipelineError("run exceeded its time budget while fetching")

        result = runner.run(locations, raw, prev_text, cfg.api_key, frozen_iso=frozen_iso, forecast_days=cfg.forecast_days,
                            obs_prune=cfg.obs_prune, pipeline_url=cfg.pipeline_url, pipeline_token=cfg.pipeline_token, attempted=attempted)
        effects = result["effects"]
        unplanned = result["counts"]["unplanned"]
        del raw, prev_text
        gc.collect()
        if over_budget():
            raise PipelineError("run exceeded its time budget while scoring")

        generated_at = now.isoformat()
        gen = publish.iter_owner_objects(publish.PUBLIC_OWNER, result)
        key, text, counts = next(gen)  # conditions.json for Public, computed once: it also feeds the gate
        verdict = publish.evaluate_gate(prev_manifest, {
            "pairs": counts["pairs"], "fresh_pairs": counts["freshPairs"], "rows": counts["rows"], "locations": counts["locations"],
            "unplanned": unplanned, "valid": counts["rows"] > 0 and counts["locations"] > 0,
        }, force=force)
        summary["gate"] = verdict
        summary["counts"] = counts
        if not verdict["ok"]:
            log("pipeline: PUBLISH GATE REFUSED this run: " + "; ".join(verdict["reasons"]))
            del text
        else:
            if verdict["forced"]:
                log("pipeline: gate overridden (forced): " + "; ".join(verdict["reasons"]))
            prefix = publish.run_prefix(run_id)
            objects = []

            async def put(rel, body, ctype="application/json"):
                await store.put_text(prefix + rel, body, ctype, "public, max-age=31536000, immutable")
                objects.append({"key": prefix + rel, "bytes": len(body.encode("utf-8")), "sha256": publish.sha256_text(body)})

            await put(key, text)
            del text
            gc.collect()
            for rel, body, _ in gen:
                await put(rel, body)
                del body
            manifest = publish.make_manifest(run_id, generated_at, objects, counts, verdict, python_version)
            await put("manifest.json", publish.dumps(manifest))
            # Everything the pointer names exists. Before flipping it, make sure we still OWN the run: a run that overran its lease
            # while a newer one took over must not publish over it.
            if db is not None and not await locking.holds(db, run_id, now_ms + int((clock() - t0) * 1000)):
                raise PipelineError("lost the run lock before publishing (another run took over)")
            await store.put_text(publish.latest_key(), publish.dumps(publish.make_latest(run_id, generated_at)), "application/json", "public, max-age=60")
            summary["published"] = True
            summary["ok"] = True
            try:
                all_ids = await store.list_run_ids()
                complete = [i for i in all_ids if publish.is_run_id(i) and await store.exists(f"runs/{i}/manifest.json")]
                doomed = publish.runs_to_delete(complete, cfg.keep_runs, run_id) + publish.orphans_to_delete(all_ids, complete, run_id)
                for old in doomed:
                    await store.delete_run(old)
                summary["pruned"] = len(doomed)
            except Exception as e:  # noqa: BLE001 - retention must never fail a published run
                log(f"pipeline: pruning old runs failed: {type(e).__name__}")

        if summary["published"]:
            # The script's own side effects (id cache, observation archive, prune): sent only for a run that was published.
            summary["effects"] = await replay_effects(cfg, net, effects)
        else:
            summary["effects"] = {"sent": 0, "failed": 0, "skipped": len(effects)}
        log("pipeline: fetch stats (internal) " + json.dumps({"byHost": net.stats.by_host, "errors": net.stats.errors[:5]}))
    except Exception as e:  # noqa: BLE001
        summary["error"] = public_error(e)
        log("pipeline: run failed: " + summary["error"])
    finally:
        if db is not None:
            try:
                await locking.release(db, run_id)
            except Exception as e:  # noqa: BLE001
                log(f"pipeline: could not release the lock: {type(e).__name__}")
    await write_status(store, now, summary, cfg)
    return summary


async def write_status(store, now, summary, cfg):
    """status.json is PUBLIC: only what the banner / alert / operators need. Public-scoped counts, our own messages, no fetch statistics."""
    prev = await _json(store, "status.json") or {}
    latest = await _json(store, "latest.json")
    status = dict(prev)
    status["lastRun"] = {
        "at": now.isoformat(), "runId": summary.get("runId"), "trigger": summary.get("trigger"), "ok": summary.get("ok"),
        "published": summary.get("published"), "skipped": summary.get("skipped"),
        "gateReasons": (summary.get("gate") or {}).get("reasons"), "error": summary.get("error"), "counts": summary.get("counts"),
    }
    status["freshness"] = alerts.freshness(latest, now, cfg.stale_hours)
    await store.put_text("status.json", publish.dumps(status), "application/json", "public, max-age=60")


async def watchdog(cfg, net, store, now, log=print):
    """Hourly staleness check. Independent of the run cron. Returns the freshness block."""
    latest = await _json(store, "latest.json")
    fresh = alerts.freshness(latest, now, cfg.stale_hours)
    prev = await _json(store, "status.json") or {}
    status = dict(prev)
    status["freshness"] = fresh
    if fresh["stale"]:
        log("STALE: " + alerts.alert_text(fresh))
        if cfg.alert_webhook and alerts.should_alert(prev, fresh, now):
            text = alerts.alert_text(fresh)
            st, _ = await net.request("POST", cfg.alert_webhook, "alert", {"Content-Type": "application/json"}, json.dumps({"text": text, "content": text}), tries=2)
            if 200 <= st < 300:
                status["lastAlertAt"] = now.isoformat()
    await store.put_text("status.json", publish.dumps(status), "application/json", "public, max-age=60")
    return fresh
