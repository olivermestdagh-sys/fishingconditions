"""Run fetch_conditions.main() UNMODIFIED against already-fetched responses.

Everything the script does that Pyodide cannot (urllib, threads, files on disk, the wall clock) is redirected here instead of
being edited in the script:

  * http_get_json  -> served from the prefetched {key: text} dict (see plan.py)
  * http_put_json / http_post_json -> NOT sent: recorded as "side effects" ({method, url, body, retries}); entry.py replays
    them over HTTP afterwards, to the same URLs with the same bodies as the script would have sent today (the id-cache PUTs
    to /api/pipeline/locations/<id>, the observation archive POSTs, the prune POST)
  * load_locations / load_previous_output -> the locations list and previous run, passed in
  * ThreadPoolExecutor -> a serial stand-in with the same .map() (threads do not work in Pyodide)
  * OUTPUT_PATH / LOCATIONS_EXPORT_PATH -> a temp directory (Pyodide's in-memory filesystem)
  * datetime -> optionally frozen, so a parity run can be compared with a golden output made at that instant

The script's generated files are NOT read back here: the caller gets their paths and reads them one at a time, so the whole
~7 MB output never sits in memory twice.

THE OUTPUT FOLDER IS TEMPORARY AND IS REMOVED. It holds a full copy of the run's output (every owner's rows, ~7 MB). run() deletes it itself if
the script fails; otherwise the CALLER must call cleanup(result) when it has finished reading (service.run_pipeline does, in its `finally`).
In the Worker this folder lives in Pyodide's in-memory filesystem, so a leftover is not just clutter: it is ~7 MB of the isolate's memory that
stays allocated across invocations of a warm isolate, and each run would add another.
"""
import copy
import json
import os
import shutil
import tempfile
from datetime import datetime

import fetch_conditions as fc
import plan


class SerialPool:
    """Stand-in for ThreadPoolExecutor: same context-manager + .map() contract, one call at a time."""

    def __init__(self, max_workers=None):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def map(self, fn, items):
        return [fn(i) for i in items]


def make_frozen(frozen_utc):
    class FrozenDT(datetime):
        @classmethod
        def now(cls, tz=None):
            return frozen_utc.astimezone(tz) if tz else frozen_utc.replace(tzinfo=None)

    return FrozenDT


def run(locations, raw, prev_text, api_key, *, frozen_iso=None, forecast_days=6, obs_prune="dry",
        pipeline_url="https://pipeline.invalid", pipeline_token="t", attempted=None):
    """Returns {out, conditions, export, graph_dir, graph_files, counts, effects, run_as_of}.

    raw: {key: JSON text} from plan.prefetch; prev_text: previous conditions.json text or None.
    counts: {"http": calls the script made, "miss": of those, how many were not in `raw`, "unplanned": of the misses, how many
    were never even attempted by prefetch (plan.py drifted from the script: the publish gate refuses such a run)}.
    attempted: the keys prefetch tried (None = "unplanned" is not counted).
    run_as_of: the script's own "now" (naive Melbourne time): rows at or after it are this run's forecasts, earlier ones history.
    effects: the PUT/POST calls the script would have made, in order.
    """
    counts = {"http": 0, "miss": 0, "unplanned": 0}
    effects = []

    def fake_get(url, retries=3, backoff=2.0, extra_headers=None):
        counts["http"] += 1
        key = plan.key_for(url, api_key)
        text = raw.get(key)
        if text is None:
            counts["miss"] += 1
            if attempted is not None and key not in attempted:
                counts["unplanned"] += 1
            return None
        return json.loads(text)

    def record(method):
        def send(url, body, retries=3, backoff=2.0, extra_headers=None):
            effects.append({"method": method, "url": url, "body": body, "retries": retries})
            return {"observationsWritten": 0, "tideEventsWritten": 0, "observations": 0, "tideEvents": 0, "keepDays": 30, "windowHours": 12}
        return send

    saved = {k: getattr(fc, k) for k in (
        "http_get_json", "http_put_json", "http_post_json", "load_locations", "load_previous_output", "API_KEY",
        "FORECAST_DAYS", "PIPELINE_WORKER_URL", "PIPELINE_API_TOKEN", "OBS_PRUNE", "ThreadPoolExecutor",
        "OUTPUT_PATH", "LOCATIONS_EXPORT_PATH", "RUN_AS_OF", "datetime")}
    try:
        fc.http_get_json = fake_get
        fc.http_put_json = record("PUT")
        fc.http_post_json = record("POST")
        fc.load_locations = lambda: copy.deepcopy(locations)
        fc.load_previous_output = lambda: (json.loads(prev_text) if prev_text else None)
        fc.API_KEY = api_key
        fc.FORECAST_DAYS = forecast_days
        fc.PIPELINE_WORKER_URL = pipeline_url
        fc.PIPELINE_API_TOKEN = pipeline_token
        fc.OBS_PRUNE = obs_prune
        fc.ThreadPoolExecutor = SerialPool
        if frozen_iso:
            fc.datetime = make_frozen(datetime.fromisoformat(frozen_iso))
        out = tempfile.mkdtemp(prefix="pipeline-run-")
        fc.OUTPUT_PATH = os.path.join(out, "data", "conditions.json")
        fc.LOCATIONS_EXPORT_PATH = os.path.join(out, "config", "locations.json")
        fc.ARCHIVE_BY_LOCATION.clear()
        try:
            try:
                fc.main()
            except SystemExit as e:  # the script calls sys.exit(1) when its key is unset: a BaseException that `except Exception` would miss
                raise RuntimeError(f"fetch_conditions.py exited with status {e.code}") from None
            gdir = os.path.join(out, "data", "graph")
            return {
                "out": out, "conditions": fc.OUTPUT_PATH, "export": fc.LOCATIONS_EXPORT_PATH, "graph_dir": gdir,
                "graph_files": sorted(os.listdir(gdir)), "counts": counts, "effects": effects,
                "run_as_of": fc.RUN_AS_OF.isoformat() if fc.RUN_AS_OF else None,
            }
        except BaseException:
            shutil.rmtree(out, ignore_errors=True)  # a failed run leaves nothing behind
            raise
    finally:
        for k, v in saved.items():
            setattr(fc, k, v)


def cleanup(result):
    """Remove the script's output folder. Safe to call twice, and with None."""
    if result and result.get("out"):
        shutil.rmtree(result["out"], ignore_errors=True)
        result["out"] = None
