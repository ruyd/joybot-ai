import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import path from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MESSAGE_SENDER, type MessageSender } from '../src/messaging/messaging.service';
import { api, createApp, customer, employee } from './app';

const { customers: C, users: U, services: S, locations: L } = SAMPLE;

const quiet: MessageSender = { send: async () => ({}) };
let app: INestApplication;
beforeAll(async () => {
  app = await createApp({ overrides: [{ token: MESSAGE_SENDER, value: quiet }] });
});
afterAll(async () => {
  await app.close();
});

const admin = () => api(app, employee(U.ada));
const visitor = () => request(app.getHttpServer());
type Type = { id: string; key: string; name: string; color: string; system: boolean };
const types = async () => (await admin().get('/api/appointment-types').expect(200)).body as Type[];
const typeKey = async (key: string) => (await types()).find((t) => t.key === key)!;

/** Runs SQL on this worker's test database as the owner (to move a call into the past). */
async function asOwner(sql: string, args: unknown[]) {
  config({ path: path.resolve(__dirname, '../../../.env') });
  const db = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await db.connect();
  try {
    await db.query(sql, args);
  } finally {
    await db.end();
  }
}

/** The first open sales-call time at least `days` ahead. */
async function openSlot(days: number) {
  const from = new Date(Date.now() + days * 86_400_000).toISOString();
  const to = new Date(Date.now() + (days + 10) * 86_400_000).toISOString();
  return ((await visitor().get(`/api/site/sales-call?from=${from}&to=${to}`).expect(200)).body.slots as string[])[0];
}

