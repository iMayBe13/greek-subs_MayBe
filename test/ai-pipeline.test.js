import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline, assembleSrt, jobKey, finalKey, chunkCues, DEFAULT_CHUNK_CUES } from '../src/lib/ai/pipeline.js';
import { parseSrt } from '../src/lib/srt.js';
import { setAiStore, delAi } from '../src/lib/cache.js';

// ---------- mocks ----------
function memStore(clock = () => 0) {
  const m = new Map(), sets = [];
  return {
    sets, m,
    async get(k, { kind }) { return m.get(`${kind}:${k}`) ?? null; },
    async set(k, b, o = {}) { sets.push({ k, kind: o.kind, ttlSec: o.ttlSec, at: clock(), text: b.toString('utf8') }); m.set(`${o.kind}:${k}`, b); },
    async del() { return true; },
  };
}
afterEach(() => setAiStore(null));

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const lastLine = (user) => JSON.parse(user.slice(user.lastIndexOf('strings:\n') + 9).split('\n')[0]);
const contextOf = (user) => JSON.parse(user.slice(user.indexOf(':\n') + 2).split('\n')[0]);

/**
 * A fake DeepL and Gemini. deepl(texts) -> string[]; gemini({ kind, items, context, note, n, call }) -> string[] | { status, body }.
 * kind: 'polish' | 'translate' | 'glossary'. Every call is recorded.
 */
function mockApis({ deepl, gemini, usage = { used: 0, limit: 1000000 }, models = ['gemini-3.8-flash', 'gemini-3.7-flash'] } = {}) {
  const calls = { deepl: [], gemini: [], usage: 0 };
  const defaultDeepl = (texts) => texts.map((t) => `Σχέδιο ${t}`);
  const defaultGemini = ({ kind, items }) => items.map((x) => (kind === 'polish' ? `Τελικό ${x.en}` : kind === 'translate' ? `Μετάφραση ${x}` : 'Κέιλα'));
  const fetchImpl = async (url, init) => {
    url = String(url);
    const body = init?.body ? JSON.parse(init.body) : null;
    if (url.includes('/v2/usage')) { calls.usage++; return reply(200, { character_count: usage.used, character_limit: usage.limit }); }
    if (url.includes('/v2/translate')) {
      calls.deepl.push(body);
      return reply(200, { translations: (deepl || defaultDeepl)(body.text, body).map((text) => ({ text })) });
    }
    if (/\/models\?/.test(url)) return reply(200, { models: models.map((name) => ({ name: `models/${name}`, supportedGenerationMethods: ['generateContent'] })) });
    if (url.includes(':generateContent')) {
      const model = decodeURIComponent(url.match(/models\/([^:]+):generateContent/)[1]);
      const system = body.systemInstruction.parts[0].text, user = body.contents[0].parts[0].text;
      const kind = /subtitle editor/.test(system) ? 'polish' : /professional subtitle translator/.test(system) ? 'translate' : 'glossary';
      const items = lastLine(user);
      const rec = { model, kind, items, system, user, n: items.length, context: kind === 'glossary' ? [] : contextOf(user), note: user.includes('IMPORTANT') ? user.slice(user.indexOf('IMPORTANT')) : '', body };
      calls.gemini.push(rec);
      const out = await (gemini || defaultGemini)({ ...rec, call: calls.gemini.length });
      if (Array.isArray(out)) return reply(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] }, finishReason: 'STOP' }], usageMetadata: {} });
      return reply(out.status, out.body);
    }
    throw new Error(`unexpected request ${url}`);
  };
  return { fetchImpl, calls };
}

