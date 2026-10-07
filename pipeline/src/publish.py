"""What gets written to R2, where, and whether it is allowed to replace the last good run. Pure functions: no Cloudflare calls.

LAYOUT (public bucket; the same layout, under an `owner/<userId>/` prefix, is reserved for a later PRIVATE bucket):

    latest.json                       {"runId", "generatedAt", "schema", "conditions", "graphIndex", "locations", "manifest"}
                                      the ONLY mutable pointer; written LAST, after everything it names exists
    status.json                       small run/staleness summary for the in-site banner and the alert (no location data)
    heartbeat.json                    proof the cron reached the Worker
    runs/<runId>/conditions.json      immutable: cache them for a year
    runs/<runId>/locations.json
    runs/<runId>/graph/index.json
    runs/<runId>/graph/<hash>.json
    runs/<runId>/manifest.json        every object of the run with its size and sha-256, counts, fetch stats, gate verdict

PRIVACY: the script computes every owner's locations (D1 holds Public's and each user's own). Only Public's are published.
`iter_owner_objects(owner, ...)` is owner-parameterised so a later stage can emit each other owner's files to a private
bucket under `owner_prefix(owner)` without touching this module's callers.
"""
import hashlib
import json
import os

PUBLIC_OWNER = "public"
SCHEMA = 1
# Same dump settings as the script uses for conditions.json (compact, no ASCII escaping).
_DUMP = dict(separators=(",", ":"), ensure_ascii=False, default=str)


def dumps(obj):
    return json.dumps(obj, **_DUMP)


def owner_prefix(owner):
    return "" if owner == PUBLIC_OWNER else f"owner/{owner}/"


def run_prefix(run_id, owner=PUBLIC_OWNER):
    return f"{owner_prefix(owner)}runs/{run_id}/"


def latest_key(owner=PUBLIC_OWNER):
    return f"{owner_prefix(owner)}latest.json"


def sha256_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- partitioning by owner

def _read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def owners_in(conditions_obj):
    return sorted({l.get("ownerId") or PUBLIC_OWNER for l in conditions_obj.get("locations", [])})


def filter_conditions(conditions_text, owner):
    """conditions.json for one owner: that owner's locations, their rows and sun times. Moon phases are global.
    Returns (text, counts)."""
    obj = json.loads(conditions_text)
    keep = [l for l in obj["locations"] if (l.get("ownerId") or PUBLIC_OWNER) == owner]
    pairs = {(l["name"], l.get("type")) for l in keep}
    names = {l["name"] for l in keep}
    rows = [r for r in obj["rows"] if (r.get("Location Name"), r.get("Type")) in pairs]
    out = dict(obj)  # keeps the script's key order
    out["locations"] = keep
    out["rows"] = rows
    out["sunTimes"] = {k: v for k, v in obj.get("sunTimes", {}).items() if k in names}
    return dumps(out), {"locations": len(keep), "rows": len(rows)}


def filter_graph_index(index_text, owner):
    """(index text for the owner, [graph file names it lists])."""
    obj = json.loads(index_text)
    keep = [e for e in obj["locations"] if (e.get("ownerId") or PUBLIC_OWNER) == owner]
    out = dict(obj)
    out["locations"] = keep
    return dumps(out), [e["file"] for e in keep]


def filter_export(export_text, owner):
    """config/locations.json export (a list, one entry per location with its types)."""
    arr = json.loads(export_text)
    # Written with indent=2 by the script today; keep that so the file looks the same.
    return json.dumps([e for e in arr if (e.get("ownerId") or PUBLIC_OWNER) == owner], indent=2) + "\n"


def iter_owner_objects(owner, result):
    """Yield (relative key, text, content-type) for one owner, one object at a time, from the script's output files.

    `result` is runner.run()'s dict. The big conditions file is yielded first and the caller drops each text before taking
    the next, so only one object is ever held.
    """
    text, counts = filter_conditions(_read(result["conditions"]), owner)
    yield "conditions.json", text, counts
    del text
    index_text, files = filter_graph_index(_read(os.path.join(result["graph_dir"], "index.json")), owner)
    for name in files:
        yield f"graph/{name}", _read(os.path.join(result["graph_dir"], name)), None
    yield "graph/index.json", index_text, None
    yield "locations.json", filter_export(_read(result["export"]), owner), None


# ---------------------------------------------------------------- manifest / pointer

def make_run_id(now):
    """Sortable (UTC timestamp), so 'newest' is a string sort. `now` is an aware or naive-UTC datetime."""
    return now.strftime("%Y%m%dT%H%M%SZ")


def make_manifest(run_id, generated_at, objects, counts, fetch, gate, python_version, owner=PUBLIC_OWNER):
    return {
        "schema": SCHEMA, "runId": run_id, "owner": owner, "generatedAt": generated_at, "python": python_version,
        "counts": counts, "objects": objects, "fetch": fetch, "gate": gate,
    }


def make_latest(run_id, generated_at, owner=PUBLIC_OWNER):
    p = run_prefix(run_id, owner)
    return {
        "schema": SCHEMA, "runId": run_id, "generatedAt": generated_at,
        "conditions": p + "conditions.json", "graphIndex": p + "graph/index.json",
        "locations": p + "locations.json", "manifest": p + "manifest.json",
    }


# ---------------------------------------------------------------- publish gate

def evaluate_gate(prev_manifest, current, *, min_fresh_fraction=0.8, min_rows_fraction=0.7):
    """May this run replace the last good one? Returns {"ok": bool, "reasons": [...], "checks": {...}}.

    current: {"physical": locations tried, "weather_ok": of those, how many returned WillyWeather data,
              "rows": published rows, "public_locations": published location entries, "misses": prefetch misses,
              "valid": the output parsed and has locations + rows}
    prev_manifest: the last published run's manifest, or None (first run: only the absolute checks apply).
    """
    reasons = []
    if not current.get("valid"):
        reasons.append("output did not parse or has no locations/rows")
    physical = current.get("physical", 0)
    if physical <= 0:
        reasons.append("no locations were loaded")
    else:
        frac = current.get("weather_ok", 0) / physical
        if frac < min_fresh_fraction:
            reasons.append(f"only {current.get('weather_ok', 0)} of {physical} locations returned weather data ({frac:.0%} < {min_fresh_fraction:.0%})")
    if current.get("public_locations", 0) <= 0:
        reasons.append("no public locations in the output")
    if prev_manifest:
        prev_rows = (prev_manifest.get("counts") or {}).get("rows") or 0
        if prev_rows and current.get("rows", 0) < prev_rows * min_rows_fraction:
            reasons.append(f"{current.get('rows', 0)} rows is under {min_rows_fraction:.0%} of the last run's {prev_rows}")
    return {"ok": not reasons, "reasons": reasons, "checks": {k: current.get(k) for k in ("physical", "weather_ok", "rows", "public_locations", "misses")}}


def weather_ok_count(raw, physical):
    """How many locations came back with WillyWeather data: the non-empty `weather:<id>` responses in `raw` (a location that
    was re-resolved contributes its NEW id's response, a dead cached id's empty one does not count), capped at `physical`."""
    import plan  # local import: plan imports fetch_conditions
    ok = sum(1 for k, v in raw.items() if k.startswith("weather:") and plan._has_data(v))
    return min(ok, physical)


# ---------------------------------------------------------------- retention

def runs_to_delete(run_ids, keep, current_run_id=None):
    """Old run ids to remove: everything but the newest `keep`, never the one `latest.json` points at."""
    ordered = sorted(run_ids, reverse=True)
    doomed = ordered[keep:]
    return [r for r in doomed if r != current_run_id]
