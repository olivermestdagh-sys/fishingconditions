#!/usr/bin/env python3
"""
classify_tide_types.py — pulls WillyWeather's real tide events for Lang
Lang Boat Ramp across the date range we've been logging observations
against, and labels each one HHW / LHW / HLW / LLW by comparing it to its
same-day, same-type sibling (the two highs, or the two lows, of that
calendar day).

Reuses the exact same API call shape, auth, and location-resolution logic
as scripts/fetch_conditions.py, rather than inventing a new pattern — same
WILLYWEATHER_API_KEY env var, same BASE_URL, same coordinate-search-then-
weather-call sequence. If you can run fetch_conditions.py, you can run
this the same way.

ONE THING I COULDN'T VERIFY FIRSTHAND: whether WillyWeather's
/weather.json endpoint accepts a `startDate` parameter for PAST dates the
same way it's documented to for future ones — fetch_conditions.py never
needed to look backward, so there's no existing example in the codebase
to copy. It's a standard, commonly-supported parameter for this kind of
API, so I'm confident enough to hand this to you rather than make you
guess — but if the request comes back empty or errors, that's the first
thing to check. The exact URL being called is printed to stderr for each
request, so you can test it directly in a browser if needed.

Run with:
    WILLYWEATHER_API_KEY=xxxx python3 classify_tide_types.py

Output is a plain table — date/time, height, and label — covering every
high and low from Sept 2 to Sept 21. Cross-reference this against our
logged observations by date; I didn't try to bake that matching into the
script itself, since transcribing all those predicted/actual times again
by hand here risked introducing new errors rather than avoiding them.
"""

import json
import os
import sys
import urllib.request
from datetime import datetime

API_KEY = os.environ.get("WILLYWEATHER_API_KEY")
BASE_URL = "https://api.willyweather.com.au/v2"

# Lang Lang Boat Ramp's coordinates, straight from config/locations.json —
# same values fetch_conditions.py's own search_location_by_coords uses.
LAT = -38.3052
LNG = 145.5214
SEARCH_RANGE_KM = 25

# Covers every date we've logged an observation against, Sept 3 - Sept 20,
# with a day of padding either side.
START_DATE = "2026-09-02"
DAYS = 20


def http_get_json(url):
    req = urllib.request.Request(url, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def search_location_by_coords(lat, lng):
    """Identical to fetch_conditions.py's own function of the same name —
    see that file's comments for why `range` + `units` are both required
    and why the response is a single {"location": {...}} object, not a
    list."""
    url = (
        f"{BASE_URL}/{API_KEY}/search.json?lat={lat}&lng={lng}"
        f"&range={SEARCH_RANGE_KM}&units=distance:km"
    )
    data = http_get_json(url)
    if isinstance(data, dict) and data.get("location"):
        return data["location"]
    return None


def get_tide_events(location_id, start_date, days):
    url = (
        f"{BASE_URL}/{API_KEY}/locations/{location_id}/weather.json"
        f"?forecasts=tides&startDate={start_date}&days={days}"
    )
    print(f"[fetching] {url}", file=sys.stderr)
    data = http_get_json(url)
    tide_days = ((data.get("forecasts", {}) or {}).get("tides") or {}).get("days") or []
    events = []
    for day in tide_days:
        for entry in day.get("entries", []):
            dt_str = entry.get("dateTime")
            height = entry.get("height")
            etype = entry.get("type")  # expected: "high" or "low"
            if dt_str and height is not None and etype:
                events.append((datetime.fromisoformat(dt_str), float(height), etype))
    events.sort(key=lambda e: e[0])
    return events


def classify(events):
    """Groups events by calendar date, then labels each high as HHW/LHW
    and each low as LLW/HLW by comparing it to its same-day, same-type
    sibling. A day missing one of its pair (can happen right at the edge
    of the requested window) is labeled accordingly rather than guessed
    at."""
    by_date = {}
    for dt, height, etype in events:
        by_date.setdefault(dt.date(), []).append((dt, height, etype))

    labeled = []
    for d in sorted(by_date):
        day_events = by_date[d]
        highs = [(dt, h) for dt, h, t in day_events if t == "high"]
        lows = [(dt, h) for dt, h, t in day_events if t == "low"]
        for dt, h in highs:
            if len(highs) >= 2:
                label = "HHW" if h == max(hh for _, hh in highs) else "LHW"
            else:
                label = "H (only one this day)"
            labeled.append((dt, h, label))
        for dt, h in lows:
            if len(lows) >= 2:
                label = "LLW" if h == min(hh for _, hh in lows) else "HLW"
            else:
                label = "L (only one this day)"
            labeled.append((dt, h, label))
    labeled.sort(key=lambda x: x[0])
    return labeled


def main():
    if not API_KEY:
        print("Set WILLYWEATHER_API_KEY first, same as fetch_conditions.py.", file=sys.stderr)
        sys.exit(1)

    location = search_location_by_coords(LAT, LNG)
    if not location:
        print("Could not resolve Lang Lang's location ID from WillyWeather's coordinate search.", file=sys.stderr)
        sys.exit(1)
    location_id = location.get("id")
    print(f"Resolved location: {location.get('name')} (id={location_id})\n")

    events = get_tide_events(location_id, START_DATE, DAYS)
    if not events:
        print("No tide events came back — see the ONE THING I COULDN'T VERIFY note at the top of this file.")
        sys.exit(1)

    labeled = classify(events)

    print(f"{'Date/time':<18} {'Height':>7}  Label")
    print("-" * 40)
    for dt, h, label in labeled:
        print(f"{dt.strftime('%Y-%m-%d %H:%M'):<18} {h:>6.2f}m  {label}")


if __name__ == "__main__":
    main()
