"""PARITY GATE: the pipeline Worker's code path must reproduce the Python script's golden output with ZERO differences.

Skipped unless PIPELINE_PARITY_DIR points at a folder holding the recorded fixtures and golden outputs. Those contain the
owner's PRIVATE locations, so they live OUTSIDE the repo (the session scratchpad) and are never committed:

    <dir>/fxdir/meta.json            {"frozenUtc", "locations": [...], "keys": [...]}   (the locations D1 would return)
    <dir>/fxdir/prev.json            the previous conditions.json (history)
    <dir>/fxdir/fx/<key>.json        one recorded API response each ("weather_<id>", "om_fc_<lat>_<lng>", "om_mr_...", "moon_<id>")
    <dir>/local313.json              golden output, clock 2026-10-07T05:30:00Z
    <dir>/local313-dst1.json         golden output, clock 2026-10-03T16:30:00Z  (just after Melbourne's spring-forward)
    <dir>/local313-dst.json          golden output, clock 2027-04-03T16:30:00Z  (the autumn fall-back hour)

Each golden file was produced by the ORIGINAL script (scripts/fetch_conditions.py, Python 3.13) through the stage 0 harness.
What is proven here, per clock:
  1. plan.prefetch asks for EXACTLY the recorded responses (no more, no fewer) and the script then makes no un-prefetched call
  2. runner.run (the code path the Worker uses) gives byte-identical conditions.json, locations export and all 29 graph files
  3. the id-cache / observation-archive / prune side effects are the same calls with the same bodies, in the same order
  4. the PUBLIC-ONLY objects the Worker publishes equal an independent filter of the golden output
  5. service.run_pipeline end to end publishes those same objects, with no private location anywhere in the bucket
"""
import asyncio
import hashlib
import json
import os
import sys
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import net as netmod
import plan
import publish
import runner
import service

D = os.environ.get("PIPELINE_PARITY_DIR")
CLOCKS = [("local313.json", "2026-10-07T05:30:00+00:00"), ("local313-dst1.json", "2026-10-03T16:30:00+00:00"), ("local313-dst.json", "2027-04-03T16:30:00+00:00")]
API_KEY = "spike"      # the key the golden outputs were produced with (it appears nowhere in the output)
URL, TOKEN = "https://pipeline.invalid", "t"


def sha(t):
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def load():
    fx = os.path.join(D, "fxdir")
    meta = json.load(open(os.path.join(fx, "meta.json"), encoding="utf-8"))
    raw = {k: open(os.path.join(fx, "fx", k.replace(":", "_") + ".json"), encoding="utf-8").read() for k in meta["keys"]}
    prev = open(os.path.join(fx, "prev.json"), encoding="utf-8").read()
    return meta, raw, prev


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


async def prefetch_from(raw, locations):
    asked = []

    async def get(url, host):
        asked.append(plan.key_for(url, API_KEY))
        return raw.get(plan.key_for(url, API_KEY))

    got = await plan.prefetch(get, locations, API_KEY, 6)
    return got, asked


def golden_public(g):
    """An INDEPENDENT filter of the golden output (no code shared with publish.py)."""
    cond = json.loads(g["conditions"])
    pub = [l for l in cond["locations"] if l["ownerId"] == "public"]
    pairs = {(l["name"], l["type"]) for l in pub}
    names = {l["name"] for l in pub}
    idx = json.loads(g["graph"]["index.json"])
    return {
        "conditions": {**cond, "locations": pub, "rows": [r for r in cond["rows"] if (r["Location Name"], r["Type"]) in pairs],
                       "sunTimes": {k: v for k, v in cond["sunTimes"].items() if k in names}},
        "index": [e for e in idx["locations"] if e["ownerId"] == "public"],
        "export": [e for e in json.loads(g["export"]) if e["ownerId"] == "public"],
    }


