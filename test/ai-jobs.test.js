import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJobs, titleKey, MAX_RUNNING, MAX_WAITING, WRITE_STOP } from '../src/lib/ai/jobs.js';
import { setAiStore } from '../src/lib/cache.js';

// ---------- mocks ----------
function memStore() {
  const m = new Map(), sets = [], dels = [];
  return {
    m, sets, dels,
    async get(k, { kind }) { return m.get(`${kind}:${k}`) ?? null; },
    async set(k, b, o = {}) { sets.push({ k, text: b.toString('utf8') }); m.set(`${o.kind}:${k}`, b); return true; },
    async del(k, o = {}) { dels.push(k); m.delete(`${o.kind}:${k}`); return true; },
  };
}
afterEach(() => setAiStore(null));
const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));

const fakeSt = () => ({
  v: 1, state: 'running', chunk: 250, gemini: false, release: 'R', draft: null, polished: {}, fb: [], models: {},
  en: [[6000, 8000, 'Hello there'], [9000, 11000, 'Second line']],
  stats: { deeplChars: 11, geminiCalls: 0, retries: 0, fallbackChunks: 0, englishLines: 0 },
});

/** A pipeline the test controls: each call waits until the test calls draft() / finish(). */
function controlled() {
  const runs = [];
  const run = (opts) => new Promise((resolve) => {
    const r = {
      opts, st: fakeSt(),
      draft() {
        r.st.draft = ['Γεια σου εκεί', 'Δεύτερη γραμμή'];
        opts.onProgress({ phase: 'draft', chunk: null, chunks: 1, doneChunks: 0, kind: 'draft', job: r.st });
      },
      finish(state = 'done') { resolve({ ok: state === 'done', state, kind: 'final', srt: state === 'done' ? 'FINAL SRT\n' : '', stats: r.st.stats }); },
    };
    runs.push(r);
  });
  return { run, runs };
}
const english = async () => ({ cues: [{ start: 6000, end: 8000, raw: 'Hello there' }], release: 'R' });

let n = 0;
const spec = (over = {}) => ({
  imdbId: `tt${String(1000000 + ++n)}`, season: 1, episode: 2, type: 'series', filename: 'x.mkv',
  candidates: [{ provider: 'subdl', ref: 'r1', release: 'R', hearingImpaired: false }], providerCfgs: { subdl: { apiKey: 'provider-key-123' } },
  keys: { deepl: `deeplkey-user-${n}-0123456789:fx`, gemini: 'AIza' + `GeminiUserKey${n}ABCDEFG0123` }, ...over,
});
const sameUser = (s) => ({ keys: s.keys });
const make = (over = {}) => {
  setAiStore(memStore());
  const c = controlled(), logs = [];
  const jobs = createJobs({ run: c.run, fetchEn: over.fetchEn || english, writesToday: () => 0, log: (m) => logs.push(m), env: {}, ...over });
  return { jobs, c, logs };
};

// ---------- one job per title ----------
test('two fetches for the same title attach to one job: the pipeline runs once', async () => {
  const { jobs, c, logs } = make();
  const s = spec();
  const a = jobs.ensure(s), b = jobs.ensure({ ...s });
  assert.equal(a.attached, false);
  assert.equal(b.attached, true);
  assert.equal(a.job, b.job);
  await settle();
  assert.equal(c.runs.length, 1);
  assert.equal(titleKey(s), `${s.imdbId}:1:2`);
  assert.equal(logs.filter((l) => /state=queued/.test(l)).length, 1);
});

test('a different user fetching the same title attaches too (the job was started with the first one\'s keys)', async () => {
  const { jobs, c } = make();
  const s = spec();
  const a = jobs.ensure(s), b = jobs.ensure({ ...s, keys: spec().keys });
  assert.equal(a.job, b.job);
  await settle();
  assert.equal(c.runs.length, 1);
});

