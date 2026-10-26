"""City of Houston active Fire / EMS incidents.

Source: https://cohweb.houstontx.gov/ActiveIncidents/Combined.aspx
(refreshed by the city about every 5 minutes; City of Houston only, so
unincorporated Harris County such as Channelview or Sheldon is NOT covered.)
"""
import hashlib
import re
from datetime import datetime, timedelta, timezone

from bs4 import BeautifulSoup

from . import config, geo, geocode, http
from .http import TTLCache

FEED_URL = "https://cohweb.houstontx.gov/ActiveIncidents/Combined.aspx"
_cache = TTLCache(ttl_seconds=60)

COLUMN_KEYS = [
    ("agency", "agency"),
    ("address", "address"),
    ("location", "address"),
    ("crossstreet", "cross_street"),
    ("keymap", "key_map"),
    ("calltime", "call_time"),
    ("incidenttype", "type"),
    ("type", "type"),
    ("alarm", "alarm"),
    ("units", "units"),
    ("combinedresponse", "combined"),
]
LEGACY_ORDER = ["agency", "address", "cross_street", "key_map", "call_time", "type", "combined"]
TIME_FORMATS = [
    "%m/%d/%Y %H:%M", "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %I:%M %p", "%m/%d/%Y %I:%M:%S %p",
    "%H:%M", "%H:%M:%S", "%I:%M %p",
]

HAZMAT_RE = re.compile(
    r"HAZ|CHEMICAL|EXPLOS|GAS LEAK|NATURAL GAS|GAS ODOR|ODOR|SPILL|PIPELINE|RADIOLOG|BOMB|TOXIC|VAPOR",
)
ALARM_ONLY_RE = re.compile(r"FIRE\s*ALARM|ALARM\s*(SYSTEM|ACTIVATION|SOUNDING)|SMOKE\s*DETECTOR|CO\s*DETECTOR|CARBON MONOXIDE ALARM")
FIRE_RE = re.compile(r"FIRE|SMOKE|BURN")
MAJOR_FIRE_RE = re.compile(r"(2ND|3RD|4TH|5TH|SECOND|THIRD|MULTI|GENERAL)\W*ALARM|HIGH\s*RISE|COMMERCIAL|INDUSTRIAL|REFINERY|PLANT")


def _norm_header(h):
    return re.sub(r"[^a-z]", "", h.lower())


def _map_headers(cells):
    keys = []
    for c in cells:
        n = _norm_header(c)
        key = next((k for prefix, k in COLUMN_KEYS if n.startswith(prefix)), None)
        keys.append(key)
    return keys


def parse_call_time(text, now):
    text = re.sub(r"\s+", " ", text or "").strip()
    local_now = now.astimezone(config.LOCAL_TZ)
    for fmt in TIME_FORMATS:
        try:
            dt = datetime.strptime(text, fmt)
        except ValueError:
            continue
        if "%m" not in fmt:
            dt = dt.replace(year=local_now.year, month=local_now.month, day=local_now.day)
            dt = dt.replace(tzinfo=config.LOCAL_TZ)
            if dt > local_now + timedelta(minutes=10):
                dt -= timedelta(days=1)
            return dt
        return dt.replace(tzinfo=config.LOCAL_TZ)
    return None


def parse_table(html):
    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table")
    if not tables:
        return []
    table = max(tables, key=lambda t: len(t.find_all("tr")))
    keys = None
    rows = []
    for tr in table.find_all("tr"):
        cells = [re.sub(r"\s+", " ", td.get_text(" ")).strip() for td in tr.find_all(["td", "th"])]
        if not any(cells):
            continue
        mapped = _map_headers(cells)
        if "address" in mapped and "type" in mapped:
            keys = mapped
            continue
        if re.search(r"this page contains|disclaimer", " ".join(cells), re.I):
            continue
        row_keys = keys or (LEGACY_ORDER if len(cells) >= 7 else None)
        if not row_keys:
            continue
        row = {k: v for k, v in zip(row_keys, cells) if k}
        if row.get("address") or row.get("type"):
            rows.append(row)
    return rows


def classify(row, distance_km):
    t = (row.get("type") or "").upper()
    alarm = re.search(r"\d", row.get("alarm") or "")
    alarm_level = int(alarm.group()) if alarm else 1
    near = distance_km is not None
    if HAZMAT_RE.search(t):
        return ("warning" if near and distance_km <= 8 else "info"), "hazmat"
    if ALARM_ONLY_RE.search(t):
        return "info", "alarm"
    if FIRE_RE.search(t):
        if alarm_level >= 2 or MAJOR_FIRE_RE.search(t):
            return ("warning" if near and distance_km <= 8 else "info"), "major_fire"
        return ("advisory" if near and distance_km <= 3 else "info"), "fire"
    return "info", "other"


def fetch_incidents(home_lat, home_lon, now=None):
    now = now or datetime.now(timezone.utc)
    rows = _cache.get_or_fetch("feed", lambda: parse_table(http.get(FEED_URL).text))
    fire_rows = [r for r in rows if not r.get("agency") or r["agency"].upper().startswith("F")]

    def query(r):
        return f"{r.get('address', '')}, Houston, TX"

    locations = geocode.geocode_many([query(r) for r in fire_rows if r.get("address")])
    incidents = []
    for r in fire_rows:
        loc = locations.get(query(r)) if r.get("address") else None
        dist = round(geo.distance_km(home_lat, home_lon, loc["lat"], loc["lon"]), 1) if loc else None
        level, kind = classify(r, dist)
        called = parse_call_time(r.get("call_time"), now)
        key = f"{r.get('address')}|{r.get('call_time')}|{r.get('type')}"
        incidents.append({
            "id": "hfd-" + hashlib.sha1(key.encode()).hexdigest()[:16],
            "type": r.get("type") or "Incident",
            "address": r.get("address"),
            "cross_street": r.get("cross_street"),
            "key_map": r.get("key_map"),
            "alarm": r.get("alarm"),
            "units": r.get("units"),
            "called_at": called.isoformat() if called else None,
            "call_time_raw": r.get("call_time"),
            "level": level,
            "kind": kind,
            "lat": loc["lat"] if loc else None,
            "lon": loc["lon"] if loc else None,
            "distance_km": dist,
            "bearing_from_home": geo.compass(geo.bearing_deg(home_lat, home_lon, loc["lat"], loc["lon"])) if loc else None,
            "url": FEED_URL,
        })
    order = {"action": 0, "warning": 1, "advisory": 2, "info": 3}
    incidents.sort(key=lambda i: (order[i["level"]], i["distance_km"] if i["distance_km"] is not None else 1e9))
    return incidents
