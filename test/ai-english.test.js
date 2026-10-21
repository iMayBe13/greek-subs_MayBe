import test from 'node:test';
import assert from 'node:assert/strict';
import { findEnglish, fetchEnglish, rankEnglish, stripHearingImpaired, MIN_CUES } from '../src/lib/ai/english.js';
import { isHearingImpaired } from '../src/lib/dedupe.js';
import { setStore } from '../src/lib/cache.js';
import { markExhausted, scopeOf } from '../src/lib/health.js';
import opensubtitles from '../src/providers/opensubtitles.js';
import subdl from '../src/providers/subdl.js';
import subsource from '../src/providers/subsource.js';
import greeksubs from '../src/providers/greeksubs.js';

// A memory store, so no test writes to the disk cache.
const files = new Map();
setStore({
  async get(k, { kind }) { return files.get(`${kind}:${k}`) ?? null; },
  async set(k, b, { kind }) { files.set(`${kind}:${k}`, b); },
});

const srt = (n, text = (i) => `Line number ${i}`) =>
  Array.from({ length: n }, (_, i) => {
    const t = (s) => `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')},000`;
    return `${i + 1}\n${t(i * 3)} --> ${t(i * 3 + 2)}\n${text(i)}`;
  }).join('\n\n') + '\n';

/** A fake provider: results is a list of search rows, files maps ref -> Buffer (or an Error to throw). */
function fake(id, results, files = {}, calls = []) {
  return {
    id, name: id, enabled: () => true,
    async search(ctx) { calls.push({ search: id, lang: ctx.lang }); return ctx.lang === 'en' ? results : []; },
    async download({ ref }) {
      calls.push({ download: id, ref });
      const f = files[ref];
      if (f instanceof Error) throw f;
      return Buffer.from(f ?? srt(30));
    },
  };
}

let seq = 0;
const uniq = () => `tt99${String(++seq).padStart(5, '0')}`; // health.js and the search cache are global: a fresh title per test
const ctxFor = (providers, extra = {}) => ({
  type: 'series', imdbId: uniq(), season: 1, episode: 2, filename: 'Show.S01E02.1080p.WEB.h264-GRP.mkv',
  cfg: { providers: {} }, providers, ...extra,
});
const row = (provider, ref, release, extra = {}) => ({ provider, ref, release, downloads: 0, ...extra });

// ---------- ranking ----------
test('the release closest to the playing file wins', async () => {
  const p = fake('subdl', [
    row('subdl', 'a', 'Show.S01E02.720p.HDTV.x264-OTHER'),
    row('subdl', 'b', 'Show.S01E02.1080p.WEB.h264-GRP'),
    row('subdl', 'c', 'Show.S01E02.480p.DVDRip.xvid-ZZZ'),
  ]);
  const out = await findEnglish(ctxFor([p]));
  assert.deepEqual(out.map((c) => c.ref), ['b', 'a', 'c']);
});

test('hearing-impaired candidates go last, flagged by the provider or by the release name', async () => {
  const p = fake('subdl', [
    row('subdl', 'hi-flag', 'Show.S01E02.1080p.WEB.h264-GRP', { hearingImpaired: true }), // best match, but HI
    row('subdl', 'hi-name', 'Show.S01E02.1080p.WEB.h264-OTHER.SDH'),
    row('subdl', 'plain', 'Show.S01E02.720p.HDTV.x264-OTHER'),
  ]);
  const out = await findEnglish(ctxFor([p]));
  assert.equal(out[0].ref, 'plain');
  assert.deepEqual(out.map((c) => c.hearingImpaired), [false, true, true]);
});

test('a clean file is not merged away by its HI twin (same normalized name)', () => {
  const out = rankEnglish([
    row('subdl', 'hi', 'Show.S01E02.WEB-GRP.HI', { hearingImpaired: true }),
    row('subsource', 'clean', 'Show.S01E02.WEB-GRP'),
  ], { filename: 'Show.S01E02.WEB-GRP.mkv' });
  assert.deepEqual(out.map((c) => c.ref), ['clean', 'hi']);
});

test('SubDL and SubSource come before OpenSubtitles, even when OpenSubtitles matches the file better', async () => {
  const os = fake('opensubtitles', [row('opensubtitles', 'os', 'Show.S01E02.1080p.WEB.h264-GRP', { downloads: 5000 })]);
  const dl = fake('subdl', [row('subdl', 'dl', 'Show.S01E02.480p.DVDRip.xvid-ZZZ')]);
  const ss = fake('subsource', [row('subsource', 'ss', 'Show.S01E02.720p.HDTV.x264-OTHER')]);
  const out = await findEnglish(ctxFor([os, dl, ss]));
  assert.equal(out.at(-1).ref, 'os');
  assert.deepEqual(out.slice(0, 2).map((c) => c.ref).sort(), ['dl', 'ss']);
});

