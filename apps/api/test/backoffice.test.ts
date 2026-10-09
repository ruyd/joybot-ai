import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createApp, customer, employee } from './app';

const { customers: C, users: U, orgs: O, appointments: A, services: S, locations: L } = SAMPLE;
let app: INestApplication;

beforeAll(async () => {
  app = await createApp();
});
afterAll(async () => {
  await app.close();
});

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
const userIds = (rows: { user_id: string }[]) => rows.map((r) => r.user_id).sort();
const inDays = (d: number, hour = 15) => {
  const t = new Date(Date.now() + d * 86_400_000);
  t.setUTCHours(hour, 0, 0, 0);
  return t.toISOString();
};

describe('catalog', () => {
  it('admins manage the price list; customers only see active services', async () => {
    const created = await api(app, employee(U.ada))
      .post('/api/admin/services', { code: 'color', name: 'Hair color', price: 85, duration_minutes: 90, category: 'Hair' })
      .expect(201);
    expect(created.body).toMatchObject({ code: 'COLOR', currency: 'USD', price: '85.00', active: true });

    await api(app, employee(U.sam)).post('/api/admin/services', { code: 'X', name: 'X', price: 1 }).expect(403);

    let visible = await api(app, customer(C.maria)).get('/api/services?category=Hair').expect(200);
    expect(visible.body.map((s: { code: string }) => s.code)).toContain('COLOR');

    await api(app, employee(U.ada)).put(`/api/admin/services/${created.body.id}`, { active: false }).expect(200);
    visible = await api(app, customer(C.maria)).get('/api/services').expect(200);
    expect(visible.body.map((s: { code: string }) => s.code)).not.toContain('COLOR');
    await api(app, customer(C.maria)).get(`/api/services/${created.body.id}`).expect(404);
  });

  it('locations validate time zones', async () => {
    await api(app, employee(U.ada))
      .post('/api/admin/locations', { code: 'mia', name: 'Miami', time_zone: 'Florida/Miami' })
      .expect(400);
    const res = await api(app, employee(U.ada))
      .post('/api/admin/locations', { code: 'mia', name: 'Miami', time_zone: 'America/New_York' })
      .expect(201);
    expect(res.body.code).toBe('MIA');
    const list = await api(app, customer(C.pat)).get('/api/locations').expect(200);
    expect(list.body.map((l: { code: string }) => l.code)).toEqual(expect.arrayContaining(['LA', 'MIA', 'NYC']));
  });
});

describe('organizations', () => {
  it('staff see organizations in scope; assignments reveal restricted ones', async () => {
    const sam = await api(app, employee(U.sam)).get('/api/organizations').expect(200);
    expect(ids(sam.body)).toEqual([O.acme]);
    const lia = await api(app, employee(U.lia)).get('/api/organizations?q=vip').expect(200);
    expect(ids(lia.body)).toEqual([O.vip]);
    await api(app, employee(U.sam)).get(`/api/organizations/${O.vip}`).expect(404);
  });

  it('member lists only include members the employee can see', async () => {
    const sam = await api(app, employee(U.sam)).get(`/api/organizations/${O.acme}/members`).expect(200);
    expect(ids(sam.body)).toEqual([C.jane]);
    const ada = await api(app, employee(U.ada)).get(`/api/organizations/${O.acme}/members`).expect(200);
    expect(ada.body[0]).toMatchObject({ id: C.john, org_role: 'org_admin' });
    expect(ids(ada.body)).toEqual([C.john, C.jane].sort());
  });

  it('staff create organizations but cannot restrict them', async () => {
    const created = await api(app, employee(U.sam)).post('/api/organizations', { name: 'Globex' }).expect(201);
    expect(created.body.org_number).toMatch(/^O-\d+$/);
    const updated = await api(app, employee(U.sam))
      .put(`/api/organizations/${created.body.id}`, { restricted: true, legal_name: 'Globex LLC' })
      .expect(200);
    expect(updated.body).toMatchObject({ restricted: false, legal_name: 'Globex LLC' });
  });

  it('customers cannot use the organizations back-office API', async () => {
    await api(app, customer(C.john)).get('/api/organizations').expect(403);
  });
});

