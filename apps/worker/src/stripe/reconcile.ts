import type { Pool } from 'pg';
import { upsertPayment } from './apply';
import type { StripeApi } from './api';
import { fromIntent } from './mapping';

export interface ReconcileResult {
  seen: number;
  changed: number;
}

/**
 * Nightly / on-demand reconciliation (plan.md §4.4): reads the last `days` of PaymentIntents from
 * Stripe and applies their current state, which fixes anything a missed webhook left behind.
 */
export async function reconcile(pool: Pool, api: StripeApi, days = 3, now = new Date()): Promise<ReconcileResult> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const result: ReconcileResult = { seen: 0, changed: 0 };
  for await (const pi of api.paymentIntentsSince(since)) {
    result.seen++;
    if (pi.status === 'requires_payment_method' && !pi.last_payment_error) continue; // abandoned checkout
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.via', 'stripe_reconcile', true)`);
      if (await upsertPayment(client, fromIntent(pi), now.toISOString())) result.changed++;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  return result;
}
