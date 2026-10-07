"""The recorder (scripts/record_run.py) and SHADOW mode (pipeline/src/shadow.py): the recorder must not change what the script does, a
recording must replay to the same bytes, shadow must make no requests / send no writes / write nothing outside shadow/, and anything wrong
(a changed answer, a changed write, a leaked private name, too much memory, a broken recording) must show up as an unclean cycle."""
import asyncio
import json
import os
import tempfile
import tomllib
import unittest
from datetime import datetime, timedelta, timezone

import recording_world as rw
import synth
from synth import FakeDB, FakeStore

import net as netmod
import publish
import service
import shadow

START = datetime(2026, 10, 7, 5, 30, 0, 123456, tzinfo=timezone.utc)
NOW = datetime(2026, 10, 7, 6, 40, tzinfo=timezone.utc)


def run(coro):
    return asyncio.run(coro)


def world(locs=None):
    locs = locs or synth.locations()
    return locs, synth.responses(locs)


def cfg():
    return service.Config(api_key="", pipeline_url="https://pipeline.invalid", pipeline_token="", keep_runs=3)


def make_bundle(start=START, locs=None, resp=None, prev=None):
    locs, default = world(locs)
    outputs, bundle, code, path = rw.run_recorder(locs, resp or default, prev, synth.KEY, start)
    assert code == 0 and bundle, "the recorder should have succeeded"
    return bundle, outputs


def put_bundle(store, bundle):
    store.all[f"recordings/{bundle['runId']}.json"] = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"))


def process(bucket, db=None, probe=None, now=NOW):
    out = bucket.view("shadow/")
    return run(shadow.process_pending(cfg(), bucket, out, db, now, probe=probe, log=lambda *a: None))


class RecorderMustNotChangeTheRun(unittest.TestCase):
    def tmp(self):
        """A temporary directory that is removed when the test ends."""
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        return d.name

    def test_recorder_output_is_byte_identical_to_the_plain_script_under_the_same_clock(self):
        locs, resp = world()
        plain, plain_posts = rw.run_plain(locs, resp, None, synth.KEY, START)
        recorded, bundle, code, _ = rw.run_recorder(locs, resp, None, synth.KEY, START)
        self.assertEqual(code, 0)
        self.assertEqual(sorted(plain), sorted(recorded))
        for name in plain:
            self.assertEqual(plain[name], recorded[name], f"{name} differs between the plain script and the recorder")
        self.assertEqual(len(plain), 2 + 5)  # conditions, export, 4 graph files + the graph index

    def test_it_is_also_identical_with_a_previous_output_to_carry_history_from(self):
        locs, resp = world()
        first, _ = rw.run_plain(locs, resp, None, synth.KEY, START - timedelta(hours=3))
        prev = first["data/conditions.json"]
        plain, _ = rw.run_plain(locs, resp, prev, synth.KEY, START)
        recorded, bundle, code, _ = rw.run_recorder(locs, resp, prev, synth.KEY, START)
        for name in plain:
            self.assertEqual(plain[name], recorded[name], name)
        self.assertEqual(bundle["previous"], prev)

    def test_the_recorder_sends_exactly_the_requests_and_writes_the_plain_script_does(self):
        locs, resp = world()
        plain_get, plain_posts, rec_get, rec_posts = [], [], [], []
        with rw.world(locs, resp, None, synth.KEY, self.tmp(), get_log=plain_get, posts=plain_posts):
            rw.fc.datetime = rw.record_run.make_frozen(START)
            rw.fc.main()
        outs, bundle, code, _ = rw.run_recorder(locs, resp, None, synth.KEY, START, get_log=rec_get, posts=rec_posts)
        self.assertEqual(plain_get, rec_get)
        self.assertEqual(plain_posts, rec_posts)

    def test_the_clock_is_pinned_to_the_start_of_the_run(self):
        locs, resp = world()
        _, bundle, _, _ = rw.run_recorder(locs, resp, None, synth.KEY, START)
        cond = json.loads(rw.read_outputs.__globals__["os"].path and _read_conditions(locs, resp))
        self.assertEqual(cond["generatedAt"], START.isoformat())
        self.assertEqual(bundle["runStart"], START.isoformat())

    def test_a_failing_script_exits_nonzero_and_writes_no_recording_so_the_workflow_falls_back(self):
        locs, resp = world()
        outdir = self.tmp()
        rec = self.tmp()
        with rw.world(locs, resp, None, "", outdir):  # no WillyWeather key: the script exits 1 straight away
            code = rw.record_run.main(start=START, record_dir=rec)
        self.assertEqual(code, 1)
        self.assertEqual(os.listdir(rec), [])

    def test_an_unexpected_crash_propagates_so_the_exit_is_nonzero(self):
        locs, resp = world()
        outdir = self.tmp()
        with rw.world(locs, resp, None, synth.KEY, outdir):
            rw.fc.load_locations = lambda: (_ for _ in ()).throw(RuntimeError("boom"))
            with self.assertRaises(RuntimeError):
                rw.record_run.main(start=START, record_dir=self.tmp())

    def test_a_recording_that_cannot_be_written_never_fails_the_data_run(self):
        locs, resp = world()
        blocker = os.path.join(self.tmp(), "not-a-dir")
        open(blocker, "w").close()          # a FILE where the recordings directory should be
        outdir = self.tmp()
        with rw.world(locs, resp, None, synth.KEY, outdir):
            code = rw.record_run.main(start=START, record_dir=blocker)
        self.assertEqual(code, 0)
        self.assertTrue(os.path.exists(os.path.join(outdir, "data", "conditions.json")))

    def test_the_effects_hash_is_the_same_function_in_the_recorder_and_the_worker(self):
        effects = [{"method": "POST", "url": "https://x/api/pipeline/observations", "body": {"b": 1, "a": 2}, "retries": 2},
                   {"method": "PUT", "url": "https://y/api/pipeline/locations/L1", "body": {"willyweatherId": 5}, "retries": 3}]
        self.assertEqual(rw.record_run.effects_hash(effects), shadow.effects_hash(effects))
        self.assertEqual(rw.record_run.effects_hash(effects), rw.record_run.effects_hash(list(reversed(effects))))  # order-independent


