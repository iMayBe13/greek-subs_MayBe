import test from 'node:test';
import assert from 'node:assert/strict';
import { testKeys, testOpenSubtitles, testSubdl, testSubsource, testDeepl, testGemini } from '../src/lib/keytest.js';
import { deeplHost } from '../src/lib/ai/deepl.js';
import { createLimiter } from '../src/lib/ratelimit.js';

const res = (status, body = {}, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const timeout = () => { throw Object.assign(new Error('timeout https://api.example/?api_key=SECRETKEY'), { name: 'TimeoutError' }); };

test('SubSource: 200 ok, 401 wrong key, 429 limit, 500/timeout unreachable; key only in the header', async () => {
  const seen = [];
  const mk = (r) => async (url, opts) => { seen.push({ url: String(url), headers: opts.headers }); return typeof r === 'function' ? r() : r; };
  assert.deepEqual(await testSubsource({ apiKey: 'K1' }, mk(res(200))), { status: 'ok' });
  assert.equal(seen[0].headers['X-API-Key'], 'K1');
  assert.ok(!seen[0].url.includes('K1'));
  assert.deepEqual(await testSubsource({ apiKey: 'K1' }, mk(res(401))), { status: 'bad_key' });
  assert.deepEqual(await testSubsource({ apiKey: 'K1' }, mk(res(429))), { status: 'quota', reason: 'rate' });
  assert.deepEqual(await testSubsource({ apiKey: 'K1' }, mk(res(500))), { status: 'unreachable' });
  assert.deepEqual(await testSubsource({ apiKey: 'K1' }, mk(timeout)), { status: 'unreachable' });
});

test('SubDL: 403 not_authorized is a wrong key; the key goes in the query (the only form SubDL accepts)', async () => {
  let url;
  const ok = await testSubdl({ apiKey: 'K2' }, async (u) => { url = String(u); return res(200); });
  assert.deepEqual(ok, { status: 'ok' });
  assert.match(url, /api\.subdl\.com\/api\/v1\/subtitles\?api_key=K2/);
  assert.deepEqual(await testSubdl({ apiKey: 'K2' }, async () => res(403, { error: 'not_authorized' })), { status: 'bad_key' });
});

test('OpenSubtitles: key-only check uses a free search; bad key = 403', async () => {
  const urls = [];
  const f = async (u, o) => { urls.push(`${o.method || 'GET'} ${new URL(u).pathname}`); return res(200, { data: [] }); };
  assert.deepEqual(await testOpenSubtitles({ apiKey: 'K3', username: '', password: '' }, f), { status: 'ok', login: false });
  assert.deepEqual(urls, ['GET /api/v1/subtitles']); // no download, no login
  assert.deepEqual(await testOpenSubtitles({ apiKey: 'K3' }, async () => res(403, { message: 'You cannot consume this service' })), { status: 'bad_key' });
});

test('OpenSubtitles: login + remaining downloads; quota 0 is reported; wrong password is its own status', async () => {
  const flow = (loginStatus, user) => async (u, o) => {
    const p = new URL(u).pathname;
    if (p.endsWith('/subtitles')) return res(200, { data: [] });
    if (p.endsWith('/login')) return res(loginStatus, loginStatus === 200 ? { token: 'T' } : { message: 'invalid' });
    assert.equal(o.headers.Authorization, 'Bearer T');
    return res(200, { data: user });
  };
  const c = { apiKey: 'K3', username: 'u', password: 'p' };
  assert.deepEqual(await testOpenSubtitles(c, flow(200, { allowed_downloads: 20, remaining_downloads: 14 })),
    { status: 'ok', login: true, allowed: 20, remaining: 14 });
  assert.deepEqual(await testOpenSubtitles(c, flow(200, { allowed_downloads: 20, remaining_downloads: 0 })),
    { status: 'quota', reason: 'daily', allowed: 20, remaining: 0 });
  assert.deepEqual(await testOpenSubtitles(c, flow(401)), { status: 'bad_login' });
  assert.deepEqual(await testOpenSubtitles(c, flow(200, {})), { status: 'ok', login: true, allowed: undefined, remaining: undefined });
});

test('testKeys: only entered keys are tested, in parallel; errors never carry text', async () => {
  const f = async (u) => (String(u).includes('subdl') ? res(403) : res(200));
  const out = await testKeys({ subdl: { apiKey: 'bad' }, subsource: { apiKey: 'good' }, opensubtitles: { apiKey: '   ' } }, f);
  assert.deepEqual(out, { subdl: { status: 'bad_key' }, subsource: { status: 'ok' } });
  assert.deepEqual(await testKeys({}, f), {});
  assert.deepEqual(await testKeys(undefined, f), {});
  const boom = await testKeys({ subsource: { apiKey: 'k' } }, async () => { throw new Error('https://x/?api_key=SECRETKEY'); });
  assert.deepEqual(boom, { subsource: { status: 'unreachable' } });
  assert.ok(!JSON.stringify(boom).includes('SECRETKEY'));
});

test('rate limiter: blocks after the limit, resets with the window, counts IPs separately', () => {
  let t = 1000;
  const l = createLimiter({ limit: 3, windowMs: 60000, now: () => t });
  assert.ok(l.take('a').ok && l.take('a').ok && l.take('a').ok);
  const blocked = l.take('a');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryAfter, 60);
  assert.ok(l.take('b').ok);
  t += 30000;
  assert.equal(l.take('a').retryAfter, 30);
  t += 30001;
  assert.ok(l.take('a').ok);
  t += 120000;
  l.take('zzz'); // triggers the sweep
  assert.ok(l.size() <= 2);
});

