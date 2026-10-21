// Anything but clear local development must not start without a SECRET of 32+ characters that is not a known placeholder
// (the dev fallback and the old .env.example value are public); local dev still runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { secretError } from '../src/lib/crypto.js';

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** Starts the server with SECRET, RENDER and NODE_ENV removed, plus `extra`. */
async function start(extra) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), BASE_URL: `http://127.0.0.1:${port}`, GREEKSUBS_BASE: 'http://127.0.0.1:1',
    CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'gs-secret-test-')), ...extra };
  for (const k of ['SECRET', 'RENDER', 'NODE_ENV']) if (!(k in extra)) delete env[k];
  const proc = spawn(process.execPath, ['src/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  proc.stdout.on('data', (d) => { logs += d; });
  proc.stderr.on('data', (d) => { logs += d; });
  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  return { proc, port, exited, logs: () => logs };
}

test('secretError: only clear local development may run without a good SECRET', () => {
  const good = 'x'.repeat(32);
  // local development: no SECRET needed, BASE_URL unset or on this machine
  for (const env of [{}, { NODE_ENV: 'development' }, { BASE_URL: '' }, { BASE_URL: 'http://127.0.0.1:7000' },
    { BASE_URL: 'http://localhost:7000' }, { BASE_URL: 'http://[::1]:7000' }, { BASE_URL: 'http://127.0.0.1:7000', SECRET: 'short' }]) {
    assert.equal(secretError(env), null, JSON.stringify(env));
  }
  // anywhere else a SECRET of 32+ characters is required
  for (const env of [{ RENDER: 'true' }, { NODE_ENV: 'production' }, { BASE_URL: 'https://subs.example.test' },
    { BASE_URL: 'not a url' }, { BASE_URL: 'http://localhost.example.test' }, { RENDER: 'true', BASE_URL: 'http://127.0.0.1:7000' },
    { NODE_ENV: 'production', BASE_URL: 'http://localhost:7000' }, { RENDER: 'true', SECRET: '' }]) {
    assert.match(secretError(env), /SECRET is not set.*Refusing to start/, JSON.stringify(env));
    assert.match(secretError({ ...env, SECRET: 'x'.repeat(31) }), /SECRET is too short.*32.*Refusing to start/, JSON.stringify(env));
    assert.equal(secretError({ ...env, SECRET: good }), null, JSON.stringify(env));
  }
  assert.doesNotMatch(secretError({ RENDER: 'true', SECRET: 'abc' }), /abc/);
});

const PLACEHOLDERS = ['change-me-to-a-long-random-string', 'dev-only-secret', 'change-me', 'CHANGE-ME-please-' + 'x'.repeat(32), 'x'.repeat(32) + '-change-me'];

test('secretError: known placeholders are refused outside local dev, even when long enough; local dev is unchanged', () => {
  for (const secret of PLACEHOLDERS) {
    for (const env of [{ RENDER: 'true' }, { NODE_ENV: 'production' }, { BASE_URL: 'https://subs.example.test' }]) {
      const msg = secretError({ ...env, SECRET: secret });
      assert.match(msg, /SECRET is a known placeholder.*Refusing to start/, JSON.stringify({ ...env, SECRET: secret }));
      assert.ok(!msg.includes(secret), 'the message must not print the secret');
    }
    assert.equal(secretError({ SECRET: secret }), null, secret);
    assert.equal(secretError({ BASE_URL: 'http://127.0.0.1:7000', SECRET: secret }), null, secret);
  }
  // a real random value that merely resembles nothing on the list is fine
  assert.equal(secretError({ RENDER: 'true', SECRET: 'a1b2c3d4'.repeat(8) }), null);
});

const BAD = [
  [{ RENDER: 'true' }, /SECRET is not set\. .*Refusing to start\./],
  [{ NODE_ENV: 'production' }, /SECRET is not set\. .*Refusing to start\./],
  [{ BASE_URL: 'https://subs.example.test' }, /SECRET is not set\. .*Refusing to start\./], // a host that is not Render
  [{ BASE_URL: 'https://subs.example.test', SECRET: 'short-secret' }, /SECRET is too short.*Refusing to start\./],
  [{ RENDER: 'true', SECRET: 'x'.repeat(31) }, /SECRET is too short.*Refusing to start\./],
  [{ RENDER: 'true', SECRET: 'change-me-to-a-long-random-string' }, /SECRET is a known placeholder.*Refusing to start\./],
  [{ NODE_ENV: 'production', SECRET: 'dev-only-secret' }, /SECRET is a known placeholder.*Refusing to start\./],
  [{ BASE_URL: 'https://subs.example.test', SECRET: 'my-change-me-secret-' + 'x'.repeat(20) }, /SECRET is a known placeholder.*Refusing to start\./],
];
for (const [extra, message] of BAD) {
  test(`server exits 1 for ${JSON.stringify(Object.keys(extra))} ${extra.SECRET ? 'with a bad SECRET' : 'without SECRET'}`, async () => {
    const s = await start(extra);
    const code = await Promise.race([s.exited, new Promise((r) => setTimeout(() => r('still running'), 10000).unref())]);
    if (code === 'still running') s.proc.kill();
    assert.equal(code, 1);
    assert.match(s.logs(), /\[config\] SECRET /);
    assert.match(s.logs(), message);
    assert.doesNotMatch(s.logs(), /Greek Subs addon on/);
    if (extra.SECRET) assert.ok(!s.logs().includes(extra.SECRET));
  });
}

test('local dev (localhost BASE_URL) without SECRET still starts and makes working links', async () => {
  const s = await start({});
  const base = `http://127.0.0.1:${s.port}`;
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try { up = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.ok(up, 'server did not start');
    const j = await (await fetch(`${base}/api/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providers: {}, maxResults: '20' }),
    })).json();
    assert.equal((await fetch(j.manifestUrl)).status, 200);
  } finally {
    s.proc.kill();
  }
});
