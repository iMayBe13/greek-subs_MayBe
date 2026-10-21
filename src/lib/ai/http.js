// Shared plumbing for the AI clients (deepl.js, gemini.js): one request with a timeout, retries with backoff, and errors
// whose text is safe to log. Global fetch, no dependency.
//
// Keys travel only in request headers (the callers put them there). Everything that can reach a log or a thrown message goes
// through redactReason(): the keys are removed, URLs become <url>, whitespace is collapsed and the text is cut to 80
// characters, the same way the /dl/ log reasons are cleaned in index.js. The original fetch error is never attached to an AiError.

export const MAX_WAIT_MS = 60 * 1000; // no single wait is longer than this
export const MAX_TRIES = 4;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * code: 'quota' (spent for the day or month), 'rate' (429 after all tries), 'unavailable' (5xx after all tries),
 * 'timeout', 'unreachable', 'bad_key', 'bad_request', 'too_large', 'not_found', 'bad_response', 'http'.
 * `quota` is true for code 'quota' (index.js checks err.quota on download errors the same way).
 */
export class AiError extends Error {
  constructor(message, { code = 'http', status, retryAfterMs } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.quota = code === 'quota';
    if (status != null) this.status = status;
    if (retryAfterMs != null) this.retryAfterMs = retryAfterMs;
  }
}

/** Text that is safe to log or put in an error message. `secrets`: the keys in use (also removed when URL-encoded). */
export function redactReason(text, secrets = []) {
  let s = String(text ?? '');
  for (const k of secrets) {
    const raw = String(k ?? '');
    if (raw.length < 4) continue;
    for (const form of new Set([raw, encodeURIComponent(raw)])) s = s.split(form).join('<key>');
  }
  return s
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/AIza[\w-]{16,}/g, '<key>') // shape of a Google API key
    .replace(/DeepL-Auth-Key\s+\S+/gi, 'DeepL-Auth-Key <key>')
    .replace(/[0-9a-f-]{20,}:fx/gi, '<key>') // shape of a DeepL Free key
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Header values must be plain printable ASCII: a key with a newline or space could add headers. */
export const looksLikeKey = (k) => typeof k === 'string' && /^[A-Za-z0-9:_.\-]{8,200}$/.test(k.trim());

/** Retry-After as milliseconds: seconds ("5") or an HTTP date. null when absent or unusable. */
export function parseRetryAfter(headers, now = Date.now()) {
  const v = headers?.get?.('retry-after');
  if (v == null || v === '') return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export const backoffMs = (attempt) => Math.min(MAX_WAIT_MS, 2000 * 2 ** (attempt - 1)); // 2 s, 4 s, 8 s, ...
export const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const codeFor = (s) => (s === 429 ? 'rate' : s >= 500 ? 'unavailable' : s === 401 || s === 403 ? 'bad_key' : s === 456 ? 'quota'
  : s === 413 ? 'too_large' : s === 404 ? 'not_found' : s === 400 ? 'bad_request' : 'http');

/** The server's own short message from a JSON error body ({ error: { message } } or { message }), or ''. */
function bodyMessage(text) {
  try { const j = JSON.parse(text); return String(j?.error?.message ?? j?.message ?? ''); } catch { return ''; }
}

/**
 * One logical request, up to maxTries attempts. Retried: 429, 500, 502, 503, 504, timeouts and network errors.
 * The wait before a retry is Retry-After (or the service's own hint from onError), else 2 s / 4 s / 8 s, never more than 60 s.
 *   onError(status, bodyText, headers): called for every non-2xx answer; may throw an AiError to stop at once (quota, wrong key),
 *                                       or return { waitMs } to say how long to wait before the retry.
 *   onAttempt({ attempt, status, code, ms, text }): called first after every try (2xx too; status is null and code 'timeout' or
 *                                       'unreachable' when there was no answer). Returning 'stop' ends the retries: the error is thrown at once.
 * Returns { status, text, headers } for a 2xx answer. Throws AiError only.
 */
export async function aiRequest({
  url, method = 'GET', headers = {}, body, secrets = [], label = 'AI request',
  timeoutMs = 30000, maxTries = MAX_TRIES, fetchImpl = (...a) => fetch(...a), sleep = defaultSleep,
  onError, onAttempt, log = (m) => console.warn(m), now = Date.now,
}) {
  let last;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    let res, text;
    const t0 = now();
    try {
      res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      text = await res.text();
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      last = new AiError(`${label} ${timedOut ? 'timed out' : 'could not be reached'}`, { code: timedOut ? 'timeout' : 'unreachable' });
      const stop = onAttempt?.({ attempt, status: null, code: last.code, ms: now() - t0, text: '' }) === 'stop';
      if (stop || attempt >= maxTries) throw last;
      const wait = backoffMs(attempt);
      log(`[ai] ${label} ${timedOut ? 'timed out' : 'unreachable'}, retry ${attempt}/${maxTries - 1} in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    const stop = onAttempt?.({ attempt, status: res.status, code: res.ok ? null : codeFor(res.status), ms: now() - t0, text }) === 'stop';
    if (res.ok) return { status: res.status, text, headers: res.headers };

    const hint = onError ? onError(res.status, text, res.headers) : undefined; // may throw
    const reason = redactReason(bodyMessage(text), secrets);
    last = new AiError(`${label} HTTP ${res.status}${reason ? `: ${reason}` : ''}`, {
      code: codeFor(res.status), status: res.status, retryAfterMs: parseRetryAfter(res.headers) ?? undefined,
    });
    if (stop || !RETRY_STATUS.has(res.status) || attempt >= maxTries) throw last;
    const wait = Math.min(MAX_WAIT_MS, hint?.waitMs ?? parseRetryAfter(res.headers) ?? backoffMs(attempt));
    log(`[ai] ${label} HTTP ${res.status}, retry ${attempt}/${maxTries - 1} in ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
  throw last;
}
