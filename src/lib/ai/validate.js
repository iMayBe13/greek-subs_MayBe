// Checks on machine-translated cues before they are accepted.
//
// Per cue (checkCue):
//   hard  chars      a character outside Greek, Latin, digits, punctuation, spaces and a few symbols (Cyrillic, CJK, control characters)
//   hard  empty      empty output for a non-empty English cue
//   hard  no-greek   English with 4+ letters whose output has no Greek letter, unless the English is only glossary names / acronyms
//   hard  type       the item is not a string
//   soft  latin-name a glossary name still written in Latin letters
//   soft  line-breaks different number of line breaks than the English cue
// Per chunk (validateChunk): a wrong item count is hard too. The chunk must be retried when there is any hard error or when
// more than 5% of the cues have a soft error. Nothing here touches the network, a key or a log.

/** The only characters a translated cue may contain. */
export const ALLOWED_CHARS = /^[\p{Script=Greek}\p{Script=Latin}\p{Nd}\p{P}\p{Zs}\n♪€°%&+=<>#*~^|$@]*$/u;
export const MAX_SOFT_RATE = 0.05;

export const GREEK_LETTER = /[Ͱ-Ͽἀ-῿]/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

export const passesCharCheck = (text) => typeof text === 'string' && ALLOWED_CHARS.test(text);

/** Distinct code points of `text` that are not allowed (empty array = fine). */
export function findBadChars(text) {
  const bad = new Set();
  for (const ch of String(text)) if (!ALLOWED_CHARS.test(ch)) bad.add(ch.codePointAt(0));
  return [...bad];
}

// ---------- glossary ----------
// glossary: ['Laroche', 'Kayla'] or { Laroche: 'Λαρός', Kayla: 'Κέιλα' }. In the object form a name is checked for "left in
// Latin letters" only when its value has Greek letters (so { NCIS: 'NCIS' } may stay Latin).
const compiled = new WeakMap();
function compileGlossary(glossary) {
  if (!glossary || typeof glossary !== 'object') return { names: [], latin: [] };
  if (compiled.has(glossary)) return compiled.get(glossary);
  const entries = Array.isArray(glossary) ? glossary.map((n) => [n, null]) : Object.entries(glossary);
  const clean = entries.filter(([n]) => typeof n === 'string' && n.trim());
  const names = clean.map(([n]) => n).sort((a, b) => b.length - a.length); // longest first, so "Agent Knight" goes before "Knight"
  const latin = clean
    .filter(([, v]) => v == null || GREEK_LETTER.test(String(v)))
    .map(([n]) => ({ name: n, inEnglish: new RegExp(`\\b${escapeRe(n)}\\b`), inOutput: new RegExp(`\\b${escapeRe(n)}\\b`, 'i') }));
  const out = { names, latin };
  compiled.set(glossary, out);
  return out;
}

export const WORD = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
const isAcronym = (w) => /^[A-Z]{2,5}$/.test(w);

/** True when every English word is a glossary name (also possessive "Kayla's") or an acronym of 2 to 5 capital letters. */
export function isOnlyNamesOrAcronyms(english, glossary) {
  let rest = String(english);
  for (const n of compileGlossary(glossary).names) rest = rest.replace(new RegExp(`\\b${escapeRe(n)}(?:['’]s)?\\b`, 'g'), ' ');
  const words = rest.match(WORD) || [];
  return words.every(isAcronym) && (words.length > 0 || rest !== String(english));
}

// ---------- one cue ----------
/** english / text: the plain English cue and its translation. Returns { hard: [{code, message}], soft: [{code, message}] }. */
export function checkCue({ english, text, glossary } = {}) {
  const hard = [], soft = [];
  if (typeof text !== 'string') return { hard: [{ code: 'type', message: 'item is not a string' }], soft };
  const en = String(english ?? '');

  const bad = findBadChars(text);
  if (bad.length) hard.push({ code: 'chars', message: `characters not allowed: ${bad.slice(0, 5).map(hex).join(' ')}` });

  const letters = (en.match(/[A-Za-z]/g) || []).length;
  if (!text.trim()) {
    if (en.trim()) hard.push({ code: 'empty', message: 'empty translation' });
  } else if (letters >= 4 && !GREEK_LETTER.test(text) && !isOnlyNamesOrAcronyms(en, glossary)) {
    hard.push({ code: 'no-greek', message: 'no Greek letters in the translation' });
  }

  for (const g of compileGlossary(glossary).latin) {
    if (g.inEnglish.test(en) && g.inOutput.test(text)) soft.push({ code: 'latin-name', message: `name "${g.name}" is still in Latin letters` });
  }
  if ((en.match(/\n/g) || []).length !== (text.match(/\n/g) || []).length) soft.push({ code: 'line-breaks', message: 'different number of line breaks' });
  return { hard, soft };
}

// ---------- one chunk ----------
/**
 * english: string[] (plain cues of the chunk); output: what the model returned; glossary: see above.
 * -> { ok, retry, hard: [{code, cue, message}], soft: [...], softRate, badCues }
 * `cue` is a 0-based index into the chunk (null for chunk-level errors); `badCues` lists the cues with a hard error.
 */
export function validateChunk({ english = [], output, glossary } = {}) {
  const n = english.length;
  const hard = [], soft = [];
  if (!Array.isArray(output)) {
    hard.push({ code: 'not-array', cue: null, message: 'the answer is not a list' });
  } else if (output.length !== n) {
    hard.push({ code: 'count', cue: null, message: `expected ${n} items, got ${output.length}` });
  } else {
    output.forEach((text, i) => {
      const r = checkCue({ english: english[i], text, glossary });
      hard.push(...r.hard.map((h) => ({ ...h, cue: i })));
      soft.push(...r.soft.map((s) => ({ ...s, cue: i })));
    });
  }
  const softRate = n ? new Set(soft.map((s) => s.cue)).size / n : 0;
  const ok = hard.length === 0 && softRate <= MAX_SOFT_RATE;
  return { ok, retry: !ok, hard, soft, softRate, badCues: [...new Set(hard.filter((h) => h.cue != null).map((h) => h.cue))] };
}

/** One short sentence naming what was wrong, to put in the retry prompt. Cue numbers are 1-based. */
export function describeProblems(result) {
  const parts = [];
  const cuesOf = (list, code) => list.filter((x) => x.code === code).map((x) => x.cue + 1);
  const show = (a) => `${a.slice(0, 8).join(', ')}${a.length > 8 ? ', …' : ''}`;
  const chunk = result.hard.find((h) => h.cue == null);
  if (chunk) parts.push(chunk.message);
  const chars = cuesOf(result.hard, 'chars'); if (chars.length) parts.push(`cues ${show(chars)} contain characters other than Greek or Latin letters`);
  const none = cuesOf(result.hard, 'no-greek'); if (none.length) parts.push(`cues ${show(none)} are not translated into Greek`);
  const empty = cuesOf(result.hard, 'empty'); if (empty.length) parts.push(`cues ${show(empty)} are empty`);
  const types = cuesOf(result.hard, 'type'); if (types.length) parts.push(`items ${show(types)} are not strings`);
  const names = cuesOf(result.soft, 'latin-name');
  if (names.length && result.softRate > MAX_SOFT_RATE) parts.push(`names in cues ${show(names)} must be written in Greek letters`);
  const lines = cuesOf(result.soft, 'line-breaks');
  if (lines.length && result.softRate > MAX_SOFT_RATE) parts.push(`cues ${show(lines)} must keep the English line breaks`);
  return parts.join('; ');
}
