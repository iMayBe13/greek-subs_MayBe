// Short-lived, per-process memory of what just failed, so the subtitles route stops offering dead entries.
// Lost on restart on purpose: it only avoids repeating a failure for a while.
import crypto from 'node:crypto';

export const FAIL_TTL_MS = 30 * 60 * 1000;

const failed = new Map(); // "provider:ref" -> expiry (ms)
const exhausted = new Map(); // "provider:scope" -> expiry (ms)

const sweep = (m) => {
  const now = Date.now();
  for (const [k, exp] of m) if (exp <= now) m.delete(k);
};

export function markFailed(provider, ref, ttlMs = FAIL_TTL_MS) {
  failed.set(`${provider}:${ref}`, Date.now() + ttlMs);
  if (failed.size > 5000) sweep(failed);
}

export function hasFailed(provider, ref) {
  const k = `${provider}:${ref}`;
  const exp = failed.get(k);
  if (!exp) return false;
  if (exp <= Date.now()) { failed.delete(k); return false; }
  return true;
}

/** Quota is per user account, so the scope is a short hash of that user's credentials (never the credentials). */
export function scopeOf(c = {}) {
  return crypto.createHash('sha1').update(`${c.apiKey || ''}|${c.username || ''}`).digest('hex').slice(0, 12);
}

export function nextUtcMidnight(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** Returns true only the first time (so the caller can log once). */
export function markExhausted(provider, scope, until = nextUtcMidnight()) {
  const k = `${provider}:${scope}`;
  const was = exhausted.get(k);
  exhausted.set(k, until);
  return !was || was <= Date.now();
}

export function isExhausted(provider, scope) {
  const k = `${provider}:${scope}`;
  const exp = exhausted.get(k);
  if (!exp) return false;
  if (exp <= Date.now()) { exhausted.delete(k); return false; }
  return true;
}

/** Tests only: forget everything, as a restart does. */
export function resetHealth() {
  failed.clear();
  exhausted.clear();
}

/** First instant of the next calendar month (UTC): when a monthly quota is assumed to be renewed. */
export function nextUtcMonthStart(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * Next midnight in Pacific time (America/Los_Angeles): when Gemini's daily request quota resets.
 * On the two days a year the clocks change, the result is one hour off.
 */
export function nextPacificMidnight(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const sinceMidnight = ((get('hour') * 60 + get('minute')) * 60 + get('second')) * 1000 + (((now % 1000) + 1000) % 1000);
  return now - sinceMidnight + 24 * 3600 * 1000;
}
