// In-process job queue for AI translations.
//   createJobs(opts) -> { ensure(spec), find(spec), waitFor(job, ms), pct(job), stats() }
//   jobs              the default queue used by the server
//
// Rules this file keeps:
//   - One job per title ({tt,s,e}): a second fetch of the same URL attaches to the running job and never starts another
//     (Stremio's helper and its web view fetch the same URL at the same time).
//   - At most 1 running job per user scope (scopeOf of the AI keys), at most 2 running in all, at most 10 waiting (FIFO) and at most
//     2 of those waiting for one scope. Over that, ensure() refuses with 'busy' and the route answers with a status file.
//   - Daily caps in memory, reset at UTC midnight: AI_USER_DAILY (default 10) per scope and AI_GLOBAL_DAILY (default 40) in all.
//   - No NEW job starts once the AI store has taken 700 writes today (kvStore.stats().writesToday); running jobs finish.
//   - A job outlives the request that started it. Requests only wait for it (waitFor) and then answer with what is ready.
//   - The user's keys (spec.keys) and provider settings (spec.providerCfgs) live in the job object while it is queued or running and
//     are dropped when it ends. They are not in the job record, the final file, the logs or an error message. Log lines are built
//     from counters only.
//   - A job that ends in any state but 'done' leaves memory ENDED_KEEP_MS after it ended (timer), with its text and result.
//   - If the store refused the final file (final_not_stored), the finished job stays in memory for the life of the process (job.kept),
//     so a repeat fetch is served from it and never starts a new job that would spend the user's quota again.
//   - Everything here is in memory: after a restart (Render free sleeps after about 15 minutes idle) the queue and the daily counters
//     start from zero.
//   - A job interrupted by a restart is not in memory any more; the next fetch starts a new job, which continues from the saved
//     record (the pipeline reads it; the English text comes from the record, so nothing is downloaded again).
import { runPipeline, jobKey, finalKey, FINAL_TTL_SEC } from './pipeline.js';
import { fetchEnglish } from './english.js';
import { getAi, setAi } from '../cache.js';
import { scopeOf } from '../health.js';
import { looksLikeKey } from './http.js';
import { kvStore } from '../kv.js';

export const MAX_RUNNING = 2;
export const MAX_RUNNING_PER_USER = 1;
export const MAX_WAITING = 10;
export const MAX_WAITING_PER_USER = 2;
export const WRITE_STOP = 700;
export const ENDED_KEEP_MS = 60 * 1000; // a job that failed or paused stays visible this long, so a repeat fetch does not start another
const DAY_MS = 24 * 3600 * 1000;

const wholeNumber = (v, dflt) => { const n = /^\d{1,6}$/.test(String(v ?? '').trim()) ? Number(v) : NaN; return n > 0 ? n : dflt; };

/** `tt0364845:23:20`; a film is `tt0111161:0:0` like the store keys. */
export const titleKey = ({ imdbId, season, episode }) => `${imdbId}:${season ?? 0}:${episode ?? 0}`;

const keyScope = (keys = {}) => scopeOf({ apiKey: keys.deepl || '', username: keys.gemini || '' });

/**
 * spec: { imdbId, season, episode, type, filename, candidates, providerCfgs, keys: { deepl, gemini } }
 * Test hooks: run, fetchEn, writesToday, now, log, env, runOpts (extra options for the pipeline), keepMs.
 */