let seq = 0;
const fresh = () => ({ imdbId: `tt98${String(++seq).padStart(5, '0')}`, season: 1, episode: 2 });
const keyPair = () => ({ deepl: `deeplkey-test-${seq}-0123456789:fx`, gemini: 'AIza' + `GeminiTestKey${seq}ABCDEFG0123` });
const ENV = { AI_GEMINI_MODEL: 'gemini-test-flash', AI_CHUNK_CUES: '100' }; // the tests are written for chunks of 100 cues (the minimum is 50, the default 250)
const english = (n, { first = 6000, text = (i) => `Line ${i} here` } = {}) => ({
  release: 'Show.S01E02.WEB-GRP',
  cues: Array.from({ length: n }, (_, i) => ({ start: first + i * 3000, end: first + i * 3000 + 2000, raw: text(i) })),
});
const run = (title, eng, keys, apis, extra = {}) => runPipeline({
  ...title, english: eng, keys, fetchImpl: apis.fetchImpl, env: ENV, sleep: async () => {}, log: () => {}, minSaveGapMs: 0, ...extra,
});
const quota429 = { status: 429, body: { error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }] }] } } };
const CYRILLIC = /[\u0400-\u04FF]/;

// ---------- happy path ----------
test('DeepL + Gemini: every timestamp identical, label first, numbering gapless, italics back, context and thinking right', async () => {
  const store = memStore(); setAiStore(store);
  const title = fresh(), apis = mockApis();
  const eng = english(250, { text: (i) => (i === 3 ? '<i>Line 3 here</i>' : `Line ${i} here`) });
  const r = await run(title, eng, keyPair(), apis);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'final');
  assert.equal(r.stats.mode, 'deepl+gemini');
  assert.equal(r.stats.chunks, 3);

  const out = parseSrt(r.srt);
  assert.equal(out.length, 251);
  assert.deepEqual(out.slice(1).map((c) => [c.start, c.end]), eng.cues.map((c) => [c.start, c.end]));
  assert.match(out[0].raw, /Μετάφραση με τεχνητή νοημοσύνη \(AI\)[^]*AI translation \(DeepL \+ Gemini\)/);
  assert.equal(out[0].start, 0);
  assert.ok(out[0].end < eng.cues[0].start);
  assert.deepEqual([...r.srt.matchAll(/^(\d+)\n\d\d:/gm)].map((m) => +m[1]), Array.from({ length: 251 }, (_, i) => i + 1));
  assert.equal(out[4].raw, '<i>Τελικό Line 3 here</i>');
  assert.equal(out[1].raw, 'Τελικό Line 0 here');

  // DeepL: the 250 cues were drafted once (characters counted), Gemini: 3 polish calls, 5 earlier English cues as context
  assert.equal(r.stats.deeplChars, eng.cues.reduce((n, c) => n + c.raw.replace(/<\/?i>/g, '').length, 0));
  assert.deepEqual(apis.calls.gemini.map((g) => [g.kind, g.n]), [['polish', 100], ['polish', 100], ['polish', 50]]);
  assert.deepEqual(apis.calls.gemini[1].context, ['Line 95 here', 'Line 96 here', 'Line 97 here', 'Line 98 here', 'Line 99 here']);
  assert.deepEqual(apis.calls.gemini[0].context, []);
  assert.equal(apis.calls.gemini[0].body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
  assert.equal(apis.calls.gemini[0].items[0].draft, 'Σχέδιο Line 0 here');
  assert.ok(store.m.has(`text:${finalKey(title.imdbId, 1, 2)}`));
});

test('the label tells the truth about the engine, and a first cue before 3 s gets the second notice in a later gap', async () => {
  setAiStore(memStore());
  const eng = english(30, { first: 1200 });
  eng.cues[10].start += 5000; eng.cues[10].end += 5000; // a 5 s gap before cue 10, after cue 9
  for (let i = 11; i < 30; i++) { eng.cues[i].start += 5000; eng.cues[i].end += 5000; }
  const r = await run(fresh(), eng, { deepl: keyPair().deepl }, mockApis());
  const out = parseSrt(r.srt);
  assert.match(out[0].raw, /Πρόχειρη[^]*AI draft translation \(DeepL\)/);
  assert.equal(out.filter((c) => /AI draft translation/.test(c.raw)).length, 2);
  assert.ok(out[0].end < 1200);
  assert.equal(out.length, 30 + 2);
});

