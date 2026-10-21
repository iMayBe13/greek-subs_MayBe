// Old install links: the configure page once sent `subs4free: { enabled }` (checkbox removed, the source is skipped on purpose).
// Such a link must keep answering exactly like a new one. Real server; GreekSubs is a local fake serving the saved movie sample.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const SECRET = 'test-secret-for-old-link-test-0123456789';
process.env.SECRET = SECRET; // seal/open in this process must match the server
const { seal, open } = await import('../src/lib/crypto.js');

const sample = fs.readFileSync(new URL('./fixtures/greeksubs/movie-tt0111161.html', import.meta.url));
let proc, fakeSite, base;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

before(async () => {
  fakeSite = http.createServer((req, res) => {
    if (req.url === '/en/view/tt0111161') return res.writeHead(200, { 'Content-Type': 'text/html' }).end(sample);
    res.writeHead(404).end();
  });
  await new Promise((r) => fakeSite.listen(0, '127.0.0.1', r));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['src/index.js'], {
    env: {
      ...process.env, PORT: String(port), BASE_URL: base, SECRET,
      GREEKSUBS_BASE: `http://127.0.0.1:${fakeSite.address().port}`,
      CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'gs-old-link-test-')),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { proc?.kill(); fakeSite?.close(); });

const subtitlesOf = async (token) => {
  const r = await fetch(`${base}/${token}/subtitles/movie/tt0111161.json`);
  assert.equal(r.status, 200);
  return (await r.json()).subtitles;
};

test('an old link with the subs4free flag (on or off) returns the same subtitles as a new link', async () => {
  const fresh = seal({ maxResults: 20, providers: { greeksubs: { enabled: true } } });
  const oldOn = seal({ maxResults: 20, providers: { greeksubs: { enabled: true }, subs4free: { enabled: true } } });
  const oldOff = seal({ maxResults: 20, providers: { greeksubs: { enabled: true }, subs4free: { enabled: false } } });

  const want = await subtitlesOf(fresh);
  assert.equal(want.length, 4); // the four Greek rows of the sample page
  assert.ok(want.every((s) => s.lang === 'ell' && s.id.startsWith('greeksubs:') && s.url.startsWith(`${base}/dl/`)));
  for (const token of [oldOn, oldOff]) {
    assert.equal((await (await fetch(`${base}/${token}/manifest.json`)).json()).resources[0], 'subtitles');
    assert.deepEqual((await subtitlesOf(token)).map((s) => s.id), want.map((s) => s.id));
  }
});

test('new links no longer carry subs4free, and /api/providers does not list it', async () => {
  const ids = (await (await fetch(`${base}/api/providers`)).json()).map((p) => p.id);
  assert.ok(ids.includes('greeksubs'));
  assert.ok(!ids.includes('subs4free'));
  const r = await fetch(`${base}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providers: { greeksubs: { enabled: true }, subs4free: { enabled: true } }, maxResults: '20' }),
  });
  const cfg = open((await r.json()).token);
  assert.deepEqual(cfg.providers, { greeksubs: { enabled: true } });
});
