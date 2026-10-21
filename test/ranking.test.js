import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAndRank, parseRelease } from '../src/lib/dedupe.js';
import { fixOldAccents } from '../src/lib/encoding.js';

const filename = 'ncis.s23e20.720p.HEVC.x265-MeGusta';
const prio = ['greeksubs', 'opensubtitles'];
// Stand-ins for the two releases from the log (same show/episode, one matching source+group, one not).
const matching = 'NCIS.S23E20.720p.HEVC.x265-MeGusta';
const other = 'NCIS.S23E20.1080p.WEB-DL.DDP5.1.H.264-NTb';

test('parseRelease extracts tags', () => {
  assert.deepEqual(parseRelease(filename), {
    season: 23, episode: 20, resolution: 720, source: null, codec: 'hevc', group: 'megusta',
  });
  assert.equal(parseRelease(other).source, 'webdl');
  assert.equal(parseRelease(other).group, 'ntb');
});

test('NCIS: release matching codec, resolution and group ranks first', () => {
  const r = mergeAndRank([
    { provider: 'opensubtitles', ref: '1', release: other, downloads: 900 },
    { provider: 'opensubtitles', ref: '2', release: matching, downloads: 3 },
  ], { filename, providerPriority: prio });
  assert.equal(r[0].ref, '2');
});

test('same-source different-group beats different-source', () => {
  const f = 'Show.S01E02.1080p.WEB-DL.x264-AAA';
  const r = mergeAndRank([
    { provider: 'opensubtitles', ref: 'a', release: 'Show.S01E02.1080p.BluRay.x264-BBB' },
    { provider: 'opensubtitles', ref: 'b', release: 'Show.S01E02.1080p.WEB-DL.x264-CCC' },
  ], { filename: f, providerPriority: prio });
  assert.equal(r[0].ref, 'b');
});

test('Greek-native provider outranks a global one with an equal match', () => {
  const r = mergeAndRank([
    // distinct names (not collapsed as duplicates), neither matches the playing group
    { provider: 'opensubtitles', ref: 'g', release: 'NCIS.S23E20.720p.HEVC.x265-RARBG' },
    { provider: 'greeksubs', ref: 'n', release: 'NCIS.S23E20.720p.HEVC.x265-FLUX' },
  ], { filename, providerPriority: prio });
  assert.equal(r[0].provider, 'greeksubs');
});

test('hashMatch always wins', () => {
  const r = mergeAndRank([
    { provider: 'greeksubs', ref: 'n', release: matching },
    { provider: 'opensubtitles', ref: 'h', release: 'Totally.Different.Name', hashMatch: true },
  ], { filename, providerPriority: prio });
  assert.equal(r[0].ref, 'h');
});

test('fixOldAccents', () => {
  assert.equal(fixOldAccents('΄Ηταν ´Ελα ΄ομως ΄σ'), 'Ήταν Έλα όμως ΄σ');
  assert.equal(fixOldAccents('Ήταν ήδη'), 'Ήταν ήδη'); // idempotent on clean text
  assert.equal(fixOldAccents("don´t"), "don´t"); // not before a Greek vowel
});
