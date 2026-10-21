// Labelling of AI translations: every AI-translated file says so in its first cue, and its list entry id carries "AI".
//   1. A first cue at the very start of the file says, in Greek and English, that it is an AI translation. It ends before the
//      first real cue. Every following cue is renumbered (serializeSrt numbers the final list 1..N).
//   2. If the first real cue starts earlier than 3 s, that cue would flash too briefly to read. The same notice is then also shown
//      in the first gap of at least 3 s between real cues within the first 10 minutes. No real cue is moved or shortened.
//   3. The word "AI" is always in the Stremio entry id (aiEntryId).
// Cues here are { start, end, text } in milliseconds. Nothing in this file logs anything except through the `warn` option.

export const LABEL_MAX_MS = 5000; // the first notice lasts at most this long
export const READABLE_START_MS = 3000; // a first real cue earlier than this needs the second notice
export const GAP_MIN_MS = 3000; // smallest gap between real cues that can hold the second notice
export const GAP_PAD_MS = 100; // distance kept from the cue before and after
export const NOTICE_MAX_MS = 5000; // the second notice lasts at most this long
export const WINDOW_MS = 10 * 60 * 1000; // the second notice must end inside the first 10 minutes

export const AI_ENTRY_LABEL = 'Ελληνικά (AI)';

// ---------- text ----------
// kind: 'final' (finished translation), 'draft' (DeepL draft only), 'improving' (draft with polished parts, still being improved)
const TEXTS = {
  final: (e) => ['Μετάφραση με τεχνητή νοημοσύνη (AI). Μπορεί να έχει λάθη.', `AI translation (${e}). It may contain errors.`],
  draft: (e) => ['Πρόχειρη μετάφραση με τεχνητή νοημοσύνη (AI). Μπορεί να έχει λάθη.', `AI draft translation (${e}). It may contain errors.`],
  improving: (e) => ['Πρόχειρη μετάφραση με τεχνητή νοημοσύνη (AI), σε βελτίωση. Μπορεί να έχει λάθη.', `AI draft translation (${e}), improving. It may contain errors.`],
};

/** The two-line notice: Greek first, English second. `engine` is shown in the English line (e.g. "DeepL + Gemini"). */
export function labelText({ kind = 'final', engine = 'DeepL + Gemini' } = {}) {
  const e = String(engine).replace(/[^A-Za-z0-9 +.\-]/g, '').trim().slice(0, 40) || 'AI';
  return (TEXTS[kind] || TEXTS.final)(e).join('\n');
}

// ---------- placing the notices ----------
const hasText = (c) => String(c.text ?? '').trim() !== '';

/**
 * cues: [{ start, end, text }]. Returns { cues, notices, warnings }:
 *   cues      new list in time order (stable sort by start): the first notice, then the input cues unchanged, with the second
 *             notice inserted in its place when one is needed. Empty-text cues are kept (serializeSrt drops them).
 *   notices   [{ type: 'first' | 'gap', start, end }]
 *   warnings  strings, also passed to `warn` (default console.warn)
 * The input is not modified.
 */
export function addLabel(cues, { kind = 'final', engine = 'DeepL + Gemini', warn = (m) => console.warn(`[ai-label] ${m}`) } = {}) {
  const warnings = [];
  const say = (m) => { warnings.push(m); warn(m); };
  const text = labelText({ kind, engine });
  const ordered = cues
    .map((c, i) => ({ c: { ...c }, i }))
    .sort((a, b) => a.c.start - b.c.start || a.i - b.i)
    .map((x) => x.c);
  const real = ordered.filter(hasText);
  const notices = [];

  // 1. first notice: 0 .. min(5 s, first real cue - 1 ms), never reaching the first real cue
  const first = real[0];
  const firstEnd = first ? Math.max(0, Math.min(LABEL_MAX_MS, first.start - 1)) : LABEL_MAX_MS;
  const label = { start: 0, end: firstEnd, text };
  notices.push({ type: 'first', start: label.start, end: label.end });
  if (!first) say('no real cues: only the AI notice was added');
  else if (firstEnd <= 0) say(`the first real cue starts at ${first.start} ms, so the AI notice is 0 ms long; real cues are not moved`);
  const out = [label, ...ordered];

  // 2. second notice when the first notice is too short to read
  if (first && first.start < READABLE_START_MS) {
    let maxEnd = first.end; // overlapping cues count: the gap starts when the last of them ends
    let found = null;
    for (let i = 1; i < real.length && !found; i++) {
      const next = real[i];
      const start = maxEnd + GAP_PAD_MS;
      const end = Math.min(next.start - GAP_PAD_MS, start + NOTICE_MAX_MS);
      if (next.start - maxEnd >= GAP_MIN_MS && end <= WINDOW_MS) found = { start, end, next };
      else if (start > WINDOW_MS) break;
      maxEnd = Math.max(maxEnd, next.end);
    }
    if (found) {
      out.splice(out.indexOf(found.next), 0, { start: found.start, end: found.end, text });
      notices.push({ type: 'gap', start: found.start, end: found.end });
    } else {
      say('the first cue starts before 3 s and there is no gap of 3 s or more in the first 10 minutes: only the first AI notice is used');
    }
  }
  return { cues: out, notices, warnings };
}

// ---------- Stremio entry ----------
const cleanText = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Entry id for the subtitles list: "AI:tt0364845:23:20:final | AI translation from <english release>".
 * The word AI is always in it, whatever the inputs are. state: 'final' or 'draft' (anything else counts as 'draft').
 */
export function aiEntryId({ imdbId, season, episode, state = 'draft', release = '' } = {}) {
  const tt = /^[A-Za-z0-9_]{1,16}$/.test(String(imdbId ?? '')) ? String(imdbId) : 'unknown';
  const parts = ['AI', tt];
  if (season != null && episode != null) parts.push(String(Number(season) || 0), String(Number(episode) || 0));
  parts.push(state === 'final' ? 'final' : 'draft');
  const rel = cleanText(release, 80);
  return `${parts.join(':')} | AI translation${rel ? ` from ${rel}` : ''}`;
}
