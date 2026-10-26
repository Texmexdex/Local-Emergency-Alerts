// Local Emergency Alerts API — Cloudflare Worker.
//
// GET /api/status?lat=29.77&lon=-95.11[&radius_mi=10][&label=Home]
//     One combined assessment: overall level, the reasons for it, and the
//     normalized data from every source.
// GET /api/geocode?q=<address or place>
//     Look up coordinates for a home address.
// GET /api/health
//
// The cron trigger (wrangler.toml) runs the ntfy phone-push monitor.
import { SOURCES, assess } from './assess.js';
import { DEFAULT_LABEL, DEFAULT_LAT, DEFAULT_LON, DEFAULT_RADIUS_KM } from './config.js';
import * as geocode from './geocode.js';
import { TTLCache, getJson } from './http.js';
import { runMonitor } from './monitor.js';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};
const placeCache = new TTLCache(24 * 3600_000);

function json(body, status = 200, extra = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...extra },
    });
}

function numberParam(params, name, fallback, lo, hi) {
    const raw = params.get(name);
    if (raw == null || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new RangeError(`${name} must be a number`);
    if (value < lo || value > hi) throw new RangeError(`${name} must be between ${lo} and ${hi}`);
    return value;
}

async function status(params, env, ctx) {
    let lat, lon, radiusKm;
    try {
        lat = numberParam(params, 'lat', DEFAULT_LAT, 18, 72);
        lon = numberParam(params, 'lon', DEFAULT_LON, -180, -60);
        radiusKm = DEFAULT_RADIUS_KM;
        if (params.get('radius_mi')) radiusKm = numberParam(params, 'radius_mi', 10, 1, 50) / 0.621371;
        else if (params.get('radius_km')) radiusKm = numberParam(params, 'radius_km', radiusKm, 1, 80);
    } catch (err) {
        return json({ error: err.message }, 400);
    }
    let label = (params.get('label') || '').trim().slice(0, 80) || null;
    if (!label && lat === DEFAULT_LAT && lon === DEFAULT_LON) label = DEFAULT_LABEL;
    await geocode.loadPersisted(env.STATE);
    const result = await assess(lat, lon, { radiusKm, label });
    ctx.waitUntil(geocode.savePersisted(env.STATE));
    return json(result);
}

async function nominatim(q) {
    try {
        const rows = await getJson(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q, format: 'jsonv2', limit: '5', countrycodes: 'us' })}`);
        return rows.map((r) => ({ lat: Number(r.lat), lon: Number(r.lon), label: r.display_name || q }));
    } catch {
        return [];
    }
}

async function geocodeRoute(params) {
    const q = (params.get('q') || '').trim().slice(0, 200);
    if (q.length < 3) return json({ error: 'q is required' }, 400);
    const hit = await geocode.geocode(q);
    const results = hit
        ? [{ lat: hit.lat, lon: hit.lon, label: hit.matched.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase()) }]
        : await placeCache.getOrFetch(q.toLowerCase(), () => nominatim(q)); // place names Census can't match
    return json({ query: q, results });
}

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
        if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
        const url = new URL(request.url);
        switch (url.pathname.replace(/\/+$/, '')) {
            case '/api/status':
                return status(url.searchParams, env, ctx);
            case '/api/geocode':
                return geocodeRoute(url.searchParams);
            case '/api/health':
                return json({
                    status: 'ok',
                    time: new Date().toISOString(),
                    default_location: { lat: DEFAULT_LAT, lon: DEFAULT_LON, label: DEFAULT_LABEL },
                    sources: Object.fromEntries(Object.entries(SOURCES).map(([k, [name]]) => [k, name])),
                    monitor: { enabled: Boolean(env.NTFY_TOPIC && env.STATE), kv_bound: Boolean(env.STATE) },
                });
            case '':
                return json({ service: 'Local Emergency Alerts API', endpoints: ['/api/status', '/api/geocode', '/api/health'] });
            default:
                return json({ error: 'not found' }, 404);
        }
    },

    async scheduled(event, env, ctx) {
        await geocode.loadPersisted(env.STATE);
        console.log(await runMonitor(env));
        ctx.waitUntil(geocode.savePersisted(env.STATE));
    },
};
