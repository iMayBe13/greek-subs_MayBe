import test from 'node:test';
import assert from 'node:assert/strict';
import { addLabel, labelText, aiEntryId, AI_ENTRY_LABEL } from '../src/lib/ai/label.js';
import { serializeSrt, parseSrt } from '../src/lib/srt.js';

const cue = (start, end, text = 'x') => ({ start, end, text });
const quiet = () => {}; // never let a test write to the console
const run = (cues, opts = {}) => { const warned = []; const r = addLabel(cues, { warn: (m) => warned.push(m), ...opts }); return { ...r, warned }; };
const numbers = (srt) => srt.trim().split('\n\n').map((b) => Number(b.split('\n')[0]));
/** the real cues only: everything that is not one of the notices */
const realOf = (r) => r.cues.filter((c) => !c.text.includes('AI'));

const LABEL = 'Μετάφραση με τεχνητή νοημοσύνη (AI). Μπορεί να έχει λάθη.\nAI translation (DeepL + Gemini). It may contain errors.';

test('labelText: the exact bilingual notice from the plan, Greek line first', () => {
  assert.equal(labelText(), LABEL);
  assert.equal(labelText({ kind: 'final', engine: 'DeepL + Gemini' }), LABEL);
});

test('labelText: draft and improving say "draft" in both languages; the engine name is sanitised', () => {
  const draft = labelText({ kind: 'draft', engine: 'DeepL' });
  assert.match(draft, /^Πρόχειρη μετάφραση με τεχνητή νοημοσύνη \(AI\)/);
  assert.match(draft, /\nAI draft translation \(DeepL\)\. It may contain errors\.$/);
  assert.match(labelText({ kind: 'improving' }), /σε βελτίωση/);
  assert.match(labelText({ kind: 'improving' }), /improving/);
  const evil = labelText({ engine: 'Deep\nL <script>шш' });
  assert.equal(evil.split('\n').length, 2); // a newline in the engine name cannot add lines
  assert.ok(!/[<>ш]/.test(evil.split('\n')[1]));
  assert.equal(labelText({ kind: 'nonsense' }), LABEL);
  assert.match(labelText({ engine: '' }), /AI translation \(AI\)/);
});

test('first cue at 10 s: the notice runs 0 to 5 s, is first, the file is renumbered from 2 and no real cue changes', () => {
  const real = [cue(10000, 12000, 'a'), cue(13000, 15000, 'b')];
  const r = run(real);
  assert.deepEqual(r.notices, [{ type: 'first', start: 0, end: 5000 }]);
  assert.deepEqual(r.warned, []);
  assert.equal(r.cues.length, 3);
  assert.deepEqual(r.cues[0], { start: 0, end: 5000, text: LABEL });
  assert.deepEqual(r.cues.slice(1), real);
  const srt = serializeSrt(r.cues);
  assert.deepEqual(numbers(srt), [1, 2, 3]);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:05,000\nΜετάφραση με τεχνητή νοημοσύνη \(AI\)/);
  assert.match(srt, /\n\n2\n00:00:10,000 --> 00:00:12,000\na\n\n3\n/);
});

test('the notice always ends before the first real cue: min(5 s, first start - 1 ms)', () => {
  for (const start of [1200, 2999, 3000, 3500, 5000, 5001, 6000, 20000, 3600000]) {
    const r = run([cue(start, start + 1000)]);
    const label = r.cues[0];
    assert.equal(label.start, 0);
    assert.equal(label.end, Math.min(5000, start - 1), `first cue at ${start}`);
    assert.ok(label.end < start);
  }
});

test('the notice text is bilingual: Greek letters and English words in the same cue', () => {
  const t = run([cue(10000, 11000)]).cues[0].text;
  const [el, en] = t.split('\n');
  assert.match(el, /[Ͱ-Ͽ]/);
  assert.ok(!/[Ͱ-Ͽ]/.test(en));
  assert.match(t, /\bAI\b/);
  assert.match(en, /AI translation/);
});

test('a first cue at 3 s or later needs no second notice and gives no warning', () => {
  const r = run([cue(3000, 4000), cue(20000, 21000)]);
  assert.equal(r.notices.length, 1);
  assert.deepEqual(r.warned, []);
  assert.equal(r.cues.length, 3);
});

// a dense run of cues (gaps of 500 ms) from `from` to `to`
const dense = (from, to) => { const a = []; for (let t = from; t <= to; t += 2000) a.push(cue(t, t + 1500, `line ${t}`)); return a; };

