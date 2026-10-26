// Plant notifications relayed from your own phone.
//
// The public CAER web feed now requires a sign-in, but the EHCMA CAER Online
// app still sends push notifications to residents. A notification-forwarder
// app on an Android phone (an old spare phone on WiFi works well) can POST
// each notification it receives to /api/ingest/notification. They are kept
// in KV for a week and fed through the same CAER classifier as the old feed.
//
// This is your own copy of alerts sent to you; keep the dashboard private
// and don't republish them.
import { clean } from './http.js';

const KEY = 'relay:caer:v1';
const KEEP_MS = 7 * 24 * 3600_000;
const MAX_ITEMS = 300;
// If the phone has ever sent a heartbeat, treat it as offline after this long.
export const STALE_AFTER_MS = 6 * 3600_000;

const first = (...vals) => vals.find((v) => typeof v === 'string' && v.trim()) || '';

function parseTime(v, now) {
    if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
    if (typeof v === 'string' && /^\d{10,13}$/.test(v.trim())) return parseTime(Number(v), now);
    const t = Date.parse(v ?? '');
    return Number.isFinite(t) && t <= now + 5 * 60_000 ? t : now;
}

async function hash(s) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Accept the field names common forwarder apps use. */
export function normalize(payload, now = Date.now()) {
    const p = payload || {};
    const title = clean(first(p.title, p.notification_title, p.android_title, p.subject)).slice(0, 200);
    const text = clean(first(p.text, p.message, p.body, p.bigtext, p.bigText, p.big_text, p.content, p.android_text)).slice(0, 4000);
    return {
        title,
        text,
        app: clean(first(p.app, p.package, p.packageName, p.package_name, p.app_name)).slice(0, 120) || null,
        received_at: parseTime(p.time ?? p.timestamp ?? p.posted_at ?? p.when, now),
    };
}

async function load(kv) {
    const raw = await kv.get(KEY);
    return raw ? JSON.parse(raw) : { items: [], heartbeat_at: null };
}

/** Store one forwarded notification (or a heartbeat). Writes KV only on change. */
export async function ingest(kv, payload, now = Date.now()) {
    const state = await load(kv);
    if (payload?.heartbeat) {
        state.heartbeat_at = now;
        await kv.put(KEY, JSON.stringify(state));
        return { stored: false, heartbeat: true };
    }
    const n = normalize(payload, now);
    if (!n.text && !n.title) return { stored: false, error: 'empty notification' };
    const id = await hash(`${n.title}|${n.text}`);
    state.items = state.items.filter((i) => now - i.received_at < KEEP_MS);
    if (state.items.some((i) => i.id === id)) return { stored: false, duplicate: true, id };
    state.items.unshift({ id, ...n });
    state.items = state.items.slice(0, MAX_ITEMS);
    state.last_received_at = now;
    await kv.put(KEY, JSON.stringify(state));
    return { stored: true, id };
}

/** Everything relayed in the last week plus relay health. */
export async function recent(kv, now = Date.now()) {
    const state = await load(kv);
    const items = state.items.filter((i) => now - i.received_at < KEEP_MS);
    const lastSeen = Math.max(state.heartbeat_at || 0, state.last_received_at || 0) || null;
    const stale = state.heartbeat_at != null && now - lastSeen > STALE_AFTER_MS;
    return { items, last_seen_at: lastSeen, heartbeat: state.heartbeat_at != null, stale };
}

const FACILITY_RES = [
    /\bmessage from (?<f>.+?) located (?:at|on)\b/i,
    /\bupdate from (?<f>[^.]+?)\./i,
    /\bthis is (?:the )?(?<f>[A-Z][\w&'.-]*(?: [A-Z][\w&'.-]*){0,5}) (?:duty person|calling)/,
];
const GENERIC_TITLE = /^(caer|ehcma|caer online|new message|notification|alert|message|update)\b/i;

/** Work out which facility a notification is about. */
export function facilityOf(title, text) {
    if (title && !GENERIC_TITLE.test(title)) return title.replace(/\s*[-|:]\s*(initial|update|clear|all clear)\b.*$/i, '').trim();
    for (const re of FACILITY_RES) {
        const m = re.exec(text || '');
        if (m) return m.groups.f.trim();
    }
    return title || 'Unknown facility';
}

/**
 * Turn relayed notifications into the same raw shape caer.parseFeed returns:
 * one posting per facility (notifications within 48 h grouped), newest first.
 */
export function toRawPostings(items) {
    const groups = new Map();
    const sorted = [...items].sort((a, b) => b.received_at - a.received_at);
    for (const i of sorted) {
        const facility = facilityOf(i.title, i.text);
        const label = /\bclear\b/i.test(i.title) ? 'All Clear' : /\bupdate\b/i.test(i.title) ? 'Update' : '';
        const entry = { posted: i.received_at, label, text: i.text || i.title };
        const g = groups.get(facility);
        if (g && g.entries[g.entries.length - 1].posted - i.received_at < 48 * 3600_000) g.entries.push(entry);
        else if (!g) groups.set(facility, { facility, entries: [entry] });
    }
    return [...groups.values()];
}
