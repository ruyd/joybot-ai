import type { Evidence } from './tools';

/**
 * Checks the model's answer against the records it was given. Without a
 * thinking step Gemma 4 E2B occasionally fills in plausible details ("a massage on 2023-10-27 at
 * 10:00 AM") that no record contains. Years, clock times, amounts and record numbers are easy to
 * check exactly: each one in the answer must appear in a record (or in the question itself).
 * Returns the facts that do not; an empty list means the answer passes.
 */
export function ungroundedFacts(answer: string, evidence: Evidence[], question: string): string[] {
  const source = [question, ...evidence.flatMap((e) => [e.id, e.title, ...Object.values(e.fields).map((v) => (v == null ? '' : String(v)))])].join('\n');
  const sourceLower = source.toLowerCase();
  const amounts = new Set([...source.matchAll(MONEY)].map((m) => amount(m[0])));
  const times = new Set([...source.matchAll(CLOCK)].flatMap((m) => [clock(m), clock(m, false)]));
  const out: string[] = [];

  for (const m of answer.matchAll(MONEY)) if (!amounts.has(amount(m[0]))) out.push(m[0]);
  for (const m of answer.matchAll(CLOCK)) if (!times.has(clock(m))) out.push(m[0]);
  for (const m of answer.matchAll(YEAR)) if (!source.includes(m[0])) out.push(m[0]);
  for (const m of answer.matchAll(RECORD_NUMBER)) if (!sourceLower.includes(m[0].toLowerCase())) out.push(m[0]);
  return [...new Set(out)];
}

const MONEY = /[$€£]\s?\d[\d,]*(?:\.\d{1,2})?/g;
const CLOCK = /\b(\d{1,2}):(\d{2})(?:\s*([ap])\.?m\.?)?/gi;
const YEAR = /\b(?:19|20)\d{2}\b/g;
const RECORD_NUMBER = /\b[ACPO]-\d{4,}(?:-\d+)?\b|#\d{3,}\b/gi;

const amount = (s: string) => Number(s.replace(/[^\d.]/g, '')).toFixed(2);

/** "9:05 PM" → "9:05p"; without the meridiem when `withMeridiem` is false or none was written. */
function clock(m: RegExpMatchArray, withMeridiem = true): string {
  const base = `${Number(m[1])}:${m[2]}`;
  return withMeridiem && m[3] ? `${base}${m[3].toLowerCase()}` : base;
}
