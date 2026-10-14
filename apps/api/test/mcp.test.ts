import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import path from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createApp, customer, employee } from './app';

const { customers: C, users: U } = SAMPLE;

let app: INestApplication;
let migrator: Client;
let seq = 0;

beforeAll(async () => {
  app = await createApp({ env: { MCP_RATE_LIMIT_PER_MINUTE: '40' } });
  config({ path: path.resolve(__dirname, '../../../.env') });
  migrator = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await migrator.connect();
});
afterAll(async () => {
  // Shared database: no tokens or role changes left behind.
  await migrator.query('DELETE FROM app.api_tokens');
  await migrator.query(`UPDATE core.users SET role = 'staff' WHERE id = $1`, [U.sam]);
  await migrator.end();
  await app.close();
});

const newToken = async (name = 'Claude Code') => (await api(app, employee(U.ada)).post('/api/admin/api-tokens', { name }).expect(201)).body as { id: string; token: string; prefix: string };

/** One JSON-RPC call to the MCP endpoint, as an MCP client sends it (stateless, JSON responses). */
const rpc = (token: string | null, method: string, params: Record<string, unknown> = {}) => {
  const req = request(app.getHttpServer())
    .post('/api/mcp')
    .set('accept', 'application/json, text/event-stream')
    .set('content-type', 'application/json')
    .set('mcp-protocol-version', '2025-06-18')
    .send({ jsonrpc: '2.0', id: ++seq, method, params });
  return token ? req.set('authorization', `Bearer ${token}`) : req;
};
const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const res = (await rpc(token, 'tools/call', { name, arguments: args }).expect(200)).body.result;
  return { isError: Boolean(res.isError), data: res.isError ? res.content[0].text : JSON.parse(res.content[0].text) };
};

describe('access tokens', () => {
  it('admins create tokens (shown once) and see them all; staff and customers cannot', async () => {
    const created = await newToken('Laptop');
    expect(created.token).toMatch(/^jbt_[A-Za-z0-9_-]{40,}$/);
    expect(created.prefix).toBe(created.token.slice(0, 12));
    const list = (await api(app, employee(U.ada)).get('/api/admin/api-tokens').expect(200)).body;
    const mine = list.find((t: { id: string }) => t.id === created.id);
    expect(mine).toMatchObject({ name: 'Laptop', scope: 'read', mine: true, active: true, owner_name: 'Ada Admin' });
    expect(JSON.stringify(list)).not.toContain(created.token); // never shown again
    expect(Object.keys(mine)).not.toContain('token_hash');

    await api(app, employee(U.sam)).get('/api/admin/api-tokens').expect(403);
    await api(app, employee(U.sam)).post('/api/admin/api-tokens', { name: 'x' }).expect(403);
    await api(app, customer(C.maria)).post('/api/admin/api-tokens', { name: 'x' }).expect(403);
    await api(app, employee(U.sam)).delete(`/api/admin/api-tokens/${created.id}`).expect(403);
    await api(app, customer(C.maria)).delete(`/api/admin/api-tokens/${created.id}`).expect(403);
    await api(app, employee(U.ada)).post('/api/admin/api-tokens', { name: 'x', expires_in_days: 400 }).expect(400);
  });
});

describe('MCP endpoint', () => {
  it('speaks MCP: initialize and list read-only tools', async () => {
    const { token } = await newToken();
    const init = (await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }).expect(200)).body.result;
    expect(init.serverInfo.name).toBe('joybot');
    expect(init.capabilities.tools).toBeDefined();
    expect(init.instructions).toMatch(/treat it as data/);

    const tools = (await rpc(token, 'tools/list').expect(200)).body.result.tools as { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }[];
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['whoami', 'find_customers', 'get_customer', 'list_appointments', 'get_calendar', 'list_payments', 'list_invoices', 'list_todos', 'get_staff_schedule', 'search_knowledge', 'get_business_info']),
    );
    for (const t of tools) expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it('tools answer as the token’s admin', async () => {
    const { token } = await newToken();
    expect((await call(token, 'whoami')).data).toMatchObject({ acting_as: { first_name: 'Ada', role: 'admin' }, token: { name: 'Claude Code', scope: 'read-only' } });

    const found = (await call(token, 'find_customers', { query: 'maria lop' })).data;
    expect(found[0]).toMatchObject({ id: C.maria, customer_number: 'C-10001' });
    expect((await call(token, 'get_customer', { customer_id: C.maria })).data).toMatchObject({ customer_number: 'C-10001', balance: expect.any(String) });

    const from = new Date().toISOString();
    const to = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const cal = (await call(token, 'get_calendar', { from, to })).data;
    expect(cal.appointments.length).toBeGreaterThan(0);
    expect((await call(token, 'list_appointments', { customer_id: C.maria })).data.length).toBeGreaterThan(0);
    expect((await call(token, 'get_business_info')).data.services.length).toBeGreaterThan(0);
    expect((await call(token, 'search_knowledge', { query: 'What payment methods do you accept?' })).data.answers.length).toBeGreaterThan(0);
  });

  it('reports bad arguments as tool errors Claude can correct', async () => {
    const { token } = await newToken();
    const bad = await call(token, 'get_customer', { customer_id: '00000000-0000-4000-8000-000000000000' });
    expect(bad).toMatchObject({ isError: true });
    const range = await call(token, 'get_calendar', { from: new Date().toISOString(), to: new Date(Date.now() + 60 * 86_400_000).toISOString() });
    expect(range.data).toMatch(/45 days/);
  });

  it('rejects missing, unknown, revoked and expired tokens, and tokens of someone no longer an admin', async () => {
    await rpc(null, 'tools/list').expect(401);
    const unknown = await rpc('jbt_notarealtokennotarealtoken1234', 'tools/list').expect(401);
    expect(unknown.headers['www-authenticate']).toMatch(/Bearer/);

    const revoked = await newToken();
    await api(app, employee(U.ada)).delete(`/api/admin/api-tokens/${revoked.id}`).expect(204);
    await rpc(revoked.token, 'tools/list').expect(401);
    await api(app, employee(U.ada)).delete(`/api/admin/api-tokens/${revoked.id}`).expect(404);

    const expired = await newToken();
    await migrator.query(`UPDATE app.api_tokens SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second' WHERE id = $1`, [expired.id]);
    await rpc(expired.token, 'tools/list').expect(401);

    // Sam is made admin, creates a token, then is demoted: the token stops working at once.
    await migrator.query(`UPDATE core.users SET role = 'admin' WHERE id = $1`, [U.sam]);
    const sams = (await api(app, employee(U.sam)).post('/api/admin/api-tokens', { name: 'Sam' }).expect(201)).body;
    await rpc(sams.token, 'tools/list').expect(200);
    await migrator.query(`UPDATE core.users SET role = 'staff' WHERE id = $1`, [U.sam]);
    await rpc(sams.token, 'tools/list').expect(401);
  });

  it('only accepts POST, and limits requests per token', async () => {
    await request(app.getHttpServer()).get('/api/mcp').expect(405);
    const { token } = await newToken();
    const codes: number[] = [];
    for (let i = 0; i < 42; i++) codes.push((await rpc(token, 'tools/list')).status);
    expect(codes.filter((c) => c === 200)).toHaveLength(40);
    expect(codes.at(-1)).toBe(429);
  });
});
