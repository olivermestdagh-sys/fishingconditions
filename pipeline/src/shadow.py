"""SHADOW mode: replay what the GitHub Actions job already did, through the Worker's own code, and prove it gets the same answer.

Each Actions run is recorded by scripts/record_run.py into one bundle (recordings/<runId>.json in a PRIVATE bucket): the locations, the
previous output, every API answer, the pinned clock, and the SHA-256 of every file Actions produced. This module, for each bundle not yet
processed (oldest first):

  1. runs service.run_pipeline in replay mode: the same prefetch-free path (the recorded answers ARE the inputs), the same unmodified script,
     the same publish gate and layout, with a NullNet (no network exists), a "shadow/" view of the bucket (nothing can land elsewhere) and
     its own lock row ("shadow"); the script's would-be writes are counted, never sent;
  2. compares the script's FULL output (all owners, before filtering) with Actions' hashes, byte for byte: conditions.json, the locations
     export, every graph file, the sequence of writes it would have sent, and how many calls it made / how many failed;
  3. scans every published object for any private location name or owner id;
  4. stamps the entry with the script hash of the recording and of this Worker (script_hash.py). A recording made with a DIFFERENT script
     is still replayed, as information, but marked superseded: verify-shadow neither counts it nor treats it as a failure;
  5. writes shadow/compare/<runId>.json, appends a one-line entry to shadow/index.json (what scripts/verify-shadow.mjs reads), and, only on a
     mismatch, keeps the shadow's full output under shadow/diffs/<runId>/ so the first differing field can be found.

Everything is in the private bucket; nothing here is public.
"""
import gc
import hashlib
import json
import os

import publish
import script_hash
import service

INDEX_KEY = "index.json"
INDEX_MAX = 300
# Memory is judged SEPARATELY from output equality. Equality alone decides clean/unclean (and so the streak) EXCEPT for a hard ceiling: the Worker's
# real limit is far above these, but a replay that peaks over the ceiling is a replay we cannot trust to keep running, so it counts as unclean. The watch
# level is only reported (heapWatch in the entry; verify-shadow prints it) and never resets the streak.
HEAP_WATCH_MB = 90.0
HEAP_CEILING_MB = 115.0
# The wasm linear memory only grows, so a warm isolate's figure is the high-water mark of everything it has replayed. Each entry therefore also records
# whether the isolate was cold (first replay since the Worker started) and how much the figure grew during this replay.
_ISOLATE = {"id": os.urandom(3).hex(), "replays": 0}
KEEP_RECORDINGS_DAYS = 4


def sha256_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def canon_effects(effects):
    """Same function as scripts/record_run.py (a test keeps them identical)."""
    return [{"method": e["method"], "path": e["url"].split("/api/")[-1], "body": e["body"]} for e in effects]


def effects_hash(effects):
    """A hash of WHAT would be written, as a SET: the real Actions run uses a thread pool, so the order of the per-location archive POSTs
    varies from run to run (each is idempotent; the order carries no meaning). Same function in scripts/record_run.py and shadow.py."""
    lines = sorted(json.dumps(x, sort_keys=True, separators=(",", ":"), ensure_ascii=False) for x in canon_effects(effects))
    return sha256_text("\n".join(lines))


def parse_bundle(text):
    """-> (bundle dict, replay dict). Response bodies stay JSON TEXT (never parsed here): the script parses each one when it asks for it."""
    import plan
    b = json.loads(text)
    if b.get("schema") != 1:
        raise ValueError(f"unknown recording schema {b.get('schema')!r}")
    responses = b["responses"]
    raw = {plan.key_for(url, "{KEY}"): body for url, body in responses.items() if body is not None}
    attempted = {plan.key_for(url, "{KEY}") for url in responses}
    locations = json.loads(b["locations"]) if b.get("locations") else None
    if not locations:
        raise ValueError("the recording has no locations")
    replay = {
        "locations": locations, "raw": raw, "attempted": attempted, "prev_text": b.get("previous"),
        "frozen_iso": b["runStart"], "forecast_days": int(b["env"]["FORECAST_DAYS"]), "obs_prune": b["env"]["OBS_PRUNE"],
    }
    return b, replay


