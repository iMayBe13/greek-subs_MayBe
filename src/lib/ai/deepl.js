// DeepL client (draft translation English -> Greek). Global fetch, no dependency.
//   The key comes from the caller (the user's own key from their link), goes only in the Authorization header, and is never put
//   in a URL, a log line or an error message (see http.js redactReason).
//   Host: a key ending in ":fx" is a DeepL API Free key and uses api-free.deepl.com; every other key uses api.deepl.com
//   (developers.deepl.com/docs/getting-started/auth: "DeepL API Free authentication keys can be identified easily by the suffix :fx").
//   translate(): batches of up to 50 cues and under 100 KiB, at most 2 requests at the same time, source EN, target EL,
//   preserve_formatting, model_type prefer_quality_optimized, and the 3 cues before each batch as `context`
//   (the docs say context characters are not billed). A 456 answer marks this key exhausted until the first day of next month.
import { aiRequest, AiError, looksLikeKey } from './http.js';
import { isExhausted, markExhausted, scopeOf, nextUtcMonthStart } from '../health.js';

export const DEEPL_BATCH_MAX_CUES = 50;
export const DEEPL_BATCH_MAX_BYTES = 100 * 1024;
export const DEEPL_PARALLEL = 2;
export const DEEPL_CONTEXT_CUES = 3;
export const DEEPL_MODEL_TYPE = 'prefer_quality_optimized';

export const deeplHost = (key) => (/:fx$/.test(String(key ?? '').trim()) ? 'https://api-free.deepl.com' : 'https://api.deepl.com');
const authHeader = (key) => ({ Authorization: `DeepL-Auth-Key ${String(key).trim()}` });

function checkKey(key) {
  if (!looksLikeKey(key)) throw new AiError('DeepL key is missing or malformed', { code: 'bad_key' });
}
const quotaError = () => new AiError('DeepL quota exhausted (456)', { code: 'quota', status: 456 });

/**
 * Split cues into requests. A batch holds at most `maxCues` cues and its JSON body stays under `maxBytes` (UTF-8 bytes, the
 * context included); one cue larger than that goes alone. `context` of a batch = the `contextCues` cues before it
 * (the end of `contextBefore` for the first batch). -> [{ from, texts, context }]
 */
export function makeBatches(texts, { contextBefore = [], maxCues = DEEPL_BATCH_MAX_CUES, maxBytes = DEEPL_BATCH_MAX_BYTES, contextCues = DEEPL_CONTEXT_CUES } = {}) {
  const all = [...contextBefore, ...texts];
  const offset = contextBefore.length;
  const bytesOf = (cues, context) => Buffer.byteLength(JSON.stringify({ text: cues, context }), 'utf8') + 200; // 200: the fixed fields
  const batches = [];
  let from = 0;
  while (from < texts.length) {
    const ctxText = all.slice(Math.max(0, offset + from - contextCues), offset + from).join('\n');
    let to = from + 1;
    while (to < texts.length && to - from < maxCues && bytesOf(texts.slice(from, to + 1), ctxText) <= maxBytes) to++;
    batches.push({ from, texts: texts.slice(from, to), context: ctxText });
    from = to;
  }
  return batches;
}

async function translateBatch(key, batch, opts) {
  const body = { text: batch.texts, source_lang: 'EN', target_lang: 'EL', preserve_formatting: true, model_type: DEEPL_MODEL_TYPE };
  if (batch.context) body.context = batch.context;
  const scope = scopeOf({ apiKey: key });
  const r = await aiRequest({
    url: `${deeplHost(key)}/v2/translate`, method: 'POST', body: JSON.stringify(body),
    headers: { ...authHeader(key), 'Content-Type': 'application/json' },
    secrets: [key], label: 'DeepL translate',
    timeoutMs: opts.timeoutMs ?? 30000, fetchImpl: opts.fetchImpl, sleep: opts.sleep, log: opts.log,
    onError: (status) => {
      if (status === 456) {
        if (markExhausted('deepl', scope, nextUtcMonthStart())) (opts.log ?? console.warn)('[ai] DeepL quota exhausted for a key: DeepL is skipped for it until the first day of next month');
        throw quotaError();
      }
    },
  });
  let translations;
  try { translations = JSON.parse(r.text)?.translations; } catch { /* handled below */ }
  if (!Array.isArray(translations) || translations.length !== batch.texts.length || !translations.every((t) => typeof t?.text === 'string')) {
    throw new AiError(`DeepL translate answer has ${Array.isArray(translations) ? translations.length : 'no'} translations, expected ${batch.texts.length}`, { code: 'bad_response' });
  }
  return translations.map((t) => t.text);
}

/**
 * texts: the English cues (plain text, one string per cue). contextBefore: the English cues just before them (optional).
 * -> { texts, chars }: the Greek drafts in the same order, and the number of characters sent for translation (context excluded).
 * The text is returned exactly as DeepL wrote it; checking its characters is the validator's job.
 * onBatch({ from, texts }) is called as each batch finishes (to save progress). Throws AiError.
 */
export async function translate({ key, texts, contextBefore = [], onBatch, ...opts }) {
  checkKey(key);
  if (!texts.length) return { texts: [], chars: 0 };
  const scope = scopeOf({ apiKey: key });
  const batches = makeBatches(texts, { contextBefore });
  const out = new Array(texts.length);
  let next = 0, failure = null;
  const worker = async () => {
    while (!failure) {
      const i = next++;
      if (i >= batches.length) return;
      try {
        if (isExhausted('deepl', scope)) throw quotaError();
        const got = await translateBatch(key, batches[i], opts);
        got.forEach((t, k) => { out[batches[i].from + k] = t; });
        onBatch?.({ from: batches[i].from, texts: got });
      } catch (e) {
        failure ||= e instanceof AiError ? e : new AiError('DeepL translate failed', { code: 'http' });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DEEPL_PARALLEL, batches.length) }, worker));
  if (failure) throw failure;
  return { texts: out, chars: texts.reduce((n, t) => n + [...t].length, 0) };
}

/** GET /v2/usage (free, not counted as translation). -> { used, limit } in characters. Throws AiError. */
export async function usage({ key, ...opts }) {
  checkKey(key);
  const r = await aiRequest({
    url: `${deeplHost(key)}/v2/usage`, headers: authHeader(key), secrets: [key], label: 'DeepL usage',
    timeoutMs: opts.timeoutMs ?? 10000, fetchImpl: opts.fetchImpl, sleep: opts.sleep, log: opts.log,
  });
  let j;
  try { j = JSON.parse(r.text); } catch { /* handled below */ }
  const used = Number(j?.character_count), limit = Number(j?.character_limit);
  if (!Number.isFinite(used) || !Number.isFinite(limit)) throw new AiError('DeepL usage answer is not understood', { code: 'bad_response' });
  return { used, limit };
}
