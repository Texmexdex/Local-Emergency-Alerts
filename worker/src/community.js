// Scanner reports and official posts relayed from your own phone.
//
// The relay app on the phone can forward notifications from apps other than
// CAER: a scanner-alert app (CrimeRadar, which turns dispatch radio into
// written incidents), texts from Ready Harris or another sender you choose,
// and so on. Those land in the relay store with channel "community"
// (relay.js) and are shown here.
//
// Scanner reports are first dispatch traffic summarised by AI: addresses can
// be misheard and incidents can turn out to be nothing. They are labelled
// unconfirmed and can raise the verdict to "advisory" at most, and only for
// serious keywords near you. Official texts can raise a "warning" when they
// tell people to shelter in place or evacuate.
import { bearingDeg, compass, distanceKm, round1 } from './geo.js';
import * as geocode from './geocode.js';
import { clean, toLocalIso } from './http.js';
import * as relay from './relay.js';

export const SHOW_HOURS = 24;

let store = null;
/** KV namespace holding relayed notifications (the same one relay.js writes). */
export function setStore(kv) { store = kv || null; }

// City/community centres, used when a report names a place but no street
// address. Houston itself is too big to be useful, so it is left out.
export const PLACES = [
    ['Highlands', 29.8189, -95.0563], ['Channelview', 29.7761, -95.1144], ['Crosby', 29.9119, -95.0621],
    ['Sheldon', 29.8680, -95.1280], ['Barrett', 29.8797, -95.0644], ['Cloverleaf', 29.7783, -95.1719],
    ['Baytown', 29.7355, -94.9774], ['Mont Belvieu', 29.8477, -94.8910], ['Old River-Winfree', 29.8686, -94.8302],
    ['Cove', 29.8166, -94.8216], ['Beach City', 29.6622, -94.8730], ['Anahuac', 29.7730, -94.6827],
    ['La Porte', 29.6658, -95.0194], ['Deer Park', 29.7052, -95.1238], ['Pasadena', 29.6911, -95.2091],
    ['Galena Park', 29.7336, -95.2302], ['Jacinto City', 29.7675, -95.2338], ['South Houston', 29.6630, -95.2355],
    ['Humble', 29.9988, -95.2622], ['Atascocita', 29.9988, -95.1766], ['Huffman', 30.0236, -95.0866],
    ['Kingwood', 30.0499, -95.1855], ['Dayton', 30.0466, -94.8852], ['Liberty', 30.0580, -94.7955],
    ['Seabrook', 29.5641, -95.0255], ['Kemah', 29.5427, -95.0205], ['Webster', 29.5377, -95.1183],
    ['League City', 29.5075, -95.0950], ['Friendswood', 29.5294, -95.2010], ['Pearland', 29.5636, -95.2860],
    ['Texas City', 29.3838, -94.9027], ['La Marque', 29.3686, -94.9710],
];
const PLACE_RE = new RegExp(`\\b(${PLACES.map(([n]) => n.replace(/[-\s]/g, '[-\\s]')).join('|')})\\b`, 'i');
const SUFFIX = 'St|Street|Rd|Road|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Pkwy|Parkway|Fwy|Freeway|Hwy|Highway|Ct|Court|Cir|Circle|Pl|Place|Trl|Trail|Loop|Expy|Expressway|Bnd|Bend|Ter|Terrace|Run|Xing|Crossing';
const ADDRESS_RE = new RegExp(`\\b(\\d{2,6})\\s+((?:[NSEW]\\.?\\s+)?(?:[A-Za-z0-9.']+\\s+){0,4}?(?:${SUFFIX}))\\b\\.?`, 'i');
const ZIP_RE = /\b(77\d{3})\b/;
// Only accept geocoder results in the greater Houston / Golden Triangle region.
const inRegion = (lat, lon) => lat > 28.8 && lat < 30.8 && lon > -96.6 && lon < -93.7;

/** Pull a street address and/or a named community out of a report. */
export function extractPlace(text) {
    const t = text || '';
    const placeMatch = PLACE_RE.exec(t);
    const norm = (n) => n.toLowerCase().replace(/[-\s]+/g, ' ');
    const place = placeMatch ? PLACES.find(([n]) => norm(n) === norm(placeMatch[1])) : null;
    const a = ADDRESS_RE.exec(t);
    const zip = ZIP_RE.exec(t)?.[1] ?? null;
    return {
        address: a ? `${a[1]} ${a[2]}` : null,
        place: place ? place[0] : null,
        placeLatLon: place ? [place[1], place[2]] : null,
        zip,
    };
}

/** Locate a report: a geocoded street address if it has one, else the centre of the community it names. */
export async function locate(text) {
    const p = extractPlace(text);
    if (p.address && (p.place || p.zip)) {
        const q = [p.address, p.place, 'TX', p.zip].filter(Boolean).join(', ');
        const hit = await geocode.geocode(q);
        if (hit && inRegion(hit.lat, hit.lon)) {
            return { lat: hit.lat, lon: hit.lon, location_approximate: false, place: hit.matched || q };
        }
    }
    if (p.placeLatLon) {
        return { lat: p.placeLatLon[0], lon: p.placeLatLon[1], location_approximate: true, place: p.place };
    }
    return { lat: null, lon: null, location_approximate: false, place: p.address };
}

