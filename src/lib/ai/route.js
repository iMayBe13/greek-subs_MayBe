// GET /ai/<sealed>.srt: one stable URL that always answers with the best version ready.
//   1. a finished file in the store -> that file (max-age 86400)
//   2. otherwise start the job, or attach to the one already running for the title, and wait at most 7 s for the DeepL draft
//   3. the draft with the polished chunks merged in (labelled draft or improving), or the status file; both Cache-Control: no-store
// A bad or tampered link gets a plain 400. Everything else answers 200: the route never answers 5xx and never throws.
// The sealed blob holds the AI keys, so nothing from it is logged; log lines come from the job counters only.
import { open, cleanCfg } from '../crypto.js';
import { getAi } from '../cache.js';
import { assembleSrt, finalKey, jobKey } from './pipeline.js';
import { statusSrt } from './status.js';
import { validateAiKeys } from './keys.js';
import { jobs as defaultJobs, titleKey } from './jobs.js';

export const DRAFT_WAIT_MS = 7000; // Stremio's helper hangs up at about 10 s: the whole request (store reads included) is answered by then
export const STORE_WAIT_MS = 1500; // a store read in the route that takes longer counts as a miss
const GUARD_EXTRA_MS = 500; // the hard stop comes this long after the deadline
export const FINAL_MAX_AGE_SEC = 86400;
const SRT_TYPE = 'application/x-subrip; charset=utf-8';

/** The promise's value, or null when it fails or takes longer than `ms`. */
const atMost = (p, ms) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), Math.max(0, ms));
  Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
});

const short = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const int = (v) => (Number.isInteger(v) && v >= 0 && v <= 99999 ? v : null);

/**
 * The decrypted blob of an /ai/ link -> a job spec, or null when it is not one of ours (wrong shape, or a /dl/ blob).
 * Blob: { v:1, imdbId, s?, e?, filename?, cands:[{provider,ref,release,hearingImpaired}], pc:{provider:cfg}, ai:{deepl?,gemini?} }
 */
export function parseAiBlob(b) {
  if (!b || typeof b !== 'object' || b.v !== 1) return null;
  if (typeof b.imdbId !== 'string' || !/^tt\d{1,10}$/.test(b.imdbId)) return null;
  const series = b.s != null || b.e != null;
  const season = series ? int(b.s) : undefined, episode = series ? int(b.e) : undefined;
  if (series && (season == null || episode == null)) return null;
  if (b.cands != null && (!Array.isArray(b.cands) || b.cands.length > 3)) return null;
  const candidates = [];
  for (const c of b.cands || []) {
    if (!c || typeof c.provider !== 'string' || !/^[a-z0-9_]{1,30}$/.test(c.provider)) return null;
    if (!['string', 'number'].includes(typeof c.ref) || String(c.ref).length > 200) return null;
    candidates.push({ provider: c.provider, ref: c.ref, release: short(c.release, 200) || '', hearingImpaired: !!c.hearingImpaired });
  }
  const providerCfgs = {};
  if (b.pc && typeof b.pc === 'object') {
    for (const p of new Set(candidates.map((c) => c.provider))) {
      const cfg = b.pc[p];
      if (cfg && typeof cfg === 'object') providerCfgs[p] = cleanCfg(cfg);
    }
  }
  const k = validateAiKeys(b.ai);
  if (!k.ok) return null;
  return {
    imdbId: b.imdbId, season, episode, type: series ? 'series' : 'movie', filename: short(b.filename, 200),
    candidates, providerCfgs, keys: k.value || {},
  };
}

function parseRecord(text) {
  try {
    const r = JSON.parse(text || 'null');
    return r && r.v === 1 && Array.isArray(r.en) ? r : null;
  } catch { return null; }
}

/** A short client name from the User-Agent, from a fixed list (the header itself is never logged). */
export function clientOf(ua) {
  const s = String(ua ?? '');
  if (!s) return 'none';
  if (/stremio/i.test(s)) return 'stremio';
  if (/mpv/i.test(s)) return 'mpv';
  if (/exoplayer/i.test(s)) return 'exoplayer';
  if (/vlc/i.test(s)) return 'vlc';
  if (/mozilla/i.test(s)) return 'browser';
  return 'other';
}

