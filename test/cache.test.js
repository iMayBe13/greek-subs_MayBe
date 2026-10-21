import test from 'node:test';
import assert from 'node:assert/strict';
import { setStore, diskStore, getCached, setCached, getCachedBuf, setCachedBuf, getCachedJson, setCachedJson } from '../src/lib/cache.js';

test('cache works against any store with get(key, opts) / set(key, buf, opts)', async () => {
  const data = new Map();
  const calls = [];
  setStore({
    async get(key, opts) { calls.push(['get', key, opts.kind]); return data.get(opts.kind + ':' + key) ?? null; },
    async set(key, buf, opts) { calls.push(['set', key, opts.kind]); data.set(opts.kind + ':' + key, buf); },
  });
  try {
    await setCached('a', 'Γειά σου');
    assert.equal(await getCached('a'), 'Γειά σου');
    await setCachedBuf('b', Buffer.from([1, 2, 3]));
    assert.deepEqual([...(await getCachedBuf('b'))], [1, 2, 3]);
    await setCachedJson('c', ['x.srt']);
    assert.deepEqual(await getCachedJson('c'), ['x.srt']);
    assert.equal(await getCached('missing'), null);
    assert.equal(await getCachedJson('missing'), null);
    assert.deepEqual(calls.filter((c) => c[0] === 'set').map((c) => c[2]), ['text', 'bin', 'json']);
  } finally {
    setStore(diskStore);
  }
});
