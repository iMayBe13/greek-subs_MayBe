import test from 'node:test';
import assert from 'node:assert/strict';
import { passesCharCheck, findBadChars, isOnlyNamesOrAcronyms, checkCue, validateChunk, describeProblems, MAX_SOFT_RATE } from '../src/lib/ai/validate.js';

const codes = (list) => list.map((x) => x.code);

test('character check: Greek, Latin, digits, punctuation, symbols and newlines are accepted', () => {
  for (const ok of ['Καλημέρα, κόσμε!', 'NCIS', 'Κέιλα', 'Λαρός', 'Agent Knight', '«Ναι»… – όχι;', '“quote” ‘x’', '♪ τραγούδι ♪', '12:30 €5 50%', 'Ένα\nδύο', '', 'Καφές & γάλα #1']) {
    assert.equal(passesCharCheck(ok), true, JSON.stringify(ok));
  }
});

test('character check: Cyrillic (the stray letter DeepL produced) and CJK are rejected', () => {
  assert.equal(passesCharCheck('Λαρόш'), false); // Cyrillic ш inside a Greek name
  assert.deepEqual(findBadChars('Λαρόш'), [0x448]);
  assert.equal(passesCharCheck('Привет'), false);
  assert.equal(passesCharCheck('你好'), false);
  assert.equal(passesCharCheck('こんにちは'), false);
  assert.equal(passesCharCheck('한국어'), false);
  assert.equal(passesCharCheck('𠀀'), false); // CJK outside the basic plane
});

test('character check: control characters, tabs, carriage returns, emoji and non-strings are rejected', () => {
  for (const bad of ['a\u0007b', 'a\tb', 'a\rb', 'a\u0000b', 'ok 😀', 'a​b']) assert.equal(passesCharCheck(bad), false, JSON.stringify(bad));
  assert.equal(passesCharCheck(null), false);
  assert.equal(passesCharCheck(42), false);
});

test('findBadChars lists each bad code point once', () => {
  assert.deepEqual(findBadChars('шшш Греция'), [0x448, 0x413, 0x440, 0x435, 0x446, 0x438, 0x44f]);
  assert.deepEqual(findBadChars('Καλημέρα'), []);
});

test('a cue without Greek is flagged hard; names and acronyms alone are allowed', () => {
  assert.deepEqual(codes(checkCue({ english: 'Yeah, sure thing.', text: 'Yeah, sure thing.' }).hard), ['no-greek']);
  assert.deepEqual(checkCue({ english: 'Yeah, sure thing.', text: 'Ναι, βέβαια.' }).hard, []);
  // acronyms of 2 to 5 capitals stay in Latin
  assert.deepEqual(checkCue({ english: 'NCIS.', text: 'NCIS.' }).hard, []);
  assert.deepEqual(checkCue({ english: 'FBI, NCIS!', text: 'FBI, NCIS!' }).hard, []);
  // glossary names alone (also possessive) are allowed; a name plus a real word is not
  assert.deepEqual(checkCue({ english: 'Kayla!', text: 'Kayla!', glossary: ['Kayla'] }).hard, []);
  assert.deepEqual(checkCue({ english: "Kayla's Laroche", text: "Kayla's Laroche", glossary: ['Kayla', 'Laroche'] }).hard, []);
  assert.deepEqual(codes(checkCue({ english: 'Kayla!', text: 'Kayla!' }).hard), ['no-greek']); // not in the glossary
  assert.deepEqual(codes(checkCue({ english: 'Hello Kayla.', text: 'Hello Kayla.', glossary: ['Kayla'] }).hard), ['no-greek']);
  assert.deepEqual(codes(checkCue({ english: 'Hello NCIS.', text: 'Hello NCIS.' }).hard), ['no-greek']);
  // multi-word names
  assert.deepEqual(checkCue({ english: 'Agent Knight', text: 'Agent Knight', glossary: ['Agent Knight'] }).hard, []);
});

test('short English cues (under 4 letters) are not required to contain Greek', () => {
  assert.deepEqual(checkCue({ english: 'Oh.', text: 'Oh.' }).hard, []);
  assert.deepEqual(checkCue({ english: '...', text: '...' }).hard, []);
  assert.deepEqual(codes(checkCue({ english: 'Yeah.', text: 'Yeah.' }).hard), ['no-greek']); // 4 letters
});

test('an empty translation of a real cue is a hard error; a non-string item too', () => {
  assert.deepEqual(codes(checkCue({ english: 'Hello there.', text: '  ' }).hard), ['empty']);
  assert.deepEqual(codes(checkCue({ english: 'Hello there.', text: null }).hard), ['type']);
  assert.deepEqual(checkCue({ english: '', text: '' }).hard, []);
});

test('Cyrillic inside an otherwise good cue is a hard error naming the code point, not the text', () => {
  const r = checkCue({ english: 'I thought we were done with Laroche.', text: 'Νόμιζα ότι τελειώσαμε με τον Λαρόш.' });
  assert.deepEqual(codes(r.hard), ['chars']);
  assert.match(r.hard[0].message, /U\+0448/);
  assert.ok(!r.hard[0].message.includes('Νόμιζα'));
});

