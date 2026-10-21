// Cloudflare Workers KV over the REST API, as a store for cache.js (setAiStore). Global fetch, no dependency.
//   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_KV_NAMESPACE_ID, CLOUDFLARE_API_TOKEN (token permission: Workers KV Storage, write)
//
//   get(key, { maxAgeMs })  -> Buffer | null     null = miss, expired, not configured or any failure
//   set(key, buf, { ttlSec }) -> Promise<boolean> true only when Cloudflare accepted the write
//   del(key)                -> Promise<boolean>   true when the key is gone (a 404 counts)
//
// What a live round trip against the API showed: PUT with a raw application/octet-stream body and
// ?expiration_ttl=N, GET returns the raw bytes, DELETE, a GET after the delete is 404, and key names with colons and
// encoded characters work. Nothing here ever throws into a caller, and nothing here logs a URL, a token or a response body.
//
// Free-plan limits it is built around: 1,000 writes a day (we refuse our own writes at 850, jobs.js stops starting jobs at 700), 1 write per
// second to the same key (we keep writes to one key at least 2 s apart, newest value wins), values up to 25 MiB, key names
// up to 512 bytes, expiration_ttl at least 60 s.
import crypto from 'node:crypto';
import { parseRetryAfter } from './ai/http.js';

const API = 'https://api.cloudflare.com/client/v4';
export const KV_TIMEOUT_MS = 5000;
export const DAILY_WRITE_CAP = 850;
export const MIN_WRITE_GAP_MS = 2000;
export const MIN_TTL_SEC = 60;
export const MAX_KEY_BYTES = 512;
export const MAX_VALUE_BYTES = 25 * 1024 * 1024;
const PREFIX_BYTES = 8; // every stored value starts with its write time (ms since epoch, 64-bit big endian)
const ID_OK = /^[A-Za-z0-9_-]{1,64}$/; // account and namespace ids go into the URL: only plain ids are accepted
const DAY_MS = 24 * 3600 * 1000;

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

/** The key name used in KV: the key itself, or `sha1:<hex>` when it is empty, "." / "..", or longer than 512 bytes. */
export function keyName(key) {
  const name = String(key);
  if (!name || name === '.' || name === '..' || Buffer.byteLength(name, 'utf8') > MAX_KEY_BYTES) return `sha1:${sha1(name)}`;
  return name;
}

export const PAUSE_MS = 5 * 60 * 1000; // after a 429 that is not the daily limit (per-key or per-5-minute API limits)

const stamp = (ms) => { const b = Buffer.alloc(PREFIX_BYTES); b.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(ms)))); return b; };

/** True when all three variables are set (non-empty). */
export const kvConfigured = (env = process.env) =>
  ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_KV_NAMESPACE_ID', 'CLOUDFLARE_API_TOKEN'].every((n) => String(env[n] ?? '').trim() !== '');

/**
 * Options are for tests: fetchImpl, now, timeoutMs, minWriteGapMs, maxWritesPerDay, and explicit accountId / namespaceId /
 * apiToken (otherwise the environment is read at every call).
 */