export function createJobs({
  run = runPipeline, fetchEn = fetchEnglish, writesToday = () => kvStore.stats().writesToday,
  now = Date.now, log = (m) => console.log(m), env = process.env, runOpts = {}, keepMs = ENDED_KEEP_MS,
} = {}) {
  const byTitle = new Map(); // titleKey -> job
  const running = new Set();
  let waiting = [];
  const daily = { day: -1, users: new Map(), total: 0 };

  const limits = () => ({ user: wholeNumber(env?.AI_USER_DAILY, 10), global: wholeNumber(env?.AI_GLOBAL_DAILY, 40) });
  function rollDay() {
    const d = Math.floor(now() / DAY_MS); // UTC midnight
    if (d !== daily.day) { daily.day = d; daily.users.clear(); daily.total = 0; }
  }

  // ----- one log line per job event, from counters only -----
  function event(job, state) {
    const s = job.st?.stats || {};
    const done = job.st ? Object.keys(job.st.polished || {}).length : 0;
    log(`[ai] ${job.key} state=${state} chunk=${done}/${job.progress?.chunks ?? 0} ms=${now() - job.createdAt} ` +
      `deepl_chars=${s.deeplChars || 0} retries=${s.retries || 0} fallback_chunks=${s.fallbackChunks || 0}`);
  }
  const refusedLine = (tag, why) => log(`[ai] ${tag} state=refused_${why} chunk=0/0 ms=0 deepl_chars=0 retries=0 fallback_chunks=0`);

  const notify = (job) => { for (const w of [...job.waiters]) w(); };

  /** -> the live job for the title, or null (a finished job is gone, a failed one is kept for ENDED_KEEP_MS). */
  function find(spec) {
    const k = titleKey(spec);
    const job = byTitle.get(k);
    if (!job) return null;
    if (job.endedAt && !job.kept && now() - job.endedAt > keepMs) { byTitle.delete(k); return null; }
    return job;
  }

  /** -> { job, attached } or { refused: 'nokeys' | 'user_cap' | 'global_cap' | 'writes' | 'busy' }. Never throws. */
  function ensure(spec) {
    const existing = find(spec);
    if (existing) return { job: existing, attached: true }; // running, or ended a moment ago: the repeat fetch gets the same answer

    const tag = titleKey(spec);
    const keys = { deepl: looksLikeKey(spec.keys?.deepl) ? spec.keys.deepl.trim() : '', gemini: looksLikeKey(spec.keys?.gemini) ? spec.keys.gemini.trim() : '' };
    if (!keys.deepl && !keys.gemini) return { refused: 'nokeys' };
    const scope = keyScope(keys);

    rollDay();
    const lim = limits();
    if ((daily.users.get(scope) || 0) >= lim.user) { refusedLine(tag, 'user_cap'); return { refused: 'user_cap' }; }
    if (daily.total >= lim.global) { refusedLine(tag, 'global_cap'); return { refused: 'global_cap' }; }
    if (writesToday() >= WRITE_STOP) { refusedLine(tag, 'writes'); return { refused: 'writes' }; }
    const canStart = running.size < MAX_RUNNING && ![...running].some((j) => j.scope === scope);
    if (!canStart && (waiting.length >= MAX_WAITING || waiting.filter((j) => j.scope === scope).length >= MAX_WAITING_PER_USER)) {
      refusedLine(tag, 'busy');
      return { refused: 'busy' };
    }

    daily.users.set(scope, (daily.users.get(scope) || 0) + 1);
    daily.total++;
    const job = {
      key: tag, scope, spec: { ...spec, keys }, state: 'queued', st: null, progress: null, result: null, reason: '',
      createdAt: now(), endedAt: 0, waiters: new Set(),
    };
    byTitle.set(tag, job);
    waiting.push(job);
    event(job, 'queued');
    pump();
    return { job, attached: false };
  }

  /** Starts waiting jobs while there is room: at most MAX_RUNNING, and never two for one scope. FIFO among those that may start. */
  function pump() {
    for (;;) {
      if (running.size >= MAX_RUNNING) return;
      const i = waiting.findIndex((j) => ![...running].some((r) => r.scope === j.scope));
      if (i < 0) return;
      const [job] = waiting.splice(i, 1);
      if (writesToday() >= WRITE_STOP) { job.reason = 'writes'; finish(job, 'failed'); continue; } // the store budget ran out while it waited
      running.add(job);
      job.state = 'running';
      job.startedAt = now();
      event(job, 'running');
      execute(job).catch(() => finish(job, 'failed')); // execute handles its own errors; this is the last guard
    }
  }

  function finish(job, state) {
    if (job.endedAt) return;
    job.state = state;
    job.endedAt = now();
    job.spec.keys = null; // the keys and the provider settings are not needed any more
    job.spec.providerCfgs = null;
    running.delete(job);
    waiting = waiting.filter((j) => j !== job);
    if (state === 'done' && !job.kept) byTitle.delete(job.key); // the final file is in the store; the next fetch serves it
    event(job, state);
    if (job.kept) job.st = null; // the result holds the file; the working record is not needed
    notify(job);
    if (state !== 'done') {
      // a failed or paused job is shown to repeat fetches for keepMs, then it leaves memory with its text
      const timer = setTimeout(() => {
        if (byTitle.get(job.key) === job) byTitle.delete(job.key);
        job.st = null;
        job.result = null;
      }, keepMs);
      timer.unref?.();
    }
    pump();
  }

  async function recordEnglish(spec) {
    try {
      const rec = JSON.parse((await getAi(jobKey(spec.imdbId, spec.season, spec.episode), { kind: 'json' })) || 'null');
      if (rec && rec.v === 1 && rec.state !== 'failed' && Array.isArray(rec.en) && rec.en.length) {
        return { cues: rec.en.map(([start, end, raw]) => ({ start, end, raw })), release: rec.release || '' };
      }
    } catch { /* unreadable record: download the English file */ }
    return null;
  }

  async function execute(job) {
    const { spec } = job;
    try {
      const english = (await recordEnglish(spec)) || await fetchEn({
        type: spec.season != null ? 'series' : 'movie', imdbId: spec.imdbId, season: spec.season, episode: spec.episode,
        cfg: { providers: spec.providerCfgs || {} }, filename: spec.filename, candidates: spec.candidates,
      });
      if (!english) { job.reason = 'no_english'; return finish(job, 'failed'); }
      const result = await run({
        imdbId: spec.imdbId, season: spec.season, episode: spec.episode, english, keys: spec.keys, env, log, now, ...runOpts,
        onProgress: (p) => {
          job.progress = { phase: p.phase, chunks: p.chunks, doneChunks: p.doneChunks, kind: p.kind };
          job.st = p.job || job.st;
          event(job, p.phase === 'draft' ? 'draft' : p.phase === 'polish' ? 'chunk' : p.phase);
          notify(job);
        },
      });
      job.result = result;
      if (result?.state === 'done' && result.srt) {
        // the pipeline wrote the file and says whether the store took it (the memory layer in front of the store would hide a refusal)
        let stored = result.finalStored !== false;
        if (!(await getAi(finalKey(spec.imdbId, spec.season, spec.episode), { kind: 'text' }))) {
          stored = await setAi(finalKey(spec.imdbId, spec.season, spec.episode), result.srt, { kind: 'text', ttlSec: FINAL_TTL_SEC });
        }
        if (!stored) {
          job.kept = true;
          log(`[ai] ${job.key} final_not_stored: the store refused the file, the result stays in memory`);
        }
        return finish(job, 'done');
      }
      return finish(job, result?.state === 'paused' ? 'paused' : 'failed');
    } catch {
      job.reason ||= 'error'; // no error text: it could carry a URL with a key
      return finish(job, 'failed');
    }
  }

  /** Resolves when the job has something to show (a draft, a polished chunk or its end), or after `ms`, whichever is first. */
  function waitFor(job, ms) {
    const ready = () => !!job.endedAt || !!job.st?.draft || Object.keys(job.st?.polished || {}).length > 0;
    if (ready() || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); job.waiters.delete(check); resolve(); };
      const check = () => { if (ready()) done(); };
      const timer = setTimeout(done, ms);
      job.waiters.add(check);
    });
  }

  /** A rough progress number for the status file: English 5, draft 30, then the polished share up to 99. */
  function pct(job) {
    if (job.state === 'done') return 100;
    if (job.state === 'queued') return 0;
    if (!job.st) return 5;
    const chunks = job.progress?.chunks || 0;
    const done = Object.keys(job.st.polished || {}).length;
    const base = job.st.draft ? 30 : 10;
    return Math.min(99, Math.round(base + (100 - base) * (chunks ? done / chunks : 0)));
  }

  return {
    ensure, find, waitFor, pct,
    stats: () => ({ running: running.size, waiting: waiting.length, day: { ...daily, users: new Map(daily.users) } }),
  };
}

export const jobs = createJobs();
