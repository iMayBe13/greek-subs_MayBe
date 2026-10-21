// Fan out to every enabled provider in parallel, tolerate failures/timeouts, merge + rank.
import { providers, PROVIDER_PRIORITY } from '../providers/index.js';
import { mergeAndRank } from './dedupe.js';
import { memGet, memSet } from './cache.js';
import { hasFailed, isExhausted, scopeOf } from './health.js';
import { findEnglish } from './ai/english.js';

const TIMEOUT_MS = 7000; // Stremio gives up on slow addons; keep every provider on a leash

const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms))]);

export async function searchAll({ type, imdbId, season, episode, cfg, filename, videoHash, videoSize }) {
  const ctx = { type, imdbId, season, episode, videoHash, videoSize, filename };
  const active = providers.filter((p) => p.enabled(cfg.providers?.[p.id]));

  const settled = await Promise.allSettled(
    active.map(async (p) => {
      const key = `search:${p.id}:${type}:${imdbId}:${season ?? ''}:${episode ?? ''}:${videoHash ?? ''}`; // hash changes OpenSubtitles results
      const hit = memGet(key);
      if (hit) return hit;
      // The search keeps running after a timeout and still fills the cache, so Stremio's retry is instant.
      const run = Promise.resolve(p.search({ ...ctx, cfg: cfg.providers?.[p.id] || {} }))
        .then((out) => { memSet(key, out); return out; });
      run.catch(() => {}); // late failure after a timeout: already reported as a timeout
      return withTimeout(run, p.timeoutMs || TIMEOUT_MS, p.id);
    }),
  );

  const items = [];
  const counts = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      items.push(...r.value);
      counts.push(`${active[i].id}=${r.value.length}`);
    } else {
      console.warn(`[${active[i].id}] search failed:`, r.reason?.message);
      counts.push(`${active[i].id}=failed`);
    }
  });

  // Hide what just failed and providers whose daily quota is spent (before the cut to maxResults).
  const usable = items.filter((it) =>
    !hasFailed(it.provider, it.ref) &&
    !(it.provider === 'opensubtitles' && isExhausted('opensubtitles', scopeOf(cfg.providers?.opensubtitles))));
  const merged = mergeAndRank(usable, { filename, providerPriority: PROVIDER_PRIORITY });
  const limit = cfg.maxResults || 20;
  const epTag = season != null ? `:${season}:${episode}` : '';
  console.log(
    `[search] ${imdbId}${epTag} raw: ${counts.join(' ') || 'no providers enabled'} | ` +
      `raw total=${items.length} hidden=${items.length - usable.length} merged=${merged.length} returned=${Math.min(merged.length, limit)}`,
  );
  return merged.slice(0, limit);
}

/**
 * Starts the Greek search and, when `english` is true (the user has an AI key), the English search for the AI translation at the
 * same moment, so the English one costs no extra wait. -> { greek: Promise<results>, english: Promise<candidates> }
 * `greek` is exactly searchAll (and rejects like it); `english` never rejects: it is [] when nothing was found or the search broke.
 * Hooks for tests: search, findEnglishFn.
 */
export function startSearches(args, { english = false, search = searchAll, findEnglishFn = findEnglish } = {}) {
  const greek = search(args);
  const eng = english
    ? Promise.resolve().then(() => findEnglishFn(args)).catch(() => [])
    : Promise.resolve([]);
  greek.catch(() => {}); // the caller awaits it; this only keeps an early rejection from being reported as unhandled
  return { greek, english: eng };
}
