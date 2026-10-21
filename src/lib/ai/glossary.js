// Per-show name glossary. Built once per show from the English cues and reused for every episode.
//   glossaryCandidates(texts) -> names worth asking about: capitalised words and pairs of words that appear 2 or more times and not
//                                only at the start of a sentence, minus English stop words and titles. Acronyms (NCIS, FBI) are
//                                all capitals, so they never qualify and stay in Latin letters.
//   getGlossary({ imdbId, texts, key }) -> { "Laroche": "Λαρός", ... }. Needs a Gemini key for one small call; without it there is
//                                no glossary ({}), except one that is already stored. Stored in the AI store under ai:gloss:{tt}.
// Never throws, never logs a key or a subtitle line.
import { getAi, setAi } from '../cache.js';
import { spellNames } from './gemini.js';
import { passesCharCheck, GREEK_LETTER, WORD } from './validate.js';
import { MAX_GLOSSARY_NAMES } from './prompts.js';

export const GLOSSARY_TTL_SEC = 180 * 24 * 3600;
export const glossaryKey = (imdbId) => `ai:gloss:${imdbId}`;

const MIN_COUNT = 2;

// Words that are capitalised only because of their position, or are not names.
const STOP = new Set(('a an the and or but nor so yet for of in on at to by up as if is are was were be been am do does did have has had ' +
  'i you he she it we they me him her us them my your his its our their this that these those there here what who whom whose which when where why how ' +
  'not no yes yeah yep nope okay ok oh ah hey hi hello well now then just still even also too very much more most some any all both each ' +
  'one two three four five six seven eight nine ten first second last next again never always maybe please thanks thank sorry ' +
  'will would can could shall should may might must let get got go going come look see say said tell know think want need ' +
  'monday tuesday wednesday thursday friday saturday sunday january february march april june july august september october november december ' +
  'sir madam mom dad mum mama papa god lord hell damn dammit').split(/\s+/));
// Ranks and honorifics: they may sit inside a pair ("Agent Knight") but are not names on their own.
const TITLES = new Set(('agent special director doctor detective captain lieutenant sergeant officer commander admiral colonel major general ' +
  'professor president judge senator governor mayor chief deputy marshal miss mister mr mrs ms dr mrs sheriff inspector petty ' +
  'secretary lady king queen prince princess father sister brother uncle aunt grandma grandpa').split(/\s+/));

const CAPITALISED = /^[A-Z][a-z]+$/;

/** Words of one line as { word, start } where start is true at the start of a sentence ('s endings removed). */
function wordsOf(line) {
  const out = [];
  for (const m of line.matchAll(WORD)) {
    const word = m[0].replace(/['’]s$/i, '');
    const before = line.slice(0, m.index).replace(/[\s"'“”‘’\-–—♪*()[\]]+$/, '');
    out.push({ word, start: before === '' || /[.!?…:]$/.test(before) });
  }
  return out;
}

/**
 * texts: plain English cue texts. -> names sorted by how often they occur, at most MAX_GLOSSARY_NAMES.
 * A name counts when it occurs 2 or more times and at least once away from the start of a sentence.
 */
export function glossaryCandidates(texts) {
  const stats = new Map(); // name -> { n, inside }
  const hit = (name, start) => {
    const s = stats.get(name) || { n: 0, inside: 0 };
    s.n++;
    if (!start) s.inside++;
    stats.set(name, s);
  };
  for (const text of texts) {
    for (const line of String(text).split('\n')) {
      const ws = wordsOf(line);
      ws.forEach((w, i) => {
        if (!CAPITALISED.test(w.word) || STOP.has(w.word.toLowerCase())) return;
        if (!TITLES.has(w.word.toLowerCase())) hit(w.word, w.start);
        const next = ws[i + 1];
        if (next && CAPITALISED.test(next.word) && !STOP.has(next.word.toLowerCase())) hit(`${w.word} ${next.word}`, w.start);
      });
    }
  }
  return [...stats]
    .filter(([, s]) => s.n >= MIN_COUNT && s.inside >= 1)
    .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
    .slice(0, MAX_GLOSSARY_NAMES)
    .map(([name]) => name);
}

/** names + the model's answer -> { name: greek } keeping only values that pass the character check and contain Greek letters. */
export function acceptSpellings(names, items) {
  const out = {};
  if (!Array.isArray(items) || items.length !== names.length) return out;
  names.forEach((name, i) => {
    const v = items[i];
    if (typeof v === 'string' && v.trim() && passesCharCheck(v) && GREEK_LETTER.test(v)) out[name] = v.trim();
  });
  return out;
}

/**
 * texts: plain English cues of this episode. key: the user's Gemini key (may be missing).
 * opts are passed to the Gemini client (fetchImpl, sleep, log, env). Returns {} when there is nothing to use.
 */
export async function getGlossary({ imdbId, texts, key, log = (m) => console.warn(m), ...opts }) {
  if (!imdbId) return {};
  const k = glossaryKey(imdbId);
  try {
    const stored = JSON.parse((await getAi(k, { kind: 'json' })) || 'null');
    if (stored && typeof stored === 'object' && !Array.isArray(stored) && Object.keys(stored).length) return stored;
  } catch { /* unreadable record: build it again */ }
  if (!key) return {};
  const names = glossaryCandidates(texts);
  if (!names.length) return {};
  try {
    const { items } = await spellNames({ key, names, log, ...opts });
    const glossary = acceptSpellings(names, items);
    if (Object.keys(glossary).length) await setAi(k, JSON.stringify(glossary), { kind: 'json', ttlSec: GLOSSARY_TTL_SEC });
    log(`[ai] ${imdbId} glossary: ${names.length} candidate names, ${Object.keys(glossary).length} accepted`);
    return glossary;
  } catch (e) {
    log(`[ai] ${imdbId} glossary skipped: ${e?.code || 'error'}`); // the message could name a model; the code is enough
    return {};
  }
}
