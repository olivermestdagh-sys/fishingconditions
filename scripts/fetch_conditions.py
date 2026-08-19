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
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

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


def get_marine_forecast(lat, lng):
    """Hourly sea surface temperature, ocean current velocity, and ocean
    current direction — all from Open-Meteo's Marine API in ONE request
    (free, no API key, a separate endpoint from the main forecast). Current
    velocity/direction replace the old fixed north/south tide-flow guess
    with a real per-hour forecast. past_days=1 so water-temp trend has a
    real comparison point for the very first day of our window too, not
    just day two onward. cell_selection=sea avoids the grid cell resolving
    to a nearby land pixel for coastal locations."""
    if lat is None or lng is None:
        return {}, {}, {}
    url = (
        f"{OPEN_METEO_MARINE_URL}?latitude={lat}&longitude={lng}"
        f"&hourly=sea_surface_temperature,ocean_current_velocity,ocean_current_direction"
        f"&forecast_days={min(FORECAST_DAYS, 8)}&past_days=1&timezone=auto&cell_selection=sea"
    )
    data = http_get_json(url)
    if not data:
        return {}, {}, {}
    hourly = data.get("hourly", {}) or {}
    times = hourly.get("time", []) or []
    sst = dict(zip(times, hourly.get("sea_surface_temperature", []) or []))
    velocity = dict(zip(times, hourly.get("ocean_current_velocity", []) or []))
    direction = dict(zip(times, hourly.get("ocean_current_direction", []) or []))
    return sst, velocity, direction


def normalize_open_meteo_dt(t):
    """Open-Meteo returns 'YYYY-MM-DDTHH:MM' (no seconds) — parse it so we
    can bucket by calendar date."""
    try:
        return datetime.strptime(t, "%Y-%m-%dT%H:%M")
    except (ValueError, TypeError):
        return None


def hourly_lookup(hourly_dict):
    """Given {iso_string: value}, returns {'YYYY-MM-DD HH': value} — for
    values scored hour by hour (current velocity/direction), unlike
    pressure/water-temperature which are scored as a daily figure."""
    result = {}
    for t, v in hourly_dict.items():
        dt = normalize_open_meteo_dt(t)
        if dt is None or v is None:
            continue
        result[dt.strftime("%Y-%m-%d %H")] = v
    return result


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


def get_moon_phases(location_id):
    """Moon phase is a global astronomical fact, not location-specific like
    sunrise/sunset — fetched ONCE (using whichever location resolves first)
    and shared across every graph on the site, rather than repeating this
    per location like everything else."""
    url = (
        f"{BASE_URL}/{API_KEY}/locations/{location_id}/weather.json"
        f"?forecasts=moonphases&days={FORECAST_DAYS}"
    )
    data = http_get_json(url)
    return data or {}


def extract_moon_illumination(weather):
    """Returns {date_str: percentage_full} from the moonphases forecast."""
    days = ((weather.get("forecasts", {}) or {}).get("moonphases") or {}).get("days") or []
    out = {}
    for day in days:
        entries = day.get("entries") or []
        if not entries:
            continue
        e = entries[0]
        date_str = (day.get("dateTime") or "")[:10]
        if not date_str:
            continue
        pct = e.get("percentageFull")
        if pct is not None:
            out[date_str] = pct
    return out


def classify_moon_phase(illumination_by_date):
    """Classifies each date into one of the 8 standard phases, from
    illumination percentage plus whether it's trending up (waxing) or down
    (waning) versus the nearest other day in the same fetch. Doesn't rely
    on WillyWeather naming phases any particular way — just the widely
    available illumination percentage, which is more robust to not knowing
    their exact field/label conventions for certain."""
    dates = sorted(illumination_by_date.keys())
    result = {}
    for i, date_str in enumerate(dates):
        pct = illumination_by_date[date_str]
        if i + 1 < len(dates):
            trend_diff = illumination_by_date[dates[i + 1]] - pct
        elif i > 0:
            trend_diff = pct - illumination_by_date[dates[i - 1]]
        else:
            trend_diff = 0
        waxing = trend_diff >= 0

        if pct < 2:
            phase = "New Moon"
        elif pct > 98:
            phase = "Full Moon"
        elif 45 <= pct <= 55:
            phase = "First Quarter" if waxing else "Last Quarter"
        elif pct < 45:
            phase = "Waxing Crescent" if waxing else "Waning Crescent"
        else:
            phase = "Waxing Gibbous" if waxing else "Waning Gibbous"

        result[date_str] = {"phase": phase, "illumination": round(pct, 1)}
    return result


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


