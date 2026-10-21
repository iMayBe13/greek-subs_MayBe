// The AI slot of cache.js (getAi / setAi / delAi, setAiStore, the memory layer) and proof that the Greek cache is unchanged.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  setStore, setAiStore, diskStore, getCached, setCached, getCachedBuf, setCachedBuf, getCachedJson, setCachedJson, getAi, setAi, delAi,
} from '../src/lib/cache.js';

/** In-memory store that records every call. `kind` is part of the stored name, like the disk store's extension. */
function recordingStore(name, { failSet = false } = {}) {
  const data = new Map();
  const calls = [];
  return {
    name, data, calls,
    async get(key, opts = {}) { calls.push(['get', key, opts]); return data.get(`${opts.kind}:${key}`) ?? null; },
    async set(key, buf, opts = {}) { calls.push(['set', key, opts]); if (failSet) return false; data.set(`${opts.kind}:${key}`, buf); },
    async del(key, opts = {}) { calls.push(['del', key, opts]); for (const k of opts.kind ? [opts.kind] : ['text', 'bin', 'json']) data.delete(`${k}:${key}`); },
  };
}
const ops = (s, op) => s.calls.filter((c) => c[0] === op);
let n = 0;
const uniq = (p = 'ai') => `${p}:test:${process.pid}:${++n}`; // the memory layer is per process: every test uses its own keys

afterEach(() => { setStore(diskStore); setAiStore(null); });

test('without an AI store the AI helpers fall back to the main store', async () => {
  const main = recordingStore('main');
  setStore(main);
  const k = uniq();
  assert.equal(await setAi(k, 'Γειά σου', { ttlSec: 600 }), true);
  assert.equal(await getAi(k), 'Γειά σου');
  assert.equal(ops(main, 'set').length, 1);
  assert.deepEqual(ops(main, 'set')[0][2], { kind: 'text', ttlSec: 600 });
  assert.equal(await delAi(k), true);
  assert.equal(await getAi(k), null);
  assert.equal(ops(main, 'del').length, 1);
});

test('with an AI store, AI values go there and Greek values stay on the main store, in both directions', async () => {
  const main = recordingStore('main');
  const ai = recordingStore('ai');
  setStore(main); setAiStore(ai);
  const k = uniq();
  await setAi(k, 'AI file');
  await setAi(`${k}:job`, '{"a":1}', { kind: 'json' });
  assert.equal(ai.calls.filter((c) => c[0] === 'set').length, 2);
  assert.equal(main.calls.length, 0, 'AI values must not reach the main store');

  await setCached('gr:text', 'Ελληνικά');
  await setCachedBuf('gr:zip', Buffer.from([80, 75, 3, 4]));
  await setCachedJson('gr:names', ['a.srt']);
  assert.equal(await getCached('gr:text'), 'Ελληνικά');
  assert.deepEqual([...(await getCachedBuf('gr:zip'))], [80, 75, 3, 4]);
  assert.deepEqual(await getCachedJson('gr:names'), ['a.srt']);
  assert.equal(ai.calls.filter((c) => c[1].startsWith('gr:')).length, 0, 'Greek values must not reach the AI store');
  assert.deepEqual(ops(main, 'set').map((c) => c[2].kind), ['text', 'bin', 'json']);
  assert.ok(ops(main, 'set').every((c) => c[2].ttlSec === undefined)); // the Greek helpers pass no ttl
});

test('setAiStore(null) goes back to the fallback', async () => {
  const main = recordingStore('main'), ai = recordingStore('ai');
  setStore(main); setAiStore(ai); setAiStore(null);
  await setAi(uniq(), 'x');
  assert.equal(ai.calls.length, 0);
  assert.equal(main.calls.length, 1);
});

