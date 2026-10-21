// The slow first chunk seen live (Tracker S4E2): gemini-3.8-flash slow, then 503, then out of daily quota. Offline replays with a
// fake Gemini and fake time: Date.now is mocked, every fake answer moves the clock forward by its own duration, and the injected
// sleep moves it by the wait. Nothing really waits (one test uses a 20 ms timeout) and nothing touches the network or a real key.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../src/lib/ai/pipeline.js';
import { translate, quotaKey, resetGeminiState, SLOW_FAIL_MS } from '../src/lib/ai/gemini.js';
import { setAiStore, resetAiMemory } from '../src/lib/cache.js';
import { resetHealth, scopeOf, nextPacificMidnight } from '../src/lib/health.js';

let clock;
beforeEach((t) => {
  clock = Date.UTC(2026, 9, 19, 20, 0, 0); // 13:00 in Los Angeles (PDT): the daily quota resets at 07:00 UTC
  t.mock.method(Date, 'now', () => clock);
});
afterEach(() => setAiStore(null));

function memStore({ refuse = false } = {}) {
  const m = new Map(), sets = [];
  return {
    m, sets,
    async get(k, { kind }) { return refuse ? null : m.get(`${kind}:${k}`) ?? null; },
    async set(k, b, o = {}) { sets.push({ k, ttlSec: o.ttlSec, text: b.toString('utf8') }); if (refuse) return false; m.set(`${o.kind}:${k}`, b); return true; },
    async del() { return true; },
  };
}
/** A restart: memory state of health.js, gemini.js and the AI store's memory layer is gone; the store keeps its values. */
const restart = () => { resetHealth(); resetGeminiState(); resetAiMemory(); };

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const DAILY = { status: 429, body: { error: { code: 429, message: 'You exceeded your current quota.', status: 'RESOURCE_EXHAUSTED', details: [
  { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaDimensions: { model: 'gemini-3.8-flash' } }] },
  { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '41s' }] } } };
const OVERLOADED = { status: 503, body: { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } } };
const S38 = 'gemini-3.8-flash', S37 = 'gemini-3.7-flash';

/**
 * Fake DeepL + Gemini. script(rec) -> { ms, status?, body? } | undefined (undefined = a good answer after 30 s).
 * rec: { model, kind: 'glossary' | 'polish' | 'translate', n (this model+kind's request number, from 1) }.
 */
function fakeApis(script = () => undefined, { models = [S38, S37] } = {}) {
  const gemini = [], lists = [];
  const fetchImpl = async (url, init) => {
    url = String(url);
    const body = init?.body ? JSON.parse(init.body) : null;
    if (url.includes('/v2/usage')) { clock += 300; return reply(200, { character_count: 0, character_limit: 1000000 }); }
    if (url.includes('/v2/translate')) { clock += 1000; return reply(200, { translations: body.text.map((t) => ({ text: `Σχέδιο ${t.replace(/Laroche/g, 'Λαρός')}` })) }); }
    if (/\/models\?/.test(url)) { clock += 200; lists.push(clock); return reply(200, { models: models.map((m) => ({ name: `models/${m}`, supportedGenerationMethods: ['generateContent'] })) }); }
    if (url.includes(':generateContent')) {
      const model = decodeURIComponent(url.match(/models\/([^:]+):generateContent/)[1]);
      const system = body.systemInstruction.parts[0].text, user = body.contents[0].parts[0].text;
      const kind = /subtitle editor/.test(system) ? 'polish' : /professional subtitle translator/.test(system) ? 'translate' : 'glossary';
      const items = JSON.parse(user.slice(user.lastIndexOf('strings:\n') + 9).split('\n')[0]);
      const rec = { model, kind, at: clock, n: gemini.filter((g) => g.model === model && g.kind === kind).length + 1 };
      gemini.push(rec);
      const out = (await script(rec)) ?? { ms: 30000 };
      clock += out.ms;
      if (out.status) return reply(out.status, out.body);
      const arr = kind === 'glossary' ? items.map(() => 'Λαρός') : items.map((x) => `Τελικό ${(x.en ?? x).replace(/Laroche/g, 'Λαρός')}`);
      return reply(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(arr) }] }, finishReason: 'STOP' }], usageMetadata: {} });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const count = (model, kind) => gemini.filter((g) => g.model === model && (!kind || g.kind === kind)).length;
  return { fetchImpl, gemini, lists, count };
}

