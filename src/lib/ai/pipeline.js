// The translation pipeline: English cues -> DeepL draft -> Gemini polish -> labelled Greek .srt.
//   runPipeline(opts) -> null (no usable key given) | { ok, state, kind, srt, stats, error? }
//   assembleSrt(job, { running }) -> { srt, kind, cues }   the best file available right now, from a job record
//
// Rules this file keeps:
//   - Timestamps come only from the original English cues. Models see and return text only; output is mapped back by index.
//   - Formatting (<i>, ASS tags) is stripped before translating and italics are restored afterwards (srt.js).
//   - Nothing reaches the output unchecked: Gemini chunks go through validate.js (one retry naming the problem, then the DeepL
//     draft for the chunk), DeepL drafts through the character check (a bad cue is sent to DeepL again alone, then the English
//     line is kept and counted). assembleSrt checks every cue once more, so a stale record cannot leak a bad character.
//   - Progress is saved in the AI store under ai:v1:{tt}:{s}:{e}:job (7 days), at most one write every 2 s and about 12 writes per
//     episode in all. The record holds the English text, the draft, the finished chunks and counters. It never holds a key or a user id.
//   - A new run reads that record first and continues from the first unfinished chunk.
//   - DeepL quota short or spent: no draft (Gemini only). Gemini quota spent or key rejected: finish with the draft.
// Keys are only passed to the clients; this file never logs them, a subtitle line, or a cue.
import crypto from 'node:crypto';
import { getAi, setAi } from '../cache.js';
import { isExhausted, scopeOf } from '../health.js';
import { splitFormatting, restoreItalics, serializeSrt } from '../srt.js';
import { translate as deeplTranslate, usage as deeplUsage } from './deepl.js';
import { polish, translate as geminiTranslate } from './gemini.js';
import { looksLikeKey, defaultSleep } from './http.js';
import { retryNote } from './prompts.js';
import { validateChunk, describeProblems, passesCharCheck } from './validate.js';
import { addLabel } from './label.js';
import { getGlossary } from './glossary.js';

export const DEFAULT_CHUNK_CUES = 250;
export const MIN_CHUNK_CUES = 50;
export const MAX_CHUNK_CUES = 400;
const LEGACY_CHUNK_CUES = 100; // job records written before the size was stored

/** Cues per Gemini request from AI_CHUNK_CUES: a whole number, held between 50 and 400; anything else gives the default (250). */
export function chunkCues(env = process.env) {
  const v = String(env?.AI_CHUNK_CUES ?? '').trim();
  if (!/^\d{1,6}$/.test(v)) return DEFAULT_CHUNK_CUES;
  return Math.min(MAX_CHUNK_CUES, Math.max(MIN_CHUNK_CUES, Number(v)));
}
export const CONTEXT_CUES = 5;
export const JOB_TTL_SEC = 7 * 24 * 3600;
export const FINAL_TTL_SEC = 120 * 24 * 3600;
export const SAVE_GAP_MS = 2000;
export const WRITE_BUDGET = 11; // job saves + the final file; with the glossary that makes the plan's "about 12" per episode

const base = (imdbId, season, episode) => `ai:v1:${imdbId}:${season ?? 0}:${episode ?? 0}`;
export const jobKey = (imdbId, season, episode) => `${base(imdbId, season, episode)}:job`;
export const finalKey = (imdbId, season, episode) => `${base(imdbId, season, episode)}:final`;

// ---------- preparing cues ----------
/** raw cues -> { prep: [{ plain, italic }], T: indexes of cues that have text } */
function prepare(rawTexts) {
  const prep = rawTexts.map((raw) => { const f = splitFormatting(raw); return { plain: f.plain, italic: f.italic }; });
  const T = [];
  prep.forEach((p, i) => { if (p.plain.trim()) T.push(i); });
  return { prep, T };
}

const fingerprint = (en) => crypto.createHash('sha1').update(JSON.stringify(en)).digest('hex').slice(0, 16);

const engineOf = (st) => (st.draft && st.gemini ? 'DeepL + Gemini' : st.draft ? 'DeepL' : 'Gemini');

// ---------- the best file right now ----------
/**
 * job: a job record. running: true while chunks are still being polished.
 * kind: 'final' = every chunk done and Gemini took part; 'improving' = draft with some polished chunks, still running; else 'draft'.
 * Cues with no translation yet (Gemini-only, mid-run) are left out. The label is added by label.js and the file is numbered 1..N.
 */
