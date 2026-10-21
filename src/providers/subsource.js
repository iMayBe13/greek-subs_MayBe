// SubSource API. Docs: https://subsource.net/api-docs (free key in the X-API-Key header; free limits 60/min,
// 1800/h, 7200/day). The docs page renders its parameter tables client-side; the names below are from those tables
// and were checked against real responses (test/fixtures/subsource/).
//   GET /movies/search?searchType=imdb&imdb=tt...[&type=movie|series][&season=N] -> { success, data: [{ movieId, imdbId, type, season, ... }] }
//        series are one movieId PER SEASON
//   GET /subtitles?movieId=..&language=greek&limit=100&sort=popular            -> { data: [{ subtitleId, releaseInfo: [..], downloads, files, ... }], pagination }
//        rows carry no season/episode field: the episode only appears inside the release name (S09x03, S01E02)
//   GET /subtitles/{id}/download                                                 -> a ZIP
// The key only ever goes in the X-API-Key header and is never logged.
import { memGet, memSet, getCachedBuf, setCachedBuf } from '../lib/cache.js';
import { parseRelease } from '../lib/dedupe.js';
import { scopeOf } from '../lib/health.js';
import { readCapped } from '../lib/limits.js';

const BASE = 'https://api.subsource.net/api/v1';
const REQUEST_TIMEOUT_MS = 4500; // two calls per search must fit inside the provider timeout
const MAX_MOVIE_IDS = 3; // one imdb id can map to a few movieIds; never fan out further

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const COOLDOWN_429_MS = 60 * 1000; // the free window is per minute; used when no reset header is given
const BAD_KEY_MS = 10 * MINUTE;

// Per user key (scope = hash, never the key): when we may call again after a 429 or a rejected key.
const blockedUntil = new Map();
const badKeyUntil = new Map();

const headers = (cfg) => ({ 'X-API-Key': cfg.apiKey, Accept: 'application/json' });

/** Release name of a list row: releaseInfo is an array of strings ("BluRay", "1080p") or one full name. */
export function releaseName(row) {
  const r = row?.releaseInfo;
  return (Array.isArray(r) ? r.join(' ') : String(r || '')).trim();
}

/** movieIds for an imdb id from a /movies/search body. Series: only the requested season. */
export function parseSearchResults(body, { type, imdbId, season } = {}) {
  const data = Array.isArray(body?.data) ? body.data : [];
  return data
    .filter((m) => m && m.movieId != null && (!m.imdbId || m.imdbId === imdbId))
    .filter((m) => type !== 'series' || m.season == null || Number(m.season) === Number(season))
    .map((m) => m.movieId)
    .slice(0, MAX_MOVIE_IDS);
}

/**
 * Rows of a /subtitles body in `language` (default Greek) as provider results. Series: a row whose release name names another episode is
 * dropped; one naming the requested episode is kept; one naming no episode is a season pack (archive.js picks the file).
 */
export function parseSubtitleRows(body, { type, season, episode, language = 'greek' } = {}) {
  const data = Array.isArray(body?.data) ? body.data : [];
  const out = [];
  for (const row of data) {
    // Unknown language codes are not guaranteed to be rejected, so check the row itself too.
    if (!row || row.subtitleId == null || String(row.language || '').toLowerCase() !== language) continue;
    const release = releaseName(row);
    const item = { provider: 'subsource', ref: String(row.subtitleId), release, downloads: row.downloads || 0 };
    if (row.hearingImpaired) item.hearingImpaired = true;
    if (type === 'series') {
      const tags = parseRelease(release);
      if (tags.episode != null) {
        if (Number(tags.season) !== Number(season) || tags.episode !== Number(episode)) continue; // another episode
      } else {
        item.pack = true; // the playing file name travels with the link so archive.js can choose
        item.generic = true;
      }
    }
    out.push(item);
  }
  return out;
}

