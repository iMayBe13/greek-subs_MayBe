// SubDL API. Docs: https://subdl.com/api-doc  (free key from your SubDL account)
// Greek files are served in Windows-1253 inside zip archives -> handled by lib/encoding + lib/archive.
// Some series have no season/episode metadata: those results are kept and archive.js picks the file.

import { readCapped } from '../lib/limits.js';

const API = 'https://api.subdl.com/api/v1/subtitles';
const DL = 'https://dl.subdl.com';

export default {
  id: 'subdl',
  name: 'SubDL',
  enabled: (cfg) => !!cfg?.apiKey,

  async search({ type, imdbId, season, episode, cfg, lang = 'el' }) {
    const english = lang === 'en';
    const p = new URLSearchParams({
      api_key: cfg.apiKey,
      imdb_id: imdbId,
      languages: english ? 'EN' : 'EL',
      subs_per_page: '30',
      type: type === 'series' ? 'tv' : 'movie',
    });
    if (type === 'series') {
      p.set('season_number', season);
      p.set('episode_number', episode);
    }
    const res = await fetch(`${API}?${p}`);
    if (!res.ok) throw new Error(`SubDL search ${res.status}`);
    const j = await res.json();
    // Verified live: 'EL' is the code for Greek. Unknown codes (e.g. 'GR') are NOT rejected, they silently
    // return every language, so also filter on the result's own language fields.
    const isGreek = (s) => /^el$/i.test(s.language || '') || /^greek$/i.test(s.lang || '');
    const isEnglish = (s) => /^en$/i.test(s.language || '') || /^english$/i.test(s.lang || '');
    // series: keep only the requested episode when SubDL provides the numbers (unknown -> let the archive picker decide)
    const sameEpisode = (s) => type !== 'series' || s.episode == null ||
      (Number(s.season) === Number(season) && Number(s.episode) === Number(episode));
    return (j.subtitles || []).filter((s) => (english ? isEnglish(s) : isGreek(s)) && sameEpisode(s)).map((s) => ({
      provider: 'subdl',
      // SubDL appends ?api_key=<the user's key> to every url: strip it so the key never reaches ids/logs.
      // Downloads work without it (verified).
      ref: String(s.url || '').split('?')[0], // e.g. /subtitle/123-456.zip
      release: s.release_name || s.name || '',
      downloads: 0,
      ...(s.hi ? { hearingImpaired: true } : {}),
    }));
  },

  async download({ ref }) {
    const res = await fetch(`${DL}${ref}`);
    if (!res.ok) throw new Error(`SubDL file ${res.status}`);
    return readCapped(res);
  },
};