test('an OpenSubtitles hash match overrides that', async () => {
  const os = fake('opensubtitles', [row('opensubtitles', 'os', 'Whatever', { hashMatch: true })]);
  const dl = fake('subdl', [row('subdl', 'dl', 'Show.S01E02.1080p.WEB.h264-GRP')]);
  const out = await findEnglish(ctxFor([os, dl], { videoHash: 'abc' }));
  assert.equal(out[0].ref, 'os');
});

test('hearing-impaired still goes last, even for an OpenSubtitles hash match', async () => {
  const os = fake('opensubtitles', [row('opensubtitles', 'os', 'Whatever', { hashMatch: true, hearingImpaired: true })]);
  const ss = fake('subsource', [row('subsource', 'ss', 'Show.S01E02.720p.HDTV.x264-OTHER')]);
  const out = await findEnglish(ctxFor([os, ss]));
  assert.deepEqual(out.map((c) => c.ref), ['ss', 'os']);
});

test('a provider that fails or times out is tolerated; OpenSubtitles with a spent quota is hidden', async () => {
  const bad = { ...fake('subdl', []), search: async () => { throw new Error('boom'); } };
  const os = fake('opensubtitles', [row('opensubtitles', 'os', 'Show.S01E02')]);
  const ss = fake('subsource', [row('subsource', 'ss', 'Show.S01E02')]);
  const cfg = { providers: { opensubtitles: { apiKey: 'KEY-spent-en-1' } } };
  markExhausted('opensubtitles', scopeOf(cfg.providers.opensubtitles));
  const out = await findEnglish(ctxFor([bad, os, ss], { cfg }));
  assert.deepEqual(out.map((c) => c.ref), ['ss']);
});

test('the search asks every provider for English', async () => {
  const calls = [];
  await findEnglish(ctxFor([fake('subdl', [], {}, calls), fake('subsource', [], {}, calls)]));
  assert.deepEqual(calls.map((c) => c.lang), ['en', 'en']);
});

// ---------- fetch ----------
test('downloads the top candidate and returns its cues', async () => {
  const calls = [];
  const p = fake('subdl', [row('subdl', 'top', 'Show.S01E02.1080p.WEB.h264-GRP')], { top: srt(25) }, calls);
  const out = await fetchEnglish(ctxFor([p]));
  assert.equal(out.cues.length, 25);
  assert.equal(out.provider, 'subdl');
  assert.equal(out.release, 'Show.S01E02.1080p.WEB.h264-GRP');
  assert.equal(out.hearingImpaired, false);
  assert.deepEqual(out.cues[0], { start: 0, end: 2000, raw: 'Line number 0' });
});

test('falls back to the second and then the third candidate', async () => {
  const calls = [];
  const p = fake('subdl', [
    row('subdl', 'f1', 'Show.S01E02.1080p.WEB.h264-GRP'),
    row('subdl', 'f2', 'Show.S01E02.720p.WEB.h264-GRP'),
    row('subdl', 'f3', 'Show.S01E02.720p.HDTV.x264-OTHER'),
    row('subdl', 'f4', 'Show.S01E02.480p.DVDRip.xvid-ZZZ'),
  ], { f1: new Error('HTTP 500'), f2: srt(5), f3: srt(40), f4: srt(40) }, calls);
  const out = await fetchEnglish(ctxFor([p]));
  assert.equal(out.cues.length, 40);
  assert.equal(out.release, 'Show.S01E02.720p.HDTV.x264-OTHER');
  assert.deepEqual(calls.filter((c) => c.download).map((c) => c.ref), ['f1', 'f2', 'f3']);
});

test('gives up after three candidates and returns null', async () => {
  const calls = [];
  const p = fake('subdl', ['g1', 'g2', 'g3', 'g4'].map((r, i) => row('subdl', r, `Show.S01E02.${720 - i}p.WEB-GRP`)),
    { g1: srt(3), g2: new Error('x'), g3: srt(19), g4: srt(40) }, calls);
  assert.equal(await fetchEnglish(ctxFor([p])), null);
  assert.equal(calls.filter((c) => c.download).length, 3);
});