let seq = 0;
const newKeys = () => ({ deepl: `deepl-slow-test-${++seq}-0123456789:fx`, gemini: 'AIza' + `SlowTestGeminiKey${seq}x0123456789` });
// 750 cues = 3 chunks of 250 (the default size), like the Tracker episode. "Laroche" makes one glossary name.
const english = { release: 'Show.S04E02.WEB', cues: Array.from({ length: 750 }, (_, i) => ({ start: 6000 + i * 3000, end: 8000 + i * 3000, raw: `Line ${i} with Laroche` })) };

/** One job through the real pipeline. -> { r, logs, sleeps, marks: { draft, chunks: [clock at chunk k] } } */
async function job(apis, keys, { imdbId = `tt97${String(++seq).padStart(5, '0')}` } = {}) {
  const logs = [], sleeps = [], marks = { draft: null, chunks: [] };
  const r = await runPipeline({
    imdbId, season: 4, episode: 2, english, keys, fetchImpl: apis.fetchImpl, env: {},
    now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; }, log: (m) => logs.push(m), minSaveGapMs: 0,
    onProgress: (p) => { if (p.phase === 'draft') marks.draft = clock; if (p.phase === 'polish') marks.chunks[p.chunk] = clock; },
  });
  return { r, logs, sleeps, marks };
}
const geminiLines = (logs) => logs.filter((l) => l.startsWith('[ai] gemini call='));

// ---------------------------------------------------------------------------------------------------------------------
test('Tracker replay: 3.8 answers 503 after 200 s; the job moves to 3.7 at once and never asks 3.8 again', async () => {
  setAiStore(memStore());
  const apis = fakeApis((rec) => {
    if (rec.model === S38 && rec.kind === 'glossary') return { ms: 20000 };
    if (rec.model === S38) return rec.n === 1 ? { ms: 200000, ...OVERLOADED } : { ms: 400, ...DAILY };
    return undefined; // 3.7: 30 s per chunk
  });
  const { r, logs, sleeps, marks } = await job(apis, newKeys());
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'final');
  assert.deepEqual(r.stats.models, [S37]);
  assert.equal(r.stats.fallbackChunks, 0);
  assert.equal(apis.count(S38, 'polish'), 1, 'one slow answer from 3.8, then no more');
  assert.deepEqual(sleeps, [], 'no backoff after a slow failure');
  // draft -> chunk 1: model list 0.2 s + glossary 20 s + the slow 503 200 s + 3.7 30 s. The old code slept 2 s and asked 3.8 again,
  // and with a second slow 503 that alone was another 200 s.
  assert.equal(marks.chunks[0] - marks.draft, 200 + 20000 + 200000 + 30000);
  assert.equal(marks.chunks[1] - marks.chunks[0], 30000);
  assert.equal(marks.chunks[2] - marks.chunks[1], 30000);
  const g = geminiLines(logs);
  assert.equal(g[0], `[ai] gemini call=glossary model=${S38} result=200 ms=20000`);
  assert.equal(g[1], `[ai] gemini call=chunk model=${S38} result=503 ms=200000`);
  assert.equal(g[2], `[ai] gemini call=chunk model=${S37} result=200 ms=30000`);
  assert.equal(g.length, 5); // glossary + 503 + three chunks
  assert.ok(logs.includes(`[ai] Gemini model ${S38} is slow or unavailable: using ${S37}`));
});

test('the logged sequence (fast 503, 2 s, then 429 per day): switch at once, the spent model is written to the store until midnight Pacific', async () => {
  const store = memStore(); setAiStore(store);
  const keys = newKeys();
  const apis = fakeApis((rec) => {
    if (rec.model === S38 && rec.kind === 'glossary') return { ms: 5000 };
    if (rec.model === S38) return rec.n === 1 ? { ms: 3000, ...OVERLOADED } : { ms: 400, ...DAILY };
    return undefined;
  });
  const { r, logs, sleeps, marks } = await job(apis, keys);
  assert.equal(r.ok, true);
  assert.deepEqual(sleeps, [2000], 'a fast 503 is tried once more after 2 s');
  assert.equal(apis.count(S38, 'polish'), 2);
  assert.equal(marks.chunks[0] - marks.draft, 200 + 5000 + 3000 + 2000 + 400 + 30000);
  assert.ok(logs.includes(`[ai] Gemini model ${S38} is out of daily quota: using ${S37}`));
  assert.ok(geminiLines(logs).includes(`[ai] gemini call=chunk model=${S38} result=429day ms=400`));

  const rec = store.sets.filter((s) => s.k === quotaKey(scopeOf({ apiKey: keys.gemini })));
  assert.equal(rec.length, 1, 'one store write for the spent model');
  assert.deepEqual(JSON.parse(rec[0].text), { [S38]: nextPacificMidnight() });
  const savedAt = apis.gemini.find((g) => g.model === S38 && g.kind === 'polish' && g.n === 2).at + 400; // when the 429 arrived
  assert.equal(rec[0].ttlSec, Math.ceil((nextPacificMidnight() - savedAt) / 1000));
  for (const s of store.sets) assert.ok(!s.text.includes(keys.gemini) && !s.k.includes(keys.gemini));
});

