import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { sweepDisk, startCacheCleanup, cacheMaxBytes, SWEEP_MAX_AGE_MS } from '../src/lib/cache.js';

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 9, 21);
const hex = (s) => crypto.createHash('sha1').update(s).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gs-sweep-'));

/** Writes `bytes` bytes to <sha1(name)><ext> with an mtime `ageDays` before NOW. -> file name. */
function put(dir, name, ext, ageDays, bytes = 100) {
  const f = hex(name) + ext;
  fs.writeFileSync(path.join(dir, f), Buffer.alloc(bytes, 1));
  const t = new Date(NOW - ageDays * DAY);
  fs.utimesSync(path.join(dir, f), t, t);
  return f;
}
const left = (dir) => fs.readdirSync(dir).sort();

test('sweep removes expired files by extension and keeps the rest', async () => {
  const dir = tmp();
  const keep = [put(dir, 'bin-fresh', '.bin', 6), put(dir, 'srt-old-but-valid', '.srt', 100), put(dir, 'json-ok', '.json', 100)];
  put(dir, 'bin-old', '.bin', 8);
  put(dir, 'srt-old', '.srt', 121);
  put(dir, 'json-old', '.json', 181);
  const r = await sweepDisk({ dir, maxBytes: 0, now: NOW });
  assert.deepEqual(left(dir), keep.sort());
  assert.deepEqual({ expired: r.expired, evicted: r.evicted, files: r.files }, { expired: 3, evicted: 0, files: 3 });
  assert.equal(SWEEP_MAX_AGE_MS['.bin'], 7 * DAY);
});

test('sweep never touches files it did not write', async () => {
  const dir = tmp();
  for (const name of ['notes.txt', 'abc.srt', hex('x') + '.exe', hex('y') + '.srt.bak', 'README']) {
    fs.writeFileSync(path.join(dir, name), 'keep me');
    const t = new Date(NOW - 1000 * DAY);
    fs.utimesSync(path.join(dir, name), t, t);
  }
  fs.mkdirSync(path.join(dir, hex('d') + '.srt')); // a directory with a cache-looking name
  const r = await sweepDisk({ dir, maxBytes: 1, now: NOW });
  assert.equal(left(dir).length, 6);
  assert.equal(r.expired + r.evicted, 0);
});

test('size cap evicts the oldest files first until the folder fits', async () => {
  const dir = tmp();
  const oldest = put(dir, 'a', '.srt', 10);
  const second = put(dir, 'b', '.bin', 5);
  const third = put(dir, 'c', '.srt', 3);
  const newest = put(dir, 'd', '.srt', 1);
  const mid = put(dir, 'e', '.json', 4);
  const r = await sweepDisk({ dir, maxBytes: 250, now: NOW }); // 5 x 100 bytes -> keep the 2 newest
  assert.deepEqual(left(dir), [newest, third].sort());
  assert.equal(r.evicted, 3);
  assert.equal(r.bytes, 200);
  assert.ok(![oldest, second, mid].some((f) => fs.existsSync(path.join(dir, f))));
});

test('size cap works on sizes, not file counts, and 0 means no cap', async () => {
  const dir = tmp();
  const big = put(dir, 'big', '.bin', 2, 5000);
  const small = put(dir, 'small', '.srt', 1, 10);
  await sweepDisk({ dir, maxBytes: 0, now: NOW });
  assert.equal(left(dir).length, 2);
  await sweepDisk({ dir, maxBytes: 1000, now: NOW });
  assert.deepEqual(left(dir), [small]);
  assert.ok(!fs.existsSync(path.join(dir, big)));
});

test('sweep of a missing folder is empty and does not throw', async () => {
  const r = await sweepDisk({ dir: path.join(tmp(), 'nope'), maxBytes: 1, now: NOW });
  assert.deepEqual(r, { expired: 0, evicted: 0, files: 0, bytes: 0 });
});

test('CACHE_MAX_MB: default 500 MB, 0 = no cap, junk falls back to the default', () => {
  const MB = 1024 * 1024;
  assert.equal(cacheMaxBytes({}), 500 * MB);
  assert.equal(cacheMaxBytes({ CACHE_MAX_MB: '' }), 500 * MB);
  assert.equal(cacheMaxBytes({ CACHE_MAX_MB: '64' }), 64 * MB);
  assert.equal(cacheMaxBytes({ CACHE_MAX_MB: '0' }), 0);
  assert.equal(cacheMaxBytes({ CACHE_MAX_MB: '0.5' }), 0.5 * MB);
  for (const bad of ['abc', '-5', 'Infinity']) assert.equal(cacheMaxBytes({ CACHE_MAX_MB: bad }), 500 * MB, bad);
});

test('startCacheCleanup sweeps at once, then on the timer, skips overlaps, and stops', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const stop = startCacheCleanup({
    intervalMs: 10,
    sweep: async () => { calls++; if (calls === 1) await gate; return { expired: 0, evicted: 0, files: 0, bytes: 0 }; },
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, 1, 'a slow sweep is not overlapped by the timer');
  release();
  await stop.done;
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(calls >= 2, `timer sweeps (${calls})`);
  stop();
  const n = calls;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, n, 'stopped');
});

test('startCacheCleanup survives a failing sweep and logs only a fixed text', async () => {
  const errs = [];
  const real = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const stop = startCacheCleanup({ intervalMs: 1000, sweep: async () => { throw new Error('C:\secret\path SECRETKEY'); } });
    await stop.done;
    stop();
  } finally {
    console.error = real;
  }
  assert.deepEqual(errs, ['[cache] cleanup failed']);
});
