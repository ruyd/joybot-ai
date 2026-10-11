import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createApp, customer, employee } from './app';

const { appointments: A, customers: C, locations: L, users: U } = SAMPLE;

let app: INestApplication;

beforeAll(async () => {
  app = await createApp();
});
afterAll(async () => {
  await app.close();
});

type Calendar = {
  appointments: { id: string; employee_id: string | null; status: string }[];
  busy: Record<string, unknown>[];
  staff: { id: string; first_name: string }[];
};

/** The next week: Maria's, Jane's (Sam, NYC), Pat's (Lia, LA) and Victor's (no staff) bookings. */
const week = () => {
  const from = new Date();
  const to = new Date(from.getTime() + 7 * 86_400_000);
  return `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
};

describe('calendar', () => {
  it('admins see every booking in the range, with no busy blocks left to hide', async () => {
    const cal: Calendar = (await api(app, employee(U.ada)).get(`/api/appointments/calendar?${week()}`).expect(200)).body;
    expect(cal.appointments.map((a) => a.id)).toEqual(expect.arrayContaining([A.mariaNext, A.janeNext, A.patNext, A.victorNext]));
    expect(cal.appointments.map((a) => a.id)).not.toContain(A.mariaDone); // outside the range
    expect(cal.busy).toEqual([]);
    expect(cal.staff.map((s) => s.id)).toEqual(expect.arrayContaining([U.ada, U.sam, U.lia]));
  });

  it("shows colleagues' bookings the employee cannot see as busy times, without any details", async () => {
    const cal: Calendar = (await api(app, employee(U.lia)).get(`/api/appointments/calendar?${week()}`).expect(200)).body;
    const seen = cal.appointments.map((a) => a.id);
    expect(seen).toContain(A.patNext);
    expect(seen).toContain(A.victorNext); // assigned to Lia
    expect(seen).not.toContain(A.mariaNext);
    expect(seen).not.toContain(A.janeNext);
    // Sam's two NYC bookings are there as busy blocks: staff, location and times only.
    const samBusy = cal.busy.filter((b) => b.employee_id === U.sam);
    expect(samBusy).toHaveLength(2);
    for (const b of samBusy) expect(Object.keys(b).sort()).toEqual(['employee_id', 'location_id', 'scheduled_end', 'scheduled_start']);
    expect(JSON.stringify(cal.busy)).not.toMatch(new RegExp(`${A.mariaNext}|${A.janeNext}|${C.maria}|${C.jane}|Haircut`));
  });

  it('filters by location and staff member', async () => {
    const nyc: Calendar = (await api(app, employee(U.ada)).get(`/api/appointments/calendar?${week()}&location_id=${L.nyc}`).expect(200)).body;
    expect(nyc.appointments.map((a) => a.id)).not.toContain(A.patNext);
    expect(nyc.staff.map((s) => s.id)).not.toContain(U.lia);
    const sam: Calendar = (await api(app, employee(U.lia)).get(`/api/appointments/calendar?${week()}&employee_id=${U.sam}`).expect(200)).body;
    expect(sam.appointments).toEqual([]);
    expect(sam.busy).toHaveLength(2);
    expect(sam.staff.map((s) => s.id)).toContain(U.lia); // the picker keeps every option
  });

  it('is for employees, for at most 45 days', async () => {
    await api(app, customer(C.maria)).get(`/api/appointments/calendar?${week()}`).expect(403);
    const from = new Date();
    const to = new Date(from.getTime() + 60 * 86_400_000);
    await api(app, employee(U.ada))
      .get(`/api/appointments/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`)
      .expect(400);
  });
});
