"""National Weather Service: official alerts and observed wind.

The NWS alerts feed carries more than weather. Local officials relay
non-weather emergencies through it too (Shelter In Place Warning,
Hazardous Materials Warning, Civil Emergency Message, Evacuation Immediate,
etc.), so it is the single most important source here.
"""
from datetime import datetime, timezone

from . import geo, http
from .http import TTLCache

API = "https://api.weather.gov"
GEOJSON = {"Accept": "application/geo+json"}

# Alerts that mean "protect yourself now" regardless of NWS severity field.
ACTION_EVENTS = {
    "Tornado Warning",
    "Extreme Wind Warning",
    "Shelter In Place Warning",
    "Evacuation Immediate",
    "Hazardous Materials Warning",
    "Civil Danger Warning",
    "Civil Emergency Message",
    "Local Area Emergency",
    "Nuclear Power Plant Warning",
    "Radiological Hazard Warning",
    "Fire Warning",
    "Law Enforcement Warning",
}
# Flash Flood Emergencies arrive as "Flash Flood Warning" with severity
# "Extreme", which alert_level() already treats as action.

_alerts_cache = TTLCache(ttl_seconds=60)
_points_cache = TTLCache(ttl_seconds=24 * 3600)
_obs_cache = TTLCache(ttl_seconds=300)


def _pt(lat, lon):
    return f"{lat:.4f},{lon:.4f}"


def alert_level(props):
    event = props.get("event") or ""
    severity = props.get("severity") or "Unknown"
    if event in ACTION_EVENTS or severity == "Extreme":
        return "action"
    if severity == "Severe" or event.endswith("Warning"):
        return "warning"
    if severity == "Moderate" or event.endswith(("Watch", "Advisory")):
        return "advisory"
    return "info"


def normalize_alert(feature):
    p = feature.get("properties", {})
    return {
        "id": p.get("id") or feature.get("id"),
        "event": p.get("event", "Alert"),
        "headline": p.get("headline") or p.get("event", ""),
        "description": (p.get("description") or "").strip(),
        "instruction": (p.get("instruction") or "").strip(),
        "severity": p.get("severity"),
        "urgency": p.get("urgency"),
        "certainty": p.get("certainty"),
        "response": p.get("response"),
        "sender": p.get("senderName"),
        "areas": p.get("areaDesc"),
        "effective": p.get("effective") or p.get("sent"),
        "onset": p.get("onset"),
        "expires": p.get("expires"),
        "ends": p.get("ends"),
        "message_type": p.get("messageType"),
        "level": alert_level(p),
        "url": p.get("@id") or feature.get("id"),
        "geometry": feature.get("geometry"),
    }


def fetch_alerts(lat, lon):
    def fetch():
        data = http.get(f"{API}/alerts/active", params={"point": _pt(lat, lon)}, headers=GEOJSON).json()
        alerts = [
            normalize_alert(f)
            for f in data.get("features", [])
            if f.get("properties", {}).get("status", "Actual") == "Actual"
        ]
        order = {"action": 0, "warning": 1, "advisory": 2, "info": 3}
        alerts.sort(key=lambda a: (order[a["level"]], a.get("effective") or ""))
        return alerts

    return _alerts_cache.get_or_fetch(_pt(lat, lon), fetch)


def _point_meta(lat, lon):
    def fetch():
        p = http.get(f"{API}/points/{_pt(lat, lon)}", headers=GEOJSON).json()["properties"]
        stations = http.get(p["observationStations"], headers=GEOJSON).json().get("features", [])
        rel = p.get("relativeLocation", {}).get("properties", {})
        return {
            "forecast_hourly": p.get("forecastHourly"),
            "place": ", ".join(x for x in (rel.get("city"), rel.get("state")) if x),
            "stations": [
                {
                    "id": s["properties"]["stationIdentifier"],
                    "name": s["properties"].get("name"),
                    "lat": s["geometry"]["coordinates"][1],
                    "lon": s["geometry"]["coordinates"][0],
                }
                for s in stations[:4]
            ],
        }

    return _points_cache.get_or_fetch(_pt(lat, lon), fetch)


def _val(obs, key):
    v = obs.get(key) or {}
    return v.get("value")


def _parse_time(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def parse_observation(obs, station):
    """Normalize an NWS observation's properties. Units: NWS sends km/h and degC."""
    wind_kmh = _val(obs, "windSpeed")
    gust_kmh = _val(obs, "windGust")
    temp_c = _val(obs, "temperature")
    wind_dir = _val(obs, "windDirection")
    return {
        "source": "observed",
        "station": station.get("id"),
        "station_name": station.get("name"),
        "station_lat": station.get("lat"),
        "station_lon": station.get("lon"),
        "observed_at": obs.get("timestamp"),
        "description": obs.get("textDescription"),
        "wind_from_deg": wind_dir,
        "wind_from": geo.compass(wind_dir) if wind_dir is not None else None,
        "wind_kmh": wind_kmh,
        "wind_mph": None if wind_kmh is None else round(wind_kmh * 0.621371),
        "gust_mph": None if gust_kmh is None else round(gust_kmh * 0.621371),
        "temp_f": None if temp_c is None else round(temp_c * 9 / 5 + 32),
        "humidity": None if _val(obs, "relativeHumidity") is None else round(_val(obs, "relativeHumidity")),
    }


def fetch_weather(lat, lon, now=None):
    """Latest observed conditions from the nearest station with fresh wind data."""
    now = now or datetime.now(timezone.utc)

    def fetch():
        meta = _point_meta(lat, lon)
        for station in meta["stations"]:
            try:
                obs = http.get(
                    f"{API}/stations/{station['id']}/observations/latest", headers=GEOJSON
                ).json()["properties"]
            except Exception:
                continue
            ts = _parse_time(obs.get("timestamp") or "")
            if not ts or (now - ts).total_seconds() > 3 * 3600:
                continue
            w = parse_observation(obs, station)
            if w["wind_kmh"] is None and w["wind_from_deg"] is None:
                continue
            w["place"] = meta["place"]
            w["distance_km"] = round(geo.distance_km(lat, lon, station["lat"], station["lon"]), 1)
            return w
        return _forecast_fallback(meta)

    return _obs_cache.get_or_fetch(_pt(lat, lon), fetch)


def _forecast_fallback(meta):
    """If no station has a fresh reading, use the current hour of the forecast."""
    period = http.get(meta["forecast_hourly"], headers=GEOJSON).json()["properties"]["periods"][0]
    mph = None
    try:
        mph = int(str(period.get("windSpeed", "")).split()[0])
    except (ValueError, IndexError):
        pass
    direction = period.get("windDirection") or None
    deg = geo.COMPASS_POINTS.index(direction) * 22.5 if direction in geo.COMPASS_POINTS else None
    return {
        "source": "forecast",
        "station": None,
        "observed_at": period.get("startTime"),
        "description": period.get("shortForecast"),
        "wind_from_deg": deg,
        "wind_from": direction,
        "wind_kmh": None if mph is None else mph / 0.621371,
        "wind_mph": mph,
        "gust_mph": None,
        "temp_f": period.get("temperature"),
        "humidity": (period.get("relativeHumidity") or {}).get("value"),
        "place": meta["place"],
    }
