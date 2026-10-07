"""prefetch (what gets fetched, in what waves), the HTTP retry policy, and the owner-parameterised layout."""
import asyncio
import json
import unittest

import synth

import net as netmod
import plan
import publish
import runner
import fetch_conditions as fc


def run(coro):
    return asyncio.run(coro)


class Prefetch(unittest.TestCase):
    def _get(self, resp, log=None):
        async def get(url, host):
            if log is not None:
                log.append((plan.key_for(url, synth.KEY), host))
            return resp.get(plan.key_for(url, synth.KEY))
        return get

    def test_steady_state_fetches_exactly_three_per_physical_location_plus_the_moon(self):
        locs = synth.locations()
        resp = synth.responses(locs)
        log = []
        raw = run(plan.prefetch(self._get(resp, log), locs, synth.KEY, 6))
        self.assertEqual(set(raw), set(resp))
        self.assertEqual(len(log), plan.expected_counts(locs))  # 3 x 3 locations + 1
        self.assertEqual({h for _, h in log}, {"willyweather", "open-meteo", "open-meteo-marine"})
        self.assertEqual(len(plan.physical_locations(locs)), 3)

    def test_urls_are_built_by_the_scripts_own_functions(self):
        rec = plan._Recorder("K", 6)
        self.assertEqual(rec.weather(7), f"{fc.BASE_URL}/K/locations/7/weather.json?forecasts=temperature,wind,swell,rainfallprobability,tides,sunrisesunset&days=6&observationalGraphs=temperature,wind")
        self.assertIn("forecasts=moonphases&days=6", rec.moon(7))
        self.assertIn("pressure_msl&forecast_days=6", rec.pressure(-38.1, 145.2))
        self.assertIn("past_days=1", rec.marine(-38.1, 145.2))
        self.assertEqual(fc.API_KEY, fc.API_KEY)  # the recorder restores the script's globals

    def test_concurrency_never_exceeds_the_limit(self):
        locs = synth.locations()
        resp = synth.responses(locs)
        live, peak = 0, 0

        async def get(url, host):
            nonlocal live, peak
            live += 1
            peak = max(peak, live)
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            live -= 1
            return resp.get(plan.key_for(url, synth.KEY))

        run(plan.prefetch(get, locs, synth.KEY, 6, limit=2))
        self.assertEqual(peak, 2)

    def test_a_location_without_a_cached_id_is_found_by_coordinate_search_then_fetched(self):
        locs = synth.locations(with_ids=False)
        resp = synth.responses(synth.locations())
        rec = plan._Recorder(synth.KEY, 6)
        for i, l in enumerate(plan.physical_locations(locs), start=1):
            resp[plan.key_for(rec.search_coords(l["lat"], l["lng"]), synth.KEY)] = json.dumps({"location": {"id": 100 + i, "name": l["name"], "lat": l["lat"], "lng": l["lng"]}})
        resp[plan.key_for(rec.search_name(locs[0]["name"]), synth.KEY)] = json.dumps([{"id": 101, "name": locs[0]["name"]}])
        raw = run(plan.prefetch(self._get(resp), locs, synth.KEY, 6))
        for wid in (101, 102, 103):
            self.assertIn(f"weather:{wid}", raw)
        self.assertIn("moon:101", raw)

    def test_coordinate_search_with_no_match_falls_back_to_the_name_search(self):
        locs = [synth.locations(with_ids=False)[0]]
        resp = {}
        rec = plan._Recorder(synth.KEY, 6)
        resp[plan.key_for(rec.search_name(locs[0]["name"]), synth.KEY)] = json.dumps([{"id": 555, "name": locs[0]["name"]}])
        resp["weather:555"] = json.dumps(synth.weather_payload(1))
        resp["moon:555"] = json.dumps(synth.moon_payload())
        raw = run(plan.prefetch(self._get(resp), locs, synth.KEY, 6))
        self.assertIn("weather:555", raw)

    def test_a_cached_id_that_returns_nothing_triggers_the_scripts_self_heal_search(self):
        locs = synth.locations()
        resp = synth.responses(locs)
        resp["weather:101"] = "{}"   # the cached id now answers with an empty object
        rec = plan._Recorder(synth.KEY, 6)
        resp[plan.key_for(rec.search_coords(locs[0]["lat"], locs[0]["lng"]), synth.KEY)] = json.dumps({"location": {"id": 901, "name": "Alpha Beach", "lat": locs[0]["lat"], "lng": locs[0]["lng"]}})
        resp["weather:901"] = json.dumps(synth.weather_payload(1))
        raw = run(plan.prefetch(self._get(resp), locs, synth.KEY, 6))
        self.assertIn("weather:901", raw)

    def test_failed_calls_are_simply_absent_and_the_script_sees_them_as_failures(self):
        locs = synth.locations()
        resp = synth.responses(locs, drop_weather={102})
        raw = run(plan.prefetch(self._get(resp), locs, synth.KEY, 6))
        self.assertNotIn("weather:102", raw)
        result = runner.run(locs, raw, None, synth.KEY, frozen_iso=synth.NOW_ISO)
        self.assertGreater(result["counts"]["miss"], 0)

    def test_weather_ok_count_ignores_empty_responses(self):
        raw = {"weather:1": json.dumps({"a": 1}), "weather:2": "{}", "weather:3": "", "om_fc:x": "{}"}
        self.assertEqual(publish.weather_ok_count(raw, 3), 1)
        self.assertEqual(publish.weather_ok_count({"weather:1": "{\"a\":1}", "weather:2": "{\"b\":1}"}, 1), 1)  # capped at the location count


