// DeepL client: offline, fetch and sleep injected. Nothing here touches the network or a real key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { translate, usage, makeBatches, deeplHost, DEEPL_MODEL_TYPE } from '../src/lib/ai/deepl.js';
import { AiError } from '../src/lib/ai/http.js';
import { passesCharCheck } from '../src/lib/ai/validate.js';
import { isExhausted, scopeOf } from '../src/lib/health.js';

let n = 0;
const proKey = () => `deepl-pro-key-${process.pid}-${++n}-0123456789abcdef`; // every test gets its own key: quota state is kept per key
const freeKey = () => `${proKey()}:fx`;
const json = (status, body = {}, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** Fake DeepL. handler(call, callNumber) may return a Response to override the default answer ("EL(<text>)" for every text). */
function fakeDeepl(handler) {
  const calls = [];
  let inFlight = 0, maxInFlight = 0;
  const fetchImpl = async (url, init) => {
    const call = { url: String(url), method: init.method, headers: init.headers, raw: init.body, body: init.body ? JSON.parse(init.body) : null, signal: init.signal };
    calls.push(call);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (handler) { const r = await handler(call, calls.length); if (r) return r; }
      if (call.url.endsWith('/v2/usage')) return json(200, { character_count: 1234, character_limit: 500000 });
      return json(200, { translations: call.body.text.map((t) => ({ detected_source_language: 'EN', text: `EL(${t})` })) });
    } finally { inFlight--; }
  };
  return { fetchImpl, calls, maxInFlight: () => maxInFlight };
}
const env = () => {
  const sleeps = [], logs = [];
  return { sleeps, logs, sleep: async (ms) => { sleeps.push(ms); }, log: (m) => logs.push(m) };
};
const cues = (count, make = (i) => `line ${i}`) => Array.from({ length: count }, (_, i) => make(i));

test('host: a key ending in :fx is a Free key (api-free.deepl.com), every other key uses api.deepl.com', async () => {
  assert.equal(deeplHost('abc:fx'), 'https://api-free.deepl.com');
  assert.equal(deeplHost('abc'), 'https://api.deepl.com');
  assert.equal(deeplHost('abc:fx '), 'https://api-free.deepl.com'); // surrounding whitespace is ignored
  assert.equal(deeplHost('abc:fx-not'), 'https://api.deepl.com');
  assert.equal(deeplHost(undefined), 'https://api.deepl.com');
  for (const [key, host] of [[freeKey(), 'api-free.deepl.com'], [proKey(), 'api.deepl.com']]) {
    const f = fakeDeepl(); const e = env();
    await translate({ key, texts: ['Hello.'], fetchImpl: f.fetchImpl, ...e });
    await usage({ key, fetchImpl: f.fetchImpl, ...e });
    assert.deepEqual(f.calls.map((c) => new URL(c.url).host), [host, host]);
    assert.deepEqual(f.calls.map((c) => new URL(c.url).pathname), ['/v2/translate', '/v2/usage']);
  }
});

test('request: POST JSON, key only in the Authorization header, source EN, target EL, preserve_formatting, model_type', async () => {
  const key = freeKey(); const f = fakeDeepl(); const e = env();
  const r = await translate({ key, texts: ['Hello there.', 'Two\nlines'], fetchImpl: f.fetchImpl, ...e });
  assert.deepEqual(r, { texts: ['EL(Hello there.)', 'EL(Two\nlines)'], chars: 'Hello there.'.length + 'Two\nlines'.length });
  const c = f.calls[0];
  assert.equal(c.method, 'POST');
  assert.equal(c.headers.Authorization, `DeepL-Auth-Key ${key}`);
  assert.equal(c.headers['Content-Type'], 'application/json');
  assert.deepEqual(c.body, { text: ['Hello there.', 'Two\nlines'], source_lang: 'EN', target_lang: 'EL', preserve_formatting: true, model_type: 'prefer_quality_optimized' });
  assert.equal(DEEPL_MODEL_TYPE, 'prefer_quality_optimized');
  assert.ok(!c.url.includes(key) && !c.raw.includes(key));
  assert.equal(new URL(c.url).search, '');
  assert.ok(c.signal instanceof AbortSignal); // every request has a timeout
});

