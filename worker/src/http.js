import { HTTP_TIMEOUT_MS, LOCAL_TZ, USER_AGENT } from './config.js';

async function request(url, { method = 'GET', headers = {}, body, timeout = HTTP_TIMEOUT_MS } = {}) {
    const resp = await fetch(url, {
        method,
        body,
        headers: { 'User-Agent': USER_AGENT, ...headers },
        signal: AbortSignal.timeout(timeout),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${new URL(url).host}`);
    return resp;
}

export const getText = async (url, opts) => (await request(url, opts)).text();
export const getJson = async (url, opts) => (await request(url, opts)).json();
export const postText = async (url, opts) => (await request(url, { ...opts, method: 'POST' })).text();

/**
 * Per-isolate TTL cache of promises, so concurrent and repeated requests
 * share one upstream fetch. Failed fetches are evicted immediately.
 */
export class TTLCache {
    constructor(ttlMs, maxItems = 2000) {
        this.ttlMs = ttlMs;
        this.maxItems = maxItems;
        this.map = new Map();
    }

    getOrFetch(key, fetchFn) {
        const now = Date.now();
        const hit = this.map.get(key);
        if (hit && hit.expires > now) return hit.promise;
        const promise = Promise.resolve().then(fetchFn);
        this.map.set(key, { expires: now + this.ttlMs, promise });
        promise.catch(() => { if (this.map.get(key)?.promise === promise) this.map.delete(key); });
        if (this.map.size > this.maxItems) this.map.delete(this.map.keys().next().value);
        return promise;
    }

    clear() { this.map.clear(); }
}

// ---- Houston local time <-> ISO strings ----

const offsetFormatter = new Intl.DateTimeFormat('en-US', { timeZone: LOCAL_TZ, timeZoneName: 'longOffset' });
const partsFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: LOCAL_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/** UTC offset of Houston at a given instant, in minutes (e.g. -300 for CDT). */
export function localOffsetMinutes(epochMs) {
    const name = offsetFormatter.formatToParts(new Date(epochMs)).find((p) => p.type === 'timeZoneName').value;
    const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
    if (!m) return 0;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

/** Houston wall-clock parts of an instant: {year, month, day, hour, minute, second}. */
export function localParts(epochMs) {
    const out = {};
    for (const p of partsFormatter.formatToParts(new Date(epochMs))) {
        if (p.type !== 'literal') out[p.type] = Number(p.value);
    }
    return out;
}

/** Epoch ms for a Houston wall-clock time (month is 1-12; day/hour may overflow). */
export function localToEpoch(year, month, day, hour = 0, minute = 0, second = 0) {
    const guess = Date.UTC(year, month - 1, day, hour, minute, second);
    let t = guess - localOffsetMinutes(guess) * 60000;
    const off2 = localOffsetMinutes(t);
    t = guess - off2 * 60000;
    return t;
}

/** ISO 8601 in Houston local time with offset, e.g. 2026-10-26T07:21:00-05:00. */
export function toLocalIso(epochMs) {
    const p = localParts(epochMs);
    const off = localOffsetMinutes(epochMs);
    const pad = (n) => String(n).padStart(2, '0');
    const sign = off < 0 ? '-' : '+';
    const a = Math.abs(off);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Strip tags and decode the HTML entities these feeds actually use. */
export function htmlToText(html) {
    return (html || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
            if (e[0] === '#') {
                const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
                return Number.isFinite(code) ? String.fromCodePoint(code) : m;
            }
            return ENTITIES[e.toLowerCase()] ?? m;
        });
}

export const clean = (s) => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
