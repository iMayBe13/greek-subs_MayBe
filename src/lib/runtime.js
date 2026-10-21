// Settings that depend on where the server runs: clear local development or hosted, and how many proxies sit in front.
import net from 'node:net';

/** Clear local development: no RENDER, not production, and BASE_URL unset or on this machine. */
export function isLocalDev(env = process.env) {
  if (env.RENDER || env.NODE_ENV === 'production') return false;
  if (!env.BASE_URL) return true;
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(env.BASE_URL).hostname);
  } catch {
    return false;
  }
}

const TRUE = ['1', 'true', 'on', 'yes'];
const FALSE = ['0', 'false', 'off', 'no'];
const flag = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  return TRUE.includes(s) ? true : FALSE.includes(s) ? false : null;
};

/**
 * Whether POST /api/test ("Test my keys") is served. ENABLE_KEY_TEST decides when set to a clear on/off value;
 * otherwise it is on for local development and off everywhere else, because on a hosted server anyone could use it
 * to check OpenSubtitles (and other) credentials from the server's IP.
 */
export function keyTestEnabled(env = process.env) {
  return flag(env.ENABLE_KEY_TEST) ?? isLocalDev(env);
}

const MAX_HOPS = 10;

/**
 * How many proxies in front of the server to trust for the client IP (Express "trust proxy" as a number).
 * TRUST_PROXY_HOPS wins (0 = trust none). Else the older TRUST_PROXY (any value except 0/false/off/no) means 1,
 * and so does running on Render. Else 0. -> { hops, warning }: warning is set when TRUST_PROXY_HOPS was not a usable number.
 */
export function proxyHops(env = process.env) {
  const raw = String(env.TRUST_PROXY_HOPS ?? '').trim();
  let warning = null;
  if (raw) {
    const n = /^\d{1,2}$/.test(raw) ? Number(raw) : -1;
    if (n >= 0 && n <= MAX_HOPS) return { hops: n, warning };
    warning = `TRUST_PROXY_HOPS must be a whole number from 0 to ${MAX_HOPS}; ignoring it`;
  }
  const legacy = String(env.TRUST_PROXY ?? '').trim();
  if (legacy && flag(legacy) !== false) return { hops: 1, warning };
  return { hops: env.RENDER ? 1 : 0, warning };
}

/** TRUST_CF_CONNECTING_IP is set to a clear "on". */
export const trustCfHeader = (env = process.env) => flag(env.TRUST_CF_CONNECTING_IP) === true;

/**
 * -> (req) => the client's IP as a string. Normally Express's req.ip, which follows "trust proxy". With
 * TRUST_CF_CONNECTING_IP set to 1/true, the CF-Connecting-IP header is used when it holds a valid IP, else req.ip.
 * That header can be forged by anyone who reaches the server without passing through Cloudflare, so turn it on only
 * when all traffic comes through Cloudflare.
 */
export function makeClientIp(env = process.env) {
  const useCf = trustCfHeader(env);
  return (req) => {
    if (useCf) {
      const v = req.headers?.['cf-connecting-ip'];
      if (typeof v === 'string' && net.isIP(v.trim())) return v.trim();
    }
    return req.ip || req.socket?.remoteAddress || 'unknown';
  };
}
