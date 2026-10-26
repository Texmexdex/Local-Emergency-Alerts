import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as assess from '../src/assess.js';
import * as caer from '../src/caer.js';
import * as geo from '../src/geo.js';
import { BLIND_RUNS_BEFORE_WARNING, planNotifications } from '../src/monitor.js';
import * as nws from '../src/nws.js';
import { HOME, NOW, fixture, mockFetch } from './helpers.js';

const nwsFeature = (event, severity = 'Severe', status = 'Actual') => ({
    id: `urn:${event}`,
    properties: {
        id: `urn:${event}`, event, headline: `${event} issued`, severity, urgency: 'Immediate', status,
        description: 'desc', instruction: 'Do this.',
        effective: '2026-10-26T13:00:00-05:00', expires: '2026-10-26T15:00:00-05:00',
    },
});
const ok = (data) => ({ ok: true, data, error: null, ms: 1 });
const weather = (fromDeg, kmh = 15) => ({ wind_from_deg: fromDeg, wind_kmh: kmh, place: 'Channelview, TX' });

async function caerPostings() {
    mockFetch({ 'incident-reporter.net': () => fixture('caer_feed.html') });
    return caer.fetchPostings(...HOME, NOW);
}

test('NWS levels', () => {
    const lvl = (event, severity) => nws.alertLevel({ event, severity });
    assert.equal(lvl('Shelter In Place Warning', 'Unknown'), 'action');
    assert.equal(lvl('Hazardous Materials Warning', 'Severe'), 'action');
    assert.equal(lvl('Tornado Warning', 'Extreme'), 'action');
    assert.equal(lvl('Flash Flood Warning', 'Extreme'), 'action');
    assert.equal(lvl('Severe Thunderstorm Warning', 'Severe'), 'warning');
    assert.equal(lvl('Flood Watch', 'Moderate'), 'advisory');
    assert.equal(lvl('Heat Advisory', 'Minor'), 'advisory');
    assert.equal(lvl('Special Weather Statement', 'Minor'), 'info');
});

test('NWS fetch drops test messages and sends User-Agent', async () => {
    let ua;
    mockFetch({
        'api.weather.gov/alerts': (url, init) => {
            ua = init.headers['User-Agent'];
            return { features: [nwsFeature('Flood Watch', 'Moderate'), nwsFeature('Tornado Warning', 'Extreme'), nwsFeature('Civil Emergency Message', 'Severe', 'Test')] };
        },
    });
    const alerts = await nws.fetchAlerts(...HOME);
    assert.deepEqual(alerts.map((a) => a.event), ['Tornado Warning', 'Flood Watch']);
    assert.match(ua, /LocalEmergencyAlerts/);
});

test('weather uses the nearest station with a fresh reading', async () => {
    const obsAt = new Date(NOW - 20 * 60_000).toISOString();
    mockFetch({
        '/points/': { properties: { observationStations: 'https://api.weather.gov/gridpoints/HGX/1,1/stations', forecastHourly: 'x', relativeLocation: { properties: { city: 'Channelview', state: 'TX' } } } },
        '/stations/KSTALE/': { properties: { timestamp: '2026-10-25T00:00:00Z', windSpeed: { value: 10 }, windDirection: { value: 90 } } },
        '/stations/KHPY/': { properties: { timestamp: obsAt, windSpeed: { value: 16.09 }, windDirection: { value: 180 }, temperature: { value: 25 }, relativeHumidity: { value: 70.4 }, textDescription: 'Cloudy' } },
        '/stations': { features: [
            { properties: { stationIdentifier: 'KSTALE', name: 'Stale' }, geometry: { coordinates: [-95.1, 29.8] } },
            { properties: { stationIdentifier: 'KHPY', name: 'Baytown' }, geometry: { coordinates: [-94.95, 29.78] } },
        ] },
    });
    const w = await nws.fetchWeather(...HOME, NOW);
    assert.deepEqual([w.station, w.wind_from, w.wind_mph, w.temp_f, w.humidity, w.place], ['KHPY', 'S', 10, 77, 70, 'Channelview, TX']);
});

test('downwind geometry', () => {
    const src = [29.70, -95.11]; // south of home
    assert.equal(geo.downwindExposure(...src, ...HOME, 180, 15), 'downwind');
    assert.equal(geo.downwindExposure(...src, ...HOME, 0, 15), null);
    assert.equal(geo.downwindExposure(...src, ...HOME, 0, 2), null); // calm but 8 km away
    assert.equal(geo.downwindExposure(29.79, -95.11, ...HOME, 0, 2), 'calm-nearby');
    assert.equal(geo.compass(359), 'N');
    assert.equal(geo.compass(200), 'SSW');
});

test('clear when nothing relevant', () => {
    const r = assess.build(...HOME, { nws_alerts: ok([]), weather: ok(weather(180)), caer: ok([]), houston_fire: ok([]) }, { radiusKm: 16, now: NOW });
    assert.equal(r.level, 'clear');
    assert.equal(r.complete, true);
    assert.equal(r.headline, 'No active emergencies found near you');
});

test('a failed source is never reported as all clear', () => {
    const r = assess.build(...HOME, {
        nws_alerts: ok([]), weather: ok(weather(180)), caer: ok([]),
        houston_fire: { ok: false, data: null, error: 'Timeout', ms: 1 },
    }, { now: NOW });
    assert.equal(r.complete, false);
    assert.deepEqual(r.failed_sources, ['City of Houston Fire/EMS active incidents']);
    assert.match(r.headline, /sources that responded/);
});

