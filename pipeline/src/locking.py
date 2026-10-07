"""A run lock in D1 so a manual "Refresh data now" can never overlap the cron (two runs writing the same pointer).

One row in `pipeline_lock` (schema-v2.sql; needs a manual CREATE TABLE on D1 like the other tables). acquire() is a single
conditional UPDATE: it succeeds only when the previous holder released (locked_until = 0) or its lease ran out, so a run that
crashed mid-way never blocks the pipeline for longer than the lease.
"""
LOCK_ID = "conditions"
DEFAULT_LEASE_MS = 15 * 60 * 1000  # far longer than a run (~1 min) and far shorter than the 3-hour schedule


async def _changes(result):
    """D1's run() result carries meta.changes; works for the real binding (a JS object) and for the test fake (a dict)."""
    meta = result["meta"] if isinstance(result, dict) else result.meta
    return int(meta["changes"] if isinstance(meta, dict) else meta.changes)


async def acquire(db, run_id, now_ms, lease_ms=DEFAULT_LEASE_MS):
    await db.prepare("INSERT OR IGNORE INTO pipeline_lock (id, run_id, locked_until) VALUES (?, '', 0)").bind(LOCK_ID).run()
    res = await db.prepare(
        "UPDATE pipeline_lock SET run_id = ?, locked_until = ? WHERE id = ? AND locked_until < ?"
    ).bind(run_id, now_ms + lease_ms, LOCK_ID, now_ms).run()
    return await _changes(res) == 1


async def release(db, run_id):
    """Only the holder can release (a run whose lease already expired must not free a newer run's lock)."""
    await db.prepare("UPDATE pipeline_lock SET locked_until = 0 WHERE id = ? AND run_id = ?").bind(LOCK_ID, run_id).run()