def private_markers(locations):
    """What must never appear in a public object: each non-public location's name (as a quoted JSON string, so 'Alpha' does not match
    inside 'Alpha Beach') and each non-public owner id. Anything without a real ownerId counts as non-public too."""
    names, owners = set(), set()
    for l in locations:
        o = l.get("ownerId")
        if o != publish.PUBLIC_OWNER:
            names.add(json.dumps(l["name"], ensure_ascii=False))
            if isinstance(o, str) and o:
                owners.add(o)
    return names, owners


def first_mismatch(expected, actual, label):
    """A short, public-safe note: which file differs (hashes only; the field-level diff is done by verify-shadow from shadow/diffs/)."""
    return {"file": label, "expected": expected[:12], "actual": actual[:12]}


async def compare_outputs(bundle, result):
    """Byte-compare the script's full output with the hashes Actions recorded. Returns {"identical": bool, "mismatched": [...], ...}."""
    exp = bundle["expected"]
    mism = []
    cond_hash = sha256_text(_read(result["conditions"]))
    if cond_hash != exp["conditions"]:
        mism.append(first_mismatch(exp["conditions"], cond_hash, "conditions.json"))
    exp_hash = sha256_text(_read(result["export"]))
    if exp_hash != exp["export"]:
        mism.append(first_mismatch(exp["export"], exp_hash, "locations export"))
    want_graph, have_graph = exp["graph"], {}
    for name in result["graph_files"]:
        have_graph[name] = sha256_text(_read(os.path.join(result["graph_dir"], name)))
    for name in sorted(set(want_graph) | set(have_graph)):
        if name not in have_graph:
            mism.append({"file": f"graph/{name}", "problem": "missing in shadow output"})
        elif name not in want_graph:
            mism.append({"file": f"graph/{name}", "problem": "extra in shadow output"})
        elif have_graph[name] != want_graph[name]:
            mism.append(first_mismatch(want_graph[name], have_graph[name], f"graph/{name}"))
    eff = effects_hash(result["effects"])
    if eff != exp["effects"]:
        mism.append(first_mismatch(exp["effects"], eff, "archive/id-cache/prune writes"))
    counts = result["counts"]
    if counts["http"] != exp["counts"]["http"] or counts["miss"] != exp["counts"]["miss"]:
        mism.append({"file": "script calls", "problem": f"made {counts['http']} calls ({counts['miss']} failed), Actions made {exp['counts']['http']} ({exp['counts']['miss']} failed)"})
    return {
        "identical": not mism, "mismatched": mism, "graphFiles": len(want_graph),
        "unplanned": counts["unplanned"], "effects": len(result["effects"]),
    }


def verdict(summary, compare, leaked, heap_mb):
    """Is this cycle clean? Returns (clean, [reasons]). Every reason is a short sentence naming the failing check."""
    reasons = []
    if summary.get("skipped") == "locked":
        reasons.append("the shadow lock was held by another run")
    if summary.get("error"):
        reasons.append(f"the run failed: {summary['error']}")
    if compare is None:
        if not summary.get("error"):
            reasons.append("no comparison was produced")
    elif not compare["identical"]:
        first = compare["mismatched"][0]
        reasons.append(f"output differs from Actions at {first['file']}" + (f" ({first['problem']})" if "problem" in first else ""))
    gate = summary.get("gate")
    if gate is not None and not gate["ok"]:
        reasons.append("the publish gate would have refused: " + "; ".join(gate["reasons"]))
    if gate is not None and gate["ok"] and not summary.get("published"):
        reasons.append("the gate passed but nothing was published")
    if leaked:
        reasons.append("a private location name or owner id appeared in a public object")
    if heap_mb is not None and heap_mb > HEAP_CEILING_MB:
        reasons.append(f"Python heap {heap_mb:.0f} MB is over the {HEAP_CEILING_MB:.0f} MB ceiling")
    return (not reasons), reasons


