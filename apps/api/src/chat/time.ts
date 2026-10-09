/**
 * Time zone helpers without dependencies (Intl only). Relative dates in questions ("tomorrow",
 * "last month") are resolved on the server in the principal's time zone, never by the model
 * (plan.md §5.2 step 4).
 */

export interface DateRange {
  from: string; // ISO instant (inclusive)
  to: string; // ISO instant (exclusive)
  label: string;
}

/** Offset of `tz` from UTC at `instant`, in minutes (e.g. -240 for New York in summer). */
export function offsetMinutes(instant: Date, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/** Local calendar date (y, m 1-12, d) of `instant` in `tz`. */
export function localDate(instant: Date, tz: string): { y: number; m: number; d: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { y: +parts.year, m: +parts.month, d: +parts.day, weekday };
}

/** UTC instant of local midnight for the calendar date (y, m, d) in `tz` (DST-safe). */
export function zonedMidnight(y: number, m: number, d: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d);
  let instant = guess - offsetMinutes(new Date(guess), tz) * 60_000;
  // Re-check once: the offset can differ at the corrected instant around DST changes.
  instant = guess - offsetMinutes(new Date(instant), tz) * 60_000;
  return new Date(instant);
}

function addDays(y: number, m: number, d: number, days: number) {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Finds a relative date expression in `text` and returns the matching range in `tz`.
 * Returns undefined when the question has no date expression.
 */
export function parseRelativeRange(text: string, tz: string, now = new Date()): DateRange | undefined {
  const t = text.toLowerCase();
  const today = localDate(now, tz);
  const day = (offset: number, label: string, length = 1): DateRange => {
    const a = addDays(today.y, today.m, today.d, offset);
    const b = addDays(a.y, a.m, a.d, length);
    return { from: zonedMidnight(a.y, a.m, a.d, tz).toISOString(), to: zonedMidnight(b.y, b.m, b.d, tz).toISOString(), label };
  };
  const month = (offset: number, label: string): DateRange => {
    const first = new Date(Date.UTC(today.y, today.m - 1 + offset, 1));
    const next = new Date(Date.UTC(today.y, today.m + offset, 1));
    return {
      from: zonedMidnight(first.getUTCFullYear(), first.getUTCMonth() + 1, 1, tz).toISOString(),
      to: zonedMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, 1, tz).toISOString(),
      label,
    };
  };
  // Weeks start on Monday.
  const mondayOffset = -((today.weekday + 6) % 7);

  if (/\btoday\b|\btonight\b/.test(t)) return day(0, 'today');
  if (/\btomorrow\b/.test(t)) return day(1, 'tomorrow');
  if (/\byesterday\b/.test(t)) return day(-1, 'yesterday');
  if (/\bnext week\b/.test(t)) return day(mondayOffset + 7, 'next week', 7);
  if (/\blast week\b|\bprevious week\b/.test(t)) return day(mondayOffset - 7, 'last week', 7);
  if (/\bthis week\b/.test(t)) return day(mondayOffset, 'this week', 7);
  if (/\bnext month\b/.test(t)) return month(1, 'next month');
  if (/\blast month\b|\bprevious month\b/.test(t)) return month(-1, 'last month');
  if (/\bthis month\b/.test(t)) return month(0, 'this month');

  const weekday = WEEKDAYS.findIndex((w) => new RegExp(`\\b(on |this |next )?${w}\\b`).test(t));
  if (weekday >= 0) {
    let offset = (weekday - today.weekday + 7) % 7;
    if (new RegExp(`\\bnext ${WEEKDAYS[weekday]}\\b`).test(t) && offset < 7) offset += offset === 0 ? 7 : 0;
    return day(offset, WEEKDAYS[weekday]);
  }
  return undefined;
}

/** "Fri, Oct 10, 3:00 PM EDT" in the given zone (answers always label the zone). */
export function formatLocal(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso));
}
