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
OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
OPEN_METEO_MARINE_URL = "https://marine-api.open-meteo.com/v1/marine"
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


def get_pressure_forecast(lat, lng):
    """Hourly mean-sea-level pressure from Open-Meteo (free, no API key) —
    WillyWeather only offers pressure as a current/observational reading,
    not a multi-day forecast, so this fills that specific gap."""
    if lat is None or lng is None:
        return {}
    url = (
        f"{OPEN_METEO_FORECAST_URL}?latitude={lat}&longitude={lng}"
        f"&hourly=pressure_msl&forecast_days={min(FORECAST_DAYS, 16)}&timezone=auto"
    )
    data = http_get_json(url)
    if not data:
        return {}
    hourly = data.get("hourly", {}) or {}
    return dict(zip(hourly.get("time", []) or [], hourly.get("pressure_msl", []) or []))


def get_water_temp_forecast(lat, lng):
    """Hourly sea surface temperature from Open-Meteo's Marine API (free, no
    API key, a separate endpoint from the main forecast). past_days=1 so we
    can compute a trend for the very first day of our window too, not just
    day two onward. cell_selection=sea avoids the grid cell resolving to a
    nearby land pixel for coastal locations."""
    if lat is None or lng is None:
        return {}
    url = (
        f"{OPEN_METEO_MARINE_URL}?latitude={lat}&longitude={lng}"
        f"&hourly=sea_surface_temperature&forecast_days={min(FORECAST_DAYS, 8)}"
        f"&past_days=1&timezone=auto&cell_selection=sea"
    )
    data = http_get_json(url)
    if not data:
        return {}
    hourly = data.get("hourly", {}) or {}
    return dict(zip(hourly.get("time", []) or [], hourly.get("sea_surface_temperature", []) or []))


def normalize_open_meteo_dt(t):
    """Open-Meteo returns 'YYYY-MM-DDTHH:MM' (no seconds) — parse it so we
    can bucket by calendar date."""
    try:
        return datetime.strptime(t, "%Y-%m-%dT%H:%M")
    except (ValueError, TypeError):
        return None


def daily_averages(hourly_dict):
    """Given {iso_string: value}, returns {date_string: average_value}.
    Both pressure and water temperature are scored at daily granularity
    (a trend/typical-value concept), not hour by hour."""
    by_date = {}
    for t, v in hourly_dict.items():
        dt = normalize_open_meteo_dt(t)
        if dt is None or v is None:
            continue
        by_date.setdefault(dt.strftime("%Y-%m-%d"), []).append(v)
    return {d: sum(vals) / len(vals) for d, vals in by_date.items() if vals}


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


def tide_flow_degrees(tide_status):
    """Tidal current direction, fixed for all locations per local knowledge of
    how the tide actually runs through these bays (not derived from each
    location's own Shore bearing): incoming flows north, outgoing flows south."""
    if tide_status == "Incoming":
        return 0  # North
    if tide_status == "Outgoing":
        return 180  # South
    return None


def wind_tide_angle_diff(wind_dir, tide_status):
    """Angular difference between the wind's direction of travel and the
    tide's current direction: 0 = wind blowing exactly with the tide, 180 =
    directly against it. None if either isn't known, or near slack water
    (Low/High), where there's no meaningful current to be "against"."""
    tide_deg = tide_flow_degrees(tide_status)
    wind_deg = compass_to_degrees(wind_dir)
    if tide_deg is None or wind_deg is None:
        return None
    wind_travel_deg = (wind_deg + 180) % 360  # direction the wind is blowing TOWARD
    return angle_diff(wind_travel_deg, tide_deg)


def wind_against_tide_penalty(wind_dir, wind_speed, tide_status):
    """How much to subtract from the Kayak base score for wind opposing the
    tide's current — graduated rather than all-or-nothing:
      - Directly opposed (180°, e.g. wind straight from the south into a
        north-flowing incoming tide): full 1-point penalty.
      - Partially/quarteringly opposed (>90° but not dead-on, e.g. a NE or NW
        wind into an incoming tide): half-point penalty — real chop, but not
        as steep and short as a true head-on clash.
      - 90° or less (crosswind or aligned): no penalty.
    Only applies above 10 km/h — light wind doesn't create meaningful chop
    regardless of direction."""
    if wind_speed is None or wind_speed <= 10:
        return 0
    diff = wind_tide_angle_diff(wind_dir, tide_status)
    if diff is None or diff <= 90:
        return 0
    return 1 if diff == 180 else 0.5


def compute_condition(loc_type, shore, wind_dir, wind_speed, tide_status=None):
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
            base = 5
        elif wind_speed < 10:
            base = 4
        elif wind_speed < 15:
            diff = angle_diff(compass_to_degrees(shore), compass_to_degrees(wind_dir))
            if diff is None:
                return None
            base = 4 if diff <= 90 else 3
        elif wind_speed < 20:
            base = 2
        else:
            base = 1

        base = max(1, base - wind_against_tide_penalty(wind_dir, wind_speed, tide_status))
        return base

    return None


# --- Fishing Condition: a separate score from the above (Location Condition),
# answering "are the fish likely to be active" rather than "is it comfortable
# to paddle/launch here". Same formula for every location — fish behaviour
# doesn't care what kind of craft you're in. Baseline 3.0, each factor nudges
# it up/down, clamped to 1-5. See fishing-condition-formula.md for the
# reasoning behind the specific weights and thresholds below.

