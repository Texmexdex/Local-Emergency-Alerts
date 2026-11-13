// Houston TranStar traffic incidents: wrecks, stalls, debris and hazards on
// monitored roads across the region (I-10, Beltway 8, SH 146, SH 225, I-45 ...).
//
// Source: the JSON layer behind TranStar's public traffic map, which carries
// coordinates for every incident:
//   {"incidents": [{"id","location","dir","desc","veh","lanes","status",
//                   "time":"1:31 PM","date":"today","lat","lng"}, ...]}
import { bearingDeg, compass, distanceKm, round1 } from './geo.js';
import { TTLCache, getText, localParts, localToEpoch, toLocalIso } from './http.js';

export const FEED_URL = 'https://traffic.houstontranstar.org/data/layers/incidents_json.js';
export const PAGE_URL = 'https://traffic.houstontranstar.org/roadclosures/';
export const cache = new TTLCache(60_000);

const HAZMAT_RE = /HAZMAT|HAZ\W*MAT|HAZARDOUS|CHEMICAL|SPILL|LEAK|EXPLOS|GAS\b/i;
const WATER_RE = /HIGH WATER|FLOOD/i;
const ORDER = { action: 0, warning: 1, advisory: 2, info: 3 };

/** Parse the layer file (JSON, possibly wrapped in a JS assignment). */
export function parseFeed(text) {
    const start = (text || '').indexOf('{');
    const end = (text || '').lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('TranStar incident feed format not recognised');
    const data = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(data.incidents)) throw new Error('TranStar incident feed has no incidents list');
    return data.incidents;
}

/** "1:31 PM" + "today" | "yesterday" | "11/12/2026" (Houston time) -> epoch ms. */
export function eventTime(time, date, now = Date.now()) {
    const m = /^(\d{1,2}):(\d{2})\s*([AP]M)?$/i.exec((time || '').trim());
    if (!m) return null;
    let hour = Number(m[1]);
    const ampm = m[3]?.toUpperCase();
    if (ampm === 'PM' && hour < 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    const d = (date || '').trim().toLowerCase();
    const dm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(d);
    if (dm) return localToEpoch(Number(dm[3]), Number(dm[1]), Number(dm[2]), hour, Number(m[2]));
    const today = localParts(now);
    const dayOffset = d === 'yesterday' ? -1 : 0;
    return localToEpoch(today.year, today.month, today.day + dayOffset, hour, Number(m[2]));
}

/** Return [level, kind]. Only hazardous-material or water incidents near home affect the verdict. */
export function classify(desc, distanceKmFromHome) {
    const near = (km) => distanceKmFromHome != null && distanceKmFromHome <= km;
    const t = desc || '';
    if (HAZMAT_RE.test(t)) return [near(8) ? 'warning' : 'info', 'hazmat'];
    if (WATER_RE.test(t)) return [near(5) ? 'advisory' : 'info', 'flooding'];
    if (/FIRE|SMOKE/i.test(t)) return ['info', 'fire'];
    if (/ACCIDENT|CRASH|COLLISION/i.test(t)) return ['info', 'accident'];
    if (/STALL/i.test(t)) return ['info', 'stall'];
    if (/DEBRIS|HAZARD|OBJECT/i.test(t)) return ['info', 'hazard'];
    if (/CLOS/i.test(t)) return ['info', 'closure'];
    return ['info', 'other'];
}

export async function fetchIncidents(homeLat, homeLon, now = Date.now()) {
    const raw = await cache.getOrFetch('feed', async () => parseFeed(await getText(FEED_URL)));
    const incidents = raw.map((r) => {
        const lat = Number(r.lat);
        const lon = Number(r.lng ?? r.lon);
        const located = Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0;
        const dist = located ? round1(distanceKm(homeLat, homeLon, lat, lon)) : null;
        const [level, kind] = classify(r.desc, dist);
        const at = eventTime(r.time, r.date, now);
        const vehicles = parseInt(r.veh, 10);
        return {
            id: `tt-${r.id}`,
            type: r.desc || 'Incident',
            location: r.location || null,
            direction: r.dir || null,
            lanes: r.lanes || null,
            vehicles: Number.isFinite(vehicles) ? vehicles : null,
            status: r.status || null,
            reported_at: at == null ? null : toLocalIso(at),
            level,
            kind,
            lat: located ? lat : null,
            lon: located ? lon : null,
            distance_km: dist,
            bearing_from_home: located ? compass(bearingDeg(homeLat, homeLon, lat, lon)) : null,
            url: PAGE_URL,
        };
    });
    incidents.sort((a, b) => ORDER[a.level] - ORDER[b.level] || (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9));
    return incidents;
}
