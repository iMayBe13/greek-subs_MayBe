import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { seal, open, cleanCfg } from './lib/crypto.js';
import { byId, providers } from './providers/index.js';
import { pickFromArchive, isRar } from './lib/archive.js';
import { markFailed } from './lib/health.js';
import { normalize } from './lib/dedupe.js';
import { toUtf8, looksGreek, fixOldAccents, stripAssTags } from './lib/encoding.js';
import { getCached, setCached, setAiStore, startCacheCleanup } from './lib/cache.js';
import { kvStore, kvConfigured } from './lib/kv.js';
import { createLimiter } from './lib/ratelimit.js';
import { keyTestEnabled, proxyHops, trustCfHeader, makeClientIp } from './lib/runtime.js';
import { testKeys } from './lib/keytest.js';
import { createSubtitlesHandler } from './lib/subtitles.js';
import { createAiHandler } from './lib/ai/route.js';
import { validateAiKeys } from './lib/ai/keys.js';
import { redactReason } from './lib/ai/http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 7000;
// BASE_URL wins; on Render fall back to the service's own public URL; locally use 127.0.0.1.
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');

const RAR_TTL_MS = 24 * 3600 * 1000; // waiting does not make a RAR openable; retry after a day (a deploy may add support)

const app = express();

// A rejected promise nobody awaited must not end the process. Only the error name is logged: a message could quote a URL or a key.
process.on('unhandledRejection', (e) => console.error(`[unhandled] rejection ${e?.name || 'error'}`));

// AI results go to Cloudflare KV when all three CLOUDFLARE_* variables are set, otherwise to the disk store.
if (kvConfigured()) setAiStore(kvStore);
console.log(`[kv] AI store: ${kvConfigured() ? 'Cloudflare KV' : 'disk (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_KV_NAMESPACE_ID and CLOUDFLARE_API_TOKEN not all set)'}`);

// Health check for the host (Render): instant, no side effects, no auth, no provider or disk access.
app.get('/health', (_req, res) => res.status(200).type('text/plain').send('ok'));

// Behind a proxy every visitor would share the proxy's IP, which would make the rate limits global. TRUST_PROXY_HOPS says how
// many proxies to trust (Render alone: 1; Render behind Cloudflare: 2; see the README). CF-Connecting-IP only when TRUST_CF_CONNECTING_IP is set.
const proxy = proxyHops();
if (proxy.warning) console.warn(`[config] ${proxy.warning}`);
app.set('trust proxy', proxy.hops || false);
const clientIp = makeClientIp();
console.log(`[proxy] trusting ${proxy.hops} proxy hop(s) for the client IP; CF-Connecting-IP header: ${trustCfHeader() ? 'trusted' : 'ignored'}`);

app.use(express.json({ limit: '50kb' }));
// A malformed body must not reach the default error handler: its message can quote part of the body (a key).
app.use((err, _req, res, next) => {
  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    return res.status(err.status || 400).json({ error: 'bad_request' });
  }
  next(err);
});
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  next();
});

// ---------- configure page + token creation ----------
const page = (_req, res) => res.sendFile(path.join(here, '..', 'public', 'configure.html'));
app.get('/', (_req, res) => res.redirect('/configure'));
app.get('/configure', page);
app.get('/:token/configure', page);

app.get('/api/providers', (_req, res) =>
  res.json(providers.map((p) => ({ id: p.id, name: p.name }))));

const configLimiter = createLimiter({ limit: 20, windowMs: 60 * 1000, keyOf: clientIp });
const testLimiter = createLimiter({ limit: 10, windowMs: 60 * 1000, keyOf: clientIp }); // each test calls the providers' APIs

// "Test my keys" can check credentials from this server's IP, so it is served only when ENABLE_KEY_TEST says so
// (default: local development only). The page asks /api/features and hides its button when it is off.
const KEY_TEST = keyTestEnabled();
console.log(`[config] key test endpoint (/api/test): ${KEY_TEST ? 'on' : 'off'}`);
app.get('/api/features', (_req, res) => res.json({ keyTest: KEY_TEST }));

// Keys arrive in the body, are used for one free call each and are never stored or logged.
app.post('/api/test', (req, res, next) => (KEY_TEST ? next() : res.status(404).json({ error: 'disabled' })), testLimiter.middleware, async (req, res) => {
  try {
    const results = await testKeys(req.body?.providers);
    console.log(`[test] ${Object.entries(results).map(([id, r]) => `${id}=${r.status}`).join(' ') || 'no keys'}`);
    res.json({ results });
  } catch {
    res.status(500).json({ error: 'test_failed' }); // no error text: it could contain a key
  }
});

