import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAndRank, isLowQuality } from '../src/lib/dedupe.js';
import { hasFailed, markFailed, isExhausted, markExhausted, nextUtcMidnight, scopeOf } from '../src/lib/health.js';

const playing = 'Spider-Man.Brand.New.Day.2026.2160p.WEB.h265-ETHEL.mkv';
const ts = 'Spider-Man Brand New Day (2026) TELESYNC.x264-NGP';
const web = 'Spider-Man.Brand.New.Day.2026.1080p.WEB.h264-ETHEL';
const hdts = 'Spider-man-brand-new-day-2026-1080p-hdts-dd2-0-h-2';
const items = [
  { provider: 'opensubtitles', ref: 'ts', release: ts, downloads: 5000 },
  { provider: 'opensubtitles', ref: 'hdts', release: hdts, downloads: 5000 },
  { provider: 'opensubtitles', ref: 'web', release: web, downloads: 1 },
];

test('isLowQuality flags cam/telesync tags, not titles', () => {
  for (const n of [ts, hdts, 'Movie.2026.HDCAM.x264', 'Movie.2026.CAM.x264', 'Movie.2026.TS.x264-GRP', 'Movie 2026 HD-TS']) {
    assert.equal(isLowQuality(n), true, n);
  }
  for (const n of [web, playing, 'Cam.2018.1080p.WEB-DL.x264-GRP', 'Cameron.Diaz.Movie.2020.720p', 'Stats.2020.720p.BluRay']) {
    assert.equal(isLowQuality(n), false, n);
  }
});

test('Spider-Man: WEB subtitle beats TELESYNC and HDTS ones, even with many more downloads', () => {
  const r = mergeAndRank(items, { filename: playing, providerPriority: [] });
  assert.equal(r[0].ref, 'web');
  assert.deepEqual(r.slice(1).map((x) => x.ref).sort(), ['hdts', 'ts']);
  assert.ok(r[0]._score - r[1]._score > 100);
});

test('no penalty when the playing file is also a telesync', () => {
  const r = mergeAndRank(items, { filename: 'Spider-Man.Brand.New.Day.2026.HDTS.x264-NGP.mkv', providerPriority: [] });
  assert.equal(r[0].ref, 'ts'); // same tag and group, plus more downloads
});

test('UHD playing file prefers WEB-DL over HDTV subtitles', () => {
  const f = 'Movie.2026.2160p.HEVC-AAA.mkv';
  const r = mergeAndRank([
    { provider: 'opensubtitles', ref: 'hdtv', release: 'Movie.2026.720p.HDTV.x264-BBB' },
    { provider: 'opensubtitles', ref: 'webdl', release: 'Movie.2026.720p.WEB-DL.x264-CCC' },
  ], { filename: f, providerPriority: [] });
  assert.equal(r[0].ref, 'webdl');
});

test('remux playing file prefers BluRay/Remux subtitles', () => {
  const f = 'Movie.2026.1080p.BluRay.REMUX.AVC-AAA.mkv';
  const r = mergeAndRank([
    { provider: 'opensubtitles', ref: 'dvd', release: 'Movie.2026.1080p.x264-BBB' },
    { provider: 'opensubtitles', ref: 'remux', release: 'Movie.2026.REMUX.x264-CCC' },
  ], { filename: f, providerPriority: [] });
  assert.equal(r[0].ref, 'remux');
});

test('failed entries are remembered per provider+ref', () => {
  assert.equal(hasFailed('greeksubs', 'x1'), false);
  markFailed('greeksubs', 'x1');
  assert.equal(hasFailed('greeksubs', 'x1'), true);
  assert.equal(hasFailed('greeksubs', 'x2'), false);
  markFailed('greeksubs', 'x3', -1); // already expired
  assert.equal(hasFailed('greeksubs', 'x3'), false);
});

test('exhausted state lasts until UTC midnight, per account, and logs once', () => {
  const a = scopeOf({ apiKey: 'k1', username: 'u' });
  assert.notEqual(a, scopeOf({ apiKey: 'k2', username: 'u' }));
  assert.equal(isExhausted('opensubtitles', a), false);
  assert.equal(markExhausted('opensubtitles', a), true);
  assert.equal(markExhausted('opensubtitles', a), false);
  assert.equal(isExhausted('opensubtitles', a), true);
  const m = nextUtcMidnight(Date.UTC(2026, 9, 18, 23, 59, 0));
  assert.equal(m, Date.UTC(2026, 9, 19));
});
