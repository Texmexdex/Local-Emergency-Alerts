// Push notifications for new emergencies, via ntfy (https://ntfy.sh).
//
// Runs on the Worker's cron trigger. Uses the same assessment as the dashboard
// and sends one push per new (or escalated) reason at or above
// NOTIFY_MIN_LEVEL, plus a single "all clear" once everything has ended, and
// a one-time notice if the key feeds stay unreachable.
//
// State lives in the STATE KV namespace and is written only when it changes,
// keeping well inside the free plan's daily KV write allowance.
import { assess, LEVELS, rank } from './assess.js';
import { DEFAULT_LABEL, DEFAULT_LAT, DEFAULT_LON } from './config.js';

const PRIORITY = { action: '5', warning: '4', advisory: '3' };
const TAGS = { action: 'rotating_light', warning: 'warning', advisory: 'information_source' };
const KEEP_FOR_MS = 3 * 24 * 3600_000;
const TOUCH_AFTER_MS = 12 * 3600_000; // refresh "still active" timestamps at most twice a day
const BLIND_IF_DOWN = ['nws_alerts', 'caer'];
export const BLIND_RUNS_BEFORE_WARNING = 30; // ~1 hour at the 2-minute cron schedule
const STATE_KEY = 'monitor:v1';

/** Decide what to send. Pure: returns {messages, state}. */
export function planNotifications(result, state, minLevel = 'warning', now = Date.now()) {
    const min = rank(minLevel);
    const seen = {};
    for (const [k, v] of Object.entries(state.seen || {})) {
        if (now - Date.parse(v.at) < KEEP_FOR_MS) seen[k] = { ...v };
    }
    const messages = [];
    for (const r of result.reasons) {
        const level = rank(r.level);
        const prev = seen[r.id];
        const escalated = !prev || level > rank(prev.level);
        if (escalated && level >= min) {
            const where = r.distance_mi != null ? `${r.distance_mi} mi ${r.direction || ''}`.trim() : null;
            let body = [r.detail, r.note, where].filter(Boolean).join(' | ');
            if (r.instruction) body += `\n\n${r.instruction}`;
            messages.push({ title: `${r.level.toUpperCase()}: ${r.title}`, body: body.slice(0, 3500), level: r.level, url: r.url || null });
        }
        if (escalated) seen[r.id] = { level: r.level, at: new Date(now).toISOString() };
        else if (now - Date.parse(prev.at) > TOUCH_AFTER_MS) prev.at = new Date(now).toISOString();
    }

    const last = state.last_level || 'clear';
    if (result.level === 'clear' && result.complete && rank(last) >= min) {
        messages.push({ title: 'All clear', body: `No active emergencies found near ${result.location.label}.`, level: 'advisory', url: null });
    }

    // If the key feeds keep failing, say so once rather than going silently blind.
    const sources = result.sources || {};
    const blind = BLIND_IF_DOWN.every((k) => sources[k] && !sources[k].ok);
    const prevBlind = state.blind_runs || 0;
    const blindRuns = blind ? Math.min(prevBlind + 1, BLIND_RUNS_BEFORE_WARNING + 1) : 0;
    if (blind && prevBlind + 1 === BLIND_RUNS_BEFORE_WARNING) {
        messages.push({
            title: "Monitor can't reach emergency feeds",
            body: 'The NWS and CAER feeds have been unreachable for about an hour. Phone alerts from this tool are not working; rely on official alerts until this clears.',
            level: 'advisory',
            url: null,
        });
    }

    // A "clear" with sources down isn't trustworthy, so keep the previous level.
    const unverifiedClear = result.level === 'clear' && !result.complete;
    return { messages, state: { seen, last_level: unverifiedClear ? last : result.level, blind_runs: blindRuns } };
}

const ascii = (s) => (s || '').replace(/[^\x20-\x7e]/g, '').slice(0, 200);

async function sendNtfy(server, topic, msg, clickUrl) {
    const headers = {
        Title: ascii(msg.title),
        Priority: PRIORITY[msg.level] || '3',
        Tags: TAGS[msg.level] || 'information_source',
    };
    if (clickUrl || msg.url) headers.Click = clickUrl || msg.url;
    const resp = await fetch(`${server.replace(/\/$/, '')}/${encodeURIComponent(topic)}`, {
        method: 'POST', body: msg.body, headers, signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`ntfy HTTP ${resp.status}`);
}

/** Cron entry point. Returns a short summary (also logged). */
export async function runMonitor(env, { dryRun = false } = {}) {
    if (!env.NTFY_TOPIC && !dryRun) return 'monitor disabled: set the NTFY_TOPIC secret';
    if (!env.STATE && !dryRun) return 'monitor disabled: bind a KV namespace as STATE';
    const lat = Number(env.HOME_LAT || DEFAULT_LAT);
    const lon = Number(env.HOME_LON || DEFAULT_LON);
    const radiusMi = Number(env.RADIUS_MI || 10);
    const minLevel = LEVELS.includes(env.NOTIFY_MIN_LEVEL) ? env.NOTIFY_MIN_LEVEL : 'warning';

    const result = await assess(lat, lon, { radiusKm: radiusMi / 0.621371, label: env.HOME_LABEL || DEFAULT_LABEL });
    const raw = env.STATE ? await env.STATE.get(STATE_KEY) : null;
    const state = raw ? JSON.parse(raw) : { seen: {}, last_level: 'clear' };
    const { messages, state: next } = planNotifications(result, state, minLevel);

    let failures = 0;
    if (!dryRun) {
        for (const m of messages) {
            try {
                await sendNtfy(env.NTFY_SERVER || 'https://ntfy.sh', env.NTFY_TOPIC, m, env.DASHBOARD_URL);
            } catch (err) {
                failures++;
                console.error(`ntfy send failed: ${err.message}`);
            }
        }
        const serialized = JSON.stringify(next);
        if (!failures && serialized !== raw) await env.STATE.put(STATE_KEY, serialized);
    }
    return `level=${result.level} reasons=${result.reasons.length} failed=${result.failed_sources.join('; ') || 'none'} sent=${messages.length - failures}${failures ? ` failed_sends=${failures}` : ''}`
        + (dryRun ? `\n${messages.map((m) => `--- ${m.title}\n${m.body}`).join('\n')}` : '');
}
