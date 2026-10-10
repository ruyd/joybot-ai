import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createApp, customer, employee } from './app';

const { customers: C, users: U } = SAMPLE;

let app: INestApplication;

beforeAll(async () => {
  app = await createApp();
});
afterAll(async () => {
  await app.close();
});

describe('employee profile (PUT /me/employee)', () => {
  it('staff edit their own name and time zone, nothing else', async () => {
    const before = (await api(app, employee(U.lia)).get('/api/me').expect(200)).body.profile;
    const res = await api(app, employee(U.sam))
      .put('/api/me/employee', { first_name: 'Samuel', time_zone: 'America/Chicago' })
      .expect(200);
    expect(res.body.profile).toMatchObject({ id: U.sam, first_name: 'Samuel', last_name: 'Staff', time_zone: 'America/Chicago', role: 'staff', email: 'sam@example.com' });

    // Only the changed fields: a later name change keeps the time zone; null clears it.
    const again = await api(app, employee(U.sam)).put('/api/me/employee', { last_name: 'Smith' }).expect(200);
    expect(again.body.profile).toMatchObject({ first_name: 'Samuel', last_name: 'Smith', time_zone: 'America/Chicago' });
    const cleared = await api(app, employee(U.sam)).put('/api/me/employee', { time_zone: null }).expect(200);
    expect(cleared.body.profile.time_zone).toBeNull();

    // Other employees are untouched.
    expect((await api(app, employee(U.lia)).get('/api/me').expect(200)).body.profile).toEqual(before);
  });

  it('rejects unknown time zones, blank names and fields outside the profile', async () => {
    await api(app, employee(U.sam)).put('/api/me/employee', { time_zone: 'Mars/Olympus' }).expect(400);
    await api(app, employee(U.sam)).put('/api/me/employee', { first_name: '  ' }).expect(400);
    await api(app, employee(U.sam)).put('/api/me/employee', { role: 'admin' }).expect(400);
    await api(app, employee(U.sam)).put('/api/me/employee', { email: 'x@example.com' }).expect(400);
    expect((await api(app, employee(U.sam)).get('/api/me').expect(200)).body).toMatchObject({ role: 'staff', profile: { email: 'sam@example.com' } });
  });

  it('is for employees only', async () => {
    await api(app, customer(C.maria)).put('/api/me/employee', { first_name: 'X' }).expect(403);
  });
});