/** Call the API. 401/403 -> key rejected (remembered); 429 -> cooldown (remembered); anything else non-200 throws. */
async function api(cfg, path, qs, { binary = false } = {}) {
  const scope = scopeOf(cfg);
  if ((badKeyUntil.get(scope) || 0) > Date.now()) throw new Error('SubSource key was rejected recently');
  if ((blockedUntil.get(scope) || 0) > Date.now()) throw new Error('SubSource rate limited, backing off');
  const url = `${BASE}${path}${qs ? `?${new URLSearchParams(qs)}` : ''}`;
  let res;
  try {
    res = await fetch(url, { headers: headers(cfg), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * (binary ? 3 : 1)) });
  } catch (err) {
    throw new Error(err?.name === 'TimeoutError' ? 'SubSource timed out' : `SubSource request failed (${err?.cause?.code || err?.message || 'network'})`);
  }
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after'));
    const reset = Date.parse(res.headers.get('x-ratelimit-reset'));
    const wait = retry > 0 ? retry * 1000 : reset > Date.now() ? reset - Date.now() : COOLDOWN_429_MS;
    blockedUntil.set(scope, Date.now() + Math.min(wait, HOUR));
    throw new Error('SubSource rate limited (429)');
  }
  if (res.status === 401 || res.status === 403) {
    badKeyUntil.set(scope, Date.now() + BAD_KEY_MS);
    throw new Error(`SubSource key rejected (${res.status})`);
  }
  if (!res.ok) throw new Error(`SubSource ${path.split('/')[1]} ${res.status}`);
  // Out of budget for this window: stop early instead of earning a 429.
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Date.parse(res.headers.get('x-ratelimit-reset'));
    blockedUntil.set(scope, reset > Date.now() ? reset : Date.now() + COOLDOWN_429_MS);
  }
  return binary ? readCapped(res) : res.json();
}

async function movieIds(cfg, { type, imdbId, season }) {
  const k = `subsource:ids:${type}:${imdbId}:${season ?? ''}`;
  const hit = memGet(k);
  if (hit) return hit;
  const qs = { searchType: 'imdb', imdb: imdbId, type: type === 'series' ? 'series' : 'movie' };
  if (type === 'series') qs.season = season;
  const ids = parseSearchResults(await api(cfg, '/movies/search', qs), { type, imdbId, season });
  memSet(k, ids, 12 * HOUR);
  return ids;
}

async function languageRows(cfg, movieId, language) {
  const k = `subsource:rows:${movieId}:${language}`;
  const hit = memGet(k);
  if (hit) return hit;
  const body = await api(cfg, '/subtitles', { movieId, language, limit: 100, sort: 'popular' });
  memSet(k, body, 30 * MINUTE);
  return body;
}

export default {
  id: 'subsource',
  name: 'SubSource',
  enabled: (cfg) => !!cfg?.apiKey,
  timeoutMs: 9500,

  async search({ type, imdbId, season, episode, cfg, lang = 'el' }) {
    const language = lang === 'en' ? 'english' : 'greek';
    const t0 = Date.now();
    const tag = `${imdbId}${type === 'series' ? ` S${season}E${episode}` : ''}`;
    let results = [];
    let note = '';
    try {
      const ids = await movieIds(cfg, { type, imdbId, season });
      if (!ids.length) note = ' (title not on SubSource)';
      for (const id of ids) results.push(...parseSubtitleRows(await languageRows(cfg, id, language), { type, season, episode, language }));
      if (ids.length && !results.length) note = ` (no ${language} subtitles)`;
      return results;
    } catch (err) {
      note = ` (failed: ${err.message})`;
      throw err;
    } finally {
      console.log(`[subsource] ${tag} took ${((Date.now() - t0) / 1000).toFixed(1)}s (${results.length} results)${note}`);
    }
  },

  // Returns the ZIP Buffer; archive.js and encoding.js do the rest. Cached so a file is never fetched twice.
  async download({ ref, cfg }) {
    const k = `subsource:${ref}`;
    const cached = await getCachedBuf(k);
    if (cached) return cached;
    const buf = await api(cfg, `/subtitles/${encodeURIComponent(ref)}/download`, null, { binary: true });
    if (buf[0] === 0x7b || buf[0] === 0x3c) throw new Error('SubSource download returned JSON/HTML, not a subtitle'); // "{" or "<"
    await setCachedBuf(k, buf);
    return buf;
  },
};
