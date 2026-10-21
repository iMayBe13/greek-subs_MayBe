// OpenSubtitles.com REST API (NOT the dead opensubtitles.org XML-RPC).
// Docs: https://opensubtitles.stoplight.io/docs/opensubtitles-api
// Quota: 5 downloads/day anonymous, 20/day with a free account. Search is unlimited.
// Each user supplies their own apiKey (+ username/password for the 20/day quota).
import { memGet, memSet } from '../lib/cache.js';
import { markExhausted, scopeOf } from '../lib/health.js';
import { readCapped } from '../lib/limits.js';

export const BASE = 'https://api.opensubtitles.com/api/v1';
export const UA = 'GreekSubsStremio v0.1';

const headers = (cfg, token) => ({
  'Api-Key': cfg.apiKey,
  'User-Agent': UA,
  'Content-Type': 'application/json',
  Accept: 'application/json',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

async function login(cfg) {
  if (!cfg.username || !cfg.password) return null;
  const k = `os-token:${cfg.username}`;
  const hit = memGet(k);
  if (hit) return hit;
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify({ username: cfg.username, password: cfg.password }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  memSet(k, j.token, 20 * 3600 * 1000);
  return j.token;
}

export default {
  id: 'opensubtitles',
  name: 'OpenSubtitles',
  enabled: (cfg) => !!cfg?.apiKey,

  async search({ type, imdbId, season, episode, videoHash, videoSize, cfg, lang = 'el' }) {
    const id = imdbId.replace(/^tt0*/, ''); // API wants the number only
    const p = new URLSearchParams({ languages: lang === 'en' ? 'en' : 'el' });
    if (type === 'series') {
      p.set('parent_imdb_id', id);
      p.set('season_number', season);
      p.set('episode_number', episode);
    } else {
      p.set('imdb_id', id);
    }
    const query = async (params) => {
      // The API prefers alphabetically sorted params
      const qs = new URLSearchParams([...params.entries()].sort(([a], [b]) => a.localeCompare(b)));
      const res = await fetch(`${BASE}/subtitles?${qs}`, { headers: headers(cfg) });
      if (!res.ok) throw new Error(`OpenSubtitles search ${res.status}`);
      return (await res.json()).data || [];
    };

    // moviehash only. moviebytesize is not a REST parameter (it belongs to the old XML-RPC API).
    let data;
    if (videoHash) {
      const hashed = new URLSearchParams(p);
      hashed.set('moviehash', videoHash);
      try {
        data = await query(hashed);
      } catch (err) {
        console.warn(`[opensubtitles] hashed search failed (${err.message}), retrying without moviehash`);
      }
      if (data && !data.length) data = undefined; // hash gave nothing: a plain search must not lose results
    }
    if (!data) data = await query(p);
    return data.flatMap((d) => {
      const a = d.attributes || {};
      const f = a.files?.[0];
      if (!f) return [];
      return [{
        provider: 'opensubtitles',
        ref: String(f.file_id),
        release: a.release || f.file_name || '',
        downloads: a.download_count || 0,
        hashMatch: !!a.moviehash_match,
        ...(a.hearing_impaired ? { hearingImpaired: true } : {}),
      }];
    });
  },

  // Returns a Buffer (raw .srt). Counts against the user's daily quota -> result is cached by caller.
  async download({ ref, cfg }) {
    const token = await login(cfg);
    const res = await fetch(`${BASE}/download`, {
      method: 'POST',
      headers: headers(cfg, token),
      body: JSON.stringify({ file_id: Number(ref), sub_format: 'srt' }),
    });
    // The download response carries { link, remaining, requests, message, reset_time_utc }; a spent quota comes
    // back as an error status (406, sometimes 429) whose body says so. Plain 429 can also be a per-second rate limit.
    const body = await res.json().catch(() => ({}));
    const spent = body.remaining === 0 ||
      ([406, 429].includes(res.status) && /allowed|quota|download limit|downloaded your/i.test(String(body.message || '')));
    if (spent) {
      const reset = Date.parse(body.reset_time_utc);
      const until = reset > Date.now() ? reset : undefined; // else next UTC midnight
      if (markExhausted('opensubtitles', scopeOf(cfg), until)) {
        console.warn('[opensubtitles] daily download limit reached: hiding OpenSubtitles entries until the quota resets');
      }
    }
    if (!res.ok) throw Object.assign(new Error(`OpenSubtitles download ${res.status}${spent ? ' (daily quota)' : ''}`), { quota: spent });
    const { link } = body;
    if (!link) throw new Error('OpenSubtitles download: no link in response');
    const file = await fetch(link);
    if (!file.ok) throw new Error(`OpenSubtitles file ${file.status}`);
    return readCapped(file);
  },
};
