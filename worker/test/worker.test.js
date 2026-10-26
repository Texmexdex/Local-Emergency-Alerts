import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as geocode from '../src/geocode.js';
import { localToEpoch, toLocalIso } from '../src/http.js';
import worker from '../src/index.js';
import { fixture, mockFetch } from './helpers.js';

const ctx = () => {
    const pending = [];
    return { waitUntil: (p) => pending.push(p), flush: () => Promise.all(pending) };
};

class MemoryKV {
    constructor() { this.data = new Map(); this.puts = 0; }
    async get(key, type) { const v = this.data.get(key) ?? null; return v && type === 'json' ? JSON.parse(v) : v; }
    async put(key, value) { this.puts++; this.data.set(key, value); }
}

function mockAllSources({ alerts = [] } = {}) {
    const sent = [];
    mockFetch({
        'api.weather.gov/alerts': { features: alerts },
        'api.weather.gov/points': () => new Response('down', { status: 503 }),
        'incident-reporter.net': () => fixture('caer_feed.html'),
        'cohweb.houstontx.gov': () => fixture('houston.html'),
        'ntfy.example': (url, init) => { sent.push({ url, title: init.headers.Title, body: init.body }); return new Response('ok'); },
    });
    return sent;
}

const get = (path, env = {}) => {
    const c = ctx();
    return worker.fetch(new Request(`https://w.example${path}`), env, c).then(async (r) => { await c.flush(); return r; });
};

test('status endpoint returns the combined assessment with CORS', async () => {
    mockAllSources();
    const r = await get('/api/status?lat=29.7761&lon=-95.1144&radius_mi=10&label=Home');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
    const body = await r.json();
    assert.equal(body.location.label, 'Home');
    assert.equal(Math.round(body.radius_mi), 10);
    assert.equal(body.sources.weather.ok, false); // points mocked as down
    assert.equal(body.sources.caer.ok, true);
    assert.equal(body.complete, false);
    assert.ok(body.caer.length === 7 && body.fire.length === 4);
});

test('status defaults to Channelview and validates input', async () => {
    mockAllSources();
    assert.equal((await (await get('/api/status')).json()).location.label, 'Channelview, TX');
    assert.equal((await get('/api/status?lat=abc')).status, 400);
    assert.equal((await get('/api/status?lat=10&lon=-95')).status, 400);
    assert.equal((await get('/api/geocode')).status, 400);
    assert.equal((await get('/nope')).status, 404);
    assert.equal((await worker.fetch(new Request('https://w.example/api/status', { method: 'OPTIONS' }), {}, ctx())).status, 204);
});

test('geocode endpoint uses Census, then falls back to place search', async () => {
    mockFetch({ 'nominatim.openstreetmap.org': [{ lat: '29.77', lon: '-95.11', display_name: 'Channelview, Harris County, Texas' }] });
    const a = await (await get('/api/geocode?q=8280 Sheldon Rd Channelview, TX 77530')).json();
    assert.deepEqual([a.results[0].lat, a.results[0].lon], [29.8325, -95.1170]);
    const b = await (await get('/api/geocode?q=Channelview TX')).json();
    assert.equal(b.results[0].label, 'Channelview, Harris County, Texas');
});

test('facility geocodes persist to KV and are reused by a cold isolate', async () => {
    const kv = new MemoryKV();
    mockAllSources();
    await get('/api/status', { STATE: kv });
    assert.equal(kv.puts, 1);
    const saved = JSON.parse(kv.data.get('geocodes:v1'));
    assert.ok(saved['8280 SHELDON RD CHANNELVIEW, TX 77530']);

    geocode._reset(); // simulate a new isolate
    const { calls, resetAll } = await import('./helpers.js');
    resetAll();
    mockAllSources();
    await get('/api/status', { STATE: kv });
    assert.equal(calls.filter((c) => c.url.includes('onelineaddress')).length, 0);
    assert.equal(kv.puts, 1, 'nothing new, so no extra KV write');
});

test('cron monitor pushes once and stores state only on change', async () => {
    const kv = new MemoryKV();
    const env = { STATE: kv, NTFY_TOPIC: 'test-topic', NTFY_SERVER: 'https://ntfy.example', HOME_LAT: '29.7761', HOME_LON: '-95.1144' };
    const sent = mockAllSources();
    const run = async () => { const c = ctx(); await worker.scheduled({}, env, c); await c.flush(); };
    await run();
    assert.ok(sent.length >= 2, `sent ${sent.length}`);
    assert.match(sent[0].title, /^ACTION: Example Chemical Baytown/);
    assert.equal(sent[0].url, 'https://ntfy.example/test-topic');
    const writes = kv.puts;
    await run();
    assert.equal(sent.length >= 2 && sent.length, sent.length);
    const before = sent.length;
    await run();
    assert.equal(sent.length, before, 'no repeat pushes');
    assert.equal(kv.puts, writes, 'quiet runs do not write KV');
});

test('cron monitor is a no-op without a topic', async () => {
    const sent = mockAllSources();
    const c = ctx();
    await worker.scheduled({}, { STATE: new MemoryKV() }, c);
    assert.equal(sent.length, 0);
});

test('Houston local time handles daylight saving', () => {
    assert.equal(toLocalIso(localToEpoch(2026, 10, 26, 7, 21, 0)), '2026-10-26T07:21:00-05:00');
    assert.equal(toLocalIso(localToEpoch(2026, 12, 1, 7, 21, 0)), '2026-12-01T07:21:00-06:00');
    assert.equal(new Date(localToEpoch(2026, 12, 1, 0, 0, 0)).toISOString(), '2026-12-01T06:00:00.000Z');
    assert.equal(toLocalIso(localToEpoch(2026, 11, 0, 23, 0, 0)), '2026-10-31T23:00:00-05:00'); // day overflow
});

test('census batch response parsing', () => {
    const r = geocode.parseBatchResponse([
        '"0","1000 MAIN ST, Houston, TX, ","Match","Exact","1000 MAIN ST, HOUSTON, TX, 77002","-95.363,29.756","1","L"',
        '"1","9999 NOWHERE LN, Houston, TX, ","No_Match"',
        '"2","100 ELM, Houston, TX, ","Tie"',
    ].join('\r\n'));
    assert.deepEqual([r.get('0').lat, r.get('0').lon], [29.756, -95.363]);
    assert.equal(r.get('1'), null);
    assert.equal(r.get('2'), null);
});

test('status reports CAER as failed (not all clear) when the page format changes', async () => {
    mockFetch({
        'api.weather.gov/alerts': { features: [] },
        'api.weather.gov/points': () => new Response('down', { status: 503 }),
        'incident-reporter.net': () => '<html><title>eNotify - Emergency Notification System</title><body>Initializing...</body></html>',
        'cohweb.houstontx.gov': () => fixture('houston.html'),
    });
    const body = await (await get('/api/status')).json();
    assert.equal(body.sources.caer.ok, false);
    assert.match(body.sources.caer.error, /FormatError/);
    assert.equal(body.complete, false);
    assert.match(body.headline, /sources that responded/);
});