// ---------- retries and fallbacks ----------
test('a bad chunk is retried once with a note naming the problem, then accepted', async () => {
  setAiStore(memStore());
  const apis = mockApis({ gemini: ({ kind, items, call }) => (call === 1 ? items.slice(1).map((x) => `Τελικό ${x.en}`) : items.map((x) => `Τελικό ${x.en}`)) });
  const r = await run(fresh(), english(50), keyPair(), apis);
  assert.equal(r.kind, 'final');
  assert.equal(r.stats.retries, 1);
  assert.equal(r.stats.fallbackChunks, 0);
  assert.equal(apis.calls.gemini.length, 2);
  assert.match(apis.calls.gemini[1].note, /expected 50 items, got 49/);
  assert.equal(apis.calls.gemini[0].note, '');
});

test('a chunk that fails twice falls back to the DeepL draft; the others keep the polish', async () => {
  setAiStore(memStore());
  const apis = mockApis({ gemini: ({ items }) => (items[0].en === 'Line 100 here' ? [] : items.map((x) => `Τελικό ${x.en}`)) });
  const r = await run(fresh(), english(250), keyPair(), apis);
  assert.equal(r.stats.fallbackChunks, 1);
  assert.equal(r.stats.retries, 1);
  assert.equal(apis.calls.gemini.length, 4); // chunk 0, chunk 1 twice, chunk 2
  const out = parseSrt(r.srt);
  assert.equal(out[1].raw, 'Τελικό Line 0 here');
  assert.equal(out[101].raw, 'Σχέδιο Line 100 here');
  assert.equal(out[200].raw, 'Σχέδιο Line 199 here');
  assert.equal(out[201].raw, 'Τελικό Line 200 here');
  assert.equal(r.kind, 'final'); // Gemini took part and every chunk is settled
});

test('a Cyrillic letter never reaches the output: Gemini output with one falls back, DeepL output with one is asked again', async () => {
  const store = memStore(); setAiStore(store);
  const apis = mockApis({
    deepl: (texts) => texts.map((t) => (t === 'Line 7 here' && texts.length > 1 ? 'Λαρόш' : t === 'Line 8 here' ? 'Λαρόш' : `Σχέδιο ${t}`)),
    gemini: ({ items }) => items.map((x, j) => (x.en === 'Line 20 here' ? 'Τελικό ш' : `Τελικό ${x.en}`)),
  });
  const r = await run(fresh(), english(60), keyPair(), apis);
  assert.ok(!CYRILLIC.test(r.srt));
  assert.ok(store.sets.every((s) => !CYRILLIC.test(s.text)));
  const out = parseSrt(r.srt);
  assert.equal(r.stats.fallbackChunks, 1); // the Gemini chunk with the bad cue went back to the draft
  // cue 7: DeepL batch gave Cyrillic, asked again alone -> clean. cue 8: Cyrillic every time -> the English line, counted
  assert.equal(out[8].raw, 'Σχέδιο Line 7 here');
  assert.equal(out[9].raw, 'Line 8 here');
  assert.equal(r.stats.englishLines, 1);
});

test('assembleSrt writes the English line instead of a bad character found in a stale record', () => {
  const job = { en: [[0, 1000, 'Hello'], [2000, 3000, 'World']], draft: ['Γεια', 'Κόσμε ш'], polished: {}, gemini: false };
  const out = parseSrt(assembleSrt(job).srt);
  assert.equal(out[1].raw, 'Γεια');
  assert.equal(out[2].raw, 'World');
});

// ---------- modes ----------
test('DeepL only: no Gemini call, the draft is the finished file, labelled as a draft', async () => {
  const store = memStore(); setAiStore(store);
  const title = fresh(), apis = mockApis();
  const r = await run(title, english(120), { deepl: keyPair().deepl }, apis);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'draft');
  assert.equal(r.stats.mode, 'deepl');
  assert.equal(apis.calls.gemini.length, 0);
  assert.match(parseSrt(r.srt)[0].raw, /AI draft translation \(DeepL\)/);
  assert.equal(parseSrt(r.srt)[1].raw, 'Σχέδιο Line 0 here');
});

