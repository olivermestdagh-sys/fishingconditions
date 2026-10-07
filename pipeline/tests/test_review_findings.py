"""Regression tests for the independent review of the pipeline Worker (stage 1 -> 2). Each test reproduces one confirmed finding.
Finding numbers are the reviewer's. They all FAILED against the first stage-1 code before the fixes."""
import asyncio
import json
import unittest
from datetime import datetime, timedelta, timezone

import synth
from synth import FakeDB, FakeNetwork, FakeStore

import locking
import net as netmod
import plan
import publish
import service

NOW = datetime(2026, 10, 7, 5, 30, tzinfo=timezone.utc)


def run(coro):
    return asyncio.run(coro)


def make(locs=None, resp=None, net_kw=None, **cfg_kw):
    locs = locs or synth.locations()
    network = FakeNetwork(locs, resp if resp is not None else synth.responses(locs))
    n = netmod.Net(network.transport, secret=synth.KEY, backoff=0, sleep=lambda s: asyncio.sleep(0), **(net_kw or {}))
    base = dict(api_key=synth.KEY, pipeline_url=synth.PIPELINE_URL, pipeline_token=synth.TOKEN, obs_prune="dry", keep_runs=3)
    base.update(cfg_kw)
    return network, n, FakeStore(), FakeDB(), service.Config(**base)


async def go(n, store, db, c, now=NOW, **kw):
    return await service.run_pipeline(c, n, store, db, now, "cron", frozen_iso=now.isoformat(), log=lambda *a: None, **kw)


def clashing_world():
    """A PRIVATE 'Alpha Beach' (own id, own coordinates) listed BEFORE Public's 'Alpha Beach'. locations has no unique name at all."""
    locs = synth.locations()
    dup = json.loads(json.dumps(locs[0]))
    dup.update(id="locX", ownerId="owner-x", willyweatherId=777, lat=-39.5, lng=146.5, tideMaxObserved=None, types=[locs[0]["types"][0]])
    locs = [dup] + locs
    resp = synth.responses(synth.locations())
    resp["weather:777"] = json.dumps(synth.weather_payload(9))
    resp[f"om_fc:{plan.f6(-39.5)}:{plan.f6(146.5)}"] = resp[f"om_fc:{plan.f6(locs[1]['lat'])}:{plan.f6(locs[1]['lng'])}"]
    resp[f"om_mr:{plan.f6(-39.5)}:{plan.f6(146.5)}"] = resp[f"om_mr:{plan.f6(locs[1]['lat'])}:{plan.f6(locs[1]['lng'])}"]
    return locs, resp


class Finding1_NameClash(unittest.TestCase):
    def test_prefetch_fetches_every_location_entry_even_when_names_repeat(self):
        locs, resp = clashing_world()

        async def get(url, host):
            return resp.get(plan.key_for(url, synth.KEY))

        raw = run(plan.prefetch(get, locs, synth.KEY, 6))
        self.assertIn("weather:101", raw, "Public's Alpha Beach was skipped because a private one shares its name")
        self.assertIn("weather:777", raw)

    def test_a_private_location_with_a_public_name_never_reaches_the_public_bucket_or_nulls_an_id(self):
        locs, resp = clashing_world()
        network, n, store, db, c = make(locs, resp)
        s = run(go(n, store, db, c))
        self.assertTrue(s["published"], s)
        blob = "\n".join(store.objects.values())
        self.assertNotIn("owner-x", blob)
        cond = json.loads(store.objects[f"runs/{s['runId']}/conditions.json"])
        # the clashing (name, type) cannot be told apart by the script, so it is withheld from the public output, never mixed
        self.assertEqual({r["Location Name"] for r in cond["rows"]}, {"Bravo Pier"})
        self.assertEqual({l["name"] for l in cond["locations"]}, {"Bravo Pier"})
        self.assertEqual(set(cond["sunTimes"]), {"Bravo Pier"})
        idx = json.loads(store.objects[f"runs/{s['runId']}/graph/index.json"])
        self.assertEqual({e["name"] for e in idx["locations"]}, {"Bravo Pier"})
        self.assertEqual({e["name"] for e in json.loads(store.objects[f"runs/{s['runId']}/locations.json"])}, {"Bravo Pier"})
        self.assertEqual(s["counts"]["ambiguous"], 1)
        # and no PUT that clears Public's cached WillyWeather id
        self.assertEqual([b for m, u, b in network.sent if m == "PUT" and b.get("willyweatherId") is None], [])


