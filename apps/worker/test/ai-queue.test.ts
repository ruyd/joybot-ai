import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { sealSecret } from '@joybot/db';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { backoffMs, claimAiJob, pruneAiJobs, runAiJob, runAiJobs } from '../src/ai/queue';
import { connect, dispatch, startBullWorker, startStreamConsumer, streamKey, sweep, type RedisDelivery } from '../src/ai/redis';

config({ path: path.resolve(__dirname, '../../../.env') });
const worker = new Pool({ connectionString: process.env.WORKER_DATABASE_URL, max: 4 });
const admin = new Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL, max: 2 });
const SECRET = 'test-settings-key';

/** A fake OpenAI-compatible provider: records requests and answers per path. */
const seen: { path: string; auth?: string; body: any }[] = [];
let failWith: number | undefined;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString();
    const body = (req.headers['content-type'] ?? '').includes('json') ? JSON.parse(raw || '{}') : raw;
    seen.push({ path: req.url ?? '', auth: req.headers.authorization, body });
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.url?.startsWith('/audio.mp3')) {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      return res.end(Buffer.from('fake-audio'));
    }
    if (failWith) return send(failWith, { error: 'nope' });
    if (req.url === '/v1/embeddings') return send(200, { data: body.input.map((_: string, i: number) => ({ index: i, embedding: [i, 0.5, 1] })), usage: { prompt_tokens: 7 } });
    if (req.url === '/v1/rerank') return send(200, { results: [{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.9 }], usage: { total_tokens: 12 } });
    if (req.url === '/v1/audio/transcriptions') return send(200, { text: 'hello there', usage: { type: 'duration', seconds: 3.2 } });
    if (req.url === '/v1/chat/completions') {
      const text = JSON.stringify(body.messages[0].content).includes('kill') ? 'unsafe\nS1' : 'safe';
      return send(200, { choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
    }
    send(404, { error: 'unknown' });
  });
});
let base = '';

const ids: Record<string, string> = {};
const opts = { workerId: 'test', secret: SECRET };

async function job(capability: string, input: Record<string, unknown>, extra: { audience?: string; max_attempts?: number; transport?: string } = {}) {
  return (
    await admin.query<{ id: string }>(
      `INSERT INTO app.ai_jobs (capability, input, audience, max_attempts, requested_type, transport) VALUES ($1, $2, $3, $4, 'system', $5) RETURNING id`,
      [capability, input, extra.audience ?? 'admin', extra.max_attempts ?? 3, extra.transport ?? 'postgres'],
    )
  ).rows[0].id;
}
const row = async (id: string) => (await admin.query('SELECT * FROM app.ai_jobs WHERE id = $1', [id])).rows[0];

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const conn = async (name: string, isPrivate: boolean, cap?: number) =>
    (
      await admin.query<{ id: string }>(
        `INSERT INTO core.ai_connections (name, kind, base_url, private, monthly_cap_usd) VALUES ($1, 'openai_compatible', $2, $3, $4) RETURNING id`,
        [name, `${base}/v1`, isPrivate, cap ?? null],
      )
    ).rows[0].id;
  ids.local = await conn('Queue local', true);
  ids.cloud = await conn('Queue cloud', false);
  await admin.query('INSERT INTO core.ai_connection_secrets (connection_id, api_key_cipher) VALUES ($1, $2)', [ids.cloud, sealSecret('sk-cloud-1234', SECRET)]);
  const model = async (connection: string, name: string, capability: string) =>
    (
      await admin.query<{ id: string }>(
        `INSERT INTO core.ai_models (connection_id, model, capability, input_price, output_price) VALUES ($1, $2, $3, 1, 2) RETURNING id`,
        [connection, name, capability],
      )
    ).rows[0].id;
  ids.embedLocal = await model(ids.local, 'embed-local', 'embeddings');
  ids.embedCloud = await model(ids.cloud, 'embed-cloud', 'embeddings');
  ids.rerank = await model(ids.local, 'rerank-local', 'reranker');
  ids.stt = await model(ids.cloud, 'whisper', 'speech_to_text');
  ids.guard = await model(ids.local, 'guard', 'moderation');
  const slot = (capability: string, model: string, backup: string | null = null) =>
    admin.query(`UPDATE core.ai_slots SET model_id = $2, backup_model_id = $3, transport = 'postgres', active = true WHERE capability = $1`, [capability, model, backup]);
  await slot('embeddings', ids.embedLocal, ids.embedCloud);
  await slot('reranker', ids.rerank);
  await slot('speech_to_text', ids.stt);
  await slot('moderation', ids.guard);
});

