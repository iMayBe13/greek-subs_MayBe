import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'subsource-test-')); // never touch the real cache
import subsource, { parseSearchResults, parseSubtitleRows, releaseName } from '../src/providers/subsource.js';

const sample = (n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/subsource/${n}`, import.meta.url), 'utf8'));

test('movie search sample: one movieId for tt0111161', () => {
  assert.deepEqual(parseSearchResults(sample('search-movie-tt0111161.json'), { type: 'movie', imdbId: 'tt0111161' }), [97027]);
  assert.deepEqual(parseSearchResults(sample('search-movie-tt0111161.json'), { type: 'movie', imdbId: 'tt9999999' }), []);
});

test('series search sample: only the requested season', () => {
  const body = sample('search-series-tt0364845-s23.json');
  assert.deepEqual(parseSearchResults(body, { type: 'series', imdbId: 'tt0364845', season: 23 }), [153284]);
  assert.deepEqual(parseSearchResults(body, { type: 'series', imdbId: 'tt0364845', season: 22 }), []);
});

test('movie rows: Greek rows with release names and download counts', () => {
  const rows = parseSubtitleRows(sample('subtitles-movie-tt0111161-greek.json'), { type: 'movie' });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    provider: 'subsource', ref: '317884', release: 'The.Shawshank.Redemption.1994.1080p', downloads: 69,
  });
  assert.match(rows[1].release, /Shawshank/);
});

test('season with no Greek subtitles gives an empty list', () => {
  assert.deepEqual(parseSubtitleRows(sample('subtitles-series-tt0364845-s23-greek.json'), { type: 'series', season: 23, episode: 19 }), []);
});

test('series rows: the requested episode is kept, other episodes are dropped', () => {
  const body = sample('subtitles-series-ncis-s09-greek.json'); // one row: NCIS.S09x03.The Penelope Papers.HDTV.XviD-LOL
  const hit = parseSubtitleRows(body, { type: 'series', season: 9, episode: 3 });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].ref, '491433');
  assert.equal(hit[0].pack, undefined); // a single episode, not a pack
  assert.deepEqual(parseSubtitleRows(body, { type: 'series', season: 9, episode: 4 }), []);
  assert.deepEqual(parseSubtitleRows(body, { type: 'series', season: 8, episode: 3 }), []);
});

test('series rows with no episode in the name are season packs for archive.js', () => {
  const body = { data: [{ subtitleId: 1, language: 'greek', releaseInfo: ['Show.Season.2.WEB-DL'], downloads: 3 }] };
  const [r] = parseSubtitleRows(body, { type: 'series', season: 2, episode: 5 });
  assert.equal(r.pack, true);
  assert.equal(r.generic, true);
});

test('rows in another language are ignored even if the API returns them', () => {
  const body = { data: [{ subtitleId: 1, language: 'english', releaseInfo: ['X.2020'] }, { subtitleId: 2, language: 'greek', releaseInfo: ['X.2020'] }] };
  assert.deepEqual(parseSubtitleRows(body, { type: 'movie' }).map((r) => r.ref), ['2']);
});

test('releaseName joins an array and accepts a string', () => {
  assert.equal(releaseName({ releaseInfo: ['BluRay', '1080p'] }), 'BluRay 1080p');
  assert.equal(releaseName({ releaseInfo: 'A.B.2020' }), 'A.B.2020');
  assert.equal(releaseName({}), '');
});

// ---- search() / download() with a mocked fetch: failures must be contained, the key must stay in the header ----
const realFetch = globalThis.fetch;
const realLog = console.log;
const restore = () => { globalThis.fetch = realFetch; console.log = realLog; };
const json = (status, body, h = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...h } });

test('search: happy path sends the key only in X-API-Key, one log line, no key in it', async () => {
  const calls = [];
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), headers: opts.headers });
    return String(url).includes('/movies/search') ? json(200, sample('search-movie-tt0111161.json')) : json(200, sample('subtitles-movie-tt0111161-greek.json'));
  };
  try {
    const r = await subsource.search({ type: 'movie', imdbId: 'tt0111161', cfg: { apiKey: 'KEY-happy-0001' } });
    assert.equal(r.length, 2);
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.equal(c.headers['X-API-Key'], 'KEY-happy-0001');
      assert.ok(!c.url.includes('KEY-happy-0001'));
    }
    assert.match(calls[0].url, /searchType=imdb&imdb=tt0111161&type=movie/);
    assert.match(calls[1].url, /movieId=97027&language=greek&limit=100&sort=popular/);
    const mine = lines.filter((l) => l.startsWith('[subsource]'));
    assert.equal(mine.length, 1);
    assert.match(mine[0], /tt0111161 took [\d.]+s \(2 results\)/);
    assert.ok(!lines.join('\n').includes('KEY-happy-0001'));
  } finally { restore(); }
});

test('search: the second identical search is served from cache (no new requests)', async () => {
  let n = 0;
  console.log = () => {};
  globalThis.fetch = async () => { n++; return json(500, {}); };
  try {
    const r = await subsource.search({ type: 'movie', imdbId: 'tt0111161', cfg: { apiKey: 'KEY-happy-0001' } });
    assert.equal(r.length, 2);
    assert.equal(n, 0);
  } finally { restore(); }
});

test('search: no results (title unknown, or no Greek) returns []', async () => {
  console.log = () => {};
  try {
    globalThis.fetch = async () => json(200, { success: true, data: [] });
    assert.deepEqual(await subsource.search({ type: 'movie', imdbId: 'tt0000001', cfg: { apiKey: 'KEY-empty-0002' } }), []);
    globalThis.fetch = async (url) => (String(url).includes('/movies/search')
      ? json(200, sample('search-series-tt0364845-s23.json'))
      : json(200, sample('subtitles-series-tt0364845-s23-greek.json')));
    assert.deepEqual(await subsource.search({ type: 'series', imdbId: 'tt0364845', season: 23, episode: 19, cfg: { apiKey: 'KEY-empty-0002' } }), []);
  } finally { restore(); }
});

test('search: a bad key rejects with a clear error, then is not retried for a while', async () => {
  console.log = () => {};
  let n = 0;
  globalThis.fetch = async () => { n++; return json(401, { error: 'API key required' }); };
  try {
    await assert.rejects(subsource.search({ type: 'movie', imdbId: 'tt0000002', cfg: { apiKey: 'KEY-bad-0003' } }), /key rejected \(401\)/);
    await assert.rejects(subsource.search({ type: 'movie', imdbId: 'tt0000003', cfg: { apiKey: 'KEY-bad-0003' } }), /rejected recently/);
    assert.equal(n, 1);
  } finally { restore(); }
});

test('search: a timeout rejects with a short message', async () => {
  console.log = () => {};
  globalThis.fetch = async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
  try {
    await assert.rejects(subsource.search({ type: 'movie', imdbId: 'tt0000004', cfg: { apiKey: 'KEY-slow-0004' } }), /timed out/);
  } finally { restore(); }
});

test('search: 429 backs off (no further requests until the reset time)', async () => {
  console.log = () => {};
  let n = 0;
  const reset = new Date(Date.now() + 30000).toISOString();
  globalThis.fetch = async () => { n++; return json(429, { error: 'Too many requests' }, { 'x-ratelimit-reset': reset }); };
  try {
    await assert.rejects(subsource.search({ type: 'movie', imdbId: 'tt0000005', cfg: { apiKey: 'KEY-429-0005' } }), /429/);
    await assert.rejects(subsource.search({ type: 'movie', imdbId: 'tt0000006', cfg: { apiKey: 'KEY-429-0005' } }), /backing off/);
    assert.equal(n, 1);
    // another user's key is not affected
    globalThis.fetch = async () => json(200, { success: true, data: [] });
    assert.deepEqual(await subsource.search({ type: 'movie', imdbId: 'tt0000007', cfg: { apiKey: 'KEY-other-0006' } }), []);
  } finally { restore(); }
});

test('download: refuses a JSON error body, returns a zip', async () => {
  const realLogFn = console.log; console.log = () => {};
  try {
    globalThis.fetch = async () => json(200, { error: 'nope' });
    await assert.rejects(subsource.download({ ref: '900001', cfg: { apiKey: 'KEY-dl-0007' } }), /not a subtitle/);
    const zip = Buffer.from([0x50, 0x4b, 3, 4, 0, 0]);
    let url;
    globalThis.fetch = async (u) => { url = String(u); return new Response(zip, { status: 200 }); };
    const got = await subsource.download({ ref: '900002', cfg: { apiKey: 'KEY-dl-0007' } });
    assert.equal(got[0], 0x50);
    assert.match(url, /\/subtitles\/900002\/download$/);
  } finally { restore(); console.log = realLogFn; }
});
