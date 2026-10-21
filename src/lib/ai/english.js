// English source subtitle for the AI translation: find it, rank it, download it, check it, clean it.
//   findEnglish(ctx)  -> ranked candidates [{ provider, ref, release, hearingImpaired, hashMatch?, ... }]
//   fetchEnglish(ctx) -> { cues, release, provider, hearingImpaired } | null      (cues: [{ start, end, raw }])
// ctx: { type, imdbId, season, episode, cfg, filename, videoHash, videoSize }, plus for tests and scripts:
//   providers (list to use instead of the registry), candidates (skip the search and use this ranked list).
import { providers as registry, PROVIDER_PRIORITY } from '../../providers/index.js';
import { mergeAndRank, isHearingImpaired } from '../dedupe.js';
import { pickFromArchive, isRar } from '../archive.js';
import { toUtf8, stripAssTags } from '../encoding.js';
import { parseSrt } from '../srt.js';
import { memGet, memSet, getCached, setCached } from '../cache.js';
import { hasFailed, markFailed, isExhausted, scopeOf } from '../health.js';
import { redactReason } from './http.js';

const TIMEOUT_MS = 7000; // same leash as aggregate.js
export const MIN_CUES = 20;
export const MAX_TRIES = 3;
export const DOWNLOAD_TIMEOUT_MS = 20000; // a stalled download must not hold a job slot for minutes (the download has no timeout of its own)

function withTimeout(p, ms, label) {
  let timer;
  const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out`)), ms); });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

const osSpent = (cfg) => isExhausted('opensubtitles', scopeOf(cfg?.providers?.opensubtitles));

/** Search every enabled provider for English in parallel and rank the result. Never throws; [] when nothing is found. */
export async function findEnglish(ctx) {
  const { type, imdbId, season, episode, cfg = {}, filename, videoHash, videoSize } = ctx;
  const active = (ctx.providers || registry).filter((p) => p.enabled(cfg.providers?.[p.id]));
  const sctx = { type, imdbId, season, episode, videoHash, videoSize, filename, lang: 'en' };

  const settled = await Promise.allSettled(
    active.map(async (p) => {
      const key = `search-en:${p.id}:${type}:${imdbId}:${season ?? ''}:${episode ?? ''}:${videoHash ?? ''}`;
      const hit = memGet(key);
      if (hit) return hit;
      const run = Promise.resolve(p.search({ ...sctx, cfg: cfg.providers?.[p.id] || {} }))
        .then((out) => { memSet(key, out); return out; });
      run.catch(() => {}); // a late failure after the timeout was already reported
      return withTimeout(run, p.timeoutMs || TIMEOUT_MS, p.id);
    }),
  );

  const items = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else console.warn(`[${active[i].id}] english search failed:`, redactReason(r.reason?.message));
  });

  const usable = items
    .filter((it) => !hasFailed(it.provider, it.ref) && !(it.provider === 'opensubtitles' && osSpent(cfg)))
    .map((it) => ({ ...it, hearingImpaired: !!it.hearingImpaired || isHearingImpaired(it.release) }));
  return rankEnglish(usable, { filename });
}

/**
 * Closest release to the playing file first (mergeAndRank), then a stable re-sort:
 * hearing-impaired last; SubDL and SubSource ahead of OpenSubtitles unless that one has a hash match.
 */
export function rankEnglish(items, { filename } = {}) {
  const opts = { filename, providerPriority: PROVIDER_PRIORITY };
  // normalize() ignores "HI"/"SDH", so rank the two groups apart or a clean file could be merged away by its HI twin.
  const ranked = [
    ...mergeAndRank(items.filter((it) => !it.hearingImpaired), opts),
    ...mergeAndRank(items.filter((it) => it.hearingImpaired), opts),
  ].sort((a, b) => b._score - a._score);
  const tier = (it) => (it.hearingImpaired ? 2 : it.provider === 'opensubtitles' && !it.hashMatch ? 1 : 0);
  return ranked.sort((a, b) => tier(a) - tier(b)); // Array.prototype.sort is stable
}

// ---------- hearing-impaired clean-up ----------
const BRACKETED = /\[[^\]]*\]|\([^)]*\)/g;
// "GIBBS:", "DR. PALMER:", "MAN #1:" at the start of a line (after dashes or tags): upper case only, so "Note: x" stays.
const SPEAKER = /^((?:<[^>]*>|[\s-])*)(?:[A-Z][A-Z0-9 .'#]*[A-Z0-9.]|[A-Z]):[ \t]*/;

/** Removes [SOUNDS], (SOUNDS) and NAME: prefixes. A cue left with no text keeps its timestamps and gets raw ''. */
export function stripHearingImpaired(cues) {
  return cues.map((c) => {
    const lines = c.raw.replace(BRACKETED, '').split('\n')
      .map((l) => l.replace(SPEAKER, '$1').replace(/[ \t]{2,}/g, ' ').trim())
      .filter((l) => l.replace(/<[^>]*>/g, '').replace(/^[-–—\s]+$/, '') !== '');
    return { ...c, raw: lines.join('\n') };
  });
}

// ---------- download ----------
const cacheKey = (c, { season, episode }) => `en:${c.provider}:${c.ref}:${season ?? ''}:${episode ?? ''}`;

/** Text of one candidate: from our cache, else downloaded (which costs quota on OpenSubtitles) and converted. Throws on failure. */
async function textOf(c, ctx, provider) {
  const cached = await getCached(cacheKey(c, ctx));
  if (cached) return cached;
  const dl = Promise.resolve().then(() => provider.download({ ref: c.ref, cfg: ctx.cfg?.providers?.[c.provider] || {} }));
  dl.catch(() => {}); // a late failure after the timeout was already reported
  const raw = await withTimeout(dl, ctx.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS, `${c.provider} download`);
  if (isRar(raw)) throw new Error('rar archives are not supported');
  const picked = pickFromArchive(raw, { season: ctx.season, episode: ctx.episode, filename: ctx.filename });
  if (!picked) throw new Error('no matching subtitle file in the archive');
  return stripAssTags(toUtf8(picked.data).replace(/^﻿/, '').replace(/\r\n?/g, '\n'));
}

/** Downloads the best candidate that parses to at least MIN_CUES cues; tries at most MAX_TRIES. Never throws. */
export async function fetchEnglish(ctx) {
  const list = ctx.providers || registry;
  const candidates = ctx.candidates || await findEnglish(ctx);
  let tries = 0;
  for (const c of candidates) {
    if (tries >= MAX_TRIES) break;
    const provider = list.find((p) => p.id === c.provider);
    if (!provider || hasFailed(c.provider, c.ref)) continue;
    if (c.provider === 'opensubtitles' && osSpent(ctx.cfg)) continue; // the quota ran out meanwhile: nothing to try
    tries++;
    try {
      const text = await textOf(c, ctx, provider);
      const cues = parseSrt(text);
      if (cues.length < MIN_CUES) throw new Error(`only ${cues.length} cues`);
      await setCached(cacheKey(c, ctx), text);
      return {
        cues: c.hearingImpaired ? stripHearingImpaired(cues) : cues,
        release: c.release,
        provider: c.provider,
        hearingImpaired: !!c.hearingImpaired,
      };
    } catch (err) {
      if (!err.quota) markFailed(c.provider, c.ref); // a spent quota hides the whole provider instead (see health.js)
      console.warn(`[english] ${c.provider} candidate rejected: ${redactReason(err.message)}`);
    }
  }
  return null;
}
