// Key Map square -> approximate coordinates.
//
// Houston's dispatch feed gives only a street, a cross street and a Key Map
// code such as "494G" (page 494, square G): no house numbers, so normal
// address geocoding can't place it. Each Key Map square is about 0.75 x 0.75
// mile, so its centre is a good approximate location.
//
// The grid is Key Maps, Inc.'s copyrighted base map, so it is not bundled
// here; squares are looked up on demand from Harris County's public GIS
// service (one request for all new codes) and cached in the isolate.
import { getJson } from './http.js';

export const SERVICE_URL = 'https://www.gis.hctx.net/arcgis/rest/services/LE_Apps/Keymap_Published/MapServer/0/query';
const CODE_RE = /^\d{3,4}[A-HJ-NP-Z]$/; // letters I and O are not used
// Sanity bounds for the Key Map coverage area (greater Houston).
const BOUNDS = { minLat: 28.8, maxLat: 30.8, minLon: -96.4, maxLon: -94.3 };
const MAX_CODES_PER_QUERY = 150;

const cache = new Map(); // code -> {lat, lon, ...} | null

export function normalizeCode(code) {
    const c = (code || '').toUpperCase().replace(/\s+/g, '');
    return CODE_RE.test(c) ? c : null;
}

/** Centroid of an ArcGIS polygon (average of its outer ring's distinct vertices). */
export function ringCentroid(geometry) {
    const ring = geometry?.rings?.[0];
    if (!ring?.length) return null;
    const pts = ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring;
    const lon = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    if (lat < BOUNDS.minLat || lat > BOUNDS.maxLat || lon < BOUNDS.minLon || lon > BOUNDS.maxLon) return null;
    return { lat, lon };
}

function codeOf(attributes) {
    for (const v of Object.values(attributes || {})) {
        const c = normalizeCode(String(v ?? ''));
        if (c) return c;
    }
    return null;
}

/** Query the county service for these codes. Throws on network/service errors. */
export async function queryService(codes) {
    const where = `KEYREF IN (${codes.map((c) => `'${c}'`).join(',')})`;
    const url = `${SERVICE_URL}?${new URLSearchParams({ where, outFields: 'KEYREF', returnGeometry: 'true', outSR: '4326', f: 'json' })}`;
    const data = await getJson(url, { timeout: 15000 });
    if (data.error) throw new Error(`Key Map service: ${data.error.message || JSON.stringify(data.error)}`);
    const found = new Map();
    for (const f of data.features || []) {
        const code = codeOf(f.attributes);
        const c = code && ringCentroid(f.geometry);
        if (c) found.set(code, c);
    }
    return found;
}

/**
 * Resolve Key Map codes to approximate locations. Returns Map(code -> result | null).
 * Service failures leave codes unresolved (not cached) so they are retried.
 */
export async function lookup(rawCodes) {
    const out = new Map();
    const todo = [];
    for (const raw of new Set(rawCodes)) {
        const code = normalizeCode(raw);
        if (!code) continue;
        if (cache.has(code)) out.set(code, cache.get(code));
        else todo.push(code);
    }
    if (todo.length) {
        const batch = todo.slice(0, MAX_CODES_PER_QUERY);
        try {
            const found = await queryService(batch);
            for (const code of batch) {
                const c = found.get(code);
                const result = c ? { lat: c.lat, lon: c.lon, matched: `Key Map ${code}`, approximate: true } : null;
                cache.set(code, result);
                out.set(code, result);
            }
        } catch {
            // leave unresolved; next refresh retries
        }
    }
    return out;
}

/** For tests. */
export function _reset() { cache.clear(); }
