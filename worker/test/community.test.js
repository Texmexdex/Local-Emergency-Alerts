import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as assess from '../src/assess.js';
import * as caer from '../src/caer.js';
import * as community from '../src/community.js';
import worker from '../src/index.js';
import * as relay from '../src/relay.js';
import { HOME, NOW, mockFetch } from './helpers.js';

class MemoryKV {
    constructor() { this.data = new Map(); this.puts = 0; }
    async get(key) { return this.data.get(key) ?? null; }
    async put(key, value) { this.puts++; this.data.set(key, value); }
}

const CR = { app: 'CrimeRadar', package: 'com.towntalk.crimeradar' };
const ingest = (kv, payload, at) => relay.ingest(kv, payload, at, { enrich: community.enrich });

test('notifications are routed by app: CAER app vs everything else', () => {
    assert.equal(relay.channelOf({ app: 'CAER Online', package: 'com.conduit.app_caer' }), 'caer');
    assert.equal(relay.channelOf({ app: 'CAER Relay' }), 'caer', 'the relay app\'s own test message');
    assert.equal(relay.channelOf({}), 'caer', 'older forwarders sent no app name');
    assert.equal(relay.channelOf(CR), 'community');
    assert.equal(relay.channelOf({ app: 'Messages', package: 'com.google.android.apps.messaging' }), 'community');
});

test('finds addresses and named communities in report text', () => {
    assert.deepEqual(community.extractPlace('Structure fire reported at 1500 San Jacinto St, Baytown'),
        { address: '1500 San Jacinto St', place: 'Baytown', placeLatLon: [29.7355, -94.9774], zip: null });
    const p = community.extractPlace('Chemical odor reported near Old River Winfree');
    assert.equal(p.place, 'Old River-Winfree');
    assert.equal(community.extractPlace('Shots fired in Houston').place, null, 'Houston alone is too vague to map');
    assert.equal(community.extractPlace('Crash on I-10 at exit 787').address, null);
});

test('categories and verdict rules: scanner reports never exceed advisory', () => {
    assert.equal(community.category('Hazmat spill on SH-146'), 'hazmat');
    assert.equal(community.category('Residents told to shelter in place'), 'protective');
    assert.equal(community.category('Working fire at an apartment complex'), 'major_fire');
    assert.equal(community.category('Two-vehicle crash with injuries'), 'crash');
    assert.equal(community.category('Shots fired near the park'), 'crime');
    assert.equal(community.classify('scanner', 'protective', 2), 'advisory');
    assert.equal(community.classify('scanner', 'hazmat', 2), 'advisory');
    assert.equal(community.classify('scanner', 'hazmat', 20), 'info');
    assert.equal(community.classify('scanner', 'hazmat', null), 'info', 'unlocated scanner reports stay informational');
    assert.equal(community.classify('scanner', 'crash', 1), 'info');
    assert.equal(community.classify('sms', 'protective', null), 'warning', 'official shelter-in-place text');
    assert.equal(community.classify('sms', 'protective', 40), 'info');
});

