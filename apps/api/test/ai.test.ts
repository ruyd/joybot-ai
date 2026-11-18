import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, createApp, customer, employee } from './app';

const { customers: C, users: U } = SAMPLE;

const KEY = 'sk-or-v1-test-key-abcd';

/** A fake OpenAI-compatible model server: records requests, answers "ready", streams one sentence or speaks. */
class FakeModel {
  requests: { path: string; auth?: string; body: any }[] = [];
  status = 200;
  server!: Server;
  url = '';

  async start() {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        this.requests.push({ path: req.url ?? '', auth: req.headers.authorization, body });
        const usage = { prompt_tokens: 1000, completion_tokens: 500 };
        if (this.status !== 200) {
          res.writeHead(this.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'No endpoints found matching your data policy' } }));
        } else if (req.url?.endsWith('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: 'google/gemma-4-26b-a4b-it' }, { id: 'gemma4:e2b' }] }));
        } else if (req.url?.endsWith('/audio/speech')) {
          res.writeHead(200, { 'content-type': 'audio/pcm' });
          res.end(Buffer.alloc(4410)); // 50 ms of silence
        } else if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello from the configured model.' } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
          res.end('data: [DONE]\n\n');
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: 'ready', tool_calls: [] } }], usage }));
        }
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }
}

const model = new FakeModel();
const backup = new FakeModel();
let app: INestApplication;
beforeAll(async () => {
  await model.start();
  await backup.start();
  app = await createApp();
});
afterAll(async () => {
  await app.close();
  model.server.close();
  backup.server.close();
});

const admin = () => api(app, employee(U.ada));

/** Back to nothing configured: no connections, every slot on and empty. */
beforeEach(async () => {
  for (const m of [model, backup]) {
    m.requests = [];
    m.status = 200;
  }
  const { connections } = (await admin().get('/api/admin/ai').expect(200)).body;
  for (const c of connections) await admin().delete(`/api/admin/ai/connections/${c.id}`).expect(204);
  await admin().put('/api/admin/ai/slots/general', { active: true }).expect(200);
});

async function asOwner<T>(sql: string): Promise<T[]> {
  config({ path: path.resolve(__dirname, '../../../.env') });
  const db = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await db.connect();
  try {
    return (await db.query(sql)).rows as T[];
  } finally {
    await db.end();
  }
}

/** Sends a chat message and returns the streamed answer text. */
async function ask(who: { type: 'employee' | 'customer'; id: string }, question: string): Promise<string> {
  const conversation = (await api(app, who).post('/api/conversations', {}).expect(201)).body.id;
  const res = await request(app.getHttpServer())
    .post(`/api/conversations/${conversation}/messages`)
    .set('x-dev-principal', `${who.type}:${who.id}`)
    .send({ content: question })
    .buffer(true)
    .parse((r, cb) => {
      let data = '';
      r.on('data', (c: Buffer) => (data += c.toString()));
      r.on('end', () => cb(null, data));
    })
    .expect(200);
  const blocks = String(res.body).split('\n\n');
  const text = (b: string) => JSON.parse(b.split('\n')[1].slice(6)).text as string;
  // A replaced answer (the record list) wins over the streamed text.
  const replaced = blocks.filter((b) => b.startsWith('event: replace')).map(text).pop();
  return replaced ?? blocks.filter((b) => b.startsWith('event: token')).map(text).join('');
}

/** A connection to a fake server with one General model in the General slot. */
async function general(opts: { private?: boolean; cap?: number | null; server?: FakeModel; name?: string } = {}) {
  const connection = (
    await admin()
      .post('/api/admin/ai/connections', {
        name: opts.name ?? 'Own deployment',
        kind: 'openai_compatible',
        base_url: (opts.server ?? model).url,
        private: opts.private ?? true,
        monthly_cap_usd: opts.cap ?? null,
      })
      .expect(201)
  ).body;
  const m = (
    await admin()
      .post('/api/admin/ai/models', { connection_id: connection.id, model: 'google/gemma-4-26b-a4b-it', capability: 'general', tags: ['MoE'], input_price: 1, output_price: 2 })
      .expect(201)
  ).body;
  await admin().put('/api/admin/ai/slots/general', { model_id: m.id, backup_model_id: null }).expect(200);
  return { connection, model: m };
}

