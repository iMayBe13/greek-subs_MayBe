// SRT helpers shared by the server and the AI pipeline.
//   parseSrt          text -> [{ start, end, raw }]             (times in ms; raw = the cue text exactly as in the file, trimmed)
//   splitFormatting   raw  -> { plain, italic, partialItalic }   strip tags before translating
//   restoreItalics    translated text + italic info -> { text, restored }   put <i> back afterwards
//   serializeSrt      [{ start, end, text }] -> SRT text, numbered 1..N in the order given, empty cues dropped
import { stripAssTags } from './encoding.js';

// ---------- parse ----------
export function parseSrt(text) {
  const cues = [];
  for (const block of text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const m = lines[ti].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) continue;
    const ms = (h, mi, s, f) => ((+h * 60 + +mi) * 60 + +s) * 1000 + +f.padEnd(3, '0').slice(0, 3);
    cues.push({ start: ms(m[1], m[2], m[3], m[4]), end: ms(m[5], m[6], m[7], m[8]), raw: lines.slice(ti + 1).join('\n').trim() });
  }
  return cues;
}

// ---------- formatting: strip before translating, restore <i> afterwards ----------
const FMT_TAG = /<\/?(?:i|b|u|s|font)(?:\s[^>]*)?>/gi;

/** -> { plain, italic: { whole, lines: boolean[] }, partialItalic } ; ASS blocks like {\an8} are dropped. */
export function splitFormatting(raw) {
  const text = stripAssTags(raw);
  const oneItalicPair = (t) => (t.match(/<i>/gi) || []).length === 1 && (t.match(/<\/i>/gi) || []).length === 1;
  const whole = /^\s*<i>[\s\S]*<\/i>\s*$/i.test(text) && oneItalicPair(text);
  const lines = text.split('\n').map((l) => ({
    t: l.replace(FMT_TAG, '').trim(),
    it: whole || (/^\s*<i>.*<\/i>\s*$/i.test(l) && oneItalicPair(l)),
    mixed: !whole && /<\/?i>/i.test(l) && !(/^\s*<i>.*<\/i>\s*$/i.test(l) && oneItalicPair(l)),
  })).filter((l) => l.t);
  return {
    plain: lines.map((l) => l.t).join('\n'),
    italic: { whole, lines: lines.map((l) => l.it) },
    partialItalic: lines.some((l) => l.mixed),
  };
}

/** Put <i> back around the translated text. Returns { text, restored } (restored=false if the layout could not be mapped). */
export function restoreItalics(translated, italic) {
  if (!italic.lines.some(Boolean)) return { text: translated, restored: true };
  if (italic.whole || italic.lines.every(Boolean)) return { text: `<i>${translated}</i>`, restored: true };
  const tl = translated.split('\n');
  if (tl.length === italic.lines.length) return { text: tl.map((l, i) => (italic.lines[i] ? `<i>${l}</i>` : l)).join('\n'), restored: true };
  return { text: translated, restored: false };
}

// ---------- serialise ----------
const pad = (x, w = 2) => String(x).padStart(w, '0');

/** ms -> "HH:MM:SS,mmm" (negative values become 0). */
export function formatTimestamp(ms) {
  const t = Math.max(0, Math.round(Number(ms) || 0));
  return `${pad(Math.floor(t / 3600000))}:${pad(Math.floor((t % 3600000) / 60000))}:${pad(Math.floor((t % 60000) / 1000))},${pad(t % 1000, 3)}`;
}

/**
 * cues: [{ start, end, text }] in the order they should appear. Writes UTF-8 text with \n line ends, numbered 1..N.
 * A cue whose text is empty is dropped (the numbering stays gapless). Blank lines inside a cue are removed, because
 * a blank line would end the cue in an .srt file. An end time before the start time is raised to the start time.
 */
export function serializeSrt(cues) {
  const blocks = [];
  for (const c of cues) {
    const text = String(c.text ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '').join('\n');
    if (!text) continue;
    blocks.push(`${blocks.length + 1}\n${formatTimestamp(c.start)} --> ${formatTimestamp(Math.max(c.end, c.start))}\n${text}`);
  }
  return blocks.length ? blocks.join('\n\n') + '\n' : '';
}