test(`fewer than ${MIN_CUES} cues is rejected, exactly ${MIN_CUES} is accepted`, async () => {
  const mk = (n) => fake('subdl', [row('subdl', `n${n}`, 'Show.S01E02.WEB')], { [`n${n}`]: srt(n) });
  assert.equal(await fetchEnglish(ctxFor([mk(MIN_CUES - 1)])), null);
  assert.equal((await fetchEnglish(ctxFor([mk(MIN_CUES)]))).cues.length, MIN_CUES);
});

test('a failed candidate is remembered, so the next search no longer lists it', async () => {
  const ctx = ctxFor([fake('subdl', [row('subdl', 'dead', 'Show.S01E02.WEB')], { dead: new Error('gone') })]);
  assert.equal(await fetchEnglish(ctx), null);
  assert.deepEqual(await findEnglish({ ...ctx }), []);
});

test('OpenSubtitles is skipped without a download once its quota is spent', async () => {
  const calls = [];
  const cfg = { providers: { opensubtitles: { apiKey: 'KEY-spent-en-2' } } };
  const os = fake('opensubtitles', [row('opensubtitles', 'osq', 'Show.S01E02', { hashMatch: true })], {}, calls);
  const dl = fake('subdl', [row('subdl', 'okq', 'Whatever.else')], { okq: srt(30) }, calls);
  const ctx = ctxFor([os, dl], { cfg });
  const candidates = await findEnglish(ctx); // quota still fine here
  markExhausted('opensubtitles', scopeOf(cfg.providers.opensubtitles));
  const out = await fetchEnglish({ ...ctx, candidates });
  assert.equal(out.provider, 'subdl');
  assert.equal(calls.filter((c) => c.download === 'opensubtitles').length, 0);
});

test('a downloaded file is cached: the second fetch makes no download', async () => {
  const calls = [];
  const p = fake('subdl', [row('subdl', 'cached1', 'Show.S01E02.WEB')], { cached1: srt(30) }, calls);
  const ctx = ctxFor([p]);
  await fetchEnglish(ctx);
  await fetchEnglish({ ...ctx, candidates: await findEnglish(ctx) });
  assert.equal(calls.filter((c) => c.download).length, 1);
});

test('reads a legacy-encoded file and a zip', async () => {
  const { default: AdmZip } = await import('adm-zip');
  const zip = new AdmZip();
  zip.addFile('Show.S01E01.srt', Buffer.from(srt(30, () => 'wrong episode')));
  zip.addFile('Show.S01E02.srt', Buffer.from(srt(30, () => 'right episode')));
  const p = fake('subsource', [row('subsource', 'zip1', 'Show.S01E02')], { zip1: zip.toBuffer() });
  const out = await fetchEnglish(ctxFor([p]));
  assert.equal(out.cues[0].raw, 'right episode');
});

// ---------- hearing-impaired clean-up ----------
test('HI file: sounds and speaker prefixes are stripped, an emptied cue keeps its timestamps', async () => {
  const lines = ['[PHONE RINGING]', 'GIBBS: Where is he?', '(SIGHS) Fine.', '- DR. PALMER: Hello\n- [LAUGHS]', '<i>MAN #1: Go!</i>', 'Note: keep this', 'He said [softly] hi', '10:30 sharp'];
  const p = fake('subdl', [row('subdl', 'hi1', 'Show.S01E02.SDH')], { hi1: srt(30, (i) => lines[i] ?? `Line ${i}`) });
  const out = await fetchEnglish(ctxFor([p]));
  assert.equal(out.hearingImpaired, true);
  const raws = out.cues.slice(0, 8).map((c) => c.raw);
  assert.deepEqual(raws, ['', 'Where is he?', 'Fine.', '- Hello', '<i>Go!</i>', 'Note: keep this', 'He said hi', '10:30 sharp']);
  assert.deepEqual([out.cues[0].start, out.cues[0].end], [0, 2000]);
  assert.equal(out.cues.length, 30);
});

test('a clean file is returned untouched, brackets and all', async () => {
  const p = fake('subdl', [row('subdl', 'clean1', 'Show.S01E02.WEB')], { clean1: srt(30, () => '[x] GIBBS: y') });
  const out = await fetchEnglish(ctxFor([p]));
  assert.equal(out.cues[0].raw, '[x] GIBBS: y');
});

test('stripHearingImpaired keeps cue count and times', () => {
  const cues = [{ start: 1, end: 2, raw: '[MUSIC]' }, { start: 3, end: 4, raw: 'Hi' }];
  assert.deepEqual(stripHearingImpaired(cues), [{ start: 1, end: 2, raw: '' }, { start: 3, end: 4, raw: 'Hi' }]);
});