@unittest.skipUnless(D and os.path.isdir(D), "set PIPELINE_PARITY_DIR to the (private, out-of-repo) parity fixtures to run the parity gate")
class Parity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.meta, cls.raw, cls.prev = load()
        cls.golden = {f: json.load(open(os.path.join(D, f), encoding="utf-8")) for f, _ in CLOCKS}

    def test_prefetch_asks_for_exactly_the_recorded_responses(self):
        got, asked = asyncio.run(prefetch_from(self.raw, self.meta["locations"]))
        self.assertEqual(set(got), set(self.raw))
        self.assertEqual(len(asked), len(set(asked)), "a response was requested twice")
        self.assertEqual(len(got), 79)

    def _run(self, frozen):
        got, _ = asyncio.run(prefetch_from(self.raw, self.meta["locations"]))
        return runner.run(self.meta["locations"], got, self.prev, API_KEY, frozen_iso=frozen, obs_prune="dry", pipeline_url=URL, pipeline_token=TOKEN)

    def test_every_golden_output_is_reproduced_with_zero_differences(self):
        for gname, frozen in CLOCKS:
            with self.subTest(clock=frozen):
                g = self.golden[gname]
                r = self._run(frozen)
                self.assertEqual(r["counts"]["miss"], 0, "the script made a call that was not prefetched")
                self.assertEqual(r["counts"]["http"], g["counts"]["http"])
                cond = read(r["conditions"])
                self.assertEqual(len(cond), len(g["conditions"]))
                self.assertEqual(sha(cond), sha(g["conditions"]), "conditions.json differs")
                self.assertEqual(read(r["export"]), g["export"], "locations export differs")
                self.assertEqual(r["graph_files"], sorted(g["graph"]), "graph file set differs")
                for name in r["graph_files"]:
                    self.assertEqual(read(os.path.join(r["graph_dir"], name)), g["graph"][name], f"graph/{name} differs")
                mine = [{"url": e["url"].split("/api/")[-1], "body": e["body"]} for e in r["effects"] if e["method"] == "POST"]
                self.assertEqual(mine, g["posts"], "observation archive / prune calls differ")
                self.assertEqual([e for e in r["effects"] if e["method"] == "PUT"], [], "no id-cache PUT expected for this fixture")

    def test_the_public_only_objects_equal_an_independent_filter_of_the_golden_output(self):
        for gname, frozen in CLOCKS:
            with self.subTest(clock=frozen):
                g = self.golden[gname]
                want = golden_public(g)
                r = self._run(frozen)
                have = {k: t for k, t, _ in publish.iter_owner_objects("public", r)}
                self.assertEqual(json.loads(have["conditions.json"]), want["conditions"])
                self.assertEqual(json.loads(have["graph/index.json"])["locations"], want["index"])
                self.assertEqual(json.loads(have["locations.json"]), want["export"])
                for e in want["index"]:
                    self.assertEqual(have["graph/" + e["file"]], g["graph"][e["file"]])
                # exactly the public graph files, nothing else
                self.assertEqual({k for k in have if k.startswith("graph/") and k != "graph/index.json"}, {"graph/" + e["file"] for e in want["index"]})

    def test_end_to_end_publish_matches_and_leaks_no_private_location(self):
        gname, frozen = CLOCKS[0]
        g = self.golden[gname]
        want = golden_public(g)
        private = sorted({l["name"] for l in json.loads(g["conditions"])["locations"] if l["ownerId"] != "public"})
        self.assertTrue(private, "the fixture should contain private locations")

        class World:
            def __init__(s, meta, raw):
                s.meta, s.raw, s.sent = meta, raw, []

            async def transport(s, method, url, headers, body):
                if url.startswith(URL):
                    if url.endswith("/api/pipeline/locations"):
                        return 200, json.dumps(s.meta["locations"]), None
                    s.sent.append((method, url, json.loads(body) if body else None))
                    return 200, "{}", None
                k = plan.key_for(url, API_KEY)
                return (200, s.raw[k], None) if k in s.raw else (404, "", None)

        class Store:
            def __init__(s):
                s.objects = {"latest.json": json.dumps({"runId": "prev", "generatedAt": "2026-10-07T02:30:00+00:00", "manifest": "runs/prev/manifest.json", "conditions": "runs/prev/conditions.json"}),
                             "runs/prev/manifest.json": json.dumps({"counts": {"rows": 1}}), "runs/prev/conditions.json": self.prev}

            async def get_text(s, k): return s.objects.get(k)
            async def put_text(s, k, t, c="application/json", cc=None): s.objects[k] = t
            async def list_run_ids(s): return sorted({k.split("/")[1] for k in s.objects if k.startswith("runs/")})
            async def delete_run(s, r):
                for k in [k for k in s.objects if k.startswith(f"runs/{r}/")]:
                    del s.objects[k]

        world, store = World(self.meta, self.raw), Store()
        n = netmod.Net(world.transport, secret=API_KEY, backoff=0, sleep=lambda s: asyncio.sleep(0))
        cfg = service.Config(api_key=API_KEY, pipeline_url=URL, pipeline_token=TOKEN, obs_prune="dry", keep_runs=3)
        now = datetime.fromisoformat(frozen)
        s = asyncio.run(service.run_pipeline(cfg, n, store, None, now, "cron", frozen_iso=frozen, log=lambda *a: None))
        self.assertTrue(s["ok"] and s["published"], s)
        rid = s["runId"]
        self.assertEqual(json.loads(store.objects[f"runs/{rid}/conditions.json"]), want["conditions"])
        self.assertEqual(json.loads(store.objects[f"runs/{rid}/locations.json"]), want["export"])
        blob = "\n".join(v for k, v in store.objects.items() if k != "runs/prev/conditions.json")
        for name in private:
            self.assertNotIn(name, blob, "a private location name leaked into a published object")
        self.assertEqual({l["ownerId"] for l in json.loads(store.objects[f"runs/{rid}/conditions.json"])["locations"]}, {"public"})
        # the archive POSTs the Worker replays equal the golden ones (private locations' archive rows go to the internal user Worker, not R2)
        posts = [{"url": u.split("/api/")[-1], "body": b} for m, u, b in world.sent if m == "POST"]
        self.assertEqual(posts, g["posts"])
        self.assertEqual(s["effects"]["failed"], 0)


if __name__ == "__main__":
    unittest.main()
