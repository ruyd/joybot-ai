import type { Pool } from 'pg';
import { applyEvent, type StoredEvent } from './apply';

const MAX_ATTEMPTS = 10;

export interface ProcessResult {
  processed: number;
  ignored: number;
  failed: number;
}

/**
 * Drains app.stripe_events (stored by the API webhook) in Stripe order. Each event is applied in
 * its own transaction; failures retry with backoff (1, 2, 4 … 60 minutes) and give up after 10.
 * Safe to run on several workers at once (FOR UPDATE SKIP LOCKED).
 */
export async function processPendingEvents(pool: Pool, max = 200, log = console.log): Promise<ProcessResult> {
  const result: ProcessResult = { processed: 0, ignored: 0, failed: 0 };
  for (let i = 0; i < max; i++) {
    const client = await pool.connect();
    let event: StoredEvent | undefined;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.via', 'stripe_webhook', true)`);
      event = (
        await client.query<StoredEvent & { attempts: number }>(
          `SELECT event_id, type, created, payload, attempts FROM app.stripe_events
            WHERE status = 'received' AND next_attempt_at <= now()
            ORDER BY created, received_at
            LIMIT 1 FOR UPDATE SKIP LOCKED`,
        )
      ).rows[0];
      if (!event) {
        await client.query('COMMIT');
        break;
      }
      const outcome = await applyEvent(client, event);
      await client.query(
        `UPDATE app.stripe_events SET status = $2, processed_at = now(), attempts = attempts + 1, error = NULL WHERE event_id = $1`,
        [event.event_id, outcome],
      );
      await client.query('COMMIT');
      result[outcome === 'processed' ? 'processed' : 'ignored']++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (!event) throw err;
      result.failed++;
      const message = err instanceof Error ? err.message : String(err);
      await client.query(
        `UPDATE app.stripe_events
            SET attempts = attempts + 1, error = left($2, 1000),
                status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'received' END,
                next_attempt_at = now() + make_interval(mins => least(power(2, attempts)::int, 60))
          WHERE event_id = $1`,
        [event.event_id, message, MAX_ATTEMPTS],
      );
      // Metric filter in the backend stack counts these lines (alarm: stripe events failing).
      log(JSON.stringify({ event: 'stripe_event_failed', eventId: event.event_id, type: event.type, error: message }));
    } finally {
      client.release();
    }
  }
  return result;
}
