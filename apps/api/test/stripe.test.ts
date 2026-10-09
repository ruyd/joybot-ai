import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signStripePayload, verifyStripeSignature } from '../src/stripe/signature';
import { api, createApp, customer, employee } from './app';

const SECRET = 'whsec_test_secret';
const { users: U, customers: C, payments: P, appointments: A } = SAMPLE;

describe('Stripe signature', () => {
  const body = Buffer.from('{"id":"evt_1"}');
  it('accepts a valid signature and rejects tampering, wrong secrets and replays', () => {
    const header = signStripePayload(body.toString(), SECRET);
    expect(verifyStripeSignature(body, header, SECRET)).toBe(true);
    expect(verifyStripeSignature(Buffer.from('{"id":"evt_2"}'), header, SECRET)).toBe(false);
    expect(verifyStripeSignature(body, header, 'whsec_other')).toBe(false);
    const old = signStripePayload(body.toString(), SECRET, Math.floor(Date.now() / 1000) - 600);
    expect(verifyStripeSignature(body, old, SECRET)).toBe(false);
    expect(verifyStripeSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyStripeSignature(body, 't=abc,v1=zz', SECRET)).toBe(false);
  });
});

describe('Stripe webhook and admin API', () => {
  let app: INestApplication;
  let migrator: Client;

  const post = (payload: object, header?: string) => {
    const raw = JSON.stringify(payload);
    return request(app.getHttpServer())
      .post('/api/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', header ?? signStripePayload(raw, SECRET))
      .send(raw);
  };
  const event = (id: string) => ({ id, object: 'event', type: 'payment_intent.succeeded', created: 1_760_000_000, livemode: false, data: { object: { id: 'pi_x' } } });

  beforeAll(async () => {
    config({ path: path.resolve(__dirname, '../../../.env') });
    migrator = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
    await migrator.connect();
    app = await createApp({ env: { STRIPE_WEBHOOK_SECRET: SECRET } });
  });
  afterAll(async () => {
    await migrator.query(`UPDATE core.settings SET stripe_enabled = false`);
    await migrator.end();
    await app.close();
  });

  it('acknowledges but ignores events while Stripe is disabled', async () => {
    const res = await post(event('evt_disabled')).expect(200);
    expect(res.body).toEqual({ received: false, reason: 'stripe disabled' });
  });

  it('stores signed events once (idempotent) for the worker', async () => {
    await api(app, employee(U.ada)).put('/api/admin/settings', { stripe_enabled: true }).expect(200);
    expect((await post(event('evt_ok')).expect(200)).body).toEqual({ received: true, duplicate: false });
    expect((await post(event('evt_ok')).expect(200)).body).toEqual({ received: true, duplicate: true });
    const row = (await migrator.query(`SELECT type, status, payload->>'id' AS id FROM app.stripe_events WHERE event_id = 'evt_ok'`)).rows[0];
    expect(row).toEqual({ type: 'payment_intent.succeeded', status: 'received', id: 'evt_ok' });
  });

  it('rejects bad signatures and non-events', async () => {
    await post(event('evt_bad'), 't=1,v1=00').expect(400);
    await post(event('evt_bad'), signStripePayload('{"different":true}', SECRET)).expect(400);
    await post({ hello: 'world' }).expect(400);
    expect((await migrator.query(`SELECT 1 FROM app.stripe_events WHERE event_id = 'evt_bad'`)).rowCount).toBe(0);
  });

  it('staff assign unmatched Stripe payments to customers in their scope', async () => {
    await api(app, customer(C.maria)).post(`/api/payments/${P.unmatchedStripe}/assign`, { customer_id: C.maria }).expect(403);
    await api(app, employee(U.sam)).post(`/api/payments/${P.unmatchedStripe}/assign`, { customer_id: C.john }).expect(404);
    await api(app, employee(U.sam))
      .post(`/api/payments/${P.unmatchedStripe}/assign`, { customer_id: C.maria, appointment_id: A.janeNext })
      .expect(400);
    const res = await api(app, employee(U.sam))
      .post(`/api/payments/${P.unmatchedStripe}/assign`, { customer_id: C.maria, appointment_id: A.mariaNext })
      .expect(200);
    expect(res.body).toMatchObject({ customer_id: C.maria, appointment_id: A.mariaNext });
    await api(app, employee(U.sam)).post(`/api/payments/${P.unmatchedStripe}/assign`, { customer_id: C.jane }).expect(400);
    await api(app, employee(U.sam)).post(`/api/payments/${P.johnStripe}/assign`, { customer_id: C.maria }).expect(404);
  });

  it('admins see sync status and request reconciliation; staff cannot', async () => {
    const job = await api(app, employee(U.ada)).post('/api/admin/stripe/reconcile', { days: 7 }).expect(202);
    expect(job.body.status).toBe('queued');
    const status = await api(app, employee(U.ada)).get('/api/admin/stripe/status').expect(200);
    expect(status.body.events).toContainEqual(expect.objectContaining({ status: 'received' }));
    expect(status.body.lastReconcile).toMatchObject({ status: 'queued' });
    await api(app, employee(U.sam)).post('/api/admin/stripe/reconcile', {}).expect(403);
    await api(app, employee(U.ada)).post('/api/admin/stripe/reconcile', { days: 365 }).expect(400);
  });
});
