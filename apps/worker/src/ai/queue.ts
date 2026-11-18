import { openSecret } from '@joybot/db';
import type { Pool } from 'pg';
import { PermanentError, ProviderError, RUNNERS, type Target } from './runners';

/**
 * The Postgres queue for AI capabilities (migration 0059). Jobs are claimed with FOR UPDATE SKIP LOCKED,
 * so several workers can share the queue; a claim is a lease that another worker takes over if this one
 * dies. Each job tries the slot's model, then its backup, and retries later with backoff.
 */

export type JobTransport = 'postgres' | 'bullmq' | 'redis_streams';

export interface AiJob {
  id: string;
  transport: JobTransport;
  capability: string;
  input: Record<string, unknown>;
  audience: 'employee' | 'customer' | 'admin';
  attempts: number;
  max_attempts: number;
}

interface SlotRow extends Omit<Target, 'apiKey'> {
  slot_active: boolean;
  role: 'primary' | 'backup';
  connection_active: boolean;
  over_cap: boolean;
  api_key_cipher: string | null;
}

export interface QueueOptions {
  /** Who is working (shows on the job while it runs). */
  workerId: string;
  /** SETTINGS_ENCRYPTION_KEY, to read connections' keys. */
  secret?: string;
  /** How long a claim lasts before another worker may take the job over. */
  leaseMs?: number;
  /** How many jobs run at the same time. */
  concurrency?: number;
  log?: (event: Record<string, unknown>) => void;
}

export const LEASE_MS = 10 * 60_000;

/** Wait before the next try: 30 s, 2 min, 8 min… up to an hour. */
export const backoffMs = (attempt: number) => Math.min(30_000 * 4 ** Math.max(attempt - 1, 0), 3_600_000);

const CLAIM = `SET status = 'running', attempts = attempts + 1, locked_by = $1,
       locked_until = now() + make_interval(secs => $2::double precision / 1000), started_at = now()`;
const RETURNING = 'RETURNING id, transport, capability, input, audience, attempts, max_attempts';

/** Postgres queue: claims the next due job (or one whose lease ran out). */
export async function claimAiJob(pool: Pool, workerId: string, leaseMs = LEASE_MS): Promise<AiJob | undefined> {
  return (
    await pool.query<AiJob>(
      `UPDATE app.ai_jobs ${CLAIM}
        WHERE id = (SELECT id FROM app.ai_jobs
                     WHERE transport = 'postgres'
                       AND ((status = 'queued' AND run_after <= now()) OR (status = 'running' AND locked_until < now()))
                     ORDER BY priority DESC, run_after
                     LIMIT 1 FOR UPDATE SKIP LOCKED)
        ${RETURNING}`,
      [workerId, leaseMs],
    )
  ).rows[0];
}

/**
 * Redis deliveries: claims the job a message named, unless it's finished, cancelled, waiting for a later
 * try, or running under a live lease. Redis may deliver a message twice; this makes the second a no-op.
 */
export async function claimAiJobById(pool: Pool, id: string, transport: JobTransport, workerId: string, leaseMs = LEASE_MS): Promise<AiJob | undefined> {
  return (
    await pool.query<AiJob>(
      `UPDATE app.ai_jobs ${CLAIM}
        WHERE id = $3 AND transport = $4
          AND ((status = 'queued' AND run_after <= now() + interval '5 seconds') OR (status = 'running' AND locked_until < now()))
        ${RETURNING}`,
      [workerId, leaseMs, id, transport],
    )
  ).rows[0];
}

/** The slot's models this job may use, in order: on, under their cap, private for customers, with a key where needed. */
async function targets(pool: Pool, job: AiJob, secret: string | undefined): Promise<Target[]> {
  const rows = (await pool.query<SlotRow>('SELECT * FROM authz.ai_slot_delivery($1)', [job.capability])).rows;
  if (!rows[0]?.slot_active) throw new PermanentError(`${job.capability} is turned off`);
  const models = rows.filter((r) => r.model_id && r.connection_id);
  if (!models.length) throw new PermanentError(`${job.capability} has no model`);
  const usable: Target[] = [];
  for (const r of models) {
    if (!r.connection_active || r.over_cap || (job.audience === 'customer' && !r.private)) continue;
    let apiKey: string | undefined;
    if (r.api_key_cipher) {
      if (!secret) throw new PermanentError('A key is saved, but SETTINGS_ENCRYPTION_KEY is not set for the worker');
      apiKey = openSecret(r.api_key_cipher, secret);
    }
    if (r.kind === 'openrouter' && !apiKey) continue;
    const { slot_active: _a, role: _r, connection_active: _c, over_cap: _o, api_key_cipher: _k, ...t } = r;
    usable.push({ ...t, apiKey });
  }
  // Nothing usable now (caps, keys, connections off) may change: retry later.
  if (!usable.length) throw new Error(`no ${job.capability} model is usable now (off, over its cap, no key or not private)`);
  return usable;
}

