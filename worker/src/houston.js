// City of Houston active Fire / EMS incidents.
//
// Source: https://cohweb.houstontx.gov/ActiveIncidents/Combined.aspx
// (refreshed by the city about every 5 minutes; City of Houston only, so
// unincorporated Harris County such as Channelview or Sheldon is NOT covered.)
import { bearingDeg, compass, distanceKm, round1 } from './geo.js';
import * as geocode from './geocode.js';
import * as keymap from './keymap.js';
import { TTLCache, clean, getText, htmlToText, localParts, localToEpoch, toLocalIso } from './http.js';

export const FEED_URL = 'https://cohweb.houstontx.gov/ActiveIncidents/Combined.aspx';
export const cache = new TTLCache(60_000);

const COLUMN_KEYS = [
    ['agency', 'agency'],
    ['address', 'address'],
    ['location', 'address'],
    ['crossstreet', 'cross_street'],
    ['keymap', 'key_map'],
    ['calltime', 'call_time'],
    ['incidenttype', 'type'],
    ['type', 'type'],
    ['alarm', 'alarm'],
    ['units', 'units'],
    ['combinedresponse', 'combined'],
];
const LEGACY_ORDER = ['agency', 'address', 'cross_street', 'key_map', 'call_time', 'type', 'combined'];

const HAZMAT_RE = /HAZ|CHEMICAL|EXPLOS|GAS LEAK|NATURAL GAS|GAS ODOR|ODOR|SPILL|PIPELINE|RADIOLOG|BOMB|TOXIC|VAPOR/;
const ALARM_ONLY_RE = /FIRE\s*ALARM|ALARM\s*(SYSTEM|ACTIVATION|SOUNDING)|SMOKE\s*DETECTOR|CO\s*DETECTOR|CARBON MONOXIDE ALARM/;
const FIRE_RE = /FIRE|SMOKE|BURN/;
const MAJOR_FIRE_RE = /(2ND|3RD|4TH|5TH|SECOND|THIRD|MULTI|GENERAL)\W*ALARM|HIGH\s*RISE|COMMERCIAL|INDUSTRIAL|REFINERY|PLANT/;
const ORDER = { action: 0, warning: 1, advisory: 2, info: 3 };

function mapHeaders(cells) {
    return cells.map((c) => {
        const n = c.toLowerCase().replace(/[^a-z]/g, '');
        return COLUMN_KEYS.find(([prefix]) => n.startsWith(prefix))?.[1] ?? null;
    });
}

const isHeader = (keys) => keys.includes('address') && keys.includes('type');

function rowsOf(html) {
    return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map((m) =>
        [...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)].map((c) => clean(htmlToText(c[1]))));
}

/**
 * The incident grid is located by its header row ("Address" ... "Incident
 * Type") so layout tables around it can't misalign the columns. If no header
 * is found, fall back to 7-cell rows in the historical column order.
 */
export function parseTable(html) {
    const src = html || '';
    let grid = src;
    const headerAt = src.search(/>\s*Incident\s*Type\s*</i);
    if (headerAt >= 0) {
        const start = src.lastIndexOf('<table', headerAt);
        const end = src.indexOf('</table', headerAt);
        if (start >= 0) grid = src.slice(start, end >= 0 ? end : undefined);
    }
    let keys = null;
    const rows = [];
    for (const cells of rowsOf(grid)) {
        if (!cells.some(Boolean)) continue;
        const mapped = mapHeaders(cells);
        if (isHeader(mapped)) { keys = mapped; continue; }
        if (/this page contains|disclaimer/i.test(cells.join(' '))) continue;
        const rowKeys = keys || (cells.length >= 7 ? LEGACY_ORDER : null);
        if (!rowKeys) continue;
        const row = {};
        rowKeys.forEach((k, i) => { if (k && i < cells.length) row[k] = cells[i]; });
        if (row.address || row.type) rows.push(row);
    }
    return rows;
}

