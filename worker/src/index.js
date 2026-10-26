// Local Emergency Alerts API — Cloudflare Worker.
//
// GET /api/status?lat=29.77&lon=-95.11[&radius_mi=10][&label=Home]
//     One combined assessment: overall level, the reasons for it, and the
//     normalized data from every source.
// GET /api/geocode?q=<address or place>
//     Look up coordinates for a home address.
// GET /api/health
// GET /api/debug?source=caer|caer_app|houston|keymap   what an upstream feed returned
//
// The cron trigger (wrangler.toml) runs the ntfy phone-push monitor.
import { SOURCES, assess } from './assess.js';
import * as caer from './caer.js';
import { DEFAULT_LABEL, DEFAULT_LAT, DEFAULT_LON, DEFAULT_RADIUS_KM, USER_AGENT } from './config.js';
import * as geocode from './geocode.js';
import * as houston from './houston.js';
import { TTLCache, clean, getJson, htmlToText } from './http.js';
import * as keymap from './keymap.js';
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

// What an upstream feed actually returned, for checking parsers against live
// data: /api/debug?source=caer | houston | keymap&code=494G
async function debugRoute(params) {
    const source = params.get('source');
    const describe = async (url) => {
        const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
        const html = await resp.text();
        return {
            url, status: resp.status, bytes: html.length,
            title: clean(htmlToText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '')) || null,
            html,
        };
    };
    try {
        if (source === 'caer') {
            const { html, ...meta } = await describe(caer.FEED_URL);
            const postings = caer.parseFeed(html);
            return json({
                ...meta,
                h5_headings: (html.match(/<h5\b/gi) || []).length,
                parsed_postings: postings.length,
                first_postings: postings.slice(0, 3).map((p) => ({ facility: p.facility, entries: p.entries.length, latest: p.entries[0] })),
                text_sample: clean(htmlToText(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ''))).slice(0, 1500),
            });
        }
        if (source === 'caer_app') {
            // The CAER page is now a JavaScript app. List what it loads and any
            // data addresses inside its scripts, to find where messages come from.
            const page = await describe(caer.FEED_URL);
            const base = new URL(page.url);
            const abs = (u) => { try { return new URL(u, base).href; } catch { return null; } };
            const scripts = [...page.html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((m) => abs(m[1])).filter(Boolean);
            const links = [...page.html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["']/gi)].map((m) => abs(m[1])).filter(Boolean);
            const inline = [...page.html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].trim()).filter(Boolean);
            const URLISH = /["'`]((?:https?:\/\/|\/|\.\.?\/)?[\w\-./]*(?:api|Api|API|json|Json|Message|message|Caer|caer|Feed|feed|hub|Hub|signalr|notif|Notif|odata|graphql)[\w\-./?=&{}$]*)["'`]/g;
            const hits = (text) => [...new Set([...text.matchAll(URLISH)].map((m) => m[1]).filter((u) => u.length > 3 && u.length < 160))].slice(0, 60);
            const scanned = [];
            for (const src of scripts.filter((u) => new URL(u).host === base.host).slice(0, 6)) {
                try {
                    const r = await fetch(src, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
                    const js = (await r.text()).slice(0, 1_500_000);
                    scanned.push({ src, status: r.status, bytes: js.length, data_addresses: hits(js) });
                } catch (err) {
                    scanned.push({ src, error: err.message });
                }
            }
            return json({
                url: page.url, status: page.status, title: page.title, bytes: page.bytes,
                scripts, stylesheets_and_links: links.slice(0, 20),
                inline_scripts: inline.map((t) => t.slice(0, 600)).slice(0, 8),
                inline_data_addresses: hits(inline.join('\n')),
                scanned_scripts: scanned,
                html_head: page.html.slice(0, 2500),
            });
        }
        if (source === 'houston') {
            const { html, ...meta } = await describe(houston.FEED_URL);
            const rows = houston.parseTable(html);
            return json({
                ...meta,
                header_found: /incident\s*type/i.test(html),
                parsed_rows: rows.length,
                sample_rows: rows.slice(0, 5),
                key_map_codes: [...new Set(rows.map((r) => r.key_map).filter(Boolean))].slice(0, 20),
            });
        }
        if (source === 'keymap') {
            const code = keymap.normalizeCode(params.get('code') || '493A');
            if (!code) return json({ error: 'code must look like 494G' }, 400);
            const found = await keymap.queryService([code]);
            return json({ service: keymap.SERVICE_URL, code, result: found.get(code) || null });
        }
        return json({ error: 'source must be caer, caer_app, houston or keymap' }, 400);
    } catch (err) {
        return json({ source, error: `${err.name}: ${err.message}` }, 502);
    }
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
            case '/api/debug':
                return debugRoute(url.searchParams);
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
