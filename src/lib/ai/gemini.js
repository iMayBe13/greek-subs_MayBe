// Gemini client (translate English cues, or polish a DeepL draft). Global fetch, no dependency.
//   The key comes from the caller (the user's own key), goes only in the x-goog-api-key header, and is never put in a URL, a log
//   line or an error message (see http.js redactReason).
//   Model: AI_GEMINI_MODEL, else the newest stable Flash model from the model list.
//   Thinking: generationConfig.thinkingConfig.thinkingLevel from AI_GEMINI_THINKING (MINIMAL | LOW | MEDIUM | HIGH | UNSET), default LOW.
//   thinkingBudget is never sent. A model that rejects the level is retried once without it and remembered.
//   One request at a time per key (retries and waits included). 429 and 503: wait for the server's retryDelay / Retry-After, else
//   2 s / 4 s / 8 s, never more than 60 s, at most 4 tries.
//   A 429 on a per-day quota marks that MODEL exhausted for this key until midnight Pacific (health key "gemini:<model>") and the
//   call moves on to the next candidate from flashCandidates (Google counts daily requests per model). Only when every candidate is
//   exhausted or unusable is the whole key marked exhausted ("gemini") and the quota error reported. A per-minute 429 still just waits.
//   A spent model is also written to the AI store (ai:quota:gemini:<scope>, until midnight Pacific; the scope hash, never the key),
//   read once per key per process, so a restart does not ask a spent model again.
//   A slow or failing model is left quickly when another one is free: a 5xx or timeout that took SLOW_FAIL_MS or more, or a second
//   5xx, moves the call to the next candidate, and the model is used last for BUSY_MS (memory only). With no free candidate the
//   usual retries apply.
//   Every request logs one line: call (glossary | chunk), model, result (200, 503, 429day, 429min, timeout, ...) and ms.
//   Each call asks the model once; checking the answer (count, characters, names) and asking again is the validator's / pipeline's job.
import { aiRequest, AiError, looksLikeKey, redactReason } from './http.js';
import { isExhausted, markExhausted, scopeOf, nextPacificMidnight } from '../health.js';
import { getAi, setAi } from '../cache.js';
import { systemPrompt, translateUser, polishUser, SYSTEM_GLOSSARY, glossaryUser } from './prompts.js';

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const THINKING_LEVELS = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'];
export const DEFAULT_THINKING = 'LOW';
const REQUEST_TIMEOUT_MS = 240000; // a 100-cue chunk took 13 to 35 s when measured; chunks may be up to 400 cues (AI_CHUNK_CUES)
export const GLOSSARY_TIMEOUT_MS = 60000; // a list of about 30 names
export const SLOW_FAIL_MS = 15000; // a failure that took this long is not tried again on the same model when another one is free
export const BUSY_MS = 10 * 60 * 1000; // a model that was slow or failing is used last for this long
const MODEL_CACHE_MS = 6 * 3600 * 1000;

export function thinkingLevel(env = process.env) {
  const v = String(env.AI_GEMINI_THINKING ?? '').trim().toUpperCase();
  if (v === 'UNSET' || v === 'DEFAULT') return null; // send no thinkingConfig: the model's own default
  return THINKING_LEVELS.includes(v) ? v : DEFAULT_THINKING;
}

const headers = (key) => ({ 'x-goog-api-key': String(key).trim(), 'Content-Type': 'application/json' });
const quotaError = () => new AiError('Gemini daily quota exhausted (429)', { code: 'quota', status: 429 });
function checkKey(key) {
  if (!looksLikeKey(key)) throw new AiError('Gemini key is missing or malformed', { code: 'bad_key' });
}