def _read_conditions(locs, resp):
    outs, _, _, _ = rw.run_recorder(locs, resp, None, synth.KEY, START)
    return outs["data/conditions.json"]


class NothingToReplay(unittest.TestCase):
    def test_an_empty_recordings_prefix_is_not_an_error_and_writes_nothing(self):
        bucket = FakeStore()
        before = dict(bucket.all)
        self.assertEqual(process(bucket, FakeDB()), [])
        self.assertEqual(bucket.all, before)   # no index, no compare report, no status: an empty bucket stays empty

    def test_only_non_recording_objects_there_is_also_fine(self):
        bucket = FakeStore()
        bucket.all["recordings/notes.txt"] = "x"
        bucket.all["recordings/"] = ""
        bucket.all["shadow/index.json"] = json.dumps({"schema": 1, "cycles": []})
        self.assertEqual(process(bucket, FakeDB()), [])

    def test_the_lock_row_is_not_even_created_when_there_is_nothing_to_do(self):
        db = FakeDB()
        process(FakeStore(), db)
        self.assertEqual(db.conn.execute("SELECT COUNT(*) FROM pipeline_lock").fetchone()[0], 0)


class ThreadedLikeActions(unittest.TestCase):
    def test_a_threaded_run_records_and_replays_clean_and_matches_the_serial_output(self):
        locs, resp = world()
        serial, _ = rw.run_plain(locs, resp, None, synth.KEY, START)
        for attempt in range(5):   # the thread interleaving differs every time: the result must not
            outs, bundle, code, _ = rw.run_recorder(locs, resp, None, synth.KEY, START, threaded=True)
            self.assertEqual(code, 0)
            self.assertEqual(outs, serial, "a threaded recorded run must produce the same files as a serial plain run")
            bucket = FakeStore()
            put_bundle(bucket, bundle)
            e = process(bucket, FakeDB())[0]
            self.assertTrue(e["clean"], e["reasons"])
            self.assertGreater(bundle["expected"]["counts"]["http"], 0)


