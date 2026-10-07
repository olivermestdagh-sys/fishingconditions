"""(1) The script's output folder (a full copy of every owner's rows) is never left behind. (2) A shadow fire with nothing new is a cheap no-op
that touches no D1, and a recording can never count twice, however many times the cron fires."""
import asyncio
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

import recording_world as rw
import synth
from synth import FakeDB, FakeNetwork, FakeStore

import net as netmod
import runner
import service
import shadow

NOW = datetime(2026, 10, 7, 5, 30, tzinfo=timezone.utc)
FIRE = datetime(2026, 10, 7, 6, 40, tzinfo=timezone.utc)


def run(coro):
    return asyncio.run(coro)


class Isolated(unittest.TestCase):
    """Each test gets its own temp root, so 'nothing left behind' can be asserted exactly."""

    def setUp(self):
        self._t = tempfile.TemporaryDirectory()
        self._old = tempfile.tempdir
        tempfile.tempdir = self._t.name
        self.root = self._t.name

    def tearDown(self):
        tempfile.tempdir = self._old
        self._t.cleanup()

    def leftovers(self):
        return sorted(os.listdir(self.root))


class OutputFolderIsRemoved(Isolated):
    def test_runner_leaves_its_folder_until_cleanup_then_nothing(self):
        locs = synth.locations()
        result = runner.run(locs, synth.responses(locs), None, synth.KEY, frozen_iso=synth.NOW_ISO)
        self.assertEqual(len(self.leftovers()), 1)              # the caller owns it now...
        self.assertTrue(os.path.exists(result["conditions"]))
        runner.cleanup(result)
        self.assertEqual(self.leftovers(), [])                   # ...and it is really gone
        runner.cleanup(result)                                   # twice is fine
        runner.cleanup(None)                                     # and so is nothing

    def test_a_failing_script_leaves_nothing_behind(self):
        locs = synth.locations()
        with self.assertRaises(RuntimeError):
            runner.run(locs, synth.responses(locs), None, "", frozen_iso=synth.NOW_ISO)   # no key: the script exits 1
        self.assertEqual(self.leftovers(), [])

    def _pipeline(self, locs, resp, **cfg):
        network = FakeNetwork(locs, resp)
        n = netmod.Net(network.transport, secret=synth.KEY, backoff=0, sleep=lambda s: asyncio.sleep(0))
        base = dict(api_key=synth.KEY, pipeline_url=synth.PIPELINE_URL, pipeline_token=synth.TOKEN, keep_runs=3)
        base.update(cfg)
        return run(service.run_pipeline(service.Config(**base), n, FakeStore(), FakeDB(), NOW, "cron", frozen_iso=NOW.isoformat(), log=lambda *a: None))

    def test_a_published_run_leaves_nothing_behind(self):
        locs = synth.locations()
        s = self._pipeline(locs, synth.responses(locs))
        self.assertTrue(s["published"])
        self.assertEqual(self.leftovers(), [])

    def test_a_refused_run_leaves_nothing_behind(self):
        locs = synth.locations()
        resp = {k: v for k, v in synth.responses(locs).items() if not k.startswith("weather:")}
        s = self._pipeline(locs, resp)
        self.assertFalse(s["published"])
        self.assertEqual(self.leftovers(), [])

    def test_a_failed_run_leaves_nothing_behind(self):
        s = self._pipeline(synth.locations(), synth.responses(), api_key="")
        self.assertFalse(s["ok"])
        self.assertEqual(self.leftovers(), [])

    def test_a_shadow_replay_leaves_nothing_behind(self):
        locs = synth.locations()
        outs, bundle, code, _ = rw.run_recorder(locs, synth.responses(locs), None, synth.KEY, NOW)
        # the recorder's own temp dirs are TemporaryDirectory contexts: gone already
        self.assertEqual(self.leftovers(), [])
        bucket = FakeStore()
        bucket.all[f"recordings/{bundle['runId']}.json"] = json.dumps(bundle, ensure_ascii=False)
        cfg = service.Config(api_key="", pipeline_url="https://pipeline.invalid", pipeline_token="", keep_runs=3)
        done = run(shadow.process_pending(cfg, bucket, bucket.view("shadow/"), FakeDB(), FIRE, log=lambda *a: None))
        self.assertTrue(done[0]["clean"])
        self.assertEqual(self.leftovers(), [])

    def test_a_mismatch_replay_leaves_nothing_behind_either(self):
        locs = synth.locations()
        outs, bundle, code, _ = rw.run_recorder(locs, synth.responses(locs), None, synth.KEY, NOW)
        bundle["expected"]["conditions"] = "0" * 64
        bucket = FakeStore()
        bucket.all[f"recordings/{bundle['runId']}.json"] = json.dumps(bundle, ensure_ascii=False)
        cfg = service.Config(api_key="", pipeline_url="https://pipeline.invalid", pipeline_token="", keep_runs=3)
        done = run(shadow.process_pending(cfg, bucket, bucket.view("shadow/"), FakeDB(), FIRE, log=lambda *a: None))
        self.assertFalse(done[0]["clean"])
        self.assertEqual(self.leftovers(), [])


def recorded_bucket(n=1):
    """A bucket holding n distinct recordings of the synthetic world."""
    locs = synth.locations()
    bucket = FakeStore()
    ids = []
    for i in range(n):
        outs, bundle, code, _ = rw.run_recorder(locs, synth.responses(locs), None, synth.KEY, NOW - timedelta(hours=3 * (n - 1 - i)))
        bucket.all[f"recordings/{bundle['runId']}.json"] = json.dumps(bundle, ensure_ascii=False)
        ids.append(bundle["runId"])
    return bucket, ids


