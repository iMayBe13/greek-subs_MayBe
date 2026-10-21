// The list side of the AI translation: when does the subtitles list get an AI entry, and what is in its link.
//   aiState(title)       -> { final, job }   what the store has for the title; never throws
//   dropAi(title)        removes the AI records once human Greek subtitles exist (best effort; the glossary stays)
//   buildAiEntry(opts)   -> the one Stremio entry, or null
// The entry URL is /ai/<sealed>.srt. The sealed blob is encrypted like /dl/ and holds the AI keys, so it must never be logged.
import { seal, cleanCfg } from '../crypto.js';
import { getAi, delAi } from '../cache.js';
import { finalKey, jobKey } from './pipeline.js';
import { aiEntryId, AI_ENTRY_LABEL } from './label.js';
import { usableKeys } from './keys.js';

/** -> { final: boolean, job: the saved job record | null }. Reads go to the memory layer first, so repeat lists cost nothing. */
export async function aiState({ imdbId, season, episode }) {
  try {
    const [fin, job] = await Promise.all([
      getAi(finalKey(imdbId, season, episode), { kind: 'text' }),
      getAi(jobKey(imdbId, season, episode), { kind: 'json' }),
    ]);
    let rec = null;
    try { rec = JSON.parse(job || 'null'); } catch { /* unreadable record: ignore it */ }
    return { final: !!fin, job: rec && typeof rec === 'object' ? rec : null };
  } catch { return { final: false, job: null }; }
}

/** Deletes the final file and the job record (both count as store writes). Best effort, never throws. */
export async function dropAi({ imdbId, season, episode }) {
  try {
    await Promise.allSettled([
      delAi(finalKey(imdbId, season, episode), { kind: 'text' }),
      delAi(jobKey(imdbId, season, episode), { kind: 'json' }),
    ]);
  } catch { /* nothing to do */ }
}

/**
 * title: { imdbId, season, episode, filename }; state: from aiState; english: ranked candidates from findEnglish (may be empty);
 * cfg: the user's config (provider keys for the English download, ai keys).
 * A final file exists (anyone may see it), or the link has an AI key and there is something to translate: an English candidate or
 * a saved job. -> { entry, state } where state is 'final' or 'draft', or null.
 */
export function buildAiEntry({ title, state, english = [], cfg, baseUrl }) {
  const keys = usableKeys(cfg?.ai);
  const cands = english.slice(0, 3).map((c) => ({
    provider: c.provider, ref: c.ref, release: String(c.release || '').slice(0, 200), hearingImpaired: !!c.hearingImpaired,
  }));
  if (!state.final && !(keys && (cands.length || state.job))) return null;

  const pc = {};
  for (const c of cands) if (cfg?.providers?.[c.provider]) pc[c.provider] = cleanCfg(cfg.providers[c.provider]);
  const blob = seal({
    v: 1, imdbId: title.imdbId, s: title.season, e: title.episode, filename: (title.filename || '').slice(0, 200) || undefined,
    cands, pc, ai: keys || undefined,
  });
  const kind = state.final ? 'final' : 'draft';
  const release = cands[0]?.release || state.job?.release || '';
  return {
    state: kind,
    entry: {
      id: aiEntryId({ imdbId: title.imdbId, season: title.season, episode: title.episode, state: kind, release }),
      url: `${baseUrl}/ai/${blob}.srt`,
      lang: 'ell',
      label: AI_ENTRY_LABEL,
    },
  };
}
