// Robustness of the AI path: Cloudflare write limits, a store that refuses or never answers, the route deadline, hung
// downloads, ended jobs leaving memory, the per-user waiting limit and bad input. Offline; short timeouts instead of real waits.
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { seal } from '../src/lib/crypto.js';
import { createKvStore } from '../src/lib/kv.js';
import { createJobs, MAX_WAITING_PER_USER } from '../src/lib/ai/jobs.js';
import { createAiHandler, DRAFT_WAIT_MS, STORE_WAIT_MS } from '../src/lib/ai/route.js';
import { createSubtitlesHandler } from '../src/lib/subtitles.js';
import { fetchEnglish } from '../src/lib/ai/english.js';
import { finalKey, jobKey } from '../src/lib/ai/pipeline.js';
import { setAiStore, delAi } from '../src/lib/cache.js';
import { parseSrt } from '../src/lib/srt.js';

const warns = [];
const orig = {};
before(() => { for (const m of ['log', 'warn', 'error', 'info']) { orig[m] = console[m]; console[m] = (...a) => { warns.push(a.map(String).join(' ')); }; } });
after(() => { for (const m of Object.keys(orig)) console[m] = orig[m]; });

const servers = [];
afterEach(async () => {
  setAiStore(null);
  await delAi(finalKey('tt7770001', 1, 2), { kind: 'text' });
  await delAi(jobKey('tt7770001', 1, 2), { kind: 'json' });
  while (servers.length) await new Promise((r) => servers.pop().close(r));
});
const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await settle(5); }
}
async function serve(app) {
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

const english1 = async () => ({ cues: [{ start: 6000, end: 8000, raw: 'Hello there' }], release: 'R' });
let n = 0;
const spec = (over = {}) => ({
  imdbId: `tt${String(8000000 + ++n)}`, season: 1, episode: 2, type: 'series', filename: 'x.mkv',
  candidates: [], providerCfgs: { subdl: { apiKey: 'provider-key-123' } },
  keys: { deepl: `deeplkey-user-${n}-0123456789:fx`, gemini: '' }, ...over,
});
const make = (over = {}) => {
  const logs = [];
  const jobs = createJobs({ fetchEn: english1, writesToday: () => 0, log: (m) => logs.push(m), env: { AI_USER_DAILY: '500', AI_GLOBAL_DAILY: '500' }, ...over });
  return { jobs, logs };
};
const hang = () => ({ run: () => new Promise(() => {}) }); // a pipeline that never ends
const SLOW_KEY = 'deepl-slow-store-key-0123456789:fx';
const blobFor = (deepl) => seal({ v: 1, imdbId: 'tt7770001', s: 1, e: 2, cands: [], pc: {}, ai: { deepl } });

// ================= Cloudflare says the day's writes are used up =================
const kvOpts = { accountId: 'acct-id-1', namespaceId: 'ns-id-1', apiToken: 'tok-secret-12345', minWriteGapMs: 0 };
const noSecrets = (lines) => { for (const l of lines) assert.ok(!/tok-secret|acct-id-1|ns-id-1|cloudflare\.com/.test(l), l); };

test('a plain 429 on a PUT pauses writes for 5 minutes, then they work again (fake time); one log line, no secrets', async () => {
  const before = warns.length;
  let t = Date.UTC(2026, 9, 18, 10, 0, 0);
  const calls = [];
  let answer = 429;
  const fetchImpl = async (url, init) => { calls.push(init.method); return new Response(JSON.stringify({ errors: [{ message: 'too many requests' }] }), { status: answer }); };
  const store = createKvStore({ ...kvOpts, fetchImpl, now: () => t });
  assert.equal(await store.set('a', Buffer.from('x')), false);
  assert.equal(store.stats().capReached, false, 'the day is not used up');
  const sent = calls.length;
  assert.equal(await store.set('b', Buffer.from('y')), false);
  assert.equal(await store.del('c'), false);
  assert.equal(calls.length, sent, 'paused: nothing is sent');
  t += 4 * 60 * 1000 + 59 * 1000;
  assert.equal(await store.set('b', Buffer.from('y')), false);
  assert.equal(calls.length, sent, 'still paused after 4 min 59 s');
  t += 2000;
  answer = 200;
  assert.equal(await store.set('b', Buffer.from('y')), true, 'writes work again after 5 minutes');
  assert.equal(calls.length, sent + 1);
  const mine = warns.slice(before).filter((l) => l.startsWith('[kv]'));
  assert.equal(mine.length, 1);
  assert.match(mine[0], /paused for 5 min/);
  noSecrets(mine);
});

test('a Retry-After longer than 5 minutes is honoured; a shorter one is not used', async () => {
  let t = 1_000_000_000_000;
  const calls = [];
  let retry = '600';
  const fetchImpl = async (url, init) => { calls.push(init.method); return new Response('{}', { status: 429, headers: { 'Retry-After': retry } }); };
  const store = createKvStore({ ...kvOpts, fetchImpl, now: () => t });
  await store.set('a', Buffer.from('x'));
  t += 6 * 60 * 1000;
  await store.set('a', Buffer.from('x'));
  assert.equal(calls.length, 1, 'paused for 10 minutes, not 5');
  t += 4 * 60 * 1000 + 1000;
  retry = '10';
  await store.set('a', Buffer.from('x'));
  assert.equal(calls.length, 2, 'sent again after the 10 minutes');
  t += 5 * 60 * 1000 + 1000;
  await store.set('a', Buffer.from('x'));
  assert.equal(calls.length, 3, 'a Retry-After of 10 s does not shorten the 5 minute pause');
});

test('a 429 whose body says the daily write limit is reached uses up the day: no more requests, one log line, no secrets', async () => {
  const before = warns.length;
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(init.method); return new Response(JSON.stringify({ errors: [{ message: 'You have exceeded the daily write limit' }] }), { status: 429 }); };
  const store = createKvStore({ ...kvOpts, fetchImpl });
  assert.equal(await store.set('a', Buffer.from('x')), false);
  assert.equal(store.stats().writesToday, store.stats().cap);
  assert.equal(store.stats().capReached, true);
  const sent = calls.length;
  assert.equal(await store.set('b', Buffer.from('y')), false);
  assert.equal(await store.del('c'), false);
  assert.equal(calls.length, sent, 'nothing more was sent');
  const mine = warns.slice(before).filter((l) => l.startsWith('[kv]'));
  assert.equal(mine.length, 1);
  assert.match(mine[0], /daily write limit/);
  noSecrets(mine);
});

