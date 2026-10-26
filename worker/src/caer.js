// CAER / EHCMA community notifications from Houston-area industrial facilities.
//
// Source: https://www.incident-reporter.net/e-notifycaerfeed/caermessagelive.html
//
// The page lists one <h5> heading per facility posting:
//
//     <h5>PEMEX Deer Park, Posted On - 8/13/2026 7:21:00 AM</h5>
//     Posted On - 8/13/2026 7:21:00 AM - Update 7<br>
//     This is an update from PEMEX Deer Park. ...<br><br>
//
// followed by one "Posted On - <time> - <label>" entry per update (newest
// first). Most postings are routine: planned flaring, weekly alarm tests,
// drills and all-clears. The classifier below is deliberately strict so those
// do not raise an alarm, while real releases, fires, odours and protective
// actions (shelter in place / evacuate) do.
import { bearingDeg, compass, distanceKm, round1 } from './geo.js';
import * as geocode from './geocode.js';
import { TTLCache, clean, getText, htmlToText, localToEpoch, toLocalIso } from './http.js';

export const FEED_URL = 'https://www.incident-reporter.net/e-notifycaerfeed/caermessagelive.html';
export const cache = new TTLCache(60_000);
const facilityAddresses = new Map(); // facility name -> last address seen in its messages
// Subrequest budget: at most this many new single-address lookups per invocation.
const MAX_NEW_GEOCODES = 15;

