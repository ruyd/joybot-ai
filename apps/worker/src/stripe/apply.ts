import type { PoolClient } from 'pg';
import { fromCharge, fromIntent, type PaymentUpsert, type StripeCharge, type StripePaymentIntent } from './mapping';

export type Outcome = 'processed' | 'ignored';

export interface StoredEvent {
  event_id: string;
  type: string;
  created: Date;
  payload: { data?: { object?: Record<string, unknown> } };
}

const DUPLICATE_WINDOW_DAYS = 2;

/** Applies one Stripe event inside the caller's transaction (joybot_worker role). */
export async function applyEvent(db: PoolClient, event: StoredEvent): Promise<Outcome> {
  const object = event.payload.data?.object ?? {};
  const syncedAt = event.created.toISOString();
  switch (event.type) {
    case 'payment_intent.succeeded':
    case 'payment_intent.processing':
    case 'payment_intent.payment_failed':
    case 'payment_intent.canceled':
      await upsertPayment(db, fromIntent(object as unknown as StripePaymentIntent), syncedAt);
      return 'processed';

    case 'charge.succeeded':
    case 'charge.updated':
    case 'charge.refunded':
    case 'charge.failed': {
      const update = fromCharge(object as unknown as StripeCharge);
      if (!update) return 'ignored';
      await upsertPayment(db, update, syncedAt);
      return 'processed';
    }

    case 'charge.dispute.created':
      await db.query(
        `UPDATE core.payments SET status = 'disputed', stripe_synced_at = greatest(stripe_synced_at, $2)
          WHERE stripe_payment_intent_id = $1`,
        [object.payment_intent, syncedAt],
      );
      return 'processed';

    case 'charge.dispute.closed':
      // Won: back to its refund-aware state. Lost: stays disputed, with the reason shown to staff.
      await db.query(
        `UPDATE core.payments
            SET status = CASE WHEN $2 = 'won'
                              THEN CASE WHEN amount_refunded >= amount THEN 'refunded'
                                        WHEN amount_refunded > 0 THEN 'partially_refunded'
                                        ELSE 'succeeded' END
                              ELSE 'disputed' END,
                failure_reason = CASE WHEN $2 = 'lost' THEN 'Dispute lost' ELSE failure_reason END,
                stripe_synced_at = greatest(stripe_synced_at, $3)
          WHERE stripe_payment_intent_id = $1 AND status = 'disputed'`,
        [object.payment_intent, object.status, syncedAt],
      );
      return 'processed';

    case 'customer.created':
    case 'customer.updated':
      return linkStripeCustomer(db, object as { id: string; email?: string | null; metadata?: Record<string, string> });

    default:
      return 'ignored';
  }
}

