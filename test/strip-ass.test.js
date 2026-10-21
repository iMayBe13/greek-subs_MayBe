import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import AdmZip from 'adm-zip';
import { stripAssTags, toUtf8 } from '../src/lib/encoding.js';

// Real lines from the GreekSubs S23 pack (NCIS E19 and E20)
test('real E19/E20 lines lose {\\an5} and keep their text', () => {
  assert.equal(stripAssTags('{\\an5}Νάτος.'), 'Νάτος.');
  assert.equal(stripAssTags('{\\an5}Επιτέλους βγήκες από το νοσοκομείο.'), 'Επιτέλους βγήκες από το νοσοκομείο.');
  assert.equal(stripAssTags('{\\an5}Να σου φέρω κάτι;'), 'Να σου φέρω κάτι;');
  assert.equal(stripAssTags('{\\an5}Η αστυνομία λέει ότι το όχημα ανήκει στον'), 'Η αστυνομία λέει ότι το όχημα ανήκει στον');
  assert.equal(stripAssTags('{\\an5}Δούλευε στο Ναυτικό'), 'Δούλευε στο Ναυτικό');
});

test('all common override forms are removed', () => {
  for (const [a, b] of [
    ['{\\an1}x', 'x'], ['{\\an9}x', 'x'], ['{an5}x', 'x'], ['{AN8}x', 'x'],
    ['{\\pos(192,240)}x', 'x'], ['{\\i1}x{\\i0}', 'x'], ['{\\b1}x{\\b0}', 'x'],
    ['{\\c&H00FFFF&}x', 'x'], ['{\\an8\\pos(10,20)\\i1}x', 'x'], ['{\\an5}{\\i1}x', 'x'],
  ]) assert.equal(stripAssTags(a), b, a);
});

test('normal tags and real dialogue in braces are untouched', () => {
  for (const s of [
    '<i>Καλημέρα</i>', '<b>ΠΡΟΣΟΧΗ</b>', '<font color="#ffff00">Γεια</font>',
    '{μουσική}', '[μουσική]', '{music}', '{an}', '{an10}', 'Είπε {κάτι} εδώ', '(Γελάει)',
  ]) assert.equal(stripAssTags(s), s, s);
  assert.equal(stripAssTags('<i>{\\an8}Γεια</i>'), '<i>Γεια</i>');
});

test('a line that held only a tag is dropped, not left blank (blank = end of subtitle block)', () => {
  assert.equal(stripAssTags('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}\nΓεια σου\n\n2\n...'),
    '1\n00:00:01,000 --> 00:00:02,000\nΓεια σου\n\n2\n...');
  assert.equal(stripAssTags('a\n\nb'), 'a\n\nb'); // genuine blank lines stay
});

test('idempotent', () => {
  const once = stripAssTags('{\\an5}Νάτος.\n{\\pos(1,2)}Ναι');
  assert.equal(stripAssTags(once), once);
});

// The raw zip is git-ignored (third-party content): skip, don't fail, when it is not on disk.
const packUrl = new URL('./fixtures/greeksubs/pack-s23-download.zip', import.meta.url);
test('real S23 pack: E19 changes 25 lines, E20 changes 2, nothing else differs',
  { skip: !fs.existsSync(packUrl) && 'test/fixtures/greeksubs/pack-s23-download.zip not present' }, () => {
  const zip = new AdmZip(fs.readFileSync(packUrl));
  const read = (re) => {
    const e = zip.getEntries().find((x) => re.test(x.entryName));
    return toUtf8(e.getData()).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  };
  for (const [re, changed] of [[/S23E19/, 25], [/S23E20/, 2], [/S23E17/, 0]]) {
    const before = read(re), after = stripAssTags(before);
    const b = before.split('\n'), a = after.split('\n');
    assert.equal(a.length, b.length, 'no line added or removed');
    const diffs = b.map((l, i) => [l, a[i]]).filter(([x, y]) => x !== y);
    assert.equal(diffs.length, changed);
    for (const [x, y] of diffs) assert.equal(y, x.replace(/^\{\\an5\}/, ''), 'only the tag was removed');
    assert.ok(!/\{\\/.test(after));
  }
});