describe('appointment types', () => {
  it('start as sales call (system), service and installation, readable by everyone signed in', async () => {
    const list = await types();
    expect(list.map((t) => [t.key, t.system])).toEqual([
      ['sales_call', true],
      ['service', false],
      ['installation', false],
    ]);
    expect(list.every((t) => /^#[0-9a-f]{6}$/.test(t.color))).toBe(true);
    expect((await api(app, customer(C.maria)).get('/api/appointment-types').expect(200)).body).toHaveLength(3);
    await visitor().get('/api/appointment-types').expect(401);
  });

  it('whoever may edit services adds, renames, recolors and deletes them; system types are read-only', async () => {
    await api(app, employee(U.sam)).post('/api/appointment-types', { name: 'Repair', color: '#10b981' }).expect(403);
    const repair = (await admin().post('/api/appointment-types', { name: 'Window cleaning!', color: '#10B981' }).expect(201)).body as Type;
    expect(repair).toMatchObject({ key: 'window_cleaning', name: 'Window cleaning!', color: '#10b981', system: false });
    expect((await types()).at(-1)!.id).toBe(repair.id); // added last
    await admin().post('/api/appointment-types', { name: 'window CLEANING!', color: '#10b981' }).expect(409);
    await admin().post('/api/appointment-types', { name: 'Odd', color: 'green' }).expect(400);
    await admin().post('/api/appointment-types', { name: '', color: '#10b981' }).expect(400);

    expect((await admin().put(`/api/appointment-types/${repair.id}`, { name: 'Windows', color: '#0ea5e9' }).expect(200)).body).toMatchObject({ name: 'Windows', color: '#0ea5e9', key: 'window_cleaning' });
    await api(app, employee(U.sam)).put(`/api/appointment-types/${repair.id}`, { name: 'x' }).expect(403);
    await admin().put(`/api/appointment-types/${repair.id}`, { name: 'Service' }).expect(409);

    const sales = await typeKey('sales_call');
    const locked = await admin().put(`/api/appointment-types/${sales.id}`, { color: '#000000' }).expect(403);
    expect(locked.body.message).toMatch(/read-only/);
    await admin().delete(`/api/appointment-types/${sales.id}`).expect(403);

    await api(app, employee(U.sam)).delete(`/api/appointment-types/${repair.id}`).expect(403);
    await admin().delete(`/api/appointment-types/${repair.id}`).expect(204);
    await admin().delete(`/api/appointment-types/${repair.id}`).expect(404);
    expect((await admin().delete(`/api/appointment-types/${(await typeKey('service')).id}`).expect(409)).body.message).toMatch(/use this type/);
  });
});

describe('appointments have a type', () => {
  it('a service unless chosen; staff pick any type but the system ones', async () => {
    const base = { customer_id: C.jane, service_id: S.haircut, location_id: L.nyc, scheduled_start: new Date(Date.now() + 30 * 86_400_000).toISOString() };
    const plain = (await api(app, employee(U.sam)).post('/api/appointments', base).expect(201)).body;
    expect(plain).toMatchObject({ type_key: 'service', type_name: 'Service', service_name: 'Haircut' });

    const installation = await typeKey('installation');
    const later = { ...base, scheduled_start: new Date(Date.now() + 31 * 86_400_000).toISOString() };
    const typed = (await api(app, employee(U.sam)).post('/api/appointments', { ...later, type_id: installation.id }).expect(201)).body;
    expect(typed).toMatchObject({ type_id: installation.id, type_key: 'installation', type_color: installation.color });

    await api(app, employee(U.sam)).post('/api/appointments', { ...later, type_id: (await typeKey('sales_call')).id }).expect(400);
    expect((await api(app, employee(U.sam)).put(`/api/appointments/${plain.id}`, { type_id: installation.id }).expect(200)).body.type_key).toBe('installation');
    await api(app, employee(U.sam)).put(`/api/appointments/${plain.id}`, { type_id: (await typeKey('sales_call')).id }).expect(400);
    // The customer sees the type too.
    const mine = (await api(app, customer(C.jane)).get('/api/appointments?limit=100').expect(200)).body as { id: string; type_name: string }[];
    expect(mine.find((a) => a.id === plain.id)?.type_name).toBe('Installation');
  });
});

describe('sales calls are appointments', () => {
  it('on the calendar (online, the visitor named), and they block the host like any appointment', async () => {
    await admin().put('/api/website/sales-call-settings', { host_ids: [U.sam] }).expect(200);
    const start = await openSlot(14);
    const booked = (await visitor().post('/api/site/sales-call').send({ name: 'Cal Endar', email: 'cal@example.com', start, phone: '+1 555 010 0001' }).expect(201)).body as { id: string };

    const from = new Date(Date.parse(start) - 3_600_000).toISOString();
    const to = new Date(Date.parse(start) + 3_600_000).toISOString();
    const cal = (await admin().get(`/api/appointments/calendar?from=${from}&to=${to}`).expect(200)).body;
    expect(cal.appointments.find((a: { id: string }) => a.id === booked.id)).toMatchObject({
      type_key: 'sales_call',
      customer_id: null,
      customer_name: 'Cal Endar',
      contact_email: 'cal@example.com',
      service_name: 'Sales call',
      location_name: 'Online',
      employee_id: U.sam,
    });
    // The host sees their own; other staff see only that Sam is busy.
    expect((await api(app, employee(U.sam)).get(`/api/appointments/calendar?from=${from}&to=${to}`).expect(200)).body.appointments.map((a: { id: string }) => a.id)).toContain(booked.id);
    const lia = (await api(app, employee(U.lia)).get(`/api/appointments/calendar?from=${from}&to=${to}`).expect(200)).body;
    expect(lia.appointments.map((a: { id: string }) => a.id)).not.toContain(booked.id);
    expect(lia.busy).toEqual(expect.arrayContaining([expect.objectContaining({ employee_id: U.sam, scheduled_start: start })]));
    // Customers never see it.
    expect((await api(app, customer(C.maria)).get('/api/appointments?limit=100').expect(200)).body.map((a: { id: string }) => a.id)).not.toContain(booked.id);

    // Booking Sam for a haircut over the call is a double booking.
    const clash = await admin()
      .post('/api/appointments', { customer_id: C.maria, service_id: S.haircut, location_id: L.nyc, employee_id: U.sam, scheduled_start: start })
      .expect(409);
    expect(clash.body.code).toBe('employee_double_booked');

    await admin().post(`/api/website/sales-calls/${booked.id}/cancel`).expect(200);
    await admin().put('/api/website/sales-call-settings', { host_ids: [] }).expect(200);
  });
});

describe('sales call outcomes', () => {
  it('staff log follow up, conversion, potential or do not call with notes; a call that took place is then completed', async () => {
    const start = await openSlot(20);
    const call = (await visitor().post('/api/site/sales-call').send({ name: 'Out Come', email: 'outcome@example.com', start, phone: '+1 555 010 0002' }).expect(201)).body as { id: string };

    await api(app, employee(U.sam)).post(`/api/website/sales-calls/${call.id}/outcome`, { outcome: 'potential' }).expect(403);
    await admin().post(`/api/website/sales-calls/${call.id}/outcome`, { outcome: 'maybe' }).expect(400);
    // Before the call: saved, the call stays booked.
    const early = (await admin().post(`/api/website/sales-calls/${call.id}/outcome`, { outcome: 'potential', notes: 'Asked for pricing first' }).expect(200)).body;
    expect(early).toMatchObject({ outcome: 'potential', outcome_notes: 'Asked for pricing first', status: 'confirmed' });

    // After it: moved into the past, then logged again.
    await asOwner(`UPDATE core.appointments SET scheduled_start = now() - interval '2 hours', scheduled_end = now() - interval '90 minutes' WHERE id = $1`, [call.id]);
    const done = (await admin().post(`/api/website/sales-calls/${call.id}/outcome`, { outcome: 'conversion', notes: 'Signed the quickstart' }).expect(200)).body;
    expect(done).toMatchObject({ outcome: 'conversion', outcome_notes: 'Signed the quickstart' });
    const past = (await admin().get('/api/website/sales-calls?when=past').expect(200)).body.items as { id: string; outcome: string }[];
    expect(past.find((c) => c.id === call.id)?.outcome).toBe('conversion');
    expect((await admin().get('/api/website/sales-calls?when=past&q=quickstart').expect(200)).body.total).toBe(1); // notes are searched
    const appt = (await admin().get(`/api/appointments/${call.id}`).expect(200)).body;
    expect(appt.status).toBe('completed');

    // Not for cancelled calls.
    const later = await openSlot(25);
    const other = (await visitor().post('/api/site/sales-call').send({ name: 'Gone', email: 'gone@example.com', start: later, phone: '+1 555 010 0003' }).expect(201)).body as { id: string };
    await admin().post(`/api/website/sales-calls/${other.id}/cancel`).expect(200);
    await admin().post(`/api/website/sales-calls/${other.id}/outcome`, { outcome: 'do_not_call' }).expect(404);
  });
});

describe('sales call status', () => {
  it('staff mark a call completed (it leaves upcoming) or a no-show once started, or confirm it again', async () => {
    const start = await openSlot(30);
    const call = (await visitor().post('/api/site/sales-call').send({ name: 'Stat Us', email: 'status@example.com', start, phone: '+1 555 010 0004' }).expect(201)).body as { id: string };
    const upcoming = async () => ((await admin().get('/api/website/sales-calls?limit=100').expect(200)).body.items as { id: string }[]).map((c) => c.id);
    const past = async () => ((await admin().get('/api/website/sales-calls?when=past&limit=100').expect(200)).body.items as { id: string }[]).map((c) => c.id);
    expect(await upcoming()).toContain(call.id);

    await api(app, employee(U.sam)).put(`/api/website/sales-calls/${call.id}/status`, { status: 'completed' }).expect(403);
    await admin().put(`/api/website/sales-calls/${call.id}/status`, { status: 'cancelled' }).expect(400); // that is Cancel
    await admin().put(`/api/website/sales-calls/${call.id}/status`, { status: 'no_show' }).expect(400); // not started yet

    expect((await admin().put(`/api/website/sales-calls/${call.id}/status`, { status: 'completed' }).expect(200)).body.status).toBe('completed');
    expect(await upcoming()).not.toContain(call.id);
    expect(await past()).toContain(call.id);
    // Confirmed again (the host, if any, must still be free).
    expect((await admin().put(`/api/website/sales-calls/${call.id}/status`, { status: 'confirmed' }).expect(200)).body.status).toBe('confirmed');
    expect(await upcoming()).toContain(call.id);

    await asOwner(`UPDATE core.appointments SET scheduled_start = now() - interval '10 minutes', scheduled_end = now() + interval '20 minutes' WHERE id = $1`, [call.id]);
    expect((await admin().put(`/api/website/sales-calls/${call.id}/status`, { status: 'no_show' }).expect(200)).body.status).toBe('no_show');
    expect(await upcoming()).not.toContain(call.id); // still running, but marked

    await admin().post(`/api/website/sales-calls/${call.id}/cancel`).expect(404); // only booked calls cancel
    await admin().put(`/api/website/sales-calls/${call.id}/status`, { status: 'confirmed' }).expect(200);
    await admin().post(`/api/website/sales-calls/${call.id}/cancel`).expect(200);
    await admin().put(`/api/website/sales-calls/${call.id}/status`, { status: 'completed' }).expect(404); // cancelled stays cancelled
  });
});