test('rate limiter middleware answers 429 JSON with Retry-After', () => {
  const l = createLimiter({ limit: 1, windowMs: 60000 });
  const run = () => {
    const out = { headers: {} };
    const res = { set: (k, v) => { out.headers[k] = v; }, status: (c) => { out.code = c; return res; }, json: (b) => { out.body = b; } };
    let nexted = false;
    l.middleware({ ip: '9.9.9.9' }, res, () => { nexted = true; });
    return { nexted, ...out };
  };
  assert.equal(run().nexted, true);
  const r = run();
  assert.equal(r.code, 429);
  assert.equal(r.body.error, 'rate_limited');
  assert.ok(r.body.retryAfter >= 1);
  assert.equal(r.headers['Retry-After'], String(r.body.retryAfter));
});

// ---------- DeepL and Gemini (offered through testKeys, /api/test and the configure page) ----------
// Fake keys are built at runtime, so no file holds a literal that secret scanners take for a real key.
const DEEPL_PRO = ['0123abcd', '4567', '89ef', '0123', '456789abcdef'].join('-');
const DEEPL_FREE = `${DEEPL_PRO}:fx`;
const GEMINI_KEY = 'AIza' + 'SyTestKey0123456789abcdefghijklmnop';

test('DeepL: usage on the host that belongs to the key; ok gives used and limit; the key only in the Authorization header', async () => {
  const seen = [];
  const mk = (r) => async (url, opts) => { seen.push({ url: String(url), method: opts.method, headers: opts.headers }); return typeof r === 'function' ? r() : r; };
  assert.deepEqual(await testDeepl({ apiKey: DEEPL_FREE }, mk(res(200, { character_count: 8258, character_limit: 1000000 }))), { status: 'ok', used: 8258, limit: 1000000 });
  assert.equal(seen[0].url, 'https://api-free.deepl.com/v2/usage');
  assert.equal(seen[0].headers.Authorization, `DeepL-Auth-Key ${DEEPL_FREE}`);
  assert.ok(!seen[0].url.includes('0123abcd'));
  await testDeepl({ apiKey: DEEPL_PRO }, mk(res(200, {})));
  assert.equal(seen[1].url, 'https://api.deepl.com/v2/usage');
  assert.ok(seen.every((s) => !s.method || s.method === 'GET'));
});