describe('AI settings', () => {
  it('are for admins; staff and customers cannot see or change them', async () => {
    const overview = (await admin().get('/api/admin/ai').expect(200)).body;
    expect(overview).toMatchObject({ connections: [], server_default: null, encryption_available: true, available_transports: ['direct', 'postgres'] });
    expect(overview.slots).toHaveLength(12);
    expect(overview.slots[0]).toMatchObject({ capability: 'general', model_id: null, transport: 'direct', active: true });
    await api(app, employee(U.sam)).get('/api/admin/ai').expect(403);
    await api(app, employee(U.sam)).post('/api/admin/ai/connections', { name: 'x', kind: 'openrouter' }).expect(403);
    await api(app, customer(C.maria)).put('/api/admin/ai/slots/general', { active: false }).expect(403);
    await api(app, customer(C.maria)).get('/api/admin/ai/calls').expect(403);
    const [counted] = await asOwner<{ n: string }>('SELECT count(*) AS n FROM core.ai_slots WHERE active');
    expect(Number(counted.n)).toBe(12);
  });

  it('check connections, models and slots', async () => {
    await admin().post('/api/admin/ai/connections', { name: 'Box', kind: 'openai_compatible' }).expect(400); // needs a base URL
    await admin().post('/api/admin/ai/connections', { name: 'Box', kind: 'other', base_url: model.url }).expect(400);
    await admin().post('/api/admin/ai/connections', { name: 'Box', kind: 'ollama', base_url: 'ftp://x' }).expect(400);
    const { model: m } = await general();
    await admin().post('/api/admin/ai/connections', { name: 'own deployment', kind: 'openrouter' }).expect(409); // names are unique
    await admin().put('/api/admin/ai/slots/general', { transport: 'redis' }).expect(400); // not available yet
    await admin().put('/api/admin/ai/slots/general', { transport: 'postgres' }).expect(400); // answers stream
    await admin().put('/api/admin/ai/slots/text_to_speech', { model_id: m.id }).expect(400); // a General model can't speak
    await admin().put('/api/admin/ai/slots/video_generation', { transport: 'postgres' }).expect(200);
    await admin().put('/api/admin/ai/slots/unknown', { active: false }).expect(400);
  });

  it('keep API keys encrypted, show only their last four characters and keep them out of the audit log', async () => {
    const connection = (await admin().post('/api/admin/ai/connections', { name: 'OpenRouter', kind: 'openrouter', private: true }).expect(201)).body;
    const saved = (await admin().put(`/api/admin/ai/connections/${connection.id}/api-key`, { api_key: KEY }).expect(200)).body;
    expect(saved).toMatchObject({ api_key_last4: 'abcd', api_key_set_at: expect.any(String) });
    expect(JSON.stringify(saved)).not.toContain(KEY);
    expect(JSON.stringify((await admin().get('/api/admin/ai').expect(200)).body)).not.toContain(KEY);
    const [secret] = await asOwner<{ api_key_cipher: string }>(`SELECT api_key_cipher FROM core.ai_connection_secrets WHERE connection_id = '${connection.id}'`);
    expect(secret.api_key_cipher).toMatch(/^v1\./);
    const log = await asOwner<{ diff: unknown }>(`SELECT diff FROM core.change_log WHERE table_name IN ('ai_connections', 'ai_connection_secrets')`);
    expect(log.length).toBeGreaterThan(0);
    expect(JSON.stringify(log)).not.toContain(KEY);
    expect(JSON.stringify(log)).not.toContain(secret.api_key_cipher);
    await api(app, employee(U.sam)).put(`/api/admin/ai/connections/${connection.id}/api-key`, { api_key: KEY }).expect(403);
    expect((await admin().delete(`/api/admin/ai/connections/${connection.id}/api-key`).expect(200)).body.api_key_last4).toBeNull();
  });
});

