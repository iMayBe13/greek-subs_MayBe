// Cloudflare KV store: offline, fetch injected. No test here touches the network or the real credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createKvStore, kvConfigured, keyName, DAILY_WRITE_CAP } from '../src/lib/kv.js';

const TOKEN = 'cf-test-TOKEN-7f3a9c1e2b4d';
const ACCT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const NS = '0123456789abcdef0123456789abcdef';
const json = (status, body = {}, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** A fake of the KV REST API: remembers every request and keeps the stored bytes in a Map. */
function fakeKv({ override } = {}) {
  const data = new Map();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const key = decodeURIComponent(u.pathname.split('/values/')[1]);
    const call = { url: String(url), method: init.method, headers: init.headers, body: init.body ? Buffer.from(init.body) : null, query: u.search, key, at: Date.now(), signal: init.signal };
    calls.push(call);
    if (override) { const r = await override(call); if (r) return r; }
    if (init.method === 'PUT') { data.set(key, call.body); return json(200, { success: true }); }
    if (init.method === 'DELETE') { data.delete(key); return json(200, { success: true }); }
    return data.has(key) ? new Response(data.get(key), { status: 200 }) : json(404, { success: false, errors: [{ code: 10009, message: 'key not found' }] });
  };
  return { fetchImpl, calls, data };
}

/** console.warn / console.log captured as text. */
function captureLogs(t) {
  const lines = [];
  const grab = (...a) => lines.push(a.join(' '));
  t.mock.method(console, 'warn', grab);
  t.mock.method(console, 'log', grab);
  return lines;
}

const make = (extra = {}) => {
  const fake = fakeKv(extra.fake);
  const store = createKvStore({ accountId: ACCT, namespaceId: NS, apiToken: TOKEN, fetchImpl: fake.fetchImpl, minWriteGapMs: 0, ...extra.opts });
  return { ...fake, store };
};

test('kvConfigured needs all three variables to be non-empty', () => {
  const all = { CLOUDFLARE_ACCOUNT_ID: ACCT, CLOUDFLARE_KV_NAMESPACE_ID: NS, CLOUDFLARE_API_TOKEN: TOKEN };
  assert.equal(kvConfigured(all), true);
  for (const k of Object.keys(all)) {
    assert.equal(kvConfigured({ ...all, [k]: '' }), false, k);
    assert.equal(kvConfigured({ ...all, [k]: '   ' }), false, k);
    const { [k]: _gone, ...rest } = all;
    assert.equal(kvConfigured(rest), false, k);
  }
  assert.equal(kvConfigured({}), false);
});

test('not configured (or odd ids): no request is made, get gives null, set and del give false', async (t) => {
  captureLogs(t);
  for (const opts of [{ accountId: '', namespaceId: NS, apiToken: TOKEN }, { accountId: ACCT, namespaceId: NS, apiToken: '' }, { accountId: '../x', namespaceId: NS, apiToken: TOKEN }, { accountId: ACCT, namespaceId: 'a/b', apiToken: TOKEN }]) {
    const fake = fakeKv();
    const s = createKvStore({ ...opts, env: {}, fetchImpl: fake.fetchImpl, minWriteGapMs: 0 });
    assert.equal(await s.get('k'), null);
    assert.equal(await s.set('k', Buffer.from('v')), false);
    assert.equal(await s.del('k'), false);
    assert.equal(fake.calls.length, 0);
  }
});

test('the environment is read at call time', async (t) => {
  captureLogs(t);
  const env = {};
  const fake = fakeKv();
  const s = createKvStore({ env, fetchImpl: fake.fetchImpl, minWriteGapMs: 0 });
  assert.equal(await s.set('k', Buffer.from('v')), false);
  Object.assign(env, { CLOUDFLARE_ACCOUNT_ID: ACCT, CLOUDFLARE_KV_NAMESPACE_ID: NS, CLOUDFLARE_API_TOKEN: TOKEN });
  assert.equal(await s.set('k', Buffer.from('v')), true);
});

