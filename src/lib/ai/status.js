// The status subtitle: one cue over the whole video that says, in Greek and English, what the AI translation is doing
// and what to do next. All the wording lives here so it can be changed in one place (it may need another action on Android).
// Nothing in this file logs anything or sees a key.
import { serializeSrt } from '../srt.js';

export const STATUS_FALLBACK_END_MS = 3 * 3600 * 1000; // the end of the video is not known: three hours is longer than any film

const AGAIN_EL = 'Διάλεξε ξανά τον υπότιτλο σε 1 λεπτό.';
const AGAIN_EN = 'Pick this subtitle again in a minute.';

// kind -> [Greek, English]; pct is a whole number 0..100
const TEXTS = {
  running: (pct) => [`Μετάφραση AI σε εξέλιξη: ${pct}%. ${AGAIN_EL}`, `AI translation in progress: ${pct}%. ${AGAIN_EN}`],
  queued: () => [`Η μετάφραση AI περιμένει σειρά. ${AGAIN_EL}`, `The AI translation is waiting for its turn. ${AGAIN_EN}`],
  busy: () => ['Τρέχουν ήδη πολλές μεταφράσεις AI. Δοκίμασε ξανά αργότερα.', 'AI translation is busy right now. Try again later.'],
  user_cap: () => ['Έφτασες το ημερήσιο όριο μεταφράσεων AI. Δοκίμασε ξανά αύριο.', 'You reached the daily limit of AI translations. Try again tomorrow.'],
  global_cap: () => ['Η μετάφραση AI έφτασε το ημερήσιο όριό της. Δοκίμασε ξανά αύριο.', 'AI translation reached its daily limit. Try again tomorrow.'],
  writes: () => ['Η μετάφραση AI δεν ξεκινά νέες εργασίες σήμερα. Δοκίμασε ξανά αύριο.', 'AI translation is not starting new jobs today. Try again tomorrow.'],
  nokeys: () => ['Δεν υπάρχει διαθέσιμη μετάφραση AI και αυτός ο σύνδεσμος δεν έχει κλειδιά AI.', 'No AI translation is available yet, and this install link has no AI keys.'],
  failed: () => ['Η μετάφραση AI δεν ολοκληρώθηκε. Δοκίμασε ξανά σε λίγο.', 'The AI translation could not be made. Try again in a bit.'],
  error: () => ['Η μετάφραση AI δεν είναι διαθέσιμη αυτή τη στιγμή. Δοκίμασε ξανά σε λίγο.', 'AI translation is not available right now. Try again in a bit.'],
};

/** The status .srt for a kind from TEXTS ('running', 'queued', 'busy', 'user_cap', 'global_cap', 'writes', 'nokeys', 'failed', 'error'). */
export function statusSrt(kind, { pct = 0, endMs } = {}) {
  const make = TEXTS[kind] || TEXTS.error;
  const p = Math.min(100, Math.max(0, Math.round(Number(pct) || 0)));
  const end = Number.isFinite(endMs) && endMs > 1000 ? endMs : STATUS_FALLBACK_END_MS;
  return serializeSrt([{ start: 0, end, text: make(p).join('\n') }]);
}