test('DeepL: 403 wrong key, 456 or a full counter is quota, 429 rate, 500 and timeout unreachable, an odd body still means the key works', async () => {
  const mk = (r) => async () => (typeof r === 'function' ? r() : r);
  assert.deepEqual(await testDeepl({ apiKey: DEEPL_FREE }, mk(res(403, { message: 'Forbidden' }))), { status: 'bad_key' });
  assert.deepEqual(await testDeepl({ apiKey: DEEPL_FREE }, mk(res(456, { message: 'Quota exceeded' }))), { status: 'quota', reason: 'monthly' });
  assert.deepEqual(await testDeepl({ apiKey: DEEPL_FREE }, mk(res(200, { character_count: 500000, character_limit: 500000 }))), { status: 'quota', reason: 'monthly', used: 500000, limit: 500000 });
  assert.deepEqual(await testDeepl({ apiKey: DEEPL_FREE }, mk(res(429))), { status: 'limit' });
  assert.deepEqual(await testDeepl({ apiKey: DEEPL_FREE }, mk(res(500))), { status: 'unreachable' });
  assert.deepEqual(await testDeepl({ apiKey: DEEPL_FREE }, mk(timeout)), { status: 'unreachable' });
  assert.deepEqual(await testDeepl({ apiKey: DEEPL_FREE }, mk(new Response('not json', { status: 200 }))), { status: 'ok' });
  assert.deepEqual(await testDeepl({ apiKey: DEEPL_FREE }, mk(res(200, { character_count: 'x' }))), { status: 'ok' });
});

test('Gemini: a free model-list call with the key in the x-goog-api-key header only; 400 API_KEY_INVALID and 403 are a wrong key', async () => {
  const seen = [];
  const mk = (r) => async (url, opts) => { seen.push({ url: String(url), method: opts.method, headers: opts.headers, body: opts.body }); return typeof r === 'function' ? r() : r; };
  assert.deepEqual(await testGemini({ apiKey: GEMINI_KEY }, mk(res(200, { models: [] }))), { status: 'ok' });
  assert.equal(seen[0].url, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1');
  assert.ok(!seen[0].method || seen[0].method === 'GET');
  assert.equal(seen[0].body, undefined); // no prompt, so no tokens
  assert.equal(seen[0].headers['x-goog-api-key'], GEMINI_KEY);
  assert.ok(!seen[0].url.includes('AIza'));
  const invalid = { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } };
  assert.deepEqual(await testGemini({ apiKey: GEMINI_KEY }, mk(res(400, invalid))), { status: 'bad_key' });
  assert.deepEqual(await testGemini({ apiKey: GEMINI_KEY }, mk(res(403, { error: { status: 'PERMISSION_DENIED' } }))), { status: 'bad_key' });
  assert.deepEqual(await testGemini({ apiKey: GEMINI_KEY }, mk(res(400, { error: { message: 'something else' } }))), { status: 'unreachable' });
  assert.deepEqual(await testGemini({ apiKey: GEMINI_KEY }, mk(res(429, { error: { status: 'RESOURCE_EXHAUSTED' } }))), { status: 'limit' });
  assert.deepEqual(await testGemini({ apiKey: GEMINI_KEY }, mk(res(503))), { status: 'unreachable' });
  assert.deepEqual(await testGemini({ apiKey: GEMINI_KEY }, mk(timeout)), { status: 'unreachable' });
});

