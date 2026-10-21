// Providers often return .zip (sometimes .rar) archives. Pick the right .srt inside.
import AdmZip from 'adm-zip';
import { parseRelease, tagScore, similarity } from './dedupe.js';
import { LimitError, MAX_DOWNLOAD_BYTES, ZIP_LIMITS } from './limits.js';

const SUB_EXT = /\.(srt|vtt|sub|ass|ssa)$/i;

/** Entry count from the end-of-central-directory record, read before anything is parsed. null when there is no such record. */
function zipEntryCount(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return buf.readUInt16LE(i + 10);
  }
  return null;
}

/**
 * Opens a zip after checking it against `limits` (entry count, declared uncompressed size, compression ratio).
 * Throws LimitError when it is over a limit, and whatever adm-zip throws for a file that is not a zip.
 * The declared sizes are what adm-zip enforces while inflating, so a header that lies cannot inflate more than it says.
 */
function openZip(buf, limits = ZIP_LIMITS) {
  const count = zipEntryCount(buf);
  if (count !== null && count > limits.maxEntries) throw new LimitError(`archive has too many entries (${count}, limit ${limits.maxEntries})`);
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  if (entries.length > limits.maxEntries) throw new LimitError(`archive has too many entries (${entries.length}, limit ${limits.maxEntries})`);
  let total = 0;
  for (const e of entries) {
    const { size, compressedSize } = e.header;
    total += size;
    if (total > limits.maxUncompressed) throw new LimitError(`archive is too large when unpacked (over ${limits.maxUncompressed} bytes)`);
    if (size > limits.ratioFloor && size / Math.max(compressedSize, 1) > limits.maxRatio) {
      throw new LimitError(`archive entry compresses ${Math.round(size / Math.max(compressedSize, 1))}:1 (limit ${limits.maxRatio}:1)`);
    }
  }
  return entries;
}

export function isZip(buf) {
  return buf[0] === 0x50 && buf[1] === 0x4b; // "PK"
}
export function isRar(buf) {
  return buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72; // "Rar"
}

export function epRegexes(season, episode) {
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  return [
    new RegExp(`s0*${season}[ ._-]*e0*${episode}(?!\\d)`, 'i'),
    new RegExp(`(?<!\\d)0*${season}x${e}(?!\\d)`, 'i'),
    new RegExp(`(?<!\\d)${s}${e}(?!\\d)`, 'i'),
  ];
}

const baseName = (n) => n.split(/[\\/]/).pop();

/** Names of the subtitle files inside a zip ([] for anything else, including a zip over the limits). */
export function listArchiveNames(buf, limits) {
  if (!isZip(buf) || buf.length > MAX_DOWNLOAD_BYTES) return [];
  try {
    return openZip(buf, limits).filter((e) => !e.isDirectory && SUB_EXT.test(e.entryName)).map((e) => e.entryName);
  } catch { return []; }
}

/**
 * Best file name for an episode among `names` (null if none matches). When several match
 * (re-uploads with different groups), prefer the one closest to the playing file name.
 */
export function bestEntryName(names, { season, episode, filename } = {}) {
  const res = epRegexes(season, episode);
  const matches = names.filter((n) => res.some((r) => r.test(n)));
  if (matches.length < 2 || !filename) return matches[0] ?? null;
  const want = parseRelease(filename);
  const score = (n) => similarity(filename, baseName(n)) * 40 + tagScore(want, parseRelease(baseName(n)));
  return matches.sort((a, b) => score(b) - score(a))[0];
}

/**
 * Returns { name, data } of the best subtitle file in an archive buffer, or null.
 * Throws LimitError when the buffer or the zip is over the limits (see limits.js); callers treat it like a failed download.
 */
export function pickFromArchive(buf, { season, episode, filename, limits } = {}) {
  if (isRar(buf)) {
    // RAR is not supported (it would need a dependency such as node-unrar-js): skip.
    return null;
  }
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new LimitError(`download too large (${buf.length} bytes, limit ${MAX_DOWNLOAD_BYTES})`);
  if (!isZip(buf)) return { name: 'raw.srt', data: buf };

  const entries = openZip(buf, limits).filter((e) => !e.isDirectory && SUB_EXT.test(e.entryName));
  if (!entries.length) return null;

  let chosen = null;
  if (season != null && episode != null) {
    const name = bestEntryName(entries.map((e) => e.entryName), { season, episode, filename });
    chosen = entries.find((e) => e.entryName === name);
    if (!chosen && entries.length > 1) return null; // season pack without our episode
  }
  chosen = chosen || entries.sort((a, b) => b.header.size - a.header.size)[0];
  return { name: chosen.entryName, data: chosen.getData() };
}
