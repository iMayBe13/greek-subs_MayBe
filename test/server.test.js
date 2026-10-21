// Starts the real server on a free port (no network: GreekSubs points at a closed port) and checks the endpoints.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

let proc, base, logs = '';

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['src/index.js'], {
    env: {
      ...process.env, PORT: String(port), BASE_URL: base, SECRET: 'test-secret-for-server-test-0123456789',
      GREEKSUBS_BASE: 'http://127.0.0.1:1', CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'gs-server-test-')),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => { logs += d; });
  proc.stderr.on('data', (d) => { logs += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => proc?.kill());

const post = (p, body, raw) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw ?? JSON.stringify(body) });

test('configure page is served and has the credit, the key buttons and no removed panels', async () => {
  const html = await (await fetch(`${base}/configure`)).text();
  assert.match(html, /class="credit">Made by MayBe</);
  for (const name of ['os_key', 'os_user', 'os_pass', 'subdl_key', 'subsource_key', 'deepl_key', 'gemini_key', 'max']) assert.match(html, new RegExp(`name="${name}"`));
  assert.equal((html.match(/Get your key/g) || []).length, 6); // 5 buttons + the English default text in the dictionary
  // the two AI key fields are password fields, optional, not autocompleted; their buttons open the right pages safely
  for (const name of ['deepl_key', 'gemini_key']) assert.match(html, new RegExp(`<input type="password" name="${name}" autocomplete="off">`));
  for (const url of ['https://www.deepl.com/en/your-account/keys', 'https://aistudio.google.com/apikey']) {
    assert.match(html, new RegExp(`href="${url.replace(/\./g, '\\.')}" target="_blank" rel="noopener noreferrer"`));
  }
  // the Product rule paragraph, the six points and both guides are on the page in both languages
  for (const text of [
    "aiW1: 'It runs only when none of the sources enabled in your link has a Greek subtitle",
    "aiW2: 'The result is labelled AI",
    "aiW3: 'Finished translations are shared with other users of this add-on, and are removed the next time the add-on finds a Greek subtitle",
    "aiW4: 'The first time, you may see a “translation in progress” line or a draft. Pick the subtitle again after a minute for a better version.",
    "aiW5: 'The file is made for one version of the video",
    "aiW6: 'The English subtitles are sent only to the services whose key you entered (DeepL and/or Google)",
    "dlG1: 'Sign up for “DeepL API Free”", "gmG1: 'Sign in to Google AI Studio",
    "aiW1: 'Τρέχει μόνο όταν καμία από τις πηγές που έχεις ενεργοποιήσει στον σύνδεσμό σου δεν έχει ελληνικό υπότιτλο",
    "aiW2: 'Το αποτέλεσμα έχει την ένδειξη AI (στην πρώτη γραμμή του αρχείου και στο όνομα του υπότιτλου στη λίστα)",
    "aiW3: 'Οι ολοκληρωμένες μεταφράσεις μοιράζονται με άλλους χρήστες αυτού του πρόσθετου και διαγράφονται την επόμενη φορά",
    "aiW4: 'Την πρώτη φορά μπορεί να δεις μια γραμμή «μετάφραση σε εξέλιξη» ή ένα πρόχειρο.",
    "aiW5: 'Το αρχείο φτιάχνεται για μία έκδοση του βίντεο",
    "aiW6: 'Οι αγγλικοί υπότιτλοι στέλνονται για μετάφραση μόνο στις υπηρεσίες των οποίων έβαλες κλειδί (DeepL ή/και Google)",
    "dlG1: 'Κάνε εγγραφή στο «DeepL API Free»", "gmG1: 'Συνδέσου στο Google AI Studio",
  ]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /class="side"|class="panel"|class="mock"/);
});

