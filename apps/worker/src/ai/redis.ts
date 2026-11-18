import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import type { Pool } from 'pg';
import { claimAiJobById, LEASE_MS, runAiJob, type JobTransport, type QueueOptions } from './queue';

/**
 * The Redis deliveries (migration 0060). Both carry only job ids; the job itself (input, result, status)
 * stays a row in app.ai_jobs, so Redis never holds customer data and the Jobs dialog works the same.
 *
 * - BullMQ: a queue named `ai` with BullMQ's retries (exponential backoff from 30 s) and priorities.
 * - Redis Streams: entries on `<prefix>:ai:jobs`, read by the `ai-workers` consumer group; a message left
 *   pending by a worker that died is claimed by another after the lease (XAUTOCLAIM).
 *
 * The API hands jobs over (keep `dispatch` in step with apps/api/src/ai/ai-redis.ts). The worker's sweep
 * hands over again any job Redis lost or the API couldn't reach, and Streams retries that come due.
 */

export const QUEUE_NAME = 'ai';
export const GROUP = 'ai-workers';
export const streamKey = (prefix: string) => `${prefix}:ai:jobs`;
/** BullMQ's backoff: 30 s, 1 min, 2 min… */
export const bullBackoffMs = (attempt: number) => 30_000 * 2 ** Math.max(attempt - 1, 0);
/** Ours is −10 (last) to 10 (first); BullMQ's is 1 (first) and up. */
export const bullPriority = (priority: number) => 11 - priority;

export interface RedisDelivery {
  queue: Queue;
  redis: Redis;
  prefix: string;
}

export function connect(url: string, prefix = 'joybot'): RedisDelivery {
  const redis = new IORedis(url, { maxRetriesPerRequest: null });
  return { redis, prefix, queue: new Queue(QUEUE_NAME, { connection: redis, prefix }) };
}

export interface DispatchJob {
  id: string;
  transport: JobTransport;
  priority: number;
  max_attempts: number;
  attempts?: number;
}

/** Hands a job's id to its Redis delivery. Safe to repeat: BullMQ keys jobs by id, and claims ignore extra stream entries. */
export async function dispatch(d: RedisDelivery, job: DispatchJob): Promise<void> {
  if (job.transport === 'bullmq') {
    // A finished BullMQ job with this id (an admin's retry) would block the new one.
    const old = await d.queue.getJob(job.id);
    if (old && ((await old.isCompleted()) || (await old.isFailed()))) await old.remove();
    await d.queue.add(
      'run',
      { id: job.id },
      {
        jobId: job.id,
        attempts: Math.max(job.max_attempts - (job.attempts ?? 0), 1),
        backoff: { type: 'exponential', delay: 30_000 },
        priority: bullPriority(job.priority),
        removeOnComplete: true,
        removeOnFail: { age: 7 * 86_400 },
      },
    );
  } else if (job.transport === 'redis_streams') {
    await d.redis.xadd(streamKey(d.prefix), 'MAXLEN', '~', '10000', '*', 'id', job.id);
  }
}

/** Hands over Redis jobs that are due but not with Redis: never handed over, lost, retries come due, or leases run out. */
export async function sweep(pool: Pool, d: RedisDelivery, leaseMs = LEASE_MS): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = (
      await client.query<DispatchJob>(
        `SELECT id, transport, priority, max_attempts, attempts FROM app.ai_jobs
          WHERE transport <> 'postgres'
            AND ((status = 'queued' AND run_after <= now()
                  AND (dispatched_at IS NULL OR dispatched_at < now() - make_interval(secs => $1::double precision / 1000)))
                 OR (status = 'running' AND locked_until < now()))
          ORDER BY priority DESC, run_after LIMIT 100 FOR UPDATE SKIP LOCKED`,
        [leaseMs],
      )
    ).rows;
    for (const job of due) {
      await dispatch(d, job);
      await client.query('UPDATE app.ai_jobs SET dispatched_at = now() WHERE id = $1', [job.id]);
    }
    await client.query('COMMIT');
    return due.length;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** BullMQ: runs jobs as they arrive; a retryable failure throws so BullMQ tries again after its backoff. */
export function startBullWorker(pool: Pool, url: string, prefix: string, opts: QueueOptions): Worker {
  const worker = new Worker<{ id: string }>(
    QUEUE_NAME,
    async (job: Job<{ id: string }>) => {
      const row = await claimAiJobById(pool, job.data.id, 'bullmq', opts.workerId, opts.leaseMs);
      if (!row) return { skipped: true };
      const run = await runAiJob(pool, row, opts, { retryDelayMs: bullBackoffMs, keepDispatched: true });
      if (run.outcome === 'retry') throw new Error(run.error);
      if (run.outcome === 'failed') throw new UnrecoverableError(run.error);
      return { done: true };
    },
    { connection: new IORedis(url, { maxRetriesPerRequest: null }), prefix, concurrency: opts.concurrency ?? 2 },
  );
  worker.on('error', (err) => opts.log?.({ event: 'ai_bullmq_error', error: err.message }));
  return worker;
}

type Entry = [id: string, fields: string[]];

/** Redis Streams: a consumer in the `ai-workers` group. Returns a function that stops it. */
export async function startStreamConsumer(pool: Pool, d: RedisDelivery, url: string, opts: QueueOptions): Promise<() => Promise<void>> {
  const key = streamKey(d.prefix);
  const lease = opts.leaseMs ?? LEASE_MS;
  try {
    await d.redis.xgroup('CREATE', key, GROUP, '0', 'MKSTREAM');
  } catch (err) {
    if (!String((err as Error).message).includes('BUSYGROUP')) throw err;
  }
  // XREADGROUP BLOCK holds its connection, so it gets its own.
  const reader = new IORedis(url, { maxRetriesPerRequest: null });
  let stopping = false;

  const handle = async ([entryId, fields]: Entry) => {
    const id = fields[fields.indexOf('id') + 1];
    try {
      const row = id ? await claimAiJobById(pool, id, 'redis_streams', opts.workerId, lease) : undefined;
      // A retry clears dispatched_at, and the sweep adds a new entry when it comes due.
      if (row) await runAiJob(pool, row, opts);
    } finally {
      await d.redis.xack(key, GROUP, entryId);
    }
  };

  const loop = (async () => {
    while (!stopping) {
      try {
        // Entries a dead consumer left pending past the lease, then new ones.
        const claimed = ((await d.redis.xautoclaim(key, GROUP, opts.workerId, lease, '0-0', 'COUNT', 10)) as [string, Entry[]])[1] ?? [];
        const read = (await reader.xreadgroup('GROUP', GROUP, opts.workerId, 'COUNT', opts.concurrency ?? 2, 'BLOCK', 2000, 'STREAMS', key, '>')) as
          | [string, Entry[]][]
          | null;
        const entries = [...claimed.filter((e) => e && e[1]), ...(read?.[0]?.[1] ?? [])];
        await Promise.all(entries.map((e) => handle(e).catch((err) => opts.log?.({ event: 'ai_stream_error', error: (err as Error).message }))));
      } catch (err) {
        if (stopping) break;
        opts.log?.({ event: 'ai_stream_error', error: (err as Error).message });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();

  return async () => {
    stopping = true;
    await loop;
    reader.disconnect();
  };
}