test('Gemini only: the translate prompt is used, no DeepL call, finished as a final', async () => {
  setAiStore(memStore());
  const apis = mockApis();
  const r = await run(fresh(), english(120), { gemini: keyPair().gemini }, apis);
  assert.equal(r.kind, 'final');
  assert.equal(r.stats.mode, 'gemini');
  assert.equal(apis.calls.deepl.length + apis.calls.usage, 0);
  assert.ok(apis.calls.gemini.every((g) => g.kind === 'translate'));
  assert.equal(parseSrt(r.srt)[1].raw, 'Μετάφραση Line 0 here');
  assert.match(parseSrt(r.srt)[0].raw, /AI translation \(Gemini\)/);
});

test('Gemini only: a chunk that fails twice keeps the English lines and counts them', async () => {
  setAiStore(memStore());
  const apis = mockApis({ gemini: () => ['wrong count'] });
  const r = await run(fresh(), english(30), { gemini: keyPair().gemini }, apis);
  assert.equal(r.ok, true);
  assert.equal(r.stats.fallbackChunks, 1);
  assert.equal(r.stats.englishLines, 30);
  assert.equal(parseSrt(r.srt)[1].raw, 'Line 0 here');
});

test('no usable key gives null and makes no request', async () => {
  const apis = mockApis();
  assert.equal(await run(fresh(), english(10), {}, apis), null);
  assert.equal(await run(fresh(), english(10), { deepl: '', gemini: 'bad key with spaces' }, apis), null);
  assert.equal(apis.calls.deepl.length + apis.calls.gemini.length + apis.calls.usage, 0);
});

// ---------- quota ----------
test('Gemini daily quota in the middle: stop politely and finish with the draft, polished chunks kept', async () => {
  const store = memStore(); setAiStore(store);
  const title = fresh();
  const apis = mockApis({ gemini: ({ call, items }) => (call === 1 ? items.map((x) => `Τελικό ${x.en}`) : quota429) });
  const r = await run(title, english(250), keyPair(), apis);
  assert.equal(r.ok, true);
  assert.equal(r.state, 'done');
  assert.equal(r.kind, 'draft');
  assert.equal(apis.calls.gemini.length, 2); // chunk 0 ok, chunk 1 hit the quota, chunk 2 never asked
  const out = parseSrt(r.srt);
  assert.equal(out[1].raw, 'Τελικό Line 0 here');
  assert.equal(out[101].raw, 'Σχέδιο Line 100 here');
  assert.match(out[0].raw, /AI draft translation/);
  assert.ok(store.m.has(`text:${finalKey(title.imdbId, 1, 2)}`));
});

test('Gemini quota already spent for the key: no Gemini call, the draft is the result', async () => {
  setAiStore(memStore());
  const keys = keyPair();
  await run(fresh(), english(10), { gemini: keys.gemini }, mockApis({ gemini: () => quota429 })); // marks this key exhausted
  const apis = mockApis();
  const r = await run(fresh(), english(10), keys, apis);
  assert.equal(apis.calls.gemini.length, 0);
  assert.equal(r.kind, 'draft');
  assert.equal(r.ok, true);
});

test('Gemini only with the quota gone: paused, progress saved, no final file', async () => {
  const store = memStore(); setAiStore(store);
  const title = fresh();
  const r = await run(title, english(250), { gemini: keyPair().gemini }, mockApis({ gemini: ({ call, items }) => (call === 1 ? items.map((x) => `Μετάφραση ${x}`) : quota429) }));
  assert.equal(r.ok, false);
  assert.equal(r.state, 'paused');
  assert.equal(r.stats.chunksDone, 1);
  assert.ok(!store.m.has(`text:${finalKey(title.imdbId, 1, 2)}`));
  assert.equal(JSON.parse(store.m.get(`json:${jobKey(title.imdbId, 1, 2)}`).toString()).state, 'paused');
});

