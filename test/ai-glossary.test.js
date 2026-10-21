import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { glossaryCandidates, acceptSpellings, getGlossary, glossaryKey } from '../src/lib/ai/glossary.js';
import { setAiStore, delAi } from '../src/lib/cache.js';

afterEach(() => setAiStore(null));

function memStore() {
  const m = new Map(), sets = [];
  return {
    m, sets,
    async get(k, { kind }) { return m.get(`${kind}:${k}`) ?? null; },
    async set(k, b, o = {}) { sets.push({ k, ttlSec: o.ttlSec }); m.set(`${o.kind}:${k}`, b); },
    async del() { return true; },
  };
}

test('names seen 2+ times and at least once inside a sentence are candidates', () => {
  const texts = [
    'Where is Laroche?', 'I told Laroche to wait.', // twice, once mid-sentence: yes
    'Kayla! Kayla, come here.', // only at sentence starts: no
    'Ask Palmer.', // once: no
    "That was Gibbs's car.", 'Tell Gibbs now.', // the possessive counts as Gibbs
  ];
  assert.deepEqual(glossaryCandidates(texts).sort(), ['Gibbs', 'Laroche']);
});

test('capitalised words that only start sentences are not names; stop words and titles are not names', () => {
  const texts = ['What is that?', 'What do you want?', 'Yes, Sir.', 'No, Sir.', 'Okay. Okay.', 'See you on Monday.', 'Not on Monday.', 'Call Director Vance.', 'Director Vance is here.'];
  assert.deepEqual(glossaryCandidates(texts).sort(), ['Director Vance', 'Vance']);
});

test('pairs of capitalised words count as one name too ("Agent Knight"); the rank alone does not', () => {
  const texts = ['Tell Agent Knight.', 'Where is Agent Knight?', 'Agent Torres agrees.', 'Call Agent Torres.'];
  assert.deepEqual(glossaryCandidates(texts).sort(), ['Agent Knight', 'Agent Torres', 'Knight', 'Torres']);
});

test('acronyms of 2 to 5 capitals are never candidates (they stay in Latin letters)', () => {
  assert.deepEqual(glossaryCandidates(['Call the NCIS now.', 'The NCIS lab is open.', 'FBI, hold it.', 'Tell the FBI.']), []);
});

test('speaker dashes, quotes and multi-line cues do not break the sentence-start rule', () => {
  assert.deepEqual(glossaryCandidates(['- Hello, Kayla.\n- Hi, Kayla!', '"Kayla," he said.']), ['Kayla']);
});

test('the most frequent names come first and the list is capped at 80', () => {
  assert.deepEqual(glossaryCandidates(['See Bob.', 'See Ann.', 'See Ann.', 'See Ann.', 'See Bob.']), ['Ann', 'Bob']);
  const letter = (i) => String.fromCharCode(97 + (i % 26));
  const many = Array.from({ length: 120 }, (_, i) => {
    const name = `Zz${letter(i)}${letter(Math.floor(i / 26))}${letter(i * 7)}`;
    return `Ask ${name} now. Ask ${name} again.`;
  });
  assert.equal(glossaryCandidates(many).length, 80);
});

test('spellings must pass the character check and contain Greek letters, or they are dropped', () => {
  const got = acceptSpellings(['Laroche', 'Kayla', 'Gibbs', 'Ziva', 'Tony'], ['Λαρός', 'Κέιλα ш', 'Gibbs', '', 42]);
  assert.deepEqual(got, { Laroche: 'Λαρός' });
  assert.deepEqual(acceptSpellings(['A', 'B'], ['Α']), {}); // wrong count: nothing is trusted
});

function fetchFor(answer, calls) {
  return async (url, init) => {
    calls.push(String(url));
    const body = JSON.parse(init.body);
    assert.match(body.systemInstruction.parts[0].text, /Greek letters/);
    const names = JSON.parse(body.contents[0].parts[0].text.split('strings:\n')[1]);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer(names)) }] }, finishReason: 'STOP' }] }), { status: 200 });
  };
}
const TEXTS = ['Where is Laroche?', 'Tell Laroche now.', 'Ask Kayla.', 'Kayla knows.', 'Call the NCIS lab.'];
const ENV = { AI_GEMINI_MODEL: 'gemini-test-flash' };
const KEY = 'AIza' + 'GlossaryTestKey0123456789';

test('with a Gemini key: one call, valid spellings stored under ai:gloss:{tt} for 180 days, then reused with no call', async () => {
  const store = memStore(); setAiStore(store);
  const calls = [];
  const fetchImpl = fetchFor((names) => names.map((n) => (n === 'Laroche' ? 'Λαρός' : 'Kayla')), calls);
  const g = await getGlossary({ imdbId: 'tt9000001', texts: TEXTS, key: KEY, fetchImpl, env: ENV, log: () => {} });
  assert.deepEqual(g, { Laroche: 'Λαρός' }); // "Kayla" came back in Latin letters: dropped
  assert.equal(calls.length, 1);
  assert.deepEqual(store.sets, [{ k: glossaryKey('tt9000001'), ttlSec: 180 * 24 * 3600 }]);
  assert.ok(!store.sets[0].k.includes(KEY));
  const again = await getGlossary({ imdbId: 'tt9000001', texts: TEXTS, key: KEY, fetchImpl, env: ENV, log: () => {} });
  assert.deepEqual(again, g);
  assert.equal(calls.length, 1);
});

test('without a Gemini key there is no glossary and no request, but a stored one is still used', async () => {
  const store = memStore(); setAiStore(store);
  const calls = [];
  assert.deepEqual(await getGlossary({ imdbId: 'tt9000002', texts: TEXTS, fetchImpl: fetchFor(() => [], calls), log: () => {} }), {});
  assert.equal(calls.length, 0);
  await delAi(glossaryKey('tt9000002'));
  store.m.set(`json:${glossaryKey('tt9000002')}`, Buffer.from(JSON.stringify({ Kayla: 'Κέιλα' })));
  assert.deepEqual(await getGlossary({ imdbId: 'tt9000002', texts: TEXTS, log: () => {} }), { Kayla: 'Κέιλα' });
});

test('a failing Gemini call gives an empty glossary, stores nothing and does not throw', async () => {
  const store = memStore(); setAiStore(store);
  const fetchImpl = async () => new Response('{}', { status: 400 });
  assert.deepEqual(await getGlossary({ imdbId: 'tt9000003', texts: TEXTS, key: KEY, fetchImpl, env: ENV, sleep: async () => {}, log: () => {} }), {});
  assert.equal(store.sets.length, 0);
});

test('no candidate names: no call at all', async () => {
  setAiStore(memStore());
  const calls = [];
  assert.deepEqual(await getGlossary({ imdbId: 'tt9000004', texts: ['Hello there.', 'Come in.'], key: KEY, fetchImpl: fetchFor(() => [], calls), env: ENV, log: () => {} }), {});
  assert.equal(calls.length, 0);
});
