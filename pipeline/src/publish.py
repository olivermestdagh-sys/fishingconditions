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
    runs/<runId>/manifest.json        every object of the run with its size and sha-256, PUBLIC counts, gate verdict

PRIVACY (fail closed). The script computes every owner's locations (D1 holds Public's and each user's own). Only locations whose
ownerId is exactly "public" are published: a missing/odd ownerId is NOT public. Everything written to the public bucket, including
manifest.json and status.json, carries only Public-scoped numbers: no all-owner totals (they would reveal how many private
locations exist), no raw error text.

NAME CLASHES. The `locations` table has no unique name, and fetch_conditions.py keys its rows, sun times and graph groups by NAME
(and type). When a non-public location shares a name with a public one, the script mixes their rows under one key and they can no
longer be told apart. Those public pairs are WITHHELD from the public output (never published mixed) and counted in
counts.ambiguous; renaming the private location, or the per-owner runs of the private-bucket stage, resolves it.

`iter_owner_objects(owner, ...)` is owner-parameterised so a later stage can emit each other owner's files to a private bucket under
`owner_prefix(owner)` without touching its callers.
"""
import hashlib
import json
import os
import re

PUBLIC_OWNER = "public"
SCHEMA = 1
RUN_ID_RE = re.compile(r"^\d{8}T\d{6}Z$")
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


def _owner(entry):
    """An entry's owner. FAIL CLOSED: anything but a real ownerId is its own non-public bucket, never 'public'."""
    o = entry.get("ownerId")
    return o if isinstance(o, str) and o else "unknown"


# ---------------------------------------------------------------- partitioning by owner

def _read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def owners_in(conditions_obj):
    return sorted({_owner(l) for l in conditions_obj.get("locations", [])})


def ambiguous_names(locations, owner):
    """Names this owner shares with ANY location of another owner: the script cannot tell those apart (see NAME CLASHES)."""
    mine = {l["name"] for l in locations if _owner(l) == owner}
    theirs = {l["name"] for l in locations if _owner(l) != owner}
    return mine & theirs


def filter_conditions_obj(obj, owner, run_as_of=None):
    """(filtered dict, counts, withheld_names). counts: locations, rows, pairs, freshPairs (pairs with a forecast row at/after run_as_of,
    i.e. fed by THIS run's data, not only carried history), ambiguous (withheld names)."""
    withheld = ambiguous_names(obj["locations"], owner)
    keep = [l for l in obj["locations"] if _owner(l) == owner and l["name"] not in withheld]
    pairs = {(l["name"], l.get("type")) for l in keep}
    names = {l["name"] for l in keep}
    rows = [r for r in obj["rows"] if (r.get("Location Name"), r.get("Type")) in pairs]
    fresh = set()
    if run_as_of:
        for r in rows:
            if str(r.get("dateTime", "")) >= run_as_of:
                fresh.add((r.get("Location Name"), r.get("Type")))
    else:
        fresh = set(pairs)
    out = dict(obj)  # keeps the script's key order
    out["locations"] = keep
    out["rows"] = rows
    out["sunTimes"] = {k: v for k, v in obj.get("sunTimes", {}).items() if k in names}
    counts = {"locations": len(keep), "rows": len(rows), "pairs": len(pairs), "freshPairs": len(fresh), "ambiguous": len(withheld)}
    return out, counts, withheld


def filter_conditions(conditions_text, owner, run_as_of=None):
    out, counts, _ = filter_conditions_obj(json.loads(conditions_text), owner, run_as_of)
    return dumps(out), counts


def filter_graph_index(index_text, owner, withheld=frozenset()):
    """(index text for the owner, [graph file names it lists])."""
    obj = json.loads(index_text)
    keep = [e for e in obj["locations"] if _owner(e) == owner and e.get("name") not in withheld]
    out = dict(obj)
    out["locations"] = keep
    return dumps(out), [e["file"] for e in keep]


def filter_export(export_text, owner, withheld=frozenset()):
    """config/locations.json export (a list, one entry per location with its types)."""
    arr = json.loads(export_text)
    # Written with indent=2 by the script today; keep that so the file looks the same.
    return json.dumps([e for e in arr if _owner(e) == owner and e.get("name") not in withheld], indent=2) + "\n"


