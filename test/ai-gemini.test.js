// Gemini client: offline, fetch and sleep injected. Nothing here touches the network or a real key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { translate, polish, flashCandidates, thinkingLevel } from '../src/lib/ai/gemini.js';
import { AiError } from '../src/lib/ai/http.js';
import { SYSTEM_TRANSLATE, SYSTEM_POLISH, systemPrompt, translateUser, polishUser, retryNote } from '../src/lib/ai/prompts.js';
import { isExhausted, scopeOf } from '../src/lib/health.js';
import { passesCharCheck } from '../src/lib/ai/validate.js';
import { setAiStore } from '../src/lib/cache.js';

// spent models are written to the AI store: keep them in memory here, never in the disk cache
const mem = new Map();
setAiStore({ async get(k, { kind }) { return mem.get(`${kind}:${k}`) ?? null; }, async set(k, b, o = {}) { mem.set(`${o.kind}:${k}`, b); }, async del() { return true; } });

let n = 0;
const newKey = () => `AIzaSyTest${process.pid}x${++n}abcdefghijklmnopqrstuvw`; // one key per test: quota state is kept per key
const newModel = () => `gemini-test${process.pid}x${++n}-flash`; // one model per test: "rejects thinking" is remembered per model
const json = (status, body = {}, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const answer = (items, extra = {}) => json(200, {
  candidates: [{ content: { parts: [{ text: JSON.stringify(items) }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 45, thoughtsTokenCount: 7 }, ...extra,
});
const quotaBody = (quotaId, retryDelay, message = 'You exceeded your current quota, please check your plan and billing details.') => ({
  error: { code: 429, message, status: 'RESOURCE_EXHAUSTED', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId, quotaValue: '20' }] },
    ...(retryDelay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] : []),
  ] },
});

const PAGE1 = { models: [
  { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3-flash-preview', supportedGenerationMethods: ['generateContent'] },
], nextPageToken: 'p2' };
const PAGE2 = { models: [
  { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
  { name: 'models/gemini-3.8-flash-001', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.8-flash-image', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/embedding-flash-001', supportedGenerationMethods: ['embedContent'] },
] };

/** Fake Gemini. reply(call, generateNumber) may return a Response. Default: the model list (two pages) and "EL <i>" for each requested cue. */
function fakeGemini(reply) {
  const calls = [];
  let inFlight = 0, maxInFlight = 0, generates = 0;
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const call = { url: String(url), path: u.pathname, search: u.search, method: init.method || 'GET', headers: init.headers, raw: init.body, body: init.body ? JSON.parse(init.body) : null, signal: init.signal };
    calls.push(call);
    const isGenerate = call.path.endsWith(':generateContent');
    if (isGenerate) generates++;
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (reply) { const r = await reply(call, generates); if (r) return r; }
      if (call.path.endsWith('/models')) return json(200, u.searchParams.get('pageToken') === 'p2' ? PAGE2 : PAGE1);
      const want = Number(/exactly (\d+) strings/.exec(call.body.contents[0].parts[0].text)?.[1] ?? 0);
      return answer(Array.from({ length: want }, (_, i) => `EL ${i}`));
    } finally { inFlight--; }
  };
  return { fetchImpl, calls, generateCalls: () => calls.filter((c) => c.path.endsWith(':generateContent')), maxInFlight: () => maxInFlight };
}
const env = () => {
  const sleeps = [], logs = [];
  return { sleeps, logs, sleep: async (ms) => { sleeps.push(ms); }, log: (m) => logs.push(m) };
};
/** Log lines without the one-per-request "[ai] gemini call=..." lines. */
const notes = (logs) => logs.filter((l) => !/^\[ai\] gemini call=/.test(l));
const TEXTS = ['Hello there.', 'I thought we were done with Laroche.'];

test('thinkingLevel: LOW by default; MINIMAL, MEDIUM, HIGH accepted in any case; junk gives LOW; UNSET sends nothing', () => {
  assert.equal(thinkingLevel({}), 'LOW');
  assert.equal(thinkingLevel({ AI_GEMINI_THINKING: '' }), 'LOW');
  assert.equal(thinkingLevel({ AI_GEMINI_THINKING: 'high' }), 'HIGH');
  assert.equal(thinkingLevel({ AI_GEMINI_THINKING: ' Medium ' }), 'MEDIUM');
  assert.equal(thinkingLevel({ AI_GEMINI_THINKING: 'minimal' }), 'MINIMAL');
  assert.equal(thinkingLevel({ AI_GEMINI_THINKING: 'banana' }), 'LOW');
  assert.equal(thinkingLevel({ AI_GEMINI_THINKING: '0' }), 'LOW');
  assert.equal(thinkingLevel({ AI_GEMINI_THINKING: 'unset' }), null);
  assert.equal(thinkingLevel({ AI_GEMINI_THINKING: 'DEFAULT' }), null);
});