test('URL, method, auth header and raw body: the shape the live round trip proved', async () => {
  const { store, calls } = make();
  assert.equal(await store.set('ai:v1:tt0364845:23:20:final', Buffer.from('Γεια')), true);
  const put = calls[0];
  assert.equal(put.method, 'PUT');
  assert.equal(put.url, `https://api.cloudflare.com/client/v4/accounts/${ACCT}/storage/kv/namespaces/${NS}/values/ai%3Av1%3Att0364845%3A23%3A20%3Afinal`);
  assert.equal(put.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(put.headers['Content-Type'], 'application/octet-stream');
  assert.equal(put.query, '');
  assert.ok(put.signal instanceof AbortSignal);
  assert.deepEqual((await store.get('ai:v1:tt0364845:23:20:final')).toString('utf8'), 'Γεια');
  const get = calls[1];
  assert.equal(get.method, 'GET');
  assert.equal(get.headers['Content-Type'], undefined);
  assert.equal(await store.del('ai:v1:tt0364845:23:20:final'), true);
  assert.equal(calls[2].method, 'DELETE');
});

test('key names are URL-encoded: colons, space, é, slash, plus, ampersand, percent, hash and question mark', async () => {
  const { store, calls, data } = make();
  const keys = ['a:b', 'name with space é', 'a/b+c&d', '100%', 'x#y?z=1', 'Ελληνικά:τίτλος'];
  for (const k of keys) {
    assert.equal(await store.set(k, Buffer.from(k)), true, k);
    assert.equal((await store.get(k)).toString('utf8'), k, k);
  }
  for (const c of calls) {
    const raw = c.url.split('/values/')[1];
    assert.equal(raw, encodeURIComponent(decodeURIComponent(raw))); // fully encoded, no raw reserved characters
    assert.ok(!/[\/ ?#&+]/.test(raw), raw);
  }
  assert.deepEqual([...data.keys()], keys); // the server decoded them back to the original names
});

test('ttlSec becomes expiration_ttl, never below 60, rounded up; none means no parameter', async () => {
  const { store, calls } = make();
  const q = async (opts) => { calls.length = 0; await store.set('k', Buffer.from('v'), opts); return calls[0].query; };
  assert.equal(await q(undefined), '');
  assert.equal(await q({}), '');
  assert.equal(await q({ ttlSec: 3600 }), '?expiration_ttl=3600');
  assert.equal(await q({ ttlSec: 120 * 86400 }), `?expiration_ttl=${120 * 86400}`);
  assert.equal(await q({ ttlSec: 60 }), '?expiration_ttl=60');
  assert.equal(await q({ ttlSec: 5 }), '?expiration_ttl=60');
  assert.equal(await q({ ttlSec: 0 }), '?expiration_ttl=60');
  assert.equal(await q({ ttlSec: -10 }), '?expiration_ttl=60');
  assert.equal(await q({ ttlSec: NaN }), '?expiration_ttl=60');
  assert.equal(await q({ ttlSec: 59.2 }), '?expiration_ttl=60');
  assert.equal(await q({ ttlSec: 90.5 }), '?expiration_ttl=91');
});

test('the stored value starts with the 8-byte write time; get strips it and maxAgeMs uses it', async () => {
  let clock = 1_800_000_000_000;
  const { store, calls } = make({ opts: { now: () => clock } });
  const payload = Buffer.from('Δοκιμή\nδεύτερη γραμμή');
  assert.equal(await store.set('k', payload), true);
  const body = calls[0].body;
  assert.equal(body.length, 8 + payload.length);
  assert.equal(Number(body.readBigUInt64BE(0)), 1_800_000_000_000);
  assert.deepEqual(body.subarray(8), payload);

  assert.deepEqual(await store.get('k'), payload); // prefix removed, no age limit
  assert.deepEqual(await store.get('k', { maxAgeMs: 1000 }), payload);
  clock += 1000;
  assert.deepEqual(await store.get('k', { maxAgeMs: 1000 }), payload); // exactly as old as allowed
  clock += 1;
  assert.equal(await store.get('k', { maxAgeMs: 1000 }), null); // one ms too old
  assert.deepEqual(await store.get('k'), payload); // without maxAgeMs it is still served
  assert.deepEqual(await store.get('k', { maxAgeMs: 0 }), payload); // 0 = no limit, like the disk store
});

test('a value too short to carry the time prefix is a miss; an empty payload round-trips', async () => {
  const { store, data } = make();
  data.set('foreign', Buffer.from('abc'));
  assert.equal(await store.get('foreign'), null);
  assert.equal(await store.set('empty', Buffer.alloc(0)), true);
  assert.deepEqual(await store.get('empty'), Buffer.alloc(0));
});

test('a 100 KB value and arbitrary bytes survive the round trip', async () => {
  const { store } = make();
  const big = crypto.randomBytes(100 * 1024);
  assert.equal(await store.set('big', big), true);
  assert.ok(big.equals(await store.get('big')));
});

test('a miss is null without a log line; del is true for a key that is gone, and the key is gone afterwards', async (t) => {
  const logs = captureLogs(t);
  const { store } = make();
  assert.equal(await store.get('nope'), null);
  assert.equal(await store.set('k', Buffer.from('v')), true);
  assert.equal(await store.del('k'), true);
  assert.equal(await store.get('k'), null);
  assert.equal(await store.del('k'), true); // already gone
  assert.deepEqual(logs, []);
});

test('429, 5xx, 401/403 and other failures: get null, set false, del false, nothing thrown, no token or URL in the log', async (t) => {
  const logs = captureLogs(t);
  for (const status of [429, 500, 502, 503, 504, 401, 403, 400, 418]) {
    const { store } = make({ fake: { override: () => json(status, { success: false, errors: [{ code: 1, message: `leaky ${TOKEN}` }] }, status === 429 ? { 'Retry-After': '5' } : {}) } });
    assert.equal(await store.get('k'), null, String(status));
    assert.equal(await store.set('k', Buffer.from('v')), false, String(status));
    assert.equal(await store.del('k'), false, String(status));
  }
  assert.ok(logs.length > 0);
  assert.ok(logs.every((l) => l.startsWith('[kv] ')));
  assert.ok(logs.some((l) => /HTTP 429/.test(l)));
  assert.ok(logs.some((l) => /HTTP 403 \(check the token/.test(l)));
  for (const l of logs) { assert.ok(!l.includes(TOKEN), l); assert.ok(!l.includes('cloudflare.com'), l); assert.ok(!l.includes(NS), l); }
});

test('a timeout gives null / false within the limit and never throws', async (t) => {
  const logs = captureLogs(t);
  const fake = fakeKv({ override: (c) => new Promise((_, rej) => c.signal.addEventListener('abort', () => rej(c.signal.reason))) });
  const store = createKvStore({ accountId: ACCT, namespaceId: NS, apiToken: TOKEN, fetchImpl: fake.fetchImpl, timeoutMs: 40, minWriteGapMs: 0 });
  const t0 = Date.now();
  assert.equal(await store.get('k'), null);
  assert.equal(await store.set('k', Buffer.from('v')), false);
  assert.equal(await store.del('k'), false);
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(logs.some((l) => /timeout/.test(l)));
});

test('network errors and broken responses give null / false; error text is never logged', async (t) => {
  const logs = captureLogs(t);
  const boom = () => { throw Object.assign(new TypeError(`fetch failed for https://api.cloudflare.com/x with ${TOKEN}`), { cause: { code: 'ECONNREFUSED' } }); };
  const a = make({ fake: { override: boom } });
  assert.equal(await a.store.get('k'), null);
  assert.equal(await a.store.set('k', Buffer.from('v')), false);
  assert.equal(await a.store.del('k'), false);
  const b = make({ fake: { override: () => ({ status: 200, arrayBuffer: () => Promise.reject(new Error(`body ${TOKEN}`)) }) } });
  assert.equal(await b.store.get('k'), null);
  assert.ok(logs.some((l) => /ECONNREFUSED/.test(l)));
  for (const l of logs) assert.ok(!l.includes(TOKEN) && !l.includes('cloudflare.com'), l);
});

test('failure log lines are limited to one per kind per minute', async (t) => {
  const logs = captureLogs(t);
  let clock = 5_000_000_000;
  const { store } = make({ fake: { override: () => json(503) }, opts: { now: () => clock } });
  for (let i = 0; i < 10; i++) await store.get(`k${i}`);
  assert.equal(logs.length, 1);
  clock += 61_000;
  await store.get('again');
  assert.equal(logs.length, 2);
});

test('key names: short keys unchanged, longer than 512 bytes (also multibyte) replaced by sha1, same key same name', () => {
  assert.equal(keyName('ai:v1:tt1:1:2:final'), 'ai:v1:tt1:1:2:final');
  const ok512 = 'k'.repeat(512);
  assert.equal(keyName(ok512), ok512);
  const long = 'k'.repeat(513);
  assert.equal(keyName(long), `sha1:${crypto.createHash('sha1').update(long).digest('hex')}`);
  assert.equal(keyName(long), keyName(long));
  assert.notEqual(keyName(long), keyName('k'.repeat(514)));
  const multi = 'é'.repeat(300); // 600 bytes, only 300 characters
  assert.match(keyName(multi), /^sha1:[0-9a-f]{40}$/);
  assert.equal(keyName('é'.repeat(256)), 'é'.repeat(256)); // exactly 512 bytes
  for (const bad of ['', '.', '..']) assert.match(keyName(bad), /^sha1:[0-9a-f]{40}$/);
  assert.ok(Buffer.byteLength(keyName('x'.repeat(100000))) <= 512);
});

test('a long key is hashed in the request and still reads back', async () => {
  const { store, calls } = make();
  const long = `ai:v1:${'x'.repeat(700)}`;
  assert.equal(await store.set(long, Buffer.from('v')), true);
  assert.equal((await store.get(long)).toString(), 'v');
  const name = decodeURIComponent(calls[0].url.split('/values/')[1]);
  assert.match(name, /^sha1:[0-9a-f]{40}$/);
  assert.ok(!calls[0].url.includes('xxxxxxxxxx'));
  assert.equal(await store.del(long), true);
  assert.equal(await store.get(long), null);
});

test('a value over 25 MiB is refused without a request', async (t) => {
  captureLogs(t);
  const { store, calls } = make();
  assert.equal(await store.set('huge', Buffer.alloc(25 * 1024 * 1024)), false);
  assert.equal(calls.length, 0);
  assert.equal(await store.set('max', Buffer.alloc(25 * 1024 * 1024 - 8)), true); // exactly at the limit with the prefix
});

test('daily write cap: 850 writes pass, the 851st is refused without a request, one log line, reads still work, resets at UTC midnight', async (t) => {
  const logs = captureLogs(t);
  assert.equal(DAILY_WRITE_CAP, 850);
  let clock = Date.UTC(2026, 9, 18, 10, 0, 0);
  const { store, calls } = make({ opts: { now: () => clock } });
  for (let i = 0; i < 850; i++) assert.equal(await store.set(`k${i}`, Buffer.from('v')), true, `write ${i + 1}`);
  assert.equal(calls.length, 850);
  assert.equal(store.stats().writesToday, 850);
  assert.equal(store.stats().capReached, true);
  assert.deepEqual(logs, []); // not logged until a write is refused

  assert.equal(await store.set('k850', Buffer.from('v')), false);
  assert.equal(await store.set('k851', Buffer.from('v')), false);
  assert.equal(await store.del('k0'), false); // deletes are writes too
  assert.equal(calls.length, 850);
  assert.equal(logs.filter((l) => /daily write cap reached \(850\)/.test(l)).length, 1);
  assert.equal(logs.length, 1);

  assert.equal((await store.get('k5')).toString(), 'v'); // reads are not limited
  assert.equal(calls.length, 851);

  clock = Date.UTC(2026, 9, 19, 0, 0, 1); // after UTC midnight
  assert.equal(store.stats().writesToday, 0);
  assert.equal(await store.set('fresh', Buffer.from('v')), true);
  assert.equal(store.stats().writesToday, 1);
  assert.equal(await store.set('x', Buffer.from('v')), true);
});

test('a write that fails still counts against the daily budget, a refused (not configured) one does not', async (t) => {
  captureLogs(t);
  const a = make({ fake: { override: () => json(503) } });
  await a.store.set('k', Buffer.from('v'));
  assert.equal(a.store.stats().writesToday, 1);
  const s = createKvStore({ env: {}, fetchImpl: fakeKv().fetchImpl });
  await s.set('k', Buffer.from('v'));
  assert.equal(s.stats().writesToday, 0);
});

test('writes to one key are at least minWriteGapMs apart; the newest value wins and every caller hears the result', async () => {
  const GAP = 80;
  const { store, calls, data } = make({ opts: { minWriteGapMs: GAP } });
  const first = store.set('k', Buffer.from('one'));
  const second = store.set('k', Buffer.from('two'));
  const third = store.set('k', Buffer.from('three'));
  const other = store.set('other', Buffer.from('x')); // another key is not delayed
  assert.deepEqual(await Promise.all([first, second, third, other]), [true, true, true, true]);
  const puts = calls.filter((c) => c.key === 'k');
  assert.equal(puts.length, 2); // 'two' was replaced by 'three'
  assert.ok(puts[1].at - puts[0].at >= GAP - 5, `gap was ${puts[1].at - puts[0].at} ms`);
  assert.equal(data.get('k').subarray(8).toString(), 'three');
  assert.equal(calls.filter((c) => c.key === 'other').length, 1);
  assert.ok(calls.find((c) => c.key === 'other').at - puts[0].at < GAP); // sent at once
  assert.equal(store.stats().pending, 0);

  // after the gap has passed, a write goes out at once again
  await new Promise((r) => setTimeout(r, GAP + 20));
  const before = Date.now();
  await store.set('k', Buffer.from('four'));
  assert.ok(calls.at(-1).at - before < 30);
});

test('a delete right after a set waits for the gap and replaces a waiting set; flush() runs delayed writes now', async () => {
  const GAP = 5000; // long: nothing may wait for it
  const { store, calls, data } = make({ opts: { minWriteGapMs: GAP } });
  assert.equal(await store.set('k', Buffer.from('one')), true); // immediate
  const pendingSet = store.set('k', Buffer.from('two')); // waits
  const pendingDel = store.del('k'); // replaces the waiting set
  assert.equal(store.stats().pending, 1);
  assert.equal(calls.length, 1);
  await store.flush();
  assert.deepEqual(await Promise.all([pendingSet, pendingDel]), [true, true]);
  assert.deepEqual(calls.map((c) => c.method), ['PUT', 'DELETE']);
  assert.equal(data.has('k'), false);
  assert.equal(store.stats().pending, 0);
});

test('the API token is only ever in the Authorization header: never in a URL, a body, another header or a log line', async (t) => {
  const logs = captureLogs(t);
  const failing = new Set(['k-fail']);
  const { store, calls } = make({ fake: { override: (c) => (failing.has(c.key) ? json(500, { errors: [{ message: TOKEN }] }) : null) /* not 429: that would use up the day's writes */ } });
  await store.set('k-ok', Buffer.from('payload'), { ttlSec: 300 });
  await store.get('k-ok');
  await store.del('k-ok');
  await store.get('k-fail');
  await store.set('k-fail', Buffer.from('payload'));
  await store.del('k-fail');
  await store.set('x'.repeat(900), Buffer.from('long key'));
  assert.ok(calls.length >= 7);
  for (const c of calls) {
    assert.ok(!c.url.includes(TOKEN), 'token in url');
    if (c.body) assert.ok(!c.body.toString('latin1').includes(TOKEN), 'token in body');
    for (const [name, value] of Object.entries(c.headers)) {
      if (name === 'Authorization') assert.equal(value, `Bearer ${TOKEN}`);
      else assert.ok(!String(value).includes(TOKEN), `token in header ${name}`);
    }
    assert.ok(!c.query.includes(TOKEN));
  }
  for (const l of logs) assert.ok(!l.includes(TOKEN) && !l.includes(ACCT) && !l.includes(NS), l);
});
