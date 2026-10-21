// src/index.js picks the AI store from the environment: Cloudflare KV only when all three variables are set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = 'wiring-test-TOKEN-91c4e7a2d8';
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** Starts the real server, waits for /health, returns what it logged, stops it. No request reaches Cloudflare: starting never uses KV. */
async function startAndRead(cloudflare) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), BASE_URL: `http://127.0.0.1:${port}`, SECRET: 'test-secret-for-wiring-test-0123456789',
    CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'gs-kv-wiring-')) };
  for (const k of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_KV_NAMESPACE_ID', 'CLOUDFLARE_API_TOKEN']) delete env[k];
  Object.assign(env, cloudflare);
  const proc = spawn(process.execPath, ['src/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  proc.stdout.on('data', (d) => { logs += d; });
  proc.stderr.on('data', (d) => { logs += d; });
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return logs; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server did not start');
  } finally { proc.kill(); }
}

test('all three CLOUDFLARE_* variables set: the server reports Cloudflare KV and never prints the token', async () => {
  const logs = await startAndRead({ CLOUDFLARE_ACCOUNT_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', CLOUDFLARE_KV_NAMESPACE_ID: '0123456789abcdef0123456789abcdef', CLOUDFLARE_API_TOKEN: TOKEN });
  assert.match(logs, /\[kv\] AI store: Cloudflare KV/);
  assert.ok(!logs.includes(TOKEN));
  assert.ok(!logs.includes('a1b2c3d4e5f60718293a4b5c6d7e8f90'));
});

test('one or none of them set: the AI store is the disk', async () => {
  for (const cf of [{}, { CLOUDFLARE_API_TOKEN: TOKEN }, { CLOUDFLARE_ACCOUNT_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', CLOUDFLARE_KV_NAMESPACE_ID: '0123456789abcdef0123456789abcdef', CLOUDFLARE_API_TOKEN: '' }]) {
    const logs = await startAndRead(cf);
    assert.match(logs, /\[kv\] AI store: disk/);
    assert.ok(!logs.includes('Cloudflare KV'));
    assert.ok(!logs.includes(TOKEN));
  }
});