test('request: the key only in x-goog-api-key, model from AI_GEMINI_MODEL (no model list call), schema, temperature, LOW thinking', async () => {
  const key = newKey(), model = newModel(); const f = fakeGemini(); const e = env();
  const r = await translate({ key, texts: TEXTS, context: ['earlier cue'], env: { AI_GEMINI_MODEL: `models/${model}` }, fetchImpl: f.fetchImpl, ...e });
  assert.deepEqual(r.items, ['EL 0', 'EL 1']);
  assert.equal(r.model, model);
  assert.deepEqual(r.usage, { prompt: 120, output: 45, thoughts: 7 });
  assert.equal(f.calls.length, 1); // no list request
  const c = f.calls[0];
  assert.equal(c.method, 'POST');
  assert.equal(c.path, `/v1beta/models/${model}:generateContent`);
  assert.equal(c.search, '');
  assert.equal(c.headers['x-goog-api-key'], key);
  assert.equal(c.headers['Content-Type'], 'application/json');
  assert.ok(!c.url.includes(key) && !c.raw.includes(key));
  assert.equal(c.body.systemInstruction.parts[0].text, SYSTEM_TRANSLATE);
  assert.equal(c.body.contents[0].role, 'user');
  assert.equal(c.body.contents[0].parts[0].text, translateUser({ context: ['earlier cue'], texts: TEXTS }));
  assert.deepEqual(c.body.generationConfig, {
    temperature: 0.3, responseMimeType: 'application/json',
    responseSchema: { type: 'ARRAY', items: { type: 'STRING' } }, thinkingConfig: { thinkingLevel: 'LOW' },
  });
  assert.ok(c.signal instanceof AbortSignal);
});

test('thinking: AI_GEMINI_THINKING sets thinkingLevel, UNSET leaves thinkingConfig out, thinkingBudget is never sent', async () => {
  const seen = [];
  for (const [value, expected] of [[undefined, 'LOW'], ['HIGH', 'HIGH'], ['medium', 'MEDIUM'], ['minimal', 'MINIMAL'], ['junk', 'LOW'], ['unset', undefined]]) {
    const f = fakeGemini();
    await translate({ key: newKey(), texts: ['a'], env: { AI_GEMINI_MODEL: newModel(), ...(value ? { AI_GEMINI_THINKING: value } : {}) }, fetchImpl: f.fetchImpl, ...env() });
    const raw = f.calls[0].raw;
    assert.ok(!/thinkingBudget|thinking_budget/i.test(raw), `thinkingBudget sent for ${value}`);
    seen.push(f.calls[0].body.generationConfig.thinkingConfig?.thinkingLevel);
    assert.equal(seen.at(-1), expected, String(value));
    if (expected === undefined) assert.ok(!('thinkingConfig' in f.calls[0].body.generationConfig));
  }
});

