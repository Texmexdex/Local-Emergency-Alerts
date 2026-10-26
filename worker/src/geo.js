const EARTH_RADIUS_KM = 6371.0088;
export const COMPASS_POINTS = [
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function distanceKm(lat1, lon1, lat2, lon2) {
    const p1 = rad(lat1), p2 = rad(lat2);
    const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/** Initial compass bearing (0-360, 0 = north) from point 1 to point 2. */
export function bearingDeg(lat1, lon1, lat2, lon2) {
    const p1 = rad(lat1), p2 = rad(lat2), dl = rad(lon2 - lon1);
    const x = Math.sin(dl) * Math.cos(p2);
    const y = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

/** Smallest absolute difference between two bearings, 0-180. */
export function angleDiff(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}

export function compass(deg) {
    if (deg == null) return null;
    return COMPASS_POINTS[Math.floor((((deg % 360) + 360) % 360) / 22.5 + 0.5) % 16];
}

export const kmToMi = (km) => (km == null ? null : km * 0.621371);
export const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

// Wind-driven exposure. A release travels roughly with the wind; we treat
// anything within +/- DOWNWIND_HALF_ANGLE of the downwind direction, out to
// DOWNWIND_MAX_KM, as potentially in the path. Under calm winds vapours pool
// around the source instead of travelling, so only very close points count.
export const DOWNWIND_HALF_ANGLE = 30;
export const DOWNWIND_MAX_KM = 25;
export const CALM_WIND_KMH = 5;
export const CALM_RADIUS_KM = 5;

/** Return 'downwind', 'calm-nearby', or null for a source relative to home. */
export function downwindExposure(srcLat, srcLon, homeLat, homeLon, windFromDeg, windKmh) {
    const dist = distanceKm(srcLat, srcLon, homeLat, homeLon);
    if (windKmh != null && windKmh < CALM_WIND_KMH) return dist <= CALM_RADIUS_KM ? 'calm-nearby' : null;
    if (windFromDeg == null || dist > DOWNWIND_MAX_KM) return null;
    const blowingToward = (windFromDeg + 180) % 360;
    const toHome = bearingDeg(srcLat, srcLon, homeLat, homeLon);
    return angleDiff(blowingToward, toHome) <= DOWNWIND_HALF_ANGLE ? 'downwind' : null;
}