const SCANNER_APP_RE = /crime\s*radar|towntalk|scanner|pulsepoint|citizen|dispatch|911/i;
const SMS_APP_RE = /messag|\bsms\b|\bmms\b|textra|com\.google\.android\.apps\.messaging|com\.samsung\.android\.messaging/i;

/** "scanner" (AI scanner summaries), "sms" (texts from a chosen sender) or "post" (anything else). */
export function kindOf(item) {
    const who = `${item.app || ''} ${item.package || ''}`;
    if (SCANNER_APP_RE.test(who)) return 'scanner';
    if (SMS_APP_RE.test(who)) return 'sms';
    return 'post';
}

const PROTECTIVE_RE = /shelter[\s-]*in[\s-]*place|\bevacuat|\bboil[\s-]*water/i;
const HAZMAT_RE = /haz[\s-]*mat|hazardous material|chemical|gas leak|leak(?:ing)? gas|ammonia|chlorine|benzene|toxic|vapou?r cloud|\bodou?r\b|pipeline|tanker|explosion|explosive|\bexplod/i;
const BIG_FIRE_RE = /(?:plant|refinery|industrial|tank|commercial|apartment|multi[\s-]*alarm|2nd[\s-]*alarm|3rd[\s-]*alarm|second[\s-]*alarm|third[\s-]*alarm|working) fire|fire at (?:the )?(?:plant|refinery)|large fire|major fire|heavy smoke/i;
const FIRE_RE = /\bfire\b|smoke|\bburn/i;
const CRASH_RE = /crash|collision|accident|wreck|rollover|vehicle vs|mvc|major accident/i;
const CRIME_RE = /shoot|shots? fired|gunfire|stabb|robbery|burglar|assault|pursuit|chase|barricade|swat|homicide|police activity/i;
const MEDICAL_RE = /medical|cardiac|unresponsive|overdose|injur/i;
const WATER_RE = /high water|flood|water rescue/i;

export function category(text) {
    const t = text || '';
    if (PROTECTIVE_RE.test(t)) return 'protective';
    if (HAZMAT_RE.test(t)) return 'hazmat';
    if (BIG_FIRE_RE.test(t)) return 'major_fire';
    if (WATER_RE.test(t)) return 'flooding';
    if (FIRE_RE.test(t)) return 'fire';
    if (CRASH_RE.test(t)) return 'crash';
    if (CRIME_RE.test(t)) return 'crime';
    if (MEDICAL_RE.test(t)) return 'medical';
    return 'other';
}

/**
 * Level for the verdict. Scanner reports: advisory at most (serious + within
 * 8 km). Texts/posts: shelter/evacuate -> warning (unless clearly far away);
 * serious + within 8 km -> advisory. Everything else is shown for awareness.
 */
export function classify(kind, cat, distanceKmFromHome) {
    const near = distanceKmFromHome != null && distanceKmFromHome <= 8;
    const serious = cat === 'protective' || cat === 'hazmat' || cat === 'major_fire';
    if (kind !== 'scanner' && cat === 'protective' && (distanceKmFromHome == null || distanceKmFromHome <= 16)) return 'warning';
    if (serious && near) return 'advisory';
    return 'info';
}

/** Ingest hook: work out where a new community report is (one geocode per report, stored with it). */
export async function enrich(item) {
    if (relay.channelOf(item) !== 'community') return {};
    return locate(`${item.title} ${item.text}`);
}

export async function fetchReports(homeLat, homeLon, now = Date.now()) {
    if (!store) throw new Error('Phone relay not set up (needs the STATE KV namespace)');
    const r = await relay.recent(store, now, { channel: 'community' });
    const items = r.items
        .filter((i) => now - i.received_at <= SHOW_HOURS * 3600_000)
        .map((i) => {
            const kind = kindOf(i);
            const text = clean(`${i.title} ${i.text}`);
            const cat = category(text);
            const located = i.lat != null && i.lon != null;
            const dist = located ? round1(distanceKm(homeLat, homeLon, i.lat, i.lon)) : null;
            return {
                id: `cr-${i.id}`,
                kind,
                unconfirmed: kind === 'scanner',
                app: i.app,
                title: i.title || null,
                text: i.text || null,
                category: cat,
                level: classify(kind, cat, dist),
                reported_at: toLocalIso(i.received_at),
                lat: located ? i.lat : null,
                lon: located ? i.lon : null,
                location_approximate: Boolean(i.location_approximate),
                place: i.place ?? null,
                distance_km: dist,
                bearing_from_home: located ? compass(bearingDeg(homeLat, homeLon, i.lat, i.lon)) : null,
            };
        });
    const ORDER = { warning: 0, advisory: 1, info: 2 };
    items.sort((a, b) => ORDER[a.level] - ORDER[b.level] || (b.reported_at > a.reported_at ? 1 : -1));
    items.meta = {
        last_seen_at: r.last_seen_at == null ? null : toLocalIso(r.last_seen_at),
        stale: r.stale,
        apps: [...new Set(r.items.map((i) => i.app).filter(Boolean))],
    };
    return items;
}

/** For tests. */
export function _reset() { store = null; }