test('a model that rejects the thinking level is retried once without it, and remembered', async () => {
  const key = newKey(), model = newModel(); const e = env();
  const f = fakeGemini((call, number) => (call.body?.generationConfig?.thinkingConfig
    ? json(400, { error: { code: 400, message: 'Thinking level LOW is not supported for this model.', status: 'INVALID_ARGUMENT' } }) : null));
  const r = await translate({ key, texts: ['a'], env: { AI_GEMINI_MODEL: model }, fetchImpl: f.fetchImpl, ...e });
  assert.deepEqual(r.items, ['EL 0']);
  assert.deepEqual(f.generateCalls().map((c) => 'thinkingConfig' in c.body.generationConfig), [true, false]);
  assert.equal(notes(e.logs).length, 1);
  assert.deepEqual(e.sleeps, []); // no waiting for this
  await translate({ key, texts: ['a'], env: { AI_GEMINI_MODEL: model }, fetchImpl: f.fetchImpl, ...e });
  assert.deepEqual(f.generateCalls().map((c) => 'thinkingConfig' in c.body.generationConfig), [true, false, false]); // remembered

  // another 400 that is not about thinking is a plain bad_request, not retried
  const g = fakeGemini(() => json(400, { error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT' } }));
  await assert.rejects(() => translate({ key: newKey(), texts: ['a'], env: { AI_GEMINI_MODEL: newModel() }, fetchImpl: g.fetchImpl, ...env() }), (er) => er.code === 'bad_request');
  assert.equal(g.generateCalls().length, 1);
});

test('model list: paged, only Flash models that can generate, stable before preview, newest first; the first one is used and the list is remembered', async () => {
  const key = newKey(); const f = fakeGemini(); const e = env();
  const r = await translate({ key, texts: ['a'], env: {}, fetchImpl: f.fetchImpl, ...e });
  assert.equal(r.model, 'gemini-3.8-flash');
  assert.deepEqual(f.calls.map((c) => c.path + c.search), ['/v1beta/models?pageSize=200', '/v1beta/models?pageSize=200&pageToken=p2', '/v1beta/models/gemini-3.8-flash:generateContent']);
  assert.ok(f.calls.slice(0, 2).every((c) => c.headers['x-goog-api-key'] === key && !c.url.includes(key)));
  await translate({ key, texts: ['a'], env: {}, fetchImpl: f.fetchImpl, ...e });
  assert.equal(f.calls.length, 4); // second call: no new list request
});

test('flashCandidates: the Flash filter and order', () => {
  const names = ['models/gemini-3.8-flash', 'models/gemini-3.7-flash', 'models/gemini-3.5-flash-lite', 'models/gemini-2.5-flash', 'models/gemini-3-flash-preview',
    'models/gemini-3.8-flash-001', 'models/gemini-embedding-001', 'models/gemini-2.5-flash-image', 'models/gemini-3.8-flash-live', 'models/gemini-2.0-flash-exp', 'models/gemini-2.5-pro',
    'models/gemini-2.5-flash-tts', 'models/gemini-2.5-flash-thinking'];
  assert.deepEqual(flashCandidates(names), ['gemini-3.8-flash', 'gemini-3.8-flash-001', 'gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-3-flash-preview']);
  assert.deepEqual(flashCandidates([]), []);
});

test('no usable model in the list: not_found; a rejected key on the list call: bad_key', async () => {
  const none = fakeGemini((call) => (call.path.endsWith('/models') ? json(200, { models: [{ name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] }] }) : null));
  await assert.rejects(() => translate({ key: newKey(), texts: ['a'], env: {}, fetchImpl: none.fetchImpl, ...env() }), (e) => e.code === 'not_found');
  const bad = fakeGemini(() => json(403, { error: { code: 403, message: 'API key not valid', status: 'PERMISSION_DENIED' } }));
  await assert.rejects(() => translate({ key: newKey(), texts: ['a'], env: {}, fetchImpl: bad.fetchImpl, ...env() }), (e) => e.code === 'bad_key');
});

test('a model that is gone (404) moves to the next candidate, at most twice; a forced model is not replaced', async () => {
  const key = newKey(); const e = env();
  const f = fakeGemini((call) => (/gemini-3\.8-flash(-001)?:generateContent/.test(call.path) ? json(404, { error: { code: 404, message: 'models/x is not found', status: 'NOT_FOUND' } }) : null));
  const r = await translate({ key, texts: ['a'], env: {}, fetchImpl: f.fetchImpl, ...e });
  assert.equal(r.model, 'gemini-2.5-flash'); // 3.8-flash and 3.8-flash-001 failed
  assert.deepEqual(f.generateCalls().map((c) => c.path.split('/').pop()), ['gemini-3.8-flash:generateContent', 'gemini-3.8-flash-001:generateContent', 'gemini-2.5-flash:generateContent']);

  const forced = fakeGemini(() => json(404, { error: { code: 404, message: 'not found', status: 'NOT_FOUND' } }));
  await assert.rejects(() => translate({ key: newKey(), texts: ['a'], env: { AI_GEMINI_MODEL: newModel() }, fetchImpl: forced.fetchImpl, ...env() }), (er) => er.code === 'not_found');
  assert.equal(forced.calls.length, 1);
});

test('polish: the setup-C system prompt, the {en, draft} user message, the glossary sentence, a retry note, the context', async () => {
  const f = fakeGemini(); const key = newKey();
  const cuesIn = [{ en: 'Hello.', draft: 'Γεια.' }, { en: 'Laroche is here.', draft: 'Ο Λαρόш είναι εδώ.' }];
  const glossary = { Laroche: 'Λαρός', Nonsense: 'no greek letters here' };
  const note = retryNote('cues 2 contain characters other than Greek or Latin letters', 2);
  await polish({ key, cues: cuesIn, context: ['c1', 'c2'], glossary, note, env: { AI_GEMINI_MODEL: newModel() }, fetchImpl: f.fetchImpl, ...env() });
  const b = f.calls[0].body;
  assert.equal(b.systemInstruction.parts[0].text, systemPrompt('polish', glossary));
  assert.ok(b.systemInstruction.parts[0].text.startsWith(SYSTEM_POLISH));
  assert.match(b.systemInstruction.parts[0].text, /"Laroche":"Λαρός"/);
  assert.ok(!b.systemInstruction.parts[0].text.includes('Nonsense'));
  assert.equal(b.contents[0].parts[0].text, polishUser({ context: ['c1', 'c2'], cues: cuesIn }) + note);
  assert.match(b.contents[0].parts[0].text, /Improve the Greek draft of these 2 cues/);
  // no glossary: the system prompt is the base text, nothing added
  const g = fakeGemini();
  await polish({ key, cues: cuesIn, env: { AI_GEMINI_MODEL: newModel() }, fetchImpl: g.fetchImpl, ...env() });
  assert.equal(g.calls[0].body.systemInstruction.parts[0].text, SYSTEM_POLISH);
});

test('the answer is returned as the model wrote it: a wrong count and a Cyrillic letter are left to the validator', async () => {
  const f = fakeGemini(() => answer(['Νόμιζα με τον Λαρόш.']));
  const r = await translate({ key: newKey(), texts: ['a', 'b', 'c'], env: { AI_GEMINI_MODEL: newModel() }, fetchImpl: f.fetchImpl, ...env() });
  assert.deepEqual(r.items, ['Νόμιζα με τον Λαρόш.']);
  assert.equal(passesCharCheck(r.items[0]), false);
});

test('answer parsing: thought parts are skipped, a wrapped list is accepted, bad JSON / empty / blocked answers are bad_response', async () => {
  const run = (reply) => translate({ key: newKey(), texts: ['a'], env: { AI_GEMINI_MODEL: newModel() }, fetchImpl: fakeGemini(() => reply).fetchImpl, ...env() });
  const withThought = json(200, { candidates: [{ content: { parts: [{ thought: true, text: 'thinking about it' }, { text: '["ένα"]' }] } }] });
  assert.deepEqual((await run(withThought)).items, ['ένα']);
  assert.deepEqual((await run(json(200, { candidates: [{ content: { parts: [{ text: '{"translations":["ένα"]}' }] } }] }))).items, ['ένα']);
  assert.deepEqual((await run(json(200, { candidates: [{ content: { parts: [{ text: '["ένα"]' }] } }] }))).usage, { prompt: 0, output: 0, thoughts: 0 });
  for (const [reply, rx] of [
    [json(200, { candidates: [{ content: { parts: [{ text: 'not json at all' }] }, finishReason: 'MAX_TOKENS' }] }), /not valid JSON \(MAX_TOKENS\)/],
    [json(200, { candidates: [{ content: { parts: [{ text: '"just a string"' }] } }] }), /not a list/],
    [json(200, { candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }] }), /not a list/],
    [json(200, { candidates: [] }), /no text/],
    [json(200, { promptFeedback: { blockReason: 'SAFETY' } }), /no text \(SAFETY\)/],
    [json(200, { candidates: [{ finishReason: 'SAFETY' }] }), /no text \(SAFETY\)/],
    [new Response('<html>', { status: 200 }), /not understood/],
  ]) {
    await assert.rejects(() => run(reply), (e) => e instanceof AiError && e.code === 'bad_response' && rx.test(e.message), String(rx));
  }
});