describe('who can access', () => {
  it('explains access to a restricted organization', async () => {
    const res = await api(app, employee(U.ada)).get(`/api/organizations/${O.vip}/access`).expect(200);
    expect(userIds(res.body)).toEqual([U.ada, U.lia].sort());
    expect(res.body.find((r: { user_id: string }) => r.user_id === U.lia)).toMatchObject({ can_read: 'assignment', can_update: 'assignment' });
  });

  it('explains location, grant and role access to a customer', async () => {
    const res = await api(app, employee(U.ada)).get(`/api/customers/${C.pat}/access`).expect(200);
    const byUser = Object.fromEntries(res.body.map((r: { user_id: string; can_read: string; can_update: string | null }) => [r.user_id, r]));
    expect(byUser[U.ada]).toMatchObject({ can_read: 'role:all_including_restricted' });
    expect(byUser[U.lia]).toMatchObject({ can_read: 'location', can_update: 'location' });
    expect(byUser[U.sam]).toMatchObject({ can_read: 'grant', can_update: null });
  });

  it('is admin only', async () => {
    await api(app, employee(U.sam)).get(`/api/customers/${C.maria}/access`).expect(403);
  });
});

describe('appointments', () => {
  it('customers see their own appointments with local times and no internal notes', async () => {
    const res = await api(app, customer(C.maria)).get('/api/appointments').expect(200);
    expect(ids(res.body)).toEqual([A.mariaDone, A.mariaNext].sort());
    const done = res.body.find((a: { id: string }) => a.id === A.mariaDone);
    expect(done).toMatchObject({ service_name: 'Haircut', location_name: 'New York — Midtown', time_zone: 'America/New_York', employee_name: 'Sam Staff' });
    expect(done.local_start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(done).not.toHaveProperty('notes_internal');
  });

  it('org admins see their organization members’ appointments', async () => {
    const res = await api(app, customer(C.john)).get('/api/appointments').expect(200);
    expect(ids(res.body)).toEqual([A.johnDone, A.janeNext].sort());
  });

  it('staff book with service defaults (duration, price, currency)', async () => {
    const res = await api(app, employee(U.sam))
      .post('/api/appointments', { customer_id: C.jane, service_id: S.haircut, location_id: L.nyc, employee_id: U.sam, scheduled_start: inDays(20) })
      .expect(201);
    expect(res.body).toMatchObject({ status: 'scheduled', price_quoted: '50.00', currency: 'USD', employee_id: U.sam });
    expect(new Date(res.body.scheduled_end).getTime() - new Date(res.body.scheduled_start).getTime()).toBe(45 * 60_000);
  });

  it('detects employee double-booking and allows confirming', async () => {
    const mariaNext = (await api(app, employee(U.sam)).get(`/api/appointments/${A.mariaNext}`).expect(200)).body;
    const body = { customer_id: C.jane, service_id: S.haircut, location_id: L.nyc, employee_id: U.sam, scheduled_start: mariaNext.scheduled_start };
    const conflict = await api(app, employee(U.sam)).post('/api/appointments', body).expect(409);
    expect(conflict.body).toMatchObject({ code: 'employee_double_booked' });
    expect(conflict.body.conflicts[0].appointment_number).toBe(mariaNext.appointment_number);
    await api(app, employee(U.sam)).post('/api/appointments', { ...body, confirm_overlap: true }).expect(201);
  });

  it('rejects employees who do not work at the location, and customers out of scope', async () => {
    await api(app, employee(U.sam))
      .post('/api/appointments', { customer_id: C.maria, service_id: S.haircut, location_id: L.nyc, employee_id: U.lia, scheduled_start: inDays(21) })
      .expect(400);
    await api(app, employee(U.sam))
      .post('/api/appointments', { customer_id: C.john, service_id: S.haircut, location_id: L.nyc, scheduled_start: inDays(21) })
      .expect(404);
    await api(app, customer(C.maria))
      .post('/api/appointments', { customer_id: C.maria, service_id: S.haircut, location_id: L.nyc, scheduled_start: inDays(21) })
      .expect(403);
  });

  it('enforces status transitions; only admins reopen terminal appointments', async () => {
    const created = await api(app, employee(U.sam))
      .post('/api/appointments', { customer_id: C.maria, service_id: S.deepClean, location_id: L.nyc, scheduled_start: inDays(30) })
      .expect(201);
    const id = created.body.id;
    await api(app, employee(U.sam)).put(`/api/appointments/${id}`, { status: 'completed' }).expect(400);
    await api(app, employee(U.sam)).put(`/api/appointments/${id}`, { status: 'confirmed' }).expect(200);
    await api(app, employee(U.sam)).put(`/api/appointments/${id}`, { status: 'cancelled' }).expect(200);
    await api(app, employee(U.sam)).put(`/api/appointments/${id}`, { status: 'scheduled' }).expect(400);
    await api(app, employee(U.sam)).put(`/api/appointments/${id}`, { notes_customer: 'x' }).expect(403);
    const reopened = await api(app, employee(U.ada)).put(`/api/appointments/${id}`, { status: 'scheduled' }).expect(200);
    expect(reopened.body.status).toBe('scheduled');
  });

  it('`mine=true` lists the employee’s own schedule', async () => {
    const res = await api(app, employee(U.lia)).get('/api/appointments?mine=true').expect(200);
    expect(res.body.every((a: { employee_id: string }) => a.employee_id === U.lia)).toBe(true);
    expect(ids(res.body)).toEqual([A.johnDone, A.patNext].sort());
  });
});

describe('employees (admin)', () => {
  it('admins create staff with work locations; staff cannot', async () => {
    const res = await api(app, employee(U.ada))
      .post('/api/admin/users', { first_name: 'Leo', last_name: 'New', email: 'leo@example.com', role: 'staff', home_location_id: L.la })
      .expect(201);
    expect(res.body).toMatchObject({ role: 'staff', location_ids: [L.la], has_login: false });
    expect(res.body.employee_number).toMatch(/^E-\d+$/);

    const leo = await api(app, employee(res.body.id)).get('/api/customers').expect(200);
    expect(ids(leo.body)).toEqual(expect.arrayContaining([C.john, C.pat]));
    expect(ids(leo.body)).not.toContain(C.maria);

    await api(app, employee(U.sam))
      .post('/api/admin/users', { first_name: 'X', last_name: 'Y', email: 'x@example.com', role: 'admin' })
      .expect(403);
  });

  it('admins cannot demote or deactivate themselves', async () => {
    await api(app, employee(U.ada)).put(`/api/admin/users/${U.ada}`, { role: 'staff' }).expect(400);
    await api(app, employee(U.ada)).put(`/api/admin/users/${U.ada}`, { active: false }).expect(400);
  });

  it('deactivated employees are locked out', async () => {
    const res = await api(app, employee(U.ada))
      .post('/api/admin/users', { first_name: 'Tmp', last_name: 'Staff', email: 'tmp@example.com', role: 'staff' })
      .expect(201);
    await api(app, employee(res.body.id)).get('/api/me').expect(200);
    await api(app, employee(U.ada)).put(`/api/admin/users/${res.body.id}`, { active: false }).expect(200);
    await api(app, employee(res.body.id)).get('/api/me').expect(401);
  });
});

describe('staff permissions (admin)', () => {
  it('admins can widen staff permissions; changes apply immediately and can be restored', async () => {
    const original = (await api(app, employee(U.ada)).get('/api/admin/permissions').expect(200)).body.filter(
      (r: { role: string }) => r.role === 'staff',
    );
    const widened = [...original, { role: 'staff', resource: 'customers', action: 'read', scope: 'all' }];
    const strip = (rows: { resource: string; action: string; scope: string }[]) =>
      rows.map(({ resource, action, scope }) => ({ resource, action, scope }));

    await api(app, employee(U.ada)).put('/api/admin/permissions/staff', { permissions: strip(widened) }).expect(200);
    const sam = await api(app, employee(U.sam)).get('/api/customers').expect(200);
    expect(ids(sam.body)).toContain(C.john); // now visible via "all"
    expect(ids(sam.body)).not.toContain(C.rita); // restricted stays hidden

    await api(app, employee(U.ada)).put('/api/admin/permissions/staff', { permissions: strip(original) }).expect(200);
    const after = await api(app, employee(U.sam)).get('/api/customers').expect(200);
    expect(ids(after.body)).not.toContain(C.john);
  });

  it('staff can never be given admin powers', async () => {
    for (const perm of [
      { resource: 'payments', action: 'void', scope: 'all' },
      { resource: 'access', action: 'update', scope: 'all' },
      { resource: 'settings', action: 'update', scope: 'all' },
    ]) {
      await api(app, employee(U.ada)).put('/api/admin/permissions/staff', { permissions: [perm] }).expect(400);
    }
    await api(app, employee(U.ada))
      .put('/api/admin/permissions/staff', { permissions: [{ resource: 'customers', action: 'read', scope: 'all_including_restricted' }] })
      .expect(400);
    await api(app, employee(U.sam)).put('/api/admin/permissions/staff', { permissions: [] }).expect(403);
  });
});

describe('assignments and record grants (admin)', () => {
  it('assigning staff to a restricted customer grants access until the assignment ends', async () => {
    await api(app, employee(U.sam)).get(`/api/customers/${C.rita}`).expect(404);
    const a = await api(app, employee(U.ada)).post('/api/admin/assignments', { user_id: U.sam, customer_id: C.rita }).expect(201);
    await api(app, employee(U.sam)).get(`/api/customers/${C.rita}`).expect(200);

    const list = await api(app, employee(U.ada)).get(`/api/admin/assignments?customer_id=${C.rita}`).expect(200);
    expect(ids(list.body)).toEqual([a.body.id]);

    await api(app, employee(U.ada)).post(`/api/admin/assignments/${a.body.id}/end`).expect(201);
    await api(app, employee(U.sam)).get(`/api/customers/${C.rita}`).expect(404);
    await api(app, employee(U.ada)).post(`/api/admin/assignments/${a.body.id}/end`).expect(404);
  });

  it('grants are temporary (≤ 90 days), audited and revocable', async () => {
    const base = { user_id: U.sam, resource: 'customer', record_id: C.john, actions: ['read'], reason: 'Covering for Lia' };
    await api(app, employee(U.ada)).post('/api/admin/record-grants', { ...base, expires_at: inDays(91) }).expect(400);
    await api(app, employee(U.ada)).post('/api/admin/record-grants', { ...base, expires_at: inDays(-1) }).expect(400);
    await api(app, employee(U.sam)).post('/api/admin/record-grants', { ...base, expires_at: inDays(1) }).expect(403);

    const g = await api(app, employee(U.ada)).post('/api/admin/record-grants', { ...base, expires_at: inDays(1) }).expect(201);
    expect(g.body).toMatchObject({ granted_by: U.ada, reason: 'Covering for Lia' });
    await api(app, employee(U.sam)).get(`/api/customers/${C.john}`).expect(200);
    await api(app, employee(U.sam)).put(`/api/customers/${C.john}`, { first_name: 'Johnny' }).expect(404);

    await api(app, employee(U.ada)).post(`/api/admin/record-grants/${g.body.id}/revoke`).expect(201);
    await api(app, employee(U.sam)).get(`/api/customers/${C.john}`).expect(404);
  });

  it('assignments require exactly one target and an active employee', async () => {
    await api(app, employee(U.ada)).post('/api/admin/assignments', { user_id: U.sam }).expect(400);
    await api(app, employee(U.ada))
      .post('/api/admin/assignments', { user_id: U.sam, customer_id: C.rita, organization_id: O.vip })
      .expect(400);
    await api(app, employee(U.ada))
      .post('/api/admin/assignments', { user_id: '20000000-0000-4000-8000-0000000000ff', customer_id: C.rita })
      .expect(404);
  });
});