test('DeepL and Gemini are in testKeys (so in /api/test): only entered keys are tested, one free call each', async () => {
  const urls = [];
  const f = async (u) => { urls.push(String(u)); return String(u).includes('deepl') ? res(200, { character_count: 1200, character_limit: 500000 }) : res(200, { models: [] }); };
  assert.deepEqual(await testKeys({ deepl: { apiKey: DEEPL_FREE }, gemini: { apiKey: GEMINI_KEY } }, f), {
    deepl: { status: 'ok', used: 1200, limit: 500000 }, gemini: { status: 'ok' },
  });
  assert.deepEqual(urls.sort(), ['https://api-free.deepl.com/v2/usage', 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1']);
  urls.length = 0;
  assert.deepEqual(await testKeys({ deepl: { apiKey: '  ' }, gemini: {} }, f), {});
  assert.equal(urls.length, 0);
});

test('DeepL and Gemini results never carry text, so nothing from the response or the key can leak', async () => {
  const echo = res(500, { message: `Boom ${DEEPL_FREE} https://api-free.deepl.com/x` });
  const out = [await testDeepl({ apiKey: DEEPL_FREE }, async () => echo), await testGemini({ apiKey: GEMINI_KEY }, async () => { throw new Error(`https://x/?key=${GEMINI_KEY}`); })];
  assert.deepEqual(out, [{ status: 'unreachable' }, { status: 'unreachable' }]);
  assert.ok(!JSON.stringify(out).includes('Boom') && !JSON.stringify(out).includes('AIza'));
});

// ---------- one DeepL host (the pipeline's), every status, and no key anywhere it should not be ----------
test('DeepL: the key test and ai/deepl.js pick the same host (":fx" key: api-free, other key: pro), and a 403 is not retried', async () => {
  const calls = [];
  const mk = (answers) => async (url) => { calls.push(String(url)); return answers.shift(); };
  for (const key of [DEEPL_FREE, DEEPL_PRO]) {
    calls.length = 0;
    assert.deepEqual(await testDeepl({ apiKey: key }, mk([res(403)])), { status: 'bad_key' });
    assert.deepEqual(calls, [`${deeplHost(key)}/v2/usage`]);
  }
  assert.equal(deeplHost(DEEPL_FREE), 'https://api-free.deepl.com');
  assert.equal(deeplHost(DEEPL_PRO), 'https://api.deepl.com');
  calls.length = 0;
  assert.deepEqual(await testDeepl({ apiKey: DEEPL_FREE }, mk([res(456)])), { status: 'quota', reason: 'monthly' });
  assert.deepEqual(await testDeepl({ apiKey: DEEPL_FREE }, mk([res(429)])), { status: 'limit' });
  assert.deepEqual(await testDeepl({ apiKey: DEEPL_FREE }, mk([res(500)])), { status: 'unreachable' });
  assert.equal(calls.length, 3, 'one call each, no retry');
});

test('DeepL and Gemini through testKeys: no key value in any URL that was fetched, in any request body, in the results, or in any log line', async () => {
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const m of Object.keys(orig)) console[m] = (...a) => logs.push(a.map(String).join(' '));
  const seen = [];
  const f = async (u, o) => {
    seen.push({ url: String(u), headers: o.headers, body: o.body });
    if (String(u).includes('deepl')) return res(403, { message: `Forbidden ${DEEPL_FREE}` });
    return res(400, { error: { message: 'API key not valid', details: [{ reason: 'API_KEY_INVALID' }] } });
  };
  let out;
  try { out = await testKeys({ deepl: { apiKey: DEEPL_FREE }, gemini: { apiKey: GEMINI_KEY } }, f); }
  finally { Object.assign(console, orig); }
  assert.deepEqual(out, { deepl: { status: 'bad_key' }, gemini: { status: 'bad_key' } });
  assert.equal(seen.length, 2, 'DeepL once, Gemini once');
  for (const s of seen) {
    assert.ok(!s.url.includes('0123abcd') && !s.url.includes('AIza') && !/key=/i.test(s.url), s.url);
    assert.equal(s.body, undefined);
  }
  assert.ok(seen.filter((s) => s.url.includes('deepl')).every((s) => s.headers.Authorization === `DeepL-Auth-Key ${DEEPL_FREE}`));
  assert.equal(seen.find((s) => s.url.includes('googleapis')).headers['x-goog-api-key'], GEMINI_KEY);
  const everything = JSON.stringify(out) + logs.join('\n');
  assert.ok(!everything.includes('0123abcd') && !everything.includes('AIza'));
  assert.equal(logs.length, 0, 'keytest logs nothing; index.js logs only "[test] provider=status"');
});