class Finding2_GateDeadlock(unittest.TestCase):
    def test_removing_locations_is_not_refused_forever(self):
        network, n, store, db, c = make()
        self.assertTrue(run(go(n, store, db, c))["published"])
        # an admin removes Bravo Pier: 1 public location (2 types) instead of 2
        locs = [l for l in synth.locations() if l["name"] != "Bravo Pier"]
        network2 = FakeNetwork(locs, synth.responses(locs))
        n2 = netmod.Net(network2.transport, secret=synth.KEY, backoff=0, sleep=lambda s: asyncio.sleep(0))
        s = run(go(n2, store, db, c, now=NOW + timedelta(hours=3)))
        self.assertTrue(s["published"], s["gate"])
        s2 = run(go(n2, store, db, c, now=NOW + timedelta(hours=6)))
        self.assertTrue(s2["published"], s2["gate"])

    def test_a_real_collapse_in_rows_per_location_is_still_refused_and_force_overrides(self):
        good = {"pairs": 3, "fresh_pairs": 3, "rows": 300, "locations": 3, "unplanned": 0, "valid": True}
        prev = {"counts": {"rows": 300, "locations": 3}}
        self.assertTrue(publish.evaluate_gate(prev, good)["ok"])
        bad = dict(good, rows=60)
        self.assertFalse(publish.evaluate_gate(prev, bad)["ok"])
        forced = publish.evaluate_gate(prev, bad, force=True)
        self.assertTrue(forced["ok"] and forced["forced"] and forced["reasons"])


class Finding3_GatePopulation(unittest.TestCase):
    def test_only_public_locations_count_toward_the_gate(self):
        # every PRIVATE location is dead: it must not stop Public publishing
        locs = synth.locations()
        resp = synth.responses(locs, drop_weather={103})
        network, n, store, db, c = make(locs, resp)
        self.assertTrue(run(go(n, store, db, c))["published"])

    def test_dead_public_locations_are_refused_even_if_private_ones_are_healthy(self):
        locs = synth.locations()
        resp = synth.responses(locs, drop_weather={101, 102})
        network, n, store, db, c = make(locs, resp)
        s = run(go(n, store, db, c))
        self.assertFalse(s["published"])
        self.assertTrue(any("public" in r.lower() for r in s["gate"]["reasons"]), s["gate"])

    def test_locations_sharing_a_willyweather_id_are_each_judged_on_their_own_rows(self):
        locs = synth.locations()
        locs[1]["willyweatherId"] = 101          # Bravo shares Alpha's WillyWeather id
        resp = synth.responses(locs)
        network, n, store, db, c = make(locs, resp)
        s = run(go(n, store, db, c))
        self.assertTrue(s["published"], s["gate"])
        self.assertEqual(s["counts"]["freshPairs"], s["counts"]["pairs"])

    def test_plan_drift_is_refused(self):
        self.assertFalse(publish.evaluate_gate(None, {"pairs": 3, "fresh_pairs": 3, "rows": 9, "locations": 3, "unplanned": 2, "valid": True})["ok"])


class Finding4_EffectsAfterARefusedRun(unittest.TestCase):
    def test_nothing_is_replayed_when_the_gate_refuses(self):
        locs = synth.locations()
        resp = {k: v for k, v in synth.responses(locs).items() if not k.startswith("weather:")}  # WillyWeather fully down
        network, n, store, db, c = make(locs, resp)
        s = run(go(n, store, db, c))
        self.assertFalse(s["published"])
        self.assertEqual(network.sent, [], "a refused run must not PUT cleared ids or POST archive rows")
        self.assertEqual(s["effects"], {"skipped": s["effects"]["skipped"], "sent": 0, "failed": 0})

    def test_an_id_clearing_put_is_never_sent_even_on_a_published_run(self):
        locs = synth.locations()
        resp = synth.responses(locs, drop_weather={103})   # the PRIVATE location returns nothing; the script would clear its cached id
        network, n, store, db, c = make(locs, resp, keep_runs=3)
        s = run(go(n, store, db, c))
        self.assertTrue(s["published"], s["gate"])
        self.assertEqual([b for m, u, b in network.sent if m == "PUT" and b.get("willyweatherId") is None], [])
        self.assertGreaterEqual(s["effects"]["skipped"], 1)


