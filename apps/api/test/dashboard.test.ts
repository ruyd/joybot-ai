import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DashboardSummary } from '../src/dashboard/dashboard.controller';
import { api, createApp, customer, employee } from './app';

const { customers: C, users: U } = SAMPLE;

let app: INestApplication;
let migrator: Client;

beforeAll(async () => {
  app = await createApp();
  migrator = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await migrator.connect();
});
afterAll(async () => {
  await migrator.end();
  await app.close();
});

const summary = async (who: string) => (await api(app, employee(who)).get('/api/dashboard').expect(200)).body as DashboardSummary;

describe('dashboard summary', () => {
  it('admins get every section; ticket counts match the database', async () => {
    const s = await summary(U.ada);
    expect(s.currency).toMatch(/^[A-Z]{3}$/);
    const { rows } = await migrator.query(
      `SELECT count(*) FILTER (WHERE status = 'open')::int AS open, count(*) FILTER (WHERE status = 'pending')::int AS pending FROM core.tickets`,
    );
    expect(s.tickets).toMatchObject(rows[0]);
    expect(s.payments).toBeDefined();
    expect(s.invoices).toBeDefined();
  });

  it('a payment today and an overdue invoice move the numbers', async () => {
    const before = await summary(U.ada);
    const inv = (
      await api(app, employee(U.sam))
        .post('/api/invoices', { customer_id: C.maria, lines: [{ description: 'Code review', unit_price: 300 }] })
        .expect(201)
    ).body;
    await api(app, employee(U.sam)).post(`/api/invoices/${inv.id}/send`, { notify: false }).expect(201);
    await migrator.query(`UPDATE core.invoices SET due_on = current_date - 3 WHERE id = $1`, [inv.id]);
    await api(app, employee(U.sam))
      .post('/api/payments', { customer_id: C.maria, invoice_id: inv.id, method: 'cash', amount: 120, paid_at: new Date().toISOString(), confirm_duplicate: true })
      .expect(201);

    const after = await summary(U.ada);
    expect(Number(after.payments!.collected_week) - Number(before.payments!.collected_week)).toBe(120);
    expect(after.invoices!.overdue_count).toBe(before.invoices!.overdue_count + 1);
    expect(Number(after.invoices!.overdue_total) - Number(before.invoices!.overdue_total)).toBe(180);
    expect(after.invoices!.overdue_names).toContain('Maria Lopez');
  });

  it('staff see only their own scope', async () => {
    const admin = await summary(U.ada);
    for (const who of [U.sam, U.lia]) {
      const s = await summary(who);
      if (s.tickets) expect(s.tickets.open + s.tickets.pending).toBeLessThanOrEqual(admin.tickets!.open + admin.tickets!.pending);
      if (s.invoices) expect(s.invoices.overdue_count).toBeLessThanOrEqual(admin.invoices!.overdue_count);
    }
  });

  it('customers cannot read it', async () => {
    await api(app, customer(C.maria)).get('/api/dashboard').expect(403);
  });
});