test('a missing or malformed key fails at once with bad_key and no request', async () => {
  const f = fakeDeepl();
  for (const key of [undefined, '', '   ', 'short', 'has space in it 123456', 'new\nline-1234567890', 42]) {
    await assert.rejects(() => translate({ key, texts: ['x'], fetchImpl: f.fetchImpl, ...env() }), (e) => e instanceof AiError && e.code === 'bad_key');
    await assert.rejects(() => usage({ key, fetchImpl: f.fetchImpl, ...env() }), (e) => e.code === 'bad_key');
  }
  assert.equal(f.calls.length, 0);
});

test('batching: 120 cues become 50 + 50 + 20, results keep their order, at most 2 requests run at once', async () => {
  const f = fakeDeepl(async () => { await new Promise((r) => setTimeout(r, 15)); });
  const texts = cues(120);
  const r = await translate({ key: proKey(), texts, fetchImpl: f.fetchImpl, ...env() });
  assert.deepEqual(f.calls.map((c) => c.body.text.length), [50, 50, 20]);
  assert.deepEqual(r.texts, texts.map((t) => `EL(${t})`));
  assert.equal(f.maxInFlight(), 2);
  const f2 = fakeDeepl(async () => { await new Promise((r2) => setTimeout(r2, 15)); });
  await translate({ key: proKey(), texts: cues(400), fetchImpl: f2.fetchImpl, ...env() }); // 8 batches
  assert.equal(f2.calls.length, 8);
  assert.equal(f2.maxInFlight(), 2); // never more than 2, and it does use both
});

test('batching: the body of every request stays under 100 KiB (UTF-8 bytes, Greek counts 2 per letter) and no cue is lost or repeated', async () => {
  const f = fakeDeepl(); const e = env();
  const texts = cues(120, (i) => `${i}:` + 'Ω'.repeat(1500)); // about 3 KB each: 50 would be 150 KB
  const r = await translate({ key: proKey(), texts, fetchImpl: f.fetchImpl, ...e });
  assert.ok(f.calls.length > 3);
  for (const c of f.calls) { assert.ok(Buffer.byteLength(c.raw) <= 100 * 1024, `body was ${Buffer.byteLength(c.raw)} bytes`); assert.ok(c.body.text.length <= 50); }
  assert.deepEqual(f.calls.flatMap((c) => c.body.text), texts);
  assert.deepEqual(r.texts, texts.map((t) => `EL(${t})`));
});

test('makeBatches: limits, ordering, and one oversized cue goes alone', () => {
  const texts = cues(7);
  assert.deepEqual(makeBatches(texts, { maxCues: 3 }).map((b) => [b.from, b.texts.length]), [[0, 3], [3, 3], [6, 1]]);
  assert.deepEqual(makeBatches([], {}), []);
  const big = ['a', 'x'.repeat(200000), 'b'];
  const b = makeBatches(big, { maxBytes: 100 * 1024 });
  assert.deepEqual(b.map((x) => x.texts.length), [1, 1, 1]);
  assert.deepEqual(b.flatMap((x) => x.texts), big);
  const small = makeBatches(cues(10, () => 'x'.repeat(1000)), { maxBytes: 4500 });
  assert.ok(small.every((x) => Buffer.byteLength(JSON.stringify({ text: x.texts, context: x.context })) + 200 <= 4500 || x.texts.length === 1));
  assert.ok(small.length >= 3);
});

test('a cue larger than the server accepts: 413 is reported as too_large, not retried', async () => {
  const f = fakeDeepl(() => json(413, { message: 'Request Entity Too Large' })); const e = env();
  await assert.rejects(() => translate({ key: proKey(), texts: ['x'.repeat(150000)], fetchImpl: f.fetchImpl, ...e }), (er) => er.code === 'too_large' && er.status === 413);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(e.sleeps, []);
});