describe('the General slot', () => {
  it('answers the test prompt and chat, and logs each call with its tokens and cost', async () => {
    const { model: m } = await general();
    expect((await admin().post(`/api/admin/ai/models/${m.id}/test`).expect(200)).body).toMatchObject({ reply: 'ready', model: 'google/gemma-4-26b-a4b-it' });
    expect((await api(app, customer(C.maria)).get('/api/me').expect(200)).body.assistant_mode).toBe('chat');
    expect((await api(app, employee(U.sam)).get('/api/me').expect(200)).body.assistant_mode).toBe('chat');
    expect(await ask(customer(C.maria), 'What are your opening hours?')).toContain('Hello from the configured model.');
    expect(model.requests.some((r) => r.path === '/v1/chat/completions' && r.body.stream === true && r.body.stream_options?.include_usage)).toBe(true);

    const calls = (await admin().get('/api/admin/ai/calls').expect(200)).body;
    const answer = calls.find((c: { step: string }) => c.step === 'answer');
    // 1,000 tokens in at $1 and 500 out at $2 per million.
    expect(answer).toMatchObject({ capability: 'general', audience: 'customer', input_units: 1000, output_units: 500, cost_usd: '0.002000', ok: true, connection_name: 'Own deployment' });
    expect(calls.find((c: { step: string }) => c.step === 'test')).toMatchObject({ audience: 'admin', ok: true });
    expect(JSON.stringify(calls)).not.toContain('opening hours'); // no prompt text

    // This month, per capability and per connection.
    const overview = (await admin().get('/api/admin/ai').expect(200)).body;
    expect(overview.usage.find((u: { capability: string }) => u.capability === 'general')).toMatchObject({ calls: expect.any(Number), spent_usd: expect.any(String) });
    expect(overview.connections[0].calls).toBeGreaterThan(0);

    // The connection test lists the provider's models and sends no prompt.
    const before = model.requests.length;
    expect((await admin().post(`/api/admin/ai/connections/${overview.connections[0].id}/test`).expect(200)).body).toMatchObject({ ok: true, models: 2 });
    expect(model.requests.slice(before).map((r) => r.path)).toEqual(['/v1/models']);
    await api(app, employee(U.sam)).post(`/api/admin/ai/connections/${overview.connections[0].id}/test`).expect(403);

    model.status = 404;
    expect((await admin().post(`/api/admin/ai/models/${m.id}/test`).expect(502)).body.message).toMatch(/refused the request \(404\): No endpoints found/);
  });

  it('never sends customers\' questions to a connection that is not private; staff may use it', async () => {
    await general({ private: false });
    expect((await api(app, customer(C.maria)).get('/api/me').expect(200)).body.assistant_mode).toBe('search');
    expect(await ask(customer(C.maria), 'When is my next appointment?')).not.toContain('Hello from the configured model.');
    expect(model.requests.length).toBe(0);

    expect((await api(app, employee(U.sam)).get('/api/me').expect(200)).body.assistant_mode).toBe('chat');
    expect(await ask(employee(U.sam), 'What are your opening hours?')).toContain('Hello from the configured model.');
    expect(model.requests.length).toBeGreaterThan(0);
  });

  it('uses the backup when the active model fails, and search when both do', async () => {
    const { model: primary } = await general({ name: 'Primary' });
    const { model: second } = await general({ name: 'Backup', server: backup });
    await admin().put('/api/admin/ai/slots/general', { model_id: primary.id, backup_model_id: second.id }).expect(200);
    model.status = 503;
    expect(await ask(customer(C.maria), 'What are your opening hours?')).toContain('Hello from the configured model.');
    expect(backup.requests.some((r) => r.body.stream === true)).toBe(true);
    const failed = (await admin().get('/api/admin/ai/calls').expect(200)).body.find((c: { ok: boolean }) => !c.ok);
    expect(failed).toMatchObject({ connection_name: 'Primary', capability: 'general' });

    backup.status = 503;
    expect(await ask(customer(C.maria), 'When is my next appointment?')).toMatch(/Here is what I found:\n- Code review/);
  });

  it('stops using a connection at its monthly cap', async () => {
    const { connection } = await general({ cap: 0 });
    expect((await api(app, customer(C.maria)).get('/api/me').expect(200)).body.assistant_mode).toBe('search');
    await ask(customer(C.maria), 'What are your opening hours?');
    expect(model.requests.length).toBe(0);
    const overview = (await admin().get('/api/admin/ai').expect(200)).body;
    expect(overview.connections.find((c: { id: string }) => c.id === connection.id)).toMatchObject({ monthly_cap_usd: '0.00', spent_usd: '0' });
    await admin().put(`/api/admin/ai/connections/${connection.id}`, { monthly_cap_usd: 10 }).expect(200);
    expect((await api(app, customer(C.maria)).get('/api/me').expect(200)).body.assistant_mode).toBe('chat');
  });

  it('off means search only: nothing is sent to a model, even with one chosen', async () => {
    await general();
    await admin().put('/api/admin/ai/slots/general', { active: false }).expect(200);
    expect((await api(app, customer(C.maria)).get('/api/me').expect(200)).body.assistant_mode).toBe('search');
    expect(await ask(customer(C.maria), 'When is my next appointment?')).not.toContain('Hello from the configured model.');
    expect(model.requests.length).toBe(0);
  });

  it('empty means the server default (here: answers that list records)', async () => {
    expect((await api(app, customer(C.maria)).get('/api/me').expect(200)).body.assistant_mode).toBe('search');
    expect((await api(app, employee(U.sam)).get('/api/me').expect(200)).body.assistant_mode).toBe('search');
    await ask(customer(C.maria), 'What are your opening hours?');
    expect(model.requests.length).toBe(0);
  });
});

