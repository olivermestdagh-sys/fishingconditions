"""The pipeline run, end to end, with every outside dependency injected (net, store, db, clock) so tests can run the WHOLE flow
against recorded responses and in-memory fakes. entry.py wires the real Cloudflare bindings.

    lock (D1) -> locations (user Worker) -> previous run (R2) -> prefetch (async, <=6 in flight) -> fetch_conditions.main()
    (unmodified, synchronous) -> Public-only objects -> publish GATE -> put objects one at a time under runs/<runId>/ ->
    manifest -> latest.json LAST -> prune old runs -> replay the script's write side effects -> status.json -> unlock

If the gate says no, nothing under runs/ is written and latest.json is untouched: the site keeps serving the last good run.
"""
import gc
import json
from datetime import datetime, timezone

import alerts
import locking
import plan
import publish
import runner


class PipelineError(Exception):
    pass


class Config:
    def __init__(self, *, api_key, pipeline_url, pipeline_token, obs_prune="dry", forecast_days=6, keep_runs=8,
                 stale_hours=alerts.DEFAULT_STALE_HOURS, concurrency=6, alert_webhook=None):
        self.api_key, self.pipeline_url, self.pipeline_token = api_key, pipeline_url.rstrip("/"), pipeline_token
        self.obs_prune, self.forecast_days, self.keep_runs = obs_prune, forecast_days, keep_runs
        self.stale_hours, self.concurrency, self.alert_webhook = stale_hours, concurrency, alert_webhook


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


async def replay_effects(cfg, net, effects):
    """Send the id-cache PUTs, the observation archive POSTs and the prune POST the script would have sent. Best effort, same
    as today: a failure is logged and skipped, never fails the run. Returns {"sent": n, "failed": m}."""
    sent = failed = 0
    for e in effects:
        body, status = await net.send_json(e["method"], e["url"], e["body"], cfg.pipeline_token, tries=e.get("retries", 3))
        if body is None and not (200 <= status < 300):
            failed += 1
        else:
            sent += 1
    return {"sent": sent, "failed": failed}


async def run_pipeline(cfg, net, store, db, now, trigger, *, run_id=None, frozen_iso=None, python_version="", log=print):
    """now: aware UTC datetime. Returns a summary dict (never raises for an ordinary failed run: it reports it)."""
    run_id = run_id or publish.make_run_id(now)
    now_ms = int(now.timestamp() * 1000)
    if db is not None and not await locking.acquire(db, run_id, now_ms):
        log("pipeline: another run holds the lock, skipping")
        return {"ok": False, "skipped": "locked", "runId": run_id}
    summary = {"runId": run_id, "trigger": trigger, "ok": False, "published": False}
    try:
        locations = await load_locations(cfg, net)
        latest = await _json(store, "latest.json")
        prev_manifest = await _json(store, latest["manifest"]) if latest else None
        prev_text = await store.get_text(latest["conditions"]) if latest else None

        raw = await plan.prefetch(net.get_text, locations, cfg.api_key, cfg.forecast_days, cfg.concurrency)
        physical = len(plan.physical_locations(locations))
        weather_ok = publish.weather_ok_count(raw, physical)
        summary["fetch"] = {"responses": len(raw), "weather_ok": weather_ok, "physical": physical, "calls": net.stats.total_calls()}

        result = runner.run(locations, raw, prev_text, cfg.api_key, frozen_iso=frozen_iso, forecast_days=cfg.forecast_days,
                            obs_prune=cfg.obs_prune, pipeline_url=cfg.pipeline_url, pipeline_token=cfg.pipeline_token)
        misses = result["counts"]["miss"]
        effects = result["effects"]
        del raw, prev_text
        gc.collect()

        generated_at = now.isoformat()
        gen = publish.iter_owner_objects(publish.PUBLIC_OWNER, result)
        key, text, counts = next(gen)  # conditions.json for Public, computed once: it also feeds the gate
        verdict = publish.evaluate_gate(prev_manifest, {
            "physical": physical, "weather_ok": weather_ok, "rows": counts["rows"], "public_locations": counts["locations"],
            "misses": misses, "valid": counts["rows"] > 0 and counts["locations"] > 0,
        })
        summary["gate"] = verdict
        summary["counts"] = counts
        if not verdict["ok"]:
            log("pipeline: PUBLISH GATE REFUSED this run: " + "; ".join(verdict["reasons"]))
            del text
        else:
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
            manifest = publish.make_manifest(run_id, generated_at, objects, counts, {
                "responses": summary["fetch"]["responses"], "calls": net.stats.total_calls(), "byHost": net.stats.by_host,
                "misses": misses}, verdict, python_version)
            await put("manifest.json", publish.dumps(manifest))
            # Everything the pointer names exists: now (and only now) flip it.
            await store.put_text(publish.latest_key(), publish.dumps(publish.make_latest(run_id, generated_at)), "application/json", "public, max-age=60")
            summary["published"] = True
            summary["ok"] = True
            try:
                doomed = publish.runs_to_delete(await store.list_run_ids(), cfg.keep_runs, run_id)
                for old in doomed:
                    await store.delete_run(old)
                summary["pruned"] = len(doomed)
            except Exception as e:  # noqa: BLE001 - retention must never fail a published run
                log(f"pipeline: pruning old runs failed: {type(e).__name__}")

        # The script's own side effects (id cache, observation archive, prune), exactly as sent today: best effort, after publishing.
        summary["effects"] = await replay_effects(cfg, net, effects)
        summary["httpErrors"] = net.stats.errors[:5]
    except Exception as e:  # noqa: BLE001
        summary["error"] = f"{type(e).__name__}: {str(e)[:200]}"
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
    """status.json: no location data, only what the banner / alert / operators need."""
    prev = await _json(store, "status.json") or {}
    latest = await _json(store, "latest.json")
    status = dict(prev)
    status["lastRun"] = {
        "at": now.isoformat(), "runId": summary.get("runId"), "trigger": summary.get("trigger"), "ok": summary.get("ok"),
        "published": summary.get("published"), "skipped": summary.get("skipped"),
        "gateReasons": (summary.get("gate") or {}).get("reasons"), "error": summary.get("error"),
        "counts": summary.get("counts"), "fetch": summary.get("fetch"),
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
