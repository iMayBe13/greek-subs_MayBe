import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SYSTEM_TRANSLATE, SYSTEM_POLISH, glossarySentence, systemPrompt, translateUser, polishUser, retryNote, MAX_GLOSSARY_NAMES } from '../src/lib/ai/prompts.js';

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

test('the two base prompts are exactly the tested prompts (translate and polish); any edit changes these fingerprints', () => {
  assert.equal(sha1(SYSTEM_TRANSLATE), '2148bfc749ce39e9b3fb2f4f0526d5eae79ea659');
  assert.equal(sha1(SYSTEM_POLISH), 'd58b09f01349a66eeeac9df61b8ff70ae10616ef');
  assert.match(SYSTEM_TRANSLATE, /^You are a professional subtitle translator\./);
  assert.match(SYSTEM_POLISH, /^You are an expert Greek subtitle editor\./);
});

test('without a glossary the system prompt is the base text, unchanged', () => {
  for (const g of [undefined, null, {}, [], 'Laroche', { Laroche: 'Laroche' }, { Laroche: '' }, { Laroche: 5 }]) {
    assert.equal(glossarySentence(g), '', JSON.stringify(g));
    assert.equal(systemPrompt('translate', g), SYSTEM_TRANSLATE);
    assert.equal(systemPrompt('polish', g), SYSTEM_POLISH);
  }
  assert.equal(systemPrompt('anything else'), SYSTEM_TRANSLATE);
});

test('with a glossary the names are added as a JSON map after the base prompt; entries without a Greek spelling are dropped', () => {
  const g = { Laroche: 'Λαρός', Kayla: 'Κέιλα', Archive: 'Archive', '  ': 'Κάτι', Blank: '' };
  const s = systemPrompt('polish', g);
  assert.ok(s.startsWith(SYSTEM_POLISH));
  assert.ok(s.length > SYSTEM_POLISH.length);
  assert.match(s, /\{"Laroche":"Λαρός","Kayla":"Κέιλα"\}/);
  assert.ok(!s.includes('Archive') && !s.includes('Blank'));
  assert.match(s, /instead of keeping them in Latin letters/);
  assert.match(s, /NCIS stay in Latin/);
  assert.equal(systemPrompt('translate', g), SYSTEM_TRANSLATE + glossarySentence(g));
});

test('a very long glossary is cut to the first 80 names', () => {
  const g = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`Name${i}`, `Όνομα${i}`]));
  const map = JSON.parse(/(\{.*\})$/.exec(glossarySentence(g))[1]);
  assert.equal(Object.keys(map).length, MAX_GLOSSARY_NAMES);
  assert.ok('Name0' in map && !('Name80' in map));
});

test('the user messages have the tested wording and format', () => {
  assert.equal(translateUser({ context: ['prev 1', 'prev 2'], texts: ['Hello.', 'Bye.'] }),
    'Previous cues, for context only. Do NOT translate them and do NOT include them in your answer:\n["prev 1","prev 2"]\n\n' +
    'Translate these 2 cues. Answer with a JSON array of exactly 2 strings:\n["Hello.","Bye."]');
  assert.equal(polishUser({ context: ['prev'], cues: [{ en: 'Hello.', draft: 'Γεια.', extra: 'ignored' }] }),
    'Previous English cues, for context only. Do NOT include them in your answer:\n["prev"]\n\n' +
    'Improve the Greek draft of these 1 cues. Answer with a JSON array of exactly 1 strings:\n[{"en":"Hello.","draft":"Γεια."}]');
  assert.match(translateUser({ texts: ['x'] }), /:\n\[\]\n\n/); // no context: an empty list
});

test('retryNote names the problem and the expected count, and stays short', () => {
  const note = retryNote('expected 100 items, got 98', 100);
  assert.equal(note, '\n\nIMPORTANT: your previous answer was rejected: expected 100 items, got 98. Answer again with a JSON array of exactly 100 strings.');
  assert.ok(!retryNote('x'.repeat(1000), 5).includes('x'.repeat(301))); // the problem text is cut to 300 characters
});