// ---------- concurrency ----------
test('at most 1 running job per user, at most 2 in all, FIFO for the rest', async () => {
  const { jobs, c } = make({ env: { AI_USER_DAILY: '50', AI_GLOBAL_DAILY: '50' } });
  const A = spec(), B = spec(), C = spec();
  const a1 = jobs.ensure(A), a2 = jobs.ensure(spec(sameUser(A))), b1 = jobs.ensure(B), c1 = jobs.ensure(C);
  await settle();
  assert.equal(c.runs.length, 2, 'only two run: A\'s first and B\'s');
  assert.deepEqual([a1.job.state, a2.job.state, b1.job.state, c1.job.state], ['running', 'queued', 'running', 'queued']);
  assert.deepEqual(jobs.stats(), { ...jobs.stats(), running: 2, waiting: 2 });

  c.runs[0].finish(); // A's first ends: A's second is first in line and A is free again
  await settle();
  assert.deepEqual([a1.job.state, a2.job.state, b1.job.state, c1.job.state], ['done', 'running', 'running', 'queued']);
  c.runs[1].finish(); // B's ends: C may start
  await settle();
  assert.equal(c1.job.state, 'running');
  assert.equal(c.runs.length, 4);
  assert.ok(MAX_RUNNING === 2);
});

test('a user\'s second job does not block a later job of another user (no head-of-line blocking)', async () => {
  const { jobs, c } = make({ env: { AI_USER_DAILY: '50', AI_GLOBAL_DAILY: '50' } });
  const A = spec(), B = spec();
  const a1 = jobs.ensure(A), a2 = jobs.ensure(spec(sameUser(A))), b1 = jobs.ensure(B);
  await settle();
  assert.deepEqual([a1.job.state, a2.job.state, b1.job.state], ['running', 'queued', 'running']);
  assert.equal(c.runs.length, 2);
});

test('at most 10 wait (from different users); the next is refused as busy', async () => {
  const { jobs, c } = make({ env: { AI_USER_DAILY: '500', AI_GLOBAL_DAILY: '500' } });
  assert.equal(jobs.ensure(spec()).job.state, 'running');
  assert.equal(jobs.ensure(spec()).job.state, 'running'); // a second user: 2 running in all
  for (let i = 0; i < MAX_WAITING; i++) assert.ok(jobs.ensure(spec()).job, `waiting #${i + 1}`);
  assert.deepEqual(jobs.ensure(spec()), { refused: 'busy' });
  assert.equal(jobs.stats().waiting, 10);
  await settle();
  assert.equal(c.runs.length, 2);
});

// ---------- daily caps ----------
test('per-user cap (AI_USER_DAILY) and global cap (AI_GLOBAL_DAILY), reset at UTC midnight', async () => {
  let t = Date.UTC(2026, 9, 18, 23, 0, 0);
  const { jobs, c, logs } = make({ now: () => t, env: { AI_USER_DAILY: '2', AI_GLOBAL_DAILY: '3' } });
  const A = spec(), B = spec();
  const done = async (r) => { r.finish(); await settle(); };
  assert.ok(jobs.ensure(A).job); await settle(); await done(c.runs[0]);
  assert.ok(jobs.ensure(spec(sameUser(A))).job); await settle(); await done(c.runs[1]);
  assert.deepEqual(jobs.ensure(spec(sameUser(A))), { refused: 'user_cap' }, 'third job of the same user');
  assert.ok(jobs.ensure(B).job, 'another user is still fine'); await settle(); await done(c.runs[2]);
  assert.deepEqual(jobs.ensure(spec()), { refused: 'global_cap' }, 'the fourth job of the day');
  assert.ok(logs.some((l) => /state=refused_user_cap/.test(l)) && logs.some((l) => /state=refused_global_cap/.test(l)));

  t = Date.UTC(2026, 9, 19, 0, 0, 1); // past UTC midnight
  assert.ok(jobs.ensure(spec(sameUser(A))).job, 'the counters were reset');
});

test('default caps are 10 per user and 40 in all; junk values give the defaults', async () => {
  const { jobs } = make({ run: async () => ({ ok: true, state: 'done', srt: 'x\n', stats: {} }), env: { AI_USER_DAILY: 'lots', AI_GLOBAL_DAILY: '-3' } });
  const A = spec();
  for (let i = 0; i < 10; i++) { assert.ok(jobs.ensure(spec(sameUser(A))).job, `job ${i + 1}`); await settle(5); }
  assert.deepEqual(jobs.ensure(spec(sameUser(A))), { refused: 'user_cap' });
  let ok = 10;
  for (let i = 0; i < 40; i++) { const r = jobs.ensure(spec()); if (r.job) ok++; await settle(2); }
  assert.equal(ok, 40, '10 + 30 more reach the global 40');
  assert.deepEqual(jobs.ensure(spec()), { refused: 'global_cap' });
});