test('first cue at 1.2 s with a gap at about 4:10: a second notice sits in that gap, real cues are untouched, everything is renumbered', () => {
  const real = [cue(1200, 2500, 'first'), ...dense(3000, 249000), cue(260000, 262000, 'after the gap'), cue(263000, 264000, 'last')];
  const lastBefore = real.find((c) => c.text === 'after the gap');
  const prevEnd = real[real.indexOf(lastBefore) - 1].end;
  const r = run(real);
  assert.deepEqual(r.notices, [{ type: 'first', start: 0, end: 1199 }, { type: 'gap', start: prevEnd + 100, end: prevEnd + 100 + 5000 }]);
  assert.deepEqual(r.warned, []);
  assert.equal(r.cues.length, real.length + 2);
  // the second notice comes right before the cue that follows the gap, with the same text
  const i = r.cues.findIndex((c) => c.start === prevEnd + 100);
  assert.equal(r.cues[i].text, LABEL);
  assert.equal(r.cues[i + 1], r.cues.find((c) => c.text === 'after the gap'));
  assert.ok(r.cues[i].end <= lastBefore.start - 100);
  // no real cue moved, shortened or reordered
  assert.deepEqual(realOf(r), real);
  const srt = serializeSrt(r.cues);
  assert.deepEqual(numbers(srt), Array.from({ length: real.length + 2 }, (_, k) => k + 1));
  const back = parseSrt(srt);
  assert.equal(back.length, real.length + 2);
  assert.ok(back.every((c, k) => k === 0 || c.start >= back[k - 1].start)); // still in time order
});

test('a gap of exactly 3 s counts (notice 100 ms after the cue ends to 100 ms before the next); 2.999 s does not', () => {
  const ok = run([cue(1000, 2000, 'a'), cue(5000, 6000, 'b')]); // gap 3000
  assert.deepEqual(ok.notices[1], { type: 'gap', start: 2100, end: 4900 });
  const skip = run([cue(1000, 2000, 'a'), cue(4999, 6000, 'b'), cue(20000, 21000, 'c')]); // gap 2999 then 14000
  assert.deepEqual(skip.notices[1], { type: 'gap', start: 6100, end: 11100 }); // lasts at most 5 s
});

test('the second notice lasts at most 5 s even in a long gap', () => {
  const r = run([cue(500, 1500, 'a'), cue(100000, 101000, 'b')]);
  assert.deepEqual(r.notices[1], { type: 'gap', start: 1600, end: 6600 });
});

test('overlapping cues: the gap is measured from the latest end, not from the previous cue in the list', () => {
  const r = run([cue(500, 1000, 'a'), cue(1200, 9000, 'long'), cue(1500, 2000, 'inside it'), cue(11000, 12000, 'after 2 s'), cue(16000, 17000, 'after 4 s')]);
  // gap after 'long' (ends 9000) to 11000 is only 2000: skipped; the next gap (12000 to 16000) is 4000
  assert.deepEqual(r.notices[1], { type: 'gap', start: 12100, end: 15900 });
});

test('no gap of 3 s in the first 10 minutes: only the first notice, and a warning is logged', () => {
  const real = [cue(1000, 2000, 'a'), ...dense(3000, 660000)];
  const r = run(real);
  assert.equal(r.notices.length, 1);
  assert.equal(r.cues.length, real.length + 1);
  assert.equal(r.warned.length, 1);
  assert.match(r.warned[0], /no gap of 3 s or more in the first 10 minutes/);
  assert.deepEqual(r.warnings, r.warned);
});

test('a gap that would reach past 10 minutes is not used', () => {
  const real = [cue(1000, 2000, 'a'), ...dense(3000, 596000), cue(610000, 611000, 'b')]; // last dense cue ends 597500: notice 597600 .. 602600
  const r = run(real);
  assert.equal(r.notices.length, 1);
  assert.equal(r.warned.length, 1);
  // ... but a gap whose notice ends inside the window is
  const ok = run([cue(1000, 2000, 'a'), ...dense(3000, 590000), cue(610000, 611000, 'b')]); // notice 591600+100 .. +5000 = 596600 or so
  assert.equal(ok.notices.length, 2);
  assert.ok(ok.notices[1].end <= 600000);
});

test('first real cue at 0: the notice is 0 ms long, a warning is logged, the second notice is added, nothing is moved', () => {
  const real = [cue(0, 1500, 'zero'), cue(2000, 3000, 'b'), cue(9000, 10000, 'c')];
  const r = run(real);
  assert.deepEqual(r.cues[0], { start: 0, end: 0, text: LABEL });
  assert.equal(r.warned.length, 1);
  assert.match(r.warned[0], /starts at 0 ms/);
  assert.deepEqual(r.notices[1], { type: 'gap', start: 3100, end: 8100 });
  assert.deepEqual(realOf(r), real);
  assert.deepEqual(numbers(serializeSrt(r.cues)), [1, 2, 3, 4, 5]);
  assert.match(serializeSrt(r.cues), /^1\n00:00:00,000 --> 00:00:00,000\nΜετάφραση/); // first notice is first and still carries the text
});

test('first real cue at 0 and no usable gap: two warnings (zero-length notice, and no gap)', () => {
  const r = run([cue(0, 1000, 'a'), ...dense(1500, 700000)]);
  assert.equal(r.notices.length, 1);
  assert.equal(r.warned.length, 2);
});