test('429 on a per-minute limit: waits the server\'s retryDelay (capped at 60 s), then succeeds', async () => {
  for (const [delay, expected] of [['12s', 12000], ['0.4s', 400], ['120s', 60000]]) {
    const f = fakeGemini((call, number) => (number === 1 ? json(429, quotaBody('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', delay)) : null)); const e = env();
    const r = await translate({ key: newKey(), texts: ['a'], env: { AI_GEMINI_MODEL: newModel() }, fetchImpl: f.fetchImpl, ...e });
    assert.deepEqual(r.items, ['EL 0']);
    assert.deepEqual(e.sleeps, [expected], delay);
    assert.equal(f.generateCalls().length, 2);
  }
  // no hint in the body: Retry-After, else 2 s / 4 s / 8 s
  const h = fakeGemini((call, number) => (number === 1 ? json(429, { error: { code: 429, message: 'slow down', status: 'RESOURCE_EXHAUSTED' } }, { 'Retry-After': '5' }) : null)); const e2 = env();
  await translate({ key: newKey(), texts: ['a'], env: { AI_GEMINI_MODEL: newModel() }, fetchImpl: h.fetchImpl, ...e2 });
  assert.deepEqual(e2.sleeps, [5000]);
  const g = fakeGemini(() => json(429, { error: { code: 429, message: 'slow down', status: 'RESOURCE_EXHAUSTED' } })); const e3 = env();
  await assert.rejects(() => translate({ key: newKey(), texts: ['a'], env: { AI_GEMINI_MODEL: newModel() }, fetchImpl: g.fetchImpl, ...e3 }), (er) => er.code === 'rate' && er.status === 429);
  assert.equal(g.generateCalls().length, 4); // at most 4 tries
  assert.deepEqual(e3.sleeps, [2000, 4000, 8000]);
});

