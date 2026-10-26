import math

EARTH_RADIUS_KM = 6371.0088
COMPASS_POINTS = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
]


def distance_km(lat1, lon1, lat2, lon2):
    """Great-circle distance in kilometres."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def bearing_deg(lat1, lon1, lat2, lon2):
    """Initial compass bearing (0-360, 0 = north) from point 1 to point 2."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def angle_diff(a, b):
    """Smallest absolute difference between two bearings, 0-180."""
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d


def compass(deg):
    if deg is None:
        return None
    return COMPASS_POINTS[int((deg % 360) / 22.5 + 0.5) % 16]


def km_to_mi(km):
    return None if km is None else km * 0.621371


# Wind-driven exposure. A release travels roughly with the wind; we treat
# anything within +/- DOWNWIND_HALF_ANGLE of the downwind direction, out to
# DOWNWIND_MAX_KM, as potentially in the path. Under calm winds vapours pool
# around the source instead of travelling, so only very close points count.
DOWNWIND_HALF_ANGLE = 30
DOWNWIND_MAX_KM = 25
CALM_WIND_KMH = 5
CALM_RADIUS_KM = 5


def downwind_exposure(src_lat, src_lon, home_lat, home_lon, wind_from_deg, wind_kmh):
    """Return 'downwind', 'calm-nearby', or None for a source relative to home."""
    dist = distance_km(src_lat, src_lon, home_lat, home_lon)
    if wind_kmh is not None and wind_kmh < CALM_WIND_KMH:
        return "calm-nearby" if dist <= CALM_RADIUS_KM else None
    if wind_from_deg is None or dist > DOWNWIND_MAX_KM:
        return None
    blowing_toward = (wind_from_deg + 180) % 360
    to_home = bearing_deg(src_lat, src_lon, home_lat, home_lon)
    return "downwind" if angle_diff(blowing_toward, to_home) <= DOWNWIND_HALF_ANGLE else None