test('DeepL quota too short: no draft is made, Gemini translates alone', async () => {
  setAiStore(memStore());
  const apis = mockApis({ usage: { used: 999900, limit: 1000000 } });
  const r = await run(fresh(), english(100), keyPair(), apis);
  assert.equal(apis.calls.usage, 1);
  assert.equal(apis.calls.deepl.length, 0);
  assert.equal(r.stats.mode, 'gemini');
  assert.equal(r.stats.deeplChars, 0);
  assert.equal(r.kind, 'final');
});

// ---------- resume and saved progress ----------
test('a new run continues from the first unfinished chunk and re-uses the saved draft', async () => {
  const store = memStore(); setAiStore(store);
  const title = fresh(), eng = english(250);
  const keys = keyPair();
  // run 1: DeepL draft, then Gemini is rejected after chunk 0 -> the job is "done as draft"; use Gemini-only for a paused job instead
  const first = await run(title, eng, { gemini: keys.gemini }, mockApis({ gemini: ({ call, items }) => (call === 1 ? items.map((x) => `Μετάφραση ${x}`) : quota429) }));
  assert.equal(first.state, 'paused');
  const apis = mockApis();
  const second = await run(title, eng, { gemini: `${keys.gemini}-new` }, apis);
  assert.equal(second.ok, true);
  assert.equal(second.stats.resumedChunks, 1);
  assert.deepEqual(apis.calls.gemini.map((g) => g.items[0]), ['Line 100 here', 'Line 200 here']); // chunk 0 not asked again
  const out = parseSrt(second.srt);
  assert.equal(out[1].raw, 'Μετάφραση Line 0 here'); // from the first run
  assert.equal(out[101].raw, 'Μετάφραση Line 100 here');
  assert.deepEqual(out.slice(1).map((c) => c.start), eng.cues.map((c) => c.start));
});

test('a saved draft is not bought again on resume', async () => {
  const store = memStore(); setAiStore(store);
  const title = fresh(), eng = english(150), keys = keyPair();
  const first = await run(title, eng, keys, mockApis({ gemini: () => quota429 }));
  assert.equal(first.kind, 'draft'); // done as a draft
  const job = JSON.parse(store.m.get(`json:${jobKey(title.imdbId, 1, 2)}`).toString());
  job.state = 'running'; // as if the process had died before finishing
  store.m.set(`json:${jobKey(title.imdbId, 1, 2)}`, Buffer.from(JSON.stringify(job)));
  await delAi(jobKey(title.imdbId, 1, 2)); // forget the in-memory copy, so the next run reads the edited record from the store
  store.m.set(`json:${jobKey(title.imdbId, 1, 2)}`, Buffer.from(JSON.stringify(job)));
  const apis = mockApis();
  const again = await run(title, eng, { deepl: keys.deepl, gemini: `${keys.gemini}-b` }, apis);
  assert.equal(apis.calls.deepl.length, 0);
  assert.equal(apis.calls.usage, 0);
  assert.equal(apis.calls.gemini.length, 2);
  assert.equal(apis.calls.gemini[0].items[0].draft, 'Σχέδιο Line 0 here'); // the saved draft went to Gemini
  assert.equal(again.kind, 'final');
});

test('a finished job returns at once without any request; a different English file starts over', async () => {
  setAiStore(memStore());
  const title = fresh(), keys = keyPair(), eng = english(40);
  const first = await run(title, eng, keys, mockApis());
  const apis = mockApis();
  const again = await run(title, eng, keys, apis);
  assert.equal(again.srt, first.srt);
  assert.equal(apis.calls.deepl.length + apis.calls.gemini.length, 0);
  const other = await run(title, english(41), keys, apis);
  assert.equal(parseSrt(other.srt).length, 42);
  assert.ok(apis.calls.gemini.length > 0);
});

