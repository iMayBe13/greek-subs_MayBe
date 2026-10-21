// Tiny in-memory fixed-window rate limiter (per key, usually the client IP). No dependency; lost on restart.
// Express middleware: over the limit -> 429 with Retry-After and { error: 'rate_limited', retryAfter } for the page to show.

// `keyOf(req)` names the client (default: Express's req.ip); see makeClientIp in runtime.js for the proxy-aware one.
export function createLimiter({ limit = 20, windowMs = 60 * 1000, now = () => Date.now(), keyOf } = {}) {
  const hits = new Map(); // key -> { start, count }
  let lastSweep = now();

  /** Returns { ok, retryAfter } (seconds) and counts this request. */
  function take(key) {
    const t = now();
    if (t - lastSweep > windowMs) { // drop expired windows so the map cannot grow without bound
      for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
      lastSweep = t;
    }
    let h = hits.get(key);
    if (!h || t - h.start >= windowMs) { h = { start: t, count: 0 }; hits.set(key, h); }
    h.count++;
    if (h.count > limit) return { ok: false, retryAfter: Math.max(1, Math.ceil((h.start + windowMs - t) / 1000)) };
    return { ok: true, retryAfter: 0 };
  }

  const middleware = (req, res, next) => {
    const r = take((keyOf && keyOf(req)) || req.ip || req.socket?.remoteAddress || 'unknown');
    if (r.ok) return next();
    res.set('Retry-After', String(r.retryAfter));
    res.status(429).json({ error: 'rate_limited', retryAfter: r.retryAfter });
  };
  return { take, middleware, size: () => hits.size };
}