test('context: the 3 cues before each batch are sent as context, none for the very first batch without contextBefore', async () => {
  const f = fakeDeepl(); const e = env();
  const texts = cues(120);
  await translate({ key: proKey(), texts, fetchImpl: f.fetchImpl, ...e });
  const byFirst = new Map(f.calls.map((c) => [c.body.text[0], c.body]));
  assert.equal('context' in byFirst.get('line 0'), false);
  assert.equal(byFirst.get('line 50').context, 'line 47\nline 48\nline 49');
  assert.equal(byFirst.get('line 100').context, 'line 97\nline 98\nline 99');

  const g = fakeDeepl();
  const out = await translate({ key: proKey(), texts: ['now'], contextBefore: ['c1', 'c2', 'c3', 'c4', 'c5'], fetchImpl: g.fetchImpl, ...e });
  assert.equal(g.calls[0].body.context, 'c3\nc4\nc5'); // only the last 3
  assert.equal(out.chars, 3); // context is not counted: only "now"
  const h = fakeDeepl();
  await translate({ key: proKey(), texts: ['a', 'b'], contextBefore: ['only one'], fetchImpl: h.fetchImpl, ...e });
  assert.equal(h.calls[0].body.context, 'only one');
});

test('chars counts characters (not bytes) of the cues sent, context excluded', async () => {
  const f = fakeDeepl();
  const r = await translate({ key: proKey(), texts: ['Καλημέρα', 'abc'], contextBefore: ['ignored context'], fetchImpl: f.fetchImpl, ...env() });
  assert.equal(r.chars, 8 + 3);
});

test('a stray Cyrillic letter in the answer is returned untouched: rejecting it is the validator\'s job', async () => {
  const f = fakeDeepl(() => json(200, { translations: [{ text: 'Νόμιζα ότι τελειώσαμε με τον Λαρόш.' }] }));
  const r = await translate({ key: proKey(), texts: ['I thought we were done with Laroche.'], fetchImpl: f.fetchImpl, ...env() });
  assert.equal(r.texts[0], 'Νόμιζα ότι τελειώσαμε με τον Λαρόш.');
  assert.equal(passesCharCheck(r.texts[0]), false);
});

test('a wrong number of translations, or a body that is not JSON, is a bad_response', async () => {
  for (const reply of [json(200, { translations: [{ text: 'one' }] }), json(200, { translations: 'nope' }), json(200, {}), json(200, { translations: [{ text: 1 }, { text: 2 }] }), new Response('<html>', { status: 200 })]) {
    const f = fakeDeepl(() => reply.clone());
    await assert.rejects(() => translate({ key: proKey(), texts: ['a', 'b'], fetchImpl: f.fetchImpl, ...env() }), (e) => e.code === 'bad_response', 'bad answer accepted');
  }
});

test('onBatch is called as each batch finishes; the first failing batch stops the rest and the error is the first one', async () => {
  const f = fakeDeepl((call, number) => (number === 2 ? json(403, { message: 'Forbidden' }) : null)); const done = [];
  await assert.rejects(() => translate({ key: proKey(), texts: cues(250), onBatch: (b) => done.push(b.from), fetchImpl: f.fetchImpl, ...env() }), (e) => e.code === 'bad_key');
  assert.ok(f.calls.length <= 3); // 5 batches, but nothing new starts once one failed
  assert.ok(done.length >= 1 && done.length <= 2);
  const ok = fakeDeepl(); const seen = [];
  await translate({ key: proKey(), texts: cues(120), onBatch: (b) => seen.push([b.from, b.texts.length]), fetchImpl: ok.fetchImpl, ...env() });
  assert.deepEqual(seen.sort((a, b) => a[0] - b[0]), [[0, 50], [50, 50], [100, 20]]);
});

test('no texts: no request', async () => {
  const f = fakeDeepl();
  assert.deepEqual(await translate({ key: proKey(), texts: [], fetchImpl: f.fetchImpl, ...env() }), { texts: [], chars: 0 });
  assert.equal(f.calls.length, 0);
});

test('usage() gives used and limit; a wrong key is bad_key; an odd answer is bad_response', async () => {
  const key = freeKey();
  const f = fakeDeepl();
  assert.deepEqual(await usage({ key, fetchImpl: f.fetchImpl, ...env() }), { used: 1234, limit: 500000 });
  assert.equal(f.calls[0].method, 'GET');
  assert.equal(f.calls[0].body, null);
  assert.equal(f.calls[0].headers.Authorization, `DeepL-Auth-Key ${key}`);
  assert.ok(!f.calls[0].url.includes(key));
  await assert.rejects(() => usage({ key, fetchImpl: fakeDeepl(() => json(403, { message: 'Forbidden' })).fetchImpl, ...env() }), (e) => e.code === 'bad_key');
  await assert.rejects(() => usage({ key, fetchImpl: fakeDeepl(() => json(200, { character_count: 'x' })).fetchImpl, ...env() }), (e) => e.code === 'bad_response');
});

