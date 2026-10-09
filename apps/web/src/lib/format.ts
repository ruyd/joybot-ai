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

/** Time of day in a given IANA zone with the zone shown, e.g. "9:30 AM EDT". */
export function time(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' }).format(new Date(iso));
}

/**
 * The instant at which the wall clock in `timeZone` reads `day` ('YYYY-MM-DD') `clock` ('HH:MM'), as ISO.
 * For booking at a location in another zone than the viewer's. A time skipped by a DST change moves forward.
 */
export function zonedToIso(day: string, clock: string, timeZone: string): string {
  const [y, mo, d] = day.split('-').map(Number);
  const [h, mi] = clock.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const offset = (at: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
        .formatToParts(new Date(at))
        .map((x) => [x.type, Number(x.value)]),
    );
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - at;
  };
  // Two passes settle the offset on either side of a DST change.
  let at = wall - offset(wall);
  at = wall - offset(at);
  return new Date(at).toISOString();
}

/** Today's date ('YYYY-MM-DD') on the wall clock in `timeZone`. */
export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
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