/** Inserts or updates a Stripe payment; never moves a payment back to an older state. */
export async function upsertPayment(db: PoolClient, u: PaymentUpsert, syncedAt: string): Promise<{ id: string; inserted: boolean } | undefined> {
  const res = await db.query<{ id: string; customer_id: string | null; amount: string; paid_at: Date | null; inserted: boolean }>(
    `WITH m AS (SELECT * FROM core.match_stripe_customer($1, $2, $3, $4))
     INSERT INTO core.payments AS p
       (source, customer_id, appointment_id, location_id, amount, amount_refunded, currency, method, status,
        stripe_payment_intent_id, stripe_charge_id, stripe_customer_id, stripe_invoice_id, failure_reason,
        receipt_url, card_brand, card_last4, paid_at, stripe_synced_at)
     SELECT 'stripe', m.customer_id, m.appointment_id, m.location_id, $5, $6, $7, $8, $9,
            $10, $11, $3, $12, $13, $14, $15, $16, $17, $18
       FROM (SELECT 1) one LEFT JOIN m ON true
     ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET
       amount = EXCLUDED.amount,
       amount_refunded = greatest(p.amount_refunded, EXCLUDED.amount_refunded),
       currency = EXCLUDED.currency,
       method = EXCLUDED.method,
       status = CASE WHEN p.status IN ('refunded', 'partially_refunded', 'disputed')
                      AND EXCLUDED.status IN ('succeeded', 'processing', 'pending')
                     THEN p.status ELSE EXCLUDED.status END,
       stripe_charge_id = coalesce(EXCLUDED.stripe_charge_id, p.stripe_charge_id),
       stripe_customer_id = coalesce(EXCLUDED.stripe_customer_id, p.stripe_customer_id),
       stripe_invoice_id = coalesce(EXCLUDED.stripe_invoice_id, p.stripe_invoice_id),
       failure_reason = EXCLUDED.failure_reason,
       receipt_url = coalesce(EXCLUDED.receipt_url, p.receipt_url),
       card_brand = coalesce(EXCLUDED.card_brand, p.card_brand),
       card_last4 = coalesce(EXCLUDED.card_last4, p.card_last4),
       paid_at = coalesce(p.paid_at, EXCLUDED.paid_at),
       customer_id = coalesce(p.customer_id, EXCLUDED.customer_id),
       appointment_id = coalesce(p.appointment_id, EXCLUDED.appointment_id),
       location_id = coalesce(p.location_id, EXCLUDED.location_id),
       stripe_synced_at = EXCLUDED.stripe_synced_at
     WHERE p.stripe_synced_at IS NULL OR EXCLUDED.stripe_synced_at >= p.stripe_synced_at
     RETURNING p.id, p.customer_id, p.amount, p.paid_at, (xmax = 0) AS inserted`,
    [
      u.match.customerNumber,
      u.match.appointmentNumber,
      u.stripeCustomerId,
      u.match.email,
      u.amount,
      u.amountRefunded,
      u.currency,
      u.method,
      u.status,
      u.intentId,
      u.chargeId,
      u.invoiceId,
      u.failureReason,
      u.receiptUrl,
      u.cardBrand,
      u.cardLast4,
      u.paidAt,
      syncedAt,
    ],
  );
  const row = res.rows[0];
  if (!row) return undefined; // older than what we already have

  // A payment recorded by hand that also came through Stripe (plan.md §4.4 duplicate detection).
  if (row.customer_id) {
    await db.query(
      `UPDATE core.payments np SET possible_duplicate_of = (
         SELECT m.id FROM core.payments m
          WHERE m.customer_id = $2 AND m.source = 'manual' AND m.amount = $3
            AND m.status NOT IN ('voided', 'failed', 'canceled')
            AND coalesce(m.paid_at, m.expected_at::timestamptz, m.created_at)
                BETWEEN coalesce($4::timestamptz, now()) - make_interval(days => $5)
                    AND coalesce($4::timestamptz, now()) + make_interval(days => $5)
          ORDER BY abs(extract(epoch FROM coalesce(m.paid_at, m.created_at) - coalesce($4::timestamptz, now())))
          LIMIT 1)
        WHERE np.id = $1 AND np.possible_duplicate_of IS NULL`,
      [row.id, row.customer_id, row.amount, row.paid_at, DUPLICATE_WINDOW_DAYS],
    );
  }
  return { id: row.id, inserted: row.inserted };
}

/** Links a Stripe customer to a JoyBot customer (metadata customer_number, else verified email). */
async function linkStripeCustomer(db: PoolClient, customer: { id: string; email?: string | null; metadata?: Record<string, string> }): Promise<Outcome> {
  const linked = await db.query<{ id: string }>(
    `UPDATE core.customers SET stripe_customer_id = $1
      WHERE id = (SELECT c.id FROM core.customers c
                   WHERE c.stripe_customer_id IS NULL
                     AND (c.customer_number = upper($2) OR (c.email = lower($3) AND c.email_verified))
                   ORDER BY (c.customer_number = upper($2)) DESC NULLS LAST
                   LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM core.customers o WHERE o.stripe_customer_id = $1)
      RETURNING id`,
    [customer.id, customer.metadata?.customer_number ?? null, customer.email ?? null],
  );
  if (!linked.rows[0]) return 'ignored';
  // Payments that arrived before the customer was linked.
  await db.query(
    `UPDATE core.payments SET customer_id = $2 WHERE customer_id IS NULL AND source = 'stripe' AND stripe_customer_id = $1`,
    [customer.id, linked.rows[0].id],
  );
  return 'processed';
}
