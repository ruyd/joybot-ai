import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runQueuedJobs } from '../src/jobs';
import { StripeApi } from '../src/stripe/api';
import { processPendingEvents } from '../src/stripe/processor';
import { reconcile } from '../src/stripe/reconcile';

config({ path: path.resolve(__dirname, '../../../.env') });
const worker = new Pool({ connectionString: process.env.WORKER_DATABASE_URL, max: 4 });
const { customers: C, appointments: A } = SAMPLE;
let seq = 0;
const quiet = () => undefined;

afterAll(async () => {
  await worker.end();
});

/** Stores an event the way the API webhook does. */
async function store(type: string, object: Record<string, unknown>, createdSec: number) {
  const id = `evt_test_${++seq}`;
  await worker.query(
    `INSERT INTO app.stripe_events (event_id, type, livemode, created, payload) VALUES ($1, $2, false, to_timestamp($3), $4)`,
    [id, type, createdSec, { id, type, created: createdSec, data: { object } }],
  );
  return id;
}

const payment = async (intentId: string) =>
  (await worker.query('SELECT * FROM core.payments WHERE stripe_payment_intent_id = $1', [intentId])).rows[0];

const intent = (id: string, extra: Record<string, unknown> = {}) => ({
  id, object: 'payment_intent', amount: 4500, currency: 'usd', status: 'succeeded', created: 1_760_000_000,
  payment_method_types: ['card'], latest_charge: `ch_${id}`, ...extra,
});
const charge = (intentId: string, extra: Record<string, unknown> = {}) => ({
  id: `ch_${intentId}`, object: 'charge', payment_intent: intentId, amount: 4500, amount_refunded: 0, currency: 'usd',
  created: 1_760_000_010, status: 'succeeded', disputed: false, receipt_url: `https://pay.stripe.com/receipts/${intentId}`,
  payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242' } }, ...extra,
});

describe('Stripe event processing', () => {
  it('links payments by metadata and fills card details from the charge', async () => {
    await store('payment_intent.succeeded', intent('pi_meta', { metadata: { customer_number: 'C-10001', appointment_number: (await worker.query(`SELECT appointment_number FROM core.appointments WHERE id = $1`, [A.mariaNext])).rows[0].appointment_number } }), 1_760_000_020);
    await store('charge.succeeded', charge('pi_meta'), 1_760_000_021);
    expect(await processPendingEvents(worker, 200, quiet)).toEqual({ processed: 2, ignored: 0, failed: 0 });
    expect(await payment('pi_meta')).toMatchObject({
      source: 'stripe', customer_id: C.maria, appointment_id: A.mariaNext, amount: '45.00', currency: 'USD',
      method: 'card_online', status: 'succeeded', card_brand: 'visa', card_last4: '4242',
      receipt_url: 'https://pay.stripe.com/receipts/pi_meta',
    });
  });

  it('ignores events older than the state already applied', async () => {
    await store('payment_intent.succeeded', intent('pi_order'), 1_760_000_100);
    await store('payment_intent.payment_failed', intent('pi_order', { status: 'requires_payment_method', last_payment_error: { message: 'Card declined' } }), 1_760_000_050);
    await processPendingEvents(worker, 200, quiet);
    expect((await payment('pi_order')).status).toBe('succeeded');
  });

  it('applies partial and full refunds, then disputes', async () => {
    await store('payment_intent.succeeded', intent('pi_refund'), 1_760_000_200);
    await store('charge.refunded', charge('pi_refund', { amount_refunded: 1500 }), 1_760_000_300);
    await processPendingEvents(worker, 200, quiet);
    expect(await payment('pi_refund')).toMatchObject({ status: 'partially_refunded', amount_refunded: '15.00' });

    await store('charge.refunded', charge('pi_refund', { amount_refunded: 4500 }), 1_760_000_400);
    await processPendingEvents(worker, 200, quiet);
    expect((await payment('pi_refund')).status).toBe('refunded');

    // A late "succeeded" snapshot never undoes a refund.
    await store('payment_intent.succeeded', intent('pi_refund'), 1_760_000_500);
    await processPendingEvents(worker, 200, quiet);
    expect((await payment('pi_refund')).status).toBe('refunded');
  });

  it('marks disputes and restores the state when a dispute is won', async () => {
    await store('payment_intent.succeeded', intent('pi_dispute'), 1_760_000_600);
    await store('charge.dispute.created', { id: 'dp_1', object: 'dispute', payment_intent: 'pi_dispute', status: 'needs_response' }, 1_760_000_700);
    await processPendingEvents(worker, 200, quiet);
    expect((await payment('pi_dispute')).status).toBe('disputed');
    await store('charge.dispute.closed', { id: 'dp_1', object: 'dispute', payment_intent: 'pi_dispute', status: 'won' }, 1_760_000_800);
    await processPendingEvents(worker, 200, quiet);
    expect((await payment('pi_dispute')).status).toBe('succeeded');
  });

  it('leaves unknown payers unmatched, then links them when the Stripe customer is linked', async () => {
    await store('payment_intent.succeeded', intent('pi_unmatched', { customer: 'cus_jane', receipt_email: 'someone@else.example' }), 1_760_000_900);
    await processPendingEvents(worker, 200, quiet);
    expect((await payment('pi_unmatched')).customer_id).toBeNull();

    await store('customer.created', { id: 'cus_jane', object: 'customer', email: 'jane@acme.example' }, 1_760_001_000);
    await processPendingEvents(worker, 200, quiet);
    expect((await payment('pi_unmatched')).customer_id).toBe(C.jane);
    expect((await worker.query('SELECT stripe_customer_id FROM core.customers WHERE id = $1', [C.jane])).rows[0].stripe_customer_id).toBe('cus_jane');
  });

  it('matches by verified email only', async () => {
    await store('payment_intent.succeeded', intent('pi_email', { receipt_email: 'MARIA@example.com' }), 1_760_001_100);
    await store('payment_intent.succeeded', intent('pi_unverified', { receipt_email: 'pat@nowhere.example' }), 1_760_001_101);
    await processPendingEvents(worker, 200, quiet);
    expect((await payment('pi_email')).customer_id).toBe(C.maria);
    expect((await payment('pi_unverified')).customer_id).toBeNull();
  });

  it('flags a Stripe payment that duplicates a manual entry', async () => {
    const manual = (await worker.query(`SELECT id, amount, paid_at FROM core.payments WHERE source = 'manual' AND customer_id = $1 AND method = 'card_pos'`, [C.maria])).rows[0];
    const created = Math.floor(new Date(manual.paid_at).getTime() / 1000) + 3600;
    await store('payment_intent.succeeded', intent('pi_dup', { amount: Number(manual.amount) * 100, metadata: { customer_number: 'C-10001' }, created, latest_charge: null }), created);
    await processPendingEvents(worker, 200, quiet);
    expect((await payment('pi_dup')).possible_duplicate_of).toBe(manual.id);
  });

  it('handles zero-decimal currencies', async () => {
    await store('payment_intent.succeeded', intent('pi_jpy', { amount: 5000, currency: 'jpy' }), 1_760_001_200);
    await processPendingEvents(worker, 200, quiet);
    expect(await payment('pi_jpy')).toMatchObject({ amount: '5000.00', currency: 'JPY' });
  });

  it('ignores unrelated event types and retries failures with backoff', async () => {
    const ignored = await store('invoice.created', { id: 'in_1' }, 1_760_001_300);
    const broken = await store('payment_intent.succeeded', { id: 'pi_broken', object: 'payment_intent', status: 'succeeded', created: 1, currency: 'usd' }, 1_760_001_301);
    const logs: string[] = [];
    const res = await processPendingEvents(worker, 200, (l) => logs.push(l));
    expect(res).toMatchObject({ ignored: 1, failed: 1 });
    const rows = (await worker.query(`SELECT event_id, status, attempts, next_attempt_at > now() AS later FROM app.stripe_events WHERE event_id = ANY($1) ORDER BY event_id`, [[ignored, broken]])).rows;
    expect(rows).toEqual([
      { event_id: ignored, status: 'ignored', attempts: 1, later: false },
      { event_id: broken, status: 'received', attempts: 1, later: true },
    ].sort((a, b) => a.event_id.localeCompare(b.event_id)));
    expect(JSON.parse(logs[0])).toMatchObject({ event: 'stripe_event_failed', eventId: broken });
  });
});