test('an error body that names the daily limit does the same with another status (403)', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ errors: [{ message: 'You have exceeded the daily limit for writes' }] }), { status: 403 });
  const store = createKvStore({ ...kvOpts, fetchImpl });
  assert.equal(await store.set('a', Buffer.from('x')), false);
  assert.equal(store.stats().capReached, true);
});

test('a 500 on a PUT is only a failure: the day is not used up', async () => {
  const fetchImpl = async () => new Response('{}', { status: 500 });
  const store = createKvStore({ accountId: 'acct-id-1', namespaceId: 'ns-id-1', apiToken: 'tok-secret-12345', fetchImpl, minWriteGapMs: 0 });
  assert.equal(await store.set('a', Buffer.from('x')), false);
  assert.equal(store.stats().capReached, false);
});

// ================= the store refuses the final file =================
function refusingStore() {
  return { async get() { return null; }, async set() { return false; }, async del() { return true; } };
}
test('the store refuses the final file: final_not_stored is logged, the result stays in memory, later fetches start no new job', async () => {
  setAiStore(refusingStore());
  const eng = { release: 'Show.S01E02.WEB', cues: Array.from({ length: 25 }, (_, i) => ({ start: 6000 + i * 3000, end: 8000 + i * 3000, raw: `Line ${i} here` })) };
  const calls = { deepl: 0, usage: 0 };
  const fetchImpl = async (url, init) => {
    url = String(url);
    if (url.includes('/v2/usage')) { calls.usage++; return new Response(JSON.stringify({ character_count: 0, character_limit: 1e6 }), { status: 200 }); }
    if (url.includes('/v2/translate')) {
      calls.deepl++;
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ translations: body.text.map((x) => ({ text: `Σχέδιο ${x}` })) }), { status: 200 });
    }
    throw new Error(`unexpected request ${url}`);
  };
  let downloads = 0;
  const { jobs, logs } = make({ fetchEn: async () => { downloads++; return eng; }, runOpts: { fetchImpl, sleep: async () => {}, minSaveGapMs: 0 } });
  const s = { imdbId: 'tt7770001', season: 1, episode: 2, type: 'series', candidates: [], providerCfgs: {}, keys: { deepl: 'deepl-nostore-key-0123456789:fx', gemini: '' } };

  const first = jobs.ensure(s);
  await until(() => first.job.endedAt);
  assert.equal(first.job.state, 'done');
  assert.ok(logs.some((l) => l.includes('job_not_saved')), 'the refused job record is logged');
  assert.ok(logs.some((l) => l.includes('final_not_stored')), 'the refused final file is logged');
  assert.equal(jobs.find(s), first.job, 'the finished job stays');
  assert.equal(jobs.stats().running, 0);
  const deeplAfterJob = calls.deepl;

  // the memory layer in front of the store forgets the file (removed by hand here); the store has nothing
  await delAi(finalKey('tt7770001', 1, 2), { kind: 'text' });
  const again = jobs.ensure(s);
  assert.equal(again.attached, true);
  assert.equal(again.job, first.job);

  const app = express();
  app.get('/ai/:blob', createAiHandler({ jobs, waitMs: 500 }));
  const base = await serve(app);
  const blob = blobFor('deepl-nostore-key-0123456789:fx');
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${base}/ai/${blob}.srt`);
    const cues = parseSrt(await res.text());
    assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
    assert.match(cues[0].raw, /AI/);
    assert.equal(cues.length, 26);
  }
  assert.equal(calls.deepl, deeplAfterJob, 'no second DeepL call');
  assert.equal(downloads, 1, 'no second English download');
  assert.equal(jobs.stats().running + jobs.stats().waiting, 0, 'no new job');
  assert.equal(logs.filter((l) => l.includes('state=queued')).length, 1, 'only one job was ever queued');
  assert.equal(first.job.spec.providerCfgs, null);
});

// ================= the deadline =================
test('a store that never answers does not hold the request: it is answered at the deadline with a status file', async () => {
  setAiStore({ get: () => new Promise(() => {}), set: async () => true, del: async () => true });
  const { jobs } = make({ ...hang() });
  const app = express();
  app.get('/ai/:blob', createAiHandler({ jobs, waitMs: 250, storeMs: 40 }));
  const base = await serve(app);
  const t0 = Date.now();
  const res = await fetch(`${base}/ai/${blobFor(SLOW_KEY)}.srt`);
  const text = await res.text();
  const ms = Date.now() - t0;
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(parseSrt(text)[0].raw, /AI translation/);
  assert.ok(ms >= 200 && ms < 900, `answered in ${ms} ms`);
});

test('a job that ended without a draft and a store that never answers: the record read is cut short, the status file comes at once', async () => {
  setAiStore({ get: async () => null, set: async () => true, del: async () => true });
  const { jobs } = make({ run: async () => ({ ok: false, state: 'failed', srt: '' }) });
  const ended = jobs.ensure({ imdbId: 'tt7770001', season: 1, episode: 2, type: 'series', candidates: [], providerCfgs: {}, keys: { deepl: SLOW_KEY, gemini: '' } });
  await until(() => ended.job.endedAt); // the job ends while the store still answers; then the store goes silent
  setAiStore({ get: () => new Promise(() => {}), set: async () => true, del: async () => true });
  const app = express();
  app.get('/ai/:blob', createAiHandler({ jobs, waitMs: 2000, storeMs: 40 }));
  const base = await serve(app);
  const t0 = Date.now();
  const res = await fetch(`${base}/ai/${blobFor(SLOW_KEY)}.srt`);
  const text = await res.text();
  const ms = Date.now() - t0;
  assert.match(parseSrt(text)[0].raw, /δεν ολοκληρώθηκε/);
  assert.ok(ms < 700, `answered in ${ms} ms, far before the 2 s deadline`);
});

test('the deadline is 7 s and a store read in the route is cut at 1.5 s, so no path passes 8 s', () => {
  assert.equal(DRAFT_WAIT_MS, 7000);
  assert.ok(STORE_WAIT_MS <= 1500);
});

// ================= a download that never finishes =================
test('an English download that never finishes times out; the next candidate is tried', async () => {
  const hung = { id: 'hungprov', enabled: () => true, search: async () => [], download: () => new Promise(() => {}) };
  const t0 = Date.now();
  const r = await fetchEnglish({
    type: 'series', imdbId: 'tt7770003', season: 1, episode: 1, cfg: { providers: {} }, providers: [hung], downloadTimeoutMs: 30,
    candidates: [{ provider: 'hungprov', ref: 'hang-a' }, { provider: 'hungprov', ref: 'hang-b' }],
  });
  assert.equal(r, null);
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(warns.filter((l) => l.includes('hungprov download timed out')).length >= 2, true, 'both candidates were tried');
});

test('a job whose English download hangs ends as failed (no_english) and frees its slot for the next job', async () => {
  const hung = { id: 'hungprov', enabled: () => true, search: async () => [], download: () => new Promise(() => {}) };
  const fetchEn = (ctx) => fetchEnglish({ ...ctx, providers: [hung], downloadTimeoutMs: 30, candidates: [{ provider: 'hungprov', ref: `hang-${Math.random()}` }] });
  const { jobs } = make({ fetchEn, ...hang() });
  const a = jobs.ensure(spec());
  const b = jobs.ensure(spec());
  assert.equal(jobs.stats().running, 2);
  const c3 = jobs.ensure(spec()); // waits: both slots are taken
  assert.equal(c3.job.state, 'queued');
  await until(() => a.job.endedAt && b.job.endedAt);
  assert.equal(a.job.state, 'failed');
  assert.equal(a.job.reason, 'no_english');
  await until(() => c3.job.endedAt);
  assert.equal(jobs.stats().running, 0, 'every slot is free again');
});

// ================= ended jobs leave memory =================
test('a failed job leaves memory (text and result) after keepMs; keys and provider settings go at once', async () => {
  const { jobs } = make({
    keepMs: 40,
    run: async (o) => {
      o.onProgress({ phase: 'draft', chunks: 1, doneChunks: 0, kind: 'draft', job: { en: [[1, 2, 'x']], draft: ['y'], polished: {} } });
      return { ok: false, state: 'failed', srt: '' };
    },
  });
  const s = spec();
  const { job } = jobs.ensure(s);
  await until(() => job.endedAt);
  assert.equal(job.spec.keys, null);
  assert.equal(job.spec.providerCfgs, null, 'provider settings are dropped when the job ends');
  assert.ok(job.st, 'the text is still there for repeat fetches');
  assert.equal(jobs.find(s), job);
  await settle(120);
  assert.equal(job.st, null);
  assert.equal(job.result, null);
  assert.equal(jobs.find(s), null, 'removed by the timer, not only by the next fetch');
});

test('the timer of an old job does not remove a newer job for the same title', async () => {
  const { jobs } = make({ keepMs: 60, run: async () => ({ ok: false, state: 'failed', srt: '' }) });
  const s = spec();
  const first = jobs.ensure(s).job;
  await until(() => first.endedAt);
  await settle(90); // past keepMs: the first job is gone
  const second = jobs.ensure(s).job;
  assert.notEqual(second, first);
  await until(() => second.endedAt);
  await settle(5);
  assert.equal(jobs.find(s), second);
});

test('a done job drops the provider settings too', async () => {
  const { jobs } = make({ run: async () => ({ ok: true, state: 'done', srt: 'X\n', finalStored: true }) });
  const { job } = jobs.ensure(spec());
  await until(() => job.endedAt);
  assert.equal(job.state, 'done');
  assert.equal(job.spec.providerCfgs, null);
});

// ================= waiting limit per user =================
test('at most 2 jobs wait for one user; the third is busy, other users are still accepted', () => {
  assert.equal(MAX_WAITING_PER_USER, 2);
  const { jobs } = make({ ...hang() });
  const A = spec();
  const userA = () => ({ keys: A.keys });
  assert.equal(jobs.ensure(A).job.state, 'running');
  assert.equal(jobs.ensure(spec(userA())).job.state, 'queued');
  assert.equal(jobs.ensure(spec(userA())).job.state, 'queued');
  assert.deepEqual(jobs.ensure(spec(userA())), { refused: 'busy' });
  assert.equal(jobs.ensure(spec()).job.state, 'running', 'another user takes the second slot');
  assert.equal(jobs.ensure(spec()).job.state, 'queued', 'and another may wait');
  assert.equal(jobs.stats().waiting, 3);
});

// ================= a % in the file name =================
test('a "%" in the file name gives an empty list, not a crash; the next request still works', async () => {
  let searches = 0;
  const start = () => { searches++; return { greek: Promise.resolve([]), english: Promise.resolve([]) }; };
  const app = express();
  const handler = createSubtitlesHandler({ baseUrl: 'http://x.test', start });
  app.get('/:token/subtitles/:type/:id/:extra.json', handler);
  const base = await serve(app);
  const token = seal({ providers: {} });
  const bad = await fetch(`${base}/${token}/subtitles/series/tt0364845:1:2/filename=100%2525%25zz.json`);
  assert.equal(bad.status, 200);
  assert.deepEqual(await bad.json(), { subtitles: [] });
  const ok = await fetch(`${base}/${token}/subtitles/series/tt0364845:1:2/filename=Show.S01E02.mkv.json`);
  assert.deepEqual(await ok.json(), { subtitles: [] });
  assert.equal(searches, 1, 'only the good request searched');
});

test('index.js logs an unhandled rejection by name only', () => {
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(src, /process\.on\('unhandledRejection', \(e\) => console\.error\(`\[unhandled\] rejection \$\{e\?\.name \|\| 'error'\}`\)\)/);
});