test('first real cue at 1 ms also gives a zero-length notice (it ends before the cue and cannot go below 0)', () => {
  const r = run([cue(1, 1000, 'a'), cue(9000, 10000, 'b')]);
  assert.deepEqual(r.cues[0], { start: 0, end: 0, text: LABEL });
  assert.equal(r.warned.length, 1);
});

test('empty-text cues are ignored when finding the first real cue, kept in the list, and dropped when written', () => {
  const r = run([cue(300, 900, ''), cue(9000, 10000, 'hi')]);
  assert.equal(r.cues[0].end, 5000); // first real cue is the one at 9 s
  assert.equal(r.cues.length, 3);
  assert.deepEqual(numbers(serializeSrt(r.cues)), [1, 2]);
});

test('input in the wrong order is put in time order; times are never changed; the input is not modified', () => {
  const real = [cue(20000, 21000, 'later'), cue(10000, 11000, 'earlier')];
  const copy = JSON.parse(JSON.stringify(real));
  const r = run(real);
  assert.deepEqual(real, copy);
  assert.deepEqual(realOf(r).map((c) => c.text), ['earlier', 'later']);
  assert.deepEqual(realOf(r).map((c) => [c.start, c.end]), [[10000, 11000], [20000, 21000]]);
});

test('no real cues at all: only the notice, with a warning', () => {
  const r = run([]);
  assert.equal(r.cues.length, 1);
  assert.equal(r.warned.length, 1);
  assert.deepEqual(run([cue(0, 1, ' ')]).cues.length, 2);
});

test('kind and engine reach the notice text (draft, DeepL only)', () => {
  const r = run([cue(10000, 11000)], { kind: 'draft', engine: 'DeepL' });
  assert.match(r.cues[0].text, /Πρόχειρη/);
  assert.match(r.cues[0].text, /AI draft translation \(DeepL\)/);
});

test('the default warn goes through console.warn with a prefix and carries no cue text', () => {
  const seen = [];
  const orig = console.warn;
  console.warn = (...a) => seen.push(a.join(' '));
  try { addLabel([cue(0, 1000, 'secret dialogue')]); } finally { console.warn = orig; }
  assert.equal(seen.length, 2); // zero-length notice + no gap to place the second notice in
  assert.ok(seen.every((m) => m.startsWith('[ai-label] ')));
  assert.ok(seen.every((m) => !m.includes('secret dialogue')));
});

test('entry id: AI is always in it', () => {
  assert.equal(aiEntryId({ imdbId: 'tt0364845', season: 23, episode: 20, state: 'final', release: 'NCIS.S23E20.720p.WEB-DL' }),
    'AI:tt0364845:23:20:final | AI translation from NCIS.S23E20.720p.WEB-DL');
  assert.equal(aiEntryId({ imdbId: 'tt0111161', state: 'draft', release: 'Shawshank' }), 'AI:tt0111161:draft | AI translation from Shawshank');
  assert.equal(AI_ENTRY_LABEL, 'Ελληνικά (AI)');
  assert.match(AI_ENTRY_LABEL, /\bAI\b/);
  const odd = [
    {}, { imdbId: undefined }, { imdbId: 'tt1', release: '' }, { imdbId: 'tt1', release: null }, { imdbId: 'tt1', release: 'x'.repeat(500) },
    { imdbId: 'tt1', release: 'a\nb\r\nc\u0000\t' }, { imdbId: 'tt1', release: 'Греция 你好 😀' }, { imdbId: '../../etc/passwd' }, { imdbId: 'tt1 | evil' },
    { imdbId: 'tt1', season: 'x', episode: NaN }, { imdbId: 'tt1', season: 1, episode: 2, state: 'whatever' }, { imdbId: 'tt1', state: 'final' },
    { imdbId: 'tt1', season: 0, episode: 0 }, { imdbId: 'tt1', season: null, episode: 3 },
  ];
  for (const o of odd) {
    const id = aiEntryId(o);
    assert.match(id, /\bAI\b/, JSON.stringify(o));
    assert.ok(id.startsWith('AI:'), JSON.stringify(o));
    assert.ok(!/[\u0000-\u001f]/.test(id));
    assert.ok(id.length < 200);
  }
});

test('entry id: unknown state counts as draft, bad imdb ids are replaced, the release is cut to 80 characters', () => {
  assert.equal(aiEntryId({ imdbId: 'tt1', state: 'whatever' }), 'AI:tt1:draft | AI translation');
  assert.equal(aiEntryId({ imdbId: '../x' }), 'AI:unknown:draft | AI translation');
  assert.equal(aiEntryId({ imdbId: 'tt1', release: 'x'.repeat(500) }), `AI:tt1:draft | AI translation from ${'x'.repeat(80)}`);
});