def cfg():
    return service.Config(api_key="", pipeline_url="https://pipeline.invalid", pipeline_token="", keep_runs=3)


def fire(bucket, db=None, now=FIRE):
    return run(shadow.process_pending(cfg(), bucket, bucket.view("shadow/"), db, now, log=lambda *a: None))


class NoOpFiresAreCheapAndIdempotent(Isolated):
    def test_a_fire_on_an_empty_bucket_is_one_list_and_nothing_else(self):
        bucket = FakeStore()
        db = FakeDB()
        statements = []
        real = db.prepare
        db.prepare = lambda sql: (statements.append(sql), real(sql))[1]
        self.assertEqual(fire(bucket, db), [])
        self.assertEqual(bucket.ops, {"get": 0, "head": 0, "put": 0, "list": 1, "delete": 0})
        self.assertEqual(statements, [])                         # no D1 at all

    def test_a_fire_with_everything_already_replayed_is_one_list_plus_one_index_read(self):
        bucket, ids = recorded_bucket(2)
        self.assertEqual(len(fire(bucket, FakeDB())), 1)   # one recording per fire
        self.assertEqual(len(fire(bucket, FakeDB())), 1)
        bucket.reset_ops()
        db = FakeDB()
        statements = []
        real = db.prepare
        db.prepare = lambda sql: (statements.append(sql), real(sql))[1]
        self.assertEqual(fire(bucket, db), [])
        self.assertEqual(bucket.ops, {"get": 1, "head": 0, "put": 0, "list": 1, "delete": 0})   # list recordings/ + read index.json
        self.assertEqual(statements, [])                                                         # still no D1

    def test_the_heartbeat_adds_one_read_and_one_write_and_counts_fires(self):
        bucket = FakeStore()
        out = bucket.view("shadow/")
        b1 = run(shadow.touch_heartbeat(out, FIRE, "*/15 * * * *"))
        self.assertEqual((b1["fires"], b1["cron"]), (1, "*/15 * * * *"))
        bucket.reset_ops()
        b2 = run(shadow.touch_heartbeat(out, FIRE + timedelta(minutes=5), "40 */3 * * *"))
        self.assertEqual((b2["fires"], b2["firstFireAt"]), (2, FIRE.isoformat()))
        self.assertEqual(b2["cron"], "40 */3 * * *")                                       # the string that fired THIS time
        b3 = run(shadow.touch_heartbeat(out, FIRE + timedelta(minutes=15), "*/15 * * * *"))
        self.assertEqual(b3["byCron"], {"*/15 * * * *": 2, "40 */3 * * *": 1})              # and how often each schedule has fired
        self.assertEqual(bucket.ops["get"], 2)   # two touches since the reset (the second heartbeat in this test)
        self.assertEqual(bucket.ops["put"], 2)

    def test_many_fires_replay_a_recording_exactly_once(self):
        bucket, ids = recorded_bucket(1)
        first = fire(bucket, FakeDB())
        self.assertEqual([e["id"] for e in first], ids)
        for i in range(13):                                      # the 13 fires of a */5 test
            self.assertEqual(fire(bucket, FakeDB(), FIRE + timedelta(minutes=5 * (i + 1))), [])
        index = json.loads(bucket.objects["shadow/index.json"])
        self.assertEqual([c["id"] for c in index["cycles"]], ids)
        self.assertEqual(sum(1 for w in bucket.all_writes if w == f"shadow/compare/{ids[0]}.json"), 1)

    def test_a_replay_that_died_before_its_index_entry_is_retried_but_never_counted_twice(self):
        bucket, ids = recorded_bucket(1)
        fire(bucket, FakeDB())
        # simulate a crash AFTER compare/ and runs/ were written but BEFORE the index entry: remove the entry
        del bucket.all["shadow/index.json"]
        again = fire(bucket, FakeDB(), FIRE + timedelta(minutes=5))
        self.assertEqual([e["id"] for e in again], ids)
        index = json.loads(bucket.objects["shadow/index.json"])
        self.assertEqual(len(index["cycles"]), 1)                # one entry for the one recording, whatever happened
        self.assertEqual(fire(bucket, FakeDB(), FIRE + timedelta(minutes=10)), [])

    def test_an_errored_recording_is_reported_once_not_retried_every_fire(self):
        bucket = FakeStore()
        bucket.all["recordings/20261007T020000Z.json"] = "{not json"
        self.assertEqual(len(fire(bucket, FakeDB())), 1)
        self.assertEqual(fire(bucket, FakeDB(), FIRE + timedelta(minutes=5)), [])
        index = json.loads(bucket.objects["shadow/index.json"])
        self.assertEqual([c["clean"] for c in index["cycles"]], [False])

    def test_the_streak_counts_distinct_recordings_whatever_the_number_of_fires(self):
        # the index is the verifier's only source of cycles, and it holds one entry per recording id
        bucket, ids = recorded_bucket(3)
        for i in range(6):
            fire(bucket, FakeDB(), FIRE + timedelta(minutes=5 * i))
        index = json.loads(bucket.objects["shadow/index.json"])
        self.assertEqual(len(index["cycles"]), 3)
        self.assertEqual(sorted(c["id"] for c in index["cycles"]), sorted(ids))
        self.assertTrue(all(c["clean"] for c in index["cycles"]))


if __name__ == "__main__":
    unittest.main()
