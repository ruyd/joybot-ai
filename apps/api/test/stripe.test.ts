import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signStripePayload, verifyStripeSignature } from '../src/stripe/signature';
import { StripeSecrets } from '../src/stripe/stripe-secrets';
import { api, createApp, customer, employee } from './app';

const SECRET = 'whsec_test_secret';
/** A made-up Stripe key, built at run time so it doesn't look like a real one to secret scanners. */
const fakeKey = (prefix: 'sk' | 'rk', mode: 'live' | 'test', tail: string) => [prefix, mode, `51Fake${tail}`].join('_');
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
    await migrator.query(`UPDATE core.settings SET stripe_enabled = false, stripe_reconcile_interval_hours = 24, stripe_reconcile_days = 3`);
    await migrator.query(`UPDATE core.stripe_secret SET api_key_cipher = NULL, api_key_last4 = NULL, api_key_set_at = NULL, api_key_set_by = NULL,
      webhook_secret_cipher = NULL, webhook_secret_last4 = NULL, webhook_secret_set_at = NULL, webhook_secret_set_by = NULL,
      test_api_key_cipher = NULL, test_api_key_last4 = NULL, test_webhook_secret_cipher = NULL, test_webhook_secret_last4 = NULL`);
    await migrator.query('UPDATE core.settings SET stripe_test_mode = false');
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

  it('admins save the live API key encrypted, see only its last four, and the app uses it', async () => {
    const KEY = fakeKey('rk', 'live', 'AbCdEfGhIjKlMnOpQrStUvWx1234');
    const before = (await api(app, employee(U.ada)).get('/api/admin/stripe/status').expect(200)).body;
    expect(before).toMatchObject({ encryption_available: true, mode: 'live', api_key: { last4: null }, active: { api_key: null, webhook_secret: 'server' } });

    await api(app, employee(U.ada)).put('/api/admin/stripe/api-key', { api_key: 'not-a-stripe-key' }).expect(400);
    await api(app, employee(U.ada)).put('/api/admin/stripe/api-key', { api_key: fakeKey('rk', 'test', 'AbCdEfGhIjKlMnOpQrStUvWx1234') }).expect(400);
    await api(app, employee(U.sam)).put('/api/admin/stripe/api-key', { api_key: KEY }).expect(403);
    await api(app, customer(C.maria)).put('/api/admin/stripe/api-key', { api_key: KEY }).expect(403);

    const saved = (await api(app, employee(U.ada)).put('/api/admin/stripe/api-key', { api_key: KEY }).expect(200)).body;
    expect(saved).toMatchObject({ api_key: { last4: '1234', set_by_name: 'Ada Admin' }, active: { api_key: 'settings' } });
    expect(JSON.stringify(saved)).not.toContain(KEY);
    // Stored encrypted, in a table the API's role can't read.
    const row = (await migrator.query('SELECT api_key_cipher FROM core.stripe_secret')).rows[0];
    expect(row.api_key_cipher).toMatch(/^v1\./);
    expect(row.api_key_cipher).not.toContain(KEY);
    const appDb = new Client({ connectionString: process.env.APP_DATABASE_URL });
    await appDb.connect();
    await expect(appDb.query('SELECT * FROM core.stripe_secret')).rejects.toMatchObject({ code: '42501' });
    await expect(appDb.query('SELECT * FROM authz.stripe_secret_info()')).rejects.toMatchObject({ code: '42501' });
    await appDb.end();
    // Invoice checkout now uses it.
    expect(await app.get(StripeSecrets).checkoutKey()).toBe(KEY);

    await api(app, employee(U.sam)).delete('/api/admin/stripe/api-key').expect(403);
    const removed = (await api(app, employee(U.ada)).delete('/api/admin/stripe/api-key').expect(200)).body;
    expect(removed).toMatchObject({ api_key: { last4: null }, active: { api_key: null } });
    expect(await app.get(StripeSecrets).checkoutKey()).toBeUndefined();
  });

  it('a webhook signing secret saved in Settings › Stripe replaces the server one', async () => {
    const SAVED = 'whsec_SavedInSettings0123456789abcd';
    await migrator.query(`UPDATE core.settings SET stripe_enabled = true`);
    await api(app, employee(U.ada)).put('/api/admin/stripe/webhook-secret', { webhook_secret: 'sk_test_wrongkind' }).expect(400);
    await api(app, employee(U.sam)).put('/api/admin/stripe/webhook-secret', { webhook_secret: SAVED }).expect(403);
    const saved = (await api(app, employee(U.ada)).put('/api/admin/stripe/webhook-secret', { webhook_secret: SAVED }).expect(200)).body;
    expect(saved).toMatchObject({ webhook_secret: { last4: 'abcd' }, active: { webhook_secret: 'settings' } });
    expect(JSON.stringify(saved)).not.toContain(SAVED);

    const raw = JSON.stringify(event('evt_saved_secret'));
    const send = (secret: string) =>
      request(app.getHttpServer()).post('/api/webhooks/stripe').set('content-type', 'application/json').set('stripe-signature', signStripePayload(raw, secret)).send(raw);
    await send(SECRET).expect(400);
    expect((await send(SAVED).expect(200)).body).toMatchObject({ received: true });

    const removed = (await api(app, employee(U.ada)).delete('/api/admin/stripe/webhook-secret').expect(200)).body;
    expect(removed).toMatchObject({ webhook_secret: { last4: null }, active: { webhook_secret: 'server' } });
    expect((await send(SECRET).expect(200)).body).toMatchObject({ received: true, duplicate: true });
  });

  it('admins set the reconcile schedule; Reconcile now without days uses it', async () => {
    const saved = (await api(app, employee(U.ada)).put('/api/admin/settings', { stripe_reconcile_interval_hours: 6, stripe_reconcile_days: 14 }).expect(200)).body;
    expect(saved).toMatchObject({ stripe_reconcile_interval_hours: 6, stripe_reconcile_days: 14 });
    await api(app, employee(U.ada)).put('/api/admin/settings', { stripe_reconcile_interval_hours: 0 }).expect(400);
    await api(app, employee(U.ada)).put('/api/admin/settings', { stripe_reconcile_days: 91 }).expect(400);
    await api(app, employee(U.sam)).put('/api/admin/settings', { stripe_reconcile_days: 5 }).expect(403);
    // Not for customers or staff to see.
    expect((await api(app, customer(C.maria)).get('/api/settings').expect(200)).body).not.toHaveProperty('stripe_reconcile_days');

    const job = (await api(app, employee(U.ada)).post('/api/admin/stripe/reconcile', {}).expect(202)).body;
    expect((await migrator.query('SELECT params FROM app.worker_jobs WHERE id = $1', [job.id])).rows[0].params).toEqual({});
  });

  it('test mode uses the test key and applies only test-mode webhooks', async () => {
    const LIVE = fakeKey('rk', 'live', 'LiveLiveLiveLiveLive0001');
    const TEST = fakeKey('sk', 'test', 'TestTestTestTestTest0002');
    const LIVE_HOOK = 'whsec_LiveEndpointSecret0123456789';
    const TEST_HOOK = 'whsec_TestEndpointSecret0123456789';
    const ada = () => api(app, employee(U.ada));
    await migrator.query(`UPDATE core.settings SET stripe_enabled = true`);
    await ada().put('/api/admin/stripe/test-api-key', { api_key: LIVE }).expect(400);
    await api(app, employee(U.sam)).put('/api/admin/stripe/test-api-key', { api_key: TEST }).expect(403);
    await ada().put('/api/admin/stripe/api-key', { api_key: LIVE }).expect(200);
    await ada().put('/api/admin/stripe/test-api-key', { api_key: TEST }).expect(200);
    await ada().put('/api/admin/stripe/webhook-secret', { webhook_secret: LIVE_HOOK }).expect(200);
    const saved = (await ada().put('/api/admin/stripe/test-webhook-secret', { webhook_secret: TEST_HOOK }).expect(200)).body;
    expect(saved).toMatchObject({ mode: 'live', test_api_key: { last4: '0002' }, test_webhook_secret: { last4: '6789' } });
    expect(await app.get(StripeSecrets).checkoutKey()).toBe(LIVE);

    let n = 0;
    const send = (secret: string, livemode: boolean) => {
      const raw = JSON.stringify({ ...event(`evt_mode_${++n}`), livemode });
      return request(app.getHttpServer()).post('/api/webhooks/stripe').set('content-type', 'application/json').set('stripe-signature', signStripePayload(raw, secret)).send(raw);
    };
    expect((await send(LIVE_HOOK, true).expect(200)).body).toMatchObject({ received: true });
    expect((await send(TEST_HOOK, false).expect(200)).body).toMatchObject({ received: false });
    await send(SECRET, false).expect(400); // the server's secret is no longer used

    await api(app, employee(U.sam)).put('/api/admin/stripe/mode', { mode: 'test' }).expect(403);
    const test = (await ada().put('/api/admin/stripe/mode', { mode: 'test' }).expect(200)).body;
    expect(test).toMatchObject({ mode: 'test', active: { api_key: 'settings', webhook_secret: 'settings' } });
    expect(await app.get(StripeSecrets).checkoutKey()).toBe(TEST);
    expect((await migrator.query('SELECT authz.stripe_key_cipher() AS k')).rows[0].k).toBe(
      (await migrator.query('SELECT test_api_key_cipher AS k FROM core.stripe_secret')).rows[0].k,
    ); // the worker reconciles with it too
    expect((await send(TEST_HOOK, false).expect(200)).body).toMatchObject({ received: true });
    expect((await send(LIVE_HOOK, true).expect(200)).body).toMatchObject({ received: false });

    await ada().put('/api/admin/stripe/mode', { mode: 'live' }).expect(200);
    expect(await app.get(StripeSecrets).checkoutKey()).toBe(LIVE);
  });
});