test('503: retried with 2 s / 4 s / 8 s; success on the 4th try is fine; a 4th failure gives unavailable; 500 is retried too', async () => {
  const f = fakeGemini((call, number) => (number < 4 ? json(503, { error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } }) : null)); const e = env();
  const r = await translate({ key: newKey(), texts: ['a'], env: { AI_GEMINI_MODEL: newModel() }, fetchImpl: f.fetchImpl, ...e });
  assert.deepEqual(r.items, ['EL 0']);
  assert.deepEqual(e.sleeps, [2000, 4000, 8000]);
  assert.equal(f.generateCalls().length, 4);

  for (const status of [503, 500]) {
    const down = fakeGemini(() => json(status, { error: { code: status, message: 'busy', status: 'UNAVAILABLE' } })); const e2 = env();
    await assert.rejects(() => translate({ key: newKey(), texts: ['a'], env: { AI_GEMINI_MODEL: newModel() }, fetchImpl: down.fetchImpl, ...e2 }), (er) => er.code === 'unavailable' && er.status === status);
    assert.equal(down.generateCalls().length, 4);
  }
});

test('429 on a per-day quota: no retry, the key is marked exhausted until midnight Pacific, later calls make no request', async (t) => {
  let clock = Date.UTC(2026, 9, 18, 20, 0, 0); // 13:00 in Los Angeles (PDT)
  t.mock.method(Date, 'now', () => clock);
  const key = newKey(); const e = env();
  const f = fakeGemini(() => json(429, quotaBody('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '14s')));
  await assert.rejects(() => translate({ key, texts: ['a'], env: { AI_GEMINI_MODEL: newModel() }, fetchImpl: f.fetchImpl, ...e }), (er) => er instanceof AiError && er.code === 'quota' && er.quota === true && er.status === 429);
  assert.equal(f.generateCalls().length, 1);
  assert.deepEqual(e.sleeps, []); // the 14 s hint is for minute limits: waiting would not help
  assert.equal(notes(e.logs).length, 1);
  assert.match(notes(e.logs)[0], /Gemini daily quota exhausted/);
  assert.equal(isExhausted('gemini', scopeOf({ apiKey: key })), true);

  const before = f.calls.length;
  await assert.rejects(() => polish({ key, cues: [{ en: 'a', draft: 'α' }], env: { AI_GEMINI_MODEL: newModel() }, fetchImpl: f.fetchImpl, ...e }), (er) => er.code === 'quota');
  assert.equal(f.calls.length, before);

  clock = Date.UTC(2026, 9, 19, 6, 59, 59); // 23:59:59 PDT
  assert.equal(isExhausted('gemini', scopeOf({ apiKey: key })), true);
  clock = Date.UTC(2026, 9, 19, 7, 0, 0); // 00:00:00 PDT
  assert.equal(isExhausted('gemini', scopeOf({ apiKey: key })), false);
});

test('per-day quota in winter: midnight Pacific is 08:00 UTC', async (t) => {
  let clock = Date.UTC(2026, 11, 10, 20, 0, 0); // 12:00 in Los Angeles (PST)
  t.mock.method(Date, 'now', () => clock);
  const key = newKey();
  const f = fakeGemini(() => json(429, quotaBody('GenerateRequestsPerDayPerProjectPerModel-FreeTier')));
  await assert.rejects(() => translate({ key, texts: ['a'], env: { AI_GEMINI_MODEL: newModel() }, fetchImpl: f.fetchImpl, ...env() }), (er) => er.code === 'quota');
  clock = Date.UTC(2026, 11, 11, 7, 59, 59);
  assert.equal(isExhausted('gemini', scopeOf({ apiKey: key })), true);
  clock = Date.UTC(2026, 11, 11, 8, 0, 0);
  assert.equal(isExhausted('gemini', scopeOf({ apiKey: key })), false);
});

test('a daily quota is recognised when a per-minute violation is listed too, and from the message alone', async () => {
  const both = { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED', details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }, { quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } };
  const textual = { error: { code: 429, message: 'You exceeded your daily request limit.', status: 'RESOURCE_EXHAUSTED' } };
  for (const body of [both, textual]) {
    const f = fakeGemini(() => json(429, body)); const e = env();
    await assert.rejects(() => translate({ key: newKey(), texts: ['a'], env: { AI_GEMINI_MODEL: newModel() }, fetchImpl: f.fetchImpl, ...e }), (er) => er.code === 'quota');
    assert.equal(f.generateCalls().length, 1);
  }
});

test('a rejected key (400 API_KEY_INVALID, or 403) is bad_key and is not retried', async () => {
  const invalid = { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } };
  for (const reply of [json(400, invalid), json(403, { error: { code: 403, message: 'denied', status: 'PERMISSION_DENIED' } })]) {
    const f = fakeGemini(() => reply.clone()); const e = env();
    await assert.rejects(() => translate({ key: newKey(), texts: ['a'], env: { AI_GEMINI_MODEL: newModel() }, fetchImpl: f.fetchImpl, ...e }), (er) => er.code === 'bad_key');
    assert.equal(f.generateCalls().length, 1);
    assert.deepEqual(e.sleeps, []);
  }
});

test('a timeout is retried (4 tries) and reported as timeout', async () => {
  const f = fakeGemini((call) => new Promise((_, rej) => call.signal.addEventListener('abort', () => rej(call.signal.reason)))); const e = env();
  await assert.rejects(() => translate({ key: newKey(), texts: ['a'], timeoutMs: 20, env: { AI_GEMINI_MODEL: newModel() }, fetchImpl: f.fetchImpl, ...e }), (er) => er.code === 'timeout');
  assert.equal(f.generateCalls().length, 4);
  assert.deepEqual(e.sleeps, [2000, 4000, 8000]);
});

test('one request at a time per key (waits included); different keys can run side by side', async () => {
  const slow = async () => { await new Promise((r) => setTimeout(r, 25)); };
  const same = fakeGemini(slow); const key = newKey(), model = newModel();
  await Promise.all([1, 2, 3].map(() => translate({ key, texts: ['a'], env: { AI_GEMINI_MODEL: model }, fetchImpl: same.fetchImpl, ...env() })));
  assert.equal(same.generateCalls().length, 3);
  assert.equal(same.maxInFlight(), 1);

  const two = fakeGemini(slow);
  await Promise.all([newKey(), newKey()].map((k) => translate({ key: k, texts: ['a'], env: { AI_GEMINI_MODEL: model }, fetchImpl: two.fetchImpl, ...env() })));
  assert.equal(two.maxInFlight(), 2);

  // a failed call does not block the next one for the same key
  const k3 = newKey(); let first = true;
  const flaky = fakeGemini(() => { if (first) { first = false; return json(403, { error: { code: 403, message: 'x', status: 'PERMISSION_DENIED' } }); } return null; });
  const [a, b] = await Promise.allSettled([1, 2].map(() => translate({ key: k3, texts: ['a'], env: { AI_GEMINI_MODEL: model }, fetchImpl: flaky.fetchImpl, ...env() })));
  assert.equal(a.status, 'rejected');
  assert.equal(b.status, 'fulfilled');
});

test('a malformed key fails at once with bad_key and no request', async () => {
  const f = fakeGemini();
  for (const key of [undefined, '', 'short', 'has space in it 123456', 'new\nline-1234567890']) {
    await assert.rejects(() => translate({ key, texts: ['a'], env: { AI_GEMINI_MODEL: newModel() }, fetchImpl: f.fetchImpl, ...env() }), (e) => e.code === 'bad_key');
  }
  assert.equal(f.calls.length, 0);
});

test('redaction: the key never appears in a thrown message, a log line, a request URL or a request body', async (t) => {
  const logged = [];
  t.mock.method(console, 'warn', (...a) => logged.push(a.join(' ')));
  t.mock.method(console, 'log', (...a) => logged.push(a.join(' ')));
  const scenarios = [
    (echo) => json(400, { error: { code: 400, message: echo, status: 'INVALID_ARGUMENT' } }),
    (echo) => json(400, { error: { code: 400, message: echo, status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }),
    (echo) => json(403, { error: { code: 403, message: echo, status: 'PERMISSION_DENIED' } }),
    (echo) => json(404, { error: { code: 404, message: echo, status: 'NOT_FOUND' } }),
    (echo) => json(429, quotaBody('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '1s', echo)),
    (echo) => json(429, quotaBody('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '1s', echo)),
    (echo) => json(503, { error: { code: 503, message: echo, status: 'UNAVAILABLE' } }),
    (echo) => json(500, { message: echo }),
    (echo) => { throw Object.assign(new TypeError(`fetch failed ${echo}`), { cause: new Error(echo) }); },
    (echo) => new Response(echo, { status: 502 }),
    (echo) => json(200, { candidates: [{ content: { parts: [{ text: echo }] }, finishReason: echo }] }),
    (echo) => json(200, { promptFeedback: { blockReason: echo } }),
  ];
  const urls = [], bodies = [], errors = [], keys = [];
  for (const make of scenarios) {
    const key = newKey();
    keys.push(key);
    const echo = `Bad key ${key} (${encodeURIComponent(key)}) at https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=${key}`;
    const own = env();
    const fetchImpl = async (url, init) => { urls.push(String(url)); bodies.push(String(init.body ?? '')); return make(echo); };
    try { await translate({ key, texts: ['Hello.'], env: { AI_GEMINI_MODEL: newModel() }, fetchImpl, ...own }); } catch (e) { errors.push(e); }
    try { await polish({ key, cues: [{ en: 'Hello.', draft: 'Γεια.' }], env: {}, fetchImpl, ...own }); } catch (e) { errors.push(e); } // also the model-list path
    logged.push(...own.logs);
  }
  assert.ok(errors.length >= 20);
  assert.ok(errors.every((e) => e instanceof AiError));
  const everything = [...errors.flatMap((e) => [e.message, e.stack, JSON.stringify(e), String(e.cause ?? '')]), ...logged, ...urls, ...bodies];
  for (const key of keys) {
    for (const s of everything) {
      assert.ok(!s.includes(key), 'key found');
      assert.ok(!s.includes(encodeURIComponent(key)), 'encoded key found');
      assert.ok(!s.includes(key.slice(0, 20)), 'start of the key found');
    }
  }
  assert.ok(errors.every((e) => e.message.length < 160));
});

// ---------- a daily quota is per model: move on to the next Flash model ----------
// Candidate order for PAGE1 + PAGE2: gemini-3.8-flash, gemini-3.8-flash-001, gemini-2.5-flash, gemini-3-flash-preview.
const DAILY = () => json(429, quotaBody('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '14s'));
const onModel = (name) => (call) => call.path.endsWith(`/${name}:generateContent`);
const stateOf = (key, model) => isExhausted(`gemini:${model}`, scopeOf({ apiKey: key }));

test('daily quota on model A: only A is marked, the same request goes to model B, the key stays usable', async () => {
  const key = newKey(), e = env();
  const f = fakeGemini((call) => (onModel('gemini-3.8-flash')(call) ? DAILY() : null));
  const r = await translate({ key, texts: ['a'], fetchImpl: f.fetchImpl, ...e });
  assert.equal(r.model, 'gemini-3.8-flash-001');
  assert.deepEqual(f.generateCalls().map((c) => c.path.split('/').pop()), ['gemini-3.8-flash:generateContent', 'gemini-3.8-flash-001:generateContent']);
  assert.equal(stateOf(key, 'gemini-3.8-flash'), true);
  assert.equal(stateOf(key, 'gemini-3.8-flash-001'), false);
  assert.equal(isExhausted('gemini', scopeOf({ apiKey: key })), false);
  assert.deepEqual(e.sleeps, []); // no waiting: the 14 s hint is for minute limits
  assert.equal(notes(e.logs).length, 1);
  assert.match(notes(e.logs)[0], /gemini-3\.8-flash is out of daily quota: using gemini-3\.8-flash-001/);

  // the next call goes straight to B and never asks A again
  const before = f.generateCalls().length;
  const again = await polish({ key, cues: [{ en: 'a', draft: 'α' }], fetchImpl: f.fetchImpl, ...e });
  assert.equal(again.model, 'gemini-3.8-flash-001');
  assert.equal(f.generateCalls().length, before + 1);
});

test('A and B out, C answers: three requests, C is used', async () => {
  const f = fakeGemini((call) => (onModel('gemini-3.8-flash')(call) || onModel('gemini-3.8-flash-001')(call) ? DAILY() : null));
  const r = await translate({ key: newKey(), texts: ['a'], fetchImpl: f.fetchImpl, ...env() });
  assert.equal(r.model, 'gemini-2.5-flash');
  assert.equal(f.generateCalls().length, 3);
});

test('every model out of daily quota: the key is marked exhausted, quota error, later calls make no request', async () => {
  const key = newKey(), e = env();
  const f = fakeGemini((call) => (call.path.endsWith(':generateContent') ? DAILY() : null));
  await assert.rejects(() => translate({ key, texts: ['a'], fetchImpl: f.fetchImpl, ...e }), (er) => er.code === 'quota' && er.quota === true);
  assert.equal(f.generateCalls().length, 4); // every candidate was tried once
  assert.equal(isExhausted('gemini', scopeOf({ apiKey: key })), true);
  assert.equal(e.logs.filter((l) => /daily quota exhausted for a key/.test(l)).length, 1);
  const before = f.calls.length;
  await assert.rejects(() => translate({ key, texts: ['a'], fetchImpl: f.fetchImpl, ...e }), (er) => er.code === 'quota');
  assert.equal(f.calls.length, before);
});

test('a model that does not exist is skipped, then a daily quota on the next one moves on again', async () => {
  const f = fakeGemini((call) => (onModel('gemini-3.8-flash')(call) ? json(404, { error: { code: 404, message: 'not found', status: 'NOT_FOUND' } }) : onModel('gemini-3.8-flash-001')(call) ? DAILY() : null));
  const r = await translate({ key: newKey(), texts: ['a'], fetchImpl: f.fetchImpl, ...env() });
  assert.equal(r.model, 'gemini-2.5-flash');
});

test('a per-minute 429 only waits and stays on the same model', async () => {
  const key = newKey(), e = env();
  const minute = json(429, quotaBody('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '3s'));
  const f = fakeGemini((call, n) => (call.path.endsWith(':generateContent') && n === 1 ? minute : null));
  const r = await translate({ key, texts: ['a'], fetchImpl: f.fetchImpl, ...e });
  assert.equal(r.model, 'gemini-3.8-flash');
  assert.deepEqual(e.sleeps, [3000]);
  assert.equal(stateOf(key, 'gemini-3.8-flash'), false);
});

test('the per-model state ends at midnight Pacific, after which the model is used again', async (t) => {
  let clock = Date.UTC(2026, 9, 18, 20, 0, 0); // 13:00 in Los Angeles (PDT)
  t.mock.method(Date, 'now', () => clock);
  const key = newKey();
  const f = fakeGemini((call) => (onModel('gemini-3.8-flash')(call) && clock < Date.UTC(2026, 9, 19, 7, 0, 0) ? DAILY() : null));
  await translate({ key, texts: ['a'], fetchImpl: f.fetchImpl, ...env() });
  clock = Date.UTC(2026, 9, 19, 6, 59, 59); // 23:59:59 PDT
  assert.equal(stateOf(key, 'gemini-3.8-flash'), true);
  assert.equal((await translate({ key, texts: ['a'], fetchImpl: f.fetchImpl, ...env() })).model, 'gemini-3.8-flash-001');
  clock = Date.UTC(2026, 9, 19, 7, 0, 0); // 00:00:00 PDT
  assert.equal(stateOf(key, 'gemini-3.8-flash'), false);
  assert.equal((await translate({ key, texts: ['a'], fetchImpl: f.fetchImpl, ...env() })).model, 'gemini-3.8-flash');
});

test('a forced model (AI_GEMINI_MODEL) has no neighbour to move to: the key is marked at once', async () => {
  const key = newKey();
  const f = fakeGemini(() => DAILY());
  await assert.rejects(() => translate({ key, texts: ['a'], env: { AI_GEMINI_MODEL: newModel() }, fetchImpl: f.fetchImpl, ...env() }), (er) => er.code === 'quota');
  assert.equal(f.generateCalls().length, 1);
  assert.equal(isExhausted('gemini', scopeOf({ apiKey: key })), true);
});

test('with model switching, the key appears in no URL, log line or error message, only in the header', async () => {
  const key = newKey(), e = env();
  const f = fakeGemini((call) => (onModel('gemini-3.8-flash')(call) ? json(429, quotaBody('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '1s', `quota for key ${key}`)) : null));
  await translate({ key, texts: ['a'], fetchImpl: f.fetchImpl, ...e });
  const bad = fakeGemini(() => json(429, quotaBody('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '1s', `quota for key ${key}`)));
  const key2 = newKey(); let err;
  await translate({ key: key2, texts: ['a'], fetchImpl: bad.fetchImpl, ...e }).catch((x) => { err = x; });
  for (const c of [...f.calls, ...bad.calls]) assert.ok(!c.url.includes(key) && !c.url.includes(key2) && !(c.raw || '').includes(key) && !(c.raw || '').includes(key2));
  assert.ok(![...e.logs, err.message, JSON.stringify(err)].some((t) => t.includes(key) || t.includes(key2)));
});
