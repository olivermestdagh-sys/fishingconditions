"""The run-due guard (guard.py + its place in service.run_pipeline): daily caps, spacing between attempts, "is a run due?"."""
import asyncio
import json
import unittest
from datetime import datetime, timedelta, timezone

import synth
from synth import FakeDB, FakeNetwork, FakeStore

import guard
import net as netmod
import service

NOW = datetime(2026, 10, 7, 5, 30, tzinfo=timezone.utc)
LIM = dict(guard.DEFAULTS)


def ms(dt):
    return int(dt.timestamp() * 1000)


def zero():
    return {"attempts": 0, "calls": 0, "last_attempt_ms": 0}


class Decide(unittest.TestCase):
    def test_a_normal_cron_run_is_allowed(self):
        self.assertEqual(guard.decide("cron", ms(NOW), ms(NOW - timedelta(hours=3)), zero(), LIM), (True, ""))
        self.assertTrue(guard.decide("cron", ms(NOW), None, zero(), LIM)[0], "first ever run: nothing published yet")

    def test_cron_skips_while_the_data_is_recent(self):
        ok, why = guard.decide("cron", ms(NOW), ms(NOW - timedelta(minutes=100)), zero(), LIM)
        self.assertFalse(ok)
        self.assertIn("no run due", why)
        self.assertTrue(guard.decide("manual", ms(NOW), ms(NOW - timedelta(minutes=100)), zero(), LIM)[0], "manual is never 'not due'")

    def test_a_failed_attempt_is_not_retried_within_the_minimum_interval(self):
        row = {"attempts": 1, "calls": 27, "last_attempt_ms": ms(NOW - timedelta(minutes=20))}
        for trigger in ("cron", "manual"):
            ok, why = guard.decide(trigger, ms(NOW), ms(NOW - timedelta(hours=9)), row, LIM)
            self.assertFalse(ok, trigger)
            self.assertIn("too soon", why)
        row["last_attempt_ms"] = ms(NOW - timedelta(minutes=51))
        self.assertTrue(guard.decide("cron", ms(NOW), ms(NOW - timedelta(hours=9)), row, LIM)[0])

    def test_force_skips_the_spacing_but_never_the_daily_caps(self):
        recent = {"attempts": 1, "calls": 27, "last_attempt_ms": ms(NOW - timedelta(minutes=5))}
        self.assertTrue(guard.decide("manual", ms(NOW), None, recent, LIM, force=True)[0])
        self.assertFalse(guard.decide("manual", ms(NOW), None, dict(zero(), calls=LIM["daily_call_cap"]), LIM, force=True)[0])
        self.assertFalse(guard.decide("manual", ms(NOW), None, dict(zero(), attempts=LIM["max_attempts_per_day"]), LIM, force=True)[0])

    def test_the_request_cap_refuses_everyone(self):
        ok, why = guard.decide("cron", ms(NOW), None, dict(zero(), calls=400), LIM)
        self.assertFalse(ok)
        self.assertIn("requests", why)

    def test_day_key_is_utc(self):
        self.assertEqual(guard.day_key(datetime(2026, 10, 15, 23, 59, tzinfo=timezone.utc)), "20261015")
        self.assertEqual(guard.day_key(datetime(2026, 10, 16, 9, 59, tzinfo=timezone(timedelta(hours=10)))), "20261015")


def cfg(**limits):
    return service.Config(api_key=synth.KEY, pipeline_url=synth.PIPELINE_URL, pipeline_token=synth.TOKEN, obs_prune="dry", keep_runs=3, limits=limits)


def make(**limits):
    locs = synth.locations()
    network = FakeNetwork(locs, synth.responses(locs))
    n = netmod.Net(network.transport, secret=synth.KEY, backoff=0, sleep=lambda s: asyncio.sleep(0))
    return network, n, FakeStore(), FakeDB(), cfg(**limits)


def go(n, store, db, c, now, trigger="cron", force=False):
    return asyncio.run(service.run_pipeline(c, n, store, db, now, trigger, frozen_iso=now.isoformat(), log=lambda *a: None, force=force))


def budget(db):
    return db.conn.execute("SELECT attempts, calls, last_attempt_ms FROM pipeline_budget").fetchall()


class InTheRun(unittest.TestCase):
    def test_a_run_records_its_attempt_and_its_requests(self):
        network, n, store, db, c = make()
        s = go(n, store, db, c, NOW)
        self.assertTrue(s["published"], s)
        (attempts, calls, last), = budget(db)
        self.assertEqual(attempts, 1)
        self.assertEqual(last, ms(NOW))
        self.assertEqual(calls, n.stats.by_host["willyweather"]["calls"])
        self.assertGreater(calls, 0)

    def test_a_second_cron_fire_soon_after_is_refused_and_writes_nothing(self):
        network, n, store, db, c = make()
        go(n, store, db, c, NOW)
        writes_before = list(store.writes)
        s = go(n, store, db, c, NOW + timedelta(minutes=10))
        self.assertEqual(s["skipped"], "guard")
        self.assertEqual(store.writes, writes_before)
        self.assertEqual(budget(db)[0][0], 1, "a refused attempt is not counted")
        self.assertEqual(db.row()[2], 0, "and the lock is freed")

    def test_the_cron_cadence_passes(self):
        network, n, store, db, c = make()
        go(n, store, db, c, NOW)
        s = go(n, store, db, c, NOW + timedelta(hours=3))
        self.assertTrue(s["published"], s)

    def test_a_failed_run_still_counts_and_blocks_a_quick_retry(self):
        network, n, store, db, c = make()
        c.api_key = ""  # fails before fetching: "WILLYWEATHER_API_KEY is not set"
        s = go(n, store, db, c, NOW)
        self.assertFalse(s["ok"])
        self.assertEqual(budget(db)[0][0], 1)
        c.api_key = synth.KEY
        s2 = go(n, store, db, c, NOW + timedelta(minutes=15), trigger="manual")
        self.assertEqual(s2["skipped"], "guard")
        s3 = go(n, store, db, c, NOW + timedelta(minutes=15), trigger="manual", force=True)
        self.assertTrue(s3["published"], s3)

    def test_the_daily_request_cap_stops_even_a_forced_run(self):
        network, n, store, db, c = make(daily_call_cap=3)
        go(n, store, db, c, NOW)  # makes 4 requests in the synthetic world
        s = go(n, store, db, c, NOW + timedelta(hours=4), force=True)
        self.assertEqual(s["skipped"], "guard")
        self.assertIn("requests", s["reason"])
        s_next_day = go(n, store, db, c, NOW + timedelta(hours=20))
        self.assertTrue(s_next_day["published"], s_next_day)


        network, n, store, db, c = make()
        go(n, store, db, c, NOW)
        before = budget(db)
        self.assertEqual(before[0][0], 1)  # the guard is skipped when replay= is given (shadow); covered in test_shadow's runs
