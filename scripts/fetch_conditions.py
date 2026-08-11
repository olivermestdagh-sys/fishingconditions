#!/usr/bin/env python3
"""
Fetches kayak/surf conditions from the WillyWeather API and writes a static
JSON file the website reads. This is a Python port of the same logic used in
the Excel workbook's Power Query "Conditions" query, so the numbers and
column meanings should match exactly.

Run with:
    WILLYWEATHER_API_KEY=xxxx python3 fetch_conditions.py

Environment variables:
    WILLYWEATHER_API_KEY  (required) - your WillyWeather API key
    FORECAST_DAYS         (optional) - how many days ahead to pull, default 6
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

API_KEY = os.environ.get("WILLYWEATHER_API_KEY")
FORECAST_DAYS = int(os.environ.get("FORECAST_DAYS", "6"))
BASE_URL = "https://api.willyweather.com.au/v2"
CONFIG_PATH = os.path.join(os.path.dirname(__file__), "..", "config", "locations.json")
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "conditions.json")

COMPASS_DEGREES = {
    "N": 0, "NNE": 22.5, "NE": 45, "ENE": 67.5, "E": 90, "ESE": 112.5, "SE": 135, "SSE": 157.5,
    "S": 180, "SSW": 202.5, "SW": 225, "WSW": 247.5, "W": 270, "WNW": 292.5, "NW": 315, "NNW": 337.5,
}


def http_get_json(url, retries=3, backoff=2.0):
    """GET a URL and parse JSON, with a couple of retries for transient errors."""
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001 - we want to retry on anything transient
            last_err = e
            if attempt < retries - 1:
                time.sleep(backoff * (attempt + 1))
    print(f"WARNING: request failed after {retries} attempts: {url}\n  {last_err}", file=sys.stderr)
    return None


def search_location(name):
    url = f"{BASE_URL}/{API_KEY}/search.json?query={urllib.parse.quote(name)}&limit=1"
    data = http_get_json(url)
    if not data:
        return None
    if isinstance(data, list) and len(data) > 0:
        return data[0]
    return None


def get_weather(location_id):
    url = (
        f"{BASE_URL}/{API_KEY}/locations/{location_id}/weather.json"
        f"?forecasts=temperature,wind,rainfallprobability,tides,sunrisesunset"
        f"&days={FORECAST_DAYS}&observationalGraphs=temperature,wind"
    )
    data = http_get_json(url)
    return data or {}


def extract_sun_times(weather):
    """Returns a list of {date, firstLight, sunrise, sunset, lastLight} — one per forecast day."""
    days = ((weather.get("forecasts", {}) or {}).get("sunrisesunset") or {}).get("days") or []
    out = []
    for day in days:
        entries = day.get("entries") or []
        if not entries:
            continue
        e = entries[0]
        date_str = (day.get("dateTime") or "")[:10]
        if not date_str:
            continue
        out.append({
            "date": date_str,
            "firstLight": e.get("firstLightDateTime"),
            "sunrise": e.get("riseDateTime"),
            "sunset": e.get("setDateTime"),
            "lastLight": e.get("lastLightDateTime"),
        })
    return out


def get_numeric_field(entry):
    """Mirrors GetNumericField in the M query: grabs whatever numeric field is
    present on a temperature forecast entry, regardless of its exact name."""
    for key, val in entry.items():
        if key in ("dateTime", "type"):
            continue
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            return val
    return None


def epoch_to_local_dt(epoch):
    """WillyWeather graph timestamps are epoch seconds but already represent
    local wall-clock time (per their docs), so we convert using UTC math and
    do NOT apply any further timezone shift."""
    if epoch is None:
        return None
    return datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=epoch)


def build_readings(weather):
    """Returns a list of (series, datetime, value) tuples for one location's weather payload."""
    readings = []

    forecasts = weather.get("forecasts", {}) or {}

    temp_days = ((forecasts.get("temperature") or {}).get("days")) or []
    for day in temp_days:
        for entry in day.get("entries", []):
            readings.append(("Temp Forecast (C)", entry.get("dateTime"), get_numeric_field(entry)))

    wind_days = ((forecasts.get("wind") or {}).get("days")) or []
    for day in wind_days:
        for entry in day.get("entries", []):
            readings.append(("Wind Forecast (km/h)", entry.get("dateTime"), entry.get("speed")))
            readings.append(("Wind Forecast Dir", entry.get("dateTime"), entry.get("directionText") or entry.get("direction")))

    rain_days = ((forecasts.get("rainfallprobability") or {}).get("days")) or []
    for day in rain_days:
        for entry in day.get("entries", []):
            readings.append(("Rainfall Probability (%)", entry.get("dateTime"), entry.get("probability")))

    tide_days = ((forecasts.get("tides") or {}).get("days")) or []
    for day in tide_days:
        for entry in day.get("entries", []):
            readings.append(("Tide Height (m)", entry.get("dateTime"), entry.get("height")))
            readings.append(("Tide Type", entry.get("dateTime"), entry.get("type")))

    # Hourly realtime readings for today, from observationalGraphs
    obs_graphs = weather.get("observationalGraphs", {}) or {}

    temp_graph = (obs_graphs.get("temperature") or {}).get("dataConfig", {}).get("series", {}).get("groups", [])
    for group in temp_graph:
        for point in group.get("points", []):
            dt = epoch_to_local_dt(point.get("x"))
            readings.append(("Temp Realtime (C)", dt, point.get("y")))

    wind_graph = (obs_graphs.get("wind") or {}).get("dataConfig", {}).get("series", {}).get("groups", [])
    for group in wind_graph:
        for point in group.get("points", []):
            dt = epoch_to_local_dt(point.get("x"))
            readings.append(("Wind Realtime (km/h)", dt, point.get("y")))
            readings.append(("Wind Realtime Dir", dt, point.get("directionText")))

    return readings