export function createKvStore({
  env = process.env, accountId, namespaceId, apiToken,
  fetchImpl = (...a) => fetch(...a),
  timeoutMs = KV_TIMEOUT_MS, now = () => Date.now(),
  maxWritesPerDay = DAILY_WRITE_CAP, minWriteGapMs = MIN_WRITE_GAP_MS,
} = {}) {
  const config = () => {
    const acct = String(accountId ?? env.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
    const ns = String(namespaceId ?? env.CLOUDFLARE_KV_NAMESPACE_ID ?? '').trim();
    const token = String(apiToken ?? env.CLOUDFLARE_API_TOKEN ?? '').trim();
    return ID_OK.test(acct) && ID_OK.test(ns) && token ? { acct, ns, token } : null;
  };

  // ---------- logging: one short line per kind of failure per minute; only the operation and the status ----------
  const lastNote = new Map();
  function note(op, what) {
    const k = `${op}:${what}`, t = now();
    if (t - (lastNote.get(k) ?? -Infinity) < 60000) return;
    lastNote.set(k, t);
    console.warn(`[kv] ${op} failed: ${what}`);
  }
  const describe = (r) => {
    if (r.status === -1) return 'not configured';
    if (r.status === 0) return r.error;
    if (r.status === 401 || r.status === 403) return `HTTP ${r.status} (check the token and its Workers KV Storage permission)`;
    return `HTTP ${r.status}`;
  };

  // ---------- one HTTP call; never throws ----------
  async function request(method, name, { body, query } = {}) {
    const c = config();
    if (!c) return { status: -1 };
    const url = `${API}/accounts/${c.acct}/storage/kv/namespaces/${c.ns}/values/${encodeURIComponent(name)}${query ? `?${query}` : ''}`;
    try {
      const res = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${c.token}`, ...(body ? { 'Content-Type': 'application/octet-stream' } : {}) },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const buf = Buffer.from(await res.arrayBuffer()); // also frees the connection for error bodies
      return { status: res.status, buf, retryAfterMs: parseRetryAfter(res.headers, now()) ?? 0 };
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      return { status: 0, error: timedOut ? 'timeout' : `network ${String(e?.cause?.code ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 30)}`.trim() };
    }
  }

  // ---------- daily write budget (puts and deletes both count) ----------
  let day = Math.floor(now() / DAY_MS), writesToday = 0, capLogged = false;
  function rollDay() {
    const d = Math.floor(now() / DAY_MS);
    if (d !== day) { day = d; writesToday = 0; capLogged = false; }
  }

  // An error body that names the daily write limit: stop writing until 00:00 UTC. This also re-learns the real state after a restart,
  // because the counter above starts at zero in a new process.
  const dailyLimit = (r) => r.status >= 400 && /daily.{0,20}limit|write limit/i.test(r.buf ? r.buf.toString('utf8', 0, 2000) : '');
  // Any other 429 is a short limit (1 write per second per key, 1,200 API requests per 5 minutes): pause writes for 5 minutes
  // (longer when Retry-After says so), then allow them again. One log line per pause.
  let pausedUntil = 0, pauseLogged = false;
  function pauseWrites(r) {
    pausedUntil = now() + Math.max(PAUSE_MS, r.retryAfterMs || 0);
    if (!pauseLogged) { pauseLogged = true; console.warn(`[kv] Cloudflare answered 429: writes to the AI store are paused for ${Math.round((pausedUntil - now()) / 60000)} min`); }
  }
  function useUpToday() {
    writesToday = maxWritesPerDay;
    if (!capLogged) { capLogged = true; console.warn('[kv] Cloudflare says the daily write limit is reached: writes to the AI store are treated as used up until 00:00 UTC'); }
  }

  async function perform(op) {
    if (!config()) { note(op.type === 'PUT' ? 'set' : 'del', 'not configured'); return false; }
    rollDay();
    if (now() < pausedUntil) return false; // paused after a 429
    pauseLogged = false;
    if (writesToday >= maxWritesPerDay) {
      if (!capLogged) { capLogged = true; console.warn(`[kv] daily write cap reached (${maxWritesPerDay}): writes to the AI store are refused until 00:00 UTC`); }
      return false;
    }
    writesToday++;
    if (op.type === 'PUT') {
      const r = await request('PUT', op.name, { body: Buffer.concat([stamp(now()), op.payload]), query: op.query });
      if (r.status === 200) return true;
      if (dailyLimit(r)) { useUpToday(); return false; }
      if (r.status === 429) { pauseWrites(r); return false; }
      note('set', describe(r));
      return false;
    }
    const r = await request('DELETE', op.name);
    if (r.status === 200 || r.status === 404) return true;
    if (dailyLimit(r)) { useUpToday(); return false; }
    if (r.status === 429) { pauseWrites(r); return false; }
    note('del', describe(r));
    return false;
  }

  // ---------- spacing: writes to one key at least minWriteGapMs apart; while waiting, the newest operation replaces the older ----------
  const lastAt = new Map(); // key name -> start of its last write
  const pending = new Map(); // key name -> { op, waiters, timer }
  function schedule(name, op) {
    return new Promise((resolve) => {
      const p = pending.get(name);
      if (p) { p.op = op; p.waiters.push(resolve); return; }
      const wait = (lastAt.get(name) ?? -Infinity) + minWriteGapMs - now();
      if (wait <= 0) {
        lastAt.set(name, now());
        if (lastAt.size > 2000) for (const [k, t] of lastAt) if (now() - t > minWriteGapMs) lastAt.delete(k);
        perform(op).then(resolve, () => resolve(false));
        return;
      }
      pending.set(name, { op, waiters: [resolve], timer: setTimeout(() => flushOne(name), wait) });
    });
  }
  async function flushOne(name) {
    const p = pending.get(name);
    if (!p) return;
    pending.delete(name);
    clearTimeout(p.timer);
    lastAt.set(name, now());
    let ok = false;
    try { ok = await perform(p.op); } catch { /* ok stays false */ }
    for (const w of p.waiters) w(ok);
  }

  return {
    async get(key, { maxAgeMs } = {}) {
      try {
        const r = await request('GET', keyName(key));
        if (r.status === 404) return null; // a plain miss
        if (r.status !== 200) { note('get', describe(r)); return null; }
        if (!r.buf || r.buf.length < PREFIX_BYTES) return null; // not written by us
        const written = Number(r.buf.readBigUInt64BE(0));
        if (maxAgeMs && now() - written > maxAgeMs) return null;
        return Buffer.from(r.buf.subarray(PREFIX_BYTES));
      } catch { return null; }
    },

    /** ttlSec: expiration_ttl, raised to the 60 s Cloudflare minimum. Resolves when the (possibly delayed) write has been tried. */
    async set(key, buf, { ttlSec } = {}) {
      try {
        const payload = Buffer.from(buf);
        if (payload.length + PREFIX_BYTES > MAX_VALUE_BYTES) { note('set', 'value larger than 25 MiB'); return false; }
        const query = ttlSec == null ? '' : `expiration_ttl=${Math.max(MIN_TTL_SEC, Math.ceil(Number(ttlSec)) || MIN_TTL_SEC)}`;
        return await schedule(keyName(key), { type: 'PUT', name: keyName(key), payload, query });
      } catch { return false; }
    },

    async del(key) {
      try { return await schedule(keyName(key), { type: 'DELETE', name: keyName(key) }); } catch { return false; }
    },

    /** Run every delayed write now (shutdown, tests). */
    async flush() { await Promise.all([...pending.keys()].map(flushOne)); },

    stats() { rollDay(); return { writesToday, cap: maxWritesPerDay, capReached: writesToday >= maxWritesPerDay, pending: pending.size }; },
  };
}

/** The store used for AI results; reads the environment at every call. */
export const kvStore = createKvStore();
