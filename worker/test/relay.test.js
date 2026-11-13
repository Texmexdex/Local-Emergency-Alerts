import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as caer from '../src/caer.js';
import worker from '../src/index.js';
import * as relay from '../src/relay.js';
import { HOME, NOW, fixture, mockFetch } from './helpers.js';

class MemoryKV {
    constructor() { this.data = new Map(); this.puts = 0; }
    async get(key, type) { const v = this.data.get(key) ?? null; return v && type === 'json' ? JSON.parse(v) : v; }
    async put(key, value) { this.puts++; this.data.set(key, value); }
}

const SIGN_IN_PAGE = '<html><head><title>eNotify - Emergency Notification System</title></head><body>Initializing...</body></html>';
const SIP = {
    title: 'Example Chemical Baytown',
    text: 'This is a message from Example Chemical Baytown located at 100 Example Rd Baytown,TX 77520. Due to a release at our facility, residents north of Interstate 10 should shelter in place until further notice.',
    app: 'com.conduit.app_caer',
};

test('normalizes the field names common forwarder apps send', () => {
    const a = relay.normalize({ notification_title: 'T', bigtext: 'Body', packageName: 'pkg', timestamp: 1793050200 }, NOW);
    assert.deepEqual([a.title, a.text, a.app, a.received_at], ['T', 'Body', 'pkg', 1793050200000]);
    const b = relay.normalize({ title: 'T', message: 'M', time: 'not a date' }, NOW);
    assert.equal(b.received_at, NOW);
});

test('ingest stores once, ignores duplicates and empties, records heartbeats', async () => {
    const kv = new MemoryKV();
    assert.equal((await relay.ingest(kv, SIP, NOW)).stored, true);
    assert.equal((await relay.ingest(kv, SIP, NOW + 1000)).duplicate, true);
    assert.equal((await relay.ingest(kv, {}, NOW)).error, 'empty notification');
    assert.equal(kv.puts, 1, 'duplicates and empties do not write KV');
    await relay.ingest(kv, { heartbeat: true }, NOW + 2000);
    const r = await relay.recent(kv, NOW + 3000);
    assert.equal(r.items.length, 1);
    assert.equal(r.heartbeat, true);
    assert.equal(r.stale, false);
    assert.equal((await relay.recent(kv, NOW + relay.STALE_AFTER_MS + 10_000)).stale, true);
});

test('works out the facility from generic notification titles', () => {
    assert.equal(relay.facilityOf('CAER Online', SIP.text), 'Example Chemical Baytown');
    assert.equal(relay.facilityOf('New message', 'This is an update from PEMEX Deer Park. We are flaring.'), 'PEMEX Deer Park');
    assert.equal(relay.facilityOf('LyondellBasell - Channelview - Update 2', 'x'), 'LyondellBasell - Channelview');
});

test('relayed notifications replace the unavailable public feed', async () => {
    mockFetch({ 'incident-reporter.net': () => SIGN_IN_PAGE });
    const kv = new MemoryKV();
    await relay.ingest(kv, SIP, NOW - 10 * 60_000);
    await relay.ingest(kv, { title: 'CAER Online', text: 'This is an update from PEMEX Deer Park. We are still performing planned work activities that may cause flaring. At this time, we do not anticipate any impact to the community.' }, NOW - 5 * 60_000);
    caer.setRelayStore(kv);
    const postings = await caer.fetchPostings(...HOME, NOW);
    assert.equal(postings.meta.via, 'relay');
    const sip = postings.find((p) => p.facility === 'Example Chemical Baytown');
    assert.deepEqual([sip.level, sip.kind], ['action', 'protective_action']);
    assert.ok(sip.lat != null, 'located from the address in the message');
    assert.equal(postings.find((p) => p.facility === 'PEMEX Deer Park').level, 'info');
});

test('a later all-clear from the same facility supersedes its incident', async () => {
    mockFetch({ 'incident-reporter.net': () => SIGN_IN_PAGE });
    const kv = new MemoryKV();
    await relay.ingest(kv, SIP, NOW - 60 * 60_000);
    await relay.ingest(kv, { title: 'Example Chemical Baytown', text: 'This is a message from Example Chemical Baytown located at 100 Example Rd Baytown,TX 77520. We are issuing the all clear for this incident.' }, NOW - 5 * 60_000);
    caer.setRelayStore(kv);
    const [p] = await caer.fetchPostings(...HOME, NOW);
    assert.equal(p.kind, 'all_clear');
    assert.equal(p.updates.length, 1);
});

test('without the relay, or with a stale phone, CAER is reported unavailable', async () => {
    mockFetch({ 'incident-reporter.net': () => SIGN_IN_PAGE });
    caer.setRelayStore(new MemoryKV());
    await assert.rejects(caer.fetchPostings(...HOME, NOW), (e) => e.unavailable && /sign-in/.test(e.message));
    const kv = new MemoryKV();
    await relay.ingest(kv, { heartbeat: true }, NOW - relay.STALE_AFTER_MS - 60_000);
    caer.setRelayStore(kv);
    await assert.rejects(caer.fetchPostings(...HOME, NOW), (e) => e.unavailable && /hasn't checked in/.test(e.message));
});

const post = (path, body, env, headers = { 'Content-Type': 'application/json' }) =>
    worker.fetch(new Request(`https://w.example${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers }), env, { waitUntil() {} });

test('ingest endpoint requires configuration and the right token', async () => {
    const kv = new MemoryKV();
    assert.equal((await post('/api/ingest/notification', SIP, { STATE: kv })).status, 503);
    const env = { STATE: kv, INGEST_TOKEN: 's3cret-token' };
    assert.equal((await post('/api/ingest/notification?token=wrong', SIP, env)).status, 401);
    assert.equal((await post('/api/ingest/notification', SIP, env)).status, 401);
    assert.equal((await post('/api/ingest/notification?token=s3cret-token', SIP, env)).status, 202);
    const viaHeader = await post('/api/ingest/notification', { ...SIP, text: `${SIP.text} Update.` }, env,
        { 'Content-Type': 'application/json', Authorization: 'Bearer s3cret-token' });
    assert.equal(viaHeader.status, 202);
    const plain = await post('/api/ingest/notification?token=s3cret-token', 'Plain text notification body', env, { 'Content-Type': 'text/plain' });
    assert.equal((await plain.json()).stored, true);
    const hb = await post('/api/ingest/notification?token=s3cret-token&heartbeat=1', '', env, {});
    assert.equal((await hb.json()).heartbeat, true);
    const get = await worker.fetch(new Request('https://w.example/api/ingest/notification'), env, {});
    assert.equal(get.status, 405);
});

test('status shows relayed plant notifications as a working CAER source', async () => {
    mockFetch({
        'incident-reporter.net': () => SIGN_IN_PAGE,
        'api.weather.gov/alerts': { features: [] },
        'api.weather.gov/points': () => new Response('down', { status: 503 }),
        'cohweb.houstontx.gov': () => fixture('houston.html'),
    });
    const kv = new MemoryKV();
    const env = { STATE: kv, INGEST_TOKEN: 't' };
    await post('/api/ingest/notification?token=t', SIP, env);
    const body = await (await worker.fetch(new Request('https://w.example/api/status?lat=29.7761&lon=-95.1144'), env, { waitUntil() {} })).json();
    assert.equal(body.sources.caer.ok, true);
    assert.equal(body.sources.caer.meta.via, 'relay');
    assert.equal(body.level, 'action');
    assert.match(body.reasons[0].title, /Example Chemical Baytown/);
});