def wind_against_tide_severity(wind_dir, wind_speed, current_velocity, current_direction):
    """How much wind is piling onto an opposing current, and how bad it is —
    a real, documented phenomenon (wave-action conservation: an opposing
    current slows a wave's group velocity, so its energy packs into less
    space and it steepens). Two things determine severity together, not
    just wind speed alone:

      - How DIRECTLY the wind opposes the current (>=150° = "direct",
        90-150° = "partial", <=90° = no penalty at all — crosswind/aligned).
      - How much wind speed exceeds a threshold that itself SLIDES DOWN as
        the current strengthens (10 km/h at a barely-meaningful 0.3 km/h
        current, down to a floor of 5 km/h once current reaches ~2 km/h) —
        a moderate wind matters far more against a strong current than the
        same wind against a weak one, e.g. 12 km/h against a 2 km/h current
        creates real chop that a fixed threshold would completely miss.

    Combined into three tiers — needing BOTH direct opposition and a large
    speed excess (>=5 km/h over the threshold) to reach "major":

                        partial (90-150°)   direct (>=150°)
      small excess (<5)      minor              medium
      large excess (>=5)     medium             major

    Returns (penalty, label) — label is None when no penalty applies, so
    the score and its explanation can never disagree with each other.
    Gated on the current actually being meaningful (>=0.3 km/h — below
    that, there's negligible flow to be "against" regardless of direction)."""
    if current_velocity is None or current_velocity < 0.3:
        return 0, None
    if current_direction is None or wind_speed is None:
        return 0, None

    wind_deg = compass_to_degrees(wind_dir)
    if wind_deg is None:
        return 0, None
    wind_travel_deg = (wind_deg + 180) % 360  # direction the wind is blowing TOWARD
    diff = angle_diff(wind_travel_deg, current_direction)
    if diff is None or diff <= 90:
        return 0, None

    threshold = max(5, min(10, 10 - current_velocity * 2.5))
    excess = wind_speed - threshold
    if excess <= 0:
        return 0, None

    direct = diff >= 150
    large_excess = excess >= 5

    if direct and large_excess:
        return 1.0, "major"
    if direct or large_excess:
        return 0.5, "medium"
    return 0.25, "minor"


def naive_to_ms(dt):
    """Converts a naive (no timezone) datetime — where the digits represent
    local wall-clock time, same convention used everywhere in this file —
    into a millisecond value, by treating those digits as if they were UTC.
    Module-level (not a local closure) so both process_location() and
    main()'s history-aware interpolation pass can share it."""
    return int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)


