"""The whole pipeline run (service.run_pipeline) against the synthetic world: publish layout, Public-only output, the publish
gate, the run lock, retention, the replayed side effects and the watchdog."""
import asyncio
import json
import unittest
from datetime import datetime, timedelta, timezone

import synth
from synth import FakeDB, FakeNetwork, FakeStore

import alerts
import net as netmod
import publish
import service

NOW = datetime(2026, 10, 7, 5, 30, tzinfo=timezone.utc)


def cfg(**kw):
    base = dict(api_key=synth.KEY, pipeline_url=synth.PIPELINE_URL, pipeline_token=synth.TOKEN, obs_prune="dry", keep_runs=3)
    base.update(kw)
    return service.Config(**base)


def make(locs=None, resp=None, **cfg_kw):
    locs = locs or synth.locations()
    network = FakeNetwork(locs, resp if resp is not None else synth.responses(locs))
    n = netmod.Net(network.transport, secret=synth.KEY, backoff=0, sleep=lambda s: asyncio.sleep(0))
    return network, n, FakeStore(), FakeDB(), cfg(**cfg_kw)


def run(coro):
    return asyncio.run(coro)


async def do_run(n, store, db, c, now=NOW, trigger="cron", run_id=None):
    return await service.run_pipeline(c, n, store, db, now, trigger, run_id=run_id, frozen_iso=now.isoformat(), log=lambda *a: None)


class PublishFlow(unittest.TestCase):
    def test_publishes_public_only_under_runs_and_flips_latest_last(self):
        network, n, store, db, c = make()
        s = run(do_run(n, store, db, c))
        self.assertTrue(s["ok"] and s["published"], s)
        rid = s["runId"]
        self.assertEqual(rid, "20261007T053000Z")
        latest = json.loads(store.objects["latest.json"])
        self.assertEqual(latest["runId"], rid)
        for k in ("conditions", "graphIndex", "locations", "manifest"):
            self.assertIn(latest[k], store.objects, k)
        # latest.json is written AFTER every object it names (and after the manifest)
        order = store.writes
        self.assertEqual(order.index("latest.json"), len([w for w in order if w.startswith("runs/")]))
        self.assertGreater(order.index("latest.json"), order.index(f"runs/{rid}/manifest.json"))
        # cache headers: immutable runs, short-lived pointer
        self.assertIn("immutable", store.meta[f"runs/{rid}/conditions.json"][1])
        self.assertEqual(store.meta["latest.json"][1], "public, max-age=60")

    def test_no_private_data_anywhere_in_the_published_bucket(self):
        network, n, store, db, c = make()
        run(do_run(n, store, db, c))
        blob = "\n".join(store.objects.values())
        self.assertNotIn(synth.PRIVATE_NAME, blob)
        self.assertNotIn("owner-x", blob)
        cond = json.loads(store.objects[f"runs/20261007T053000Z/conditions.json"])
        self.assertEqual({l["ownerId"] for l in cond["locations"]}, {"public"})
        self.assertEqual({r["Location Name"] for r in cond["rows"]}, {"Alpha Beach", "Bravo Pier"})
        self.assertEqual(set(cond["sunTimes"]), {"Alpha Beach", "Bravo Pier"})
        idx = json.loads(store.objects["runs/20261007T053000Z/graph/index.json"])
        self.assertEqual(len(idx["locations"]), 3)  # Alpha Kayak, Alpha Land based, Bravo Kayak
        graph_keys = [k for k in store.objects if "/graph/" in k and not k.endswith("index.json")]
        self.assertEqual(len(graph_keys), 3)
        exp = json.loads(store.objects["runs/20261007T053000Z/locations.json"])
        self.assertEqual({e["name"] for e in exp}, {"Alpha Beach", "Bravo Pier"})

    def test_manifest_lists_every_object_with_a_matching_hash(self):
        network, n, store, db, c = make()
        s = run(do_run(n, store, db, c))
        manifest = json.loads(store.objects[f"runs/{s['runId']}/manifest.json"])
        keys = {o["key"] for o in manifest["objects"]}
        self.assertIn(f"runs/{s['runId']}/conditions.json", keys)
        for o in manifest["objects"]:
            self.assertEqual(publish.sha256_text(store.objects[o["key"]]), o["sha256"])
        self.assertTrue(manifest["gate"]["ok"])
        self.assertGreater(manifest["counts"]["rows"], 0)

    def test_side_effects_are_replayed_to_the_user_worker_exactly_as_the_script_builds_them(self):
        network, n, store, db, c = make()
        s = run(do_run(n, store, db, c))
        posts = [(m, u) for m, u, _ in network.sent]
        self.assertEqual(s["effects"]["failed"], 0)
        # one observation POST per location (3 physical, private ones included: the archive is internal), then the prune
        obs = [u for m, u in posts if u.endswith("/api/pipeline/observations")]
        self.assertEqual(len(obs), 3)
        self.assertEqual(posts[-1], ("POST", synth.PIPELINE_URL + "/api/pipeline/observations/prune"))
        prune_body = [b for m, u, b in network.sent if u.endswith("/prune")][0]
        self.assertEqual(prune_body["mode"], "dry")
        # id-cache PUTs: every location already had its cached fields, so none are needed in the steady state
        self.assertEqual([m for m, u in posts if m == "PUT"], [])

    def test_a_newly_resolved_id_is_cached_back_with_a_PUT(self):
        locs = synth.locations()
        locs[1]["willyweatherId"] = None            # Bravo Pier has never been resolved
        resp = synth.responses(synth.locations())
        search_url = None
        network, n, store, db, c = make(locs, resp)
        # name search answers with id 102 (what the full-fat world has for Bravo)
        key = "url:" + n.__class__.__module__  # placeholder to keep the linter quiet
        async def go():
            import plan
            rec = plan._Recorder(synth.KEY, 6)
            coords = rec.search_coords(locs[1]["lat"], locs[1]["lng"])
            network.resp[plan.key_for(coords, synth.KEY)] = json.dumps({"location": {"id": 102, "name": "Bravo Pier", "region": "R", "state": "VIC", "lat": locs[1]["lat"], "lng": locs[1]["lng"]}})
            return await do_run(n, store, db, c)
        s = run(go())
        self.assertTrue(s["ok"], s)
        puts = [(u, b) for m, u, b in network.sent if m == "PUT"]
        self.assertEqual(len(puts), 1)
        self.assertTrue(puts[0][0].endswith("/api/pipeline/locations/loc2"))
        self.assertEqual(puts[0][1]["willyweatherId"], 102)
        self.assertEqual(puts[0][1]["willyweatherName"], "Bravo Pier")


