// Greek subtitle files circulate as UTF-8, UTF-16, Windows-1253 or ISO-8859-7.
// Stremio players want UTF-8, so every file is normalized here.
import iconv from 'iconv-lite';

export function toUtf8(buf) {
  // BOMs
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return iconv.decode(buf.subarray(2), 'utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return iconv.decode(buf.subarray(2), 'utf16be');

  // Strict UTF-8 first: if it decodes cleanly, it is UTF-8.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch { /* not utf-8 */ }

  // Legacy Greek. cp1253 and ISO-8859-7 differ in a few bytes; try cp1253 first
  // and fall back to 8859-7 if the result has no Greek letters.
  const hasGreek = (s) => /[\u0370-\u03FF]/.test(s);
  const a = iconv.decode(buf, 'win1253');
  if (hasGreek(a)) return a;
  const b = iconv.decode(buf, 'iso-8859-7');
  return hasGreek(b) ? b : a;
}

// Old subtitles type the accent as a separate character before the vowel: ΄Ηταν, ´Ηταν -> Ήταν.
const ACCENTED = { α: 'ά', ε: 'έ', η: 'ή', ι: 'ί', ο: 'ό', υ: 'ύ', ω: 'ώ', Α: 'Ά', Ε: 'Έ', Η: 'Ή', Ι: 'Ί', Ο: 'Ό', Υ: 'Ύ', Ω: 'Ώ' };
export function fixOldAccents(text) {
  return text.replace(/[΄´]([ΑΕΗΙΟΥΩαεηιουω])/g, (_, v) => ACCENTED[v]);
}

// ASS/SSA override blocks that leak into some .srt files: {\an5} {\pos(10,20)} {\i1} {\b1} {\c&H00FFFF&} and {an5}.
// Only these are removed. <i>, <b>, <font> and real dialogue in braces ("{music}") are left alone.
const ASS_BLOCK = /\{\\[^}\n]*\}|\{an?[1-9]\}/gi;
export function stripAssTags(text) {
  return text
    .split('\n')
    .flatMap((line) => {
      if (!line.includes('{')) return [line];
      const out = line.replace(ASS_BLOCK, '');
      // A line that held only tags must not become a blank line: a blank line ends the subtitle block in .srt.
      return out === line ? [line] : out.trim() === '' ? [] : [out];
    })
    .join('\n');
}

export const looksGreek = (text) => (text.match(/[\u0370-\u03FF]/g) || []).length > 20;
