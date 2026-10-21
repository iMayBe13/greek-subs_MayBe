// Prompts for the Gemini pass.
//   translate  = Gemini translates the English cues
//   polish     = Gemini improves a DeepL draft
// The glossary is an extra sentence appended to the system prompt, and only when there are names to give.
import { GREEK_LETTER } from './validate.js';

export const SYSTEM_TRANSLATE =
  'You are a professional subtitle translator. Translate the English subtitle cues into natural, spoken Modern Greek, ' +
  'the way people really talk in a TV crime drama: not literal, not bookish. Keep proper names, ranks and acronyms as they are. ' +
  'Keep each cue\'s line breaks: use a newline exactly where the English cue has one. Never merge, split, add or drop cues. ' +
  'Do not add explanations, notes or formatting tags. Reply only with a JSON array of strings containing exactly as many items ' +
  'as the cues you are given, in the same order.';

export const SYSTEM_POLISH =
  'You are an expert Greek subtitle editor. For each cue you get the English original and a machine-translated Greek draft. ' +
  'Return an improved version in natural, spoken Modern Greek: fix mistranslations, wrong register, gender/number agreement and unnatural ' +
  'phrasing, but stay faithful to the English meaning and keep it short enough to read as a subtitle. Keep proper names, ranks and acronyms. ' +
  'Keep the draft\'s line breaks (a newline where the English has one). Never merge, split, add or drop cues. No explanations or tags. ' +
  'Reply only with a JSON array of strings containing exactly as many items as the cues you are given, in the same order.';

export const MAX_GLOSSARY_NAMES = 80;

/**
 * glossary: { "Laroche": "Λαρός", ... } (English name -> Greek spelling). Entries without a Greek spelling are ignored.
 * -> the sentence for the system prompt, or '' when there is nothing to say.
 */
export function glossarySentence(glossary) {
  if (!glossary || typeof glossary !== 'object' || Array.isArray(glossary)) return '';
  const entries = Object.entries(glossary)
    .filter(([name, greek]) => typeof name === 'string' && name.trim() && typeof greek === 'string' && GREEK_LETTER.test(greek))
    .slice(0, MAX_GLOSSARY_NAMES);
  if (!entries.length) return '';
  const map = Object.fromEntries(entries.map(([n, g]) => [n.trim(), g.trim()]));
  return ' Use these Greek spellings for these names, exactly as written, instead of keeping them in Latin letters ' +
    `(acronyms such as NCIS stay in Latin letters): ${JSON.stringify(map)}`;
}

/** kind: 'translate' | 'polish'. */
export function systemPrompt(kind, glossary) {
  return (kind === 'polish' ? SYSTEM_POLISH : SYSTEM_TRANSLATE) + glossarySentence(glossary);
}

/** context: the previous English cues (strings), shown for context only. texts: the English cues of this chunk. */
export function translateUser({ context = [], texts }) {
  return `Previous cues, for context only. Do NOT translate them and do NOT include them in your answer:\n${JSON.stringify(context)}\n\n` +
    `Translate these ${texts.length} cues. Answer with a JSON array of exactly ${texts.length} strings:\n${JSON.stringify(texts)}`;
}

/** cues: [{ en, draft }] */
export function polishUser({ context = [], cues }) {
  return `Previous English cues, for context only. Do NOT include them in your answer:\n${JSON.stringify(context)}\n\n` +
    `Improve the Greek draft of these ${cues.length} cues. Answer with a JSON array of exactly ${cues.length} strings:\n${JSON.stringify(cues.map((c) => ({ en: c.en, draft: c.draft })))}`;
}

/** Appended to the user message when a chunk is asked again. `problem` comes from validate.js describeProblems (no cue text). */
export function retryNote(problem, expected) {
  return `\n\nIMPORTANT: your previous answer was rejected: ${String(problem).slice(0, 300)}. ` +
    `Answer again with a JSON array of exactly ${expected} strings.`;
}

// ---------- glossary (src/lib/ai/glossary.js) ----------
export const SYSTEM_GLOSSARY =
  'You help translate a TV show into Greek. You get a JSON array of English character, place and organisation names taken from its ' +
  'subtitles. For each one, write how it is spelled in Greek letters in Greek subtitles (a sound-alike transliteration, with the ' +
  'usual Greek accent). Keep a name that is normally left in Latin letters in Latin letters. Reply only with a JSON array of ' +
  'strings containing exactly as many items as names you are given, in the same order.';

export const glossaryUser = (names) =>
  `Give the Greek spelling of each of these ${names.length} names. Answer with a JSON array of exactly ${names.length} strings:
${JSON.stringify(names)}`;
