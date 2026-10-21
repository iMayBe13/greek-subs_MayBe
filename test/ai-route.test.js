// The subtitles-route trigger and the /ai/ route, driven over HTTP with mocked searches, providers, DeepL, Gemini and store.
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { seal, open } from '../src/lib/crypto.js';
import { createSubtitlesHandler } from '../src/lib/subtitles.js';
import { createAiHandler, DRAFT_WAIT_MS, parseAiBlob, clientOf } from '../src/lib/ai/route.js';
import { createJobs } from '../src/lib/ai/jobs.js';
import { jobKey, finalKey } from '../src/lib/ai/pipeline.js';
import { parseSrt } from '../src/lib/srt.js';
import { setAiStore, delAi } from '../src/lib/cache.js';
import { glossaryKey } from '../src/lib/ai/glossary.js';

process.env.SECRET = 'test-secret-for-ai-route-test-0123456789';
const BASE = 'http://addon.test';
const DEEPL = 'deepl-route-test-key-0123456789:fx', GEMINI = 'AIza' + 'RouteTestGeminiKey0123456789', SUBDL = 'subdl-route-test-key-777';
const KEYS = [DEEPL, GEMINI, SUBDL];

// ---------- capture every console line, to prove no key is ever printed ----------
const logs = [];
const orig = {};
before(() => {
  for (const m of ['log', 'warn', 'error', 'info']) { orig[m] = console[m]; console[m] = (...a) => { logs.push(a.map(String).join(' ')); }; }
});
after(() => { for (const m of Object.keys(orig)) console[m] = orig[m]; });

// ---------- mocks ----------
function memStore() {
  const m = new Map(), sets = [], dels = [];
  return {
    m, sets, dels,
    async get(k, { kind }) { return m.get(`${kind}:${k}`) ?? null; },
    async set(k, b, o = {}) { sets.push({ k, text: b.toString('utf8') }); allSets.push(`${k}\n${b.toString('utf8')}`); m.set(`${o.kind}:${k}`, b); return true; },
    async del(k, o = {}) { dels.push(k); m.delete(`${o.kind}:${k}`); return true; },
  };
}
let store;
const servers = [];
// cache.js keeps a memory layer in front of the store: clear what the tests used, so one test does not see another's files
afterEach(async () => {
  for (const [tt, s, e] of [['tt0364845', 1, 2], ['tt0111161', 0, 0]]) {
    await delAi(finalKey(tt, s, e), { kind: 'text' }); await delAi(jobKey(tt, s, e), { kind: 'json' }); await delAi(glossaryKey(tt), { kind: 'json' });
  }
  setAiStore(null);
  while (servers.length) await new Promise((r) => servers.pop().close(r)); });
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const bodies = []; // every response body, scanned for keys at the end
const allSets = []; // every store write

const fakeSt = () => ({
  v: 1, state: 'running', chunk: 250, gemini: false, release: 'R', draft: null, polished: {}, fb: [], models: {},
  en: [[6000, 8000, 'Hello there'], [9000, 11000, 'Second line']],
  stats: { deeplChars: 11, geminiCalls: 0, retries: 0, fallbackChunks: 0, englishLines: 0 },
});
function controlled() {
  const runs = [];
  const run = (opts) => new Promise((resolve) => {
    const r = {
      opts, st: fakeSt(),
      draft() { r.st.draft = ['Γεια σου εκεί', 'Δεύτερη γραμμή']; opts.onProgress({ phase: 'draft', chunk: null, chunks: 1, doneChunks: 0, kind: 'draft', job: r.st }); },
      finish() { resolve({ ok: true, state: 'done', kind: 'final', srt: 'FINAL SRT\n', stats: r.st.stats }); },
    };
    runs.push(r);
  });
  return { run, runs };
}
const english1 = async () => ({ cues: [{ start: 6000, end: 8000, raw: 'Hello there' }], release: 'R' });

const GREEK = [{ provider: 'greeksubs', ref: 'abc', release: 'Show.S01E02.720p', _score: 5 }];
const CANDS = [{ provider: 'subdl', ref: 'sd-1', release: 'Show.S01E02.WEB-GRP', hearingImpaired: false }, { provider: 'opensubtitles', ref: 'os-9', release: 'Show.S01E02.HDTV' }];