test('progress callback reports the draft, every chunk and the end; a throwing callback does not stop the job', async () => {
  setAiStore(memStore());
  const seen = [];
  const r = await run(fresh(), english(250), keyPair(), mockApis(), { onProgress: (p) => { seen.push([p.phase, p.chunk, p.doneChunks]); throw new Error('ui bug'); } });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [['draft', null, 0], ['polish', 0, 1], ['polish', 1, 2], ['polish', 2, 3], ['done', null, 3]]);
});

test('assembleSrt while running: polished chunks merged into the draft and labelled "improving"', async () => {
  const store = memStore(); setAiStore(store);
  const title = fresh();
  await run(title, english(250), keyPair(), mockApis({ gemini: ({ call, items }) => (call === 1 ? items.map((x) => `Τελικό ${x.en}`) : quota429) }));
  const job = JSON.parse(store.m.get(`json:${jobKey(title.imdbId, 1, 2)}`).toString());
  const a = assembleSrt(job, { running: true });
  assert.equal(a.kind, 'improving');
  const out = parseSrt(a.srt);
  assert.match(out[0].raw, /improving/);
  assert.equal(out[1].raw, 'Τελικό Line 0 here');
  assert.equal(out[150].raw, 'Σχέδιο Line 149 here');
});

// ---------- store contents ----------
test('no key, and nothing derived from a key, ever reaches the store; ttl and kind are right', async () => {
  const store = memStore(); setAiStore(store);
  const title = fresh(), keys = keyPair(), logs = [];
  const eng = english(250, { text: (i) => `Kayla said hi to Kayla ${i}` });
  await run(title, eng, keys, mockApis(), { log: (m) => logs.push(m) });
  assert.ok(store.sets.length > 0);
  for (const s of store.sets) {
    for (const secret of [keys.deepl, keys.gemini, keys.deepl.replace(':fx', ''), keys.gemini.slice(4)]) {
      assert.ok(!s.text.includes(secret) && !s.k.includes(secret), `a key leaked into ${s.k}`);
    }
    assert.ok(!/apiKey|api_key|x-goog|DeepL-Auth|scope/i.test(s.text.replace(/Kayla/g, '')));
  }
  assert.ok(logs.every((l) => !l.includes(keys.deepl) && !l.includes(keys.gemini)));
  const job = store.sets.filter((s) => s.k === jobKey(title.imdbId, 1, 2));
  assert.ok(job.length >= 1 && job.every((s) => s.kind === 'json' && s.ttlSec === 7 * 86400));
  const fin = store.sets.find((s) => s.k === finalKey(title.imdbId, 1, 2));
  assert.equal(fin.kind, 'text');
  assert.ok(store.sets.some((s) => s.k === `ai:gloss:${title.imdbId}`));
  assert.match(jobKey('tt1', 3, 4), /^ai:v1:tt1:3:4:job$/);
});

// ---------- write budget ----------
for (const [cues, chunks, size] of [[850, 9, '100'], [1500, 15, '100'], [850, 4, undefined], [1500, 30, '50']]) {
  test(`write budget: ${cues} cues (${chunks} chunks, AI_CHUNK_CUES=${size ?? 'default'}) use at most 12 store writes, none closer than 2 s`, async () => {
    let clock = 1_000_000;
    const store = memStore(() => clock); setAiStore(store);
    const title = fresh();
    const r = await run(title, english(cues, { text: (i) => `Kayla said hi to Kayla ${i}` }), keyPair(), mockApis(), {
      minSaveGapMs: 2000, now: () => clock, sleep: async (ms) => { clock += ms; },
      env: size ? { ...ENV, AI_CHUNK_CUES: size } : { AI_GEMINI_MODEL: 'gemini-test-flash' },
    });
    assert.equal(r.ok, true);
    assert.equal(r.stats.chunks, chunks);
    assert.ok(store.sets.length <= 12, `${store.sets.length} writes`);
    const jobWrites = store.sets.filter((s) => s.k.endsWith(':job')); // the KV limit is one write a second per key
    for (let i = 1; i < jobWrites.length; i++) assert.ok(jobWrites[i].at - jobWrites[i - 1].at >= 2000, 'two job writes less than 2 s apart');
    assert.equal(store.sets.filter((s) => s.k.endsWith(':final')).length, 1);
assert.equal(JSON.parse(store.sets.filter((s) => s.k.endsWith(':job')).at(-1).text).state, 'done');
    if (chunks === 9) assert.equal(store.sets.length, 12); // glossary + draft + 8 chunk saves + done + final
    if (chunks === 4) assert.equal(store.sets.length, 7); // glossary + draft + 3 chunk saves + done + final

  });
}