class ShadowReplay(unittest.TestCase):
    def test_a_recording_replays_to_identical_bytes_and_the_cycle_is_clean(self):
        bundle, _ = make_bundle()
        bucket = FakeStore()
        put_bundle(bucket, bundle)
        done = process(bucket, FakeDB(), probe=lambda: 70.0)
        self.assertEqual(len(done), 1)
        e = done[0]
        self.assertTrue(e["clean"], e["reasons"])
        self.assertTrue(e["identical"])
        self.assertEqual(e["id"], bundle["runId"])
        index = json.loads(bucket.objects["shadow/index.json"])
        self.assertEqual([c["id"] for c in index["cycles"]], [bundle["runId"]])
        report = json.loads(bucket.objects[f"shadow/compare/{bundle['runId']}.json"])
        self.assertTrue(report["compare"]["identical"])
        self.assertEqual(report["compare"]["graphFiles"], 5)

    def test_it_publishes_only_the_public_layout_and_only_under_shadow(self):
        bundle, _ = make_bundle()
        bucket = FakeStore()
        put_bundle(bucket, bundle)
        before = set(bucket.all)
        process(bucket, FakeDB())
        written = set(bucket.all) - before
        self.assertTrue(written)
        self.assertTrue(all(k.startswith("shadow/") for k in written), [k for k in written if not k.startswith("shadow/")])
        rid = bundle["runId"]
        self.assertIn(f"shadow/runs/{rid}/conditions.json", written)
        self.assertIn("shadow/latest.json", written)
        blob = "\n".join(bucket.all[k] for k in written)
        self.assertNotIn(synth.PRIVATE_NAME, blob)
        self.assertNotIn("owner-x", blob)

    def test_no_network_and_no_writes_are_ever_sent(self):
        bundle, _ = make_bundle()
        bucket = FakeStore()
        put_bundle(bucket, bundle)
        done = process(bucket, FakeDB())
        report = json.loads(bucket.objects[f"shadow/compare/{bundle['runId']}.json"])
        self.assertTrue(done[0]["clean"])  # a NullNet raises on ANY request: a clean run proves none was attempted
        self.assertEqual(report["effects"]["sent"], 0)
        self.assertGreater(report["effects"]["wouldSend"], 0)  # the archive / prune writes were produced, and only counted
        with self.assertRaises(RuntimeError):
            run(netmod.NullNet().request("GET", "https://example.com", "h"))
        with self.assertRaises(RuntimeError):
            run(netmod.NullNet().send_json("PUT", "https://example.com", {}, "t"))

    def test_the_d1_binding_is_touched_only_for_the_shadow_lock_row(self):
        bundle, _ = make_bundle()
        bucket = FakeStore()
        put_bundle(bucket, bundle)
        db = FakeDB()
        statements = []
        real_prepare = db.prepare

        def spy(sql):
            statements.append(sql)
            return real_prepare(sql)

        db.prepare = spy
        self.assertTrue(process(bucket, db)[0]["clean"])
        self.assertTrue(statements and all("pipeline_lock" in s for s in statements), statements)
        rows = db.conn.execute("SELECT id, locked_until FROM pipeline_lock").fetchall()
        self.assertEqual(rows, [("shadow", 0)])  # its own row, released; production's "conditions" row was never touched

    def test_each_recording_is_processed_once_oldest_first_and_old_ones_are_cleaned_up(self):
        bucket = FakeStore()
        ids = []
        for i in range(3):
            b, _ = make_bundle(start=START - timedelta(days=[6, 5, 0][i]))
            ids.append(b["runId"])
            put_bundle(bucket, b)
        self.assertEqual(ids, sorted(ids))
        first = process(bucket, FakeDB())            # ONE per invocation (keeps the heap at a single replay's worth)
        self.assertEqual([e["id"] for e in first], ids[:1])
        second = process(bucket, FakeDB())
        self.assertEqual([e["id"] for e in second], ids[1:2])
        third = process(bucket, FakeDB())
        self.assertEqual([e["id"] for e in third], ids[2:])
        self.assertEqual(process(bucket, FakeDB()), [])
        # a recording is dropped once processed AND older than 4 days; the recent one stays
        remaining = [k for k in bucket.all if k.startswith("recordings/")]
        self.assertEqual(remaining, [f"recordings/{ids[2]}.json"])
        index = json.loads(bucket.objects["shadow/index.json"])
        self.assertEqual([c["id"] for c in index["cycles"]], ids)

    def test_shadow_replays_on_ANY_scheduled_fire_while_production_stays_strict(self):
        for cron in ("40 */3 * * *", "*/5 * * * *", "*/15 * * * *", "0 */3 * * *", "", "anything"):
            self.assertEqual(service.dispatch_cron(cron, shadow=True), "shadow", cron)
        # production is unchanged: only its own two crons do anything, and it never recognises the shadow's
        self.assertEqual(service.dispatch_cron("0 */3 * * *"), "run")
        self.assertEqual(service.dispatch_cron("15 * * * *"), "watchdog")
        self.assertEqual(service.dispatch_cron("40 */3 * * *"), "ignore")
        self.assertEqual(service.dispatch_cron("*/5 * * * *"), "ignore")

    def test_the_shadow_environment_in_wrangler_toml_cannot_reach_production_or_the_public_bucket(self):
        with open(os.path.join(os.path.dirname(__file__), "..", "wrangler.toml"), "rb") as f:
            conf = tomllib.load(f)
        sh = conf["env"]["shadow"]
        self.assertEqual(sh["name"], "fishingconditions-pipeline-shadow")
        self.assertFalse(sh["workers_dev"])
        self.assertEqual([b["binding"] for b in sh["r2_buckets"]], ["SHADOW_DATA"])
        self.assertEqual(sh["r2_buckets"][0]["bucket_name"], "fishingconditions-shadow-private")
        self.assertEqual(sh["vars"]["SHADOW"], "1")
        for forbidden in ("PIPELINE_WORKER_URL", "WILLYWEATHER_API_KEY", "PIPELINE_API_TOKEN", "ALERT_WEBHOOK_URL"):
            self.assertNotIn(forbidden, sh["vars"])
        self.assertEqual(sh["triggers"]["crons"], ["*/15 * * * *", "40 */3 * * *"])
        self.assertNotIn("services", sh)
        self.assertEqual(conf["r2_buckets"][0]["bucket_name"], "yepyepyep-data-public")  # production's, which shadow does not inherit