/** One express app with both routes. greek/englishList feed the mocked searches; calls records what the route asked for. */
async function boot({ greek = [], englishList = CANDS, jobs, waitMs = 1500 } = {}) {
  const calls = { start: [] };
  const start = (args, opts) => { calls.start.push({ args, opts }); return { greek: Promise.resolve(greek), english: Promise.resolve(opts.english ? englishList : []) }; };
  const app = express();
  const sub = createSubtitlesHandler({ baseUrl: BASE, start });
  app.get('/:token/subtitles/:type/:id.json', sub);
  app.get('/ai/:blob', createAiHandler({ jobs: jobs || createJobs({ run: controlled().run, fetchEn: english1, writesToday: () => 0, log: () => {}, env: {} }), waitMs, log: (m) => logs.push(m) }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = async (p, headers) => { const res = await fetch(url + p, headers ? { headers } : undefined); const text = await res.text(); bodies.push(text); return { res, text }; };
  return {
    calls, get,
    list: async (token, p = '/series/tt0364845:1:2') => JSON.parse((await get(`/${token}/subtitles${p}.json`)).text),
    ai: (entryUrl, headers) => get(entryUrl.replace(BASE, ''), headers),
  };
}
const link = (ai = { deepl: DEEPL, gemini: GEMINI }) => seal({ maxResults: 20, providers: { subdl: { apiKey: SUBDL }, greeksubs: { enabled: true } }, ...(ai ? { ai } : {}) });
const blobOf = (entry) => open(entry.url.replace(`${BASE}/ai/`, '').replace(/\.srt$/, ''));

// ================= the subtitles route =================
test('no Greek and an AI key: exactly one entry, id with AI and the state, label, /ai/ URL, list not cached', async () => {
  setAiStore(store = memStore());
  const t = await boot();
  const r = await t.list(link());
  assert.equal(r.subtitles.length, 1);
  const e = r.subtitles[0];
  assert.match(e.id, /\bAI\b/);
  assert.match(e.id, /^AI:tt0364845:1:2:draft \| AI translation from Show\.S01E02\.WEB-GRP$/);
  assert.equal(e.lang, 'ell');
  assert.equal(e.label, 'Ελληνικά (AI)');
  assert.ok(e.url.startsWith(`${BASE}/ai/`) && e.url.endsWith('.srt'));
  assert.equal(r.cacheMaxAge, 0, 'a draft entry must be re-listed');
  assert.deepEqual(Object.keys(r).sort(), ['cacheMaxAge', 'subtitles']);

  // the English search ran together with the Greek one, for a link with a key
  assert.equal(t.calls.start.length, 1);
  assert.equal(t.calls.start[0].opts.english, true);

  // the sealed blob: title, the English candidates, only the providers' own settings, the AI keys; plaintext keys are not in the URL
  const b = blobOf(e);
  assert.equal(b.v, 1);
  assert.deepEqual([b.imdbId, b.s, b.e], ['tt0364845', 1, 2]);
  assert.deepEqual(b.cands.map((c) => c.provider), ['subdl', 'opensubtitles']);
  assert.deepEqual(b.pc, { subdl: { apiKey: SUBDL } });
  assert.deepEqual(b.ai, { deepl: DEEPL, gemini: GEMINI });
  for (const k of KEYS) assert.ok(!e.url.includes(k));
  assert.ok(parseAiBlob(b), 'the route accepts what the trigger builds');
});

test('a film works too: no season and episode in the id or the blob', async () => {
  setAiStore(store = memStore());
  const t = await boot();
  const r = await t.list(link(), '/movie/tt0111161');
  assert.equal(r.subtitles.length, 1);
  assert.match(r.subtitles[0].id, /^AI:tt0111161:draft \| /);
  const b = blobOf(r.subtitles[0]);
  assert.equal(b.s, undefined);
  assert.equal(parseAiBlob(b).type, 'movie');
});

test('Greek results exist: no AI entry, and the final file and job record are deleted; the glossary stays', async () => {
  setAiStore(store = memStore());
  store.m.set(`text:${finalKey('tt0364845', 1, 2)}`, Buffer.from('OLD AI FILE'));
  store.m.set(`json:${jobKey('tt0364845', 1, 2)}`, Buffer.from(JSON.stringify({ v: 1, state: 'running', en: [] })));
  store.m.set(`json:${glossaryKey('tt0364845')}`, Buffer.from('{"Kayla":"Κέιλα"}'));
  const t = await boot({ greek: GREEK });
  const r = await t.list(link());
  assert.equal(r.subtitles.length, 1);
  assert.match(r.subtitles[0].id, /^greeksubs:abc \| /);
  assert.ok(!r.subtitles.some((s) => /\bAI\b/.test(s.id)));
  assert.equal(r.cacheMaxAge, undefined);
  await settle();
  assert.deepEqual(store.dels.sort(), [finalKey('tt0364845', 1, 2), jobKey('tt0364845', 1, 2)].sort());
  assert.equal(store.m.has(`text:${finalKey('tt0364845', 1, 2)}`), false);
  assert.equal(store.m.has(`json:${jobKey('tt0364845', 1, 2)}`), false);
  assert.ok(store.m.has(`json:${glossaryKey('tt0364845')}`), 'the glossary is kept');
  // nothing left over: the next list does not delete again
  store.dels.length = 0;
  await t.list(link());
  await settle();
  assert.deepEqual(store.dels, []);
});

test('no keys and no cached file: nothing is listed and the English search is not started', async () => {
  setAiStore(store = memStore());
  const t = await boot();
  assert.deepEqual(await t.list(link(null)), { subtitles: [] });
  assert.equal(t.calls.start[0].opts.english, false);
  assert.deepEqual(await t.list(link({})), { subtitles: [] }, 'an empty ai object is the same as none');
});

test('no keys but a finished file exists: one entry for everyone, state final, list may be cached', async () => {
  setAiStore(store = memStore());
  store.m.set(`text:${finalKey('tt0364845', 1, 2)}`, Buffer.from('1\n00:00:00,000 --> 00:00:05,000\nx\n'));
  store.m.set(`json:${jobKey('tt0364845', 1, 2)}`, Buffer.from(JSON.stringify({ v: 1, state: 'done', release: 'Show.S01E02.WEB-GRP', en: [] })));
  const t = await boot({ englishList: [] });
  const r = await t.list(link(null));
  assert.equal(r.subtitles.length, 1);
  assert.match(r.subtitles[0].id, /^AI:tt0364845:1:2:final \| AI translation from Show\.S01E02\.WEB-GRP$/);
  assert.equal(r.cacheMaxAge, undefined);
  assert.equal(t.calls.start[0].opts.english, false);
  assert.equal(blobOf(r.subtitles[0]).ai, undefined, 'no keys in a link that has none');
});

test('a key but no English file anywhere and no saved job: nothing is listed', async () => {
  setAiStore(store = memStore());
  const t = await boot({ englishList: [] });
  assert.deepEqual(await t.list(link()), { subtitles: [] });
});

test('a link without ai behaves as before: same shape, ids and /dl/ blob as the old route', async () => {
  setAiStore(store = memStore());
  const t = await boot({ greek: GREEK });
  const plain = await t.list(link(null));
  const keyed = await t.list(link());
  assert.deepEqual(Object.keys(plain), ['subtitles']);
  assert.deepEqual(plain.subtitles.map((s) => Object.keys(s)), [['id', 'url', 'lang']]);
  assert.equal(plain.subtitles[0].id, 'greeksubs:abc | Show.S01E02.720p');
  assert.equal(plain.subtitles[0].lang, 'ell');
  assert.ok(plain.subtitles[0].url.startsWith(`${BASE}/dl/`) && plain.subtitles[0].url.endsWith('.srt'));
  assert.deepEqual(open(plain.subtitles[0].url.replace(`${BASE}/dl/`, '').replace(/\.srt$/, '')), { p: 'greeksubs', r: 'abc', s: 1, e: 2, c: { enabled: true } });
  assert.deepEqual(keyed.subtitles.map((s) => s.id), plain.subtitles.map((s) => s.id), 'a key changes nothing when Greek exists');
  assert.equal(t.calls.start[0].opts.english, false);
  assert.deepEqual(await (await t.get('/not-a-token/subtitles/series/tt1:1:1.json')).res.status, 400);
});

// ================= the /ai/ route =================
async function entryFor(t, token = link()) { return (await t.list(token)).subtitles[0]; }

test('two simultaneous fetches of the same /ai/ URL start one job and get the same answer', async () => {
  setAiStore(store = memStore());
  const c = controlled();
  const jobs = createJobs({ run: c.run, fetchEn: english1, writesToday: () => 0, log: () => {}, env: {} });
  const t = await boot({ jobs, waitMs: 60 });
  const e = await entryFor(t);
  const [a, b] = await Promise.all([t.ai(e.url), t.ai(e.url)]);
  assert.equal(c.runs.length, 1);
  assert.equal(a.res.status, 200);
  assert.equal(a.text, b.text);
  assert.equal(a.res.headers.get('cache-control'), 'no-store');
  assert.match(a.res.headers.get('content-type'), /^application\/x-subrip; charset=utf-8/);
});

test('the status file: one cue over the whole video, Greek and English, progress and the instruction to pick again', async () => {
  setAiStore(store = memStore());
  const jobs = createJobs({ run: controlled().run, fetchEn: english1, writesToday: () => 0, log: () => {}, env: {} });
  const t = await boot({ jobs, waitMs: 30 });
  const { text, res } = await t.ai((await entryFor(t)).url);
  const cues = parseSrt(text);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].start, 0);
  assert.ok(cues[0].end >= 3 * 3600 * 1000 || cues[0].end > 11000);
  assert.match(cues[0].raw, /Μετάφραση AI σε εξέλιξη: \d+%\. Διάλεξε ξανά τον υπότιτλο σε 1 λεπτό\./);
  assert.match(cues[0].raw, /AI translation in progress: \d+%\. Pick this subtitle again in a minute\./);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('the 7 s wait returns the draft as soon as it exists; the job keeps running; the next fetch gets the final file with max-age', async () => {
  assert.equal(DRAFT_WAIT_MS, 7000);
  setAiStore(store = memStore());
  const c = controlled();
  const jobs = createJobs({ run: c.run, fetchEn: english1, writesToday: () => 0, log: () => {}, env: {} });
  const t = await boot({ jobs, waitMs: 3000 });
  const e = await entryFor(t);
  const t0 = Date.now();
  const first = t.ai(e.url);
  await settle(40);
  c.runs[0].draft();
  const { text, res } = await first;
  assert.ok(Date.now() - t0 < 1500, 'answered when the draft was ready, not after the full wait');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const cues = parseSrt(text);
  assert.match(cues[0].raw, /Πρόχειρη μετάφραση με τεχνητή νοημοσύνη \(AI\)/);
  assert.equal(cues[0].start, 0);
  assert.ok(cues[0].end < 6000, 'the label ends before the first real cue');
  assert.deepEqual(cues.slice(1).map((x) => [x.start, x.end, x.raw]), [[6000, 8000, 'Γεια σου εκεί'], [9000, 11000, 'Δεύτερη γραμμή']]);

  assert.equal(jobs.find({ imdbId: 'tt0364845', season: 1, episode: 2 }).state, 'running', 'the job outlived the request');
  c.runs[0].finish();
  await settle();
  const done = await t.ai(e.url);
  assert.equal(done.text, 'FINAL SRT\n');
  assert.equal(done.res.headers.get('cache-control'), 'public, max-age=86400');
  assert.equal(c.runs.length, 1, 'serving the final file started nothing');
  assert.ok(store.m.has(`text:${finalKey('tt0364845', 1, 2)}`));
});

test('a finished file is served at once with max-age=86400, even to a link without keys', async () => {
  setAiStore(store = memStore());
  const c = controlled();
  const jobs = createJobs({ run: c.run, fetchEn: english1, writesToday: () => 0, log: () => {}, env: {} });
  store.m.set(`text:${finalKey('tt0364845', 1, 2)}`, Buffer.from('1\n00:00:00,000 --> 00:00:05,000\nΤελική\n'));
  const t = await boot({ jobs, englishList: [] });
  const e = await entryFor(t, link(null));
  const { text, res } = await t.ai(e.url);
  assert.equal(text, '1\n00:00:00,000 --> 00:00:05,000\nΤελική\n');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
  assert.equal(c.runs.length, 0);
});

test('no keys and no cached file: the status text, not an error', async () => {
  setAiStore(store = memStore());
  const t = await boot();
  const entry = { url: `${BASE}/ai/${seal({ v: 1, imdbId: 'tt0364845', s: 1, e: 2, cands: CANDS })}.srt` };
  const { text, res } = await t.ai(entry.url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(parseSrt(text)[0].raw, /δεν έχει κλειδιά AI[^]*no AI keys/);
});

test('busy: with 2 running and 10 waiting, the next title gets a status file saying busy', async () => {
  setAiStore(store = memStore());
  const jobs = createJobs({ run: controlled().run, fetchEn: english1, writesToday: () => 0, log: () => {}, env: { AI_USER_DAILY: '50', AI_GLOBAL_DAILY: '50' } });
  const mk = (i) => ({
    imdbId: `tt${1000 + i}`, season: 1, episode: 1, type: 'series', candidates: [], providerCfgs: {},
    keys: { deepl: `deepl-load-user-${i}-key-0123456789`, gemini: '' },
  });
  for (let i = 0; i < 12; i++) assert.ok(jobs.ensure(mk(i)).job, `job ${i}`);
  assert.equal(jobs.stats().running, 2);
  assert.equal(jobs.stats().waiting, 10);
  const t = await boot({ jobs, waitMs: 30 });
  const entry = await entryFor(t);
  const { text, res } = await t.ai(entry.url);
  assert.equal(res.status, 200);
  assert.match(parseSrt(text)[0].raw, /Τρέχουν ήδη πολλές μεταφράσεις AI[^]*AI translation is busy right now\. Try again later\./);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('a bad or tampered link gets a plain 400; the route never answers 5xx', async () => {
  setAiStore(store = memStore());
  const t = await boot({ waitMs: 30 });
  const e = await entryFor(t);
  const blob = e.url.replace(`${BASE}/ai/`, '').replace(/\.srt$/, '');
  const flipped = blob.slice(0, 40) + (blob[40] === 'A' ? 'B' : 'A') + blob.slice(41);
  for (const bad of [flipped, 'garbage', blob.slice(0, -5), seal({ p: 'greeksubs', r: '1' }), seal({ v: 1, imdbId: 'not-an-id' }), seal({ v: 1, imdbId: 'tt1', s: 1 }), seal({ v: 1, imdbId: 'tt1', ai: { deepl: 'bad key' } })]) {
    const { res, text } = await t.get(`/ai/${bad}.srt`);
    assert.equal(res.status, 400, bad.slice(0, 12));
    assert.equal(text, 'bad link');
    assert.match(res.headers.get('content-type'), /^text\/plain/);
  }
  // a job queue that breaks: still 200 with a status text
  const t2 = await boot({ jobs: { ensure() { throw new Error('queue exploded'); } }, waitMs: 30 });
  const { res, text } = await t2.get(`/ai/${blob}.srt`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(parseSrt(text)[0].raw, /AI translation is not available right now/);
});

test('a job lost to a restart resumes from the saved record: no new download, no new DeepL draft, only the unfinished chunks', async () => {
  setAiStore(store = memStore());
  const ENV = { AI_GEMINI_MODEL: 'gemini-test-flash', AI_CHUNK_CUES: '50', AI_USER_DAILY: '50', AI_GLOBAL_DAILY: '50' };
  const eng = { release: 'Show.S01E02.WEB-GRP', cues: Array.from({ length: 120 }, (_, i) => ({ start: 6000 + i * 3000, end: 8000 + i * 3000, raw: `Line ${i} here` })) };

  const calls = { deepl: 0, usage: 0, gemini: [] };
  let hang = true;
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init) => {
    url = String(url);
    const body = init?.body ? JSON.parse(init.body) : null;
    if (url.includes('/v2/usage')) { calls.usage++; return reply(200, { character_count: 0, character_limit: 1e6 }); }
    if (url.includes('/v2/translate')) { calls.deepl++; return reply(200, { translations: body.text.map((x) => ({ text: `Σχέδιο ${x}` })) }); }
    if (/\/models\?/.test(url)) return reply(200, { models: [{ name: 'models/gemini-test-flash', supportedGenerationMethods: ['generateContent'] }] });
    if (url.includes(':generateContent')) {
      const system = body.systemInstruction.parts[0].text, user = body.contents[0].parts[0].text;
      const kind = /subtitle editor/.test(system) ? 'polish' : /professional subtitle translator/.test(system) ? 'translate' : 'glossary';
      const items = JSON.parse(user.slice(user.lastIndexOf('strings:\n') + 9).split('\n')[0]);
      calls.gemini.push({ kind, n: items.length });
      if (kind === 'polish' && hang && calls.gemini.filter((g) => g.kind === 'polish').length === 2) await new Promise(() => {}); // the first server dies here
      const out = items.map((x) => (kind === 'polish' ? `Τελικό ${x.en}` : 'Κέιλα'));
      return reply(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] }, finishReason: 'STOP' }], usageMetadata: {} });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const runOpts = { fetchImpl, sleep: async () => {}, minSaveGapMs: 0 };
  const keysOf = (n) => ({ deepl: `deepl-resume-key-${n}-0123456789:fx`, gemini: 'AIza' + `ResumeGeminiKey${n}0123456789AB` });
  let downloads = 0;
  const fetchEn = async () => { downloads++; return eng; };
  const jobsOf = () => createJobs({ fetchEn, writesToday: () => 0, log: (m) => logs.push(m), env: ENV, runOpts });

  // first server: starts the job, gets as far as the draft and one polished chunk, then "dies" (the Gemini call never answers)
  const j1 = jobsOf();
  const t1 = await boot({ jobs: j1, waitMs: 20 });
  const e1 = await entryFor(t1, link(keysOf(1)));
  await t1.ai(e1.url);
  for (let i = 0; i < 100 && !(JSON.parse(store.m.get(`json:${jobKey('tt0364845', 1, 2)}`)?.toString() || 'null')?.polished?.[0]); i++) await settle(20);
  const rec = JSON.parse(store.m.get(`json:${jobKey('tt0364845', 1, 2)}`).toString());
  assert.equal(rec.state, 'running');
  assert.ok(rec.draft && rec.polished[0] && !rec.polished[1]);
  assert.equal(downloads, 1);
  const deeplBefore = calls.deepl, usageBefore = calls.usage;
  assert.equal(store.m.has(`text:${finalKey('tt0364845', 1, 2)}`), false);

  // the restart: a new queue, an empty memory, the same store; the user's link now carries other keys
  hang = false;
  calls.gemini.length = 0;
  downloads = 0;
  const j2 = jobsOf();
  const t2 = await boot({ jobs: j2, waitMs: 2000 });
  const e2 = await entryFor(t2, link(keysOf(2)));
  assert.match(e2.id, /:draft \|/, 'still a draft in the list: the job record exists, the final file does not');
  await t2.ai(e2.url);
  for (let i = 0; i < 100 && !store.m.has(`text:${finalKey('tt0364845', 1, 2)}`); i++) await settle(20);
  assert.ok(store.m.has(`text:${finalKey('tt0364845', 1, 2)}`), 'the job finished');
  assert.equal(downloads, 0, 'the English text came from the record');
  assert.equal(calls.deepl, deeplBefore, 'no second DeepL draft');
  assert.equal(calls.usage, usageBefore);
  assert.deepEqual(calls.gemini.map((g) => [g.kind, g.n]), [['polish', 50], ['polish', 20]], 'only the unfinished chunks were polished');

  const done = await t2.ai(e2.url);
  assert.equal(done.res.headers.get('cache-control'), 'public, max-age=86400');
  const cues = parseSrt(done.text);
  assert.equal(cues.length, 121);
  assert.match(cues[0].raw, /^Μετάφραση με τεχνητή νοημοσύνη \(AI\)\./);
  assert.equal(cues[1].raw, 'Τελικό Line 0 here');
  assert.equal(cues[120].raw, 'Τελικό Line 119 here');
  assert.deepEqual(cues.slice(1).map((c) => c.start), eng.cues.map((c) => c.start));
  // the next list shows the final entry
  assert.match((await t2.list(link(keysOf(2)))).subtitles[0].id, /^AI:tt0364845:1:2:final \| /);
});

test('a job resumed from a record with a draft serves it on the first fetch, fast, without a DeepL call', async () => {
  setAiStore(store = memStore());
  const eng = { release: 'Show.S01E02.WEB-GRP', cues: Array.from({ length: 4 }, (_, i) => ({ start: 6000 + i * 3000, end: 8000 + i * 3000, raw: `Line ${i} here` })) };
  const enRaw = eng.cues.map((c) => [c.start, c.end, c.raw]);
  const fp = crypto.createHash('sha1').update(JSON.stringify(enRaw)).digest('hex').slice(0, 16); // same formula as the pipeline
  const rec = { ...fakeSt(), fp, en: enRaw, chunk: 250, draft: eng.cues.map((c, i) => `Σχέδιο ${i}`) };
  store.m.set(`json:${jobKey('tt0364845', 1, 2)}`, Buffer.from(JSON.stringify(rec)));

  const calls = { deepl: 0, gemini: 0 };
  const fetchImpl = async (url) => {
    url = String(url);
    if (url.includes('/v2/')) { calls.deepl++; throw new Error('DeepL must not be called'); }
    calls.gemini++;
    return new Promise(() => {}); // Gemini never answers: the job stays running, only the saved draft can be served
  };
  const jobs = createJobs({ fetchEn: async () => { throw new Error('no download expected'); }, writesToday: () => 0, log: (m) => logs.push(m), env: { AI_GEMINI_MODEL: 'gemini-test-flash' }, runOpts: { fetchImpl, sleep: async () => {}, minSaveGapMs: 0 } });
  const t = await boot({ jobs, waitMs: 3000 });
  const e = await entryFor(t, link({ deepl: 'deepl-resume-draft-key-0123456789:fx', gemini: 'AIza' + 'ResumeDraftGeminiKey0123456789AB' }));
  const t0 = Date.now();
  const got = await t.ai(e.url);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `first fetch took ${ms} ms`);
  assert.equal(calls.deepl, 0);
  assert.match(got.text, /Σχέδιο 0/);
  assert.ok(logs.some((l) => /fetch tt0364845:1:2 answer=draft/.test(l)));
});

// ================= keys never leak =================
test('one [ai] fetch line per request: answer, kind, request ms, job age, chunks and a short client name; never the User-Agent itself', async () => {
  setAiStore(store = memStore());
  const c = controlled();
  const jobs = createJobs({ run: c.run, fetchEn: english1, writesToday: () => 0, log: () => {}, env: {} });
  const t = await boot({ jobs, waitMs: 40 });
  const e = await entryFor(t);
  const fetchLines = () => logs.filter((l) => l.startsWith('[ai] fetch '));
  const n0 = fetchLines().length;
  await t.ai(e.url, { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Stremio/4.4.168 SecretBuild/9.9' }); // still running: status
  c.runs[0].draft();
  await t.ai(e.url, { 'user-agent': 'mpv 0.38.0' }); // the draft
  c.runs[0].finish(); await settle();
  await t.ai(e.url, { 'user-agent': 'curl/8.4.0' }); // the finished file, from the store
  await t.get('/ai/not-a-real-blob.srt');
  const lines = fetchLines().slice(n0);
  assert.equal(lines.length, 4, lines.join('\n'));
  assert.match(lines[0], /^\[ai\] fetch tt0364845:1:2 answer=status kind=running ms=\d+ job_ms=\d+ chunk=0\/0 client=stremio$/);
  assert.match(lines[1], /^\[ai\] fetch tt0364845:1:2 answer=draft kind=draft ms=\d+ job_ms=\d+ chunk=0\/1 client=mpv$/);
  assert.match(lines[2], /^\[ai\] fetch tt0364845:1:2 answer=final kind=final ms=\d+ job_ms=0 chunk=0\/0 client=other$/);
  assert.match(lines[3], /^\[ai\] fetch - answer=bad_link ms=\d+ client=other$/);
  const ms = Number(lines[0].match(/ ms=(\d+)/)[1]);
  assert.ok(ms >= 30 && ms < 2000, `request time, not job age: ${ms}`);
  for (const l of lines) assert.ok(!/SecretBuild|Mozilla|curl|\/ai\/|https?:/.test(l), l);
});

test('clientOf: a fixed list of short names, nothing else from the header', () => {
  const cases = [[undefined, 'none'], ['', 'none'], ['StremioShell/4.4', 'stremio'], ['Lavf/60.3.100 libmpv', 'mpv'], ['ExoPlayerLib/2.19.1', 'exoplayer'],
    ['VLC/3.0.20 LibVLC/3.0.20', 'vlc'], ['Mozilla/5.0 (Windows NT 10.0) Chrome/130', 'browser'], ['node', 'other'], ['x'.repeat(500), 'other']];
  for (const [ua, want] of cases) assert.equal(clientOf(ua), want, String(ua));
});

test('no key appears in any log line, store write or response body of this file', () => {
  assert.ok(allSets.length > 3, 'the store saw writes');
  assert.ok(logs.length > 10, 'something was logged');
  assert.ok(bodies.length > 10, 'responses were collected');
  const all = [...logs, ...bodies, ...allSets];
  const keyLike = [DEEPL, GEMINI, SUBDL, 'deepl-resume-key-1-0123456789:fx', 'deepl-resume-key-2-0123456789:fx', 'AIza' + 'ResumeGeminiKey10123456789AB', 'AIza' + 'ResumeGeminiKey20123456789AB', 'deepl-load-user-'];
  for (const k of keyLike) for (const line of all) assert.ok(!line.includes(k), `a key leaked: ${k.slice(0, 10)}…`);
});
