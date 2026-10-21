// Encrypts a user's config (API keys etc.) into a URL-safe token, so keys are not
// readable in the install URL. AES-256-GCM, key derived from SECRET.
import crypto from 'node:crypto';
import { isLocalDev } from './runtime.js';

const MIN_SECRET = 32;

/** Values that were or are published (old .env.example, the dev fallback below) or say "change me": never a real secret. */
const isPlaceholder = (secret) => {
  const s = secret.toLowerCase();
  return s === 'dev-only-secret' || s.includes('change-me');
};

/** Why the server must not start, or null. Only clear local development may run without a SECRET (or with a short or placeholder one). */
export function secretError(env = process.env) {
  if (isLocalDev(env)) return null;
  if (!env.SECRET) {
    return 'SECRET is not set. It encrypts every install link: set a long random value (see .env.example). Refusing to start.';
  }
  if (isPlaceholder(env.SECRET)) {
    return 'SECRET is a known placeholder, so anyone could decrypt install links: set a long random value (see .env.example). Refusing to start.';
  }
  if (env.SECRET.length < MIN_SECRET) {
    return `SECRET is too short: it must be at least ${MIN_SECRET} characters (see .env.example). Refusing to start.`;
  }
  return null;
}

const problem = secretError();
if (problem) {
  console.error(`[config] ${problem}`);
  process.exit(1);
}

// Clear local development only (see isLocalDev): a fixed fallback so the server runs without a .env.
const key = () => crypto.createHash('sha256').update(process.env.SECRET || 'dev-only-secret').digest();

export function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url');
}

/** A provider config as it may go into a link: string and boolean values only. */
export const cleanCfg = (cfg) => Object.fromEntries(Object.entries(cfg || {}).filter(([, v]) => ['string', 'boolean'].includes(typeof v)));

export function open(token) {
  try {
    const buf = Buffer.from(token, 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    const dec = Buffer.concat([d.update(buf.subarray(28)), d.final()]);
    return JSON.parse(dec.toString('utf8'));
  } catch {
    return null;
  }
}
