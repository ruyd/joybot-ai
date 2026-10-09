import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { Pool } from 'pg';
import { loadConfig, stripeRestrictedKey } from './config';
import { runQueuedJobs } from './jobs';
import { StripeApi } from './stripe/api';
import { processPendingEvents } from './stripe/processor';
import { reconcile } from './stripe/reconcile';

/**
 * JoyBot worker (plan.md §3): applies Stripe events stored by the API, reconciles with Stripe
 * nightly or on request, and runs other queued jobs. Stateless; safe to run more than one.
 */
async function main(): Promise<void> {
  loadEnv({ path: path.resolve(__dirname, '../../../.env') });
  const cfg = loadConfig();
  const pool = new Pool(cfg.pool);
  let stopping = false;
  let lastReconcile = 0;

  const stripeEnabled = async () =>
    (await pool.query<{ on: boolean }>('SELECT authz.stripe_enabled() AS on')).rows[0].on;

  const runReconcile = async () => {
    const key = await stripeRestrictedKey();
    if (!key) throw new Error('Stripe restricted key is not configured');
    const result = await reconcile(pool, new StripeApi(key, cfg.stripeApiBase), cfg.reconcileDays);
    lastReconcile = Date.now();
    console.log(JSON.stringify({ event: 'stripe_reconciled', ...result }));
    return { ...result };
  };

  const tick = async () => {
    const processed = await processPendingEvents(pool);
    if (processed.processed + processed.failed > 0) console.log(JSON.stringify({ event: 'stripe_events', ...processed }));
    await runQueuedJobs(pool, { stripe_reconcile: runReconcile });
    const due = Date.now() - lastReconcile > cfg.reconcileIntervalHours * 3_600_000;
    if (due && (await stripeEnabled()) && (await stripeRestrictedKey())) await runReconcile();
  };

  const shutdown = () => {
    stopping = true;
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(JSON.stringify({ event: 'worker_started' }));
  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      console.error(JSON.stringify({ event: 'worker_error', error: err instanceof Error ? err.message : String(err) }));
    }
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
  }
  await pool.end();
  console.log(JSON.stringify({ event: 'worker_stopped' }));
}

void main();
