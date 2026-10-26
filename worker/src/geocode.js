// Address -> coordinates using the free US Census geocoder.
//
// Results (including misses) are cached in the isolate, and CAER facility
// addresses are also persisted to KV because they rarely change. Houston
// dispatch addresses go through the Census *batch* endpoint so a page load
// costs one subrequest instead of one per incident (the free plan allows 50).
// We never invent coordinates: an address that cannot be geocoded is
// reported as "location unknown".
import { getJson, postText } from './http.js';

const ONELINE_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const BATCH_URL = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
const BENCHMARK = 'Public_AR_Current';
const KV_KEY = 'geocodes:v1';

const cache = new Map(); // normalized upper-case address -> result | null (miss)
let persisted = null; // Map of addresses worth saving to KV
let persistedDirty = false;

// Approximate site centroids for large plants that often post CAER messages
// without a street address (e.g. "This is an update from PEMEX Deer Park").
// Used only when the message itself contains no geocodable address.
const KNOWN_SITES = [
    [['lyondellbasell', 'channelview'], 29.8325, -95.1170],
    [['pemex', 'deer park'], 29.7215, -95.1265],
    [['shell', 'deer park'], 29.7190, -95.1180],
    [['exxonmobil', 'baytown'], 29.7480, -95.0120],
    [['exxonmobil', 'olefins'], 29.7480, -95.0120],
    [['chevron phillips', 'baytown'], 29.7660, -94.9320],
    [['chevron phillips', 'cedar bayou'], 29.7660, -94.9320],
    [['valero', 'houston'], 29.7230, -95.2550],
    [['pasadena refin'], 29.7220, -95.2110],
    [['lyondellbasell', 'houston refin'], 29.7130, -95.2310],
    [['tpc group'], 29.7090, -95.2500],
    [['invista', 'houston'], 29.7180, -95.2380],
];

export function normalizeAddress(address) {
    return (address || '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[ ,.]+|[ ,.]+$/g, '')
        .replace(/\b(BLOCK|BLK)\s+(OF\s+)?/gi, '')
        .replace(/,\s*(?=TX\b)/gi, ', ')
        .replace(/([a-z]),(?=TX\b)/gi, '$1, ');
}

const keyOf = (address) => normalizeAddress(address).toUpperCase();
const geocodable = (q) => q.length >= 6 && /\d/.test(q);

/** Return {lat, lon, matched, approximate: false} or null. Network errors are not cached. */
export async function geocode(address, { persist = false } = {}) {
    const q = normalizeAddress(address);
    if (!geocodable(q)) return null;
    const key = q.toUpperCase();
    if (cache.has(key)) return cache.get(key);
    let result;
    try {
        result = await censusOneline(q);
    } catch {
        return null; // transient failure: retry on a later refresh
    }
    cache.set(key, result);
    if (persist && persisted) {
        persisted.set(key, result);
        persistedDirty = true;
    }
    return result;
}

async function censusOneline(q) {
    const url = `${ONELINE_URL}?${new URLSearchParams({ address: q, benchmark: BENCHMARK, format: 'json' })}`;
    const match = (await getJson(url))?.result?.addressMatches?.[0];
    const c = match?.coordinates;
    if (!c || c.x == null || c.y == null) return null;
    return { lat: Number(c.y), lon: Number(c.x), matched: match.matchedAddress || q, approximate: false };
}

/** Peek without a network call: result, null (known miss), or undefined (not looked up yet). */
export function cached(address) {
    const key = keyOf(address);
    return cache.has(key) ? cache.get(key) : undefined;
}

function csvField(s) {
    const v = String(s ?? '');
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function parseCsvLine(line) {
    const out = [];
    let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quoted) {
            if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
            else if (ch === '"') quoted = false;
            else cur += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
    }
    out.push(cur);
    return out;
}

/** Parse the Census batch response: "id","input","Match","Exact","matched","lon,lat",... */
export function parseBatchResponse(text) {
    const results = new Map();
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const f = parseCsvLine(line);
        const id = f[0];
        if (f[2] === 'Match' && f[5]) {
            const [lon, lat] = f[5].split(',').map(Number);
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
                results.set(id, { lat, lon, matched: f[4] || f[1], approximate: false });
                continue;
            }
        }
        results.set(id, null);
    }
    return results;
}

/**
 * Geocode many street addresses in one city with a single batch request.
 * Returns Map(input street -> result | null). Inputs whose batch request
 * failed map to null without being cached, so they are retried next time.
 */
export async function geocodeStreets(streets, { city, state }) {
    const out = new Map();
    const todo = [];
    for (const street of new Set(streets)) {
        const full = `${street}, ${city}, ${state}`;
        if (!geocodable(normalizeAddress(street))) { out.set(street, null); continue; }
        const hit = cached(full);
        if (hit !== undefined) out.set(street, hit);
        else todo.push(street);
    }
    if (!todo.length) return out;
    const csv = todo.map((s, i) => [i, normalizeAddress(s), city, state, ''].map(csvField).join(',')).join('\n');
    const form = new FormData();
    form.append('addressFile', new Blob([csv], { type: 'text/csv' }), 'addresses.csv');
    form.append('benchmark', BENCHMARK);
    let parsed;
    try {
        parsed = parseBatchResponse(await postText(BATCH_URL, { body: form, timeout: 30000 }));
    } catch {
        for (const s of todo) out.set(s, null);
        return out;
    }
    todo.forEach((street, i) => {
        const r = parsed.get(String(i)) ?? null;
        cache.set(keyOf(`${street}, ${city}, ${state}`), r);
        out.set(street, r);
    });
    return out;
}

export function knownSite(facilityName) {
    const name = (facilityName || '').toLowerCase();
    for (const [keys, lat, lon] of KNOWN_SITES) {
        if (keys.every((k) => name.includes(k))) return { lat, lon, matched: facilityName, approximate: true };
    }
    return null;
}

/** Load persisted facility geocodes from KV into the isolate cache (once per isolate). */
let loading = null;
export function loadPersisted(kv) {
    if (!kv) return Promise.resolve();
    loading ||= (async () => {
        const map = new Map();
        try {
            const saved = await kv.get(KV_KEY, 'json');
            for (const [k, v] of Object.entries(saved || {})) {
                map.set(k, v);
                if (!cache.has(k)) cache.set(k, v);
            }
        } catch { /* KV unavailable: carry on with network lookups */ }
        persisted = map;
    })();
    return loading;
}

/** Write new facility geocodes back to KV (only when something changed). */
export async function savePersisted(kv) {
    if (!kv || !persisted || !persistedDirty) return;
    persistedDirty = false;
    try {
        await kv.put(KV_KEY, JSON.stringify(Object.fromEntries(persisted)));
    } catch {
        persistedDirty = true;
    }
}

/** For tests. */
export function _reset() {
    cache.clear();
    persisted = null;
    persistedDirty = false;
    loading = null;
}
export const _cache = cache;