// ---------- models (names from the model list) ----------
/** names: model names from the list. -> usable Flash models, best first: stable before preview, newest version first, plain alias before a dated snapshot. */
export function flashCandidates(names) {
  return names
    .map((n) => String(n).replace(/^models\//, ''))
    .filter((n) => /^gemini-\d+(\.\d+)?-flash(-\d+)*(-preview[-\w.]*)?$/.test(n) && !/lite|image|tts|audio|live|thinking|exp|robotics|computer/.test(n))
    .map((n) => { const m = n.match(/^gemini-(\d+)(?:\.(\d+))?-flash/); return { n, v: +m[1] + (m[2] ? +m[2] / 10 : 0), preview: /preview/.test(n), dated: /-\d{3}$/.test(n) }; })
    .sort((a, b) => a.preview - b.preview || b.v - a.v || a.dated - b.dated)
    .map((x) => x.n);
}

const modelCache = new Map(); // scope -> { at, names }
async function candidateModels(key, opts) {
  const scope = scopeOf({ apiKey: key });
  const hit = modelCache.get(scope);
  if (hit && Date.now() - hit.at < MODEL_CACHE_MS) return hit.names;
  const found = [];
  let pageToken = '';
  do {
    const qs = `pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const r = await aiRequest({
      url: `${GEMINI_BASE}/models?${qs}`, headers: headers(key), secrets: [key], label: 'Gemini model list',
      timeoutMs: 15000, fetchImpl: opts.fetchImpl, sleep: opts.sleep, log: opts.log, onError: geminiOnError({ key, model: null, sentThinking: false, opts }),
    });
    let j;
    try { j = JSON.parse(r.text); } catch { throw new AiError('Gemini model list is not understood', { code: 'bad_response' }); }
    for (const m of j?.models || []) if ((m.supportedGenerationMethods || []).includes('generateContent')) found.push(m.name);
    pageToken = j?.nextPageToken || '';
  } while (pageToken);
  const names = flashCandidates(found);
  if (!names.length) throw new AiError('no Gemini Flash model is available for this key', { code: 'not_found' });
  modelCache.set(scope, { at: Date.now(), names });
  return names;
}

// ---------- error answers ----------
/** The parts of a Google error body that matter: { message, status, reasons[], quotaIds[], retryDelayMs }. */
function parseError(text) {
  const out = { message: '', status: '', reasons: [], quotaIds: [], retryDelayMs: null };
  let e;
  try { e = JSON.parse(text)?.error; } catch { return out; }
  if (!e || typeof e !== 'object') return out;
  out.message = String(e.message ?? '');
  out.status = String(e.status ?? '');
  for (const d of Array.isArray(e.details) ? e.details : []) {
    if (d?.reason) out.reasons.push(String(d.reason));
    for (const v of Array.isArray(d?.violations) ? d.violations : []) if (v?.quotaId) out.quotaIds.push(String(v.quotaId));
    if (typeof d?.retryDelay === 'string') { const s = parseFloat(d.retryDelay); if (Number.isFinite(s)) out.retryDelayMs = Math.ceil(s * 1000); }
  }
  return out;
}

const isDaily = (err) => err.quotaIds.some((q) => /PerDay/i.test(q)) || /per ?day|daily/i.test(err.message);
/** The result word of one request for the log: the status, 429day / 429min, or timeout / unreachable. */
const resultOf = (status, code, text) => (status == null ? code : status === 429 ? (isDaily(parseError(text)) ? '429day' : '429min') : String(status));

const modelState = (model) => `gemini:${model}`;
const busyState = (model) => `gemini-busy:${model}`;
const keyQuotaLog = (opts) => (opts.log ?? console.warn)('[ai] Gemini daily quota exhausted for a key: Gemini is skipped for it until midnight Pacific time');

// ---------- spent models, kept in the AI store so that a restart does not ask them again ----------
export const quotaKey = (scope) => `ai:quota:gemini:${scope}`;
const MODEL_NAME = /^[\w.-]{1,80}$/;
const spent = new Map(); // scope -> Promise<{ model: untilMs }>, read once per process

function loadSpent(scope, log) {
  if (!spent.has(scope)) {
    spent.set(scope, (async () => {
      const rec = {};
      try {
        const j = JSON.parse((await getAi(quotaKey(scope), { kind: 'json' })) || 'null');
        for (const [m, until] of Object.entries(j && typeof j === 'object' && !Array.isArray(j) ? j : {})) {
          if (!MODEL_NAME.test(m) || !Number.isFinite(until) || until <= Date.now()) continue;
          rec[m] = until;
          markExhausted(modelState(m), scope, until);
        }
      } catch { /* unreadable record: the memory state still works */ }
      if (Object.keys(rec).length) log(`[ai] Gemini models out of daily quota from an earlier run: ${Object.keys(rec).join(',')} (skipped until midnight Pacific)`);
      return rec;
    })());
  }
  return spent.get(scope);
}

async function saveSpent(scope, model, until, log) {
  const rec = await loadSpent(scope, log);
  const t = Date.now();
  for (const [m, u] of Object.entries(rec)) if (u <= t) delete rec[m];
  rec[model] = until;
  const ttlSec = Math.max(60, Math.ceil((Math.max(...Object.values(rec)) - t) / 1000));
  await setAi(quotaKey(scope), JSON.stringify(rec), { kind: 'json', ttlSec }); // never throws; a refusal leaves the memory state
}

/** Tests only: forget the model list, the thinking and quota memory, as a restart does. */
export function resetGeminiState() {
  modelCache.clear();
  noThinking.clear();
  spent.clear();
}

function geminiOnError({ key, model, sentThinking, opts }) {
  const scope = scopeOf({ apiKey: key });
  return (status, text) => {
    const err = parseError(text);
    if (status === 429) {
      if (isDaily(err)) {
        if (model) { // generateContent: the limit is per model, so only this model is out (generate() decides what happens next)
          markExhausted(modelState(model), scope, nextPacificMidnight());
          throw new AiError('Gemini daily quota exhausted for a model (429)', { code: 'model_quota', status: 429 });
        }
        if (markExhausted('gemini', scope, nextPacificMidnight())) keyQuotaLog(opts); // the model list call: no model to blame
        throw quotaError();
      }
      return { waitMs: err.retryDelayMs }; // per-minute limit: wait as the server says
    }
    if (status === 400 || status === 403) {
      if (status === 403 || err.status === 'PERMISSION_DENIED' || err.reasons.includes('API_KEY_INVALID') || /api key (not valid|expired)/i.test(err.message)) {
        throw new AiError(`Gemini key rejected or not allowed (${status})`, { code: 'bad_key', status });
      }
      if (sentThinking && /think/i.test(err.message)) throw new AiError('Gemini rejected the thinking level', { code: 'think-rejected', status });
    }
    if (status === 404) throw new AiError('Gemini model not found', { code: 'not_found', status });
    return undefined;
  };
}

// ---------- one request at a time per key ----------
const chains = new Map(); // scope -> tail of the queue
function exclusive(scope, fn) {
  const run = (chains.get(scope) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  chains.set(scope, tail);
  tail.then(() => { if (chains.get(scope) === tail) chains.delete(scope); });
  return run;
}

const noThinking = new Set(); // models that rejected a thinking level (kept for the life of the process)

async function generate({ key, system, user, call = 'chunk', env = process.env, ...opts }) {
  checkKey(key);
  const scope = scopeOf({ apiKey: key });
  const log = opts.log ?? console.warn;
  if (isExhausted('gemini', scope)) throw quotaError();
  return exclusive(scope, async () => {
    if (isExhausted('gemini', scope)) throw quotaError(); // it may have run out while this call waited in the queue
    const forced = String(env.AI_GEMINI_MODEL ?? '').trim().replace(/^models\//, '');
    const names = forced ? [forced] : await candidateModels(key, opts);
    if (!forced) await loadSpent(scope, log);
    const level = thinkingLevel(env);
    const bad = new Set(); // models that do not exist for this key
    const usable = (m) => !bad.has(m) && !isExhausted(modelState(m), scope);
    const free = (m) => usable(m) && !isExhausted(busyState(m), scope);
    const nextLive = () => { const i = names.findIndex(free); return i >= 0 ? i : names.findIndex(usable); }; // busy models last, never skipped
    const outOfModels = () => {
      if (markExhausted('gemini', scope, nextPacificMidnight())) keyQuotaLog(opts);
      return quotaError();
    };
    let idx = nextLive(), switches = 0;
    if (idx < 0) throw outOfModels();
    for (;;) {
      const model = names[idx];
      const sentThinking = !!level && !noThinking.has(model);
      const generationConfig = { temperature: 0.3, responseMimeType: 'application/json', responseSchema: { type: 'ARRAY', items: { type: 'STRING' } } };
      if (sentThinking) generationConfig.thinkingConfig = { thinkingLevel: level }; // never thinkingBudget as well
      let leave = false; // set when this model was slow or failing and another one is free
      const onAttempt = ({ attempt, status, code, ms, text }) => {
        log(`[ai] gemini call=${call} model=${redactReason(model, [key])} result=${resultOf(status, code, text)} ms=${ms}`);
        const failed = code === 'timeout' || (status != null && status >= 500);
        if (failed && (ms >= SLOW_FAIL_MS || attempt >= 2) && names.some((m) => m !== model && free(m))) { leave = true; return 'stop'; }
        return undefined;
      };
      try {
        const r = await aiRequest({
          url: `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, method: 'POST', headers: headers(key),
          body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig }),
          secrets: [key], label: 'Gemini generate', timeoutMs: opts.timeoutMs ?? REQUEST_TIMEOUT_MS,
          fetchImpl: opts.fetchImpl, sleep: opts.sleep, log: opts.log, now: opts.now, onAttempt, onError: geminiOnError({ key, model, sentThinking, opts }),
        });
        return { ...parseAnswer(r.text, key), model };
      } catch (e) {
        if (e.code === 'think-rejected') { noThinking.add(model); log(`[ai] Gemini model ${redactReason(model, [key])} rejects thinkingLevel: continuing without it`); continue; }
        if (e.code === 'model_quota') {
          if (!forced) await saveSpent(scope, model, nextPacificMidnight(), log);
          const next = nextLive();
          if (next < 0) throw outOfModels();
          log(`[ai] Gemini model ${redactReason(model, [key])} is out of daily quota: using ${redactReason(names[next], [key])}`);
          idx = next;
          continue;
        }
        if (leave) {
          markExhausted(busyState(model), scope, Date.now() + BUSY_MS);
          idx = nextLive(); // a free model exists (checked when leaving)
          log(`[ai] Gemini model ${redactReason(model, [key])} is slow or unavailable: using ${redactReason(names[idx], [key])}`);
          continue;
        }
        if (e.code === 'not_found' && !forced && switches < 2) {
          bad.add(model);
          const next = nextLive();
          if (next >= 0) { idx = next; switches++; modelCache.delete(scope); continue; }
        }
        throw e;
      }
    }
  });
}

