// "Test my keys": one lightweight, free call per provider that proves a key works WITHOUT using a download.
// Keys come from the request body, live only in this function and are never stored or logged (no URLs or keys in messages).
//
// Result per provider: { status, ... } with status one of
//   'ok'          key works
//   'bad_key'     the provider rejected the key
//   'bad_login'   (OpenSubtitles) key fine, username/password rejected
//   'quota'       daily download quota spent (OpenSubtitles), request limit hit (429), or the DeepL monthly characters spent (456)
//   'limit'       (DeepL, Gemini) HTTP 429: too many requests right now, try again in a minute
//   'unreachable' timeout / network error / provider outage
// What each check calls (verified against the live APIs):
//   OpenSubtitles  GET /subtitles?imdb_id=..&languages=el   (search is free; a bad key gives 403 "You cannot consume this service")
//                  then, with a username and password: POST /login and GET /infos/user for the remaining downloads
//   SubDL          GET /api/v1/subtitles?api_key=..          (key is only accepted as a query parameter; bad key -> 403 not_authorized)
//   SubSource      GET /movies/search?searchType=imdb&imdb=.. with the X-API-Key header (bad key -> 401)
//   DeepL          GET /v2/usage with "Authorization: DeepL-Auth-Key <key>" (never in the URL). A key ending in :fx asks api-free.deepl.com
//                  first, others api.deepl.com first; a 403 is tried once on the other host. Returns used / limit characters (testDeepl)
//   Gemini         GET /v1beta/models?pageSize=1 with the x-goog-api-key header (never ?key=); free, no tokens (testGemini)
// The only log line about a test is index.js's "[test] provider=status"; nothing here logs.

import { deeplHost } from './ai/deepl.js';
import { GEMINI_BASE } from './ai/gemini.js';
import { BASE as OS, UA } from '../providers/opensubtitles.js';

const TIMEOUT_MS = 6000;
const tt = 'tt0111161';

const unreachable = { status: 'unreachable' };

async function call(fetchImpl, url, opts = {}) {
  try {
    return await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return null; // timeout or network error: the caller reports "unreachable", never the error text (it may hold the URL)
  }
}

/** Shared status mapping for the simple providers. */
function fromStatus(res, badKeyStatuses) {
  if (!res) return unreachable;
  if (res.ok) return { status: 'ok' };
  if (res.status === 429) return { status: 'quota', reason: 'rate' };
  if (badKeyStatuses.includes(res.status)) return { status: 'bad_key' };
  return unreachable; // 5xx or anything unexpected: not the user's key
}

