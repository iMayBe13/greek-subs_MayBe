// Polite fetch for scraped sites: one request at a time per host, a small gap between them,
// a realistic browser User-Agent and a hard timeout. Callers may enqueue several at once; they run in order.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const tails = new Map(); // host -> promise of the last queued request
const lastEnd = new Map(); // host -> time the last request finished

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function politeFetch(url, { minGapMs = 600, timeoutMs = 5000, headers = {}, ...opts } = {}) {
  const host = new URL(url).host;
  const run = (tails.get(host) || Promise.resolve()).then(async () => {
    const wait = (lastEnd.get(host) || 0) + minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    } finally {
      lastEnd.set(host, Date.now());
    }
  });
  tails.set(host, run.catch(() => {})); // a failure must not block the queue
  return run;
}
