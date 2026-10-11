import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createApp, customer, employee } from './app';

const { customers: C, locations: L, services: S, users: U } = SAMPLE;

let app: INestApplication;
let migrator: Client;

beforeAll(async () => {
  app = await createApp();
  config({ path: path.resolve(__dirname, '../../../.env') });
  migrator = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await migrator.connect();
});
afterAll(async () => {
  // Shared database: leave no schedules or test bookings behind.
  await migrator.query('DELETE FROM core.working_hours');
  await migrator.query('DELETE FROM core.time_off');
  await migrator.query(`DELETE FROM core.appointments WHERE notes_customer = 'schedules test'`);
  await migrator.end();
  await app.close();
});

/** Every day, 09:00–17:00 on the location's clock. */
const allWeek = (location: string) => ({
  location_id: location,
  intervals: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, starts: '09:00', ends: '17:00' })),
});

/** A UTC instant `days` from now at `hour`:00 UTC (16 UTC is midday in New York; 03 UTC is night). */
const at = (days: number, hour: number) => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

describe('working hours', () => {
  it('staff set their own hours at their own location; colleagues can read but not change them', async () => {
    await api(app, employee(U.sam)).put(`/api/staff/${U.sam}/hours`, allWeek(L.nyc)).expect(200);
    const seen = (await api(app, employee(U.lia)).get(`/api/staff/${U.sam}/schedule`).expect(200)).body;
    expect(seen.hours).toHaveLength(7);
    expect(seen.hours[0]).toMatchObject({ location_id: L.nyc, starts: '09:00', ends: '17:00' });
    expect(seen.can_edit).toBe(false);
    expect((await api(app, employee(U.sam)).get(`/api/staff/${U.sam}/schedule`).expect(200)).body.can_edit).toBe(true);

    await api(app, employee(U.lia)).put(`/api/staff/${U.sam}/hours`, allWeek(L.nyc)).expect(403);
    await api(app, employee(U.sam)).put(`/api/staff/${U.sam}/hours`, allWeek(L.la)).expect(403); // Sam does not work in LA
    await api(app, employee(U.ada)).put(`/api/staff/${U.lia}/hours`, allWeek(L.la)).expect(200); // admins change anyone's
    await api(app, customer(C.maria)).get(`/api/staff/${U.sam}/schedule`).expect(403);
  });

  it('rejects overlapping or backwards intervals', async () => {
    const bad = { location_id: L.nyc, intervals: [{ weekday: 1, starts: '09:00', ends: '13:00' }, { weekday: 1, starts: '12:00', ends: '17:00' }] };
    await api(app, employee(U.sam)).put(`/api/staff/${U.sam}/hours`, bad).expect(400);
    await api(app, employee(U.sam)).put(`/api/staff/${U.sam}/hours`, { location_id: L.nyc, intervals: [{ weekday: 1, starts: '17:00', ends: '09:00' }] }).expect(400);
  });
});

describe('time off', () => {
  it('shows the reason only to the owner and admins; only they can remove it', async () => {
    const off = (await api(app, employee(U.sam)).post(`/api/staff/${U.sam}/time-off`, { starts_at: at(20, 0), ends_at: at(22, 0), reason: 'Dentist' }).expect(201)).body;
    const forLia = (await api(app, employee(U.lia)).get(`/api/staff/${U.sam}/schedule`).expect(200)).body;
    expect(forLia.time_off).toEqual([expect.objectContaining({ id: off.id, reason: null })]);
    const forAda = (await api(app, employee(U.ada)).get(`/api/staff/${U.sam}/schedule`).expect(200)).body;
    expect(forAda.time_off[0].reason).toBe('Dentist');

    await api(app, employee(U.lia)).post(`/api/staff/${U.sam}/time-off`, { starts_at: at(20, 0), ends_at: at(21, 0) }).expect(403);
    await api(app, employee(U.lia)).delete(`/api/time-off/${off.id}`).expect(404);
    await api(app, employee(U.sam)).delete(`/api/time-off/${off.id}`).expect(204);
  });
});

describe('booking and the calendar', () => {
  const book = (start: string, confirm = false) =>
    api(app, employee(U.ada)).post('/api/appointments', {
      customer_id: C.maria,
      service_id: S.haircut,
      location_id: L.nyc,
      employee_id: U.sam,
      scheduled_start: start,
      notes_customer: 'schedules test',
      ...(confirm ? { confirm_overlap: true } : {}),
    });

  it('warns when booking outside working hours or during time off; confirm_overlap books anyway', async () => {
    await api(app, employee(U.sam)).put(`/api/staff/${U.sam}/hours`, allWeek(L.nyc)).expect(200);
    const night = await book(at(12, 3)).expect(409);
    expect(night.body).toMatchObject({ code: 'employee_unavailable', reasons: ['outside_hours'] });
    await book(at(12, 3), true).expect(201);
    await book(at(13, 16)).expect(201); // midday in New York

    await api(app, employee(U.sam)).post(`/api/staff/${U.sam}/time-off`, { starts_at: at(14, 0), ends_at: at(15, 0) }).expect(201);
    const off = await book(at(14, 16)).expect(409);
    expect(off.body.reasons).toContain('time_off');
  });

  it('puts working hours and time off on the calendar', async () => {
    const from = encodeURIComponent(at(13, 0));
    const to = encodeURIComponent(at(16, 0));
    const cal = (await api(app, employee(U.lia)).get(`/api/appointments/calendar?from=${from}&to=${to}&employee_id=${U.sam}`).expect(200)).body;
    expect(cal.shifts.length).toBeGreaterThanOrEqual(3);
    for (const s of cal.shifts) expect(s).toMatchObject({ employee_id: U.sam, location_id: L.nyc });
    // 09:00–17:00 in New York is 8 hours.
    expect(Date.parse(cal.shifts[0].ends_at) - Date.parse(cal.shifts[0].starts_at)).toBe(8 * 3_600_000);
    expect(cal.time_off).toEqual([expect.objectContaining({ employee_id: U.sam, reason: null })]);
  });
});
