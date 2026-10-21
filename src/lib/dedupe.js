// Merge results from all providers: drop duplicates, rank the rest.

const NOISE = /\b(greek|ell|el|ελληνικ\w*|subs?|subtitles?|srt|hi|sdh|forced|www|com|net|org)\b/g;

/** Normalize a release name so "Show.S01E02.720p.WEB-DL.x264-GRP.srt" variants collapse. */
export function normalize(name = '') {
  return name
    .toLowerCase()
    .replace(/\.(srt|zip|rar|sub|ass|vtt)$/g, '')
    .replace(NOISE, ' ')
    .replace(/[^a-z0-9α-ω]+/g, '')
    .trim();
}

const tokens = (s) => new Set((s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));

/** 0..1 overlap between the playing file name and a subtitle release name. */
export function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// Greek-native sources are Greek-first (human-made, Greek release naming); global ones are fallback.
// Bonus is big enough to beat a modest filename-similarity edge, not a hash match (+1000).
const GREEK_NATIVE = new Set(['greeksubs']);
const GREEK_NATIVE_BONUS = 25;

const SOURCES = [
  ['webdl', /web[ ._-]?dl/i], ['webrip', /web[ ._-]?rip/i], ['bluray', /blu[ ._-]?ray|bdrip|brrip|\bbd\b/i],
  ['hdtv', /hdtv|pdtv|dsr/i], ['dvd', /dvd(rip|scr)?/i], ['web', /(?<![a-z])web(?![a-z])/i],
];
const CODECS = [['hevc', /hevc|x[ ._-]?265|h[ ._-]?265/i], ['h264', /x[ ._-]?264|h[ ._-]?264|avc/i], ['xvid', /xvid|divx/i]];

/** Pull comparable tags out of a release / file name. Missing tags are null. */
export function parseRelease(name = '') {
  const base = name.replace(/(\.(srt|zip|rar|sub|ass|vtt|mkv|mp4|avi))+$/i, '').trim(); // pack files can be ".srt.srt"
  const se = base.match(/s(\d{1,2})[ ._-]*e(\d{1,3})/i) || base.match(/(?<!\d)(\d{1,2})x(\d{2,3})(?!\d)/i);
  const res = base.match(/(?<!\d)(2160|1080|720|576|480)[pi]/i);
  // Release group: trailing "-GRP" (or "[GRP]"), never a codec/source word.
  const g = base.match(/-([a-z0-9]+)\s*(?:\[[^\]]*\])?$/i) || base.match(/\[([a-z0-9]+)\]$/i);
  const group = g && !/^(x?26[45]|hevc|dl|rip|web|hdtv|bluray)$/i.test(g[1]) ? g[1].toLowerCase() : null;
  return {
    season: se ? Number(se[1]) : null,
    episode: se ? Number(se[2]) : null,
    resolution: res ? Number(res[1]) : null,
    source: SOURCES.find(([, r]) => r.test(base))?.[0] ?? null,
    codec: CODECS.find(([, r]) => r.test(base))?.[0] ?? null,
    group,
  };
}

const WEB_FAMILY = new Set(['web', 'webdl', 'webrip']);

/** Points for how well a subtitle's release tags match the playing file's tags. */
export function tagScore(file, rel) {
  let s = 0;
  if (file.group && rel.group && file.group === rel.group) s += 30;
  if (file.source && rel.source) {
    if (file.source === rel.source) s += 15;
    else if (WEB_FAMILY.has(file.source) && WEB_FAMILY.has(rel.source)) s += 8; // WEB-DL vs WEBRip: usually same timing
    else s -= 5;
  }
  if (file.resolution && rel.resolution && file.resolution === rel.resolution) s += 6;
  if (file.codec && rel.codec && file.codec === rel.codec) s += 6;
  if (file.episode != null && rel.episode != null &&
      (file.season !== rel.season || file.episode !== rel.episode)) s -= 100; // wrong episode
  return s;
}

// Cam/telesync sources: their timing rarely fits a proper release. The short tags only count after the
// title (index > 0), so a movie called "Cam" or "TS" is not flagged.
const LOWQ = /(?<![a-z0-9])(telesync|tele[ ._-]?sync|telecine|hd[ ._-]?ts|hd[ ._-]?cam|cam[ ._-]?rip|cam|ts|tc)(?![a-z0-9])/gi;
const LOWQ_PENALTY = 120;
const PREMIUM_BONUS = 10;

export function isLowQuality(name = '') {
  for (const m of name.matchAll(LOWQ)) if (m.index > 0) return true;
  return false;
}

// SDH / HI in a release name. The short tags only count after the title (index > 0), like the cam tags above.
const HI_TAG = /(?<![a-z0-9])(sdh|hi|hearing[ ._-]?impaired)(?![a-z0-9])/gi;
export function isHearingImpaired(name = '') {
  for (const m of name.matchAll(HI_TAG)) if (m.index > 0) return true;
  return false;
}

const isUhdOrRemux =(name = '') => /(?<!\d)2160p|\buhd\b|remux/i.test(name);
const isPremiumSource = (name = '') => /web[ ._-]?dl|web[ ._-]?rip|blu[ ._-]?ray|remux|(?<![a-z])web(?![a-z])/i.test(name);

/** Quality-source adjustments that depend on the playing file name. */
export function qualityScore(filename, release) {
  let s = 0;
  if (isLowQuality(release) && !isLowQuality(filename)) s -= LOWQ_PENALTY;
  if (isUhdOrRemux(filename) && isPremiumSource(release) && !isLowQuality(release)) s += PREMIUM_BONUS;
  return s;
}

/**
 * items: [{ provider, release, downloads, hashMatch?, ... }]
 * ctx:   { filename, providerPriority: ['opensubtitles', ...] }
 */
export function mergeAndRank(items, ctx = {}) {
  const prio = ctx.providerPriority || [];
  const fileTags = parseRelease(ctx.filename || '');
  const score = (it) =>
    similarity(ctx.filename, it.release) * 40 +
    (ctx.filename ? tagScore(fileTags, parseRelease(it.release)) : 0) +
    qualityScore(ctx.filename, it.release) +
    (GREEK_NATIVE.has(it.provider) ? GREEK_NATIVE_BONUS : 0) +
    (it.generic ? -10 : 0) + // season pack whose inner file names are not known yet
    Math.min(Math.log10((it.downloads || 0) + 1), 4) * 5 +
    (prio.length - Math.max(prio.indexOf(it.provider), 0)) * 0.5 +
    (it.hashMatch ? 1000 : 0);

  const best = new Map();
  for (const it of items) {
    const key = normalize(it.release) || `${it.provider}:${it.ref}`;
    const cur = best.get(key);
    if (!cur || score(it) > score(cur)) best.set(key, { ...it, _score: score(it) });
  }
  return [...best.values()].sort((a, b) => b._score - a._score);
}