test('relay -> community reports: located once at ingest, shown 24 h, CAER panel unaffected', async () => {
    const kv = new MemoryKV();
    mockFetch({ 'incident-reporter.net': () => '<html><title>eNotify - Emergency Notification System</title></html>' });
    // A scanner report with an address, one with only a community, one far away, one too old.
    await ingest(kv, { ...CR, title: 'Hazmat Incident', text: 'Possible chemical leak reported at 1500 San Jacinto St, Baytown', time: NOW - 5 * 60_000 }, NOW);
    await ingest(kv, { ...CR, title: 'Vehicle Crash', text: 'Two-vehicle crash with injuries in Highlands', time: NOW - 20 * 60_000 }, NOW);
    await ingest(kv, { ...CR, title: 'Gas Leak', text: 'Gas leak at 400 Main St, Dallas, TX', time: NOW - 30 * 60_000 }, NOW);
    await ingest(kv, { ...CR, title: 'Fire', text: 'Grass fire in Crosby', time: NOW - 30 * 3600_000 }, NOW);
    await ingest(kv, { app: 'Messages', package: 'com.google.android.apps.messaging', title: 'ReadyHarris',
        text: 'Harris County OHSEM: Residents near Channelview should shelter in place due to an industrial incident.', time: NOW - 60_000 }, NOW);
    // A CAER app notification still goes to the industrial panel.
    await ingest(kv, { app: 'CAER Online', title: 'CAER Online', text: 'This is an update from PEMEX Deer Park. We are flaring. No impact to the community.', time: NOW - 60_000 }, NOW);

    const stored = JSON.parse(kv.data.get('relay:caer:v1')).items;
    const spill = stored.find((i) => i.title === 'Hazmat Incident');
    assert.deepEqual([spill.channel, spill.lat, spill.location_approximate], ['community', 29.77, false]);
    assert.equal(stored.find((i) => i.title === 'Gas Leak').lat, null, 'geocodes outside the region are rejected');
    assert.equal(stored.find((i) => i.title === 'CAER Online').lat, undefined, 'CAER items are not enriched here');

    community.setStore(kv);
    const reports = await community.fetchReports(...HOME, NOW);
    assert.equal(reports.length, 4, 'the 30-hour-old report is dropped');
    const byTitle = Object.fromEntries(reports.map((r) => [r.title, r]));
    assert.deepEqual([byTitle.ReadyHarris.kind, byTitle.ReadyHarris.level], ['sms', 'warning']);
    assert.deepEqual([byTitle['Hazmat Incident'].kind, byTitle['Hazmat Incident'].level, byTitle['Hazmat Incident'].unconfirmed], ['scanner', 'advisory', true]);
    assert.equal(byTitle['Vehicle Crash'].level, 'info');
    assert.equal(byTitle['Vehicle Crash'].location_approximate, true);
    assert.equal(reports[0].title, 'ReadyHarris', 'verdict-relevant first');
    assert.deepEqual(reports.meta.apps.sort(), ['CrimeRadar', 'Messages']);

    caer.setRelayStore(kv);
    const postings = await caer.fetchPostings(...HOME, NOW);
    assert.deepEqual(postings.map((p) => p.facility), ['PEMEX Deer Park'], 'scanner reports never show up as plants');

    const r = assess.build(...HOME, {
        nws_alerts: { ok: true, data: [] }, weather: { ok: true, data: null }, caer: { ok: true, data: [] },
        houston_fire: { ok: true, data: [] }, community: { ok: true, data: reports },
    }, { now: NOW });
    assert.equal(r.level, 'warning');
    const scan = r.reasons.find((x) => x.source === 'Scanner');
    assert.match(scan.title, /^Scanner report \(unconfirmed\): Hazmat Incident/);
    assert.match(scan.note, /may be wrong/);
});

test('ingest endpoint stores CrimeRadar notifications with a location', async () => {
    const kv = new MemoryKV();
    mockFetch({});
    const env = { INGEST_TOKEN: 'secret-token', STATE: kv };
    const res = await worker.fetch(new Request('https://w.test/api/ingest/notification', {
        method: 'POST', headers: { Authorization: 'Bearer secret-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...CR, title: 'Structure Fire', text: 'Working fire at 1500 San Jacinto St, Baytown', time: NOW }),
    }), env, { waitUntil() {} });
    assert.equal(res.status, 202);
    assert.equal((await res.json()).channel, 'community');
    const item = JSON.parse(kv.data.get('relay:caer:v1')).items[0];
    assert.deepEqual([item.lat, item.lon], [29.77, -95.05]);
});

test('without the relay store the source reports itself as not set up', async () => {
    await assert.rejects(community.fetchReports(...HOME, NOW), /not set up/);
});