class Finding5_Billing(unittest.TestCase):
    def _net(self, script, **kw):
        calls = []

        async def transport(method, url, headers, body):
            calls.append(url)
            r = script[min(len(calls) - 1, len(script) - 1)]
            if isinstance(r, Exception):
                raise r
            return r

        return netmod.Net(transport, secret="S", backoff=0, sleep=lambda s: asyncio.sleep(0), **kw), calls

    def test_a_willyweather_timeout_is_not_retried_because_it_may_already_be_billed(self):
        n, calls = self._net([TimeoutError("slow")])
        self.assertIsNone(run(n.get_text("https://api.willyweather.com.au/v2/K/x", "willyweather")))
        self.assertEqual(len(calls), 1)
        n2, calls2 = self._net([TimeoutError("slow"), (200, "ok", None)])
        self.assertEqual(run(n2.get_text("https://api.open-meteo.com/x", "open-meteo")), "ok")  # free hosts still retry
        self.assertEqual(len(calls2), 2)

    def test_a_per_run_budget_caps_willyweather_requests(self):
        n, calls = self._net([(500, "", None)], budgets={"willyweather": 5})
        for _ in range(4):
            run(n.get_text("https://api.willyweather.com.au/v2/K/x", "willyweather"))
        self.assertEqual(len(calls), 5)
        self.assertTrue(any("budget" in e for e in n.stats.errors))

    def test_concurrent_identical_requests_are_fetched_once(self):
        locs = synth.locations()
        locs[1]["willyweatherId"] = 101
        locs[1]["lat"], locs[1]["lng"] = locs[0]["lat"], locs[0]["lng"]
        resp = synth.responses(locs)
        seen = []

        async def get(url, host):
            seen.append(plan.key_for(url, synth.KEY))
            await asyncio.sleep(0)
            return resp.get(plan.key_for(url, synth.KEY))

        run(plan.prefetch(get, locs, synth.KEY, 6))
        self.assertEqual(len(seen), len(set(seen)), "the same URL was requested twice")

    def test_the_run_deadline_stops_further_requests(self):
        now = [0.0]
        n, calls = self._net([(200, "ok", None)], clock=lambda: now[0], deadline=10.0)
        self.assertEqual(run(n.get_text("https://x/1", "h")), "ok")
        now[0] = 11.0
        self.assertIsNone(run(n.get_text("https://x/2", "h")))
        self.assertEqual(len(calls), 1)


class Finding6_And_7(unittest.TestCase):
    def test_a_missing_willyweather_key_fails_cleanly_before_any_request(self):
        network, n, store, db, c = make(api_key="")
        s = run(go(n, store, db, c))
        self.assertFalse(s["ok"])
        self.assertIn("WILLYWEATHER_API_KEY", s["error"])
        self.assertEqual(network.gets, [])
        self.assertEqual(json.loads(store.objects["status.json"])["lastRun"]["ok"], False)
        self.assertEqual(db.row()[2], 0, "the lock must be released")

    def test_only_the_run_cron_runs_the_billed_pipeline(self):
        self.assertEqual(service.dispatch_cron("0 */3 * * *"), "run")
        self.assertEqual(service.dispatch_cron("15 * * * *"), "watchdog")
        self.assertEqual(service.dispatch_cron("*/5 * * * *"), "ignore")
        self.assertEqual(service.dispatch_cron(""), "ignore")


