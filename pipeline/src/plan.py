"""Which responses the (synchronous, unmodified) fetch_conditions.py will ask for, fetched FIRST and asynchronously.

fetch_conditions.py is plain synchronous code (urllib + a thread pool). Pyodide can do neither, and rewriting ~1,800 lines
of scoring around `await` would be a big, risky diff. So the Worker does the network part itself: it works out every URL the
script will request, fetches them all concurrently (at most `limit` in flight: a Worker may hold only 6 open connections),
keeps the raw response TEXT in a dict, and then runs the script untouched with its HTTP helper pointed at that dict.

The URLs are produced by calling the script's OWN url-building functions (get_weather, get_pressure_forecast, ...) with a
recording stand-in for http_get_json, so they can never drift from what the script later asks for. A request the script
makes that was not prefetched simply comes back as a failure (the same as a failed HTTP call today) and is counted as a
"miss" so a test (or the publish gate) can see it.

The script's resolution tiers (cached WillyWeather id -> coordinate search -> name search, plus the self-heal when a cached
id returns nothing) need answers that depend on earlier answers, so `prefetch` runs in waves and mirrors that logic.
"""
import asyncio
import json
import re

import fetch_conditions as fc


def f6(v):
    return f"{float(v):.6f}"


def host_for(url):
    if url.startswith(fc.BASE_URL):
        return "willyweather"
    if "marine-api" in url:
        return "open-meteo-marine"
    return "open-meteo"


def key_for(url, api_key):
    """The dict key a response is stored under (and that the script's HTTP stand-in looks up)."""
    m = re.search(r"/locations/(\d+)/weather\.json\?forecasts=([^&]+)", url)
    if m:
        return ("moon:" if m.group(2) == "moonphases" else "weather:") + m.group(1)
    m = re.search(r"latitude=([-\d.]+)&longitude=([-\d.]+)", url)
    if m:
        return ("om_mr:" if "marine-api" in url else "om_fc:") + f6(m.group(1)) + ":" + f6(m.group(2))
    return "url:" + (url.replace(api_key, "{KEY}") if api_key else url)


class _Recorder:
    """Run one of the script's own request-building functions and capture the URL it would have fetched."""

    def __init__(self, api_key, days):
        self.api_key, self.days = api_key, days

    def url(self, fn, *args):
        seen = []
        saved = (fc.http_get_json, fc.API_KEY, fc.FORECAST_DAYS)
        fc.http_get_json = lambda url, **kw: (seen.append(url) or None)
        fc.API_KEY, fc.FORECAST_DAYS = self.api_key, self.days
        try:
            fn(*args)
        finally:
            fc.http_get_json, fc.API_KEY, fc.FORECAST_DAYS = saved
        return seen[0] if seen else None

    def weather(self, wid): return self.url(fc.get_weather, wid)
    def moon(self, wid): return self.url(fc.get_moon_phases, wid)
    def pressure(self, lat, lng): return self.url(fc.get_pressure_forecast, lat, lng)
    def marine(self, lat, lng): return self.url(fc.get_marine_forecast, lat, lng)
    def search_name(self, name): return self.url(fc.search_location, name)
    def search_coords(self, lat, lng): return self.url(fc.search_location_by_coords, lat, lng)


def physical_locations(locations):
    """One entry per physical location (a name), first occurrence wins: the script makes its calls per `loc` entry, and
    config/D1 hold one entry per location with its types inside."""
    seen, out = set(), []
    for loc in locations:
        if loc["name"] in seen:
            continue
        seen.add(loc["name"])
        out.append(loc)
    return out


def _has_data(text):
    """The script treats a response as 'no data' when it is missing or parses to an empty object/list."""
    if not text:
        return False
    try:
        return bool(json.loads(text))
    except ValueError:
        return False


def _match_from(search_text, by_coords):
    """Mirror search_location / search_location_by_coords: the matched location dict, or None."""
    if not search_text:
        return None
    try:
        data = json.loads(search_text)
    except ValueError:
        return None
    if by_coords:
        return data["location"] if isinstance(data, dict) and data.get("location") else None
    return data[0] if isinstance(data, list) and data else None


async def prefetch(get, locations, api_key, days, limit=6):
    """Fetch every response the script will ask for. `get(url, host)` -> text or None (the caller supplies retries/stats).

    Returns {key: text}. Never raises for a failed individual call: a missing key is what a failed HTTP call looks like to
    the script, which already tolerates it (and the publish gate watches how many locations came back empty).
    """
    rec = _Recorder(api_key, days)
    sem = asyncio.Semaphore(limit)
    raw = {}

    async def fetch(url):
        key = key_for(url, api_key)
        if key in raw:
            return raw[key]
        async with sem:
            text = await get(url, host_for(url))
        if text is not None:
            raw[key] = text
        return text

    phys = physical_locations(locations)

    # Wave 1: everything that needs no earlier answer. A cached id -> weather straight away; a stored lat/lng -> Open-Meteo.
    async def wave1(loc):
        jobs = []
        if loc.get("willyweatherId"):
            jobs.append(fetch(rec.weather(loc["willyweatherId"])))
        if loc.get("lat") is not None and loc.get("lng") is not None:
            jobs.append(fetch(rec.pressure(loc["lat"], loc["lng"])))
            jobs.append(fetch(rec.marine(loc["lat"], loc["lng"])))
        await asyncio.gather(*jobs)

    moon_jobs = []
    first = locations[0] if locations else None
    if first is not None and first.get("willyweatherId"):
        moon_jobs.append(fetch(rec.moon(first["willyweatherId"])))
    await asyncio.gather(*[wave1(l) for l in phys], *moon_jobs)

    # Wave 2: locations the script will have to resolve itself: no cached id, or a cached id that returned nothing.
    async def resolve(loc):
        cached = loc.get("willyweatherId")
        if cached and _has_data(raw.get(key_for(rec.weather(cached), api_key))):
            return
        lat, lng = loc.get("lat"), loc.get("lng")
        match = None
        if lat is not None and lng is not None:
            match = _match_from(await fetch(rec.search_coords(lat, lng)), True)
            if not match:
                match = _match_from(await fetch(rec.search_name(loc["name"])), False)
        else:
            match = _match_from(await fetch(rec.search_name(loc["name"])), False)
        if not match:
            return
        jobs = [fetch(rec.weather(match.get("id")))]
        if lat is None or lng is None:
            jobs += [fetch(rec.pressure(match.get("lat"), match.get("lng"))), fetch(rec.marine(match.get("lat"), match.get("lng")))]
        await asyncio.gather(*jobs)

    await asyncio.gather(*[resolve(l) for l in phys])

    # The moon phase: if the first location has no cached id the script name-searches it to find one.
    if first is not None and not first.get("willyweatherId"):
        match = _match_from(await fetch(rec.search_name(first["name"])), False)
        if match:
            await fetch(rec.moon(match.get("id")))
    return raw


def expected_counts(locations):
    """For the fast path (every location has a cached id and coordinates): how many responses prefetch should hold."""
    return 3 * len(physical_locations(locations)) + 1
