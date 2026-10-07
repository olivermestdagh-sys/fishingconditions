"""TEMPORARY MEASUREMENT MODE for the shadow Worker. Delete this file (and the 4-line hook in shadow.process_pending) once the heap question is closed.

Question it answers: does the Python heap of a warm isolate keep growing from replay to replay, or does it plateau, and what is retained in between?

It is asked for by putting a request object in the PRIVATE shadow bucket:   recordings/_measure.json   =   {"id": "<recording id>", "repeats": 5}
The next scheduled fire (any cron) then replays that one recording `repeats` times back to back IN THE SAME ISOLATE and writes shadow/measure-result.json
(and deletes the request, so it runs once). It writes NOTHING else that matters: no index entry, no compare report, no streak effect. The replay is the
normal service.run_pipeline replay (same lock, NullNet, shadow/ view of the bucket), so what it measures is what a real replay costs.

Per replay it records: the wasm linear-memory size (js heap, never shrinks), sys.getallocatedblocks() (live small-object blocks), the number of objects the
garbage collector tracks, and the same three after gc.collect(); at the end, which object TYPES grew between the first and the last replay and how big the
module-level structures the script keeps are. Type names and counts only: no location names, no values.
"""
import gc
import json
import sys

import publish
import service

REQUEST_KEY = "recordings/_measure.json"
RESULT_KEY = "measure-result.json"       # under the shadow/ view
MAX_REPEATS = 8


def _type_counts():
    counts = {}
    for o in gc.get_objects():
        n = type(o).__name__
        counts[n] = counts.get(n, 0) + 1
    return counts


def _snap(probe):
    return {"wasmMb": probe() if probe else None, "liveBlocks": sys.getallocatedblocks(), "gcObjects": len(gc.get_objects())}


def _module_state():
    """Sizes of what the script and the runner keep at module level between runs (counts, not contents)."""
    import fetch_conditions as fc
    out = {"ARCHIVE_BY_LOCATION.locations": len(fc.ARCHIVE_BY_LOCATION)}
    try:
        out["ARCHIVE_BY_LOCATION.approxKB"] = round(len(json.dumps(fc.ARCHIVE_BY_LOCATION, default=str)) / 1024)
    except Exception:  # noqa: BLE001
        out["ARCHIVE_BY_LOCATION.approxKB"] = None
    out["sys.modules"] = len(sys.modules)
    return out


async def run_request(cfg, rec_store, out_store, db, now, probe, log=print):
    """Handle a pending measurement request. Returns the result dict (also written to shadow/measure-result.json)."""
    import shadow
    req = json.loads(await rec_store.get_text(REQUEST_KEY))
    rec_id, repeats = req["id"], max(1, min(int(req.get("repeats", 5)), MAX_REPEATS))
    result = {"schema": 1, "TEMPORARY": "heap measurement; see shadow_measure.py", "recording": rec_id, "repeats": repeats, "startedAt": now.isoformat(), "runs": []}
    # delete the request first: a crash must not make every following fire repeat a multi-minute measurement
    await rec_store.delete_key(REQUEST_KEY)
    bundle_text = await rec_store.get_text(f"recordings/{rec_id}.json")
    gc.collect()
    result["before"] = {**_snap(probe), **_module_state()}
    types_before = _type_counts()
    for n in range(1, repeats + 1):
        bundle, replay = shadow.parse_bundle(bundle_text)
        import datetime as dt
        run_start = dt.datetime.fromisoformat(bundle["runStart"])
        from net import NullNet
        ident = {}

        async def inspect(r):
            c = await shadow.compare_outputs(bundle, r)
            ident["identical"] = c["identical"]
            return {"identical": c["identical"]}

        summary = await service.run_pipeline(cfg, NullNet(), out_store, db, now, "shadow", run_id=rec_id, replay=replay, lock_id="shadow",
                                             generated_at=run_start.isoformat(), inspect=inspect, probe=probe, log=lambda *a: None, python_version="shadow")
        del bundle, replay
        entry = {"n": n, "identical": ident.get("identical"), "error": summary.get("error"), "afterReplay": _snap(probe)}
        collected = gc.collect()
        entry["gcCollected"] = collected
        entry["afterCollect"] = _snap(probe)
        entry["state"] = _module_state()
        result["runs"].append(entry)
        log(f"measure run {n}/{repeats}: wasm {entry['afterReplay']['wasmMb']} MB, live blocks {entry['afterCollect']['liveBlocks']}, identical {entry['identical']}")
        del summary
    types_after = _type_counts()
    growth = sorted(((types_after.get(k, 0) - types_before.get(k, 0), k) for k in types_after), reverse=True)[:12]
    result["typeGrowthFirstToLast"] = [{"type": k, "delta": d} for d, k in growth if d]
    result["finishedAt"] = now.isoformat()
    await out_store.put_text(RESULT_KEY, publish.dumps(result), "application/json")
    return result