test('456: the key is marked exhausted until the first day of next month; no further request is made for it', async (t) => {
  let clock = Date.UTC(2026, 9, 18, 10, 0, 0);
  t.mock.method(Date, 'now', () => clock);
  const key = proKey(), other = proKey();
  const f = fakeDeepl((call) => (call.headers.Authorization.includes(key) ? json(456, { message: 'Quota exceeded' }) : null));
  const e = env();
  await assert.rejects(() => translate({ key, texts: cues(10), fetchImpl: f.fetchImpl, ...e }), (er) => er instanceof AiError && er.code === 'quota' && er.quota === true && er.status === 456);
  assert.equal(isExhausted('deepl', scopeOf({ apiKey: key })), true);
  assert.equal(e.logs.length, 1);
  assert.match(e.logs[0], /DeepL quota exhausted/);
  assert.deepEqual(e.sleeps, []); // no retry on 456
  const before = f.calls.length;
  await assert.rejects(() => translate({ key, texts: ['x'], fetchImpl: f.fetchImpl, ...e }), (er) => er.code === 'quota');
  assert.equal(f.calls.length, before); // refused without a request
  assert.equal((await translate({ key: other, texts: ['x'], fetchImpl: f.fetchImpl, ...e })).texts[0], 'EL(x)'); // another key is not affected

  clock = Date.UTC(2026, 9, 31, 23, 59, 59);
  assert.equal(isExhausted('deepl', scopeOf({ apiKey: key })), true);
  clock = Date.UTC(2026, 10, 1, 0, 0, 0); // November 1st, 00:00 UTC
  assert.equal(isExhausted('deepl', scopeOf({ apiKey: key })), false);
});

test('456 with parallel batches: one quota error, and no more than the 2 requests already running', async () => {
  const key = proKey();
  const f = fakeDeepl(async () => { await new Promise((r) => setTimeout(r, 10)); return json(456, {}); });
  await assert.rejects(() => translate({ key, texts: cues(300), fetchImpl: f.fetchImpl, ...env() }), (e) => e.code === 'quota');
  assert.ok(f.calls.length <= 2);
});

test('429 follows Retry-After (seconds), then succeeds', async () => {
  const f = fakeDeepl((call, number) => (number === 1 ? json(429, { message: 'Too many requests' }, { 'Retry-After': '3' }) : null)); const e = env();
  const r = await translate({ key: proKey(), texts: ['a'], fetchImpl: f.fetchImpl, ...e });
  assert.equal(r.texts[0], 'EL(a)');
  assert.deepEqual(e.sleeps, [3000]);
  assert.equal(f.calls.length, 2);
  assert.match(e.logs[0], /DeepL translate HTTP 429, retry 1\/3 in 3s/);
});

test('429 without Retry-After backs off 2 s, 4 s, 8 s and gives up after 4 tries; the wait is never over 60 s', async () => {
  const f = fakeDeepl(() => json(429, { message: 'Too many requests' })); const e = env();
  await assert.rejects(() => translate({ key: proKey(), texts: ['a'], fetchImpl: f.fetchImpl, ...e }), (er) => er.code === 'rate' && er.status === 429 && /HTTP 429/.test(er.message));
  assert.equal(f.calls.length, 4);
  assert.deepEqual(e.sleeps, [2000, 4000, 8000]);

  const g = fakeDeepl(() => json(429, {}, { 'Retry-After': '300' })); const e2 = env();
  await assert.rejects(() => translate({ key: proKey(), texts: ['a'], fetchImpl: g.fetchImpl, ...e2 }), (er) => er.code === 'rate' && er.retryAfterMs === 300000);
  assert.deepEqual(e2.sleeps, [60000, 60000, 60000]);

  const date = new Date(Date.now() + 7000).toUTCString(); // Retry-After may be an HTTP date
  const h = fakeDeepl((c, number) => (number === 1 ? json(429, {}, { 'Retry-After': date }) : null)); const e3 = env();
  await translate({ key: proKey(), texts: ['a'], fetchImpl: h.fetchImpl, ...e3 });
  assert.ok(e3.sleeps[0] > 4000 && e3.sleeps[0] <= 7000, `waited ${e3.sleeps[0]}`);
});