// ---------- the write budget ----------
test('no new job starts at 700 writes today, a job at 699 does; running jobs are not touched', async () => {
  let writes = 699;
  const { jobs, c, logs } = make({ writesToday: () => writes, env: { AI_USER_DAILY: '50', AI_GLOBAL_DAILY: '50' } });
  assert.equal(WRITE_STOP, 700);
  const first = jobs.ensure(spec());
  assert.equal(first.job.state, 'running');
  writes = 700;
  assert.deepEqual(jobs.ensure(spec()), { refused: 'writes' });
  assert.ok(logs.some((l) => /state=refused_writes/.test(l)));
  await settle();
  c.runs[0].finish();
  await settle();
  assert.equal(first.job.state, 'done');
});

test('a waiting job that reaches its turn after the budget ran out fails with reason writes', async () => {
  let writes = 0;
  const { jobs, c } = make({ writesToday: () => writes, env: { AI_USER_DAILY: '50', AI_GLOBAL_DAILY: '50' } });
  const A = spec();
  const a1 = jobs.ensure(A), a2 = jobs.ensure(spec(sameUser(A)));
  await settle();
  writes = 700;
  c.runs[0].finish();
  await settle();
  assert.equal(a1.job.state, 'done');
  assert.equal(a2.job.state, 'failed');
  assert.equal(a2.job.reason, 'writes');
  assert.equal(c.runs.length, 1, 'it never ran');
});

// ---------- life of a job ----------
test('a job keeps running after the request stopped waiting, and waitFor returns when a draft appears', async () => {
  const { jobs, c } = make();
  const { job } = jobs.ensure(spec());
  await settle();
  const t0 = Date.now();
  await jobs.waitFor(job, 40); // the request gives up: nothing ready
  assert.ok(Date.now() - t0 >= 35);
  assert.equal(job.state, 'running');

  const waiting = jobs.waitFor(job, 5000);
  setTimeout(() => c.runs[0].draft(), 30);
  const t1 = Date.now();
  await waiting;
  assert.ok(Date.now() - t1 < 1500, 'woken by the draft, not by the timeout');
  assert.ok(job.st.draft);
  assert.equal(jobs.pct(job), 30);

  c.runs[0].finish(); // long after every request has been answered
  await settle();
  assert.equal(job.state, 'done');
});

test('a failed job stays visible for a minute (no second job from a repeat fetch), then a new one may start', async () => {
  let t = 1_000_000;
  const { jobs, c } = make({ now: () => t, fetchEn: async () => null });
  const s = spec();
  const { job } = jobs.ensure(s);
  await settle();
  assert.equal(job.state, 'failed');
  assert.equal(job.reason, 'no_english');
  assert.equal(jobs.ensure({ ...s }).job, job);
  t += 61_000;
  const again = jobs.ensure({ ...s });
  assert.notEqual(again.job, job);
  assert.equal(c.runs.length, 0);
});

test('a pipeline that throws ends the job as failed with no error text kept', async () => {
  const { jobs } = make({ run: async () => { throw new Error('boom https://x.test/?key=SECRETKEYVALUE'); } });
  const { job } = jobs.ensure(spec());
  await settle();
  assert.equal(job.state, 'failed');
  assert.equal(job.reason, 'error');
  assert.ok(!JSON.stringify({ ...job, waiters: undefined, spec: undefined }).includes('SECRETKEYVALUE'));
});

test('keys live in the job only while it is queued or running, never in the log lines', async () => {
  const { jobs, c, logs } = make();
  const s = spec();
  const { job } = jobs.ensure(s);
  await settle();
  assert.equal(job.spec.keys.deepl, s.keys.deepl);
  c.runs[0].draft();
  c.runs[0].finish();
  await settle();
  assert.equal(job.spec.keys, null);
  assert.ok(logs.length >= 4);
  for (const l of logs) {
    assert.ok(!l.includes(s.keys.deepl) && !l.includes(s.keys.gemini) && !l.includes('provider-key-123'), l);
    assert.match(l, /^\[ai\] tt\d+:1:2 state=\S+ chunk=\d+\/\d+ ms=\d+ deepl_chars=\d+ retries=\d+ fallback_chunks=\d+$/);
  }
  assert.deepEqual(logs.map((l) => l.match(/state=(\S+)/)[1]), ['queued', 'running', 'draft', 'done']);
});

test('no usable key: refused as nokeys; a key with a space or newline is not usable', () => {
  const { jobs } = make();
  assert.deepEqual(jobs.ensure(spec({ keys: {} })), { refused: 'nokeys' });
  assert.deepEqual(jobs.ensure(spec({ keys: { deepl: 'bad key with space', gemini: 'x\r\nHeader: y' } })), { refused: 'nokeys' });
});
