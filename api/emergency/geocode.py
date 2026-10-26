"""Address -> coordinates using the free US Census geocoder.

Results (including misses) are cached for the life of the process so each
address is looked up at most once. We never invent coordinates: an address
that cannot be geocoded is reported as "location unknown".
"""
import re
from concurrent.futures import ThreadPoolExecutor

from . import http
from .http import TTLCache

CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
_MISS = False
_cache = TTLCache(ttl_seconds=7 * 24 * 3600, max_items=20000)

# Approximate site centroids for large plants that often post CAER messages
# without a street address (e.g. "This is an update from PEMEX Deer Park").
# Used only when the message itself contains no geocodable address.
KNOWN_SITES = [
    (("lyondellbasell", "channelview"), 29.8325, -95.1170),
    (("pemex", "deer park"), 29.7215, -95.1265),
    (("shell", "deer park"), 29.7190, -95.1180),
    (("exxonmobil", "baytown"), 29.7480, -95.0120),
    (("exxonmobil", "olefins"), 29.7480, -95.0120),
    (("chevron phillips", "baytown"), 29.7660, -94.9320),
    (("chevron phillips", "cedar bayou"), 29.7660, -94.9320),
    (("valero", "houston"), 29.7230, -95.2550),
    (("pasadena refin",), 29.7220, -95.2110),
    (("lyondellbasell", "houston refin"), 29.7130, -95.2310),
    (("tpc group",), 29.7090, -95.2500),
    (("invista", "houston"), 29.7180, -95.2380),
]


def normalize_address(address):
    a = re.sub(r"\s+", " ", (address or "")).strip(" ,.")
    a = re.sub(r"\b(BLOCK|BLK)\s+(OF\s+)?", "", a, flags=re.IGNORECASE)
    a = re.sub(r",\s*(?=TX\b)", ", ", a)
    a = re.sub(r"(?<=[a-z]),(?=TX\b)", ", ", a, flags=re.IGNORECASE)
    return a


def geocode(address):
    """Return {'lat','lon','matched','approximate': False} or None."""
    query = normalize_address(address)
    if len(query) < 6 or not re.search(r"\d", query):
        return None
    cached = _cache.get(query.upper())
    if cached is not None:
        return cached or None
    try:
        result = _census_lookup(query)
    except Exception:
        return None  # transient failure: don't cache, retry on a later refresh
    _cache.set(query.upper(), result or _MISS)
    return result


def _census_lookup(query):
    resp = http.get(
        CENSUS_URL,
        params={"address": query, "benchmark": "Public_AR_Current", "format": "json"},
    )
    matches = resp.json().get("result", {}).get("addressMatches", [])
    if not matches:
        return None
    coords = matches[0].get("coordinates", {})
    if "x" not in coords or "y" not in coords:
        return None
    return {
        "lat": float(coords["y"]),
        "lon": float(coords["x"]),
        "matched": matches[0].get("matchedAddress", query),
        "approximate": False,
    }


def geocode_many(addresses, max_new=30, workers=6):
    """Geocode a batch, doing at most ``max_new`` uncached network lookups.

    Returns {input address: result or None} for every input.
    """
    by_key = {}
    todo = []
    for a in addresses:
        key = normalize_address(a).upper()
        if key in by_key:
            continue
        cached = _cache.get(key)
        if cached is not None:
            by_key[key] = cached or None
        else:
            by_key[key] = None
            todo.append(a)
    todo = todo[:max_new]
    if todo:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for a, r in zip(todo, pool.map(geocode, todo)):
                by_key[normalize_address(a).upper()] = r
    return {a: by_key.get(normalize_address(a).upper()) for a in addresses}


def known_site(facility_name):
    name = (facility_name or "").lower()
    for keys, lat, lon in KNOWN_SITES:
        if all(k in name for k in keys):
            return {"lat": lat, "lon": lon, "matched": facility_name, "approximate": True}
    return None
