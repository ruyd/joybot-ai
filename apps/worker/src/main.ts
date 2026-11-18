import os from 'node:os';
import path from 'node:path';
import { settingsSecret } from '@joybot/db';
import { config as loadEnv } from 'dotenv';
import { Pool, types } from 'pg';

// DATE columns are calendar dates: keep them as 'YYYY-MM-DD' (no time-zone shift).
types.setTypeParser(types.builtins.DATE, (value) => value);
import { loadConfig, reconcileSettings, stripeRestrictedKey } from './config';
import { pruneAiJobs, runAiJobs } from './ai/queue';
import { connect, startBullWorker, startStreamConsumer, sweep } from './ai/redis';
import { runQueuedJobs } from './jobs';
import { StripeApi } from './stripe/api';
import { processPendingEvents } from './stripe/processor';
import { reconcile } from './stripe/reconcile';

/**
 * JoyBot worker (plan.md §3): applies Stripe events stored by the API, reconciles with Stripe
 * nightly or on request, runs other queued jobs, and runs AI jobs from the Postgres queue (woken by
 * NOTIFY ai_jobs, else polled) and, with REDIS_URL, from BullMQ and Redis Streams. Stateless; safe to
 * run more than one.
 */
async function main(): Promise<void> {
  loadEnv({ path: path.resolve(__dirname, '../../../.env') });
  const cfg = loadConfig();
  const pool = new Pool(cfg.pool);
  let stopping = false;
  let lastReconcile = 0;

  const stripeEnabled = async () =>
    (await pool.query<{ on: boolean }>('SELECT authz.stripe_enabled() AS on')).rows[0].on;

  /** Reconciles the last `days` days: a "Reconcile now" request's own, else the setting. */
  const runReconcile = async (params: Record<string, unknown> = {}) => {
    const key = await stripeRestrictedKey(pool);
    if (!key) throw new Error('No Stripe API key: save one in Settings › Stripe');
    const requested = Number(params.days);
    const days = Number.isInteger(requested) && requested >= 1 && requested <= 90 ? requested : (await reconcileSettings(pool)).days;
    const result = await reconcile(pool, new StripeApi(key, cfg.stripeApiBase), days);
    lastReconcile = Date.now();
    console.log(JSON.stringify({ event: 'stripe_reconciled', ...result }));
    return { ...result };
  };

  const tick = async () => {
    const processed = await processPendingEvents(pool);
    if (processed.processed + processed.failed > 0) console.log(JSON.stringify({ event: 'stripe_events', ...processed }));
    await runQueuedJobs(pool, { stripe_reconcile: runReconcile });
    const due = Date.now() - lastReconcile > (await reconcileSettings(pool)).intervalHours * 3_600_000;
    if (due && (await stripeEnabled()) && (await stripeRestrictedKey(pool))) await runReconcile();
  };

  const shutdown = () => {
    stopping = true;
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // AI jobs run in their own loop: a slow model call never holds up Stripe events, and NOTIFY wakes it at once.
  const workerId = `${os.hostname()}:${process.pid}`;
  const secret = settingsSecret(process.env);
  let wake: (() => void) | undefined;
  const listener = await pool.connect();
  listener.on('notification', () => wake?.());
  listener.on('error', (err) => console.error(JSON.stringify({ event: 'ai_listen_error', error: err.message })));
  await listener.query('LISTEN ai_jobs');
  let lastPrune = 0;
  const aiOpts = { workerId, secret, concurrency: cfg.aiConcurrency, log: (e: Record<string, unknown>) => console.log(JSON.stringify(e)) };
  const redis = cfg.redisUrl ? connect(cfg.redisUrl, cfg.redisPrefix) : undefined;
  const bull = redis && cfg.redisUrl ? startBullWorker(pool, cfg.redisUrl, cfg.redisPrefix, aiOpts) : undefined;
  const stopStreams = redis && cfg.redisUrl ? await startStreamConsumer(pool, redis, cfg.redisUrl, aiOpts) : undefined;
  const aiLoop = (async () => {
    while (!stopping) {
      try {
        await runAiJobs(pool, aiOpts);
        if (redis) {
          const swept = await sweep(pool, redis);
          if (swept) console.log(JSON.stringify({ event: 'ai_jobs_swept', swept }));
        }
        if (Date.now() - lastPrune > 3_600_000) {
          lastPrune = Date.now();
          const pruned = await pruneAiJobs(pool);
          if (pruned) console.log(JSON.stringify({ event: 'ai_jobs_pruned', pruned }));
        }
      } catch (err) {
        console.error(JSON.stringify({ event: 'ai_queue_error', error: err instanceof Error ? err.message : String(err) }));
      }
      // Jobs waiting for a retry are picked up by the poll; new ones wake the loop right away.
      await new Promise<void>((r) => {
        const timer = setTimeout(r, cfg.pollIntervalMs * 5);
        wake = () => {
          clearTimeout(timer);
          r();
        };
      });
      wake = undefined;
    }
  })();

  const shutdownAi = () => wake?.();
  process.on('SIGTERM', shutdownAi);
  process.on('SIGINT', shutdownAi);

  console.log(JSON.stringify({ event: 'worker_started' }));
  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      console.error(JSON.stringify({ event: 'worker_error', error: err instanceof Error ? err.message : String(err) }));
    }
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
  }
  await aiLoop;
  await bull?.close();
  await stopStreams?.();
  await redis?.queue.close();
  redis?.redis.disconnect();
  listener.release();
  await pool.end();
  console.log(JSON.stringify({ event: 'worker_stopped' }));
}

void main();