describe('Stripe reconciliation', () => {
  let server: http.Server;
  let base: string;
  const intents = [
    intent('pi_recon_new', { metadata: { customer_number: 'C-10006' }, latest_charge: charge('pi_recon_new') }),
    intent('pi_refund', { latest_charge: charge('pi_refund', { amount_refunded: 4500 }) }),
    intent('pi_abandoned', { status: 'requires_payment_method' }),
  ];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer rk_test_key') {
        res.writeHead(401).end();
        return;
      }
      const url = new URL(req.url!, 'http://x');
      const after = url.searchParams.get('starting_after');
      const page = after ? intents.slice(intents.findIndex((i) => i.id === after) + 1) : intents.slice(0, 2);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: page, has_more: !after }));
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('creates missing payments and keeps existing state, across pages', async () => {
    const result = await reconcile(worker, new StripeApi('rk_test_key', base), 3);
    expect(result.seen).toBe(3);
    expect(await payment('pi_recon_new')).toMatchObject({ customer_id: C.pat, status: 'succeeded', card_last4: '4242' });
    expect((await payment('pi_refund')).status).toBe('refunded');
    expect(await payment('pi_abandoned')).toBeUndefined();
  });

  it('runs on request through worker jobs', async () => {
    const job = (await worker.query(`INSERT INTO app.worker_jobs (kind) VALUES ('stripe_reconcile') RETURNING id`)).rows[0];
    const ran = await runQueuedJobs(worker, { stripe_reconcile: async () => ({ ...(await reconcile(worker, new StripeApi('rk_test_key', base), 3)) }) });
    expect(ran).toBe(1);
    const done = (await worker.query('SELECT status, result FROM app.worker_jobs WHERE id = $1', [job.id])).rows[0];
    expect(done).toMatchObject({ status: 'done', result: { seen: 3 } });
  });

  it('fails the job clearly with a bad key', async () => {
    await worker.query(`INSERT INTO app.worker_jobs (kind) VALUES ('stripe_reconcile')`);
    await runQueuedJobs(worker, { stripe_reconcile: async () => ({ ...(await reconcile(worker, new StripeApi('wrong', base), 3)) }) });
    const failed = (await worker.query(`SELECT result FROM app.worker_jobs WHERE status = 'failed'`)).rows[0];
    expect(failed.result.error).toMatch(/401/);
  });
});