class Gate(unittest.TestCase):
    def test_refuses_and_leaves_the_last_good_run_when_too_much_weather_is_missing(self):
        network, n, store, db, c = make()
        first = run(do_run(n, store, db, c))
        self.assertTrue(first["published"])
        before = dict(store.objects)
        # second run, 3 hours later: WillyWeather is down for every location
        locs = synth.locations()
        resp = synth.responses(locs, drop_weather={101, 102, 103})
        network2 = FakeNetwork(locs, resp)
        n2 = netmod.Net(network2.transport, secret=synth.KEY, backoff=0, sleep=lambda s: asyncio.sleep(0))
        later = NOW + timedelta(hours=3)
        s = run(do_run(n2, store, db, c, now=later))
        self.assertFalse(s["published"])
        self.assertFalse(s["gate"]["ok"])
        self.assertTrue(any("fresh forecast data" in r for r in s["gate"]["reasons"]), s["gate"])
        # latest.json and every run object untouched; only status.json moved
        changed = {k for k in set(before) | set(store.objects) if before.get(k) != store.objects.get(k)}
        self.assertEqual(changed, {"status.json"})
        status = json.loads(store.objects["status.json"])
        self.assertFalse(status["lastRun"]["ok"])
        self.assertTrue(status["lastRun"]["gateReasons"])

    def test_gate_unit_cases(self):
        good = {"pairs": 26, "fresh_pairs": 26, "rows": 9000, "locations": 23, "unplanned": 0, "valid": True}
        prev = {"counts": {"rows": 9000, "locations": 23}}
        self.assertTrue(publish.evaluate_gate(prev, good)["ok"])
        self.assertTrue(publish.evaluate_gate(None, good)["ok"])  # first ever run: only absolute checks
        self.assertFalse(publish.evaluate_gate(prev, dict(good, fresh_pairs=20))["ok"])  # 77% < 80%
        self.assertTrue(publish.evaluate_gate(prev, dict(good, fresh_pairs=21))["ok"])   # 81%
        self.assertFalse(publish.evaluate_gate(prev, dict(good, rows=6000))["ok"])       # per-location rows under 70% of last run
        self.assertTrue(publish.evaluate_gate(prev, dict(good, rows=6400))["ok"])
        self.assertTrue(publish.evaluate_gate(prev, dict(good, rows=4500, locations=12))["ok"])  # fewer locations is not a drop
        self.assertFalse(publish.evaluate_gate(prev, dict(good, valid=False))["ok"])
        self.assertFalse(publish.evaluate_gate(prev, dict(good, pairs=0, fresh_pairs=0))["ok"])
        self.assertFalse(publish.evaluate_gate(prev, dict(good, unplanned=1))["ok"])

    def test_a_failed_locations_load_publishes_nothing(self):
        network, n, store, db, c = make()
        network.locs = []   # the user Worker answers with an empty list
        s = run(do_run(n, store, db, c))
        self.assertFalse(s["ok"])
        self.assertIn("no locations", s["error"])
        self.assertNotIn("latest.json", store.objects)


