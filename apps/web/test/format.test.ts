import { describe, expect, it } from 'vitest';
import { date, dateTime, money } from '../src/lib/format';

describe('date', () => {
  it('shows calendar dates as the same day in every time zone', () => {
    const formatted = date('2026-09-29');
    expect(formatted).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(2026, 8, 29)));
    expect(formatted).toMatch(/29/);
  });
});

describe('dateTime', () => {
  it('formats an instant in a given zone with the zone shown', () => {
    const out = dateTime('2026-10-10T19:00:00Z', 'America/New_York');
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/3:00/);
    expect(out).toMatch(/EDT|GMT-4/);
  });
  it('works without an explicit zone and for missing values', () => {
    expect(() => dateTime('2026-10-10T19:00:00Z')).not.toThrow();
    expect(dateTime(null)).toBe('—');
  });
});

describe('money', () => {
  it('formats amounts in their currency', () => {
    expect(money('50', 'USD')).toMatch(/50\.00/);
    expect(money(null)).toBe('—');
  });
});