/** Parse a call time (full date or time only) as Houston local time -> epoch ms. */
export function parseCallTime(text, now = Date.now()) {
    const t = clean(text);
    let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?$/i.exec(t);
    let y, mo, d, h, mi, s, ampm;
    if (m) {
        [, mo, d, y, h, mi, s, ampm] = m;
    } else {
        m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?$/i.exec(t);
        if (!m) return null;
        [, h, mi, s, ampm] = m;
        const today = localParts(now);
        [y, mo, d] = [today.year, today.month, today.day];
    }
    let hour = Number(h);
    if (ampm?.toUpperCase() === 'PM' && hour < 12) hour += 12;
    if (ampm?.toUpperCase() === 'AM' && hour === 12) hour = 0;
    let epoch = localToEpoch(Number(y), Number(mo), Number(d), hour, Number(mi), Number(s || 0));
    if (!/\//.test(t) && epoch > now + 10 * 60_000) {
        epoch = localToEpoch(Number(y), Number(mo), Number(d) - 1, hour, Number(mi), Number(s || 0));
    }
    return epoch;
}

export function classify(row, distanceKm) {
    const t = (row.type || '').toUpperCase();
    const alarm = /\d/.exec(row.alarm || '');
    const alarmLevel = alarm ? Number(alarm[0]) : 1;
    const near = distanceKm != null;
    if (HAZMAT_RE.test(t)) return [near && distanceKm <= 8 ? 'warning' : 'info', 'hazmat'];
    if (ALARM_ONLY_RE.test(t)) return ['info', 'alarm'];
    if (FIRE_RE.test(t)) {
        if (alarmLevel >= 2 || MAJOR_FIRE_RE.test(t)) return [near && distanceKm <= 8 ? 'warning' : 'info', 'major_fire'];
        return [near && distanceKm <= 3 ? 'advisory' : 'info', 'fire'];
    }
    return ['info', 'other'];
}

async function idFor(key) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(key));
    return `hfd-${[...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export async function fetchIncidents(homeLat, homeLon, now = Date.now()) {
    const rows = await cache.getOrFetch('feed', async () => parseTable(await getText(FEED_URL)));
    const fireRows = rows.filter((r) => !r.agency || r.agency.toUpperCase().startsWith('F'));
    // The live feed usually omits house numbers ("AUGUSTA DR" @ "BURGOYNE RD"),
    // so most calls are placed at the centre of their Key Map square instead.
    const [streets, squares] = await Promise.all([
        geocode.geocodeStreets(fireRows.map((r) => r.address).filter((a) => /\d/.test(a || '')), { city: 'Houston', state: 'TX' }),
        keymap.lookup(fireRows.map((r) => r.key_map)),
    ]);
    const incidents = await Promise.all(fireRows.map(async (r) => {
        const loc = (r.address && streets.get(r.address)) || squares.get(keymap.normalizeCode(r.key_map)) || null;
        const dist = loc ? round1(distanceKm(homeLat, homeLon, loc.lat, loc.lon)) : null;
        const [level, kind] = classify(r, dist);
        const called = parseCallTime(r.call_time, now);
        return {
            id: await idFor(`${r.address}|${r.call_time}|${r.type}`),
            type: r.type || 'Incident',
            address: r.address ?? null,
            cross_street: r.cross_street ?? null,
            key_map: r.key_map ?? null,
            alarm: r.alarm ?? null,
            units: r.units ?? null,
            called_at: called == null ? null : toLocalIso(called),
            call_time_raw: r.call_time ?? null,
            level,
            kind,
            lat: loc ? loc.lat : null,
            lon: loc ? loc.lon : null,
            location_approximate: Boolean(loc?.approximate),
            location_source: loc ? (loc.approximate ? 'keymap' : 'address') : null,
            distance_km: dist,
            bearing_from_home: loc ? compass(bearingDeg(homeLat, homeLon, loc.lat, loc.lon)) : null,
            url: FEED_URL,
        };
    }));
    incidents.sort((a, b) => ORDER[a.level] - ORDER[b.level] || (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9));
    return incidents;
}
