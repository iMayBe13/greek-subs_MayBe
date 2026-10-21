// The user's AI keys in the install link: { deepl, gemini }, both optional. Same rules as every other key field: strings,
// trimmed, at most 200 characters, and header-safe (they end up in request headers, so no spaces or line breaks).
import { looksLikeKey } from './http.js';

export const AI_KEY_FIELDS = ['deepl', 'gemini'];

/**
 * input: the `ai` object from POST /api/config (anything).
 * -> { ok: true, value: { deepl?, gemini? } | null }   null = no AI keys at all (the link is then the same as before)
 *  | { ok: false, field }                               a key that is not a string or is not header-safe; the key itself is never echoed
 */
export function validateAiKeys(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return { ok: true, value: null };
  const value = {};
  for (const field of AI_KEY_FIELDS) {
    const v = input[field];
    if (v == null || v === '') continue;
    if (typeof v !== 'string') return { ok: false, field };
    const t = v.trim();
    if (!t) continue;
    if (t.length > 200 || !looksLikeKey(t)) return { ok: false, field };
    value[field] = t;
  }
  return { ok: true, value: Object.keys(value).length ? value : null };
}

/** The usable keys of a (sealed, already validated) ai object, or null when there is none. */
export function usableKeys(ai) {
  const r = validateAiKeys(ai);
  return r.ok ? r.value : null;
}