describe('the text-to-speech slot', () => {
  it('speaks a test sentence as WAV audio through the connection', async () => {
    const connection = (await admin().post('/api/admin/ai/connections', { name: 'Voice', kind: 'openai_compatible', base_url: model.url, private: false }).expect(201)).body;
    const voice = (
      await admin()
        .post('/api/admin/ai/models', { connection_id: connection.id, model: 'heygen/heygen-voice-1-turbo:free', capability: 'text_to_speech', options: { voice: 'nadine' }, input_price: 0 })
        .expect(201)
    ).body;
    await admin().put('/api/admin/ai/slots/text_to_speech', { model_id: voice.id }).expect(200);
    const spoken = (await admin().post(`/api/admin/ai/models/${voice.id}/test`).expect(200)).body;
    expect(spoken).toMatchObject({ capability: 'text_to_speech', mime: 'audio/wav' });
    expect(Buffer.from(spoken.audio, 'base64').subarray(0, 4).toString()).toBe('RIFF');
    expect(model.requests.find((r) => r.path === '/v1/audio/speech')?.body).toMatchObject({ model: 'heygen/heygen-voice-1-turbo:free', voice: 'nadine' });
  });
});

describe('turning the assistant off', () => {
  afterAll(async () => {
    await admin().put('/api/admin/settings', { assistant_customers: true, assistant_employees: true }).expect(200);
  });

  it('per audience: /me says so and new conversations and questions are refused', async () => {
    const conversation = (await api(app, customer(C.maria)).post('/api/conversations', {}).expect(201)).body.id;
    expect((await api(app, customer(C.maria)).get('/api/me').expect(200)).body.assistant).toBe(true);

    await admin().put('/api/admin/settings', { assistant_customers: false }).expect(200);
    expect((await api(app, customer(C.maria)).get('/api/me').expect(200)).body.assistant).toBe(false);
    expect((await api(app, customer(C.maria)).post('/api/conversations', {}).expect(403)).body.code).toBe('assistant_off');
    await api(app, customer(C.maria)).post(`/api/conversations/${conversation}/messages`, { content: 'Hi' }).expect(403);

    // Staff keep theirs.
    expect((await api(app, employee(U.sam)).get('/api/me').expect(200)).body.assistant).toBe(true);
    await api(app, employee(U.sam)).post('/api/conversations', {}).expect(201);
    expect((await api(app, employee(U.sam)).get('/api/settings').expect(200)).body).toMatchObject({ assistant_customers: false, assistant_employees: true });

    // Only those who may change settings can turn it off.
    await api(app, employee(U.sam)).put('/api/admin/settings', { assistant_employees: false }).expect(403);
  });
});