test('memory layer: a second read costs no store call, and a write is readable at once even if the store refused it', async () => {
  const ai = recordingStore('ai', { failSet: true });
  setAiStore(ai);
  const k = uniq();
  assert.equal(await setAi(k, 'kept in memory'), false); // the store said no ...
  assert.equal(await getAi(k), 'kept in memory'); // ... but this process still has it
  assert.equal(ops(ai, 'get').length, 0);

  const k2 = uniq();
  ai.data.set(`text:${k2}`, Buffer.from('from the store'));
  assert.equal(await getAi(k2), 'from the store');
  assert.equal(await getAi(k2), 'from the store');
  assert.equal(await getAi(k2), 'from the store');
  assert.equal(ops(ai, 'get').filter((c) => c[1] === k2).length, 1);
  assert.equal(await getAi(uniq()), null); // misses are not remembered
  const miss = uniq();
  await getAi(miss); await getAi(miss);
  assert.equal(ops(ai, 'get').filter((c) => c[1] === miss).length, 2);
});

test('memory layer: entries expire after about 10 minutes, and maxAgeMs older than the entry bypasses it', async (t) => {
  let clock = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => clock);
  const ai = recordingStore('ai');
  setAiStore(ai);
  const k = uniq();
  ai.data.set(`text:${k}`, Buffer.from('v1'));
  assert.equal(await getAi(k), 'v1');
  clock += 9 * 60 * 1000;
  assert.equal(await getAi(k), 'v1');
  assert.equal(ops(ai, 'get').length, 1); // still from memory
  ai.data.set(`text:${k}`, Buffer.from('v2'));
  clock += 61 * 1000; // 10 minutes and 1 second after the first read
  assert.equal(await getAi(k), 'v2');
  assert.equal(ops(ai, 'get').length, 2);

  clock += 5 * 60 * 1000;
  assert.equal(await getAi(k, { maxAgeMs: 60 * 1000 }), 'v2'); // memory entry is 5 min old: too old for this caller, so the store is asked
  assert.equal(ops(ai, 'get').length, 3);
  assert.deepEqual(ops(ai, 'get')[2][2], { kind: 'text', maxAgeMs: 60 * 1000 });
});

test('memory layer: bounded, the oldest entries go first', async () => {
  const ai = recordingStore('ai');
  setAiStore(ai);
  const keys = Array.from({ length: 70 }, () => uniq());
  for (const k of keys) await setAi(k, 'x');
  ai.calls.length = 0;
  await getAi(keys.at(-1));
  assert.equal(ai.calls.length, 0); // newest is in memory
  ai.data.set(`text:${keys[0]}`, Buffer.from('x'));
  await getAi(keys[0]);
  assert.equal(ai.calls.length, 1); // oldest was evicted
});

test('delAi clears memory and asks the store to delete (every kind unless one is given)', async () => {
  const ai = recordingStore('ai');
  setAiStore(ai);
  const k = uniq();
  await setAi(k, 'a');
  await setAi(k, 'b', { kind: 'json' });
  assert.equal(await delAi(k), true);
  assert.deepEqual(ops(ai, 'del')[0].slice(1), [k, { kind: undefined }]);
  assert.equal(await getAi(k), null);
  assert.equal(await getAi(k, { kind: 'json' }), null);
  const k2 = uniq();
  await setAi(k2, 'a'); await setAi(k2, 'b', { kind: 'json' });
  await delAi(k2, { kind: 'json' });
  assert.equal(await getAi(k2), 'a'); // the text value survives
  assert.equal(await getAi(k2, { kind: 'json' }), null);
});

test('delAi is false when the store cannot delete; the helpers never throw even if the store does', async () => {
  setAiStore({ async get() { return null; }, async set() {} });
  assert.equal(await delAi(uniq()), false);
  const boom = () => { throw new Error('store is down'); };
  setAiStore({ get: boom, set: boom, del: boom });
  const k = uniq();
  assert.equal(await getAi(k), null);
  assert.equal(await setAi(k, 'x'), false);
  assert.equal(await delAi(k), false);
});