beforeEach(async () => {
  seen.length = 0;
  failWith = undefined;
  await admin.query('DELETE FROM app.ai_jobs');
  await admin.query('UPDATE core.ai_connections SET active = true WHERE id = ANY($1)', [[ids.local, ids.cloud]]);
});

afterAll(async () => {
  await admin.query('DELETE FROM app.ai_jobs');
  await admin.query(`UPDATE core.ai_slots SET model_id = NULL, backup_model_id = NULL WHERE capability IN ('embeddings', 'reranker', 'speech_to_text', 'moderation')`);
  await admin.query('DELETE FROM core.ai_connections WHERE id = ANY($1)', [[ids.local, ids.cloud]]);
  await worker.end();
  await admin.end();
  server.close();
});

describe('AI queue', () => {
  it('runs embeddings, reranking, moderation and transcription jobs and logs each call', async () => {
    const e = await job('embeddings', { texts: ['a', 'b'] });
    const r = await job('reranker', { query: 'q', documents: ['x', 'y'] });
    const m = await job('moderation', { text: 'how do I kill a process?' });
    const s = await job('speech_to_text', { audio_url: `${base}/audio.mp3` });
    expect(await runAiJobs(worker, opts)).toBe(4);

    const emb = await row(e);
    expect(emb).toMatchObject({ status: 'done', model: 'embed-local', attempts: 1, error: null });
    expect(emb.result).toEqual({ dimensions: 3, vectors: [[0, 0.5, 1], [1, 0.5, 1]] });
    expect(Number(emb.cost_usd)).toBeCloseTo(7 / 1_000_000);
    expect((await row(r)).result.results.map((x: any) => x.index)).toEqual([1, 0]);
    expect((await row(m)).result).toMatchObject({ flagged: true, categories: ['S1'] });
    expect((await row(s)).result).toEqual({ text: 'hello there', seconds: 3.2 });
    // The cloud connection's key was decrypted and sent; the local one has none.
    expect(seen.find((x) => x.path === '/v1/audio/transcriptions')?.auth).toBe('Bearer sk-cloud-1234');
    expect(seen.find((x) => x.path === '/v1/embeddings')?.auth).toBeUndefined();

    const calls = (await admin.query(`SELECT capability, step, ok FROM app.ai_calls WHERE connection_id = ANY($1) ORDER BY id`, [[ids.local, ids.cloud]])).rows;
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.step === 'job' && c.ok)).toBe(true);
  });

  it('falls back to the backup model, and keeps customers off connections that are not private', async () => {
    await admin.query('UPDATE core.ai_connections SET active = false WHERE id = $1', [ids.local]);
    const staff = await job('embeddings', { texts: ['a'] }, { audience: 'employee' });
    const customer = await job('embeddings', { texts: ['a'] }, { audience: 'customer' });
    await runAiJobs(worker, { ...opts, concurrency: 1 });
    expect(await row(staff)).toMatchObject({ status: 'done', model: 'embed-cloud', connection_id: ids.cloud });
    // Only the private (local) connection may take a customer's job, and it is off: try again later.
    expect(await row(customer)).toMatchObject({ status: 'queued', attempts: 1 });
    expect((await row(customer)).error).toMatch(/not private/);
  });

  it('retries server errors with backoff, then fails; bad input fails at once', async () => {
    failWith = 503;
    const id = await job('reranker', { query: 'q', documents: ['x'] }, { max_attempts: 2 });
    expect(await runAiJobs(worker, opts)).toBe(1);
    const first = await row(id);
    expect(first).toMatchObject({ status: 'queued', attempts: 1 });
    expect(first.error).toMatch(/503/);
    expect(new Date(first.run_after).getTime() - Date.now()).toBeGreaterThan(20_000);
    // Not due yet, so nothing runs; once due, the last attempt fails for good.
    expect(await runAiJobs(worker, opts)).toBe(0);
    await admin.query('UPDATE app.ai_jobs SET run_after = now() WHERE id = $1', [id]);
    await runAiJobs(worker, opts);
    expect(await row(id)).toMatchObject({ status: 'failed', attempts: 2 });

    failWith = 400;
    const bad = await job('reranker', { query: 'q', documents: ['x'] });
    await runAiJobs(worker, opts);
    expect(await row(bad)).toMatchObject({ status: 'failed', attempts: 1 });
    const missing = await job('embeddings', {});
    await runAiJobs(worker, opts);
    expect(await row(missing)).toMatchObject({ status: 'failed', error: 'input.text is required' });
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(3)).toBe(480_000);
    expect(backoffMs(20)).toBe(3_600_000);
  });

  it('lets two workers share the queue without running a job twice, and takes over expired leases', async () => {
    for (let i = 0; i < 6; i++) await job('embeddings', { texts: [`t${i}`] });
    const [a, b] = await Promise.all([runAiJobs(worker, { ...opts, workerId: 'a' }), runAiJobs(worker, { ...opts, workerId: 'b' })]);
    expect(a + b).toBe(6);
    expect(seen.filter((x) => x.path === '/v1/embeddings')).toHaveLength(6);

    // A worker claimed a job and died: once its lease runs out, another takes it over.
    const id = await job('embeddings', { texts: ['x'] });
    const claimed = await claimAiJob(worker, 'dead', 60_000);
    expect(claimed?.id).toBe(id);
    expect(await claimAiJob(worker, 'other')).toBeUndefined();
    await admin.query(`UPDATE app.ai_jobs SET locked_until = now() - interval '1 second' WHERE id = $1`, [id]);
    const again = await claimAiJob(worker, 'other');
    expect(again).toMatchObject({ id, attempts: 2 });
    await runAiJob(worker, again!, opts);
    expect(await row(id)).toMatchObject({ status: 'done', locked_by: 'other' });
  });

  it('fails capabilities without a runner, and prunes old finished jobs', async () => {
    await admin.query(`UPDATE core.ai_slots SET transport = 'postgres', active = true WHERE capability = 'avatar'`);
    const id = await job('avatar', { prompt: 'hi' });
    await runAiJobs(worker, opts);
    expect(await row(id)).toMatchObject({ status: 'failed', error: 'running avatar jobs is not available yet' });

    await admin.query(`UPDATE app.ai_jobs SET finished_at = now() - interval '31 days' WHERE id = $1`, [id]);
    expect(await pruneAiJobs(worker)).toBe(1);
    expect(await row(id)).toBeUndefined();
  });
});

