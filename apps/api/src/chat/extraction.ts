/**
 * Deterministic identifier extraction (plan.md §5.2 step 2): exact identifiers by pattern, plus
 * likely person/organization names. Gemma 4 is only asked when nothing is found here.
 */

export interface Identifiers {
  emails: string[];
  phones: string[];
  customerNumbers: string[];
  orgNumbers: string[];
  appointmentNumbers: string[];
  paymentNumbers: string[];
  names: string[];
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+\d[\d\s().-]{7,}\d)|(?:\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b)/g;
const CUSTOMER_NO = /\bC-\d{4,}\b/gi;
const ORG_NO = /\bO-\d{3,}\b/gi;
const APPOINTMENT_NO = /\bA-\d{4}-\d{4,}\b/gi;
const PAYMENT_NO = /\bP-\d{4}-\d{4,}\b/gi;

// Capitalized words that start questions or are product words, never names.
const NOT_NAMES = new Set(
  (
    'I Me My We Our You Your He She They It What When Where Which Who Whom Why How Is Are Was Were Do Does Did ' +
    'Can Could Would Should Will Show List Find Get Give Tell Please Hi Hello Hey Thanks The A An And Or For Of ' +
    'To From In On At By With About Any All Next Last This That These Those Today Tomorrow Yesterday ' +
    'Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July ' +
    'August September October November December Payment Payments Appointment Appointments Customer Customers ' +
    'Organization Organizations Service Services Balance Schedule Ticket Tickets Stripe POS JoyBot Unpaid Pending'
  ).split(' '),
);

const unique = <T>(xs: T[]) => [...new Set(xs)];

/** E.164 for US-style numbers; keeps explicit international numbers. */
export function normalizePhone(raw: string, defaultCountryCode = '1'): string | undefined {
  const plus = raw.trim().startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (plus) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : undefined;
  if (digits.length === 10) return `+${defaultCountryCode}${digits}`;
  if (digits.length === 11 && digits.startsWith(defaultCountryCode)) return `+${digits}`;
  return undefined;
}

export function extractIdentifiers(text: string): Identifiers {
  const withoutEmails = text.replace(EMAIL, ' ');
  const names: string[] = [];
  // "Maria Lopez's …", "for Acme Corp", "customer John Smith": runs of 1–3 capitalized words.
  for (const m of withoutEmails.matchAll(/\b([A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+){0,2})/g)) {
    const words = m[1]
      .replace(/['’]s$/, '')
      .split(/\s+/)
      .filter((w) => !NOT_NAMES.has(w.replace(/['’]s$/, '')));
    if (words.length > 0 && words.join(' ').length >= 3) names.push(words.join(' ').replace(/['’]s$/, ''));
  }
  return {
    emails: unique((text.match(EMAIL) ?? []).map((e) => e.toLowerCase())),
    phones: unique((withoutEmails.match(PHONE) ?? []).map((p) => normalizePhone(p)).filter((p): p is string => !!p)),
    customerNumbers: unique((text.match(CUSTOMER_NO) ?? []).map((x) => x.toUpperCase())),
    orgNumbers: unique((text.match(ORG_NO) ?? []).map((x) => x.toUpperCase())),
    appointmentNumbers: unique((text.match(APPOINTMENT_NO) ?? []).map((x) => x.toUpperCase())),
    paymentNumbers: unique((text.match(PAYMENT_NO) ?? []).map((x) => x.toUpperCase())),
    names: unique(names),
  };
}

export function hasIdentifiers(ids: Identifiers): boolean {
  return Object.values(ids).some((list) => list.length > 0);
}