test('kinds are separate: the same key as text and as json are two values', async () => {
  setAiStore(recordingStore('ai'));
  const k = uniq();
  await setAi(k, 'plain');
  await setAi(k, '{"j":1}', { kind: 'json' });
  assert.equal(await getAi(k), 'plain');
  assert.equal(await getAi(k, { kind: 'json' }), '{"j":1}');
});

// ---------- the disk store, unchanged ----------
function withCacheDir(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-cache-ai-'));
    const old = process.env.CACHE_DIR;
    process.env.CACHE_DIR = dir;
    try { await fn(dir); } finally { if (old === undefined) delete process.env.CACHE_DIR; else process.env.CACHE_DIR = old; fs.rmSync(dir, { recursive: true, force: true }); }
  };
}
const fileFor = (dir, key, ext) => path.join(dir, crypto.createHash('sha1').update(key).digest('hex') + ext);

test('disk store: file names (sha1 of the key + extension by kind) and contents are unchanged', withCacheDir(async (dir) => {
  await setCached('a', 'Γειά σου');
  await setCachedBuf('b', Buffer.from([1, 2, 3]));
  await setCachedJson('c', ['x.srt']);
  assert.equal(fs.readFileSync(fileFor(dir, 'a', '.srt'), 'utf8'), 'Γειά σου');
  assert.deepEqual([...fs.readFileSync(fileFor(dir, 'b', '.bin'))], [1, 2, 3]);
  assert.equal(fs.readFileSync(fileFor(dir, 'c', '.json'), 'utf8'), '["x.srt"]');
  assert.deepEqual(fs.readdirSync(dir).sort().length, 3);
  assert.equal(await getCached('a'), 'Γειά σου');
  assert.equal(await getCachedJson('c').then((v) => v[0]), 'x.srt');
  assert.equal(await getCached('missing'), null);
}));

test('disk store: maxAgeMs still uses the file age, and ttlSec is accepted and ignored', withCacheDir(async (dir) => {
  await diskStore.set('old', Buffer.from('v'), { kind: 'text', ttlSec: 60 });
  assert.equal((await diskStore.get('old', { kind: 'text' })).toString(), 'v');
  const f = fileFor(dir, 'old', '.srt');
  const past = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  fs.utimesSync(f, past, past);
  assert.equal(await diskStore.get('old', { kind: 'text', maxAgeMs: 24 * 3600 * 1000 }), null);
  assert.equal((await diskStore.get('old', { kind: 'text', maxAgeMs: 7 * 24 * 3600 * 1000 })).toString(), 'v');
  assert.equal((await diskStore.get('old', { kind: 'text' })).toString(), 'v');
}));

test('disk store: del removes one kind, or every kind when none is given, and is true for a missing key', withCacheDir(async (dir) => {
  await diskStore.set('k', Buffer.from('t'), { kind: 'text' });
  await diskStore.set('k', Buffer.from('j'), { kind: 'json' });
  assert.equal(await diskStore.del('k', { kind: 'json' }), true);
  assert.equal(fs.existsSync(fileFor(dir, 'k', '.json')), false);
  assert.equal(fs.existsSync(fileFor(dir, 'k', '.srt')), true);
  assert.equal(await diskStore.del('k'), true);
  assert.equal(fs.readdirSync(dir).length, 0);
  assert.equal(await diskStore.del('never-existed'), true);
}));

test('AI helpers on the disk fallback: round trip through real files, and the Greek cache is untouched', withCacheDir(async (dir) => {
  await setCached('greek', 'Ελληνικά');
  const k = uniq();
  assert.equal(await setAi(k, 'AI Μετάφραση', { ttlSec: 3600 }), true);
  assert.equal(fs.readFileSync(fileFor(dir, k, '.srt'), 'utf8'), 'AI Μετάφραση');
  assert.equal(await getCached('greek'), 'Ελληνικά');
  assert.equal(await delAi(k), true);
  assert.equal(fs.existsSync(fileFor(dir, k, '.srt')), false);
  assert.equal(await getCached('greek'), 'Ελληνικά');
}));
