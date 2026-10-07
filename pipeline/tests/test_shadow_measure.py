"""The TEMPORARY heap measurement mode (src/shadow_measure.py): it must never touch the index, the compare reports or the streak."""
import json
import unittest

import synth
from synth import FakeDB, FakeStore

import shadow_measure
from test_shadow import make_bundle, put_bundle, process, run, NOW


class Measure(unittest.TestCase):
    def test_a_request_replays_the_recording_n_times_writes_a_result_and_touches_nothing_else(self):
        bundle, _ = make_bundle()
        bucket = FakeStore()
        put_bundle(bucket, bundle)
        bucket.all[shadow_measure.REQUEST_KEY] = json.dumps({"id": bundle["runId"], "repeats": 3})
        done = process(bucket, FakeDB(), probe=lambda: 60.0)
        self.assertEqual(done, [])                                              # no normal replay happened
        self.assertNotIn(shadow_measure.REQUEST_KEY, bucket.all)                # the request ran once and is gone
        self.assertNotIn("shadow/index.json", bucket.objects)                   # no index entry: the streak cannot be touched
        self.assertFalse([k for k in bucket.objects if k.startswith("shadow/compare/")])
        res = json.loads(bucket.objects["shadow/measure-result.json"])
        self.assertEqual(res["repeats"], 3)
        self.assertEqual([r["n"] for r in res["runs"]], [1, 2, 3])
        self.assertTrue(all(r["identical"] and r["error"] is None for r in res["runs"]))
        self.assertTrue(all(r["afterCollect"]["wasmMb"] == 60.0 and r["afterCollect"]["liveBlocks"] > 0 for r in res["runs"]))
        self.assertIn("ARCHIVE_BY_LOCATION.locations", res["before"])
        # the next fire is a normal one again: the recording is replayed and counted as usual
        self.assertEqual(len(process(bucket, FakeDB())), 1)

    def test_repeats_are_capped(self):
        bundle, _ = make_bundle()
        bucket = FakeStore()
        put_bundle(bucket, bundle)
        bucket.all[shadow_measure.REQUEST_KEY] = json.dumps({"id": bundle["runId"], "repeats": 500})
        process(bucket, FakeDB())
        self.assertEqual(json.loads(bucket.objects["shadow/measure-result.json"])["repeats"], shadow_measure.MAX_REPEATS)


if __name__ == "__main__":
    unittest.main()


class MeasureNormalPath(unittest.TestCase):
    def test_normal_mode_runs_the_real_path_on_a_scratch_prefix_and_leaves_shadow_alone(self):
        bundle, _ = make_bundle()
        bucket = FakeStore()
        put_bundle(bucket, bundle)
        bucket.all[shadow_measure.REQUEST_KEY] = json.dumps({"id": bundle["runId"], "repeats": 3, "normal": True})
        process(bucket, FakeDB(), probe=lambda: 60.0)
        self.assertNotIn("shadow/index.json", bucket.objects)
        self.assertFalse([k for k in bucket.objects if k.startswith("shadow/compare/") or k.startswith("shadow/runs/")])
        self.assertIn("shadow-measure/index.json", bucket.objects)               # the scratch copy of the real path
        res = json.loads(bucket.objects["shadow/measure-result-normal.json"])
        self.assertEqual([r["n"] for r in res["runs"]], [1, 2, 3])
        self.assertTrue(all(r["identical"] and r["clean"] for r in res["runs"]))
        self.assertEqual([r["isolate"]["replayNo"] for r in res["runs"]], [res["runs"][0]["isolate"]["replayNo"] + i for i in range(3)])
        self.assertTrue(all(r["heapMb"] == 60.0 and r["heapBeforeMb"] == 60.0 and r["heapGrowthMb"] == 0.0 for r in res["runs"]))