class LockAndRetention(unittest.TestCase):
    def test_a_second_run_while_locked_is_skipped_and_the_lock_is_released_afterwards(self):
        network, n, store, db, c = make()
        import locking
        self.assertTrue(run(locking.acquire(db, "someone-else", int(NOW.timestamp() * 1000))))
        s = run(do_run(n, store, db, c))
        self.assertEqual(s.get("skipped"), "locked")
        self.assertNotIn("latest.json", store.objects)
        run(locking.release(db, "someone-else"))
        s2 = run(do_run(n, store, db, c))
        self.assertTrue(s2["published"])
        self.assertEqual(db.row()[2], 0)  # released

    def test_an_expired_lease_does_not_block(self):
        import locking
        network, n, store, db, c = make()
        run(locking.acquire(db, "crashed", int((NOW - timedelta(hours=1)).timestamp() * 1000)))
        self.assertTrue(run(do_run(n, store, db, c))["published"])

    def test_only_the_holder_can_release(self):
        import locking
        db = FakeDB()
        t = 1_000_000
        self.assertTrue(run(locking.acquire(db, "A", t)))
        self.assertFalse(run(locking.acquire(db, "B", t + 1000)))
        run(locking.release(db, "B"))
        self.assertFalse(run(locking.acquire(db, "B", t + 2000)))  # B's release did nothing
        run(locking.release(db, "A"))
        self.assertTrue(run(locking.acquire(db, "B", t + 3000)))

    def test_old_runs_are_pruned_but_never_the_current_one(self):
        network, n, store, db, c = make(keep_runs=2)
        for i in range(4):
            network_i = FakeNetwork(synth.locations(), synth.responses())
            ni = netmod.Net(network_i.transport, secret=synth.KEY, backoff=0, sleep=lambda s: asyncio.sleep(0))
            s = run(do_run(ni, store, db, c, now=NOW + timedelta(hours=3 * i)))
            self.assertTrue(s["published"])
        ids = run(store.list_run_ids())
        self.assertEqual(ids, ["20261007T113000Z", "20261007T143000Z"])
        self.assertEqual(json.loads(store.objects["latest.json"])["runId"], "20261007T143000Z")
        ids = ["20261001T000000Z", "20261002T000000Z", "20261003T000000Z"]
        self.assertEqual(publish.runs_to_delete(ids, 1, "20261001T000000Z"), ["20261002T000000Z"])  # the pointed-at run is never deleted
        self.assertEqual(publish.runs_to_delete(["a", "b"], 0, None), [])  # things that are not run ids are never candidates


class Watchdog(unittest.TestCase):
    def _store_with_latest(self, generated_at):
        store = FakeStore()
        store.objects["latest.json"] = json.dumps({"runId": "x", "generatedAt": generated_at})
        return store

    def test_fresh_data_is_not_stale_and_sends_nothing(self):
        store = self._store_with_latest((NOW - timedelta(hours=2)).isoformat())
        network, n, _, _, c = make(alert_webhook="https://hooks.example/x")
        fresh = run(service.watchdog(c, n, store, NOW, log=lambda *a: None))
        self.assertFalse(fresh["stale"])
        self.assertEqual(fresh["ageHours"], 2.0)
        self.assertEqual(network.sent, [])

    def test_stale_data_alerts_once_then_repeats_only_after_the_interval(self):
        store = self._store_with_latest((NOW - timedelta(hours=9)).isoformat())
        calls = []

        async def transport(method, url, headers, body):
            calls.append((method, url, json.loads(body)))
            return 200, "ok", None

        n = netmod.Net(transport, backoff=0, sleep=lambda s: asyncio.sleep(0))
        c = cfg(alert_webhook="https://hooks.example/x")
        run(service.watchdog(c, n, store, NOW, log=lambda *a: None))
        self.assertEqual(len(calls), 1)
        self.assertIn("9.0 hours old", calls[0][2]["text"])
        run(service.watchdog(c, n, store, NOW + timedelta(hours=1), log=lambda *a: None))
        self.assertEqual(len(calls), 1)  # not again an hour later
        run(service.watchdog(c, n, store, NOW + timedelta(hours=7), log=lambda *a: None))
        self.assertEqual(len(calls), 2)  # a reminder after 6 h
        self.assertTrue(json.loads(store.objects["status.json"])["freshness"]["stale"])

    def test_no_run_ever_published_counts_as_stale(self):
        fresh = alerts.freshness(None, NOW)
        self.assertTrue(fresh["stale"])
        self.assertIsNone(fresh["ageHours"])
        self.assertIn("no conditions data", alerts.alert_text(fresh))


if __name__ == "__main__":
    unittest.main()
