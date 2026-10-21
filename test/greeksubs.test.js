import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import AdmZip from 'adm-zip';
import { parseRows, parseSeriesIndex, secCodeOf } from '../src/providers/greeksubs.js';
import { listArchiveNames, bestEntryName, pickFromArchive } from '../src/lib/archive.js';

const S = new URL('./fixtures/greeksubs/', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, S));
const html = (f) => read(f).toString('utf8');

test('movie page: Greek rows with release and download count', () => {
  const rows = parseRows(html('movie-tt0111161.html'));
  assert.equal(rows.length, 4);
  assert.equal(rows[0].release, 'The-shawshank-redemption-1994-720p-1080p-x264-yify');
  assert.ok(rows[0].downloads >= 14795); // the site's counter; saving the sample bumped it
  assert.ok(rows.every((r) => /^[A-Za-z0-9]{5}-[a-f0-9]+$/.test(r.subId)));
});

test('episode page and pack page each have one row', () => {
  const ep = parseRows(html('episode-greekmtdb-episode-117.html'));
  assert.deepEqual([ep.length, ep[0].release], [1, 'NCIS.S23E20.720p.x264-FENiX']);
  assert.ok(ep[0].downloads >= 95);
  const pack = parseRows(html('pack-greekmtdb-season-92-23.html'));
  assert.equal(pack.length, 1);
  assert.match(pack[0].release, /Season 23.*Complete Season Pack/);
});

test('sample secCode is redacted but present', () => {
  assert.equal(secCodeOf(html('movie-tt0111161.html')), 'REDACTED');
});

test('series index: finds episode and pack by slug, not by id kind', () => {
  const idx = parseSeriesIndex(html('series-tt0364845.html'));
  const find = (s, e) => idx.find((l) => l.season === s && l.episode === e)?.id;
  assert.equal(find(23, 20), 'greekmtdb:episode:117');
  assert.equal(find(23, null), 'greekmtdb:season:92:23');
  assert.equal(find(1, 1), 'tt0658039'); // older episodes use their own IMDb id
  assert.equal(find(1, null), 'legacy:season:tt0364845:1');
  assert.equal(find(24, 1), 'greekmtdb:episode:619123');
});

test('NCIS S24E02 is not listed on the site: no episode link, no season 24 pack', () => {
  const idx = parseSeriesIndex(html('series-tt0364845.html'));
  assert.equal(idx.find((l) => l.season === 24 && l.episode === 2), undefined);
  assert.equal(idx.find((l) => l.season === 24 && l.episode === null), undefined);
});

// The raw zip is git-ignored (third-party content): skip, don't fail, when it is not on disk.
const hasPack = fs.existsSync(new URL('pack-s23-download.zip', S));
test('real S23 pack: 21 files, picks the right episode', { skip: !hasPack && 'test/fixtures/greeksubs/pack-s23-download.zip not present' }, () => {
  const zip = read('pack-s23-download.zip');
  const names = listArchiveNames(zip);
  assert.equal(names.length, 21);
  assert.match(bestEntryName(names, { season: 23, episode: 20 }), /S23E20.*FENiX/);
  assert.equal(bestEntryName(names, { season: 23, episode: 21 }), null); // not in this pack
  const p = pickFromArchive(zip, { season: 23, episode: 20 });
  assert.match(p.name, /S23E20/);
  assert.ok(p.data.length > 50000);
});

test('two uploads of the same episode: prefer the one matching the playing file group', () => {
  const z = new AdmZip();
  z.addFile('Show.S01E03.720p.WEB-DL.H.264-NTb.srt', Buffer.from('ntb'));
  z.addFile('Show.S01E03.720p.WEB-DL.H.264-FLUX.srt.srt', Buffer.from('flux'));
  z.addFile('Show.S01E04.720p.WEB-DL.H.264-NTb.srt', Buffer.from('e4'));
  const buf = z.toBuffer();
  const pick = (filename) => pickFromArchive(buf, { season: 1, episode: 3, filename }).data.toString();
  assert.equal(pick('show.s01e03.720p.web-dl.h264-flux.mkv'), 'flux');
  assert.equal(pick('show.s01e03.720p.web-dl.h264-ntb.mkv'), 'ntb');
});