export function assembleSrt(job, { running = false, warn } = {}) {
  const en = job.en || [];
  const { prep, T } = prepare(en.map((c) => c[2]));
  const tpos = new Map(T.map((i, p) => [i, p]));
  const size = job.chunk || LEGACY_CHUNK_CUES;
  const chunks = Math.ceil(T.length / size);
  const polished = job.polished || {};
  const complete = chunks > 0 && Array.from({ length: chunks }, (_, k) => k).every((k) => polished[k]);
  const some = Object.keys(polished).length > 0;
  const kind = complete && job.gemini ? 'final' : running && some && job.draft ? 'improving' : 'draft';

  const cues = en.map(([start, end], i) => {
    const p = tpos.get(i);
    let text = '';
    if (p != null) {
      const got = polished[Math.floor(p / size)]?.[p % size] ?? job.draft?.[p] ?? null;
      if (got != null) {
        const safe = passesCharCheck(got) ? got : prep[i].plain; // last guard: never write a character outside Greek/Latin
        text = restoreItalics(safe, prep[i].italic).text;
      }
    }
    return { start, end, text };
  });
  const labelled = addLabel(cues, { kind, engine: engineOf(job), ...(warn ? { warn } : {}) });
  return { srt: serializeSrt(labelled.cues), kind, cues: labelled.cues };
}

// ---------- saving, at most one write every `minGapMs` and within a budget ----------
function makeSaver({ write, minGapMs, now, sleep, budget }) {
  let last = -Infinity, dirty = false, forced = false, pending = null, writes = 0;
  const run = async () => {
    while (dirty) {
      const wait = last + minGapMs - now();
      if (wait > 0) await sleep(wait);
      dirty = false;
      if (!forced && writes >= budget - 2) continue; // keep two writes for the end: the finished job and the final file
      last = now();
      writes++;
      await write();
    }
    pending = null;
  };
  // run() starts on the next tick: a loop that finishes without waiting would otherwise clear `pending` before it is assigned
  const start = () => { pending ||= Promise.resolve().then(run); };
  return {
    request() { dirty = true; start(); },
    async flush() { forced = true; dirty = true; start(); await pending; },
    count: () => writes,
    spend: () => { writes++; }, // a write made elsewhere (the final file)
  };
}

// ---------- the pipeline ----------
/**
 * imdbId, season, episode: the title. english: { cues: [{ start, end, raw }], release } (what fetchEnglish returns).
 * Result of a finished job also has finalStored (false when the store refused the final file). keys: { deepl, gemini } (the user's own, either may be missing). onProgress({ phase, chunk, chunks, doneChunks, kind, job }); job is the live record (read it, never change it).
 * Test hooks: fetchImpl, env, sleep, now, log, minSaveGapMs, writeBudget.
 */
