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

/** A fake OpenAI-compatible model server: records requests, answers "ready" or streams one sentence. */
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
        if (this.status !== 200) {
          res.writeHead(this.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'No endpoints found matching your data policy' } }));
        } else if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello from the configured model.' } }] })}\n\n`);
          res.end('data: [DONE]\n\n');
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: 'ready', tool_calls: [] } }] }));
        }
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }
}

const model = new FakeModel();
let app: INestApplication;
beforeAll(async () => {
  await model.start();
  app = await createApp();
});
afterAll(async () => {
  await app.close();
  model.server.close();
});
beforeEach(() => {
  model.requests = [];
  model.status = 200;
});

const admin = () => api(app, employee(U.ada));

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
  return String(res.body)
    .split('\n\n')
    .filter((b) => b.startsWith('event: token'))
    .map((b) => JSON.parse(b.split('\n')[1].slice(6)).text)
    .join('');
}

describe('AI settings', () => {
  it('are for admins; staff and customers cannot see or change them', async () => {
    expect((await admin().get('/api/admin/ai').expect(200)).body).toMatchObject({
      provider: null,
      model: null,
      private_only: true,
      api_key_last4: null,
      server_default: null,
      encryption_available: true,
    });
    await api(app, employee(U.sam)).get('/api/admin/ai').expect(403);
    await api(app, employee(U.sam)).put('/api/admin/ai/api-key', { api_key: KEY }).expect(403);
    await api(app, customer(C.maria)).put('/api/admin/ai', { provider: 'openrouter' }).expect(403);
    await api(app, customer(C.maria)).post('/api/admin/ai/test').expect(403);
  });

  it('need a model for a provider and a base URL for an own deployment', async () => {
    await admin().put('/api/admin/ai', { provider: 'openrouter' }).expect(400);
    await admin().put('/api/admin/ai', { provider: 'custom', model: 'gemma' }).expect(400);
    await admin().put('/api/admin/ai', { provider: 'custom', model: 'gemma', base_url: 'ftp://x' }).expect(400);
    await admin().put('/api/admin/ai', { provider: 'other' }).expect(400);
    await admin().post('/api/admin/ai/test').expect(400); // nothing saved and no server default
  });

  it('keeps the API key encrypted, shows only its last four characters and keeps it out of the audit log', async () => {
    const saved = (await admin().put('/api/admin/ai/api-key', { api_key: KEY }).expect(200)).body;
    expect(saved).toMatchObject({ api_key_last4: 'abcd', api_key_set_at: expect.any(String) });
    expect(JSON.stringify(saved)).not.toContain(KEY);
    const [secret] = await asOwner<{ api_key_cipher: string }>('SELECT api_key_cipher FROM core.ai_secret');
    expect(secret.api_key_cipher).toMatch(/^v1\./);
    const log = await asOwner<{ diff: unknown }>(`SELECT diff FROM core.change_log WHERE table_name IN ('ai_settings', 'ai_secret')`);
    expect(log.length).toBeGreaterThan(0);
    expect(JSON.stringify(log)).not.toContain(KEY);
    expect(JSON.stringify(log)).not.toContain(secret.api_key_cipher);
  });
});

describe('the configured model', () => {
  it('answers the test prompt and chat with the saved key; provider errors are explained', async () => {
    await admin().put('/api/admin/ai', { provider: 'custom', model: 'google/gemma-4-26b-a4b-it', base_url: model.url }).expect(200);
    const test = (await admin().post('/api/admin/ai/test').expect(200)).body;
    expect(test).toMatchObject({ reply: 'ready', model: 'google/gemma-4-26b-a4b-it', ms: expect.any(Number) });
    expect(model.requests[0]).toMatchObject({ path: '/v1/chat/completions', auth: `Bearer ${KEY}`, body: { model: 'google/gemma-4-26b-a4b-it' } });

    expect(await ask(customer(C.maria), 'What are your opening hours?')).toContain('Hello from the configured model.');
    expect(model.requests.some((r) => r.body.stream === true && r.auth === `Bearer ${KEY}`)).toBe(true);

    model.status = 404;
    const refused = await admin().post('/api/admin/ai/test').expect(502);
    expect(refused.body.message).toMatch(/refused the request \(404\): No endpoints found/);
  });

  it('goes back to the server default (here: answers that list records) when the provider is cleared', async () => {
    await admin().put('/api/admin/ai', { provider: null }).expect(200);
    // The cache is cleared on save, so the next question no longer reaches the model server.
    const before = model.requests.length;
    await ask(customer(C.maria), 'What are your opening hours?');
    expect(model.requests.length).toBe(before);
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