def fill_wind_gaps(rows):
    """Fills missing wind speed/direction by averaging the nearest REAL
    reading before and after the gap — a simple average of the two nearest
    known points, not a time-weighted interpolation (matching what was
    asked for: "use the prior and next values to compute an average").
    Like tide interpolation, only fills gaps BETWEEN two real readings —
    never invents a value past the first/last real one, since a guess
    beyond real bracketing data is a shakier kind of estimate than one
    between two known points.

    A multi-hour gap gets the SAME flat average throughout, not a
    progressively-changing value — every missing hour in one gap uses the
    SAME pair of real bracketing readings, deliberately computed from a
    snapshot of the ORIGINAL data before any fills are written back. Filling
    in place while scanning would let an early fill get treated as "real"
    by the next gap hour, silently turning this into a lopsided cascade
    that depends on scan direction rather than a clean, predictable average.

    Direction needs circular averaging, not a plain numeric mean — naively
    averaging 350° and 10° gives 180° (due south, wrong), when the real
    answer is roughly 0° (due north). Averaging as unit vectors and taking
    the angle of the resulting vector handles the wraparound correctly.
    Mutates rows in place (all at once, after every fill value is computed).
    """
    n = len(rows)
    original_speed = [r.get("Wind Forecast (km/h)") for r in rows]
    original_dir = [r.get("Wind Forecast Dir") for r in rows]

    def nearest_real(values, i, step):
        j = i
        while 0 <= j < n:
            if values[j] is not None:
                return j
            j += step
        return None

    speed_fills = {}
    for i in range(n):
        if original_speed[i] is None:
            prev_idx = nearest_real(original_speed, i - 1, -1)
            next_idx = nearest_real(original_speed, i + 1, 1)
            if prev_idx is not None and next_idx is not None:
                speed_fills[i] = round((original_speed[prev_idx] + original_speed[next_idx]) / 2, 1)

    dir_fills = {}
    for i in range(n):
        if original_dir[i] is None:
            prev_idx = nearest_real(original_dir, i - 1, -1)
            next_idx = nearest_real(original_dir, i + 1, 1)
            if prev_idx is not None and next_idx is not None:
                deg1 = compass_to_degrees(original_dir[prev_idx])
                deg2 = compass_to_degrees(original_dir[next_idx])
                if deg1 is not None and deg2 is not None:
                    rad1, rad2 = math.radians(deg1), math.radians(deg2)
                    avg_x = (math.cos(rad1) + math.cos(rad2)) / 2
                    avg_y = (math.sin(rad1) + math.sin(rad2)) / 2
                    avg_deg = math.degrees(math.atan2(avg_y, avg_x)) % 360
                    dir_fills[i] = degrees_to_compass(avg_deg)

    for i, value in speed_fills.items():
        rows[i]["Wind Forecast (km/h)"] = value
    for i, value in dir_fills.items():
        rows[i]["Wind Forecast Dir"] = value


def degrees_to_compass(deg):
    """Nearest of the 16 compass points to a given degree value — the
    reverse of COMPASS_DEGREES/compass_to_degrees."""
    names = list(COMPASS_DEGREES.keys())
    closest = min(names, key=lambda name: min(abs(COMPASS_DEGREES[name] - deg), 360 - abs(COMPASS_DEGREES[name] - deg)))
    return closest


def interpolate_tide_height(target_ms, events):
    """Estimates tide height at target_ms from the two nearest REAL tide
    events bracketing it, using a cosine curve — the mathematical basis of
    the long-standing "Rule of Twelfths" navigation technique (tide rate
    rises to a max halfway between high/low, then eases off, not a straight
    line). Purely a visual fill for the gaps between WillyWeather's actual
    high/low readings — interpolates between known points, never
    extrapolates beyond the first/last event we actually have, since a
    guess outside real bracketing data is a different (much shakier) kind
    of estimate than one between two known points.

    events: sorted list of (ms, height) tuples — the real events only."""
    if not events or target_ms < events[0][0] or target_ms > events[-1][0]:
        return None
    for i in range(len(events) - 1):
        t1, h1 = events[i]
        t2, h2 = events[i + 1]
        if t1 <= target_ms <= t2:
            if t2 == t1:
                return h1
            fraction = (target_ms - t1) / (t2 - t1)
            return round(h1 + (h2 - h1) * (1 - math.cos(fraction * math.pi)) / 2, 2)
    return None


def compute_condition(loc_type, shore, wind_dir, wind_speed, current_velocity=None, current_direction=None):
    if loc_type == "Land based":
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

        penalty, _ = wind_against_tide_severity(wind_dir, wind_speed, current_velocity, current_direction)
        base = max(1, base - penalty)
        return base

    return None


