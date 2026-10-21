// Shared AI plumbing (http.js) and the two time helpers added to health.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AiError, redactReason, looksLikeKey, parseRetryAfter, backoffMs, aiRequest } from '../src/lib/ai/http.js';
import { nextUtcMonthStart, nextPacificMidnight } from '../src/lib/health.js';

// Fake keys are built at runtime, so no file holds a literal that secret scanners take for a real key.
const GOOGLE_SHAPED = 'AIza' + 'SyA1234567890abcdefghijklmnop';
const deeplShaped = (...parts) => `${parts.join('-')}:fx`;

const json = (status, body = {}, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

test('redactReason: removes keys (also URL-encoded), URLs and key shapes; collapses whitespace; cuts to 80 characters', () => {
  const key = 'abc123SECRET:fx';
  assert.equal(redactReason(`bad key ${key} and ${encodeURIComponent(key)}`, [key]), 'bad key <key> and <key>');
  assert.equal(redactReason('see https://api.deepl.com/v2/translate?auth_key=zzz now'), 'see <url> now');
  assert.equal(redactReason('line one\n\n  line   two\t!'), 'line one line two !');
  assert.equal(redactReason('x'.repeat(500)).length, 80);
  assert.equal(redactReason(`key ${GOOGLE_SHAPED} leaked`), 'key <key> leaked');
  const deepl = deeplShaped('1234abcd', 'ffff', '0000', '1111', '123456789abc');
  assert.equal(redactReason(`header DeepL-Auth-Key ${deepl} here`), 'header DeepL-Auth-Key <key> here');
  assert.equal(redactReason(deepl), '<key>');
  assert.equal(redactReason(undefined), '');
  assert.equal(redactReason(null, ['abcdefgh']), '');
  // the key is removed before the cut, so a key at the 80-character edge cannot leak half of itself
  const edge = `${'a'.repeat(70)}${'SECRETKEY99'}`;
  assert.ok(!redactReason(edge, ['SECRETKEY99']).includes('SECRET'));
  assert.equal(redactReason('contains ab', ['ab']), 'contains ab'); // keys shorter than 4 characters are ignored
});

test('looksLikeKey accepts real key shapes and rejects anything that could break a header', () => {
  for (const ok of [deeplShaped('0123abcd', '4567', '89ef', '0123', '456789abcdef'), `${GOOGLE_SHAPED}qrstu`, ' padded-key-12345678 ']) assert.equal(looksLikeKey(ok), true, ok);
  for (const bad of ['', 'short', 'two words 12345678', 'new\nline123456', 'tab\there1234567', undefined, null, 12345678, 'x'.repeat(300), 'ключ-1234567890']) assert.equal(looksLikeKey(bad), false, String(bad));
});

test('parseRetryAfter: seconds, HTTP date, junk', () => {
  const h = (v) => new Headers(v == null ? {} : { 'Retry-After': v });
  assert.equal(parseRetryAfter(h('5')), 5000);
  assert.equal(parseRetryAfter(h('0')), 0);
  assert.equal(parseRetryAfter(h('1.5')), 1500);
  assert.equal(parseRetryAfter(h(null)), null);
  assert.equal(parseRetryAfter(h('soon')), null);
  assert.equal(parseRetryAfter(h(new Date(10_000).toUTCString()), 4_000), 6000);
  assert.equal(parseRetryAfter(h(new Date(1_000).toUTCString()), 4_000), 0); // in the past
  assert.equal(parseRetryAfter(undefined), null);
});

test('backoffMs: 2 s, 4 s, 8 s, ... never over 60 s', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
});

test('AiError carries a code, a status and a quota flag, and no cause', () => {
  const e = new AiError('x', { code: 'quota', status: 456 });
  assert.equal(e.name, 'AiError'); assert.equal(e.quota, true); assert.equal(e.status, 456); assert.equal(e.cause, undefined);
  assert.equal(new AiError('y').code, 'http');
  assert.equal(new AiError('y', { code: 'rate' }).quota, false);
});

test('aiRequest: at most maxTries attempts, onError can stop at once or set the wait, and only AiError is thrown', async () => {
  const sleeps = [];
  const base = { url: 'https://x.test/a', label: 'T', sleep: async (ms) => sleeps.push(ms), log: () => {} };
  let calls = 0;
  const f = async () => { calls++; return json(503, { message: 'busy' }); };
  await assert.rejects(() => aiRequest({ ...base, fetchImpl: f, maxTries: 2 }), (e) => e instanceof AiError && e.code === 'unavailable');
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [2000]);

  sleeps.length = 0; calls = 0;
  await assert.rejects(() => aiRequest({ ...base, fetchImpl: f, onError: (s) => { throw new AiError('stop', { code: 'quota', status: s }); } }), (e) => e.code === 'quota');
  assert.equal(calls, 1);

  sleeps.length = 0; calls = 0;
  const g = async () => { calls++; return calls < 3 ? json(429, {}) : json(200, { ok: true }); };
  const r = await aiRequest({ ...base, fetchImpl: g, onError: () => ({ waitMs: 1234 }) });
  assert.equal(r.status, 200);
  assert.deepEqual(sleeps, [1234, 1234]);

  sleeps.length = 0;
  await assert.rejects(() => aiRequest({ ...base, fetchImpl: async () => json(429, {}), onError: () => ({ waitMs: 999999 }) }), (e) => e.code === 'rate');
  assert.deepEqual(sleeps, [60000, 60000, 60000]);

  await assert.rejects(() => aiRequest({ ...base, fetchImpl: async () => { throw new Error('secret https://x.test/?k=1'); }, maxTries: 1 }), (e) => e instanceof AiError && !/secret|x\.test/.test(e.message));
});

test('nextUtcMonthStart: the first instant of the next month, also across the year end', () => {
  assert.equal(new Date(nextUtcMonthStart(Date.UTC(2026, 9, 18, 10))).toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(new Date(nextUtcMonthStart(Date.UTC(2026, 11, 31, 23, 59, 59))).toISOString(), '2027-01-01T00:00:00.000Z');
  assert.equal(new Date(nextUtcMonthStart(Date.UTC(2028, 0, 31))).toISOString(), '2028-02-01T00:00:00.000Z');
  assert.equal(new Date(nextUtcMonthStart(Date.UTC(2026, 10, 1, 0, 0, 0))).toISOString(), '2026-12-01T00:00:00.000Z'); // exactly on the 1st: the next 1st
});

test('nextPacificMidnight: 07:00 UTC in summer (PDT), 08:00 UTC in winter (PST), a full day when it is exactly midnight there', () => {
  const iso = (ms) => new Date(ms).toISOString();
  assert.equal(iso(nextPacificMidnight(Date.UTC(2026, 9, 18, 20, 0, 0))), '2026-10-19T07:00:00.000Z');
  assert.equal(iso(nextPacificMidnight(Date.UTC(2026, 9, 19, 6, 59, 59, 999))), '2026-10-19T07:00:00.000Z');
  assert.equal(iso(nextPacificMidnight(Date.UTC(2026, 9, 19, 7, 0, 0))), '2026-10-20T07:00:00.000Z');
  assert.equal(iso(nextPacificMidnight(Date.UTC(2026, 11, 10, 20, 0, 0))), '2026-12-11T08:00:00.000Z');
  assert.equal(iso(nextPacificMidnight(Date.UTC(2026, 0, 15, 0, 0, 0, 1))), '2026-01-15T08:00:00.000Z'); // 16:00 on Jan 14 in LA
  assert.ok(nextPacificMidnight() > Date.now());
});
