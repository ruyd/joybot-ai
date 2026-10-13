import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import path from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityFromClaims, SUPABASE_HTTP, SUPABASE_TOKENS, type SupabaseIdentity } from '../src/auth/supabase';
import { loadConfig } from '../src/config/config';
import { MESSAGE_SENDER, type MessageSender, type OutgoingMessage } from '../src/messaging/messaging.service';
import { createApp } from './app';

// AUTH_MODE=supabase (docs/deploy-free.md): one Supabase user pool, the area from x-joybot-audience,
// logins linked on first use with the same SQL rules as Cognito's triggers.

const { users: U, customers: C } = SAMPLE;

const who = (sub: string, email: string | null, emailVerified = true, phone: string | null = null, phoneVerified = false): SupabaseIdentity => ({
  sub,
  email,
  emailVerified,
  phone,
  phoneVerified,
});
const TOKENS: Record<string, SupabaseIdentity> = {
  ada: who('sb-ada', 'ada@example.com'),
  'ada-unverified': who('sb-ada-2', 'ada@example.com', false),
  stranger: who('sb-stranger', 'nobody@example.com'),
  maria: who('sb-maria', 'maria@example.com'),
  pat: who('sb-pat', null, false, '+13105550106', true),
  unconfirmed: who('sb-unconfirmed', 'new@example.com', false),
  clash: who('sb-clash', 'maria@example.com'),
  newbie: who('sb-newbie', 'newbie@example.com'),
};
const tokens = {
  async verify(token: string) {
    const id = TOKENS[token];
    if (!id) throw new Error('bad token');
    return id;
  },
};

/** Supabase's Auth admin API: records calls, knows one existing login. */
class FakeSupabase {
  calls: { method: string; path: string; body: unknown; key: string | null }[] = [];
  http = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method: init.method ?? 'GET', path: u.pathname + u.search, body, key: (init.headers as Record<string, string>).apikey ?? null });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/auth/v1/invite') return body.email === 'back@example.com' ? json(422, { error_code: 'email_exists' }) : json(200, { id: 'new-login' });
    if (u.pathname === '/auth/v1/admin/users' && init.method === 'GET') return json(200, { users: [{ id: 'sb-back', email: 'back@example.com' }, { id: 'sb-ada', email: 'ada@example.com' }] });
    if (u.pathname.startsWith('/auth/v1/admin/users/')) return body?.email === 'taken@example.com' ? json(422, { error_code: 'email_exists' }) : json(200, {});
    if (u.pathname === '/auth/v1/otp') return json(200, {});
    return json(404, {});
  };
}

class CapturingSender implements MessageSender {
  sent: OutgoingMessage[] = [];
  async send(m: OutgoingMessage) {
    this.sent.push(m);
    return {};
  }
}