// ---------- chunk size ----------
test('AI_CHUNK_CUES: default 250, held between 50 and 400, junk gives the default', () => {
  assert.equal(DEFAULT_CHUNK_CUES, 250);
  for (const junk of [undefined, '', '  ', 'abc', '12abc', '-5', '1e3', '2.5', '0x40', '99999999']) assert.equal(chunkCues({ AI_CHUNK_CUES: junk }), 250, String(junk));
  assert.equal(chunkCues({}), 250);
  assert.equal(chunkCues({ AI_CHUNK_CUES: '10' }), 50);
  assert.equal(chunkCues({ AI_CHUNK_CUES: '0' }), 50);
  assert.equal(chunkCues({ AI_CHUNK_CUES: '50' }), 50);
  assert.equal(chunkCues({ AI_CHUNK_CUES: ' 300 ' }), 300);
  assert.equal(chunkCues({ AI_CHUNK_CUES: '400' }), 400);
  assert.equal(chunkCues({ AI_CHUNK_CUES: '401' }), 400);
  assert.equal(chunkCues({ AI_CHUNK_CUES: '5000' }), 400);
});

test('without AI_CHUNK_CUES the chunks are 250 cues and the size is stored in the job record', async () => {
  const store = memStore(); setAiStore(store);
  const title = fresh(), apis = mockApis();
  const r = await run(title, english(600), keyPair(), apis, { env: { AI_GEMINI_MODEL: 'gemini-test-flash' } });
  assert.deepEqual(apis.calls.gemini.map((g) => g.n), [250, 250, 100]);
  assert.equal(r.stats.chunks, 3);
  assert.equal(r.stats.chunkCues, 250);
  assert.equal(JSON.parse(store.m.get(`json:${jobKey(title.imdbId, 1, 2)}`).toString()).chunk, 250);
  const out = parseSrt(r.srt);
  assert.equal(out[251].raw, 'Τελικό Line 250 here');
  assert.deepEqual(out.slice(1).map((c) => c.start), english(600).cues.map((c) => c.start));
});

test('a saved job with another chunk size keeps its DeepL draft but polishes again from the start', async () => {
  const store = memStore(); setAiStore(store);
  const title = fresh(), eng = english(150), keys = keyPair();
  const first = await run(title, eng, keys, mockApis({ gemini: ({ call, items }) => (call === 1 ? items.map((x) => `Τελικό ${x.en}`) : quota429) }));
  assert.equal(first.kind, 'draft'); // chunk 0 of 100 polished, then the quota
  const job = JSON.parse(store.m.get(`json:${jobKey(title.imdbId, 1, 2)}`).toString());
  assert.deepEqual(Object.keys(job.polished), ['0']);
  assert.equal(job.chunk, 100);
  job.state = 'running'; // as if the process had stopped here
  await delAi(jobKey(title.imdbId, 1, 2));
  store.m.set(`json:${jobKey(title.imdbId, 1, 2)}`, Buffer.from(JSON.stringify(job)));

  const apis = mockApis();
  const again = await run(title, eng, { deepl: keys.deepl, gemini: `${keys.gemini}-new` }, apis, { env: { ...ENV, AI_CHUNK_CUES: '50' } });
  assert.equal(apis.calls.deepl.length + apis.calls.usage, 0); // the draft was kept
  assert.deepEqual(apis.calls.gemini.map((g) => g.n), [50, 50, 50]); // and the polish started again, in chunks of 50
  assert.equal(apis.calls.gemini[0].items[0].draft, 'Σχέδιο Line 0 here');
  assert.equal(again.stats.resumedChunks, 0);
  assert.equal(again.stats.chunkCues, 50);
  assert.equal(again.kind, 'final');
  assert.equal(parseSrt(again.srt)[1].raw, 'Τελικό Line 0 here');
});