describe('the Postgres queue', () => {
  afterAll(async () => {
    await asOwner(`DELETE FROM app.ai_jobs`);
    await admin().put('/api/admin/ai/slots/embeddings', { transport: 'direct', active: true }).expect(200);
  });

  it('queues jobs for capabilities delivered through it; admins list, inspect, cancel and retry them', async () => {
    const connection = (
      await admin().post('/api/admin/ai/connections', { name: 'Queue deployment', kind: 'openai_compatible', base_url: model.url, private: true }).expect(201)
    ).body;
    const m = (await admin().post('/api/admin/ai/models', { connection_id: connection.id, model: 'embeddinggemma:300m', capability: 'embeddings' }).expect(201)).body;
    await admin().put('/api/admin/ai/slots/embeddings', { model_id: m.id, transport: 'direct' }).expect(200);

    // Direct capabilities aren't queued; neither are General or bad input.
    const job = { capability: 'embeddings', input: { texts: ['Opening hours'] } };
    expect((await admin().post('/api/admin/ai/jobs', job).expect(400)).body.message).toMatch(/choose a queue/);
    // Without Redis, only Direct and the Postgres queue are offered.
    expect((await admin().get('/api/admin/ai').expect(200)).body.available_transports).toEqual(['direct', 'postgres']);
    expect((await admin().put('/api/admin/ai/slots/embeddings', { transport: 'bullmq' }).expect(400)).body.message).toMatch(/needs Redis/);
    await admin().put('/api/admin/ai/slots/embeddings', { transport: 'postgres' }).expect(200);
    await admin().post('/api/admin/ai/jobs', { capability: 'general', input: {} }).expect(400);
    await admin().post('/api/admin/ai/jobs', { capability: 'embeddings', input: { texts: [] } }).expect(400);
    await admin().post('/api/admin/ai/jobs', { capability: 'speech_to_text', input: { audio_url: 'http://169.254.169.254/x' } }).expect(400);
    await api(app, employee(U.sam)).post('/api/admin/ai/jobs', job).expect(403);
    await api(app, customer(C.maria)).get('/api/admin/ai/jobs').expect(403);

    const queued = (await admin().post('/api/admin/ai/jobs', job).expect(201)).body;
    expect(queued).toMatchObject({ capability: 'embeddings', status: 'queued', audience: 'admin', attempts: 0 });
    const overview = (await admin().get('/api/admin/ai').expect(200)).body;
    expect(overview.queue).toContainEqual({ capability: 'embeddings', queued: 1, running: 0, failed: 0 });
    expect(overview.queue_capabilities).toContain('document_parsing');

    const list = (await admin().get('/api/admin/ai/jobs?status=queued').expect(200)).body;
    expect(list.map((j: any) => j.id)).toContain(queued.id);
    expect(list[0].input).toBeUndefined();
    expect((await admin().get(`/api/admin/ai/jobs/${queued.id}`).expect(200)).body.input).toEqual(job.input);

    expect((await admin().post(`/api/admin/ai/jobs/${queued.id}/cancel`).expect(200)).body.status).toBe('cancelled');
    await admin().post(`/api/admin/ai/jobs/${queued.id}/cancel`).expect(404);
    expect((await admin().post(`/api/admin/ai/jobs/${queued.id}/retry`).expect(200)).body.status).toBe('queued');

    // An off slot takes no new jobs.
    await admin().put('/api/admin/ai/slots/embeddings', { active: false }).expect(200);
    await admin().post('/api/admin/ai/jobs', job).expect(400);
  });
});