describe('Redis deliveries', () => {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6380';
  const prefix = `test-worker-${process.pid}`;
  let d: RedisDelivery;
  /** Waits until the job reaches one of these statuses (the worker runs in the background). */
  const until = async (id: string, statuses: string[], ms = 8_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const r = await row(id);
      if (statuses.includes(r.status) || Date.now() > end) return r;
      await new Promise((res) => setTimeout(res, 50));
    }
  };
  const asJob = async (id: string) => (await admin.query('SELECT id, transport, priority, max_attempts, attempts FROM app.ai_jobs WHERE id = $1', [id])).rows[0];

  beforeAll(() => {
    d = connect(url, prefix);
  });
  afterAll(async () => {
    await d.queue.obliterate({ force: true });
    await d.redis.del(streamKey(prefix));
    await d.queue.close();
    d.redis.disconnect();
  });

  it('BullMQ runs jobs it is handed, once each, and stops at a permanent failure', async () => {
    const bull = startBullWorker(worker, url, prefix, opts);
    try {
      const ok = await job('embeddings', { texts: ['a'] }, { transport: 'bullmq' });
      // Handed over twice (say, the API and the sweep): BullMQ keeps one job per id.
      await dispatch(d, await asJob(ok));
      await dispatch(d, await asJob(ok));
      expect(await until(ok, ['done'])).toMatchObject({ status: 'done', model: 'embed-local', attempts: 1, transport: 'bullmq' });
      expect(seen.filter((x) => x.path === '/v1/embeddings')).toHaveLength(1);

      failWith = 400;
      const bad = await job('reranker', { query: 'q', documents: ['x'] }, { transport: 'bullmq' });
      await dispatch(d, await asJob(bad));
      expect(await until(bad, ['failed'])).toMatchObject({ status: 'failed', attempts: 1 });
      await new Promise((r) => setTimeout(r, 200));
      expect(await (await d.queue.getJob(bad))?.isFailed()).toBe(true);
    } finally {
      await bull.close();
    }
  });

  it('Redis Streams runs jobs from the consumer group, ignores repeats, and the sweep re-sends lost ones', async () => {
    const stop = await startStreamConsumer(worker, d, url, opts);
    try {
      const ok = await job('moderation', { text: 'how do I kill a process?' }, { transport: 'redis_streams' });
      await dispatch(d, await asJob(ok));
      await dispatch(d, await asJob(ok));
      expect(await until(ok, ['done'])).toMatchObject({ status: 'done', transport: 'redis_streams' });
      expect((await row(ok)).result).toMatchObject({ flagged: true });
      await new Promise((r) => setTimeout(r, 300));
      expect(seen.filter((x) => x.path === '/v1/chat/completions')).toHaveLength(1);
      // Every entry is acknowledged.
      expect(((await d.redis.xpending(streamKey(prefix), 'ai-workers')) as [number])[0]).toBe(0);

      // Never handed over (Redis was down when the API tried): the sweep sends it, once.
      const lost = await job('moderation', { text: 'hello' }, { transport: 'redis_streams' });
      expect(await sweep(worker, d)).toBe(1);
      expect(await sweep(worker, d)).toBe(0);
      expect(await until(lost, ['done'])).toMatchObject({ status: 'done' });
    } finally {
      await stop();
    }
  });

  it('the sweep holds no lock while calling Redis, and unmarks jobs Redis refused', async () => {
    const id = await job('embeddings', { texts: ['a'] }, { transport: 'bullmq' });
    const down = { ...d, queue: { getJob: async () => Promise.reject(new Error('Redis is down')) } } as unknown as RedisDelivery;
    await expect(sweep(worker, down)).rejects.toThrow('Redis is down');
    expect((await row(id)).dispatched_at).toBeNull();
    // Redis back: the next sweep sends it.
    expect(await sweep(worker, d)).toBe(1);
    expect((await row(id)).dispatched_at).not.toBeNull();
    expect(await d.queue.getJob(id)).toBeTruthy();
  });

  it('Redis Streams retries through the sweep once the backoff is over', async () => {
    const stop = await startStreamConsumer(worker, d, url, opts);
    try {
      failWith = 503;
      const id = await job('moderation', { text: 'hello' }, { transport: 'redis_streams' });
      await dispatch(d, await asJob(id));
      // The first try fails and waits for its backoff, out of Redis until the sweep sends it again.
      const end = Date.now() + 8_000;
      while ((await row(id)).attempts < 1 || (await row(id)).status !== 'queued') {
        if (Date.now() > end) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(await row(id)).toMatchObject({ status: 'queued', attempts: 1, dispatched_at: null });
      // Not due yet: nothing to send. Due: sent and done.
      expect(await sweep(worker, d)).toBe(0);
      failWith = undefined;
      await admin.query('UPDATE app.ai_jobs SET run_after = now() WHERE id = $1', [id]);
      expect(await sweep(worker, d)).toBe(1);
      expect(await until(id, ['done'])).toMatchObject({ status: 'done', attempts: 2 });
    } finally {
      await stop();
    }
  });
});