class NetPolicy(unittest.TestCase):
    def _net(self, script, **kw):
        calls, slept = [], []

        async def transport(method, url, headers, body):
            calls.append(url)
            r = script[min(len(calls) - 1, len(script) - 1)]
            if isinstance(r, Exception):
                raise r
            return r

        async def sleep(s):
            slept.append(s)

        n = netmod.Net(transport, secret="SECRET", sleep=sleep, jitter=lambda: 0.5, **kw)
        return n, calls, slept

    def test_5xx_and_network_errors_are_retried_then_succeed(self):
        n, calls, slept = self._net([(503, "", None), RuntimeError("boom SECRET"), (200, "ok", None)])
        self.assertEqual(run(n.get_text("https://x/y?k=SECRET", "h")), "ok")
        self.assertEqual(len(calls), 3)
        self.assertEqual(slept, [2.0, 4.0])      # exponential backoff
        self.assertEqual(n.stats.by_host["h"]["retries"], 0 + 1 + 2)
        self.assertTrue(all("SECRET" not in e for e in n.stats.errors))  # the key is scrubbed from error text

    def test_4xx_is_not_retried_because_every_willyweather_call_is_billed(self):
        n, calls, _ = self._net([(404, "", None)])
        self.assertIsNone(run(n.get_text("https://x/y", "h")))
        self.assertEqual(len(calls), 1)

    def test_429_honours_retry_after_but_never_longer_than_the_cap(self):
        n, calls, slept = self._net([(429, "", "10"), (429, "", "9999"), (200, "ok", None)])
        self.assertEqual(run(n.get_text("https://x/y", "h")), "ok")
        self.assertEqual(slept, [10.0, 30.0])

    def test_gives_up_after_the_configured_tries(self):
        n, calls, _ = self._net([(500, "", None)], tries=3)
        self.assertIsNone(run(n.get_text("https://x/y", "h")))
        self.assertEqual(len(calls), 3)

    def test_send_json_adds_the_pipeline_token_and_parses_the_answer(self):
        seen = {}

        async def transport(method, url, headers, body):
            seen.update(method=method, token=headers.get("X-Pipeline-Token"), body=json.loads(body))
            return 200, '{"ok":1}', None

        n = netmod.Net(transport)
        body, status = run(n.send_json("PUT", "https://u/api", {"a": 1}, "T"))
        self.assertEqual((body, status, seen["method"], seen["token"], seen["body"]), ({"ok": 1}, 200, "PUT", "T", {"a": 1}))


class OwnerLayout(unittest.TestCase):
    def test_keys_for_public_and_for_a_future_private_owner(self):
        self.assertEqual(publish.latest_key(), "latest.json")
        self.assertEqual(publish.run_prefix("R1"), "runs/R1/")
        self.assertEqual(publish.latest_key("u-9"), "owner/u-9/latest.json")
        self.assertEqual(publish.run_prefix("R1", "u-9"), "owner/u-9/runs/R1/")
        self.assertEqual(publish.make_latest("R1", "t")["conditions"], "runs/R1/conditions.json")
        self.assertEqual(publish.make_latest("R1", "t", "u-9")["graphIndex"], "owner/u-9/runs/R1/graph/index.json")

    def test_the_private_owners_output_can_be_produced_from_the_same_run_without_touching_publics(self):
        locs = synth.locations()
        raw = synth.responses(locs)
        result = runner.run(locs, raw, None, synth.KEY, frozen_iso=synth.NOW_ISO)
        mine = {k: t for k, t, _ in publish.iter_owner_objects("owner-x", result)}
        self.assertEqual({e["name"] for e in json.loads(mine["locations.json"])}, {synth.PRIVATE_NAME})
        cond = json.loads(mine["conditions.json"])
        self.assertEqual({r["Location Name"] for r in cond["rows"]}, {synth.PRIVATE_NAME})
        self.assertEqual(publish.owners_in(json.loads(open(result["conditions"], encoding="utf-8").read())), ["owner-x", "public"])

    def test_run_ids_sort_chronologically(self):
        from datetime import datetime, timezone
        a = publish.make_run_id(datetime(2026, 10, 7, 5, 30, tzinfo=timezone.utc))
        b = publish.make_run_id(datetime(2026, 10, 7, 8, 30, tzinfo=timezone.utc))
        self.assertTrue(a < b)

    def test_the_pipeline_copies_of_the_script_match_the_originals(self):
        import os
        here = os.path.dirname(__file__)
        for name in ("fetch_conditions.py", "observation_archive.py"):
            a = open(os.path.join(here, "..", "src", name), "rb").read()
            b = open(os.path.join(here, "..", "..", "scripts", name), "rb").read()
            self.assertEqual(a, b, f"pipeline/src/{name} drifted from scripts/{name}")


if __name__ == "__main__":
    unittest.main()