def normalize_dt(v):
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.replace(tzinfo=None) if v.tzinfo else v
    try:
        return datetime.strptime(str(v), "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def compass_to_degrees(direction):
    if not direction:
        return None
    return COMPASS_DEGREES.get(str(direction).strip().upper())


def angle_diff(a, b):
    if a is None or b is None:
        return None
    raw = abs(a - b)
    return 360 - raw if raw > 180 else raw


def compute_condition(loc_type, shore, wind_dir, wind_speed):
    if loc_type == "Surf":
        diff = angle_diff(compass_to_degrees(shore), compass_to_degrees(wind_dir))
        if diff is None:
            return None
        if diff == 0:
            return 5
        if diff == 90:
            return 3
        if diff == 180:
            return 1
        if diff == 45:
            return 4
        return 2
    if loc_type == "Kayak":
        if wind_speed is None:
            return None
        if wind_speed < 5:
            return 5
        if wind_speed < 10:
            return 4
        if wind_speed < 15:
            diff = angle_diff(compass_to_degrees(shore), compass_to_degrees(wind_dir))
            if diff is None:
                return None
            return 4 if diff <= 90 else 3
        if wind_speed < 20:
            return 2
        return 1
    return None


def process_location(loc):
    name = loc["name"]
    loc_type = loc.get("type")
    shore = loc.get("shore")

    match = search_location(name)
    matched_name = match.get("name") if match else None
    region = match.get("region") if match else None
    state = match.get("state") if match else None
    loc_id = match.get("id") if match else None

    weather = get_weather(loc_id) if loc_id else {}
    raw_readings = build_readings(weather)

    # Pivot: group by normalized DateTime into one record per timestamp
    by_dt = {}
    for series, dt_raw, value in raw_readings:
        dt = normalize_dt(dt_raw)
        if dt is None or value is None:
            continue
        key = dt.isoformat()
        rec = by_dt.setdefault(key, {"dateTime": key})
        rec[series] = value

    rows = sorted(by_dt.values(), key=lambda r: r["dateTime"])

    # Tide Status: Low/High from the tide event's own type; everything else is
    # Incoming/Outgoing based on the nearest known tide event before/after it.
    prev_type, next_type_by_idx = None, [None] * len(rows)
    running_next = None
    for i in range(len(rows) - 1, -1, -1):
        if rows[i].get("Tide Type"):
            running_next = rows[i]["Tide Type"]
        next_type_by_idx[i] = running_next if not rows[i].get("Tide Type") else rows[i]["Tide Type"]

    running_prev = None
    for i, row in enumerate(rows):
        this_type = row.get("Tide Type")
        prev_for_row = running_prev
        next_for_row = next_type_by_idx[i]

        if row.get("Tide Height (m)") is not None and this_type == "low":
            status = "Low"
        elif row.get("Tide Height (m)") is not None and this_type == "high":
            status = "High"
        elif prev_for_row is None and next_for_row == "high":
            status = "Incoming"
        elif prev_for_row is None and next_for_row == "low":
            status = "Outgoing"
        elif next_for_row is None and prev_for_row == "high":
            status = "Outgoing"
        elif next_for_row is None and prev_for_row == "low":
            status = "Incoming"
        elif prev_for_row == "low" and next_for_row == "high":
            status = "Incoming"
        elif prev_for_row == "high" and next_for_row == "low":
            status = "Outgoing"
        else:
            status = None

        row["Tide Status"] = status
        row.pop("Tide Type", None)

        if this_type:
            running_prev = this_type

        row["Condition"] = compute_condition(
            loc_type, shore, row.get("Wind Forecast Dir"), row.get("Wind Forecast (km/h)")
        )
        row["Location Name"] = name
        row["Type"] = loc_type
        row["Shore"] = shore
        row["Matched Name"] = matched_name
        row["Region"] = region
        row["State"] = state

    sun_times = extract_sun_times(weather)
    return rows, sun_times


def main():
    if not API_KEY:
        print("ERROR: WILLYWEATHER_API_KEY environment variable is not set.", file=sys.stderr)
        sys.exit(1)

    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        locations = json.load(f)

    all_rows = []
    sun_times_by_location = {}
    for loc in locations:
        print(f"Fetching {loc['name']}...")
        try:
            rows, sun_times = process_location(loc)
            all_rows.extend(rows)
            sun_times_by_location[loc["name"]] = sun_times
        except Exception as e:  # noqa: BLE001 - one bad location shouldn't kill the whole run
            print(f"WARNING: failed to process {loc['name']}: {e}", file=sys.stderr)

    output = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "forecastDays": FORECAST_DAYS,
        "locations": locations,
        "rows": all_rows,
        "sunTimes": sun_times_by_location,
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, default=str)

    print(f"Wrote {len(all_rows)} rows to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
