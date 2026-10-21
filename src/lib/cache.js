// Content cache. Caches *converted subtitle content* and raw provider downloads (not provider links, which
// expire), so repeat plays never cost another download from a rate-limited provider.
//
// All persistence goes through a tiny store interface, so the disk can be replaced later (S3, Redis, a database):
//   store.get(key, { kind, maxAgeMs }) -> Buffer | null
//   store.set(key, buffer, { kind, ttlSec })   ttlSec (optional): expire after that many seconds, for stores that can; the
//                                              disk store ignores it (callers can pass maxAgeMs to get() instead). A store may
//                                              return false when it refused or failed to write.
//   store.del(key, { kind })                   optional. The disk store removes every kind when `kind` is left out.
// `key` is a plain string, `kind` is 'text' | 'bin' | 'json' (a hint: the disk store uses it for the file extension,
// other stores may use it as a prefix or ignore it). Swap it with setStore(). Nothing else touches the filesystem.
//
// There are two slots. The main store (setStore, the disk by default) holds Greek downloads, zips and converted subtitles.
// The AI store (setAiStore; Cloudflare KV when configured, see kv.js) holds AI translations and their progress and is
// reached only through getAi / setAi / delAi. Without setAiStore the AI helpers fall back to the main store.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const EXT = { text: '.srt', bin: '.bin', json: '.json' };

/** Default store: one file per key in CACHE_DIR. Needs a writable (ideally persistent) disk. */
export const diskStore = {
  _file(key, kind) {
    const dir = process.env.CACHE_DIR || './cache';
    return path.join(dir, crypto.createHash('sha1').update(key).digest('hex') + (EXT[kind] || '.bin'));
  },
  async get(key, { kind = 'text', maxAgeMs } = {}) {
    try {
      const f = this._file(key, kind);
      const st = await fs.stat(f);
      if (maxAgeMs && Date.now() - st.mtimeMs > maxAgeMs) return null;
      return await fs.readFile(f);
    } catch { return null; }
  },
  async set(key, buf, { kind = 'text' } = {}) {
    const f = this._file(key, kind);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, buf);
  },
  async del(key, { kind } = {}) {
    let ok = true;
    for (const k of kind ? [kind] : Object.keys(EXT)) {
      try { await fs.unlink(this._file(key, k)); } catch (e) { if (e.code !== 'ENOENT') ok = false; }
    }
    return ok;
  },
};

let store = diskStore;
export const setStore = (s) => { store = s; };

const DAY = 24 * 3600 * 1000;

// ---------- disk cleanup ----------
// get() only checks age when a file is read, so without this nothing would ever leave the disk. sweepDisk() removes
// expired files, then the oldest files until the folder fits `maxBytes`. It touches only files this store wrote
// (<40 hex>.srt|bin|json), so a CACHE_DIR shared with anything else is safe.
// The age limit per extension is the longest any reader of that extension waits (a smaller limit would delete
// something a reader still accepts): .bin 7 days (raw downloads), .srt 120 days (finished AI translations; Greek text is
// only read with 30 days, but shares the extension), .json 180 days (name glossaries). A reader's own maxAgeMs never deletes.
export const SWEEP_MAX_AGE_MS = { '.srt': 120 * DAY, '.bin': 7 * DAY, '.json': 180 * DAY };
const DISK_NAME = /^[0-9a-f]{40}(\.srt|\.bin|\.json)$/;

/** Total disk size cap in bytes from CACHE_MAX_MB (default 500; 0 = no cap). */
export function cacheMaxBytes(env = process.env) {
  const raw = String(env.CACHE_MAX_MB ?? '').trim();
  const mb = raw === '' ? 500 : Number(raw);
  return Number.isFinite(mb) && mb >= 0 ? mb * 1024 * 1024 : 500 * 1024 * 1024;
}

/** -> { expired, evicted, files, bytes } (counts after the sweep). Never throws. */
export async function sweepDisk({ dir = process.env.CACHE_DIR || './cache', maxBytes = cacheMaxBytes(), maxAgeMs = SWEEP_MAX_AGE_MS, now = Date.now() } = {}) {
  const out = { expired: 0, evicted: 0, files: 0, bytes: 0 };
  let names;
  try { names = await fs.readdir(dir); } catch { return out; }
  const kept = [];
  for (const name of names) {
    const m = DISK_NAME.exec(name);
    if (!m) continue;
    const file = path.join(dir, name);
    try {
      const st = await fs.stat(file);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs > maxAgeMs[m[1]]) {
        await fs.unlink(file);
        out.expired++;
      } else {
        kept.push({ file, size: st.size, mtime: st.mtimeMs });
      }
    } catch { /* gone already, or not removable: leave it */ }
  }
  kept.sort((a, b) => a.mtime - b.mtime); // oldest first
  let total = kept.reduce((n, e) => n + e.size, 0);
  let i = 0;
  while (maxBytes > 0 && total > maxBytes && i < kept.length) {
    const e = kept[i++];
    try {
      await fs.unlink(e.file);
      total -= e.size;
      out.evicted++;
    } catch (err) {
      if (err.code === 'ENOENT') total -= e.size;
    }
  }
  out.files = kept.length - out.evicted;
  out.bytes = Math.max(0, total);
  return out;
}

