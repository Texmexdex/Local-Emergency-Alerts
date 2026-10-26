// Combine all sources into one answer: is there an emergency near me?
//
// Levels, highest first:
//   action   - official protective action (shelter in place, evacuate, tornado
//              warning...) or an industrial message telling neighbours to act.
//   warning  - an emergency is happening nearby: industrial release/fire,
//              hazmat or major fire call, severe weather warning.
//   advisory - something worth knowing: watches/advisories, minor industrial
//              incidents, a nearby fire.
//   clear    - nothing found in the sources that responded.
import * as caer from './caer.js';
import { DEFAULT_RADIUS_KM } from './config.js';
import { DOWNWIND_MAX_KM, downwindExposure, kmToMi, round1 } from './geo.js';
import * as houston from './houston.js';
import * as nws from './nws.js';

export const LEVELS = ['clear', 'info', 'advisory', 'warning', 'action'];
const HEADLINES = {
    action: 'Take protective action now',
    warning: 'Emergency activity near you',
    advisory: 'Be aware: activity near you',
    clear: 'No active emergencies found near you',
};
const ESCALATE = { advisory: 'warning', warning: 'warning', action: 'action' };

export const SOURCES = {
    nws_alerts: ['National Weather Service alerts', nws.fetchAlerts],
    weather: ['NWS observed wind & weather', nws.fetchWeather],
    caer: ['CAER industrial community notifications', caer.fetchPostings],
    houston_fire: ['City of Houston Fire/EMS active incidents', houston.fetchIncidents],
};

export const rank = (level) => LEVELS.indexOf(level);
const mi = (km) => round1(kmToMi(km));

async function run(fn, lat, lon) {
    const started = Date.now();
    try {
        return { ok: true, data: await fn(lat, lon), error: null, ms: Date.now() - started };
    } catch (err) { // each source fails independently
        return { ok: false, data: null, error: `${err?.name || 'Error'}: ${err?.message || err}`.slice(0, 300), ms: Date.now() - started };
    }
}

export async function gather(lat, lon, sources = SOURCES) {
    const keys = Object.keys(sources);
    const results = await Promise.all(keys.map((k) => run(sources[k][1], lat, lon)));
    return Object.fromEntries(keys.map((k, i) => [k, results[i]]));
}

export function build(lat, lon, results, { radiusKm = DEFAULT_RADIUS_KM, label = null, now = Date.now() } = {}) {
    const alerts = results.nws_alerts.data || [];
    const weather = results.weather.data;
    const postings = results.caer.data || [];
    const fires = results.houston_fire.data || [];
    const reasons = [];

    for (const a of alerts) {
        if (a.level === 'info') continue;
        reasons.push({
            id: `nws-${a.id}`, level: a.level, source: 'NWS', title: a.event, detail: a.headline,
            instruction: a.instruction, time: a.effective, expires: a.ends || a.expires, distance_mi: null, url: a.url,
        });
    }

    const windFrom = weather?.wind_from_deg ?? null;
    const windKmh = weather?.wind_kmh ?? null;
    const downwindOf = [];
    for (const p of postings) {
        p.exposure = p.lat != null && weather ? downwindExposure(p.lat, p.lon, lat, lon, windFrom, windKmh) : null;
        if (p.level === 'info' || !caer.isCurrent(p)) continue;
        const d = p.distance_km;
        let inRange = d == null || d <= radiusKm;
        if (p.exposure && d != null && d <= DOWNWIND_MAX_KM) inRange = true;
        if (!inRange) continue;
        let level = p.level;
        const note = [];
        if (p.exposure === 'downwind') {
            level = ESCALATE[level];
            note.push('the wind is blowing from this facility toward you');
            downwindOf.push(p.facility);
        } else if (p.exposure === 'calm-nearby') {
            note.push('winds are calm, so odours or vapours may linger nearby');
        }
        if (d == null) note.push('facility location unknown');
        reasons.push({
            id: p.id, level, source: 'CAER',
            title: `${p.facility}: ${p.kind === 'protective_action' ? 'shelter/evacuate message' : 'incident reported'}`,
            detail: p.text, note: note.join('; ') || null, instruction: null, time: p.posted_at, expires: null,
            distance_mi: mi(d), direction: p.bearing_from_home, url: p.url,
        });
    }

    for (const f of fires) {
        if (f.level === 'info' || f.distance_km == null || f.distance_km > radiusKm) continue;
        reasons.push({
            id: f.id, level: f.level, source: 'HFD', title: `Houston Fire: ${f.type}`,
            detail: [f.address, f.cross_street].filter(Boolean).join(', '), instruction: null,
            time: f.called_at, expires: null, distance_mi: mi(f.distance_km), direction: f.bearing_from_home, url: f.url,
        });
    }

    reasons.sort((a, b) => rank(b.level) - rank(a.level) || (a.distance_mi ?? 1e9) - (b.distance_mi ?? 1e9));
    const level = reasons.length ? reasons[0].level : 'clear';
    const failed = Object.keys(SOURCES).filter((k) => results[k] && !results[k].ok).map((k) => SOURCES[k][0]);
    const headline = level === 'clear' && failed.length ? 'No emergencies found in the sources that responded' : HEADLINES[level];

    return {
        generated_at: new Date(now).toISOString(),
        location: { lat, lon, label: label || weather?.place || `${lat.toFixed(4)}, ${lon.toFixed(4)}` },
        radius_km: radiusKm,
        radius_mi: mi(radiusKm),
        level,
        headline,
        reasons,
        downwind_of: downwindOf,
        complete: failed.length === 0,
        failed_sources: failed,
        sources: Object.fromEntries(Object.keys(SOURCES).filter((k) => results[k]).map((k) => [k, {
            name: SOURCES[k][0], ok: results[k].ok, error: results[k].error, ms: results[k].ms,
            count: Array.isArray(results[k].data) ? results[k].data.length : null,
        }])),
        alerts,
        weather,
        caer: postings,
        fire: fires,
    };
}

export async function assess(lat, lon, opts = {}) {
    return build(lat, lon, await gather(lat, lon), opts);
}