async function logCall(pool: Pool, t: Target, job: AiJob, out: { input_units?: number; output_units?: number; cost: number } | undefined, ms: number, err?: unknown) {
  await pool
    .query('SELECT authz.log_ai_call($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)', [
      t.connection_id,
      t.model_id,
      job.capability,
      t.model,
      job.audience,
      'job',
      out?.input_units ?? null,
      out?.output_units ?? null,
      out?.cost ?? 0,
      ms,
      !err,
      err ? (err as Error).message : null,
    ])
    .catch(() => undefined);
}

export interface RunPolicy {
  /** Wait before the next try (BullMQ passes its own backoff, so the row shows when it will run). */
  retryDelayMs?: (attempt: number) => number;
  /** BullMQ keeps the job for its retry: don't ask the sweep to hand it over again. */
  keepDispatched?: boolean;
}

export interface RunResult {
  outcome: 'done' | 'retry' | 'failed';
  error?: string;
}

/** Runs one claimed job to done, a later retry, or failed. */
export async function runAiJob(pool: Pool, job: AiJob, opts: QueueOptions, policy: RunPolicy = {}): Promise<RunResult> {
  const log = opts.log ?? (() => undefined);
  const started = Date.now();
  let lastError: unknown;
  let permanent = false;
  try {
    if (job.attempts > job.max_attempts) throw new PermanentError('stopped mid-job too many times');
    const runner = RUNNERS[job.capability];
    if (!runner) throw new PermanentError(`running ${job.capability} jobs is not available yet`);
    for (const t of await targets(pool, job, opts.secret)) {
      const callStarted = Date.now();
      try {
        const out = await runner(t, job.input);
        const ms = Date.now() - callStarted;
        await logCall(pool, t, job, out, ms);
        await pool.query(
          `UPDATE app.ai_jobs SET status = 'done', result = $2, error = NULL, model_id = $3, model = $4, connection_id = $5,
                  cost_usd = cost_usd + $6, ms = $7, finished_at = now(), locked_until = NULL WHERE id = $1`,
          [job.id, out.result, t.model_id, t.model, t.connection_id, out.cost, Date.now() - started],
        );
        log({ event: 'ai_job_done', id: job.id, transport: job.transport, capability: job.capability, model: t.model, ms });
        return { outcome: 'done' };
      } catch (err) {
        await logCall(pool, t, job, undefined, Date.now() - callStarted, err);
        lastError = err;
        // Bad input fails on every model alike: don't try the backup.
        if (err instanceof PermanentError) throw err;
      }
    }
    permanent = lastError instanceof ProviderError && lastError.permanent;
  } catch (err) {
    lastError = err;
    permanent = err instanceof PermanentError;
  }
  const message = (lastError instanceof Error ? lastError.message : String(lastError)).slice(0, 300);
  if (!permanent && job.attempts < job.max_attempts) {
    await pool.query(
      `UPDATE app.ai_jobs SET status = 'queued', error = $2, locked_until = NULL, locked_by = NULL,
              run_after = now() + make_interval(secs => $3::double precision / 1000)${policy.keepDispatched ? '' : ', dispatched_at = NULL'} WHERE id = $1`,
      [job.id, message, (policy.retryDelayMs ?? backoffMs)(job.attempts)],
    );
    log({ event: 'ai_job_retry', id: job.id, transport: job.transport, capability: job.capability, attempt: job.attempts, error: message });
    return { outcome: 'retry', error: message };
  }
  await pool.query(
    `UPDATE app.ai_jobs SET status = 'failed', error = $2, finished_at = now(), locked_until = NULL, ms = $3 WHERE id = $1`,
    [job.id, message, Date.now() - started],
  );
  log({ event: 'ai_job_failed', id: job.id, transport: job.transport, capability: job.capability, error: message });
  return { outcome: 'failed', error: message };
}

/** Postgres queue: runs due jobs until none are left, `concurrency` at a time. Returns how many ran. */
export async function runAiJobs(pool: Pool, opts: QueueOptions): Promise<number> {
  let ran = 0;
  const lane = async () => {
    for (;;) {
      const job = await claimAiJob(pool, opts.workerId, opts.leaseMs);
      if (!job) return;
      ran++;
      await runAiJob(pool, job, opts);
    }
  };
  await Promise.all(Array.from({ length: Math.max(opts.concurrency ?? 2, 1) }, lane));
  return ran;
}

/** Finished jobs are kept 30 days (their input and result may hold customer data). */
export async function pruneAiJobs(pool: Pool, days = 30): Promise<number> {
  return (
    await pool.query(`DELETE FROM app.ai_jobs WHERE status IN ('done', 'failed', 'cancelled') AND finished_at < now() - make_interval(days => $1)`, [days])
  ).rowCount ?? 0;
}