/**
 * Sweeps the disk now (not awaited by the caller if it does not want to wait) and then every `intervalMs`.
 * -> stop(). The timer does not keep the process alive. Overlapping sweeps are skipped. Logs only when it removed something.
 */
export function startCacheCleanup({ intervalMs = 60 * 60 * 1000, sweep = sweepDisk } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await sweep();
      if (r.expired || r.evicted) console.log(`[cache] cleanup: ${r.expired} expired, ${r.evicted} evicted for size; ${r.files} files, ${(r.bytes / 1048576).toFixed(1)} MB left`);
    } catch {
      console.error('[cache] cleanup failed');
    } finally {
      running = false;
    }
  };
  const first = tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return Object.assign(() => clearInterval(timer), { done: first });
}

// Converted subtitle text (UTF-8)
export async function getCached(k, maxAgeMs = 30 * DAY) {
  const b = await store.get(k, { kind: 'text', maxAgeMs });
  return b ? b.toString('utf8') : null;
}
export const setCached = (k, text) => store.set(k, Buffer.from(text, 'utf8'), { kind: 'text' });

// Raw provider downloads (zip season packs etc.) so a pack is fetched once for all its episodes.
export const getCachedBuf = (k, maxAgeMs = 7 * DAY) => store.get(k, { kind: 'bin', maxAgeMs });
export const setCachedBuf = (k, buf) => store.set(k, buf, { kind: 'bin' });

// Small JSON values (e.g. the inner file names of a downloaded pack)
export async function getCachedJson(k, maxAgeMs = 30 * DAY) {
  const b = await store.get(k, { kind: 'json', maxAgeMs });
  try { return b ? JSON.parse(b.toString('utf8')) : null; } catch { return null; }
}
export const setCachedJson = (k, val) => store.set(k, Buffer.from(JSON.stringify(val), 'utf8'), { kind: 'json' });

// ---------- AI results ----------
let aiStore = null;
/** Set the store for AI results (null = fall back to the main store). */
export const setAiStore = (s) => { aiStore = s; };
const aiBackend = () => aiStore || store;

// Small memory layer in front of the AI store: repeat reads cost nothing, and a value written here is readable at once by
// this process (Cloudflare KV can take up to 60 s to show a write elsewhere). Bounded: finished subtitles are ~100 KB each.
const AI_MEM_TTL_MS = 10 * 60 * 1000;
const AI_MEM_MAX = 64;
const aiMem = new Map(); // `${kind}\0${key}` -> { buf, at, exp }
const KINDS = ['text', 'bin', 'json'];
const memKey = (kind, key) => `${kind}\0${key}`;
function aiMemGet(mk, maxAgeMs) {
  const e = aiMem.get(mk);
  if (!e) return null;
  const t = Date.now();
  if (e.exp <= t) { aiMem.delete(mk); return null; }
  if (maxAgeMs && t - e.at > maxAgeMs) return null; // too old for this caller: ask the store
  return e.buf;
}
function aiMemPut(mk, buf) {
  aiMem.delete(mk); // re-insert so the oldest entry is always first
  aiMem.set(mk, { buf, at: Date.now(), exp: Date.now() + AI_MEM_TTL_MS });
  while (aiMem.size > AI_MEM_MAX) aiMem.delete(aiMem.keys().next().value);
}

/** Tests only: empty the memory layer, as a restart does (the store keeps its values). */
export const resetAiMemory = () => aiMem.clear();

/** -> string | null. Never throws. */
export async function getAi(key, { kind = 'text', maxAgeMs } = {}) {
  try {
    const mk = memKey(kind, key);
    const hit = aiMemGet(mk, maxAgeMs);
    if (hit) return hit.toString('utf8');
    const b = await aiBackend().get(key, { kind, maxAgeMs });
    if (!b) return null;
    aiMemPut(mk, b);
    return b.toString('utf8');
  } catch { return null; }
}

/** -> true when the store accepted the value. The value is readable from memory in this process either way. Never throws. */
export async function setAi(key, text, { kind = 'text', ttlSec } = {}) {
  try {
    const buf = Buffer.from(text, 'utf8');
    aiMemPut(memKey(kind, key), buf);
    return (await aiBackend().set(key, buf, { kind, ttlSec })) !== false;
  } catch { return false; }
}

/** Removes the value from memory and from the store. `kind` left out = every kind. -> true when the store confirmed. Never throws. */
export async function delAi(key, { kind } = {}) {
  for (const k of kind ? [kind] : KINDS) aiMem.delete(memKey(k, key));
  try {
    const b = aiBackend();
    return typeof b.del === 'function' ? (await b.del(key, { kind })) !== false : false;
  } catch { return false; }
}

// Short-lived in-memory cache for search results (provider lists). Per process, lost on restart.
const mem = new Map();
export function memGet(k) {
  const v = mem.get(k);
  if (!v || v.exp < Date.now()) { mem.delete(k); return null; }
  return v.val;
}
export function memSet(k, val, ttlMs = 10 * 60 * 1000) {
  mem.set(k, { val, exp: Date.now() + ttlMs });
  if (mem.size > 2000) mem.delete(mem.keys().next().value);
}
