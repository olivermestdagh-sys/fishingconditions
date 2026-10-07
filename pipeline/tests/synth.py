"""A tiny synthetic world for the pipeline tests: two Public locations and one private one (with obviously fake names), the
WillyWeather / Open-Meteo responses for them, and fakes for the network, R2 and D1. No real location data lives in the repo.
"""
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))
import tmpguard  # noqa: E402,F401  (all temp output of the tests goes to one folder removed at exit)

import plan  # noqa: E402

NOW_ISO = "2026-10-07T05:30:00+00:00"
PRIVATE_NAME = "Zzz Private Hideaway"
PIPELINE_URL = "https://user.example"
TOKEN = "tok"
KEY = "WWKEY123"


def _types(*names):
    return [{"type": n, "behavesLike": n, "driveTo": 10, "driveBack": 10, "setUp": 5, "packUp": 5, "timeToSpot": 5, "timeFromSpot": 5} for n in names]


def locations(with_ids=True):
    def loc(i, name, owner, shore, types):
        return {"id": f"loc{i}", "ownerId": owner, "name": name, "displayName": name, "shore": shore, "tidal": True,
                "locationGroup": None, "locationGroups": [], "tideOffset": 0, "hhwOffset": None, "lhwOffset": None,
                "hlwOffset": None, "llwOffset": None, "willyweatherId": (100 + i) if with_ids else None,
                "willyweatherName": None, "willyweatherRegion": None, "willyweatherState": None,
                "lat": -38.0 - i * 0.1, "lng": 145.0 + i * 0.1,
                # what the script computes from weather_payload(i): the highest tide event, so a steady-state run needs no id-cache PUT
                "tideMaxObserved": round(1.6 + 0.1 * i, 2) if with_ids else None, "types": types}
    return [
        loc(1, "Alpha Beach", "public", "N", _types("Kayak", "Land based")),
        loc(2, "Bravo Pier", "public", "SW", _types("Kayak")),
        loc(3, PRIVATE_NAME, "owner-x", "E", _types("Kayak")),
    ]


def _days(start="2026-10-07", n=3):
    d0 = datetime.fromisoformat(start)
    return [d0 + timedelta(days=i) for i in range(n)]


