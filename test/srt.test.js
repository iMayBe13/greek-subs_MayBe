import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSrt, splitFormatting, restoreItalics, formatTimestamp, serializeSrt } from '../src/lib/srt.js';

const SAMPLE = '﻿1\r\n00:00:01,000 --> 00:00:03,500\r\nHello there.\r\nSecond line.\r\n\r\n2\r\n00:01:02.250 --> 00:01:04.000\r\n<i>Whisper.</i>\r\n\r\nnot a cue at all\r\n\r\n3\r\n01:00:00,005 --> 01:00:01,000\r\nLate.\r\n';

test('parseSrt: times in ms, raw text kept with its line break, BOM and CRLF handled, junk blocks skipped', () => {
  const cues = parseSrt(SAMPLE);
  assert.deepEqual(cues, [
    { start: 1000, end: 3500, raw: 'Hello there.\nSecond line.' },
    { start: 62250, end: 64000, raw: '<i>Whisper.</i>' },
    { start: 3600005, end: 3601000, raw: 'Late.' },
  ]);
});

test('parseSrt: a short millisecond field is padded (",5" is 500 ms)', () => {
  assert.equal(parseSrt('1\n00:00:01,5 --> 00:00:02,25\nx\n')[0].start, 1500);
  assert.equal(parseSrt('1\n00:00:01,5 --> 00:00:02,25\nx\n')[0].end, 2250);
});

test('formatTimestamp', () => {
  assert.equal(formatTimestamp(0), '00:00:00,000');
  assert.equal(formatTimestamp(3723004), '01:02:03,004');
  assert.equal(formatTimestamp(-50), '00:00:00,000');
  assert.equal(formatTimestamp(1999.6), '00:00:02,000');
});

test('serializeSrt: numbered from 1, blank line between cues, \\n only, trailing newline', () => {
  const out = serializeSrt([{ start: 1000, end: 2000, text: 'a' }, { start: 3000, end: 4500, text: 'b\nc' }]);
  assert.equal(out, '1\n00:00:01,000 --> 00:00:02,000\na\n\n2\n00:00:03,000 --> 00:00:04,500\nb\nc\n');
  assert.ok(!out.includes('\r'));
});

test('serializeSrt: empty cues are dropped without a gap in the numbering; blank lines inside a cue are removed', () => {
  const out = serializeSrt([
    { start: 0, end: 1, text: 'one' }, { start: 2, end: 3, text: '  ' }, { start: 4, end: 5, text: '' },
    { start: 6, end: 7, text: 'two\n\n\nthree\r\nfour  ' },
  ]);
  const blocks = out.trim().split('\n\n');
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => b.split('\n')[0]), ['1', '2']);
  assert.equal(blocks[1].split('\n').slice(2).join('|'), 'two|three|four');
  assert.equal(serializeSrt([]), '');
  assert.equal(serializeSrt([{ start: 0, end: 1, text: '' }]), '');
});

test('serializeSrt: an end time before the start is raised to the start', () => {
  assert.match(serializeSrt([{ start: 5000, end: 4000, text: 'x' }]), /00:00:05,000 --> 00:00:05,000/);
});

test('serialize then parse gives the same cues back (Greek text included)', () => {
  const cues = [{ start: 1200, end: 2500, text: 'Καλημέρα.\nΤι κάνεις;' }, { start: 61000, end: 62000, text: '<i>Ναι.</i>' }];
  const back = parseSrt(serializeSrt(cues));
  assert.deepEqual(back.map((c) => [c.start, c.end, c.raw]), cues.map((c) => [c.start, c.end, c.text]));
});

test('splitFormatting: tags and ASS blocks are stripped, plain text and line structure kept', () => {
  const r = splitFormatting('{\\an8}<font color="red"><b>Hello</b></font>\nthere <u>friend</u>');
  assert.equal(r.plain, 'Hello\nthere friend');
  assert.deepEqual(r.italic, { whole: false, lines: [false, false] });
  assert.equal(r.partialItalic, false);
});

test('splitFormatting: whole italic cue, italic on one line, and italic on part of a line', () => {
  assert.deepEqual(splitFormatting('<i>Both\nlines</i>').italic, { whole: true, lines: [true, true] });
  assert.deepEqual(splitFormatting('<i>Narrator:</i>\nspoken').italic, { whole: false, lines: [true, false] });
  const mixed = splitFormatting('He said <i>never</i> again');
  assert.equal(mixed.plain, 'He said never again');
  assert.equal(mixed.partialItalic, true);
});

test('splitFormatting: a cue holding only tags becomes empty text', () => {
  assert.equal(splitFormatting('{\\an8}').plain, '');
  assert.equal(splitFormatting('<i></i>').plain, '');
});

test('restoreItalics: whole, per line, nothing to restore, and a layout that cannot be mapped', () => {
  assert.deepEqual(restoreItalics('Ψιθυρίζει', splitFormatting('<i>Whisper</i>').italic), { text: '<i>Ψιθυρίζει</i>', restored: true });
  const two = splitFormatting('<i>Narrator:</i>\nspoken').italic;
  assert.deepEqual(restoreItalics('Αφηγητής:\nμιλάει', two), { text: '<i>Αφηγητής:</i>\nμιλάει', restored: true });
  assert.deepEqual(restoreItalics('Απλό', splitFormatting('Plain').italic), { text: 'Απλό', restored: true });
  assert.deepEqual(restoreItalics('Μία γραμμή', two), { text: 'Μία γραμμή', restored: false }); // line count changed: left without tags
});

test('prepare -> translate by index -> restore -> serialize keeps every timestamp', () => {
  const src = '1\n00:00:05,000 --> 00:00:06,000\n<i>Hello.</i>\n\n2\n00:00:07,000 --> 00:00:09,000\n{\\an8}Bye\nnow.\n';
  const prepared = parseSrt(src).map((c) => ({ start: c.start, end: c.end, ...splitFormatting(c.raw) }));
  const greek = ['Γεια.', 'Αντίο\nτώρα.'];
  const out = serializeSrt(prepared.map((c, i) => ({ start: c.start, end: c.end, text: restoreItalics(greek[i], c.italic).text })));
  assert.equal(out, '1\n00:00:05,000 --> 00:00:06,000\n<i>Γεια.</i>\n\n2\n00:00:07,000 --> 00:00:09,000\nΑντίο\nτώρα.\n');
});
