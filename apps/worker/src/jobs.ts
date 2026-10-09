import type { Pool } from 'pg';

export type JobHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Runs queued app.worker_jobs (requested from the API, e.g. "reconcile Stripe now"). */
export async function runQueuedJobs(pool: Pool, handlers: Record<string, JobHandler>): Promise<number> {
  let ran = 0;
  for (;;) {
    const job = (
      await pool.query<{ id: string; kind: string; params: Record<string, unknown> }>(
        `UPDATE app.worker_jobs SET status = 'running'
          WHERE id = (SELECT id FROM app.worker_jobs WHERE status = 'queued' ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING id, kind, params`,
      )
    ).rows[0];
    if (!job) return ran;
    ran++;
    try {
      const handler = handlers[job.kind];
      if (!handler) throw new Error(`no handler for ${job.kind}`);
      const result = await handler(job.params);
      await pool.query(`UPDATE app.worker_jobs SET status = 'done', result = $2, finished_at = now() WHERE id = $1`, [job.id, result]);
    } catch (err) {
      await pool.query(`UPDATE app.worker_jobs SET status = 'failed', result = $2, finished_at = now() WHERE id = $1`, [
        job.id,
        { error: err instanceof Error ? err.message : String(err) },
      ]);
    }
  }
}