def weather_payload(seed=1):
    days = _days()
    fmt = lambda dt: dt.strftime("%Y-%m-%d %H:%M:%S")
    temp, wind, rain, tides, sun = [], [], [], [], []
    dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    for d in days:
        t_entries, w_entries, r_entries = [], [], []
        for h in range(0, 24, 3):
            dt = d + timedelta(hours=h)
            t_entries.append({"dateTime": fmt(dt), "temperature": 12 + seed + h / 4})
            w_entries.append({"dateTime": fmt(dt), "speed": 4 + (h * seed) % 17 + 0.5, "directionText": dirs[(h // 3 + seed) % 8]})
            r_entries.append({"dateTime": fmt(dt), "probability": (h * 5) % 60})
        temp.append({"dateTime": fmt(d), "entries": t_entries})
        wind.append({"dateTime": fmt(d), "entries": w_entries})
        rain.append({"dateTime": fmt(d), "entries": r_entries})
        tides.append({"dateTime": fmt(d), "entries": [
            {"dateTime": fmt(d + timedelta(hours=2, minutes=seed)), "height": 0.4 + seed * 0.1, "type": "low"},
            {"dateTime": fmt(d + timedelta(hours=8, minutes=seed)), "height": 1.6 + seed * 0.1, "type": "high"},
            {"dateTime": fmt(d + timedelta(hours=14, minutes=seed)), "height": 0.5 + seed * 0.1, "type": "low"},
            {"dateTime": fmt(d + timedelta(hours=20, minutes=seed)), "height": 1.5 + seed * 0.1, "type": "high"}]})
        sun.append({"dateTime": fmt(d), "entries": [{
            "firstLightDateTime": fmt(d + timedelta(hours=5, minutes=50)), "riseDateTime": fmt(d + timedelta(hours=6, minutes=20)),
            "setDateTime": fmt(d + timedelta(hours=19, minutes=20)), "lastLightDateTime": fmt(d + timedelta(hours=19, minutes=50))}]})
    return {"forecasts": {"temperature": {"days": temp}, "wind": {"days": wind}, "rainfallprobability": {"days": rain},
                          "tides": {"days": tides}, "sunrisesunset": {"days": sun}, "swell": None}}


def moon_payload():
    return {"forecasts": {"moonphases": {"days": [{"dateTime": f"2026-10-0{7 + i} 00:00:00", "entries": [{"percentageFull": 10 - i * 4}]} for i in range(3)]}}}


def open_meteo_payloads():
    times = [(datetime(2026, 10, 6) + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M") for i in range(24 * 6)]
    fc = {"hourly": {"time": times, "pressure_msl": [1008 + (i % 30) / 2 for i in range(len(times))]}}
    mr = {"hourly": {"time": times, "sea_surface_temperature": [14 + (i % 10) / 10 for i in range(len(times))],
                     "ocean_current_velocity": [(i % 7) / 3 for i in range(len(times))], "ocean_current_direction": [(i * 13) % 360 for i in range(len(times))]}}
    return fc, mr


def responses(locs=None, *, drop_weather=()):
    """{plan key: JSON text} for every location's responses. `drop_weather`: location ids whose weather is missing."""
    locs = locs or locations()
    out = {}
    fc_p, mr_p = open_meteo_payloads()
    for i, loc in enumerate(plan.physical_locations(locs), start=1):
        if loc["willyweatherId"] not in drop_weather:
            out[f"weather:{loc['willyweatherId']}"] = json.dumps(weather_payload(i))
        out[f"om_fc:{plan.f6(loc['lat'])}:{plan.f6(loc['lng'])}"] = json.dumps(fc_p)
        out[f"om_mr:{plan.f6(loc['lat'])}:{plan.f6(loc['lng'])}"] = json.dumps(mr_p)
    out[f"moon:{locs[0]['willyweatherId']}"] = json.dumps(moon_payload())
    return out


class FakeNetwork:
    """A transport (GET-by-key for the weather APIs; records everything sent to the user Worker) + a canned locations answer."""

    def __init__(self, locs, resp, api_key=KEY):
        self.locs, self.resp, self.api_key = locs, resp, api_key
        self.sent = []   # (method, url, body) to the user Worker
        self.gets = []   # urls fetched from the weather APIs
        self.fail = {}   # key -> status to answer with instead

    async def transport(self, method, url, headers, body):
        if url.startswith(PIPELINE_URL):
            if method == "GET" and url.endswith("/api/pipeline/locations"):
                assert headers.get("X-Pipeline-Token") == TOKEN
                return 200, json.dumps(self.locs), None
            assert headers.get("X-Pipeline-Token") == TOKEN
            self.sent.append((method, url, json.loads(body) if body else None))
            return 200, "{}", None
        self.gets.append(url)
        key = plan.key_for(url, self.api_key)
        if key in self.fail:
            return self.fail[key], "", None
        if key in self.resp:
            return 200, self.resp[key], None
        return 404, "", None


class FakeStore:
    """In-memory stand-in for R2Store. `view(prefix)` shares the same backing dict, like R2Store.view."""

    def __init__(self, objects=None, prefix="", meta=None, writes=None, ops=None):
        self.all = {} if objects is None else objects
        self.prefix = prefix
        self.meta = {} if meta is None else meta
        self.all_writes = [] if writes is None else writes
        # R2 operation counters (shared by every view): the Cloudflare cost model is per operation, so tests can pin it
        self.ops = {"get": 0, "head": 0, "put": 0, "list": 0, "delete": 0} if ops is None else ops

    def reset_ops(self):
        for k in self.ops:
            self.ops[k] = 0

    # the tests read/write `.objects` as if there were no prefix
    @property
    def objects(self):
        return _PrefixDict(self.all, self.prefix)

    @property
    def writes(self):
        return [w[len(self.prefix):] for w in self.all_writes if w.startswith(self.prefix)]

    def view(self, prefix):
        return FakeStore(self.all, self.prefix + prefix, self.meta, self.all_writes, self.ops)

    async def get_text(self, key):
        self.ops["get"] += 1
        return self.all.get(self.prefix + key)

    async def exists(self, key):
        self.ops["head"] += 1
        return self.prefix + key in self.all

    async def put_text(self, key, text, content_type="application/json", cache_control=None):
        self.ops["put"] += 1
        self.all[self.prefix + key] = text
        self.meta[self.prefix + key] = (content_type, cache_control)
        self.all_writes.append(self.prefix + key)

    async def list_keys(self, prefix=""):
        self.ops["list"] += 1
        p = self.prefix + prefix
        return sorted(k[len(self.prefix):] for k in self.all if k.startswith(p))

    async def delete_key(self, key):
        self.ops["delete"] += 1
        self.all.pop(self.prefix + key, None)

    async def list_run_ids(self):
        self.ops["list"] += 1
        p = self.prefix + "runs/"
        return sorted({k[len(p):].split("/")[0] for k in self.all if k.startswith(p)})

    async def delete_run(self, run_id):
        p = f"{self.prefix}runs/{run_id}/"
        for k in [k for k in self.all if k.startswith(p)]:
            del self.all[k]


class _PrefixDict:
    """dict-like view of FakeStore.all under a prefix (enough for the tests: [], in, get, items, values, keys, iteration)."""

    def __init__(self, d, prefix):
        self.d, self.p = d, prefix

    def __getitem__(self, k): return self.d[self.p + k]
    def __setitem__(self, k, v): self.d[self.p + k] = v
    def __contains__(self, k): return self.p + k in self.d
    def get(self, k, default=None): return self.d.get(self.p + k, default)
    def keys(self): return [k[len(self.p):] for k in self.d if k.startswith(self.p)]
    def __iter__(self): return iter(self.keys())
    def values(self): return [self.d[self.p + k] for k in self.keys()]
    def items(self): return [(k, self.d[self.p + k]) for k in self.keys()]
    def __len__(self): return len(self.keys())
    def __delitem__(self, k): del self.d[self.p + k]
    def pop(self, k, *default): return self.d.pop(self.p + k, *default)


class FakeDB:
    """D1-shaped wrapper over sqlite3: prepare(sql).bind(*args).run() -> {"meta": {"changes": n}}."""

    def __init__(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.execute("CREATE TABLE pipeline_lock (id TEXT PRIMARY KEY, run_id TEXT NOT NULL DEFAULT '', locked_until INTEGER NOT NULL DEFAULT 0)")

    def prepare(self, sql):
        db = self

        class Stmt:
            def __init__(self):
                self.args = ()

            def bind(self, *a):
                self.args = a
                return self

            async def run(self):
                cur = db.conn.execute(sql, self.args)
                db.conn.commit()
                return {"meta": {"changes": cur.rowcount}}

            async def first(self):
                cur = db.conn.execute(sql, self.args)
                row = cur.fetchone()
                return None if row is None else {d[0]: v for d, v in zip(cur.description, row)}

        return Stmt()

    def __del__(self):
        try:
            self.conn.close()
        except Exception:
            pass

    def row(self):
        return self.conn.execute("SELECT id, run_id, locked_until FROM pipeline_lock").fetchone()
