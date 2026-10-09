import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { phoneVariants } from '../src/freshdesk/freshdesk.client';
import { api, createApp, customer, employee } from './app';

const { customers: C, users: U } = SAMPLE;
const KEY = 'fd_test_key';

/** Fake Freshdesk: contacts by email/phone, tickets by requester, conversations with a private note. */
function fakeFreshdesk() {
  const contacts: Record<string, number> = {
    'email:maria@example.com': 101,
    'email:john@acme.example': 102,
    'email:jane@acme.example': 103,
    'phone:(310) 555-0106': 106, // Pat's phone, stored in a national format
    'email:unverified@example.com': 999,
  };
  const ticket = (id: number, requester: number, subject: string, status = 2) => ({
    id, requester_id: requester, subject, status, priority: 2,
    created_at: '2026-10-01T15:00:00Z', updated_at: `2026-10-0${(id % 8) + 1}T15:00:00Z`, description_text: `About: ${subject}`,
  });
  const tickets: Record<number, ReturnType<typeof ticket>[]> = {
    // A misbehaving response: includes someone else's ticket under Maria's contact.
    101: [ticket(5001, 101, 'Refund for haircut'), ticket(5002, 101, 'Change appointment', 4), ticket(7770, 777, 'Someone else')],
    102: [ticket(5003, 102, 'Acme invoice question')],
    103: [ticket(5004, 103, 'Parking at the office')],
    106: [ticket(5006, 106, 'Phone-only customer question')],
    999: [ticket(9990, 999, 'Should never be visible')],
  };
  const all = Object.values(tickets).flat();
  let rateLimitOnce = true;
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url!);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
    if (req.headers.authorization !== `Basic ${Buffer.from(`${KEY}:X`).toString('base64')}`) return json(401, {});
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/api/v2/contacts') {
      const [field, value] = [...url.searchParams.entries()][0];
      const id = contacts[`${field === 'mobile' ? 'phone' : field}:${value}`];
      return json(200, id && field !== 'mobile' ? [{ id }] : []);
    }
    if (url.pathname === '/api/v2/tickets') {
      if (url.searchParams.get('requester_id') === '102' && rateLimitOnce) {
        rateLimitOnce = false;
        return json(429, {}, { 'retry-after': '1' });
      }
      const r = url.searchParams.get('requester_id');
      return json(200, r ? (tickets[Number(r)] ?? []) : all.slice(0, 1));
    }
    const conv = /^\/api\/v2\/tickets\/(\d+)\/conversations$/.exec(url.pathname);
    if (conv) {
      return json(200, [
        { id: 1, body_text: 'We are looking into it.', private: false, incoming: false, user_id: 1, created_at: '2026-10-02T10:00:00Z' },
        { id: 2, body_text: 'Internal: refund approved by Ada.', private: true, incoming: false, user_id: 1, created_at: '2026-10-02T11:00:00Z' },
      ]);
    }
    const one = /^\/api\/v2\/tickets\/(\d+)$/.exec(url.pathname);
    if (one) {
      const t = all.find((x) => x.id === Number(one[1]));
      return t ? json(200, t) : json(404, {});
    }
    json(404, {});
  });
  return { server, requests };
}

describe('phone variants', () => {
  it('covers E.164 and common US formats', () => {
    expect(phoneVariants('+13105550106')).toEqual(
      expect.arrayContaining(['+13105550106', '13105550106', '3105550106', '(310) 555-0106', '310-555-0106']),
    );
  });
});

