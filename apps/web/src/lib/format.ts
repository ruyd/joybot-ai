export function money(amount: string | number | null | undefined, currency = 'USD'): string {
  if (amount === null || amount === undefined) return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(amount));
}

/** Date/time in a given IANA zone with the zone shown (e.g. a location's zone). */
export function dateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '—';
  // dateStyle/timeStyle cannot be combined with timeZoneName, so spell the fields out.
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(new Date(iso));
}

export function date(value: string | null | undefined): string {
  if (!value) return '—';
  // Calendar dates ('YYYY-MM-DD') must not shift with the viewer's time zone.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(d);
}

export const METHOD_LABEL: Record<string, string> = {
  card_online: 'Card (online)',
  card_pos: 'Card (in person)',
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
  wallet: 'Wallet',
  other: 'Other',
};

export function fullName(p: { first_name?: string | null; last_name?: string | null; customer_number?: string }): string {
  return [p.first_name, p.last_name].filter(Boolean).join(' ') || p.customer_number || 'Unnamed';
}