test('isHearingImpaired finds SDH/HI in names but not in a title that starts with it', () => {
  assert.equal(isHearingImpaired('Show.S01E02.WEB.SDH'), true);
  assert.equal(isHearingImpaired('Show S01E02 [HI]'), true);
  assert.equal(isHearingImpaired('Show.S01E02.Hearing.Impaired'), true);
  assert.equal(isHearingImpaired('Show.S01E02.WEB-GRP'), false);
  assert.equal(isHearingImpaired('Hi.Five.2020.1080p'), false);
});

// ---------- the lang option on the real providers (global fetch mocked) ----------
async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, init) => { urls.push(String(url)); return handler(String(url), init); };
  try { await fn(urls); } finally { globalThis.fetch = real; }
}
const json = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });

test('OpenSubtitles: default Greek, lang en asks for English, HI flag kept', async () => {
  const body = { data: [{ attributes: { release: 'R', files: [{ file_id: 7 }], hearing_impaired: true } }] };
  await withFetch(() => json(body), async (urls) => {
    const base = { type: 'movie', imdbId: 'tt0000001', cfg: { apiKey: 'K' } };
    const [def] = await opensubtitles.search(base);
    const [en] = await opensubtitles.search({ ...base, lang: 'en' });
    assert.match(urls[0], /languages=el/);
    assert.match(urls[1], /languages=en/);
    assert.equal(def.hearingImpaired, true);
    assert.equal(en.hearingImpaired, true);
  });
});

test('SubDL: default EL, lang en asks for EN and keeps only English rows, hi kept', async () => {
  const body = { subtitles: [
    { url: '/subtitle/1.zip?api_key=SECRET', language: 'EN', release_name: 'En.One', hi: true },
    { url: '/subtitle/2.zip', language: 'EL', release_name: 'Gr.Two' },
    { url: '/subtitle/3.zip', lang: 'English', release_name: 'En.Three', hi: false },
  ] };
  await withFetch(() => json(body), async (urls) => {
    const base = { type: 'movie', imdbId: 'tt0000001', cfg: { apiKey: 'K' } };
    const def = await subdl.search(base);
    const en = await subdl.search({ ...base, lang: 'en' });
    assert.match(urls[0], /languages=EL/);
    assert.match(urls[1], /languages=EN/);
    assert.deepEqual(def.map((r) => r.release), ['Gr.Two']);
    assert.deepEqual(en.map((r) => r.release), ['En.One', 'En.Three']);
    assert.deepEqual(en.map((r) => !!r.hearingImpaired), [true, false]);
    assert.ok(!en.some((r) => /SECRET/.test(r.ref)));
  });
});

test('SubSource: default greek, lang en asks for english, hearingImpaired kept, rows cached per language', async () => {
  const rows = [
    { subtitleId: 1, language: 'greek', releaseInfo: ['Gr'], downloads: 1 },
    { subtitleId: 2, language: 'english', releaseInfo: ['En'], downloads: 2, hearingImpaired: true },
    { subtitleId: 3, language: 'english', releaseInfo: ['En2'], downloads: 3, hearingImpaired: null },
  ];
  const handler = (url) => json(url.includes('/movies/search') ? { data: [{ movieId: 4242, imdbId: 'tt0000042' }] } : { data: rows });
  await withFetch(handler, async (urls) => {
    const base = { type: 'movie', imdbId: 'tt0000042', cfg: { apiKey: 'KEY-lang-0001' } };
    const def = await subsource.search(base);
    const en = await subsource.search({ ...base, lang: 'en' });
    assert.ok(urls.some((u) => u.includes('language=greek')));
    assert.ok(urls.some((u) => u.includes('language=english')));
    assert.deepEqual(def.map((r) => r.ref), ['1']);
    assert.deepEqual(en.map((r) => r.ref), ['2', '3']);
    assert.deepEqual(en.map((r) => !!r.hearingImpaired), [true, false]);
    assert.equal('hearingImpaired' in def[0], false); // the default result is unchanged
  });
});

test('GreekSubs has no English: nothing returned, no request made', async () => {
  await withFetch(() => { throw new Error('must not fetch'); }, async (urls) => {
    assert.deepEqual(await greeksubs.search({ type: 'movie', imdbId: 'tt0000001', lang: 'en' }), []);
    assert.equal(urls.length, 0);
  });
});