test('a link with every key field empty works: manifest loads and the subtitles route answers without error', async () => {
  const r = await post('/api/config', { providers: { greeksubs: { enabled: true } }, maxResults: '20' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.manifestUrl, /\/manifest\.json$/);
  const m = await (await fetch(j.manifestUrl)).json();
  assert.equal(m.resources[0], 'subtitles');
  assert.match(m.description, /Made by MayBe/);
  const base2 = j.manifestUrl.replace(/\/manifest\.json$/, '');
  for (const p of ['/subtitles/movie/tt0111161.json', '/subtitles/series/tt0364845:23:19.json']) {
    const s = await fetch(base2 + p);
    assert.equal(s.status, 200);
    assert.deepEqual(Object.keys(await s.json()), ['subtitles']);
  }
});

test('/api/test with a wrong key answers per provider (offline: unreachable is fine), never echoes the key', async () => {
  const r = await post('/api/test', { providers: { subsource: { apiKey: 'WRONG-KEY-FOR-TEST' } } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(['bad_key', 'unreachable', 'quota'].includes(j.results.subsource.status));
  assert.ok(!JSON.stringify(j).includes('WRONG-KEY-FOR-TEST'));
  assert.ok(!logs.includes('WRONG-KEY-FOR-TEST'));
  assert.deepEqual((await (await post('/api/test', { providers: {} })).json()).results, {});
});

test('malformed JSON gets a plain 400 and nothing from the body reaches the log', async () => {
  const r = await post('/api/test', null, '{"providers":{"subdl":{"apiKey":"LEAKY-KEY-123"');
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'bad_request' });
  assert.ok(!logs.includes('LEAKY-KEY-123'));
});

// ---- AI translation keys in the link ----
const SERVER_SECRET = 'test-secret-for-server-test-0123456789';
const openToken = async (b) => { process.env.SECRET = SERVER_SECRET; const { open } = await import('../src/lib/crypto.js'); return open((await post('/api/config', b).then((r) => r.json())).token); };

test('/api/config seals optional ai keys (trimmed) into the token; without them the token content is what it was before', async () => {
  const plain = await openToken({ providers: { greeksubs: { enabled: true } }, maxResults: '20' });
  assert.deepEqual(Object.keys(plain).sort(), ['maxResults', 'providers']);
  assert.equal('ai' in plain, false);
  for (const ai of [undefined, null, {}, { deepl: '', gemini: '   ' }, 'x', []]) {
    assert.deepEqual(await openToken({ providers: { greeksubs: { enabled: true } }, maxResults: '20', ai }), plain, JSON.stringify(ai));
  }
  const withAi = await openToken({ providers: { greeksubs: { enabled: true } }, maxResults: '20', ai: { deepl: '  deepl-server-test-key-0123456789:fx ', gemini: 'AIza' + 'ServerTestGeminiKey0123456789' } });
  assert.deepEqual(withAi.ai, { deepl: 'deepl-server-test-key-0123456789:fx', gemini: 'AIza' + 'ServerTestGeminiKey0123456789' });
  assert.deepEqual({ ...withAi, ai: undefined }, { ...plain, ai: undefined });
  const one = await openToken({ providers: {}, ai: { gemini: 'AIza' + 'OnlyGeminiKey0123456789' } });
  assert.deepEqual(one.ai, { gemini: 'AIza' + 'OnlyGeminiKey0123456789' });
});

test('/api/config rejects an ai key that is too long, not a string or not header-safe, without echoing it', async () => {
  for (const [ai, field] of [
    [{ deepl: 'a'.repeat(201) }, 'deepl'],
    [{ gemini: 'has a space in it 12345' }, 'gemini'],
    [{ gemini: 'AIzaLine\r\nX-Evil: 1234567' }, 'gemini'],
    [{ deepl: 12345678901 }, 'deepl'],
    [{ deepl: 'short' }, 'deepl'],
  ]) {
    const r = await post('/api/config', { providers: {}, ai });
    assert.equal(r.status, 400, JSON.stringify(ai).slice(0, 40));
    const j = await r.json();
    assert.deepEqual(j, { error: 'bad_ai_key', field });
  }
  assert.ok(!logs.includes('has a space in it'));
});

test('/ai/ on the real server: a tampered link is a plain 400; a valid link without keys or a cached file gets the status text, not an error', async () => {
  process.env.SECRET = SERVER_SECRET;
  const { seal } = await import('../src/lib/crypto.js');
  const good = seal({ v: 1, imdbId: 'tt0000001', s: 1, e: 1, cands: [] });
  const bad = await fetch(`${base}/ai/${good.slice(0, 30)}${good[30] === 'A' ? 'B' : 'A'}${good.slice(31)}.srt`);
  assert.equal(bad.status, 400);
  assert.equal(await bad.text(), 'bad link');
  assert.equal((await fetch(`${base}/ai/${seal({ p: 'greeksubs', r: '1' })}.srt`)).status, 400, 'a /dl/ link is not an /ai/ link');
  const ok = await fetch(`${base}/ai/${good}.srt`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.match(await ok.text(), /no AI keys/);
});

test('/api/test is rate limited (10 per minute) with a 429 the page can show', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await post('/api/test', { providers: {} });
  assert.equal(last.status, 429);
  const j = await last.json();
  assert.equal(j.error, 'rate_limited');
  assert.ok(j.retryAfter > 0 && j.retryAfter <= 60);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
});

test('/api/config is rate limited (20 per minute)', async () => {
  let last;
  for (let i = 0; i < 22; i++) last = await post('/api/config', { providers: {} });
  assert.equal(last.status, 429);
});
