import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import AdmZip from 'adm-zip';
import { readCapped, LimitError, MAX_DOWNLOAD_BYTES, ZIP_LIMITS } from '../src/lib/limits.js';
import { pickFromArchive, listArchiveNames } from '../src/lib/archive.js';
import subdl from '../src/providers/subdl.js';

const MB = 1024 * 1024;
const zipOf = (files) => {
  const z = new AdmZip();
  for (const [name, data] of Object.entries(files)) z.addFile(name, Buffer.isBuffer(data) ? data : Buffer.from(data));
  return z.toBuffer();
};
const srt = (n) => Array.from({ length: n }, (_, i) => `${i + 1}\n00:00:01,000 --> 00:00:02,000\nline ${i}\n`).join('\n');

// ---------- download cap ----------

test('readCapped returns a body at or under the cap', async () => {
  assert.equal((await readCapped(new Response('hello'), 5)).toString(), 'hello');
  assert.equal((await readCapped(new Response(''), 5)).length, 0);
});

test('readCapped refuses a declared Content-Length over the cap without reading the body', async () => {
  let pulled = 0;
  const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); } });
  const res = new Response(body, { headers: { 'content-length': String(100 * MB) } });
  await assert.rejects(readCapped(res, 10 * MB), (e) => e instanceof LimitError && e.code === 'limit' && /too large/.test(e.message));
  assert.ok(pulled <= 2, `body was read (${pulled} pulls)`);
});

test('readCapped stops an endless body that does not declare its length', async () => {
  let chunks = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(c) { chunks++; c.enqueue(new Uint8Array(64 * 1024)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readCapped(new Response(body), 1 * MB), LimitError);
  assert.ok(chunks <= 40, `read ${chunks} chunks`);
  assert.equal(cancelled, true);
});

test('readCapped also checks a response that has no streaming body', async () => {
  const fake = (n) => ({ headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(n) });
  assert.equal((await readCapped(fake(5), 5)).length, 5);
  await assert.rejects(readCapped(fake(6), 5), LimitError);
});

test('limit error messages carry numbers only', async () => {
  const e = await readCapped(new Response('x', { headers: { 'content-length': '999999999' } }), 10).catch((x) => x);
  assert.match(e.message, /^download too large \(\d+ bytes, limit \d+\)$/);
});

test('every provider reads downloads through readCapped, none with a bare arrayBuffer()', () => {
  for (const f of ['opensubtitles', 'subdl', 'greeksubs', 'subsource']) {
    const src = fs.readFileSync(new URL(`../src/providers/${f}.js`, import.meta.url), 'utf8');
    assert.ok(!/arrayBuffer\(\)/.test(src), `${f}.js still calls arrayBuffer()`);
    assert.match(src, /readCapped\(/, f);
  }
});

test('a provider download over the cap fails with a LimitError (SubDL)', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('x', { headers: { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) } });
  try {
    await assert.rejects(subdl.download({ ref: '/subtitle/1-2.zip' }), LimitError);
  } finally {
    globalThis.fetch = real;
  }
});

test('pickFromArchive refuses a buffer over the download cap', () => {
  assert.throws(() => pickFromArchive(Buffer.alloc(MAX_DOWNLOAD_BYTES + 1)), LimitError);
});

// ---------- zip limits ----------

test('a normal season pack still opens and the right episode is picked', () => {
  const files = {};
  for (let e = 1; e <= 24; e++) files[`Show.S01E${String(e).padStart(2, '0')}.srt`] = srt(900); // ~24 x 40 KB
  const buf = zipOf(files);
  assert.equal(listArchiveNames(buf).length, 24);
  const p = pickFromArchive(buf, { season: 1, episode: 7 });
  assert.equal(p.name, 'Show.S01E07.srt');
  assert.ok(p.data.length > 30000);
});

test('more entries than the limit is refused (default 1000, and a custom limit)', () => {
  const many = {};
  for (let i = 0; i < ZIP_LIMITS.maxEntries + 1; i++) many[`f${i}.srt`] = 'x';
  const big = zipOf(many);
  assert.throws(() => pickFromArchive(big), (e) => e instanceof LimitError && /too many entries/.test(e.message));
  assert.deepEqual(listArchiveNames(big), []);

  const five = zipOf({ 'a.srt': '1', 'b.srt': '2', 'c.srt': '3', 'd.srt': '4', 'e.srt': '5' });
  assert.throws(() => pickFromArchive(five, { limits: { ...ZIP_LIMITS, maxEntries: 4 } }), LimitError);
  assert.ok(pickFromArchive(five, { limits: { ...ZIP_LIMITS, maxEntries: 5 } }));
});

test('a zip bomb is refused by the ratio guard before anything is inflated', () => {
  const bomb = zipOf({ 'bomb.srt': Buffer.alloc(8 * MB) }); // 8 MB of zeros -> a few KB
  assert.ok(bomb.length < 50 * 1024);
  assert.throws(() => pickFromArchive(bomb), (e) => e instanceof LimitError && /compresses \d+:1/.test(e.message));
  assert.deepEqual(listArchiveNames(bomb), []);
});

test('too much uncompressed data in all is refused, even when each entry is fine', () => {
  const buf = zipOf({ 'a.srt': srt(50), 'b.srt': srt(50) });
  const total = new AdmZip(buf).getEntries().reduce((n, e) => n + e.header.size, 0);
  assert.throws(() => pickFromArchive(buf, { limits: { ...ZIP_LIMITS, maxUncompressed: total - 1 } }), (e) => e instanceof LimitError && /too large when unpacked/.test(e.message));
  assert.ok(pickFromArchive(buf, { limits: { ...ZIP_LIMITS, maxUncompressed: total } }));
});

test('a small, very repetitive subtitle is not mistaken for a bomb', () => {
  const buf = zipOf({ 'a.srt': 'x'.repeat(200 * 1024) }); // ratio far above 100, but under the 1 MB floor
  assert.equal(pickFromArchive(buf).data.length, 200 * 1024);
});

test('an archive whose header lies about the size cannot inflate more than it declares', () => {
  const buf = zipOf({ 'lie.srt': Buffer.alloc(3 * MB, 0x41) });
  const central = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const local = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  buf.writeUInt32LE(100, central + 24); // declared uncompressed size, central directory
  buf.writeUInt32LE(100, local + 22); // and in the local header
  let r = null;
  try { r = pickFromArchive(buf); } catch { /* refusing is fine */ }
  assert.ok(r === null || r.data.length <= 100, `inflated ${r?.data.length} bytes`);
});

test('a file that is not a zip at all is not a LimitError (unchanged behaviour: it throws or passes through)', () => {
  const junk = Buffer.concat([Buffer.from('PK'), Buffer.alloc(40)]);
  assert.throws(() => pickFromArchive(junk), (e) => !(e instanceof LimitError));
  assert.deepEqual(listArchiveNames(junk), []);
});
