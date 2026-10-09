import { describe, expect, it } from 'vitest';
import { date, dateTime, money, zonedToIso } from '../src/lib/format';

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

describe('zonedToIso', () => {
  it('reads the time on the location’s wall clock, whatever the viewer’s zone', () => {
    expect(zonedToIso('2026-10-09', '09:30', 'America/New_York')).toBe('2026-10-09T13:30:00.000Z');
    expect(zonedToIso('2026-10-09', '09:30', 'America/Los_Angeles')).toBe('2026-10-09T16:30:00.000Z');
    expect(zonedToIso('2026-01-15', '09:30', 'America/New_York')).toBe('2026-01-15T14:30:00.000Z');
  });

  it('handles the days clocks change', () => {
    // 2026-03-08: 02:00 → 03:00 in New York; 2026-11-01: 02:00 → 01:00.
    expect(zonedToIso('2026-03-08', '03:30', 'America/New_York')).toBe('2026-03-08T07:30:00.000Z');
    expect(zonedToIso('2026-03-08', '01:30', 'America/New_York')).toBe('2026-03-08T06:30:00.000Z');
    expect(zonedToIso('2026-11-01', '09:00', 'America/New_York')).toBe('2026-11-01T14:00:00.000Z');
  });
});