def tide_strength_score(date_str, daily_ranges):
    """+0.4 if today's tidal range is in the top third of the whole fetched
    window, -0.4 if bottom third, 0 otherwise. Relative rather than a fixed
    number, so it adapts to each bay's actual tidal magnitude (Western Port's
    2-3m swings vs Port Phillip's sub-1m ones) without hardcoding anything
    per location. Needs at least 3 days of range data to rank meaningfully;
    returns neutral (0) otherwise rather than over-interpreting too little data."""
    if date_str not in daily_ranges or len(daily_ranges) < 3:
        return 0
    sorted_items = sorted(daily_ranges.items(), key=lambda kv: kv[1])
    n = len(sorted_items)
    rank = next(i for i, (d, _) in enumerate(sorted_items) if d == date_str)
    if rank >= (2 * n) / 3:
        return 0.4
    if rank < n / 3:
        return -0.4
    return 0


def tide_stage_score(tide_status):
    """+0.4 when the tide is actively moving (Incoming/Outgoing), -0.4 near
    slack water (Low/High) where there's minimal current."""
    if tide_status in ("Incoming", "Outgoing"):
        return 0.4
    if tide_status in ("Low", "High"):
        return -0.4
    return 0


def pressure_score(pressure_hpa):
    """+0.4 for high pressure, -0.4 for low — Southern Hemisphere specific
    (the opposite of common Northern Hemisphere/freshwater advice)."""
    if pressure_hpa is None:
        return 0
    if pressure_hpa >= 1025:
        return 0.4
    if pressure_hpa < 1010:
        return -0.4
    return 0


def light_score(dt, sunrise_str, sunset_str):
    """+0.4 within 1 hour of sunrise/sunset, +0.2 within 2 hours, 0
    otherwise — never a penalty, since the research said not to write off
    the middle of the day."""
    best_diff_hours = None
    for edge_str in (sunrise_str, sunset_str):
        if not edge_str:
            continue
        try:
            edge_dt = datetime.strptime(edge_str, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
        diff_hours = abs((dt - edge_dt).total_seconds()) / 3600
        if best_diff_hours is None or diff_hours < best_diff_hours:
            best_diff_hours = diff_hours
    if best_diff_hours is None:
        return 0
    if best_diff_hours <= 1:
        return 0.4
    if best_diff_hours <= 2:
        return 0.2
    return 0


def water_temp_trend_score(date_str, daily_sst_avgs):
    """+0.4 if today's average sea surface temperature is higher than
    yesterday's, -0.2 if lower (asymmetric: rising is the real trigger per
    the research, falling just means "less exciting", not "avoid"), 0 if
    steady/unknown. Needs yesterday's average too (fetched via past_days=1),
    so day one of the window gets a real trend, not just day two onward."""
    if date_str not in daily_sst_avgs:
        return 0
    try:
        this_date = datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        return 0
    prev_date_str = (this_date - timedelta(days=1)).strftime("%Y-%m-%d")
    if prev_date_str not in daily_sst_avgs:
        return 0
    diff = daily_sst_avgs[date_str] - daily_sst_avgs[prev_date_str]
    if diff > 0.05:
        return 0.4
    if diff < -0.05:
        return -0.2
    return 0


def compute_fishing_condition(date_str, tide_status, daily_tide_ranges, pressure_hpa,
                               dt, sunrise_str, sunset_str, daily_sst_avgs):
    score = 3.0
    score += tide_strength_score(date_str, daily_tide_ranges)
    score += tide_stage_score(tide_status)
    score += pressure_score(pressure_hpa)
    score += light_score(dt, sunrise_str, sunset_str)
    score += water_temp_trend_score(date_str, daily_sst_avgs)
    return max(1.0, min(5.0, round(score, 2)))


def process_location(loc):
    name = loc["name"]
    loc_type = loc.get("type")
    shore = loc.get("shore")

    match = search_location(name)
    matched_name = match.get("name") if match else None
    region = match.get("region") if match else None
    state = match.get("state") if match else None
    loc_id = match.get("id") if match else None
    lat = match.get("lat") if match else None
    lng = match.get("lng") if match else None

    weather = get_weather(loc_id) if loc_id else {}
    sun_times = extract_sun_times(weather)
    sun_by_date = {s["date"]: s for s in sun_times}

    pressure_by_date = daily_averages(get_pressure_forecast(lat, lng))
    sst_by_date = daily_averages(get_water_temp_forecast(lat, lng))

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
            loc_type, shore, row.get("Wind Forecast Dir"), row.get("Wind Forecast (km/h)"),
            tide_status=row.get("Tide Status"),
        )
        row["Location Name"] = name
        row["Type"] = loc_type
        row["Shore"] = shore
        row["Matched Name"] = matched_name
        row["Region"] = region
        row["State"] = state

    # Fishing Condition needs each day's tide RANGE, which needs every row's
    # Tide Status already resolved (the loop just above) — hence a second pass.
    daily_tide_ranges = {}
    heights_by_date = {}
    for row in rows:
        if row.get("Tide Status") in ("High", "Low") and row.get("Tide Height (m)") is not None:
            date_str = row["dateTime"][:10]
            heights_by_date.setdefault(date_str, []).append(row["Tide Height (m)"])
    for date_str, heights in heights_by_date.items():
        if len(heights) >= 2:
            daily_tide_ranges[date_str] = max(heights) - min(heights)

    for row in rows:
        date_str = row["dateTime"][:10]
        dt = datetime.fromisoformat(row["dateTime"])
        sun = sun_by_date.get(date_str, {})
        row["Fishing Condition"] = compute_fishing_condition(
            date_str, row.get("Tide Status"), daily_tide_ranges,
            pressure_by_date.get(date_str), dt, sun.get("sunrise"), sun.get("sunset"),
            sst_by_date,
        )

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
