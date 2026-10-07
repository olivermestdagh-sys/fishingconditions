"""
Builds what the pipeline sends to the Worker's observed-conditions archive
(user-backend.js, "Observed-conditions archive"): one row per COMPLETED hour of
station and Open-Meteo readings, and the tide high/low events.

Deliberately not included: forecasts (WillyWeather temp/wind/rain/swell) and
the Condition / Fishing Condition scores. Only what was observed, plus the
Open-Meteo pressure / sea temperature / ocean current for hours that have
passed, and the latest predicted tide events.

Pure functions (no network), so they are easy to reason about. All times are
naive local time, like the rest of the pipeline.
"""

from datetime import datetime


def _hour_key(dt):
    """'YYYY-MM-DD HH' — the same key shape hourly_lookup() in fetch_conditions.py uses."""
    return dt.strftime("%Y-%m-%d %H")


def _mean(values, digits):
    values = [v for v in values if v is not None]
    if not values:
        return None
    return round(sum(values) / len(values), digits)


def build_observation_hours(base_rows, pressure_by_hour, sst_by_hour, velocity_by_hour, direction_by_hour, as_of):
    """
    base_rows: one location's rows, each a dict with 'dateTime' (ISO, naive local) and, where the station
    reported, 'Temp Realtime (C)', 'Wind Realtime (km/h)', 'Wind Realtime Dir' (readings can be every few
    minutes). The four *_by_hour dicts are keyed 'YYYY-MM-DD HH' (Open-Meteo). as_of: the current local time.

    Returns a list of {hour, tempC, windKmh, windDir, pressureHpa, waterTempC, currentKmh, currentDir} for every
    hour BEFORE the one still in progress, oldest first. Station readings are averaged within the hour.
    """
    current_hour = _hour_key(as_of)

    temps = {}
    winds = {}
    dirs = {}
    for row in base_rows:
        try:
            key = _hour_key(datetime.fromisoformat(row["dateTime"]))
        except (KeyError, ValueError, TypeError):
            continue
        if row.get("Temp Realtime (C)") is not None:
            temps.setdefault(key, []).append(row["Temp Realtime (C)"])
        if row.get("Wind Realtime (km/h)") is not None:
            winds.setdefault(key, []).append(row["Wind Realtime (km/h)"])
        if row.get("Wind Realtime Dir"):
            dirs.setdefault(key, []).append(row["Wind Realtime Dir"])

    hours = set(temps) | set(winds) | set(pressure_by_hour) | set(sst_by_hour) | set(velocity_by_hour) | set(direction_by_hour)

    out = []
    for key in sorted(hours):
        if key >= current_hour:
            continue  # the hour still in progress (or a future forecast hour): not observed yet
        entry = {
            "hour": key + ":00",
            "tempC": _mean(temps.get(key, []), 1),
            "windKmh": _mean(winds.get(key, []), 1),
            "windDir": dirs[key][-1] if key in dirs else None,  # the hour's latest reading
            "pressureHpa": _mean([pressure_by_hour.get(key)], 1),
            "waterTempC": _mean([sst_by_hour.get(key)], 1),
            "currentKmh": _mean([velocity_by_hour.get(key)], 2),
            "currentDir": _mean([direction_by_hour.get(key)], 0),
        }
        if any(v is not None for k, v in entry.items() if k != "hour"):
            out.append(entry)
    return out


def build_tide_events(base_rows):
    """The high/low tide events among a location's rows (they carry 'Tide Type' and 'Tide Height (m)'), as
    {time, type, heightM}. Raw from the station: the location's own tide offset is applied when read."""
    events = []
    for row in base_rows:
        tide_type = row.get("Tide Type")
        height = row.get("Tide Height (m)")
        if tide_type not in ("high", "low") or height is None:
            continue
        try:
            when = datetime.fromisoformat(row["dateTime"])
        except (KeyError, ValueError, TypeError):
            continue
        events.append({"time": when.strftime("%Y-%m-%d %H:%M:%S"), "type": tide_type, "heightM": round(float(height), 2)})
    return events
