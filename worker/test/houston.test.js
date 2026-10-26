import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as houston from '../src/houston.js';
import { NOW, calls, fixture, mockFetch } from './helpers.js';

const FIRST_ROW = {
    agency: 'FD', address: '1000 MAIN ST', cross_street: 'LAMAR ST', key_map: '493P',
    call_time: '10/26/2026 13:02', type: 'HAZMAT - GAS LEAK', combined: 'N',
};

test('parse table maps headers and skips disclaimer', () => {
    const rows = houston.parseTable(fixture('houston.html'));
    assert.equal(rows.length, 5);
    assert.deepEqual(rows[0], FIRST_ROW);
});

test('parse table survives layout tables, header links and entities', () => {
    const rows = houston.parseTable(fixture('houston_nested.html'));
    assert.equal(rows.length, 5);
    assert.deepEqual(rows[0], FIRST_ROW);
    assert.equal(rows[1].address, '2000 SMITH ST');
});

test('fetch incidents geocodes in one batch and classifies', async () => {
    mockFetch({ 'cohweb.houstontx.gov': () => fixture('houston.html') });
    const downtown = [29.7604, -95.3698];
    const incidents = await houston.fetchIncidents(...downtown, NOW);
    const byType = Object.fromEntries(incidents.map((i) => [i.type, i]));

    assert.equal(byType['MAJOR ACCIDENT'], undefined); // police calls dropped
    const hazmat = byType['HAZMAT - GAS LEAK'];
    assert.deepEqual([hazmat.level, hazmat.kind], ['warning', 'hazmat']);
    assert.ok(hazmat.distance_km < 2);
    assert.equal(hazmat.called_at, '2026-10-26T13:02:00-05:00');
    assert.equal(byType['STRUCTURE FIRE - RESIDENTIAL'].level, 'advisory');
    assert.equal(byType['FIRE ALARM - COMMERCIAL'].level, 'info');
    const unknown = byType['CHECK PATIENT']; // ungeocodable: no fake coordinates
    assert.equal(unknown.lat, null);
    assert.equal(unknown.distance_km, null);
    assert.equal(calls.filter((c) => c.url.includes('addressbatch')).length, 1);

    houston.cache.clear();
    await houston.fetchIncidents(...downtown, NOW);
    assert.equal(calls.filter((c) => c.url.includes('addressbatch')).length, 1, 'cached addresses are not re-sent');
});

test('batch failure leaves incidents unmapped and is retried later', async () => {
    mockFetch({ 'cohweb.houstontx.gov': () => fixture('houston.html') });
    const ok = globalThis.fetch;
    globalThis.fetch = async (url, init) => (String(url).includes('addressbatch') ? new Response('busy', { status: 503 }) : ok(url, init));
    const first = await houston.fetchIncidents(29.76, -95.37, NOW);
    assert.ok(first.every((i) => i.lat === null));
    globalThis.fetch = ok;
    houston.cache.clear();
    const second = await houston.fetchIncidents(29.76, -95.37, NOW);
    assert.ok(second.some((i) => i.lat !== null));
});

test('far incidents do not count', () => {
    assert.equal(houston.classify({ type: 'HAZMAT', address: 'x' }, 30)[0], 'info');
    assert.equal(houston.classify({ type: 'HAZMAT', address: 'x' }, null)[0], 'info');
    assert.equal(houston.classify({ type: 'STRUCTURE FIRE', alarm: '2' }, 6)[0], 'warning');
});

test('time-only call times roll back a day', () => {
    const iso = (t) => {
        const e = houston.parseCallTime(t, NOW);
        return e == null ? null : new Date(e).toISOString();
    };
    assert.equal(iso('13:02'), '2026-10-26T18:02:00.000Z');
    assert.equal(iso('23:50'), '2026-10-26T04:50:00.000Z'); // 11:50 PM on the 25th, CDT
    assert.equal(iso('1:15 PM'), '2026-10-26T18:15:00.000Z');
    assert.equal(iso('garbage'), null);
});

test('live-format calls without house numbers are placed by Key Map square', async () => {
    const { HOME, calls } = await import('./helpers.js');
    mockFetch({ 'cohweb.houstontx.gov': () => fixture('houston_live.html') });
    const incidents = await houston.fetchIncidents(...HOME, NOW);
    const byType = Object.fromEntries(incidents.map((i) => [i.type, i]));
    const hazmat = byType['HAZMAT - ODOR INVESTIGATION'];
    assert.equal(hazmat.location_source, 'keymap');
    assert.equal(hazmat.location_approximate, true);
    assert.ok(Math.abs(hazmat.lat - 29.77) < 1e-9 && Math.abs(hazmat.lon + 95.13) < 1e-9);
    assert.equal(hazmat.level, 'warning'); // ~1 mi away
    assert.equal(byType['HOUSE ON FIRE'].kind, 'fire');
    assert.equal(incidents.find((i) => i.address === 'KATY FWY IB').lat, null); // no Key Map code: unmapped, not guessed
    assert.equal(calls.filter((c) => c.url.includes('addressbatch')).length, 0, 'no street numbers, so no address geocoding');
    assert.equal(calls.filter((c) => c.url.includes('gis.hctx.net')).length, 1, 'one query for all squares');
    houston.cache.clear();
    await houston.fetchIncidents(...HOME, NOW);
    assert.equal(calls.filter((c) => c.url.includes('gis.hctx.net')).length, 1, 'squares are cached');
});

test('Key Map service failure leaves calls unmapped and retries later', async () => {
    const { HOME, calls } = await import('./helpers.js');
    mockFetch({
        'cohweb.houstontx.gov': () => fixture('houston_live.html'),
        'gis.hctx.net': () => ({ error: { code: 400, message: 'Invalid field: KEYREF' } }),
    });
    const first = await houston.fetchIncidents(...HOME, NOW);
    assert.ok(first.every((i) => i.lat === null));
    mockFetch({ 'cohweb.houstontx.gov': () => fixture('houston_live.html') });
    houston.cache.clear();
    const second = await houston.fetchIncidents(...HOME, NOW);
    assert.ok(second.some((i) => i.location_source === 'keymap'));
    assert.ok(calls.filter((c) => c.url.includes('gis.hctx.net')).length >= 2);
});
