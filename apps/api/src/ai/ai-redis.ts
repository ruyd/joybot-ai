import { Queue } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';

/**
 * Hands queued AI jobs to Redis (BullMQ or Redis Streams). Only the job's id travels; the row in
 * app.ai_jobs holds the rest. Keep in step with apps/worker/src/ai/redis.ts, which reads them.
 */
export const QUEUE_NAME = 'ai';
export const streamKey = (prefix: string) => `${prefix}:ai:jobs`;

export interface RedisJob {
  id: string;
  transport: string;
  priority: number;
  max_attempts: number;
  attempts?: number;
}

export class AiRedis {
  private readonly redis: Redis;
  private readonly queue: Queue;

  constructor(
    url: string,
    private readonly prefix = 'joybot',
  ) {
    // Fail fast when Redis is down: the job stays queued in Postgres and the worker's sweep hands it over later.
    this.redis = new IORedis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
    this.redis.on('error', () => undefined);
    this.queue = new Queue(QUEUE_NAME, { connection: this.redis, prefix });
  }

  async dispatch(job: RedisJob): Promise<void> {
    if (job.transport === 'bullmq') {
      const old = await this.queue.getJob(job.id);
      if (old && ((await old.isCompleted()) || (await old.isFailed()))) await old.remove();
      await this.queue.add(
        'run',
        { id: job.id },
        {
          jobId: job.id,
          attempts: Math.max(job.max_attempts - (job.attempts ?? 0), 1),
          backoff: { type: 'exponential', delay: 30_000 },
          priority: 11 - job.priority,
          removeOnComplete: true,
          removeOnFail: { age: 7 * 86_400 },
        },
      );
    } else if (job.transport === 'redis_streams') {
      await this.redis.xadd(streamKey(this.prefix), 'MAXLEN', '~', '10000', '*', 'id', job.id);
    }
  }

  async close(): Promise<void> {
    await this.queue.close().catch(() => undefined);
    this.redis.disconnect();
  }
}