test('503 and 500 are retried (at most 4 tries); 400 and 403 are not', async () => {
  const f = fakeDeepl((call, number) => (number < 3 ? json(503, { message: 'Service unavailable' }) : null)); const e = env();
  assert.equal((await translate({ key: proKey(), texts: ['a'], fetchImpl: f.fetchImpl, ...e })).texts[0], 'EL(a)');
  assert.deepEqual(e.sleeps, [2000, 4000]);

  const down = fakeDeepl(() => json(500, {})); const e2 = env();
  await assert.rejects(() => translate({ key: proKey(), texts: ['a'], fetchImpl: down.fetchImpl, ...e2 }), (er) => er.code === 'unavailable');
  assert.equal(down.calls.length, 4);

  for (const [status, code] of [[400, 'bad_request'], [403, 'bad_key']]) {
    const g = fakeDeepl(() => json(status, { message: 'nope' })); const e3 = env();
    await assert.rejects(() => translate({ key: proKey(), texts: ['a'], fetchImpl: g.fetchImpl, ...e3 }), (er) => er.code === code);
    assert.equal(g.calls.length, 1);
    assert.deepEqual(e3.sleeps, []);
  }
});

test('a timeout and a network error are retried 3 times (4 tries) and reported as timeout / unreachable', async () => {
  const hang = fakeDeepl((call) => new Promise((_, rej) => call.signal.addEventListener('abort', () => rej(call.signal.reason)))); const e = env();
  await assert.rejects(() => translate({ key: proKey(), texts: ['a'], timeoutMs: 20, fetchImpl: hang.fetchImpl, ...e }), (er) => er.code === 'timeout');
  assert.equal(hang.calls.length, 4);
  assert.deepEqual(e.sleeps, [2000, 4000, 8000]);

  const net = fakeDeepl(() => { throw new TypeError('fetch failed'); }); const e2 = env();
  await assert.rejects(() => translate({ key: proKey(), texts: ['a'], fetchImpl: net.fetchImpl, ...e2 }), (er) => er.code === 'unreachable');
  assert.equal(net.calls.length, 4);
});

test('redaction: the key never appears in a thrown message, a log line, a request URL or a request body', async (t) => {
  const logged = [];
  t.mock.method(console, 'warn', (...a) => logged.push(a.join(' ')));
  t.mock.method(console, 'log', (...a) => logged.push(a.join(' ')));
  // each scenario gets its own key (a 456 would otherwise mark the shared key exhausted and hide the later scenarios)
  const scenarios = [
    (echo) => json(403, { message: echo }), (echo) => json(400, { message: echo }), (echo) => json(429, { message: echo }), (echo) => json(503, { message: echo }),
    (echo) => json(456, { message: echo }), (echo) => json(500, { message: echo }), (echo) => json(404, { message: echo }),
    (echo) => { throw Object.assign(new TypeError(`fetch failed ${echo}`), { cause: new Error(echo) }); },
    (echo) => new Response(echo, { status: 502 }), (echo) => new Response(echo, { status: 200 }),
  ];
  const urls = [], bodies = [], errors = [], keys = [];
  for (const make of scenarios) {
    const key = freeKey();
    keys.push(key);
    const echo = `Invalid key ${key} (${encodeURIComponent(key)}) at https://api-free.deepl.com/v2/translate?auth_key=${key}`;
    const own = env();
    const fetchImpl = async (url, init) => { urls.push(String(url)); bodies.push(String(init.body ?? '')); return make(echo); };
    for (const run of [() => translate({ key, texts: ['Hello.'], fetchImpl, ...own }), () => usage({ key, fetchImpl, ...own })]) {
      try { await run(); } catch (e) { errors.push(e); }
    }
    logged.push(...own.logs);
  }
  assert.ok(errors.length >= 10);
  assert.ok(errors.every((e) => e instanceof AiError));
  const everything = [...errors.flatMap((e) => [e.message, e.stack, JSON.stringify(e), String(e.cause ?? '')]), ...logged, ...urls, ...bodies];
  for (const key of keys) {
    for (const s of everything) {
      assert.ok(!s.includes(key), 'key found');
      assert.ok(!s.includes(encodeURIComponent(key)), 'encoded key found');
      assert.ok(!s.includes(key.split(':')[0]), 'key body found');
    }
  }
  assert.ok(errors.every((e) => e.message.length < 160));
});