async def process_recording(cfg, rec_store, out_store, db, now, rec_key, *, probe=None, log=print, clock=None):
    """Replay one recording. Returns the index entry written (and writes compare/<id>.json)."""
    rec_id = rec_key.rsplit("/", 1)[-1].removesuffix(".json")
    entry = {"id": rec_id, "processedAt": now.isoformat(), "clean": False, "reasons": [], "deployedScriptHash": script_hash.SCRIPT_HASH}
    summary, compare, leaked, bundle = {}, None, False, None
    cold, heap_before = _ISOLATE["replays"] == 0, (probe() if probe else None)
    _ISOLATE["replays"] += 1
    try:
        bundle, replay = parse_bundle(await rec_store.get_text(rec_key))
        entry.update(runStart=bundle["runStart"], workflowRunId=bundle.get("workflowRunId"), scriptHash=bundle.get("scriptHash"))
        if bundle.get("scriptHash") != script_hash.SCRIPT_HASH:
            # Made with a different script than this Worker runs (or by a recorder that did not record one): the replay below is only
            # informational. verify-shadow lists it as superseded; it never counts for or against the streak.
            entry.update(superseded=True, supersededWhy="the recording has no script hash (older recorder)" if not bundle.get("scriptHash")
                         else "the recording was made with a different script than this Worker runs")
        names, owners = private_markers(replay["locations"])
        found = []

        def scan(rel, text):
            if any(n in text for n in names) or any(o in text for o in owners):
                found.append(rel)

        async def inspect(result):
            nonlocal compare
            compare = await compare_outputs(bundle, result)
            if not compare["identical"]:
                # Only on a mismatch: keep the shadow's FULL output (private bucket) so the first differing field can be located.
                await out_store.put_text(f"diffs/{rec_id}/conditions.json", _read(result["conditions"]), "application/json")
                await out_store.put_text(f"diffs/{rec_id}/export.json", _read(result["export"]), "application/json")
                for n in result["graph_files"]:
                    await out_store.put_text(f"diffs/{rec_id}/graph/{n}", _read(os.path.join(result["graph_dir"], n)), "application/json")
            return {"identical": compare["identical"]}

        import datetime as dt
        run_start = dt.datetime.fromisoformat(bundle["runStart"])
        from net import NullNet
        summary = await service.run_pipeline(
            cfg, NullNet(), out_store, db, now, "shadow", run_id=rec_id, replay=replay, lock_id="shadow", generated_at=run_start.isoformat(),
            inspect=inspect, on_object=scan, probe=probe, log=log, clock=clock, python_version="shadow")
        leaked = bool(found)
    except Exception as e:  # noqa: BLE001 - one bad recording must not stop the others
        summary = {"error": service.public_error(e)}
        log("shadow: recording failed: " + summary["error"])

    heap = summary.get("heapMb")
    clean, reasons = verdict(summary, compare, leaked, heap)
    entry.update(isolate={"id": _ISOLATE["id"], "cold": cold, "replayNo": _ISOLATE["replays"]}, heapBeforeMb=heap_before,
                 heapGrowthMb=(round(heap - heap_before, 1) if heap is not None and heap_before is not None else None),
                 heapWatch=bool(heap is not None and heap > HEAP_WATCH_MB))
    entry.update(clean=clean, reasons=reasons, heapMb=heap, published=bool(summary.get("published")),
                 counts=summary.get("counts"), identical=(compare or {}).get("identical"))
    if compare and compare["mismatched"]:
        entry["firstDiff"] = compare["mismatched"][0]
    report = {"schema": 1, "id": rec_id, "entry": entry, "compare": compare, "gate": summary.get("gate"), "effects": summary.get("effects"),
              "error": summary.get("error"), "publicLeak": leaked}
    await out_store.put_text(f"compare/{rec_id}.json", publish.dumps(report), "application/json")
    await update_index(out_store, entry)
    # Nothing of this replay may stay referenced in a warm isolate: the recording, the parsed responses, the output paths, the comparison and the report.
    bundle = replay = summary = compare = report = None
    gc.collect()
    return entry