def explain_condition(loc_type, shore, wind_dir, wind_speed, current_velocity=None, current_direction=None):
    """Short human-readable reason for the Location Condition score — same
    inputs, same branching as compute_condition above, so the explanation
    can never disagree with the number it's explaining."""
    if loc_type == "Land based":
        diff = angle_diff(compass_to_degrees(shore), compass_to_degrees(wind_dir))
        if diff is None:
            return "Insufficient wind data"
        if diff == 0:
            return "Straight offshore — clean waves"
        if diff == 45:
            return "Mostly offshore — good waves"
        if diff == 90:
            return "Cross-shore wind"
        if diff == 135:
            return "Mostly onshore — messy surf"
        return "Straight onshore — blown out"

    if loc_type == "Kayak":
        if wind_speed is None:
            return "Insufficient wind data"
        if wind_speed < 5:
            text = f"Calm ({wind_speed:.0f} km/h)"
        elif wind_speed < 10:
            text = f"Light wind ({wind_speed:.0f} km/h)"
        elif wind_speed < 15:
            diff = angle_diff(compass_to_degrees(shore), compass_to_degrees(wind_dir))
            if diff is not None and diff <= 90:
                text = f"Moderate wind ({wind_speed:.0f} km/h), from behind/side"
            else:
                text = f"Moderate wind ({wind_speed:.0f} km/h), from ahead"
        elif wind_speed < 20:
            text = f"Strong wind ({wind_speed:.0f} km/h)"
        else:
            text = f"Very strong wind ({wind_speed:.0f} km/h)"

        _, severity = wind_against_tide_severity(wind_dir, wind_speed, current_velocity, current_direction)
        if severity:
            text += f" · wind {severity} against {current_velocity:.1f}km/h current"

        return text

    return None


# --- Fishing Condition: a separate score from the above (Location Condition),
# answering "are the fish likely to be active" rather than "is it comfortable
# to paddle/launch here". Same formula for every location — fish behaviour
# doesn't care what kind of craft you're in. Baseline 3.0, each factor nudges
# it up/down, clamped to 1-5.
#
# Pressure and tide stage are weighted as DOMINANT factors (±0.8 each);
# tide strength, light, and water temp trend are MINOR modifiers (±0.1-0.2).
# This isn't just a numeric tweak — five roughly-equal independent factors
# summed together mathematically cluster toward the middle almost always
# (same reason 5 dice rarely sum to all-1s or all-6s), which was tested and
# confirmed: the original equal-weight version reached within 0.4 of either
# true extreme in under 2% of possible combinations. Concentrating weight on
# the two best-evidenced factors (pressure was the strongest locally-specific
# claim found; tide movement was one of the most consistently-supported
# findings generally) both fixes that clustering AND leans the score harder
# on the factors that most deserve the trust. See fishing-condition-formula.md
# for the full analysis.

def tide_strength_score(date_str, daily_ranges):
    """MINOR factor. +0.2 if today's tidal range is in the top third of the
    whole fetched window, -0.2 if bottom third, 0 otherwise. Relative rather
    than a fixed number, so it adapts to each bay's actual tidal magnitude
    (Western Port's 2-3m swings vs Port Phillip's sub-1m ones) without
    hardcoding anything per location. Needs at least 3 days of range data to
    rank meaningfully; returns neutral (0) otherwise rather than
    over-interpreting too little data."""
    if date_str not in daily_ranges or len(daily_ranges) < 3:
        return 0
    sorted_items = sorted(daily_ranges.items(), key=lambda kv: kv[1])
    n = len(sorted_items)
    rank = next(i for i, (d, _) in enumerate(sorted_items) if d == date_str)
    if rank >= (2 * n) / 3:
        return 0.2
    if rank < n / 3:
        return -0.2
    return 0


def tide_stage_score(tide_status):
    """DOMINANT factor. +0.8 when the tide is actively moving
    (Incoming/Outgoing), -0.8 near slack water (Low/High) where there's
    minimal current. Weighted heavily — along with pressure below — since
    these two are the most consistently evidence-backed factors from the
    research, and giving them outsized weight (rather than splitting evenly
    across all five factors) is also what lets the score actually reach the
    ends of the 1-5 range without needing every single factor to align."""
    if tide_status in ("Incoming", "Outgoing"):
        return 0.8
    if tide_status in ("Low", "High"):
        return -0.8
    return 0