test('daily 429 on the glossary call: the chunk calls never ask the spent model', async () => {
  setAiStore(memStore());
  const apis = fakeApis((rec) => (rec.model === S38 ? { ms: 300, ...DAILY } : rec.kind === 'glossary' ? { ms: 4000 } : undefined));
  const { r, sleeps } = await job(apis, newKeys());
  assert.equal(r.ok, true);
  assert.equal(apis.count(S38), 1);
  assert.equal(apis.count(S38, 'polish'), 0);
  assert.deepEqual(sleeps, []);
});

test('a second job the same day, same process: no request to the spent model, no wait, no new model list', async () => {
  setAiStore(memStore());
  const keys = newKeys();
  const apis = fakeApis((rec) => (rec.model === S38 ? { ms: 300, ...DAILY } : undefined));
  await job(apis, keys);
  const s38 = apis.count(S38), lists = apis.lists.length;
  const second = await job(apis, keys); // another title: a new glossary call too
  assert.equal(second.r.ok, true);
  assert.equal(apis.count(S38), s38);
  assert.equal(apis.lists.length, lists);
  assert.deepEqual(second.sleeps, []);
  assert.equal(second.marks.chunks[0] - second.marks.draft, 30000 + 30000); // glossary + chunk 1, both on 3.7
});

test('a second job after a restart: the spent model is read back from the store and not asked again', async () => {
  const store = memStore(); setAiStore(store);
  const keys = newKeys();
  const apis = fakeApis((rec) => (rec.model === S38 ? { ms: 300, ...DAILY } : undefined));
  await job(apis, keys);
  const s38 = apis.count(S38);
  restart();
  clock += 3 * 3600 * 1000; // 16:00 in Los Angeles: still the same quota day
  const second = await job(apis, keys);
  assert.equal(second.r.ok, true);
  assert.equal(apis.count(S38), s38, 'no request to 3.8 after the restart');
  assert.ok(second.logs.some((l) => /^\[ai\] Gemini models out of daily quota from an earlier run: gemini-3\.8-flash /.test(l)));
  assert.deepEqual(second.sleeps, []);
});

test('after midnight Pacific the record has expired and the first model is used again', async () => {
  setAiStore(memStore());
  const keys = newKeys();
  let spentDay = true;
  const apis = fakeApis((rec) => (rec.model === S38 && spentDay ? { ms: 300, ...DAILY } : undefined));
  await job(apis, keys);
  restart();
  clock = Date.UTC(2026, 9, 20, 7, 0, 1); // 00:00:01 in Los Angeles
  spentDay = false;
  const before = apis.count(S38);
  const next = await job(apis, keys);
  assert.equal(next.r.ok, true);
  assert.ok(apis.count(S38) > before);
  assert.deepEqual(next.r.stats.models, [S38]);
});

test('a store that refuses writes: memory still skips the model in this process; after a restart it is asked once more', async () => {
  setAiStore(memStore({ refuse: true }));
  const keys = newKeys();
  const apis = fakeApis((rec) => (rec.model === S38 ? { ms: 300, ...DAILY } : undefined));
  await job(apis, keys);
  const s38 = apis.count(S38);
  assert.equal((await job(apis, keys)).r.ok, true);
  assert.equal(apis.count(S38), s38);
  restart();
  assert.equal((await job(apis, keys)).r.ok, true);
  assert.equal(apis.count(S38), s38 + 1); // the honest cost without a store: one quick 429
});