async def update_index(out_store, entry):
    """shadow/index.json: the last INDEX_MAX cycles, newest last. One small object the verifier reads."""
    text = await out_store.get_text(INDEX_KEY)
    try:
        index = json.loads(text) if text else {"schema": 1, "cycles": []}
    except ValueError:
        index = {"schema": 1, "cycles": []}
    index["cycles"] = [c for c in index["cycles"] if c["id"] != entry["id"]] + [entry]
    index["cycles"].sort(key=lambda c: c["id"])
    index["cycles"] = index["cycles"][-INDEX_MAX:]
    await out_store.put_text(INDEX_KEY, publish.dumps(index), "application/json")


async def processed_ids(out_store):
    """The ids already replayed BY THIS DEPLOYED SCRIPT, from shadow/index.json (ONE read). An entry is written for every recording that was replayed,
    clean or not (a corrupt recording is reported once, not retried every fire). An entry made under another deployed script (or before entries carried
    one) is not "done": the recording is replayed once more under the current script, and update_index replaces the entry with the same id, so a
    recording can never count twice. A replay that died BEFORE its entry was written is simply absent here and is tried again next fire."""
    text = await out_store.get_text(INDEX_KEY)
    try:
        return {c["id"] for c in (json.loads(text)["cycles"] if text else []) if c.get("deployedScriptHash") == script_hash.SCRIPT_HASH}
    except (ValueError, KeyError, TypeError):
        return set()


async def process_pending(cfg, rec_store, out_store, db, now, *, probe=None, log=print, max_per_run=1, clock=None):
    """Replay the recordings not yet replayed, oldest first (at most `max_per_run` = ONE per fire, which also keeps the Python heap at one replay's worth), then drop old replayed recordings.

    A fire with nothing new is a cheap no-op by construction: ONE list of recordings/ and, only if there is at least one recording, ONE read
    of index.json. It touches no D1 (the lock is taken only when there is something to replay) and no other R2 object."""
    keys = sorted(k for k in await rec_store.list_keys("recordings/") if k.endswith(".json"))
    if not keys:
        return []
    import shadow_measure  # TEMPORARY (delete with shadow_measure.py): a measurement request in the listing replaces this fire's normal work
    if shadow_measure.REQUEST_KEY in keys:
        await shadow_measure.run_request(cfg, rec_store, out_store, db, now, probe, log=log)
        return []
    replayed = await processed_ids(out_store)
    done = []
    for k in keys:
        rec_id = k.rsplit("/", 1)[-1].removesuffix(".json")
        if rec_id in replayed:
            continue
        if len(done) >= max_per_run:
            break
        done.append(await process_recording(cfg, rec_store, out_store, db, now, k, probe=probe, log=log, clock=clock))
        replayed.add(rec_id)
    # Retention: a recording is deleted once it was replayed and is older than KEEP_RECORDINGS_DAYS (they are ~7 MB each).
    cutoff = publish.make_run_id(now - __import__("datetime").timedelta(days=KEEP_RECORDINGS_DAYS))
    for k in keys:
        rec_id = k.rsplit("/", 1)[-1].removesuffix(".json")
        if publish.is_run_id(rec_id) and rec_id < cutoff and rec_id in replayed:
            await rec_store.delete_key(k)
    return done


async def touch_heartbeat(out_store, now, cron):
    """shadow/heartbeat.json: proof the cron reached the Worker, the cron STRING that fired, and fire counts in total and per cron string (the
    object is overwritten each time, so without counters the history is unrecoverable). One read + one write."""
    prev = {}
    text = await out_store.get_text("heartbeat.json")
    try:
        prev = json.loads(text) if text else {}
    except ValueError:
        prev = {}
    by_cron = dict(prev.get("byCron") or {})
    by_cron[cron] = int(by_cron.get(cron, 0)) + 1          # which schedule fired, and how often each did (the shadow has two)
    beat = {"at": now.isoformat(), "cron": cron, "fires": int(prev.get("fires", 0)) + 1, "byCron": by_cron,
            "firstFireAt": prev.get("firstFireAt") or now.isoformat(), "scriptHash": script_hash.SCRIPT_HASH}
    await out_store.put_text("heartbeat.json", json.dumps(beat), "application/json", "no-store")
    return beat