def pressure_score(pressure_hpa):
    """DOMINANT factor. +0.8 for high pressure, -0.8 for low — Southern
    Hemisphere specific (the opposite of common Northern Hemisphere/
    freshwater advice). This was the single strongest, most locally-specific
    claim from the research (Reedy's Rigs), which is why it carries the same
    outsized weight as tide stage above rather than an equal fifth-share."""
    if pressure_hpa is None:
        return 0
    if pressure_hpa >= 1025:
        return 0.8
    if pressure_hpa < 1010:
        return -0.8
    return 0


def light_score(dt, sunrise_str, sunset_str):
    """MINOR factor. +0.2 within 1 hour of sunrise/sunset, +0.1 within 2
    hours, 0 otherwise — never a penalty, since the research said not to
    write off the middle of the day."""
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
        return 0.2
    if best_diff_hours <= 2:
        return 0.1
    return 0


def water_temp_trend_score(date_str, daily_sst_avgs):
    """MINOR factor. +0.2 if today's average sea surface temperature is
    higher than yesterday's, -0.1 if lower (asymmetric: rising is the real
    trigger per the research, falling just means "less exciting", not
    "avoid"), 0 if steady/unknown. Needs yesterday's average too (fetched
    via past_days=1), so day one of the window gets a real trend, not just
    day two onward."""
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
        return 0.2
    if diff < -0.05:
        return -0.1
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


def explain_fishing_condition(date_str, tide_status, daily_tide_ranges, pressure_hpa,
                               dt, sunrise_str, sunset_str, daily_sst_avgs):
    """Short human-readable reason for the Fishing Condition score — lists
    whichever of the five factors actually nudged the score, so it stays
    concise on a fully neutral day and only grows as more factors kick in.
    Same five calls as compute_fishing_condition above, on purpose — this
    can never disagree with the number it's explaining."""
    parts = []

    ts = tide_strength_score(date_str, daily_tide_ranges)
    if ts > 0:
        parts.append("strong tide")
    elif ts < 0:
        parts.append("weak tide")

    tg = tide_stage_score(tide_status)
    if tg > 0:
        parts.append("tide moving")
    elif tg < 0:
        parts.append("near slack water")

    ps = pressure_score(pressure_hpa)
    if ps > 0:
        parts.append("high pressure")
    elif ps < 0:
        parts.append("low pressure")

    ls = light_score(dt, sunrise_str, sunset_str)
    if ls > 0:
        parts.append("near dawn/dusk")

    wt = water_temp_trend_score(date_str, daily_sst_avgs)
    if wt > 0:
        parts.append("water warming")
    elif wt < 0:
        parts.append("water cooling")

    if not parts:
        return "Neutral across all factors"
    text = ", ".join(parts)
    return text[0].upper() + text[1:]