class ShadowCatchesProblems(unittest.TestCase):
    def _tampered(self, mutate):
        bundle, _ = make_bundle()
        mutate(bundle)
        bucket = FakeStore()
        put_bundle(bucket, bundle)
        done = process(bucket, FakeDB(), probe=lambda: 60.0)
        return bundle, bucket, done[0]

    def test_a_changed_api_answer_is_an_unclean_cycle_that_keeps_the_full_output_for_diffing(self):
        def mutate(b):
            k = next(k for k in b["responses"] if "weather.json?forecasts=temperature" in k)
            b["responses"][k] = b["responses"][k].replace("\"speed\": 4.5", "\"speed\": 99.5")
        bundle, bucket, e = self._tampered(mutate)
        self.assertFalse(e["clean"])
        self.assertIn("conditions.json", e["reasons"][0])
        self.assertEqual(e["firstDiff"]["file"], "conditions.json")
        self.assertIn(f"shadow/diffs/{bundle['runId']}/conditions.json", bucket.all)

    def test_a_changed_expected_hash_names_the_file(self):
        def mutate(b):
            name = sorted(b["expected"]["graph"])[0]
            b["expected"]["graph"][name] = "0" * 64
        bundle, bucket, e = self._tampered(mutate)
        self.assertFalse(e["clean"])
        self.assertTrue(e["firstDiff"]["file"].startswith("graph/"))

    def test_a_different_set_of_writes_is_caught(self):
        bundle, bucket, e = self._tampered(lambda b: b["expected"].__setitem__("effects", "f" * 64))
        self.assertFalse(e["clean"])
        self.assertIn("archive/id-cache/prune writes", e["reasons"][0])

    def test_a_different_call_count_is_caught(self):
        bundle, bucket, e = self._tampered(lambda b: b["expected"]["counts"].__setitem__("http", 999))
        self.assertFalse(e["clean"])
        self.assertIn("script calls", e["reasons"][0])

    def test_a_missing_recorded_answer_is_a_plan_drift_not_a_silent_pass(self):
        def mutate(b):
            k = next(k for k in b["responses"] if "marine" in k)
            del b["responses"][k]            # the script will ask for it, but it was never recorded at all
        bundle, bucket, e = self._tampered(mutate)
        self.assertFalse(e["clean"])
        self.assertTrue(any("never prefetched" in r or "script calls" in r or "differs" in r for r in e["reasons"]), e["reasons"])

    def test_a_private_name_in_a_public_object_is_flagged(self):
        bundle, _ = make_bundle()
        bucket = FakeStore()
        put_bundle(bucket, bundle)
        real = publish.iter_owner_objects

        def leaky(owner, result, run_as_of=None):
            for key, text, counts in real(owner, result, run_as_of):
                yield key, (text.replace("Bravo Pier", synth.PRIVATE_NAME) if key == "locations.json" else text), counts

        publish.iter_owner_objects = leaky
        try:
            e = process(bucket, FakeDB())[0]
        finally:
            publish.iter_owner_objects = real
        self.assertFalse(e["clean"])
        self.assertTrue(any("private location name" in r for r in e["reasons"]))
        self.assertTrue(json.loads(bucket.objects[f"shadow/compare/{bundle['runId']}.json"])["publicLeak"])

    def test_a_quoted_name_match_does_not_flag_a_public_name_that_merely_contains_a_private_one(self):
        names, owners = shadow.private_markers([{"name": "Alpha", "ownerId": "u1"}, {"name": "Alpha Beach", "ownerId": "public"}])
        self.assertTrue(any(n in json.dumps({"name": "Alpha"}) for n in names))
        self.assertFalse(any(n in json.dumps({"name": "Alpha Beach"}) for n in names))

    def test_heap_over_the_CEILING_is_unclean_but_over_the_watch_level_alone_is_not(self):
        bundle, _ = make_bundle()
        bucket = FakeStore()
        put_bundle(bucket, bundle)
        e = process(bucket, FakeDB(), probe=lambda: 120.0)[0]
        self.assertFalse(e["clean"])
        self.assertIn("heap", e["reasons"][0])
        b2, _ = make_bundle()
        bucket2 = FakeStore()
        put_bundle(bucket2, b2)
        e2 = process(bucket2, FakeDB(), probe=lambda: 95.0)[0]
        self.assertTrue(e2["clean"])          # 95 MB is above the 90 MB watch level only: reported (heapWatch), never a failure
        self.assertTrue(e2["heapWatch"])

    def test_a_corrupt_recording_is_reported_and_the_next_one_still_runs(self):
        bucket = FakeStore()
        bucket.all["recordings/20261007T020000Z.json"] = "{not json"
        good, _ = make_bundle(start=START)
        put_bundle(bucket, good)
        done = process(bucket, FakeDB()) + process(bucket, FakeDB())      # one per fire
        self.assertEqual([d["id"] for d in done], ["20261007T020000Z", good["runId"]])
        self.assertFalse(done[0]["clean"])
        self.assertIn("JSONDecodeError", done[0]["reasons"][0])
        self.assertTrue(done[1]["clean"])
        self.assertNotIn("superseded", done[0])      # a corrupt recording is a failure, not a hash mismatch

    def test_the_entry_carries_both_script_hashes_and_a_matching_recording_is_not_superseded(self):
        import script_hash
        bundle, _ = make_bundle()
        self.assertEqual(bundle["scriptHash"], script_hash.SCRIPT_HASH)      # the recorder hashed the very files the Worker was deployed with
        bucket = FakeStore()
        put_bundle(bucket, bundle)
        e = process(bucket, FakeDB())[0]
        self.assertTrue(e["clean"])
        self.assertEqual((e["scriptHash"], e["deployedScriptHash"]), (script_hash.SCRIPT_HASH, script_hash.SCRIPT_HASH))
        self.assertNotIn("superseded", e)

    def test_a_recording_without_or_with_another_script_hash_is_replayed_as_information_and_marked_superseded(self):
        for label, change, why in [("no hash", lambda b: b.pop("scriptHash"), "no script hash"), ("other script", lambda b: b.__setitem__("scriptHash", "0" * 64), "different script")]:
            bundle, _ = make_bundle()
            change(bundle)
            bucket = FakeStore()
            put_bundle(bucket, bundle)
            e = process(bucket, FakeDB())[0]
            self.assertTrue(e["superseded"], label)
            self.assertIn(why, e["supersededWhy"], label)
            self.assertTrue(e["clean"], label)          # the replay itself matched: the flag is what keeps it out of the count, not a failure
            self.assertEqual(e["reasons"], [], label)

    def test_a_recording_replayed_under_an_older_deployed_script_is_replayed_again_once_and_never_counted_twice(self):
        bundle, _ = make_bundle()
        bucket = FakeStore()
        put_bundle(bucket, bundle)
        self.assertEqual(len(process(bucket, FakeDB())), 1)
        self.assertEqual(process(bucket, FakeDB()), [])                       # same deployed script: done
        index = json.loads(bucket.objects["shadow/index.json"])
        index["cycles"][0].pop("deployedScriptHash")                          # as the entries written before this change look
        bucket.objects["shadow/index.json"] = json.dumps(index)
        bucket.all["shadow/index.json"] = bucket.objects["shadow/index.json"]
        again = process(bucket, FakeDB())
        self.assertEqual([e["id"] for e in again], [bundle["runId"]])
        self.assertEqual(process(bucket, FakeDB()), [])
        self.assertEqual([c["id"] for c in json.loads(bucket.objects["shadow/index.json"])["cycles"]], [bundle["runId"]])   # replaced, not added

    def test_the_heartbeat_names_the_deployed_script(self):
        import script_hash
        out = FakeStore().view("shadow/")
        beat = run(shadow.touch_heartbeat(out, NOW, "*/15 * * * *"))
        self.assertEqual(beat["scriptHash"], script_hash.SCRIPT_HASH)

    def test_a_held_lock_is_reported_as_not_clean_not_as_a_pass(self):
        bundle, _ = make_bundle()
        bucket = FakeStore()
        put_bundle(bucket, bundle)
        db = FakeDB()
        import locking
        run(locking.acquire(db, "someone", int(NOW.timestamp() * 1000), lock_id="shadow"))
        e = process(bucket, db)[0]
        self.assertFalse(e["clean"])
        self.assertIn("lock", e["reasons"][0])


