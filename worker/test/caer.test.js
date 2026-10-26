import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as caer from '../src/caer.js';
import { HOME, NOW, fixture, mockFetch } from './helpers.js';

async function postings() {
    mockFetch({ 'incident-reporter.net': () => fixture('caer_feed.html') });
    const list = await caer.fetchPostings(...HOME, NOW);
    return Object.fromEntries(list.map((p) => [`${p.facility}|${p.label}`, p]));
}

test('parses every heading with real posted times', () => {
    const raw = caer.parseFeed(fixture('caer_feed.html'));
    assert.equal(raw.length, 7);
    const pemex = raw[0];
    assert.equal(pemex.facility, 'PEMEX Deer Park');
    assert.deepEqual(pemex.entries.map((e) => e.label), ['Update 7', 'Update 6']);
    assert.equal(new Date(pemex.entries[0].posted).toISOString(), '2026-10-26T12:21:00.000Z'); // 7:21 AM CDT
    assert.ok(pemex.entries[0].text.startsWith('This is an update from PEMEX Deer Park.'));
});

test('routine messages do not raise alarm', async () => {
    const p = await postings();
    assert.equal(p['PEMEX Deer Park|Update 7'].level, 'info'); // planned flaring, "smoke", no impact
    assert.equal(p['Kuraray America La Porte|Initial Report'].kind, 'drill'); // contains "emergency"
    assert.equal(p['Kuraray America La Porte|Initial Report'].level, 'info');
    assert.equal(p['Sekisui Specialty Chemicals|All Clear'].kind, 'all_clear'); // contains "incident"
    assert.equal(p['Sekisui Specialty Chemicals|Initial Report'].level, 'info'); // "no off-site impact"
});

test('real incidents are flagged', async () => {
    const p = await postings();
    const lyb = p['LyondellBasell - Channelview|Initial Report'];
    assert.deepEqual([lyb.level, lyb.kind], ['warning', 'incident']);
    const sip = p['Example Chemical Baytown|Update 1'];
    assert.deepEqual([sip.level, sip.kind], ['action', 'protective_action']);
});

test('locations come from the message address', async () => {
    const p = await postings();
    const lyb = p['LyondellBasell - Channelview|Initial Report'];
    assert.equal(lyb.address, '8280 Sheldon Rd Channelview,TX 77530');
    assert.deepEqual([lyb.lat, lyb.lon], [29.8325, -95.1170]);
    assert.equal(lyb.location_approximate, false);
    assert.ok(lyb.distance_km > 6 && lyb.distance_km < 7);
    assert.equal(lyb.bearing_from_home, 'N');
    assert.equal(lyb.posted_at, '2026-10-26T13:05:00-05:00');
    // Address with periods in it ("Strang Rd.") still extracted.
    assert.equal(p['Kuraray America La Porte|Initial Report'].lat, 29.6960);
});

test('known-site fallback is marked approximate', async () => {
    const pemex = (await postings())['PEMEX Deer Park|Update 7'];
    assert.equal(pemex.address, null);
    assert.equal(pemex.location_approximate, true);
    assert.notEqual(pemex.lat, null);
});

test('age and currency', async () => {
    const p = await postings();
    const old = p['Old Plant Pasadena|Initial Report'];
    assert.ok(old.age_hours > 24);
    assert.equal(caer.isCurrent(old), false);
    assert.equal(caer.isCurrent(p['LyondellBasell - Channelview|Initial Report']), true);
});

test('ids are stable across fetches', async () => {
    const a = await postings();
    const b = await postings();
    assert.equal(a['PEMEX Deer Park|Update 7'].id, b['PEMEX Deer Park|Update 7'].id);
});

test('classifier cases', () => {
    const c = caer.classify;
    assert.equal(c('Residents should shelter in place immediately.')[0], 'action');
    assert.equal(c('Shelter in place has been lifted for the area.')[1], 'all_clear');
    assert.notEqual(c('There is no shelter in place in effect. A small leak was contained.')[0], 'action');
    assert.equal(c('Evacuate the area south of Hwy 225.')[0], 'action');
    assert.equal(c('A small fire broke out in a process unit. Smoke may be visible.')[0], 'warning');
    assert.equal(c('We are flaring due to a unit upset. Smoke may be visible.')[0], 'advisory');
    assert.equal(c('Weekly alarm test at noon.')[1], 'drill');
    assert.equal(c('THIS IS NOT A DRILL. Shelter in place now.')[0], 'action');
    assert.equal(c('Steam venting may be heard by nearby neighbors.')[0], 'info');
});

test('geocodes each new facility address once', async () => {
    const { calls } = await import('./helpers.js');
    await postings();
    const first = calls.filter((c) => c.url.includes('onelineaddress')).length;
    assert.equal(first, 4);
    caer.cache.clear();
    await postings();
    assert.equal(calls.filter((c) => c.url.includes('onelineaddress')).length, first);
});