test('the same chunk size continues where it stopped (nothing polished twice)', async () => {
  const store = memStore(); setAiStore(store);
  const title = fresh(), eng = english(250), keys = { gemini: keyPair().gemini };
  const first = await run(title, eng, keys, mockApis({ gemini: ({ call, items }) => (call === 1 ? items.map((x) => `Μετάφραση ${x}`) : quota429) }), { env: { ...ENV, AI_CHUNK_CUES: '100' } });
  assert.equal(first.state, 'paused');
  const apis = mockApis();
  const again = await run(title, eng, { gemini: `${keys.gemini}-b` }, apis, { env: { ...ENV, AI_CHUNK_CUES: '100' } });
  assert.deepEqual(apis.calls.gemini.map((g) => g.items[0]), ['Line 100 here', 'Line 200 here']);
  assert.equal(again.stats.resumedChunks, 1);
});

test('a finished job is returned as it is even if AI_CHUNK_CUES changed afterwards', async () => {
  setAiStore(memStore());
  const title = fresh(), keys = keyPair(), eng = english(120);
  await run(title, eng, keys, mockApis());
  const apis = mockApis();
  const again = await run(title, eng, keys, apis, { env: { ...ENV, AI_CHUNK_CUES: '50' } });
  assert.equal(apis.calls.gemini.length + apis.calls.deepl.length, 0);
  assert.equal(again.stats.chunkCues, 100);
});

// ---------- several Flash models ----------
test('a daily quota on one model moves the chunks to the next model; the job record names the model per chunk', async () => {
  const store = memStore(); setAiStore(store);
  const title = fresh(), logs = [], keys = keyPair();
  const apis = mockApis({ gemini: ({ model, items }) => (model === 'gemini-3.8-flash' ? quota429 : items.map((x) => `Τελικό ${x.en}`)) });
  const r = await run(title, english(250), keys, apis, { env: { AI_CHUNK_CUES: '100' }, log: (m) => logs.push(m) });
  assert.equal(r.kind, 'final');
  assert.deepEqual(apis.calls.gemini.map((g) => g.model), ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.7-flash', 'gemini-3.7-flash']);
  assert.deepEqual(r.stats.models, ['gemini-3.7-flash']);
  const job = JSON.parse(store.m.get(`json:${jobKey(title.imdbId, 1, 2)}`).toString());
  assert.deepEqual(job.models, { 0: 'gemini-3.7-flash', 1: 'gemini-3.7-flash', 2: 'gemini-3.7-flash' });
  assert.ok(logs.some((l) => /chunk 1\/3 model=gemini-3\.7-flash/.test(l)));
  assert.ok(![...logs, JSON.stringify(job)].some((t) => t.includes(keys.gemini) || t.includes(keys.deepl)));
});

test('every model out of quota: the job ends with the draft as before', async () => {
  setAiStore(memStore());
  const apis = mockApis({ gemini: () => quota429 });
  const r = await run(fresh(), english(150), keyPair(), apis, { env: { AI_CHUNK_CUES: '100' } });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'draft');
  assert.deepEqual(apis.calls.gemini.map((g) => g.model), ['gemini-3.8-flash', 'gemini-3.7-flash']);
  assert.equal(parseSrt(r.srt)[1].raw, 'Σχέδιο Line 0 here');
});