if __name__ == "__main__":
    unittest.main()


class MemoryIsJudgedApartFromOutput(unittest.TestCase):
    def _entry(self, probe):
        bundle, _ = make_bundle()
        bucket = FakeStore()
        put_bundle(bucket, bundle)
        return process(bucket, FakeDB(), probe=probe)[0]

    def test_a_peak_between_the_watch_level_and_the_ceiling_is_clean_and_flagged_as_watch(self):
        e = self._entry(lambda: 100.0)
        self.assertTrue(e["clean"])
        self.assertEqual(e["reasons"], [])
        self.assertTrue(e["heapWatch"])
        self.assertEqual(e["heapMb"], 100.0)

    def test_a_peak_over_the_ceiling_is_unclean(self):
        e = self._entry(lambda: 120.0)
        self.assertFalse(e["clean"])
        self.assertIn("115 MB ceiling", e["reasons"][0])

    def test_a_low_peak_is_not_flagged_and_the_entry_records_before_growth_and_isolate(self):
        beats = iter([40.0, 77.0])                   # before the replay, then at its end
        e = self._entry(lambda: next(beats))
        self.assertTrue(e["clean"])
        self.assertFalse(e["heapWatch"])
        self.assertEqual((e["heapBeforeMb"], e["heapMb"], e["heapGrowthMb"]), (40.0, 77.0, 37.0))
        self.assertEqual(set(e["isolate"]), {"id", "cold", "replayNo"})

    def test_cold_is_true_only_for_the_first_replay_in_an_isolate(self):
        shadow._ISOLATE["replays"] = 0
        first = self._entry(lambda: 50.0)
        second = self._entry(lambda: 50.0)
        self.assertTrue(first["isolate"]["cold"])
        self.assertFalse(second["isolate"]["cold"])
        self.assertEqual(second["isolate"]["replayNo"], first["isolate"]["replayNo"] + 1)

    def test_the_scripts_per_run_state_is_cleared_after_a_replay(self):
        import fetch_conditions as fc
        self._entry(lambda: 50.0)
        self.assertEqual(fc.ARCHIVE_BY_LOCATION, {})

    def test_the_memory_changes_do_not_touch_the_script_hash(self):
        import script_hash
        self.assertEqual(script_hash.SCRIPT_HASH, script_hash.script_hash(os.path.join(os.path.dirname(__file__), "..", "..", "scripts")))


class WorkerImportRules(unittest.TestCase):
    def test_no_module_asks_for_entropy_while_it_is_imported(self):
        """Cloudflare rejects a deploy whose modules call os.urandom / random at import time (TOP_LEVEL_ENTROPY_ERROR)."""
        import importlib
        from unittest import mock

        def boom(*a, **k):
            raise OSError("entropy at import time")
        names = ["shadow", "shadow_measure", "service", "publish", "plan", "runner", "net", "locking", "alerts", "script_hash"]  # store.py and entry.py need Pyodide's js module
        with mock.patch("os.urandom", boom), mock.patch("random.random", boom), mock.patch("random.seed", boom):
            for n in names:
                importlib.reload(__import__(n))
        shadow._ISOLATE["replays"] = 0
