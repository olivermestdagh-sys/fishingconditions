#!/usr/bin/env python3
"""Runs scripts/fetch_conditions.py EXACTLY as the workflow always did, and records the run so the shadow Worker can replay it.

    python3 scripts/record_run.py            (the update.yml step; same environment variables as fetch_conditions.py)

What it does differently from `python3 scripts/fetch_conditions.py` (and nothing else):
  1. it PINS the script's clock to the instant the run started (the script's own datetime is replaced by one whose now() returns that
     instant). The script reads the clock in three places seconds apart; pinned, every output is reproducible byte for byte, which is
     what lets the shadow Worker prove it computes the same files. Visible effect: "generatedAt" is the run's START, a few seconds earlier
     than before. A test proves the output is otherwise byte-identical to the plain script under the same pinned clock.
  2. it TEES every API response the script receives (and every write it sends: the id-cache PUTs, the observation archive POSTs, the
     prune) into recordings/<runId>.json. Teeing means: call the real function, remember its answer, hand the SAME answer back. It never
     changes a request, a response or an order.

Exit codes: whatever fetch_conditions.main() would give (0 on success, its sys.exit code if it exits). If the script succeeds but WRITING
THE RECORDING fails, that is logged and the exit code is still 0: a recorder problem must never cost a data run. The workflow additionally
falls back to the plain script if this exits nonzero (see update.yml).

The recording holds the locations (including private ones), the previous output and the raw API answers, so it is uploaded ONLY to the
private shadow bucket and never committed (recordings/ is git-ignored; update.yml's commit step lists its files explicitly).
"""
import hashlib
import json
import os
import sys
import threading
import traceback
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_conditions as fc  # noqa: E402

SCHEMA = 1
KEY_PLACEHOLDER = "{KEY}"


def sha256_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def read_text(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def canon_effects(effects):
    """The script's write calls reduced to what a replay must reproduce: method, the path under /api/, the body, in order.
    (pipeline/src/shadow.py has the same function; a test keeps them identical.)"""
    return [{"method": e["method"], "path": e["url"].split("/api/")[-1], "body": e["body"]} for e in effects]


def effects_hash(effects):
    """A hash of WHAT would be written, as a SET: the real Actions run uses a thread pool, so the order of the per-location archive POSTs
    varies from run to run (each is idempotent; the order carries no meaning). Same function in scripts/record_run.py and shadow.py."""
    lines = sorted(json.dumps(x, sort_keys=True, separators=(",", ":"), ensure_ascii=False) for x in canon_effects(effects))
    return sha256_text("\n".join(lines))


def make_frozen(start):
    class FrozenDT(datetime):
        @classmethod
        def now(cls, tz=None):
            return start.astimezone(tz) if tz else start.replace(tzinfo=None)

    return FrozenDT


def main(start=None, record_dir=None):
    """start: the pinned instant (aware UTC datetime); default is the real current time. Returns the exit code."""
    start = start or datetime.now(timezone.utc)
    run_id = start.strftime("%Y%m%dT%H%M%SZ")
    record_dir = record_dir or os.environ.get("RECORD_DIR", "recordings")

    responses = {}        # canonical url -> JSON text of the parsed answer, or None for a failed call
    locations_text = [None]
    calls = {"http": 0, "failed": 0}
    effects = []
    key = fc.API_KEY

    def canon(url):
        return url.replace(key, KEY_PLACEHOLDER) if key else url

    real_get, real_put, real_post = fc.http_get_json, fc.http_put_json, fc.http_post_json

    lock = threading.Lock()  # the script fetches locations from a thread pool: counters and dicts must not lose updates

    def tee_get(url, *args, **kwargs):
        result = real_get(url, *args, **kwargs)
        try:
            text = None if result is None else json.dumps(result, ensure_ascii=False)
            with lock:
                if fc.PIPELINE_WORKER_URL and url.startswith(fc.PIPELINE_WORKER_URL + "/api/pipeline/locations"):
                    locations_text[0] = text
                else:
                    calls["http"] += 1
                    if result is None:
                        calls["failed"] += 1
                    if canon(url) not in responses or responses[canon(url)] is None:
                        responses[canon(url)] = text
        except Exception:  # noqa: BLE001 - recording must never disturb the run
            pass
        return result

    def tee(method, real):
        def send(url, body, *args, **kwargs):
            result = real(url, body, *args, **kwargs)
            try:
                effects.append({"method": method, "url": url, "body": body})
            except Exception:  # noqa: BLE001
                pass
            return result
        return send

    previous = None
    try:
        if os.path.exists(fc.OUTPUT_PATH):
            previous = read_text(fc.OUTPUT_PATH)
    except Exception:  # noqa: BLE001
        previous = None

    fc.datetime = make_frozen(start)
    fc.http_get_json = tee_get
    fc.http_put_json = tee("PUT", real_put)
    fc.http_post_json = tee("POST", real_post)
    try:
        fc.main()
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else (0 if e.code in (None, 0) else 1)
        if code != 0:
            return code  # the script failed before/without output: no recording, the workflow falls back to the plain script
    finally:
        fc.http_get_json, fc.http_put_json, fc.http_post_json = real_get, real_put, real_post

    try:
        graph_dir = os.path.join(os.path.dirname(fc.OUTPUT_PATH), "graph")
        bundle = {
            "schema": SCHEMA,
            "runId": run_id,
            "runStart": start.isoformat(),
            "workflowRunId": os.environ.get("GITHUB_RUN_ID"),
            "sha": os.environ.get("GITHUB_SHA"),
            "env": {"FORECAST_DAYS": fc.FORECAST_DAYS, "OBS_PRUNE": fc.OBS_PRUNE},
            "locations": locations_text[0],
            "previous": previous,
            "responses": responses,
            "expected": {
                "conditions": sha256_text(read_text(fc.OUTPUT_PATH)),
                "export": sha256_text(read_text(fc.LOCATIONS_EXPORT_PATH)),
                "graph": {n: sha256_text(read_text(os.path.join(graph_dir, n))) for n in sorted(os.listdir(graph_dir))},
                "effects": effects_hash(effects),
                "counts": {"http": calls["http"], "miss": calls["failed"]},
            },
        }
        os.makedirs(record_dir, exist_ok=True)
        tmp = os.path.join(record_dir, run_id + ".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(bundle, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, os.path.join(record_dir, run_id + ".json"))
        print(f"Recorded run {run_id}: {len(responses)} responses, {len(effects)} writes, {os.path.getsize(os.path.join(record_dir, run_id + '.json'))} bytes")
    except Exception:  # noqa: BLE001 - the data is already written; a recording problem is never a failed run
        print("WARNING: could not write the recording (the data run itself succeeded):", file=sys.stderr)
        traceback.print_exc()
    return 0


if __name__ == "__main__":
    sys.exit(main())
