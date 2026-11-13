import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as assess from '../src/assess.js';
import * as houston from '../src/houston.js';
import * as transtar from '../src/transtar.js';
import { HOME, KEYMAP, fixture, mockFetch } from './helpers.js';

// 1:40 PM Houston time (CST, UTC-6) on Nov 13, 2026.
const NOV13 = Date.parse('2026-11-13T13:40:00-06:00');

test('parses the TranStar layer, with or without a JS wrapper', () => {
    const json = fixture('transtar_incidents.js');
    assert.equal(transtar.parseFeed(json).length, 4);
    assert.equal(transtar.parseFeed(`var incidents = ${json};`).length, 4);
    assert.throws(() => transtar.parseFeed('<html>maintenance</html>'), /not recognised/);
});

test('TranStar times: today, yesterday and dates, in Houston time', () => {
    const iso = (t, d) => new Date(transtar.eventTime(t, d, NOV13)).toISOString();
    assert.equal(iso('1:31 PM', 'today'), '2026-11-13T19:31:00.000Z');
    assert.equal(iso('11:58 PM', 'yesterday'), '2026-11-13T05:58:00.000Z');
    assert.equal(iso('8:05 AM', '11/12/2026'), '2026-11-12T14:05:00.000Z');
    assert.equal(transtar.eventTime('', 'today', NOV13), null);
});

test('TranStar incidents: located, classified, only hazmat near home counts', async () => {
    mockFetch({ 'houstontranstar.org': () => fixture('transtar_incidents.js') });
    const list = await transtar.fetchIncidents(...HOME, NOV13);
    const byId = Object.fromEntries(list.map((i) => [i.id, i]));
    const spill = byId['tt-1866900'];
    assert.deepEqual([spill.level, spill.kind], ['warning', 'hazmat']);
    assert.ok(spill.distance_km < 3);
    assert.equal(byId['tt-1866769'].kind, 'accident');
    assert.equal(byId['tt-1866769'].level, 'info');
    assert.equal(byId['tt-1866769'].vehicles, 3);
    assert.deepEqual(transtar.classify('Road Hazard', 1), ['info', 'hazard'], 'a road hazard is not hazmat');
    assert.deepEqual(transtar.classify('Vehicle Fire', 1), ['info', 'fire']);
    assert.equal(byId['tt-1866901'].lat, null, '0,0 coordinates are treated as missing');
    assert.equal(list[0].id, 'tt-1866900', 'verdict-relevant incidents first');
});

test('Houston police calls: located by address or Key Map, crashes are info, hazmat near home warns', async () => {
    mockFetch({ 'cohweb.houstontx.gov': () => fixture('hpd_police.html') });
    const list = await houston.fetchPolice(...HOME, NOV13);
    assert.equal(list.length, 4);
    const byType = Object.fromEntries(list.map((i) => [i.type, i]));
    assert.equal(byType['CRASH/MINOR/FSGI'].kind, 'crash');
    assert.equal(byType['CRASH/MINOR/FSGI'].level, 'info');
    assert.equal(byType['TRAFFIC HAZARD/URGENT'].kind, 'hazard');
    const hazmat = byType['HAZMAT INVESTIGATION'];
    assert.deepEqual([hazmat.level, hazmat.location_source], ['warning', 'keymap']);
    assert.ok(Math.abs(hazmat.lat - KEYMAP['458U'][0]) < 1e-9);
    assert.ok(hazmat.id.startsWith('hpd-'));
});

test('police and traffic feed the verdict but never mark it incomplete', () => {
    const ok = (data) => ({ ok: true, data, error: null, ms: 1 });
    const down = { ok: false, data: null, error: 'Timeout', ms: 1 };
    const results = { nws_alerts: ok([]), weather: ok(null), caer: ok([]), houston_fire: ok([]), police: down, traffic: down };
    const r = assess.build(...HOME, results, { now: NOV13 });
    assert.equal(r.level, 'clear');
    assert.equal(r.complete, true, 'supplementary sources being down does not hedge the answer');
    assert.equal(r.sources.traffic.ok, false);
    assert.equal(r.sources.traffic.core, false);
    assert.equal(r.sources.nws_alerts.core, true);

    const spill = { id: 'tt-1', level: 'warning', kind: 'hazmat', type: 'Hazardous Materials Spill', location: 'SH-146',
        lanes: 'All Lanes', reported_at: null, distance_km: 2, bearing_from_home: 'E', url: 'x', lat: 29.8, lon: -95 };
    const r2 = assess.build(...HOME, { ...results, traffic: ok([spill]) }, { now: NOV13 });
    assert.equal(r2.level, 'warning');
    assert.equal(r2.reasons[0].source, 'TranStar');
    assert.deepEqual(r2.traffic, [spill]);
});