def process_location(loc):
    """Fetches weather/tide/current data ONCE for this physical location —
    shared across every type variant it has, since it's the same GPS point
    and the same real tide events regardless of activity — then computes
    Condition separately for EACH type variant (Kayak's wind+current
    scoring is a different formula from Land based's wave-angle scoring).
    Fishing Condition doesn't depend on type or shore at all, so it's
    computed once and shared across every type's rows.

    Returns: rows_by_type ({type_name: rows_list}), sun_times
    """
    name = loc["name"]
    shore = loc.get("shore")
    types = loc.get("types") or []

    match = search_location(name)
    matched_name = match.get("name") if match else None
    region = match.get("region") if match else None
    state = match.get("state") if match else None
    loc_id = match.get("id") if match else None
    lat = match.get("lat") if match else None
    lng = match.get("lng") if match else None
    # Attach to the SAME dict object referenced in main()'s locations list, so
    # it flows through into output["locations"] without changing this
    # function's return signature — needed for the Live page to match GPS
    # coordinates against each location without a separate lookup step.
    loc["lat"] = lat
    loc["lng"] = lng

    weather = get_weather(loc_id) if loc_id else {}
    sun_times = extract_sun_times(weather)
    sun_by_date = {s["date"]: s for s in sun_times}

    pressure_by_date = daily_averages(get_pressure_forecast(lat, lng))
    sst_hourly, current_velocity_hourly, current_direction_hourly = get_marine_forecast(lat, lng)
    sst_by_date = daily_averages(sst_hourly)
    velocity_by_hour = hourly_lookup(current_velocity_hourly)
    direction_by_hour = hourly_lookup(current_direction_hourly)

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

    base_rows = sorted(by_dt.values(), key=lambda r: r["dateTime"])

    # Fill wind gaps (both speed and direction) before anything downstream
    # reads them — Condition scoring for every type depends on wind, so this
    # needs to happen before the per-type scoring loop further down, same as
    # tide height needing to be filled before Fishing Condition reads it.
    fill_wind_gaps(base_rows)

    # Tide Status: Low/High from the tide event's own type; everything else is
    # Incoming/Outgoing based on the nearest known tide event before/after it.
    # Shared across types — the physical tide doesn't care what you're doing.
    next_type_by_idx = [None] * len(base_rows)
    running_next = None
    for i in range(len(base_rows) - 1, -1, -1):
        if base_rows[i].get("Tide Type"):
            running_next = base_rows[i]["Tide Type"]
        next_type_by_idx[i] = running_next if not base_rows[i].get("Tide Type") else base_rows[i]["Tide Type"]

    running_prev = None
    for i, row in enumerate(base_rows):
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

        row["Location Name"] = name
        row["Shore"] = shore
        row["Matched Name"] = matched_name
        row["Region"] = region
        row["State"] = state

    # Fishing Condition needs each day's tide RANGE, which needs every row's
    # Tide Status already resolved (the loop just above) — hence a second
    # pass. Shared across types (doesn't depend on type or shore at all).
    daily_tide_ranges = {}
    heights_by_date = {}
    for row in base_rows:
        if row.get("Tide Status") in ("High", "Low") and row.get("Tide Height (m)") is not None:
            date_str = row["dateTime"][:10]
            heights_by_date.setdefault(date_str, []).append(row["Tide Height (m)"])
    for date_str, heights in heights_by_date.items():
        if len(heights) >= 2:
            daily_tide_ranges[date_str] = max(heights) - min(heights)

    # Fill in Tide Height for the hourly rows that don't have a real reading
    # (WillyWeather only gives us the actual High/Low events, a handful per
    # day, not a full hourly curve) — purely a visual smoothing between the
    # real points for a nicer-looking graph, not a claim of real precision
    # at those specific in-between hours. Only interpolates BETWEEN real
    # events we actually have; never extrapolates beyond the first/last one.
    # (A second pass happens later in main(), using history rows too, for
    # gaps this pass can't reach — see there for why.)
    real_tide_events = sorted(
        (naive_to_ms(datetime.fromisoformat(row["dateTime"])), row["Tide Height (m)"])
        for row in base_rows
        if row.get("Tide Status") in ("High", "Low") and row.get("Tide Height (m)") is not None
    )
    for row in base_rows:
        if row.get("Tide Height (m)") is None:
            row_ms = naive_to_ms(datetime.fromisoformat(row["dateTime"]))
            interpolated = interpolate_tide_height(row_ms, real_tide_events)
            if interpolated is not None:
                row["Tide Height (m)"] = interpolated

    for row in base_rows:
        date_str = row["dateTime"][:10]
        dt = datetime.fromisoformat(row["dateTime"])
        sun = sun_by_date.get(date_str, {})
        row["Fishing Condition"] = compute_fishing_condition(
            date_str, row.get("Tide Status"), daily_tide_ranges,
            pressure_by_date.get(date_str), dt, sun.get("sunrise"), sun.get("sunset"),
            sst_by_date,
        )
        row["Fishing Condition Reason"] = explain_fishing_condition(
            date_str, row.get("Tide Status"), daily_tide_ranges,
            pressure_by_date.get(date_str), dt, sun.get("sunrise"), sun.get("sunset"),
            sst_by_date,
        )

    # This location's real observed max tide height (from actual WillyWeather
    # events in the currently-fetched window, not synthetic/guessed) — used
    # client-side to give each location its own graph axis ceiling, instead
    # of one fixed number for every location regardless of how different
    # Western Port's ~3m tidal swings are from Port Phillip Bay's sub-1m
    # ones. Shared across types (same physical tide). Attached to the SAME
    # dict object referenced in main()'s locations list, same mechanism as
    # lat/lng above.
    real_tide_heights = [h for (_, h) in real_tide_events]
    loc["tideMaxObserved"] = round(max(real_tide_heights), 2) if real_tide_heights else None

    # Condition IS type-specific (Kayak's wind+current formula vs Land
    # based's wave-angle formula) — each type gets its own copy of the
    # shared rows, tagged with which type it represents.
    rows_by_type = {}
    for type_config in types:
        type_name = type_config.get("type")
        type_rows = []
        for row in base_rows:
            row_copy = dict(row)
            hour_key = row["dateTime"][:13].replace("T", " ")
            row_current_velocity = velocity_by_hour.get(hour_key)
            row_current_direction = direction_by_hour.get(hour_key)
            row_copy["Condition"] = compute_condition(
                type_name, shore, row.get("Wind Forecast Dir"), row.get("Wind Forecast (km/h)"),
                current_velocity=row_current_velocity, current_direction=row_current_direction,
            )
            row_copy["Condition Reason"] = explain_condition(
                type_name, shore, row.get("Wind Forecast Dir"), row.get("Wind Forecast (km/h)"),
                current_velocity=row_current_velocity, current_direction=row_current_direction,
            )
            row_copy["Type"] = type_name
            type_rows.append(row_copy)
        rows_by_type[type_name] = type_rows

    return rows_by_type, sun_times


