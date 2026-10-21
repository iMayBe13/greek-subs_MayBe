// The Stremio subtitles route. Moved out of index.js so tests can drive it with mocked searches; the Greek flow is unchanged.
// AI translation: only when the Greek search finds nothing usable for the title AND (a finished AI file exists
// in the store OR the link has an AI key), the list gets ONE extra entry that points at /ai/<sealed>.srt. When Greek exists and AI
// records are left over, the entry is not listed and the records are deleted. Never throws out of the route: it answers an empty list.
import { seal, open } from './crypto.js';
import { startSearches } from './aggregate.js';
import { usableKeys } from './ai/keys.js';
import { aiState, dropAi, buildAiEntry } from './ai/trigger.js';

export function parseExtra(s = '') {
  const out = {};
  for (const part of s.split('&')) {
    const i = part.indexOf('=');
    if (i > 0) out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

/** Test hooks: start (instead of startSearches), state, drop, entry (instead of aiState, dropAi, buildAiEntry). */
export function createSubtitlesHandler({ baseUrl, start = startSearches, state = aiState, drop = dropAi, entry = buildAiEntry } = {}) {
  return async function subtitlesHandler(req, res) {
    const cfg = open(req.params.token);
    if (!cfg) return res.status(400).json({ subtitles: [] });

    try {
      // decoding can throw (a "%" in a file name): it is inside the try, so the answer is an empty list
      const { type } = req.params;
      const [imdbId, s, e] = decodeURIComponent(req.params.id).split(':');
      const extra = parseExtra(req.params.extra);
      const season = type === 'series' ? Number(s) : undefined;
      const episode = type === 'series' ? Number(e) : undefined;

      const videoHash = /^[0-9a-f]{16}$/i.test(extra.videoHash || '') ? extra.videoHash.toLowerCase() : undefined;
      const videoSize = /^\d+$/.test(extra.videoSize || '') ? extra.videoSize : undefined;
      console.log(
        `[extra] ${imdbId} sent: filename=${!!extra.filename} videoHash=${!!extra.videoHash} ` +
          `videoSize=${!!extra.videoSize} (keys: ${Object.keys(extra).join(',') || 'none'})`,
      );

      const title = { imdbId, season, episode, filename: extra.filename };
      const aiOk = /^tt\d{1,10}$/.test(imdbId) && (type === 'movie' || (Number.isInteger(season) && Number.isInteger(episode)));
      // The English search starts together with the Greek one (only for a link with an AI key); the store check too.
      const searches = start(
        { type, imdbId, season, episode, cfg, filename: extra.filename, videoHash, videoSize },
        { english: aiOk && !!usableKeys(cfg.ai) },
      );
      const stateP = aiOk ? state(title) : Promise.resolve({ final: false, job: null });

      const results = await searches.greek;
      console.log(
        `[top] playing="${(extra.filename || '').slice(0, 80)}" ` +
          (results.slice(0, 5).map((r) =>
            `${r.provider}:${(r._score ?? 0).toFixed(1)}${r.hashMatch ? '(hash)' : ''}:${(r.release || '').slice(0, 50)}`,
          ).join(' | ') || 'none'),
      );
      const subtitles = results.map((r) => {
        // Packs: the file chosen depends on the playing file name, so it travels with the link.
        const f = r.pack ? (extra.filename || '').slice(0, 200) : undefined;
        const dl = seal({ p: r.provider, r: r.ref, s: season, e: episode, f, c: cfg.providers?.[r.provider] || {} });
        return {
          id: `${r.provider}:${r.ref} | ${(r.release || '').slice(0, 80)}`,
          url: `${baseUrl}/dl/${dl}.srt`,
          lang: 'ell',
        };
      });

      if (subtitles.length) {
        // Human Greek subtitles exist: the AI file is not needed any more. Not awaited, so the answer is not delayed.
        if (aiOk) {
          stateP.then((st) => {
            if (!st.final && !st.job) return;
            console.log(`[ai] ${imdbId}${season != null ? `:${season}:${episode}` : ''} Greek subtitles exist: AI records removed`);
            return drop(title);
          }).catch(() => {});
        }
        return res.json({ subtitles });
      }
      if (!aiOk) return res.json({ subtitles });

      const [st, english] = await Promise.all([stateP, searches.english]);
      const built = entry({ title, state: st, english, cfg, baseUrl });
      if (!built) return res.json({ subtitles });
      // A draft entry changes into the final one later, so the list must not be cached while the file is not final.
      return res.json({ subtitles: [built.entry], ...(built.state === 'draft' ? { cacheMaxAge: 0 } : {}) });
    } catch (err) {
      console.error('subtitles error', err);
      return res.json({ subtitles: [] }); // never break the player
    }
  };
}