def iter_owner_objects(owner, result, run_as_of=None):
    """Yield (relative key, text, counts-or-None) for one owner, one object at a time, from the script's output files.

    `result` is runner.run()'s dict. The big conditions file is yielded first (with the counts the publish gate needs) and the caller
    drops each text before taking the next, so only one object is ever held.
    """
    obj = json.loads(_read(result["conditions"]))
    filtered, counts, withheld = filter_conditions_obj(obj, owner, run_as_of if run_as_of is not None else result.get("run_as_of"))
    del obj
    text = dumps(filtered)
    del filtered
    yield "conditions.json", text, counts
    del text
    index_text, files = filter_graph_index(_read(os.path.join(result["graph_dir"], "index.json")), owner, withheld)
    for name in files:
        yield f"graph/{name}", _read(os.path.join(result["graph_dir"], name)), None
    yield "graph/index.json", index_text, None
    yield "locations.json", filter_export(_read(result["export"]), owner, withheld), None


# ---------------------------------------------------------------- manifest / pointer

def make_run_id(now):
    """Sortable (UTC timestamp), so 'newest' is a string sort. `now` is an aware or naive-UTC datetime."""
    return now.strftime("%Y%m%dT%H%M%SZ")


def make_manifest(run_id, generated_at, objects, counts, gate, python_version, owner=PUBLIC_OWNER):
    """PUBLIC document: Public-scoped counts only (no fetch statistics, no all-owner totals)."""
    return {
        "schema": SCHEMA, "runId": run_id, "owner": owner, "generatedAt": generated_at, "python": python_version,
        "counts": counts, "objects": objects, "gate": gate,
    }


def make_latest(run_id, generated_at, owner=PUBLIC_OWNER):
    p = run_prefix(run_id, owner)
    return {
        "schema": SCHEMA, "runId": run_id, "generatedAt": generated_at,
        "conditions": p + "conditions.json", "graphIndex": p + "graph/index.json",
        "locations": p + "locations.json", "manifest": p + "manifest.json",
    }


# ---------------------------------------------------------------- publish gate

def evaluate_gate(prev_manifest, current, *, min_fresh_fraction=0.8, min_rows_fraction=0.7, force=False):
    """May this run replace the last good one? Returns {"ok", "forced", "reasons", "checks"}. Every number is PUBLIC-scoped.

    current: {"pairs": public (location, type) pairs published, "fresh_pairs": of those, how many got forecast rows from THIS run
              (judged from what the script actually produced, so a shared WillyWeather id or a prefetch drift cannot hide a gap),
              "rows", "locations": public location entries, "unplanned": requests the script made that prefetch never planned
              (plan drift), "valid": the output parsed and has locations + rows}
    prev_manifest: the last published run's manifest, or None (first run: only the absolute checks apply).

    The row-drop check compares rows PER LOCATION with the last run, so removing locations (or types) is not a "drop": otherwise a
    legitimate shrink would be refused forever. `force` (an admin override) publishes anyway and records that it did.
    """
    reasons = []
    if not current.get("valid"):
        reasons.append("output did not parse or has no public locations/rows")
    pairs = current.get("pairs", 0)
    if pairs <= 0:
        reasons.append("no public locations in the output")
    else:
        frac = current.get("fresh_pairs", 0) / pairs
        if frac < min_fresh_fraction:
            reasons.append(f"only {current.get('fresh_pairs', 0)} of {pairs} public location/type pairs have fresh forecast data ({frac:.0%} < {min_fresh_fraction:.0%})")
    if current.get("unplanned", 0) > 0:
        reasons.append(f"the script asked for {current['unplanned']} responses that were never prefetched (plan drift)")
    if prev_manifest:
        pc = prev_manifest.get("counts") or {}
        prev_per = (pc.get("rows") or 0) / pc["locations"] if pc.get("locations") else None
        cur_per = current.get("rows", 0) / current["locations"] if current.get("locations") else 0
        if prev_per and cur_per < prev_per * min_rows_fraction:
            reasons.append(f"{cur_per:.0f} rows per location is under {min_rows_fraction:.0%} of the last run's {prev_per:.0f}")
    ok = not reasons or force
    return {"ok": ok, "forced": bool(force and reasons), "reasons": reasons,
            "checks": {k: current.get(k) for k in ("pairs", "fresh_pairs", "rows", "locations", "unplanned")}}


# ---------------------------------------------------------------- retention

def is_run_id(value):
    return bool(RUN_ID_RE.match(value or ""))


def runs_to_delete(complete_ids, keep, current_run_id=None):
    """Old COMPLETE runs to remove: everything but the newest `keep`, never the one `latest.json` points at."""
    ordered = sorted((i for i in complete_ids if is_run_id(i)), reverse=True)
    return [r for r in ordered[keep:] if r != current_run_id]


def orphans_to_delete(all_ids, complete_ids, current_run_id):
    """Run prefixes with no manifest (a killed run's leftovers) that are OLDER than the run just published. Prefixes that are not run
    ids at all, and anything newer than the current run (it could be in flight), are never touched."""
    done = set(complete_ids)
    return [i for i in all_ids if is_run_id(i) and i not in done and i < current_run_id]