const supabase = new FakeSupabase();
const sender = new CapturingSender();
let app: INestApplication;
let migrator: Client;
beforeAll(async () => {
  config({ path: path.resolve(__dirname, '../../../.env') });
  migrator = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await migrator.connect();
  app = await createApp({
    env: { AUTH_MODE: 'supabase', SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests', APP_URL: 'https://appjoy.test' },
    overrides: [
      { token: SUPABASE_TOKENS, value: tokens },
      { token: SUPABASE_HTTP, value: supabase.http },
      { token: MESSAGE_SENDER, value: sender },
    ],
  });
});
afterAll(async () => {
  await app.close();
  await migrator.end();
});

const as = (token: string | null, area: 'employee' | 'customer' = 'customer') => {
  const server = app.getHttpServer();
  const auth = (r: request.Test) => {
    if (token) r.set('authorization', `Bearer ${token}`);
    if (area === 'employee') r.set('x-joybot-audience', 'employee');
    return r;
  };
  return {
    get: (url: string) => auth(request(server).get(url)),
    post: (url: string, body?: object) => auth(request(server).post(url)).send(body),
    put: (url: string, body?: object) => auth(request(server).put(url)).send(body),
  };
};

describe('sign-in', () => {
  it('rejects missing and forged tokens, and the dev header', async () => {
    await as(null).get('/api/me').expect(401);
    await as('forged').get('/api/me').expect(401);
    await request(app.getHttpServer()).get('/api/me').set('x-dev-principal', `employee:${U.ada}`).expect(401);
  });

  it('links an employee on first staff sign-in by verified email, then resolves them by login', async () => {
    await as('ada-unverified', 'employee').get('/api/me').expect(401);
    const first = await as('ada', 'employee').get('/api/me').expect(200);
    expect(first.body).toMatchObject({ type: 'employee', role: 'admin', profile: { id: U.ada } });
    const [row] = (await migrator.query('SELECT cognito_sub FROM core.users WHERE id = $1', [U.ada])).rows;
    expect(row.cognito_sub).toBe('sb-ada');
    await as('ada', 'employee').get('/api/me').expect(200);

    const stranger = await as('stranger', 'employee').get('/api/me').expect(401);
    expect(stranger.body.message).toBe('No staff account uses this email');
  });

  it('links customers by verified email or phone, and creates new ones', async () => {
    expect((await as('maria').get('/api/me').expect(200)).body).toMatchObject({ type: 'customer', profile: { id: C.maria } });
    expect((await as('pat').get('/api/me').expect(200)).body).toMatchObject({ type: 'customer', profile: { id: C.pat } });
    const unconfirmed = await as('unconfirmed').get('/api/me').expect(401);
    expect(unconfirmed.body.message).toMatch(/not confirmed/);
  });

  it('first requests arriving together link the login once', async () => {
    const [a, b, c] = await Promise.all([as('newbie').get('/api/me'), as('newbie').get('/api/me'), as('newbie').get('/api/me')]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(new Set([a.body.profile.id, b.body.profile.id, c.body.profile.id]).size).toBe(1);
    const { rows } = await migrator.query(`SELECT count(*)::int AS n FROM core.customers WHERE cognito_sub = 'sb-newbie'`);
    expect(rows[0].n).toBe(1);
    // Linked as the worker (like Cognito's Lambdas), and marked in the audit log.
    const log = await migrator.query(`SELECT changed_via, changed_by FROM core.change_log WHERE table_name = 'customers' AND row_id = $1`, [a.body.profile.id]);
    expect(log.rows).toEqual([{ changed_via: 'supabase', changed_by: null }]);
  });

  it("a contact that belongs to another login goes to staff review once (403, so the app doesn't sign out)", async () => {
    const first = await as('clash').get('/api/me').expect(403);
    expect(first.body.code).toBe('account_in_review');
    await as('clash').get('/api/me').expect(403);
    const { rows } = await migrator.query(`SELECT count(*)::int AS n FROM app.link_review_queue WHERE cognito_sub = 'sb-clash'`);
    expect(rows[0].n).toBe(1);
  });
});

describe('logins in Supabase', () => {
  it('inviting an employee sends Supabase’s invite (to the staff console); a returning one is let back in', async () => {
    supabase.calls = [];
    await as('ada', 'employee').post('/api/admin/users', { first_name: 'New', last_name: 'Hire', email: 'hire@example.com', role: 'staff' }).expect(201);
    expect(supabase.calls[0]).toMatchObject({ method: 'POST', path: `/auth/v1/invite?redirect_to=${encodeURIComponent('https://appjoy.test/staff')}`, body: { email: 'hire@example.com' }, key: 'service-role-key-for-tests' });

    supabase.calls = [];
    await as('ada', 'employee').post('/api/admin/users', { first_name: 'Came', last_name: 'Back', email: 'back@example.com', role: 'staff' }).expect(201);
    expect(supabase.calls.map((c) => `${c.method} ${c.path.split('?')[0]}`)).toEqual([
      'POST /auth/v1/invite',
      'GET /auth/v1/admin/users',
      'PUT /auth/v1/admin/users/sb-back',
      'POST /auth/v1/otp',
    ]);
    expect(supabase.calls[2].body).toEqual({ ban_duration: 'none' });
  });

  it('deactivating an employee bans their login', async () => {
    const { rows } = await migrator.query(`SELECT id FROM core.users WHERE email = 'back@example.com'`);
    supabase.calls = [];
    await as('ada', 'employee').put(`/api/admin/users/${rows[0].id}`, { active: false }).expect(200);
    expect(supabase.calls.at(-1)).toMatchObject({ method: 'PUT', path: '/auth/v1/admin/users/sb-back', body: { ban_duration: '876000h' } });
  });

  it("a contact verified in JoyBot is set on the customer's login", async () => {
    supabase.calls = [];
    const req = await as('maria').post('/api/me/contacts', { type: 'email', value: 'maria.new@example.com' }).expect(200);
    const code = /\b(\d{6})\b/.exec(sender.sent.at(-1)!.text)![1];
    await as('maria').post('/api/me/contacts/verify', { verification_id: req.body.verification_id, code }).expect(200);
    expect(supabase.calls.at(-1)).toMatchObject({ method: 'PUT', path: '/auth/v1/admin/users/sb-maria', body: { email: 'maria.new@example.com', email_confirm: true } });
  });
});

describe('Supabase tokens and settings', () => {
  it('reads the login and confirmed contacts from the claims', () => {
    expect(identityFromClaims({ sub: 'u1', role: 'authenticated', email: 'A@Example.com', phone: '15550100', user_metadata: { email_verified: true } })).toEqual({
      sub: 'u1',
      email: 'a@example.com',
      emailVerified: true,
      phone: '+15550100',
      phoneVerified: false,
    });
    expect(() => identityFromClaims({ sub: 'u1', role: 'anon' })).toThrow();
  });

  it('needs the project URL and service-role key', () => {
    const base = { ...process.env, AUTH_MODE: 'supabase' };
    expect(() => loadConfig(base)).toThrow(/SUPABASE_URL is required/);
    expect(() => loadConfig({ ...base, SUPABASE_URL: 'https://proj.supabase.co' })).toThrow(/SUPABASE_SERVICE_ROLE_KEY is required/);
  });
});