/** The /ai/ route handler. waitMs is the deadline of a request. Test hooks: jobs, waitMs, storeMs, log. */
export function createAiHandler({ jobs = defaultJobs, waitMs = DRAFT_WAIT_MS, storeMs = STORE_WAIT_MS, log = (m) => console.log(m) } = {}) {
  // What answer() gives back: the file, and the words of the one log line per fetch (answer final | draft | status, and its kind).
  const reply = (srt, answer, kind, { job, why } = {}) => ({ srt, final: answer === 'final', answer, kind, job, why });

  /** The best non-final file from the saved record (a restart, or a job that ended early), or null. Skipped when the deadline is near. */
  async function fromRecord(spec, left) {
    if (left() < 50) return null;
    const rec = parseRecord(await atMost(getAi(jobKey(spec.imdbId, spec.season, spec.episode), { kind: 'json' }), Math.min(storeMs, left())));
    if (!rec || !(rec.draft || Object.keys(rec.polished || {}).length)) return null;
    return assembleSrt(rec, { running: false }).srt || null;
  }
  const endOf = (job) => job?.st?.en?.at(-1)?.[1];

  /** -> reply(). Every wait is counted against `deadline`, so the answer is ready when it passes (a store read that is too slow is a miss). */
  async function answer(spec, deadline) {
    const left = () => deadline - Date.now();
    const done = await atMost(getAi(finalKey(spec.imdbId, spec.season, spec.episode), { kind: 'text' }), Math.min(storeMs, left()));
    if (done) return reply(done, 'final', 'final');

    const got = jobs.ensure(spec);
    if (got.refused) {
      const old = await fromRecord(spec, left);
      if (old) return reply(old, 'draft', 'draft', { why: got.refused });
      return reply(statusSrt(got.refused), 'status', got.refused);
    }
    const { job } = got;
    await jobs.waitFor(job, Math.max(0, left()));

    if (job.state === 'done' && job.result?.srt) return reply(job.result.srt, 'final', 'final', { job });
    if (job.st && (job.st.draft || Object.keys(job.st.polished || {}).length)) {
      const a = assembleSrt(job.st, { running: !job.endedAt });
      return reply(a.srt, 'draft', a.kind, { job });
    }
    if (job.endedAt) {
      const old = await fromRecord(spec, left);
      if (old) return reply(old, 'draft', 'draft', { job });
      const kind = job.reason === 'writes' ? 'writes' : 'failed';
      return reply(statusSrt(kind, { endMs: endOf(job) }), 'status', kind, { job });
    }
    const kind = job.state === 'queued' ? 'queued' : 'running';
    return reply(statusSrt(kind, { pct: jobs.pct(job), endMs: endOf(job) }), 'status', kind, { job });
  }

  return async function aiHandler(req, res) {
    const t0 = Date.now();
    const deadline = t0 + waitMs; // taken first: the whole request, store reads included, answers by then
    const client = clientOf(req.get?.('user-agent'));
    const spec = parseAiBlob(open(String(req.params.blob || '').replace(/\.srt$/, '')));
    if (!spec) {
      log(`[ai] fetch - answer=bad_link ms=${Date.now() - t0} client=${client}`);
      return res.status(400).type('text/plain').send('bad link');
    }
    let out;
    let stop;
    try {
      // last guard: whatever goes wrong inside answer(), the request is answered shortly after the deadline
      const guard = new Promise((resolve) => { stop = setTimeout(() => resolve(reply(statusSrt('error'), 'status', 'error')), waitMs + GUARD_EXTRA_MS); });
      out = await Promise.race([answer(spec, deadline), guard]);
    } catch {
      out = reply(statusSrt('error'), 'status', 'error'); // never a 5xx, and no error text: it could carry a URL
    } finally {
      clearTimeout(stop);
    }
    // one line per fetch, from counters only: never the link, a key or the User-Agent itself
    const { job } = out;
    log(`[ai] fetch ${titleKey(spec)} answer=${out.answer} kind=${out.kind}${out.why ? ` why=${out.why}` : ''} ms=${Date.now() - t0} ` +
      `job_ms=${job ? Date.now() - job.createdAt : 0} chunk=${job?.st ? Object.keys(job.st.polished || {}).length : 0}/${job?.progress?.chunks ?? 0} client=${client}`);
    res.set('Content-Type', SRT_TYPE);
    res.set('Cache-Control', out.final ? `public, max-age=${FINAL_MAX_AGE_SEC}` : 'no-store');
    return res.status(200).send(out.srt);
  };
}