def load_previous_output():
    """The previous run's output, if any — read BEFORE we overwrite it, so
    we can carry a rolling window of real historical rows forward across
    runs. Returns None on any error (missing file, corrupt JSON) rather
    than failing the whole fetch over a history feature."""
    if not os.path.exists(OUTPUT_PATH):
        return None
    try:
        with open(OUTPUT_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001 - missing history shouldn't break a fresh fetch
        return None


def keep_recent_history(old_rows, hours_to_keep=30):
    """From a previous run's rows for one location, keep just the last N
    hours before now — genuine past data (what was actually forecast at
    the time it was fetched), not synthetic. This is what lets the Live
    page's "hours ago" side of its window show something real: WillyWeather
    itself has no way to fetch yesterday's forecast directly, but every
    scheduled run already legitimately fetched what's now "the past" before
    it aged out of the forward-looking window — we just need to not throw
    it away. Keeping a bit more than 24h (30) gives headroom against
    clock/DST edge cases at the boundary."""
    now_local = datetime.now(ZoneInfo("Australia/Melbourne")).replace(tzinfo=None)
    cutoff = now_local - timedelta(hours=hours_to_keep)
    kept = []
    for row in old_rows:
        try:
            row_dt = datetime.fromisoformat(row["dateTime"])
        except (KeyError, ValueError, TypeError):
            continue
        if cutoff <= row_dt < now_local:
            kept.append(row)
    return kept


def main():
    if not API_KEY:
        print("ERROR: WILLYWEATHER_API_KEY environment variable is not set.", file=sys.stderr)
        sys.exit(1)

    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        locations = json.load(f)

    previous_output = load_previous_output()
    previous_rows_by_key = {}
    if previous_output:
        for row in previous_output.get("rows", []):
            # Keyed by (name, type) now, not just name — Kayak and Land
            # based rows for the same physical location have different
            # Condition scores and must not get merged together.
            key = (row.get("Location Name"), row.get("Type"))
            previous_rows_by_key.setdefault(key, []).append(row)

    # Moon phase is the same for everyone regardless of location — fetched
    # ONCE, using whichever configured location resolves first, rather than
    # repeating this for every location like the rest of the weather data.
    moon_phases = {}
    if locations:
        try:
            first_match = search_location(locations[0]["name"])
            if first_match and first_match.get("id"):
                moon_weather = get_moon_phases(first_match["id"])
                illumination = extract_moon_illumination(moon_weather)
                moon_phases = classify_moon_phase(illumination)
        except Exception as e:  # noqa: BLE001 - moon phase is a nice-to-have, not core data
            print(f"WARNING: failed to fetch moon phases: {e}", file=sys.stderr)

    all_rows = []
    output_locations = []
    sun_times_by_location = {}
    for loc in locations:
        print(f"Fetching {loc['name']}...")
        try:
            rows_by_type, sun_times = process_location(loc)
            sun_times_by_location[loc["name"]] = sun_times

            for type_config in loc.get("types") or []:
                type_name = type_config.get("type")
                fresh_rows = rows_by_type.get(type_name, [])

                # Prepend real history carried from previous runs for THIS
                # specific (location, type) pair, skipping any timestamp the
                # fresh fetch already covers (the fresh version is more
                # complete/accurate for anything it actually has).
                key = (loc["name"], type_name)
                history_rows = keep_recent_history(previous_rows_by_key.get(key, []))
                fresh_datetimes = {r["dateTime"] for r in fresh_rows}
                history_rows = [r for r in history_rows if r["dateTime"] not in fresh_datetimes]

                # Second tide-height interpolation pass: the fresh fetch's
                # own interpolation (done earlier, inside process_location())
                # can only see its OWN 6-day window — it has no visibility
                # into what came before it, so today (still the very edge of
                # that window) can be missing tide height for the hours
                # before its first real event of the day. History now
                # carries forward real events from previous runs, so use the
                # FULL (history + fresh) set of real events as brackets for
                # anything still missing — this is what actually lets
                # today's early-morning hours fill in using yesterday's last
                # real tide reading, rather than staying blank.
                real_tide_events_merged = sorted(
                    (naive_to_ms(datetime.fromisoformat(r["dateTime"])), r["Tide Height (m)"])
                    for r in (history_rows + fresh_rows)
                    if r.get("Tide Status") in ("High", "Low") and r.get("Tide Height (m)") is not None
                )
                for row in fresh_rows:
                    if row.get("Tide Height (m)") is None:
                        row_ms = naive_to_ms(datetime.fromisoformat(row["dateTime"]))
                        interpolated = interpolate_tide_height(row_ms, real_tide_events_merged)
                        if interpolated is not None:
                            row["Tide Height (m)"] = interpolated

                all_rows.extend(history_rows)
                all_rows.extend(fresh_rows)

                # Flatten into one output location entry per (location, type)
                # pair — the frontend expects a flat list of {name, type,
                # shore, ...} objects, same shape as before this location
                # could have multiple types. Shared physical fields (shore,
                # lat/lng, real tide range) come from the location itself;
                # this type's own timings/settings are spread in after.
                output_locations.append({
                    "name": loc["name"],
                    "shore": loc.get("shore"),
                    "lat": loc.get("lat"),
                    "lng": loc.get("lng"),
                    "tideMaxObserved": loc.get("tideMaxObserved"),
                    **type_config,
                })
        except Exception as e:  # noqa: BLE001 - one bad location shouldn't kill the whole run
            print(f"WARNING: failed to process {loc['name']}: {e}", file=sys.stderr)

    output = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "forecastDays": FORECAST_DAYS,
        "locations": output_locations,
        "rows": all_rows,
        "sunTimes": sun_times_by_location,
        "moonPhases": moon_phases,
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, default=str)

    print(f"Wrote {len(all_rows)} rows to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