/** The model's answer as { items, usage }. items is whatever list the model returned (its length and content are checked by validate.js). */
function parseAnswer(text, key) {
  let j;
  try { j = JSON.parse(text); } catch { throw new AiError('Gemini answer is not understood', { code: 'bad_response' }); }
  const cand = j?.candidates?.[0];
  const out = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  const why = [j?.promptFeedback?.blockReason, cand?.finishReason].filter((x) => x && x !== 'STOP').map((x) => redactReason(x, [key])).join(' ');
  if (!out) throw new AiError(`Gemini gave no text${why ? ` (${why})` : ''}`, { code: 'bad_response' });
  let arr;
  try { arr = JSON.parse(out); } catch { throw new AiError(`Gemini answer is not valid JSON${why ? ` (${why})` : ''}`, { code: 'bad_response' }); }
  if (!Array.isArray(arr)) arr = (arr && typeof arr === 'object' ? Object.values(arr).find(Array.isArray) : null) ?? null;
  if (!arr) throw new AiError('Gemini answer is not a list', { code: 'bad_response' });
  const u = j.usageMetadata || {};
  return { items: arr, usage: { prompt: u.promptTokenCount || 0, output: u.candidatesTokenCount || 0, thoughts: u.thoughtsTokenCount || 0 } };
}

/**
 * Translate English cues. texts: string[]; context: the previous English cues (not translated); glossary: { name: greek };
 * note: appended to the prompt when a chunk is asked again (prompts.retryNote).
 * -> { items, usage: { prompt, output, thoughts }, model }. Throws AiError.
 */
export function translate({ key, texts, context = [], glossary, note = '', ...opts }) {
  return generate({ key, system: systemPrompt('translate', glossary), user: translateUser({ context, texts }) + note, ...opts, call: 'chunk' });
}

/** Improve DeepL drafts. cues: [{ en, draft }]. Otherwise as translate(). */
export function polish({ key, cues, context = [], glossary, note = '', ...opts }) {
  return generate({ key, system: systemPrompt('polish', glossary), user: polishUser({ context, cues }) + note, ...opts, call: 'chunk' });
}

/** Greek spellings for a list of English names (the glossary). names: string[]. -> { items, usage, model }: items in the same order. Throws AiError. */
export function spellNames({ key, names, ...opts }) {
  return generate({ key, system: SYSTEM_GLOSSARY, user: glossaryUser(names), ...opts, call: 'glossary', timeoutMs: opts.timeoutMs ?? GLOSSARY_TIMEOUT_MS });
}