export async function testOpenSubtitles({ apiKey, username, password }, fetchImpl = fetch) {
  const headers = { 'Api-Key': apiKey, 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json' };
  const search = await call(fetchImpl, `${OS}/subtitles?imdb_id=${tt.slice(2)}&languages=el`, { headers });
  const keyResult = fromStatus(search, [401, 403]);
  if (keyResult.status !== 'ok') return keyResult;
  if (!username || !password) return { status: 'ok', login: false }; // key works; without a login only 5 downloads a day

  const login = await call(fetchImpl, `${OS}/login`, { method: 'POST', headers, body: JSON.stringify({ username, password }) });
  if (!login) return unreachable;
  if (login.status === 429) return { status: 'quota', reason: 'rate' };
  if (login.status === 401 || login.status === 400 || login.status === 406 || login.status === 422) return { status: 'bad_login' };
  if (login.status === 403) return { status: 'bad_key' };
  if (!login.ok) return unreachable;
  let token;
  try { token = (await login.json()).token; } catch { /* handled below */ }
  if (!token) return { status: 'ok', login: true };

  const info = await call(fetchImpl, `${OS}/infos/user`, { headers: { ...headers, Authorization: `Bearer ${token}` } });
  let remaining, allowed;
  try {
    const d = (await info.json()).data || {};
    remaining = Number.isFinite(d.remaining_downloads) ? d.remaining_downloads : undefined;
    allowed = Number.isFinite(d.allowed_downloads) ? d.allowed_downloads : undefined;
  } catch { /* quota unknown: the key and login still work */ }
  if (remaining === 0) return { status: 'quota', reason: 'daily', allowed, remaining };
  return { status: 'ok', login: true, allowed, remaining };
}

export async function testSubdl({ apiKey }, fetchImpl = fetch) {
  const qs = new URLSearchParams({ api_key: apiKey, imdb_id: tt, languages: 'EL', subs_per_page: '1', type: 'movie' });
  return fromStatus(await call(fetchImpl, `https://api.subdl.com/api/v1/subtitles?${qs}`), [401, 403]);
}

export async function testSubsource({ apiKey }, fetchImpl = fetch) {
  const url = `https://api.subsource.net/api/v1/movies/search?searchType=imdb&imdb=${tt}`;
  return fromStatus(await call(fetchImpl, url, { headers: { 'X-API-Key': apiKey, Accept: 'application/json' } }), [401, 403]);
}

/**
 * DeepL: GET /v2/usage on exactly the host that ai/deepl.js uses for this key (deeplHost: ":fx" = api-free, else the pro host), so
 * "Working" here means the real translation reaches the same host. Free, and not counted as translation.
 * ok -> { status: 'ok', used, limit } in characters; 456 or a full quota -> quota (reason 'monthly'); 401/403 -> bad_key;
 * 429 -> limit; 5xx, timeout or network error -> unreachable.
 */
export async function testDeepl({ apiKey }, fetchImpl = fetch) {
  const res = await call(fetchImpl, `${deeplHost(apiKey)}/v2/usage`, { headers: { Authorization: `DeepL-Auth-Key ${apiKey}` } });
  if (!res) return unreachable;
  if (res.status === 456) return { status: 'quota', reason: 'monthly' };
  if (res.status === 429) return { status: 'limit' };
  if (res.status === 401 || res.status === 403) return { status: 'bad_key' };
  if (!res.ok) return unreachable;
  let used, limit;
  try { const j = await res.json(); used = Number(j.character_count); limit = Number(j.character_limit); } catch { /* usage unknown: the key works */ }
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return { status: 'ok' };
  if (limit > 0 && used >= limit) return { status: 'quota', reason: 'monthly', used, limit };
  return { status: 'ok', used, limit };
}

/**
 * Gemini: GET /v1beta/models?pageSize=1 (listing models is free and spends no tokens). A wrong key is HTTP 400 API_KEY_INVALID
 * (or 403); 429 -> limit; 5xx, timeout or network error -> unreachable.
 */
export async function testGemini({ apiKey }, fetchImpl = fetch) {
  const res = await call(fetchImpl, `${GEMINI_BASE}/models?pageSize=1`, { headers: { 'x-goog-api-key': apiKey } });
  if (!res) return unreachable;
  if (res.ok) return { status: 'ok' };
  if (res.status === 429) return { status: 'limit' };
  if (res.status === 403) return { status: 'bad_key' };
  if (res.status === 400) {
    let text = '';
    try { text = await res.text(); } catch { /* unreadable: treated as not the key */ }
    if (/API_KEY_INVALID|api key not valid/i.test(text)) return { status: 'bad_key' };
  }
  return unreachable;
}

const TESTS = { opensubtitles: testOpenSubtitles, subdl: testSubdl, subsource: testSubsource, deepl: testDeepl, gemini: testGemini };

/**
 * providers: { opensubtitles: { apiKey, username, password }, subdl: { apiKey }, subsource: { apiKey }, deepl: { apiKey }, gemini: { apiKey } }.
 * Only entered keys are tested (the AI keys travel here under "providers" only for this test; the install link keeps them in `ai`).
 */
export async function testKeys(providers = {}, fetchImpl = fetch) {
  const entries = Object.entries(TESTS).filter(([id]) => typeof providers[id]?.apiKey === 'string' && providers[id].apiKey.trim());
  const out = {};
  await Promise.all(entries.map(async ([id, fn]) => {
    const c = providers[id];
    const clean = Object.fromEntries(['apiKey', 'username', 'password'].map((k) => [k, typeof c[k] === 'string' ? c[k].trim().slice(0, 200) : '']));
    try { out[id] = await fn(clean, fetchImpl); } catch { out[id] = unreachable; }
  }));
  return out;
}
