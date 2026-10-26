import { readFileSync } from 'node:fs';
import { afterEach, beforeEach } from 'node:test';

import * as caer from '../src/caer.js';
import * as geocode from '../src/geocode.js';
import * as houston from '../src/houston.js';
import * as nws from '../src/nws.js';

export const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

// 1:30 PM Houston time (CDT, UTC-5) on the fixture day.
export const NOW = Date.parse('2026-10-26T13:30:00-05:00');
export const HOME = [29.7761, -95.1144]; // Channelview

// Fake geocoder results keyed by normalized upper-case address.
export const GEOCODES = {
    '8280 SHELDON RD CHANNELVIEW, TX 77530': [29.8325, -95.1170],
    '100 EXAMPLE RD BAYTOWN, TX 77520': [29.7600, -95.0000],
    '1423 HIGHWAY 225 PASADENA, TX 77506': [29.7230, -95.1900],
    '12342 STRANG RD. LA PORTE, TX 77571': [29.6960, -95.0710],
    '1000 MAIN ST': [29.7560, -95.3630],
    '2000 SMITH ST': [29.7520, -95.3720],
    '3000 FANNIN ST': [29.7420, -95.3780],
};

const realFetch = globalThis.fetch;
export const calls = [];

/**
 * Replace global fetch. `routes` maps a URL substring to a handler
 * (url, init) => Response | string | object (JSON). Census geocoder calls are
 * answered from GEOCODES automatically.
 */
export function mockFetch(routes = {}) {
    globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.includes('onelineaddress')) {
            const q = new URL(url).searchParams.get('address').toUpperCase();
            const hit = GEOCODES[q];
            return Response.json({ result: { addressMatches: hit ? [{ coordinates: { x: hit[1], y: hit[0] }, matchedAddress: q }] : [] } });
        }
        if (url.includes('addressbatch')) {
            const csv = await init.body.get('addressFile').text();
            const lines = csv.split('\n').map((line) => {
                const [id, street] = line.split(',');
                const hit = GEOCODES[street.toUpperCase()];
                return hit
                    ? `"${id}","${street}, Houston, TX, ","Match","Exact","${street}, HOUSTON, TX, 77002","${hit[1]},${hit[0]}","1","L"`
                    : `"${id}","${street}, Houston, TX, ","No_Match"`;
            });
            return new Response(lines.join('\n'));
        }
        for (const [needle, handler] of Object.entries(routes)) {
            if (url.includes(needle)) {
                const out = typeof handler === 'function' ? await handler(url, init) : handler;
                if (out instanceof Response) return out;
                return typeof out === 'string' ? new Response(out) : Response.json(out);
            }
        }
        throw new TypeError(`fetch failed (no mock for ${url})`);
    };
}

export function resetAll() {
    for (const c of [caer.cache, houston.cache, ...Object.values(nws.caches)]) c.clear();
    caer._reset();
    geocode._reset();
    calls.length = 0;
}

beforeEach(() => resetAll());
afterEach(() => { globalThis.fetch = realFetch; });