test('soft errors: a glossary name left in Latin letters, and a changed number of line breaks', () => {
  const glossary = { Laroche: 'Λαρός', NCIS: 'NCIS' };
  const en = 'I thought we were done with Laroche.';
  assert.deepEqual(codes(checkCue({ english: en, text: 'Νόμιζα ότι τελειώσαμε με τον Laroche.', glossary }).soft), ['latin-name']);
  assert.deepEqual(checkCue({ english: en, text: 'Νόμιζα ότι τελειώσαμε με τον Λαρός.', glossary }).soft, []);
  assert.deepEqual(checkCue({ english: 'Call NCIS now.', text: 'Πάρε το NCIS τώρα.', glossary }).soft, []); // value is Latin: allowed
  assert.deepEqual(codes(checkCue({ english: 'one\ntwo', text: 'ένα δύο' }).soft), ['line-breaks']);
  assert.deepEqual(checkCue({ english: 'one\ntwo', text: 'ένα\nδύο' }).soft, []);
  // soft errors alone are not hard errors
  assert.deepEqual(checkCue({ english: en, text: 'Νόμιζα ότι τελειώσαμε με τον Laroche.', glossary }).hard, []);
});

test('isOnlyNamesOrAcronyms', () => {
  assert.equal(isOnlyNamesOrAcronyms('NCIS', []), true);
  assert.equal(isOnlyNamesOrAcronyms('Kayla', ['Kayla']), true);
  assert.equal(isOnlyNamesOrAcronyms('Kayla', []), false);
  assert.equal(isOnlyNamesOrAcronyms('Kayla and Vance', ['Kayla', 'Vance']), false); // "and" is a real word
  assert.equal(isOnlyNamesOrAcronyms('...', ['Kayla']), false);
});

const EN = ['Hello there.', 'I thought we were done with Laroche.', 'NCIS.'];
const GOOD = ['Γεια σου.', 'Νόμιζα ότι τελειώσαμε με τον Λαρός.', 'NCIS.'];

test('validateChunk: a good chunk passes', () => {
  const r = validateChunk({ english: EN, output: GOOD, glossary: { Laroche: 'Λαρός' } });
  assert.deepEqual({ ok: r.ok, retry: r.retry, hard: r.hard, soft: r.soft, badCues: r.badCues }, { ok: true, retry: false, hard: [], soft: [], badCues: [] });
});

test('validateChunk: a wrong item count is rejected (too few, too many), and a non-list answer too', () => {
  for (const output of [GOOD.slice(0, 2), [...GOOD, 'Επιπλέον.']]) {
    const r = validateChunk({ english: EN, output });
    assert.equal(r.ok, false);
    assert.equal(r.retry, true);
    assert.deepEqual(codes(r.hard), ['count']);
    assert.equal(r.hard[0].cue, null);
  }
  assert.deepEqual(codes(validateChunk({ english: EN, output: 'nope' }).hard), ['not-array']);
  assert.deepEqual(codes(validateChunk({ english: EN, output: undefined }).hard), ['not-array']);
});

test('validateChunk: Cyrillic, a cue without Greek and a non-string item make the chunk fail and list the bad cues', () => {
  const cyr = validateChunk({ english: EN, output: ['Γεια σου.', 'Νόμιζα με τον Λαρόш.', 'NCIS.'] });
  assert.equal(cyr.ok, false);
  assert.deepEqual(cyr.badCues, [1]);
  const noGreek = validateChunk({ english: EN, output: ['Hello there.', GOOD[1], GOOD[2]] });
  assert.equal(noGreek.ok, false);
  assert.deepEqual(noGreek.badCues, [0]);
  const type = validateChunk({ english: EN, output: [GOOD[0], 7, GOOD[2]] });
  assert.deepEqual(codes(type.hard), ['type']);
});

test('validateChunk: more than 5% soft errors fails the chunk, exactly 5% passes', () => {
  assert.equal(MAX_SOFT_RATE, 0.05);
  const english = Array.from({ length: 100 }, () => 'one\ntwo');
  const output = (bad) => Array.from({ length: 100 }, (_, i) => (i < bad ? 'ένα δύο' : 'ένα\nδύο'));
  const five = validateChunk({ english, output: output(5) });
  assert.equal(five.ok, true);
  assert.equal(five.soft.length, 5);
  const six = validateChunk({ english, output: output(6) });
  assert.equal(six.ok, false);
  assert.deepEqual(six.hard, []);
  assert.equal(six.softRate, 0.06);
});

test('validateChunk: several soft errors in one cue count as one cue', () => {
  const english = Array.from({ length: 20 }, () => 'Laroche\nhere');
  const glossary = { Laroche: 'Λαρός' };
  const output = Array.from({ length: 20 }, (_, i) => (i === 0 ? 'Laroche εδώ' : 'Λαρός\nεδώ'));
  const r = validateChunk({ english, output, glossary });
  assert.equal(r.soft.length, 2); // latin-name + line-breaks on cue 0
  assert.equal(r.softRate, 1 / 20);
  assert.equal(r.ok, true);
});

test('describeProblems names the problem with 1-based cue numbers and never quotes the text', () => {
  const r = validateChunk({ english: EN, output: ['Γεια σου.', 'Νόμιζα με τον Λαρόш.', 'NCIS.'] });
  const msg = describeProblems(r);
  assert.match(msg, /cues 2 contain characters/);
  assert.ok(!msg.includes('Νόμιζα'));
  assert.match(describeProblems(validateChunk({ english: EN, output: GOOD.slice(1) })), /expected 3 items, got 2/);
  assert.equal(describeProblems(validateChunk({ english: EN, output: GOOD })), '');
});