// ---------- the client alone ----------
const one = (apis, key, extra = {}) => translate({ key, texts: ['Hello'], env: {}, fetchImpl: apis.fetchImpl, now: () => clock, ...extra });

test('a timeout (240 s on the fake clock) moves to the next model at once', async () => {
  setAiStore(memStore());
  const sleeps = [], logs = [];
  const apis = fakeApis((rec) => (rec.model === S38 ? new Promise(() => {}) : { ms: 5000 }));
  const hang = apis.fetchImpl;
  // the request to 3.8 never answers: the real timer (20 ms) aborts it, and the fake clock counts 240 s
  const fetchImpl = (url, init) => (String(url).includes(S38) ? new Promise((_, rej) => init.signal.addEventListener('abort', () => { clock += 240000; rej(init.signal.reason); })) : hang(url, init));
  const r = await one({ fetchImpl }, newKeys().gemini, { timeoutMs: 20, sleep: async (ms) => { sleeps.push(ms); clock += ms; }, log: (m) => logs.push(m) });
  assert.equal(r.model, S37);
  assert.deepEqual(sleeps, []);
  assert.ok(logs.includes(`[ai] gemini call=chunk model=${S38} result=timeout ms=240000`));
});

test('no other free model: a slow 503 keeps the usual retries (2 s, 4 s, 8 s) on the only model', async () => {
  setAiStore(memStore());
  const sleeps = [];
  const apis = fakeApis((rec) => (rec.n <= 3 ? { ms: 200000, ...OVERLOADED } : { ms: 5000 }), { models: [S38] });
  const r = await one(apis, newKeys().gemini, { sleep: async (ms) => { sleeps.push(ms); clock += ms; }, log: () => {} });
  assert.equal(r.model, S38);
  assert.deepEqual(sleeps, [2000, 4000, 8000]);
});

test('both models slow: the second one is not left for the busy first one; it gets its retries', async () => {
  setAiStore(memStore());
  const sleeps = [];
  const apis = fakeApis((rec) => (rec.model === S38 ? { ms: SLOW_FAIL_MS, ...OVERLOADED } : rec.n === 1 ? { ms: SLOW_FAIL_MS, ...OVERLOADED } : { ms: 5000 }));
  const r = await one(apis, newKeys().gemini, { sleep: async (ms) => { sleeps.push(ms); clock += ms; }, log: () => {} });
  assert.equal(r.model, S37);
  assert.equal(apis.count(S38), 1);
  assert.equal(apis.count(S37), 2);
  assert.deepEqual(sleeps, [2000]);
});

test('a per-minute 429 still waits the server\'s retryDelay on the same model, even with another model free', async () => {
  setAiStore(memStore());
  const sleeps = [], logs = [];
  const minute = { status: 429, body: { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED', details: [
    { violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }] } } };
  const apis = fakeApis((rec) => (rec.model === S38 && rec.n === 1 ? { ms: 200, ...minute } : { ms: 5000 }));
  const r = await one(apis, newKeys().gemini, { sleep: async (ms) => { sleeps.push(ms); clock += ms; }, log: (m) => logs.push(m) });
  assert.equal(r.model, S38);
  assert.deepEqual(sleeps, [7000]);
  assert.ok(logs.includes(`[ai] gemini call=chunk model=${S38} result=429min ms=200`));
});

test('a failed chunk attempt is logged with its problem codes only (it used to be retried without a line)', async () => {
  setAiStore(memStore());
  // 3.8 answers chunk 1 once with a wrong count, then correctly
  const apis = fakeApis();
  const wrong = apis.fetchImpl;
  let first = true;
  const fetchImpl = async (url, init) => {
    if (first && String(url).includes(':generateContent') && /subtitle editor/.test(JSON.parse(init.body).systemInstruction.parts[0].text)) {
      first = false; clock += 30000;
      return reply(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(['Ένα']) }] }, finishReason: 'STOP' }] });
    }
    return wrong(url, init);
  };
  const { r, logs } = await job({ fetchImpl }, newKeys());
  assert.equal(r.ok, true);
  assert.equal(r.stats.retries, 1);
  const line = logs.find((l) => / chunk 1\/3 attempt 1 failed: /.test(l));
  assert.match(line, /^\[ai\] tt\d+:4:2 chunk 1\/3 attempt 1 failed: count model=gemini-3\.8-flash$/);
});