describe('Freshdesk tickets', () => {
  const fake = fakeFreshdesk();
  let app: INestApplication;
  let unconfigured: INestApplication;
  let migrator: Client;
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

  beforeAll(async () => {
    await new Promise<void>((r) => fake.server.listen(0, r));
    const base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
    config({ path: path.resolve(__dirname, '../../../.env') });
    migrator = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
    await migrator.connect();
    await migrator.query(`UPDATE core.settings SET freshdesk_domain = 'joybot.freshdesk.com', freshdesk_portal_url = 'https://support.joybot.example'`);
    await migrator.query(
      `INSERT INTO core.customers (first_name, email, email_verified, source, preferred_location_id)
       VALUES ('Unverified', 'unverified@example.com', false, 'employee', $1)`,
      [SAMPLE.locations.nyc],
    );
    app = await createApp({ env: { FRESHDESK_BASE_URL: base, FRESHDESK_API_KEY: KEY } });
    unconfigured = await createApp({ env: { FRESHDESK_BASE_URL: '', FRESHDESK_API_KEY: '' } });
  });
  afterAll(async () => {
    await app.close();
    await unconfigured.close();
    // Leave the shared database as other test files expect it.
    await migrator.query(`DELETE FROM core.external_links WHERE source = 'freshdesk_contact'`);
    await migrator.query(`DELETE FROM core.customers WHERE email = 'unverified@example.com'`);
    await migrator.query(`UPDATE core.settings SET freshdesk_domain = NULL, freshdesk_portal_url = NULL`);
    await migrator.end();
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  it('reports when Freshdesk is not set up', async () => {
    const res = await api(unconfigured, customer(C.maria)).get('/api/tickets').expect(503);
    expect(res.body.code).toBe('freshdesk_not_configured');
  });

  it('opens a ticket by direct link before the ticket list was ever loaded', async () => {
    await api(app, customer(C.maria)).get('/api/tickets/5001').expect(200);
    // Staff: the customer page passes the customer as a hint.
    await migrator.query(`DELETE FROM core.external_links WHERE entity_id = $1`, [C.pat]);
    await api(app, employee(U.lia)).get('/api/tickets/5006').expect(404);
    await api(app, employee(U.lia)).get(`/api/tickets/5006?customer_id=${C.pat}`).expect(200);
    // A hint for a customer outside the employee's scope does not help.
    await api(app, employee(U.sam)).get(`/api/tickets/5003?customer_id=${C.john}`).expect(404);
  });

  it('customers see only their own tickets (ownership filter drops stray tickets)', async () => {
    const res = await api(app, customer(C.maria)).get('/api/tickets').expect(200);
    expect(ids(res.body)).toEqual(['5001', '5002']);
    expect(res.body.find((t: { id: string }) => t.id === '5001')).toMatchObject({
      status: 'open',
      url: 'https://support.joybot.example/support/tickets/5001',
    });
  });

  it('hides private notes from customers but shows them to staff', async () => {
    const mine = await api(app, customer(C.maria)).get('/api/tickets/5001').expect(200);
    expect(mine.body.conversation.map((c: { body: string }) => c.body)).toEqual(['We are looking into it.']);
    const staff = await api(app, employee(U.sam)).get('/api/tickets/5001').expect(200);
    expect(staff.body.conversation).toHaveLength(2);
    expect(staff.body.url).toBe('https://joybot.freshdesk.com/a/tickets/5001');
  });

  it("customers cannot open other people's tickets", async () => {
    await api(app, customer(C.john)).get('/api/tickets').expect(200); // caches John's contact link
    await api(app, customer(C.maria)).get('/api/tickets/5003').expect(404);
    await api(app, customer(C.maria)).get('/api/tickets/7770').expect(404);
    await api(app, customer(C.maria)).get('/api/tickets/not-a-number').expect(404);
  });

  it('org admins see their organization’s tickets; members only their own', async () => {
    const org = await api(app, customer(C.john)).get('/api/tickets?scope=org').expect(200);
    expect(ids(org.body)).toEqual(['5003', '5004']);
    const member = await api(app, customer(C.jane)).get('/api/tickets?scope=org').expect(200);
    expect(ids(member.body)).toEqual(['5004']);
  });

  it('staff see tickets of customers in their scope only', async () => {
    expect(ids((await api(app, employee(U.sam)).get(`/api/tickets?customer_id=${C.maria}`).expect(200)).body)).toEqual(['5001', '5002']);
    expect((await api(app, employee(U.sam)).get(`/api/tickets?customer_id=${C.john}`).expect(200)).body).toEqual([]);
    await api(app, employee(U.sam)).get('/api/tickets/5003').expect(404);
    await api(app, employee(U.sam)).get('/api/tickets').expect(400);
  });

  it('matches phone-only customers through phone variants', async () => {
    const res = await api(app, customer(C.pat)).get('/api/tickets').expect(200);
    expect(ids(res.body)).toEqual(['5006']);
  });

  it('never matches on unverified contacts', async () => {
    const res = await api(app, employee(U.ada)).get('/api/customers?q=unverified@example.com').expect(200);
    const tickets = await api(app, employee(U.ada)).get(`/api/tickets?customer_id=${res.body[0].id}`).expect(200);
    expect(tickets.body).toEqual([]);
  });

  it('keeps contacts that staff excluded as wrong matches excluded', async () => {
    await migrator.query(`UPDATE core.external_links SET excluded = true, refreshed_at = now() - interval '2 days' WHERE entity_id = $1`, [C.jane]);
    const res = await api(app, customer(C.jane)).get('/api/tickets').expect(200);
    expect(res.body).toEqual([]);
  });

  it('retried after Freshdesk rate limiting (429 with Retry-After)', () => {
    expect(fake.requests.filter((u) => u.includes('requester_id=102')).length).toBeGreaterThanOrEqual(2);
  });

  it('answers ticket questions in chat with citations', async () => {
    const conv = (await api(app, customer(C.maria)).post('/api/conversations', {}).expect(201)).body.id;
    const res = await request(app.getHttpServer())
      .post(`/api/conversations/${conv}/messages`)
      .set('x-dev-principal', `customer:${C.maria}`)
      .send({ content: 'Any update on my support tickets?' })
      .buffer(true)
      .parse((r, cb) => {
        let d = '';
        r.on('data', (c: Buffer) => (d += c));
        r.on('end', () => cb(null, d));
      })
      .expect(200);
    const citations = JSON.parse(/event: citations\ndata: (.*)\n/.exec(String(res.body))![1]);
    expect(citations.map((c: { id: string }) => c.id).sort()).toEqual(['#5001', '#5002']);
  });

  it('admins can test the connection; staff cannot', async () => {
    await api(app, employee(U.ada)).post('/api/admin/settings/freshdesk/test').expect(200, { ok: true });
    await api(app, employee(U.sam)).post('/api/admin/settings/freshdesk/test').expect(403);
  });
});