app.post('/api/config', configLimiter.middleware, (req, res) => {
  const b = req.body || {};
  const clean = {
    maxResults: Math.min(Math.max(parseInt(b.maxResults, 10) || 20, 1), 40),
    providers: {},
  };
  for (const p of providers) {
    const c = b.providers?.[p.id];
    if (c && typeof c === 'object') clean.providers[p.id] = cleanCfg(c);
  }
  // Optional AI translation keys (the user's own). A link without them is exactly what it was before.
  const ai = validateAiKeys(b.ai);
  if (!ai.ok) return res.status(400).json({ error: 'bad_ai_key', field: ai.field }); // never echoes the key
  if (ai.value) clean.ai = ai.value;
  const token = seal(clean);
  const host = BASE_URL.replace(/^https?:\/\//, '');
  res.json({
    token,
    manifestUrl: `${BASE_URL}/${token}/manifest.json`,
    stremioUrl: `stremio://${host}/${token}/manifest.json`,
  });
});

// ---------- Stremio addon protocol ----------
app.get('/:token/manifest.json', (req, res) => {
  if (!open(req.params.token)) return res.status(400).json({ err: 'invalid config token' });
  res.json({
    id: 'community.greek-subs-aggregator',
    version: '0.1.0',
    name: 'Greek Subs',
    description: 'Greek subtitles aggregated from multiple sources, de-duplicated and ranked. Works with no keys; add your own keys for more sources. Made by MayBe.',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: false },
  });
});

const subtitlesHandler = createSubtitlesHandler({ baseUrl: BASE_URL });
app.get('/:token/subtitles/:type/:id.json', subtitlesHandler);
app.get('/:token/subtitles/:type/:id/:extra.json', subtitlesHandler);

// ---------- AI translation: the stable URL listed in the subtitles answer (see src/lib/ai/route.js) ----------
app.get('/ai/:blob', createAiHandler());

// ---------- download proxy: fetch -> unzip -> pick episode -> UTF-8 -> cache ----------
app.get('/dl/:blob', async (req, res) => {
  const t0 = Date.now();
  const d = open(req.params.blob.replace(/\.srt$/, ''));
  const provider = d && byId[d.p];
  // One log line per request. Provider id and a short reason only: never keys, tokens or URLs.
  const done = (status, outcome, { bytes = 0, reason = '' } = {}, body) => {
    const why = redactReason(reason);
    console.log(`[dl] provider=${provider ? d.p : '-'} outcome=${outcome} bytes=${bytes} ms=${Date.now() - t0}${why ? ` reason="${why}"` : ''}`);
    return body === undefined ? res.status(status).send(outcome) : res.send(body);
  };
  if (!provider) return done(400, 'bad link', { reason: 'unknown or invalid link' });

  const cacheKey = `${d.p}:${d.r}:${d.s ?? ''}:${d.e ?? ''}${d.f ? ':' + normalize(d.f) : ''}`;
  try {
    let text = await getCached(cacheKey);
    const cached = !!text;
    let note = '';
    if (text) text = stripAssTags(fixOldAccents(text)); // idempotent; also repairs files cached before these fixes
    if (!text) {
      const raw = await provider.download({ ref: d.r, cfg: d.c });
      if (isRar(raw)) {
        markFailed(d.p, d.r, RAR_TTL_MS); // we cannot open RAR yet: stop listing it
        return done(404, 'no file in archive', { reason: 'rar not supported' });
      }
      const picked = pickFromArchive(raw, { season: d.s, episode: d.e, filename: d.f });
      if (!picked) return done(404, 'no file in archive', { reason: 'no matching subtitle file' });
      text = stripAssTags(fixOldAccents(toUtf8(picked.data).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')));
      if (!looksGreek(text)) note = 'does not look Greek';
      await setCached(cacheKey, text);
    }
    res.set('Content-Type', 'application/x-subrip; charset=utf-8');
    return done(200, cached ? 'cache' : 'ok', { bytes: Buffer.byteLength(text), reason: note }, text);
  } catch (err) {
    if (!err.quota) markFailed(d.p, d.r); // a spent quota hides the whole provider instead (see health.js)
    return done(502, 'failed', { reason: err.message });
  }
});

startCacheCleanup(); // expired files and the size cap (disk store); first sweep now, then hourly

app.listen(PORT, () => console.log(`Greek Subs addon on ${BASE_URL}  (configure: ${BASE_URL}/configure)`));