describe('the Redis deliveries', () => {
  const prefix = `test-api-${process.pid}`;
  let redisApp: INestApplication;
  let redis: import('ioredis').Redis;
  let queue: import('bullmq').Queue;
  const radmin = () => api(redisApp, employee(U.ada));

  beforeAll(async () => {
    config({ path: path.resolve(__dirname, '../../../.env') });
    redisApp = await createApp({ env: { REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6380', REDIS_PREFIX: prefix } });
    const { default: IORedis } = await import('ioredis');
    const { Queue } = await import('bullmq');
    redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6380', { maxRetriesPerRequest: null });
    queue = new Queue('ai', { connection: redis, prefix });
  });
  afterAll(async () => {
    await queue.obliterate({ force: true });
    await redis.del(`${prefix}:ai:jobs`);
    await queue.close();
    redis.disconnect();
    await asOwner(`DELETE FROM app.ai_jobs`);
    await radmin().put('/api/admin/ai/slots/embeddings', { transport: 'direct', active: true }).expect(200);
    await radmin().put('/api/admin/ai/slots/moderation', { transport: 'direct', active: true }).expect(200);
    await redisApp.close();
  });

  it('hand job ids to BullMQ or a Redis Stream; the job itself stays in Postgres', async () => {
    expect((await radmin().get('/api/admin/ai').expect(200)).body.available_transports).toEqual(['direct', 'postgres', 'bullmq', 'redis_streams']);
    const connection = (await radmin().post('/api/admin/ai/connections', { name: 'Redis deployment', kind: 'openai_compatible', base_url: model.url, private: true }).expect(201)).body;
    const embed = (await radmin().post('/api/admin/ai/models', { connection_id: connection.id, model: 'embed', capability: 'embeddings' }).expect(201)).body;
    const guard = (await radmin().post('/api/admin/ai/models', { connection_id: connection.id, model: 'guard', capability: 'moderation' }).expect(201)).body;
    await radmin().put('/api/admin/ai/slots/embeddings', { model_id: embed.id, transport: 'bullmq', active: true }).expect(200);
    await radmin().put('/api/admin/ai/slots/moderation', { model_id: guard.id, transport: 'redis_streams', active: true }).expect(200);
    // Still direct only: General, text to speech, realtime voice.
    await radmin().put('/api/admin/ai/slots/general', { transport: 'redis_streams' }).expect(400);

    const bull = (await radmin().post('/api/admin/ai/jobs', { capability: 'embeddings', input: { texts: ['a'] }, priority: 5 }).expect(201)).body;
    expect(bull).toMatchObject({ transport: 'bullmq', status: 'queued' });
    const queued = await queue.getJob(bull.id);
    expect(queued?.data).toEqual({ id: bull.id });
    expect(queued?.opts).toMatchObject({ attempts: 3, priority: 6, backoff: { type: 'exponential', delay: 30_000 } });

    const streamed = (await radmin().post('/api/admin/ai/jobs', { capability: 'moderation', input: { text: 'hi' } }).expect(201)).body;
    expect(streamed.transport).toBe('redis_streams');
    const entries = await redis.xrange(`${prefix}:ai:jobs`, '-', '+');
    expect(entries.map(([, fields]) => fields)).toContainEqual(['id', streamed.id]);

    // Both are marked as handed over, so the worker's sweep leaves them alone; Redis holds no input.
    const rows = await asOwner<{ id: string; dispatched_at: Date | null }>(`SELECT id, dispatched_at FROM app.ai_jobs WHERE transport <> 'postgres'`);
    expect(rows.every((r) => r.dispatched_at)).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('hi');
  });
});