test('industrial incidents drive the level; routine ones do not', async () => {
    const r = assess.build(...HOME, { nws_alerts: ok([]), weather: ok(weather(270)), caer: ok(await caerPostings()), houston_fire: ok([]) }, { radiusKm: 16, now: NOW });
    assert.equal(r.level, 'action');
    const titles = r.reasons.map((x) => x.title);
    assert.equal(titles[0], 'Example Chemical Baytown: shelter/evacuate message');
    assert.ok(titles.includes('LyondellBasell - Channelview: incident reported'));
    assert.ok(!titles.some((t) => /PEMEX|Kuraray|Old Plant/.test(t)));
});

test('downwind escalates and is explained', async () => {
    const lyb = (await caerPostings()).filter((p) => p.facility.startsWith('Lyondell'));
    lyb.forEach((p) => { p.level = 'advisory'; });
    // LyondellBasell is north of home; a north wind carries air south to us.
    const r = assess.build(...HOME, { nws_alerts: ok([]), weather: ok(weather(0)), caer: ok(lyb), houston_fire: ok([]) }, { now: NOW });
    assert.equal(r.level, 'warning');
    assert.deepEqual(r.downwind_of, ['LyondellBasell - Channelview']);
    assert.match(r.reasons[0].note, /blowing from this facility toward you/);
});

test('out-of-radius postings are ignored unless downwind', async () => {
    const far = (await caerPostings()).filter((p) => p.facility.startsWith('Lyondell'));
    const results = { nws_alerts: ok([]), weather: ok(weather(180)), caer: ok(far), houston_fire: ok([]) };
    assert.equal(assess.build(...HOME, results, { radiusKm: 3, now: NOW }).level, 'clear');
    results.weather = ok(weather(0));
    assert.equal(assess.build(...HOME, results, { radiusKm: 3, now: NOW }).level, 'warning');
});

test('NWS alert becomes a reason with instructions', () => {
    const alerts = [nws.normalizeAlert(nwsFeature('Shelter In Place Warning', 'Unknown'))];
    const r = assess.build(...HOME, { nws_alerts: ok(alerts), weather: ok(null), caer: ok([]), houston_fire: ok([]) }, { now: NOW });
    assert.equal(r.level, 'action');
    assert.equal(r.reasons[0].instruction, 'Do this.');
});

test('gather isolates failing sources', async () => {
    const r = await assess.gather(...HOME, {
        a: ['A', async () => [1]],
        b: ['B', async () => { throw new Error('boom'); }],
    });
    assert.deepEqual(r.a.data, [1]);
    assert.equal(r.b.ok, false);
    assert.match(r.b.error, /boom/);
});

test('monitor sends once, then on escalation, then one all clear', () => {
    const base = { location: { label: 'Home' }, complete: true };
    const reason = { id: 'x1', level: 'advisory', title: 'Thing', detail: 'd', distance_mi: 2.0, direction: 'N' };
    let state = { seen: {}, last_level: 'clear' };
    const step = (result, at = NOW) => {
        const out = planNotifications({ ...base, ...result }, state, 'warning', at);
        state = out.state;
        return out.messages.map((m) => m.title);
    };
    assert.deepEqual(step({ level: 'advisory', reasons: [reason] }), []); // below threshold
    assert.deepEqual(step({ level: 'warning', reasons: [{ ...reason, level: 'warning' }] }), ['WARNING: Thing']);
    assert.deepEqual(step({ level: 'warning', reasons: [{ ...reason, level: 'warning' }] }), []); // no repeats
    assert.deepEqual(step({ level: 'clear', complete: false, reasons: [] }), []); // unverified clear: wait
    assert.deepEqual(step({ level: 'clear', reasons: [] }), ['All clear']);
    assert.deepEqual(step({ level: 'clear', reasons: [] }, NOW + 600_000), []);
});

test('monitor state only changes when something happens', () => {
    const result = { location: { label: 'Home' }, complete: true, level: 'warning', reasons: [{ id: 'x', level: 'warning', title: 'T' }], sources: {} };
    const a = planNotifications(result, { seen: {}, last_level: 'clear' }, 'warning', NOW).state;
    const b = planNotifications(result, a, 'warning', NOW + 120_000).state;
    assert.equal(JSON.stringify(a), JSON.stringify(b)); // => no KV write on a quiet run
});

test('monitor warns once when feeds stay down', () => {
    const down = { ok: false };
    const result = { location: { label: 'Home' }, complete: false, level: 'clear', reasons: [],
        sources: { nws_alerts: down, caer: down, weather: down, houston_fire: down } };
    let state = { seen: {}, last_level: 'clear' };
    const sent = [];
    for (let i = 0; i < BLIND_RUNS_BEFORE_WARNING + 10; i++) {
        const out = planNotifications(result, state, 'warning', NOW);
        state = out.state;
        sent.push(...out.messages.map((m) => m.title));
    }
    assert.deepEqual(sent, ["Monitor can't reach emergency feeds"]);
    assert.equal(state.blind_runs, BLIND_RUNS_BEFORE_WARNING + 1); // capped, so KV stops changing
    result.sources.nws_alerts = { ok: true };
    assert.equal(planNotifications(result, state, 'warning', NOW).state.blind_runs, 0);
});