export async function runPipeline({
  imdbId, season, episode, english, keys = {}, onProgress, minSaveGapMs = SAVE_GAP_MS, writeBudget = WRITE_BUDGET,
  now = Date.now, sleep = defaultSleep, log = (m) => console.warn(m), fetchImpl, env,
}) {
  const dKey = looksLikeKey(keys.deepl) ? keys.deepl.trim() : null;
  const gKey = looksLikeKey(keys.gemini) ? keys.gemini.trim() : null;
  if (!dKey && !gKey) return null;
  const copts = { fetchImpl, sleep, log, env, now };
  const tag = `${imdbId}${season != null ? `:${season}:${episode}` : ''}`;
  const t0 = now();

  const enRaw = english.cues.map((c) => [c.start, c.end, c.raw]);
  const { prep, T } = prepare(enRaw.map((c) => c[2]));
  const plainT = T.map((i) => prep[i].plain);
  if (!T.length) return { ok: false, state: 'failed', kind: 'draft', srt: '', stats: { chunks: 0 }, error: 'the English file has no text' };

  // continue a saved job for this exact English file, else start one
  const jk = jobKey(imdbId, season, episode);
  const fp = fingerprint(enRaw);
  let st = null;
  try {
    const j = JSON.parse((await getAi(jk, { kind: 'json' })) || 'null');
    if (j && j.v === 1 && j.fp === fp) st = j;
  } catch { /* unreadable record: start again */ }
  const size = chunkCues(env ?? process.env);
  if (st && st.state !== 'done' && (st.chunk || LEGACY_CHUNK_CUES) !== size) {
    // Chunks of another size cannot be continued. The DeepL draft does not depend on them, so it is kept; the polish starts again.
    log(`[ai] ${tag} saved job used chunks of ${st.chunk || LEGACY_CHUNK_CUES} cues, now ${size}: keeping the draft, polishing again from the start`);
    Object.assign(st, { chunk: size, polished: {}, fb: [], models: {}, gemini: false, state: 'running' });
  }
  const resumedChunks = st ? Object.keys(st.polished || {}).length : 0;
  st ||= {
    v: 1, fp, state: 'running', release: english.release || '', chunk: size, gemini: false, en: enRaw, draft: null, polished: {}, fb: [], models: {},
    stats: { deeplChars: 0, geminiCalls: 0, retries: 0, fallbackChunks: 0, englishLines: 0 }, updatedAt: 0,
  };
  const stats = st.stats;
  const chunks = Math.ceil(T.length / (st.chunk || LEGACY_CHUNK_CUES));

  const summary = (extra = {}) => {
    const a = assembleSrt(st, { running: false });
    const mode = st.draft && st.gemini ? 'deepl+gemini' : st.draft ? 'deepl' : st.gemini ? 'gemini' : 'none';
    return {
      ok: st.state === 'done', state: st.state, kind: a.kind, srt: a.srt,
      stats: { ...stats, mode, chunks, chunkCues: st.chunk, models: [...new Set(Object.values(st.models || {}))], chunksDone: Object.keys(st.polished).length, resumedChunks, writes: saver.count(), ms: now() - t0 },
      ...extra,
    };
  };
  let saveFailLogged = false;
  const saver = makeSaver({
    write: async () => {
      st.updatedAt = now();
      const ok = await setAi(jk, JSON.stringify(st), { kind: 'json', ttlSec: JOB_TTL_SEC });
      if (!ok && !saveFailLogged) { saveFailLogged = true; log(`[ai] ${tag} job_not_saved: the store refused the job record (progress is kept in memory only)`); }
    },
    minGapMs: minSaveGapMs, now, sleep, budget: writeBudget,
  });
  const progress = (phase, chunk) => {
    try { onProgress?.({ phase, chunk, chunks, doneChunks: Object.keys(st.polished).length, kind: assembleKind(), job: st }); } catch { /* a callback must not stop the job */ }
  };
  const assembleKind = () => assembleSrt(st, { running: st.state === 'running' }).kind;

  if (st.state === 'done') { log(`[ai] ${tag} already done, nothing to run`); return summary(); }
  // A resumed record that already holds a draft or polished chunks is shown to waiting requests at once (not only after the next step).
  if (st.draft || resumedChunks) progress('resume', null);

  const dUsable = dKey && !isExhausted('deepl', scopeOf({ apiKey: dKey }));
  const gUsable = gKey && !isExhausted('gemini', scopeOf({ apiKey: gKey }));

  // ----- 1. DeepL draft -----
  if (!st.draft && dUsable) {
    const draft = await makeDraft();
    if (draft) {
      st.draft = draft;
      saver.request();
      progress('draft', null);
    }
  }
  async function makeDraft() {
    const estimate = plainT.reduce((n, t) => n + [...t].length, 0);
    try {
      const u = await deeplUsage({ key: dKey, ...copts });
      if (u.limit - u.used < estimate * 1.1) { log(`[ai] ${tag} deepl=quota (${u.limit - u.used} characters left, about ${estimate} needed): no draft`); return null; }
    } catch (e) {
      if (e.quota) return null; // a failed usage call is not a reason to skip; the translate call will say if the quota is gone
    }
    try {
      const r = await deeplTranslate({ key: dKey, texts: plainT, ...copts });
      stats.deeplChars += r.chars;
      const draft = r.texts.slice();
      for (let j = 0; j < draft.length; j++) {
        if (passesCharCheck(draft[j])) continue;
        let fixed = null;
        try {
          const one = await deeplTranslate({ key: dKey, texts: [plainT[j]], contextBefore: plainT.slice(Math.max(0, j - 3), j), ...copts });
          stats.deeplChars += one.chars;
          if (passesCharCheck(one.texts[0])) fixed = one.texts[0];
        } catch { /* keep the English line below */ }
        if (fixed == null) stats.englishLines++;
        draft[j] = fixed ?? plainT[j];
      }
      return draft;
    } catch (e) {
      log(`[ai] ${tag} DeepL draft failed: ${e?.code || 'error'}`);
      return null;
    }
  }

  // ----- 2. Gemini polish (or full translation when there is no draft) -----
  const todo = Array.from({ length: chunks }, (_, k) => k).filter((k) => !st.polished[k]);
  let stoppedBy = null;
  if (todo.length && gUsable) {
    const glossary = await getGlossary({ imdbId, texts: plainT, key: gKey, ...copts });
    for (const k of todo) {
      try {
        await doChunk(k, glossary);
      } catch (e) { // only a spent quota or a rejected key gets here: stop politely
        stoppedBy = e?.code || 'error';
        log(`[ai] ${tag} Gemini stopped (${stoppedBy}): ${st.draft ? 'finishing with the draft' : 'progress is saved, run again later'}`);
        break;
      }
      progress('polish', k);
      if (k < chunks - 1) saver.request(); // the last chunk is saved by the final flush
    }
  } else if (todo.length && gKey) {
    stoppedBy = 'quota';
    log(`[ai] ${tag} Gemini is out of quota for this key: ${st.draft ? 'finishing with the draft' : 'nothing to do'}`);
  }

  async function doChunk(k, glossary) {
    const from = k * st.chunk, to = Math.min(from + st.chunk, T.length);
    const english = plainT.slice(from, to);
    const context = plainT.slice(Math.max(0, from - CONTEXT_CUES), from);
    const draft = st.draft ? st.draft.slice(from, to) : null;
    let note = '', last = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      stats.geminiCalls++;
      let items, model;
      try {
        const call = draft
          ? polish({ key: gKey, cues: english.map((en, j) => ({ en, draft: draft[j] })), context, glossary, note, ...copts })
          : geminiTranslate({ key: gKey, texts: english, context, glossary, note, ...copts });
        const got = await call;
        items = got.items;
        model = got.model;
      } catch (e) {
        if (e?.quota || e?.code === 'bad_key') throw e;
        log(`[ai] ${tag} chunk ${k + 1}/${chunks} attempt ${attempt} failed: ${e?.code || 'error'}`);
        last = null;
        if (attempt === 1) { stats.retries++; note = ''; continue; }
        break;
      }
      const v = validateChunk({ english, output: items, glossary });
      if (v.ok) {
        st.polished[k] = items;
        st.gemini = true;
        (st.models ||= {})[k] = model; // which model wrote this chunk (style can differ between models); never a key
        log(`[ai] ${tag} chunk ${k + 1}/${chunks} model=${model}`);
        return;
      }
      // the problem codes only (count, chars, ...), never a cue
      log(`[ai] ${tag} chunk ${k + 1}/${chunks} attempt ${attempt} failed: ${[...new Set([...v.hard, ...v.soft].map((p) => p.code))].join(',') || 'invalid'} model=${model}`);
      last = { v, items };
      if (attempt === 1) { stats.retries++; note = retryNote(describeProblems(v), english.length); }
    }
    // failed twice
    stats.fallbackChunks++;
    st.fb.push(k);
    if (draft) { st.polished[k] = draft; return; } // the draft already passed its character check
    // Gemini alone: keep what passed, the English line for the rest
    const usable = last && Array.isArray(last.items) && last.items.length === english.length;
    const out = english.map((en, j) => (usable && !last.v.badCues.includes(j) ? last.items[j] : en));
    stats.englishLines += out.filter((t, j) => t === english[j]).length;
    st.polished[k] = out;
    if (usable) st.gemini = true;
  }

  // ----- 3. finish -----
  const polishedAll = todo.every((k) => st.polished[k]);
  const complete = chunks > 0 && (polishedAll || !!st.draft);
  const produced = !!st.draft || Object.keys(st.polished).length > 0;
  if (!produced) {
    log(`[ai] ${tag} nothing produced`);
    st.state = 'failed';
    return summary({ error: stoppedBy ? `Gemini ${stoppedBy}` : 'no translation could be made' });
  }
  st.state = complete ? 'done' : 'paused';
  await saver.flush();
  const result = summary(complete ? {} : { error: `paused: Gemini ${stoppedBy || 'stopped'}` });
  if (complete) {
    saver.spend();
    result.stats.writes = saver.count();
    // false = the store refused the file: jobs.js then keeps this result in memory so a repeat fetch never starts a new job
    result.finalStored = await setAi(finalKey(imdbId, season, episode), result.srt, { kind: 'text', ttlSec: FINAL_TTL_SEC });
    if (!result.finalStored) log(`[ai] ${tag} final_not_stored: the store refused the finished file`);
  }
  progress('done', null);
  log(`[ai] ${tag} state=${st.state} kind=${result.kind} chunks=${result.stats.chunksDone}/${chunks} size=${st.chunk} models=${result.stats.models.join(',') || '-'} retries=${stats.retries} ` +
    `fallback_chunks=${stats.fallbackChunks} english_lines=${stats.englishLines} deepl_chars=${stats.deeplChars} writes=${result.stats.writes} ms=${result.stats.ms}`);
  return result;
}