const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?$/i;
const POSTED_RE = /^Posted On\s*-\s*(?<dt>\d{1,2}\/\d{1,2}\/\d{4}[^-]*?)\s*(?:-\s*(?<rest>.*))?$/i;
const LABEL_RE = /^(?<label>Initial Report|Initial|Update(?:\s*#?\s*\d+)?|All Clear|Final Report|Final|Clear|Report)\b[\s:.-]*(?<text>.*)$/i;
// e.g. "located at 12342 Strang Rd. La Porte,TX 77571-0347" (abbreviations contain periods)
const ADDRESS_RE = /located (?:at|on) (?<addr>\d[^;]{3,90}?,?\s*TX,?\s*\d{5})(?:-\d{4})?\b/i;

const DRILL_RE = /\bdrill\b|\bexercise\b|\btraining\b|weekly alarm|alarm test|siren test|test(?:ing)? (?:of )?(?:the |our )?(?:alarm|siren)|test alarm/i;
const NOT_DRILL_RE = /\bthis is not a drill\b/i;
const CLEAR_RE = /\ball[ -]?clear\b|\b(?:has|have) (?:been )?(?:ended|concluded|lifted|secured)\b|\bconcluded\b/i;
const PROTECTIVE_RE = /shelter[- ]in[- ]place|\bevacuat\w*|stay indoors|remain indoors|close (?:all |your )?(?:doors|windows)|turn off (?:your )?(?:air|a\/c|ac|hvac|ventilation)/i;
const PROTECTIVE_NEGATED_RE = /\b(?:no|not|lifted|lift|lifting|ended|cancel\w*|without)\b[^.]{0,40}(?:shelter|evacuat)|(?:shelter[- ]in[- ]place|evacuation\w*)[^.]{0,30}\b(?:lifted|ended|cancel\w*|no longer)\b/i;
const SEVERE_RE = /\b(?:releas\w*|leak\w*|fire|fires|explosion|exploded|odou?rs?|smoke|vapou?rs?|chemical|spill\w*|plume|haze|injur\w*|hazard\w*|roads? (?:closure|closed|blocked)|closed? (?:the )?road)\b/i;
const INCIDENT_RE = /\bincident\b|\bemergency\b|\bupset\b|\bunplanned\b|\bunexpected\b/i;
const PLANNED_RE = /\bflar\w*|\bsteam\b|\bnoise\b|\bplanned\b|maintenance|start-?up|shut-?down|turnaround|courtesy/i;
const REASSURE_RE = new RegExp([
    'no (?:off-?site|community) (?:impact|threat|danger|risk)',
    'do(?:es)? not (?:anticipate|expect) any (?:impact|threat|danger|risk)',
    'not (?:expected|anticipated) to (?:impact|affect|pose|leave)',
    'no (?:threat|danger|risk|impact) (?:to|on) (?:the )?(?:public|community|neighbors)',
    'no action is required|contained (?:on-?site|within)|remain(?:s|ed)? on-?site',
].join('|'), 'i');

const ORDER = { action: 0, warning: 1, advisory: 2, info: 3 };

/** "10/26/2026 7:21:00 AM" (Houston local) -> epoch ms, or null. */
export function parseLocalTime(text) {
    const m = DATE_RE.exec(clean(text));
    if (!m) return null;
    let hour = Number(m[4]);
    const ampm = m[7]?.toUpperCase();
    if (ampm === 'PM' && hour < 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    return localToEpoch(Number(m[3]), Number(m[1]), Number(m[2]), hour, Number(m[5]), Number(m[6] || 0));
}

/** Parse the CAER page into postings (one per facility heading). */
export function parseFeed(html) {
    const src = (html || '').replace(/<\s*\/?\s*br\s*\/?\s*>/gi, '\n');
    const headings = [...src.matchAll(/<h5\b[^>]*>([\s\S]*?)<\/h5\s*>/gi)];
    const postings = [];
    headings.forEach((h, i) => {
        const heading = clean(htmlToText(h[1]));
        const idx = heading.indexOf('Posted On - ');
        const facility = (idx >= 0 ? heading.slice(0, idx) : heading).replace(/^[ ,]+|[ ,]+$/g, '');
        const headingTime = idx >= 0 ? heading.slice(idx + 'Posted On - '.length) : '';
        if (!facility) return;
        const end = i + 1 < headings.length ? headings[i + 1].index : src.length;
        const block = htmlToText(src.slice(h.index + h[0].length, end));
        const fallback = parseLocalTime(headingTime);
        const entries = [];
        for (const raw of block.split('\n')) {
            const line = clean(raw);
            if (!line) continue;
            const m = POSTED_RE.exec(line);
            if (m) {
                let label = '', text = m.groups.rest || '';
                const lm = LABEL_RE.exec(text);
                if (lm) { label = lm.groups.label; text = lm.groups.text; }
                entries.push({ posted: parseLocalTime(m.groups.dt), label: clean(label), text: clean(text) });
            } else if (entries.length) {
                const last = entries[entries.length - 1];
                last.text = clean(`${last.text} ${line}`);
            } else {
                entries.push({ posted: fallback, label: '', text: line });
            }
        }
        const kept = entries.filter((e) => e.text);
        if (!kept.length) return;
        for (const e of kept) e.posted ??= fallback;
        kept.sort((a, b) => (b.posted ?? -Infinity) - (a.posted ?? -Infinity));
        postings.push({ facility, entries: kept });
    });
    return postings;
}

/** Return [level, kind]. level is action/warning/advisory/info. */
export function classify(text, label = '') {
    const t = text || '';
    if (DRILL_RE.test(t) && !NOT_DRILL_RE.test(t)) return ['info', 'drill'];
    if ((label || '').toLowerCase().includes('clear') || CLEAR_RE.test(t)) return ['info', 'all_clear'];
    if (PROTECTIVE_RE.test(t) && !PROTECTIVE_NEGATED_RE.test(t)) return ['action', 'protective_action'];
    const reassured = REASSURE_RE.test(t);
    const severe = SEVERE_RE.test(t);
    if (severe && !reassured && !PLANNED_RE.test(t)) return ['warning', 'incident'];
    if ((severe || INCIDENT_RE.test(t)) && !reassured) return ['advisory', 'incident'];
    return ['info', 'notice'];
}

function rememberAddress(facility, entries) {
    for (const e of entries) {
        const m = ADDRESS_RE.exec(e.text);
        if (m) { facilityAddresses.set(facility, m.groups.addr); return; }
    }
}

async function sha1Hex(s) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Build a normalized posting. Location must already be resolved via resolveLocations(). */
export async function buildPosting(raw, homeLat, homeLon, now) {
    const { facility, entries } = raw;
    const latest = entries[0];
    const [level, kind] = classify(latest.text, latest.label);
    const first = entries[entries.length - 1].posted;
    const pid = (await sha1Hex(`${facility}|${first != null ? toLocalIso(first) : ''}`)).slice(0, 16);
    const address = facilityAddresses.get(facility) ?? null;
    const loc = (address && geocode.cached(address)) || geocode.knownSite(facility);
    const ageH = latest.posted == null ? null : (now - latest.posted) / 3600_000;
    const item = {
        id: `caer-${pid}`,
        facility,
        label: latest.label || 'Notice',
        text: latest.text,
        posted_at: latest.posted == null ? null : toLocalIso(latest.posted),
        age_hours: ageH == null ? null : round1(ageH),
        level,
        kind,
        address,
        lat: loc ? loc.lat : null,
        lon: loc ? loc.lon : null,
        location_approximate: Boolean(loc && loc.approximate),
        distance_km: null,
        bearing_from_home: null,
        updates: entries.slice(1).map((e) => ({
            posted_at: e.posted == null ? null : toLocalIso(e.posted), label: e.label, text: e.text,
        })),
        url: FEED_URL,
    };
    if (loc) {
        item.distance_km = round1(distanceKm(homeLat, homeLon, loc.lat, loc.lon));
        item.bearing_from_home = compass(bearingDeg(homeLat, homeLon, loc.lat, loc.lon));
    }
    return item;
}

/** Geocode facility addresses not seen before (bounded per invocation). */
async function resolveLocations(raw) {
    for (const r of raw) rememberAddress(r.facility, r.entries);
    const todo = [...new Set(raw.map((r) => facilityAddresses.get(r.facility)).filter(Boolean))]
        .filter((a) => geocode.cached(a) === undefined)
        .slice(0, MAX_NEW_GEOCODES);
    await Promise.all(todo.map((a) => geocode.geocode(a, { persist: true })));
}

export async function fetchPostings(homeLat, homeLon, now = Date.now()) {
    const raw = await cache.getOrFetch('feed', async () => parseFeed(await getText(FEED_URL)));
    await resolveLocations(raw);
    const postings = await Promise.all(raw.map((r) => buildPosting(r, homeLat, homeLon, now)));
    postings.sort((a, b) => ORDER[a.level] - ORDER[b.level] || (a.age_hours ?? 1e9) - (b.age_hours ?? 1e9));
    return postings;
}

export function isCurrent(posting, maxAgeHours = 24) {
    return posting.age_hours != null && posting.age_hours <= maxAgeHours;
}

/** For tests. */
export function _reset() {
    cache.clear();
    facilityAddresses.clear();
}
