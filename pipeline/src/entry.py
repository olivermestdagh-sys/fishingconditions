"""fishingconditions-pipeline: the scheduled Cloudflare Worker that replaces the GitHub Actions job (update.yml).

Shape (the one proven to fire on this account: a WorkerEntrypoint with `async def scheduled(self, controller, env, ctx)`):

  scheduled, cron "0 */3 * * *"  -> heartbeat FIRST, then one pipeline run (service.run_pipeline)
  scheduled, cron "15 * * * *"   -> the stale-data watchdog (service.watchdog)
  fetch, POST /run               -> a run on demand: how "Refresh data now" reaches the pipeline. There is NO public route
                                    (workers_dev = false): the user Worker calls this over a service binding, and the call must
                                    also carry X-Pipeline-Token, so a stray route could not trigger billed WillyWeather calls.
  fetch, GET /status             -> status.json, same guard.

All the logic lives in service.py / plan.py / publish.py (importable and tested without Cloudflare); this file only turns
Cloudflare bindings into the objects those modules take.
"""
import json
import sys
from datetime import datetime, timezone

import js
from pyodide.ffi import to_js
from workers import WorkerEntrypoint, Response

import net as netmod
import service
import store as storemod

JSONH = {"content-type": "application/json"}
CRON_RUN = "0 */3 * * *"
CRON_WATCHDOG = "15 * * * *"


async def _transport(method, url, headers, body):
    init = {"method": method, "headers": headers, "signal": js.AbortSignal.timeout(20000)}
    if body is not None:
        init["body"] = body
    r = await js.fetch(url, to_js(init, dict_converter=js.Object.fromEntries))
    return int(r.status), str(await r.text()), r.headers.get("retry-after")


def _config(env):
    def var(name, default=None):
        v = getattr(env, name, None)
        return default if v is None or str(v) == "undefined" else str(v)

    return service.Config(
        api_key=var("WILLYWEATHER_API_KEY", ""), pipeline_url=var("PIPELINE_WORKER_URL", ""),
        pipeline_token=var("PIPELINE_API_TOKEN", ""), obs_prune=var("OBS_PRUNE", "dry"),
        forecast_days=int(var("FORECAST_DAYS", "6")), keep_runs=int(var("KEEP_RUNS", "8")),
        stale_hours=float(var("STALE_HOURS", "7")), alert_webhook=var("ALERT_WEBHOOK_URL"),
    )


def _net(cfg):
    return netmod.Net(_transport, secret=cfg.api_key)


class Default(WorkerEntrypoint):
    async def scheduled(self, controller, env, ctx):
        env = self.env
        store = storemod.R2Store(env.PUBLIC_DATA)
        cron = str(getattr(controller, "cron", ""))
        now = datetime.now(timezone.utc)
        # Heartbeat first: proves the cron reached this handler even if everything after it fails.
        await store.put_text("heartbeat.json", json.dumps({"at": now.isoformat(), "cron": cron}), "application/json", "no-store")
        cfg = _config(env)
        if cron == CRON_WATCHDOG:
            await service.watchdog(cfg, _net(cfg), store, now)
            return
        summary = await service.run_pipeline(cfg, _net(cfg), store, env.DB, now, "cron", python_version=sys.version.split()[0])
        print("pipeline run", json.dumps({k: summary.get(k) for k in ("runId", "ok", "published", "skipped", "error")}))

    async def fetch(self, request):
        env = self.env
        cfg = _config(env)
        if not cfg.pipeline_token or request.headers.get("X-Pipeline-Token") != cfg.pipeline_token:
            return Response(json.dumps({"error": "Forbidden."}), status=403, headers=JSONH)
        from urllib.parse import urlparse
        path, method = urlparse(request.url).path, str(request.method)
        store = storemod.R2Store(env.PUBLIC_DATA)
        if path == "/run" and method == "POST":
            now = datetime.now(timezone.utc)
            summary = await service.run_pipeline(cfg, _net(cfg), store, env.DB, now, "manual", python_version=sys.version.split()[0])
            return Response(json.dumps(summary), status=200 if summary.get("ok") else 409, headers=JSONH)
        if path == "/status" and method == "GET":
            return Response((await store.get_text("status.json")) or "{}", headers=JSONH)
        return Response(json.dumps({"error": "Not found."}), status=404, headers=JSONH)
