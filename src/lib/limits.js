// Size limits for what we download and unpack from the subtitle sources. A source (or whoever sits between us and it)
// must not be able to make the server read or inflate an unbounded amount. Messages carry numbers only: no URLs, no keys.
const MB = 1024 * 1024;

/** A download or archive went over a limit. `code` lets callers tell it from a network error. */
export class LimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LimitError';
    this.code = 'limit';
  }
}

/** Largest download we accept (a zip or a plain subtitle). Season packs of subtitles are a few MB at most. */
export const MAX_DOWNLOAD_BYTES = 15 * MB;

/** Zip limits. `maxRatio` only applies to entries over `ratioFloor` bytes: a small file of repeated text may compress a lot. */
export const ZIP_LIMITS = {
  maxEntries: 1000,
  maxUncompressed: 50 * MB, // all entries together, as declared by the archive
  maxRatio: 100, // uncompressed size / compressed size of one entry
  ratioFloor: 1 * MB,
};

/**
 * Reads a fetch Response body into a Buffer, giving up as soon as it is over `max` bytes (Content-Length when sent,
 * otherwise the bytes actually received), so an oversized or endless body is never held in memory. Throws LimitError.
 */
export async function readCapped(res, max = MAX_DOWNLOAD_BYTES) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (declared > max) {
    res.body?.cancel?.().catch(() => {});
    throw new LimitError(`download too large (${declared} bytes, limit ${max})`);
  }
  if (!res.body?.getReader) { // not a streaming body: read it whole, then check
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) throw new LimitError(`download too large (${buf.length} bytes, limit ${max})`);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      reader.cancel().catch(() => {});
      throw new LimitError(`download too large (over ${max} bytes)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}
