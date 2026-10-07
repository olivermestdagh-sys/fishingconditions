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


async def acquire(db, run_id, now_ms, lease_ms=DEFAULT_LEASE_MS, lock_id=LOCK_ID):
    """lock_id: production uses "conditions", the shadow Worker "shadow": same table, separate rows, so they can never block each other."""
    await db.prepare("INSERT OR IGNORE INTO pipeline_lock (id, run_id, locked_until) VALUES (?, '', 0)").bind(lock_id).run()
    res = await db.prepare(
        "UPDATE pipeline_lock SET run_id = ?, locked_until = ? WHERE id = ? AND locked_until < ?"
    ).bind(run_id, now_ms + lease_ms, lock_id, now_ms).run()
    return await _changes(res) == 1


async def release(db, run_id, lock_id=LOCK_ID):
    """Only the holder can release (a run whose lease already expired must not free a newer run's lock)."""
    await db.prepare("UPDATE pipeline_lock SET locked_until = 0 WHERE id = ? AND run_id = ?").bind(lock_id, run_id).run()


async def holds(db, run_id, now_ms, lock_id=LOCK_ID):
    """Does `run_id` still hold an unexpired lease? Checked just before latest.json is flipped: a run that overran its lease while a
    newer run took over must not publish over it."""
    row = await db.prepare("SELECT run_id, locked_until FROM pipeline_lock WHERE id = ?").bind(lock_id).first()
    if row is None:
        return False
    return row["run_id"] == run_id and int(row["locked_until"]) >= now_ms
