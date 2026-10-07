"""fishingconditions-pipeline: the scheduled Cloudflare Worker that replaces the GitHub Actions job (update.yml).

Shape (the one proven to fire on this account: a WorkerEntrypoint with `async def scheduled(self, controller, env, ctx)`):

  PRODUCTION (config top level; binds PUBLIC_DATA + DB; has the WillyWeather / pipeline secrets):
    scheduled, cron "0 */3 * * *"  -> heartbeat FIRST, then one pipeline run (service.run_pipeline)
    scheduled, cron "15 * * * *"   -> the stale-data watchdog (service.watchdog)
    scheduled, any other cron      -> heartbeat only (service.dispatch_cron): never a billed run by accident
    fetch, POST /run               -> a run on demand: how "Refresh data now" reaches the pipeline. There is NO public route
                                      (workers_dev = false): the user Worker calls this over a service binding, and the call must
                                      also carry X-Pipeline-Token, so a stray route could not trigger billed WillyWeather calls.
    fetch, GET /status             -> status.json, same guard.

  SHADOW (`wrangler ... --env shadow`, SHADOW = "1"; binds ONLY the private SHADOW_DATA bucket + DB for its own lock row; NO secrets):
    scheduled, cron "40 */3 * * *" -> heartbeat, then replay any unprocessed Actions recordings (shadow.process_pending)
    everything else                -> nothing. fetch answers 404 to every request. There is no PUBLIC_DATA binding, so this deployment
                                      cannot write to the public bucket; it is given a NullNet, so it cannot make any outbound request.

All the logic lives in service.py / shadow.py / plan.py / publish.py (importable and tested without Cloudflare); this file only turns
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
import shadow
import store as storemod

JSONH = {"content-type": "application/json"}
CRON_SHADOW = "40 */3 * * *"


async def _transport(method, url, headers, body):
    init = {"method": method, "headers": headers, "signal": js.AbortSignal.timeout(20000)}
    if body is not None:
        init["body"] = body
    r = await js.fetch(url, to_js(init, dict_converter=js.Object.fromEntries))
    return int(r.status), str(await r.text()), r.headers.get("retry-after")


def heap_mb():
    """Size of the Pyodide wasm linear memory (it never shrinks, so after a phase it is that phase's high-water mark)."""
    for probe in (lambda: __import__("pyodide_js")._module.HEAPU8.length, lambda: js.Module.HEAPU8.length):
        try:
            return round(probe() / 1048576, 1)
        except Exception:  # noqa: BLE001
            pass
    return None


def _var(env, name, default=None):
    v = getattr(env, name, None)
    return default if v is None or str(v) == "undefined" else str(v)


def is_shadow(env):
    return _var(env, "SHADOW", "") == "1"


def _config(env):
    return service.Config(
        api_key=_var(env, "WILLYWEATHER_API_KEY", ""), pipeline_url=_var(env, "PIPELINE_WORKER_URL", "https://pipeline.invalid"),
        pipeline_token=_var(env, "PIPELINE_API_TOKEN", ""), obs_prune=_var(env, "OBS_PRUNE", "dry"),
        forecast_days=int(_var(env, "FORECAST_DAYS", "6")), keep_runs=int(_var(env, "KEEP_RUNS", "8")),
        stale_hours=float(_var(env, "STALE_HOURS", "7")), alert_webhook=_var(env, "ALERT_WEBHOOK_URL"),
        willyweather_budget=int(_var(env, "WILLYWEATHER_BUDGET", "100")), deadline_s=int(_var(env, "RUN_DEADLINE_S", "480")),
    )


def _net(cfg):
    return netmod.Net(_transport, secret=cfg.api_key)


class Default(WorkerEntrypoint):
    async def scheduled(self, controller, env, ctx):
        env = self.env
        cron = str(getattr(controller, "cron", ""))
        now = datetime.now(timezone.utc)
        if is_shadow(env):
            await self._shadow(env, cron, now)
            return
        store = storemod.R2Store(env.PUBLIC_DATA)
        # Heartbeat first: proves the cron reached this handler even if everything after it fails.
        await store.put_text("heartbeat.json", json.dumps({"at": now.isoformat(), "cron": cron}), "application/json", "no-store")
        cfg = _config(env)
        job = service.dispatch_cron(cron)
        if job == "watchdog":
            await service.watchdog(cfg, _net(cfg), store, now)
            return
        if job != "run":
            print("scheduled: ignoring an unrecognised cron expression")
            return
        summary = await service.run_pipeline(cfg, _net(cfg), store, env.DB, now, "cron", python_version=sys.version.split()[0])
        print("pipeline run", json.dumps({k: summary.get(k) for k in ("runId", "ok", "published", "skipped", "error")}))

    async def _shadow(self, env, cron, now):
        bucket = storemod.R2Store(env.SHADOW_DATA)          # recordings/ live at the bucket root
        out = bucket.view("shadow/")                         # everything the shadow writes lives under shadow/
        await out.put_text("heartbeat.json", json.dumps({"at": now.isoformat(), "cron": cron}), "application/json", "no-store")
        if service.dispatch_cron(cron, shadow=True) != "shadow":
            print("shadow: ignoring an unrecognised cron expression")
            return
        cfg = _config(env)
        done = await shadow.process_pending(cfg, bucket, out, env.DB, now, probe=heap_mb)
        print("shadow cycle", json.dumps([{k: e.get(k) for k in ("id", "clean", "reasons", "heapMb")} for e in done]))

    async def fetch(self, request):
        env = self.env
        if is_shadow(env):
            return Response(json.dumps({"error": "Not found."}), status=404, headers=JSONH)
        cfg = _config(env)
        if not cfg.pipeline_token or request.headers.get("X-Pipeline-Token") != cfg.pipeline_token:
            return Response(json.dumps({"error": "Forbidden."}), status=403, headers=JSONH)
        from urllib.parse import urlparse
        path, method = urlparse(request.url).path, str(request.method)
        store = storemod.R2Store(env.PUBLIC_DATA)
        if path == "/run" and method == "POST":
            now = datetime.now(timezone.utc)
            force = "force=1" in (urlparse(request.url).query or "")  # admin override of the publish gate (recorded in the manifest)
            summary = await service.run_pipeline(cfg, _net(cfg), store, env.DB, now, "manual", python_version=sys.version.split()[0], force=force)
            return Response(json.dumps(summary), status=200 if summary.get("ok") else 409, headers=JSONH)
        if path == "/status" and method == "GET":
            return Response((await store.get_text("status.json")) or "{}", headers=JSONH)
        return Response(json.dumps({"error": "Not found."}), status=404, headers=JSONH)