class Finding8_Deadline(unittest.TestCase):
    def test_a_run_that_overruns_its_budget_publishes_nothing(self):
        network, n, store, db, c = make(deadline_s=100)
        t = [1000.0]

        def clock():
            t[0] += 60.0   # every look at the clock costs a minute: the run blows its 100 s budget
            return t[0]

        s = run(go(n, store, db, c, clock=clock))
        self.assertFalse(s["published"])
        self.assertNotIn("latest.json", store.objects)
        self.assertIn("time budget", s["error"])

    def test_the_lock_is_rechecked_before_the_pointer_is_flipped(self):
        network, n, store, db, c = make()

        async def steal():
            # another run takes over (our lease "expired") while we were working: simulate by overwriting the holder
            db.conn.execute("UPDATE pipeline_lock SET run_id = 'someone-else', locked_until = ? WHERE id = 'conditions'", (int(NOW.timestamp() * 1000) + 10**9,))
            db.conn.commit()

        orig = store.put_text

        async def put(key, text, *a, **k):
            if key.endswith("manifest.json"):
                await steal()
            return await orig(key, text, *a, **k)

        store.put_text = put
        s = run(go(n, store, db, c))
        self.assertFalse(s["published"])
        self.assertNotIn("latest.json", store.objects)
        self.assertIn("lock", s["error"])
        self.assertEqual(db.row()[1], "someone-else")  # and it did not release the other run's lock

    def test_holds_unit(self):
        db = FakeDB()
        t = 1_000_000
        run(locking.acquire(db, "A", t))
        self.assertTrue(run(locking.holds(db, "A", t + 1)))
        self.assertFalse(run(locking.holds(db, "B", t + 1)))
        self.assertFalse(run(locking.holds(db, "A", t + locking.DEFAULT_LEASE_MS + 1)))


class Findings_9_to_12_PublicHygiene(unittest.TestCase):
    def test_public_files_carry_no_all_owner_totals_or_raw_error_text(self):
        network, n, store, db, c = make()
        s = run(go(n, store, db, c))
        manifest = json.loads(store.objects[f"runs/{s['runId']}/manifest.json"])
        status = json.loads(store.objects["status.json"])
        for doc in (manifest, status):
            text = json.dumps(doc)
            for forbidden in ("physical", "weather_ok", "byHost", "responses", "httpErrors", "calls"):
                self.assertNotIn(forbidden, text, f"{forbidden} leaks an all-owner total into a public file")
        self.assertEqual(manifest["counts"]["locations"], 3)   # Public location entries only (the private one is not counted)

    def test_an_unexpected_exception_publishes_only_its_type(self):
        network, n, store, db, c = make()

        async def boom(*a, **k):
            raise RuntimeError("secret text WWKEY123 for Zzz Private Hideaway")

        n.get_text = boom
        s = run(go(n, store, db, c))
        status = json.loads(store.objects["status.json"])
        self.assertNotIn("WWKEY123", json.dumps(status))
        self.assertNotIn("Zzz", json.dumps(status))
        self.assertEqual(status["lastRun"]["error"], "RuntimeError")

    def test_a_missing_or_null_ownerid_is_never_treated_as_public(self):
        locs = synth.locations()
        del locs[2]["ownerId"]            # the 'private' one loses its owner
        network, n, store, db, c = make(locs)
        s = run(go(n, store, db, c))
        self.assertTrue(s["published"])
        blob = "\n".join(store.objects.values())
        self.assertNotIn(synth.PRIVATE_NAME, blob)

    def test_retention_ignores_foreign_prefixes_and_cleans_orphans_without_counting_them(self):
        network, n, store, db, c = make(keep_runs=2)
        store.objects["runs/zzz/x.json"] = "{}"                      # not a run id: never touched
        store.objects["runs/20261001T000000Z/conditions.json"] = "{}"  # an orphan (no manifest) older than the runs below
        for i in range(3):
            network_i = FakeNetwork(synth.locations(), synth.responses())
            ni = netmod.Net(network_i.transport, secret=synth.KEY, backoff=0, sleep=lambda s: asyncio.sleep(0))
            self.assertTrue(run(go(ni, store, db, c, now=NOW + timedelta(hours=3 * i)))["published"])
        ids = run(store.list_run_ids())
        self.assertIn("zzz", ids)
        self.assertNotIn("20261001T000000Z", ids)
        self.assertEqual([i for i in ids if i != "zzz"], ["20261007T083000Z", "20261007T113000Z"])

    def test_a_latest_json_without_a_manifest_key_does_not_break_the_next_run(self):
        network, n, store, db, c = make()
        store.objects["latest.json"] = json.dumps({"runId": "x", "generatedAt": "2026-10-07T00:00:00+00:00"})
        self.assertTrue(run(go(n, store, db, c))["published"])


if __name__ == "__main__":
    unittest.main()
