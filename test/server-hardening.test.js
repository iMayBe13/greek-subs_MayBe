// Starts real servers with different environments: the key-test switch, the proxy hops and CF-Connecting-IP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** Starts the server with `env` on top of a clean base; -> { base, logs(), stop() }. */
async function start(env = {}) {
  const port = await freePort();
  let logs = '';
  const clean = { ...process.env };
  for (const k of ['RENDER', 'NODE_ENV', 'BASE_URL', 'ENABLE_KEY_TEST', 'TRUST_PROXY', 'TRUST_PROXY_HOPS', 'TRUST_CF_CONNECTING_IP']) delete clean[k];
  const proc = spawn(process.execPath, ['src/index.js'], {
    env: {
      ...clean, PORT: String(port), SECRET: 'test-secret-for-hardening-0123456789abcdef',
      GREEKSUBS_BASE: 'http://127.0.0.1:1', CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'gs-hard-')), ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => { logs += d; });
  proc.stderr.on('data', (d) => { logs += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return { base, logs: () => logs, stop: () => proc.kill() }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('server did not start');
}

const postTest = (base, headers = {}) => fetch(`${base}/api/test`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ providers: {} }),
});
/** Sends `n` requests as one client and returns the status of the last. */
async function burst(base, n, headers) {
  let r;
  for (let i = 0; i < n; i++) r = await postTest(base, headers);
  return r.status;
}

test('hosted without ENABLE_KEY_TEST: /api/test is off, the page is told, the key is never looked at', async () => {
  const s = await start({ BASE_URL: 'https://subs.example.com' });
  try {
    const r = await fetch(`${s.base}/api/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providers: { subdl: { apiKey: 'LEAKY-KEY-9' } } }) });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'disabled' });
    assert.deepEqual(await (await fetch(`${s.base}/api/features`)).json(), { keyTest: false });
    assert.match(s.logs(), /key test endpoint \(\/api\/test\): off/);
    assert.ok(!s.logs().includes('LEAKY-KEY-9'));
    // the rest of the add-on is unaffected
    assert.equal((await fetch(`${s.base}/configure`)).status, 200);
    assert.equal((await fetch(`${s.base}/api/providers`)).status, 200);
  } finally { s.stop(); }
});

test('Render without ENABLE_KEY_TEST is off too; ENABLE_KEY_TEST=1 turns it on, and it is still rate limited', async () => {
  const off = await start({ RENDER: 'true', BASE_URL: 'https://subs.example.com' });
  try {
    assert.equal((await postTest(off.base)).status, 404);
  } finally { off.stop(); }
  const on = await start({ RENDER: 'true', BASE_URL: 'https://subs.example.com', ENABLE_KEY_TEST: '1' });
  try {
    assert.deepEqual(await (await fetch(`${on.base}/api/features`)).json(), { keyTest: true });
    assert.equal((await postTest(on.base)).status, 200);
    assert.equal(await burst(on.base, 11, {}), 429);
  } finally { on.stop(); }
});

test('local development: on by default; ENABLE_KEY_TEST=0 turns it off', async () => {
  const dev = await start();
  try {
    assert.deepEqual(await (await fetch(`${dev.base}/api/features`)).json(), { keyTest: true });
    assert.equal((await postTest(dev.base)).status, 200);
  } finally { dev.stop(); }
  const off = await start({ ENABLE_KEY_TEST: '0' });
  try {
    assert.equal((await postTest(off.base)).status, 404);
  } finally { off.stop(); }
});

test('with 1 hop behind a second proxy every visitor looks like the proxy; with 2 hops each gets their own limit', async () => {
  // X-Forwarded-For as the app sees it behind Cloudflare and Render: "client, cloudflare"
  const xff = (client) => ({ 'X-Forwarded-For': `${client}, 172.70.0.1` });
  const one = await start({ TRUST_PROXY_HOPS: '1' });
  try {
    assert.equal(await burst(one.base, 11, xff('198.51.100.1')), 429);
    assert.equal((await postTest(one.base, xff('198.51.100.2'))).status, 429, 'a different visitor shares the Cloudflare address');
  } finally { one.stop(); }
  const two = await start({ TRUST_PROXY_HOPS: '2' });
  try {
    assert.match(two.logs(), /trusting 2 proxy hop/);
    assert.equal(await burst(two.base, 11, xff('198.51.100.1')), 429);
    assert.equal((await postTest(two.base, xff('198.51.100.2'))).status, 200, 'a different visitor has their own limit');
  } finally { two.stop(); }
});

test('the old TRUST_PROXY still means 1 hop, and a bad TRUST_PROXY_HOPS warns and falls back', async () => {
  const legacy = await start({ TRUST_PROXY: '1' });
  try {
    assert.match(legacy.logs(), /trusting 1 proxy hop/);
  } finally { legacy.stop(); }
  const bad = await start({ TRUST_PROXY_HOPS: 'two' });
  try {
    assert.match(bad.logs(), /\[config\] TRUST_PROXY_HOPS must be a whole number/);
    assert.match(bad.logs(), /trusting 0 proxy hop/);
  } finally { bad.stop(); }
});

test('without proxy trust a forged X-Forwarded-For does not buy a fresh limit', async () => {
  const s = await start();
  try {
    for (let i = 0; i < 10; i++) await postTest(s.base, { 'X-Forwarded-For': `203.0.113.${i}` });
    assert.equal((await postTest(s.base, { 'X-Forwarded-For': '203.0.113.99' })).status, 429);
  } finally { s.stop(); }
});

test('CF-Connecting-IP counts only when TRUST_CF_CONNECTING_IP is set', async () => {
  const cf = (ip) => ({ 'CF-Connecting-IP': ip });
  const ignored = await start();
  try {
    assert.match(ignored.logs(), /CF-Connecting-IP header: ignored/);
    assert.equal(await burst(ignored.base, 11, cf('198.51.100.1')), 429);
    assert.equal((await postTest(ignored.base, cf('198.51.100.2'))).status, 429, 'the header was not used');
  } finally { ignored.stop(); }
  const used = await start({ TRUST_CF_CONNECTING_IP: '1' });
  try {
    assert.match(used.logs(), /CF-Connecting-IP header: trusted/);
    assert.equal(await burst(used.base, 11, cf('198.51.100.1')), 429);
    assert.equal((await postTest(used.base, cf('198.51.100.2'))).status, 200, 'another visitor has their own limit');
    // a missing or invalid header falls back to the connection address, which is shared here
    assert.equal((await postTest(used.base, cf('not-an-ip'))).status, 200);
  } finally { used.stop(); }
});
