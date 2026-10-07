"""Run the PLAIN script, or the RECORDER, over a fixed world (locations + recorded API answers + previous output) with a pinned clock.

Used to prove two things the shadow design rests on:
  * the recorder's outputs are byte-identical to the plain script's under the same pinned clock (it may only observe, never change);
  * a bundle the recorder writes is something shadow.process_recording can replay to the same bytes.
"""
import contextlib
import copy
import importlib.util
import json
import os
import sys
import tempfile
from datetime import datetime

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "src"))
sys.path.insert(0, HERE)
import tmpguard  # noqa: E402,F401  (all temp output of the tests goes to one folder removed at exit)

import fetch_conditions as fc  # noqa: E402
import plan  # noqa: E402
import runner  # noqa: E402

_spec = importlib.util.spec_from_file_location("record_run", os.path.join(HERE, "..", "..", "scripts", "record_run.py"))
record_run = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(record_run)

PIPELINE_URL = "https://user.example"


@contextlib.contextmanager
def world(locations, raw, prev_text, api_key, outdir, obs_prune="dry", get_log=None, puts=None, posts=None, threaded=False):
    """Point the script at a fixed world. Yields nothing; restores the script's globals on exit."""
    names = ("http_get_json", "http_put_json", "http_post_json", "API_KEY", "FORECAST_DAYS", "PIPELINE_WORKER_URL", "PIPELINE_API_TOKEN",
             "OBS_PRUNE", "ThreadPoolExecutor", "OUTPUT_PATH", "LOCATIONS_EXPORT_PATH", "RUN_AS_OF", "datetime", "load_locations", "load_previous_output")
    saved = {n: getattr(fc, n) for n in names}

    def fake_get(url, retries=3, backoff=2.0, extra_headers=None):
        if get_log is not None:
            get_log.append(url)
        if url.startswith(PIPELINE_URL + "/api/pipeline/locations"):
            return copy.deepcopy(locations)
        text = raw.get(plan.key_for(url, api_key))
        return None if text is None else json.loads(text)

    def sink(bucket):
        def send(url, body, retries=3, backoff=2.0, extra_headers=None):
            if bucket is not None:
                bucket.append((url, body))
            return {"observationsWritten": 0, "tideEventsWritten": 0}
        return send

    try:
        fc.http_get_json, fc.http_put_json, fc.http_post_json = fake_get, sink(puts), sink(posts)
        fc.API_KEY, fc.FORECAST_DAYS, fc.OBS_PRUNE = api_key, 6, obs_prune
        fc.PIPELINE_WORKER_URL, fc.PIPELINE_API_TOKEN = PIPELINE_URL, "tok"
        if threaded:
            import concurrent.futures
            fc.ThreadPoolExecutor = concurrent.futures.ThreadPoolExecutor  # what the real Actions run uses
        else:
            fc.ThreadPoolExecutor = runner.SerialPool
        fc.OUTPUT_PATH = os.path.join(outdir, "data", "conditions.json")
        fc.LOCATIONS_EXPORT_PATH = os.path.join(outdir, "config", "locations.json")
        fc.ARCHIVE_BY_LOCATION.clear()
        if prev_text is not None:
            os.makedirs(os.path.dirname(fc.OUTPUT_PATH), exist_ok=True)
            with open(fc.OUTPUT_PATH, "w", encoding="utf-8") as f:
                f.write(prev_text)
        yield
    finally:
        for n, v in saved.items():
            setattr(fc, n, v)


def read_outputs(outdir):
    """All the script's output files as {relative name: text}."""
    out = {}
    for rel in ("data/conditions.json", "config/locations.json"):
        with open(os.path.join(outdir, rel), encoding="utf-8") as f:
            out[rel] = f.read()
    gdir = os.path.join(outdir, "data", "graph")
    for n in sorted(os.listdir(gdir)):
        with open(os.path.join(gdir, n), encoding="utf-8") as f:
            out["data/graph/" + n] = f.read()
    return out


def run_plain(locations, raw, prev_text, api_key, start, **kw):
    """The PLAIN script (fc.main) under a clock pinned to `start`. Returns (outputs, effects posts)."""
    posts = []
    with tempfile.TemporaryDirectory() as outdir:
        with world(locations, raw, prev_text, api_key, outdir, posts=posts, **kw):
            fc.datetime = record_run.make_frozen(start)
            fc.main()
        return read_outputs(outdir), posts


def run_recorder(locations, raw, prev_text, api_key, start, record_dir=None, **kw):
    """The RECORDER (scripts/record_run.py) over the same world. Returns (outputs, bundle dict or None, exit code)."""
    with tempfile.TemporaryDirectory() as outdir, tempfile.TemporaryDirectory() as default_dir:
        record_dir = record_dir or default_dir
        with world(locations, raw, prev_text, api_key, outdir, **kw):
            code = record_run.main(start=start, record_dir=record_dir)
        path = os.path.join(record_dir, start.strftime("%Y%m%dT%H%M%SZ") + ".json")
        bundle = None
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                bundle = json.load(f)
        return read_outputs(outdir), bundle, code, path
