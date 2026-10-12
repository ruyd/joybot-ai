import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RESEND_HTTP } from '../src/email/resend';
import { MESSAGE_SENDER, type MessageSender, type OutgoingMessage } from '../src/messaging/messaging.service';
import { api, createApp, customer, employee } from './app';

const { customers: C, users: U } = SAMPLE;

const GOOD = 're_good_full_access_key_1234';
const SENDING = 're_sending_only_key_5678';

/** A fake Resend: records requests and answers like the real API for a few keys. */
class FakeResend {
  calls: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
  usage = {
    object: 'usage',
    emails: {
      daily: { used: 10, limit: 100, sent: 8, received: 2, resets_at: '2026-07-29T00:00:00.000Z' },
      monthly: { used: 100, limit: 3000, sent: 80, received: 20, resets_at: '2026-08-01T00:00:00.000Z' },
    },
    domains: { used: 1, limit: 1 },
    rate_limit: { limit: 1000, duration: '1000ms' },
  };
  http = async (url: string, init: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const u = new URL(url);
    this.calls.push({ method: init.method ?? 'GET', path: u.pathname, headers, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const key = headers.Authorization?.replace('Bearer ', '');
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (!headers['User-Agent']) return json(403, { name: 'missing_user_agent' });
    if (key !== GOOD && key !== SENDING) return json(401, { statusCode: 401, name: 'invalid_api_key', message: 'API key is invalid' });
    if (u.pathname === '/emails' && init.method === 'POST') return json(200, { id: `email-${this.calls.length}` });
    if (key === SENDING) return json(401, { statusCode: 401, name: 'restricted_api_key', message: 'This API key is restricted to only send emails' });
    if (u.pathname === '/usage') return json(200, this.usage);
    if (u.pathname === '/domains')
      return json(200, { object: 'list', has_more: false, data: [{ id: 'd1', name: 'appjoy.dev', status: 'verified', created_at: '2026-01-01 00:00:00+00', region: 'us-east-1' }] });
    return json(404, { name: 'not_found' });
  };
}

class CapturingSender implements MessageSender {
  sent: OutgoingMessage[] = [];
  async send(m: OutgoingMessage) {
    this.sent.push(m);
    return {};
  }
}

const resend = new FakeResend();
const sender = new CapturingSender();
let app: INestApplication;
beforeAll(async () => {
  app = await createApp({
    overrides: [
      { token: RESEND_HTTP, value: resend.http },
      { token: MESSAGE_SENDER, value: sender },
    ],
  });
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  resend.calls = [];
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

describe('email settings', () => {
  it('are for admins; staff and customers cannot see or change them', async () => {
    const s = (await admin().get('/api/admin/email').expect(200)).body;
    expect(s).toMatchObject({ active: false, resend_key_last4: null, from_email: null, encryption_available: true });
    await api(app, employee(U.sam)).get('/api/admin/email').expect(403);
    await api(app, employee(U.sam)).put('/api/admin/email/api-key', { api_key: GOOD }).expect(403);
    await api(app, customer(C.maria)).get('/api/admin/email').expect(403);
  });

  it('validates the sender; there is no on/off switch (Resend is on once a key and a from address are saved)', async () => {
    await admin().put('/api/admin/email', { resend_enabled: true }).expect(400);
    await admin().put('/api/admin/email', { from_email: 'not an email' }).expect(400);
    await admin().put('/api/admin/email', { from_name: 'Bad <name>' }).expect(400);
    await admin().get('/api/admin/email/usage').expect(400); // no key yet
  });
});

describe('the Resend API key', () => {
  it('is checked with Resend, stored encrypted, shown only by its last four characters, and kept out of the audit log', async () => {
    await admin().put('/api/admin/email/api-key', { api_key: 'sk_live_wrong' }).expect(400);
    const bad = await admin().put('/api/admin/email/api-key', { api_key: 're_not_a_real_key_000' }).expect(400);
    expect(bad.body.message).toMatch(/did not accept this API key/);

    const saved = (await admin().put('/api/admin/email/api-key', { api_key: GOOD }).expect(200)).body;
    expect(saved).toMatchObject({ resend_key_last4: '1234', resend_key_set_at: expect.any(String) });
    expect(JSON.stringify(saved)).not.toContain(GOOD);
    expect(resend.calls.at(-1)).toMatchObject({ path: '/domains', headers: { Authorization: `Bearer ${GOOD}`, 'User-Agent': 'JoyBot' } });

    const [secret] = await asOwner<{ resend_key_cipher: string }>('SELECT resend_key_cipher FROM core.email_secret');
    expect(secret.resend_key_cipher).toMatch(/^v1\./);
    expect(secret.resend_key_cipher).not.toContain(GOOD);
    const log = await asOwner<{ diff: unknown }>(`SELECT diff FROM core.change_log WHERE table_name IN ('email_settings', 'email_secret')`);
    expect(log.length).toBeGreaterThan(0);
    expect(JSON.stringify(log)).not.toContain(secret.resend_key_cipher);
    expect(JSON.stringify(log)).not.toContain(GOOD);
  });

  it('a sending-only key is accepted (usage and domains then explain the restriction)', async () => {
    expect((await admin().put('/api/admin/email/api-key', { api_key: SENDING }).expect(200)).body.resend_key_last4).toBe('5678');
    expect((await admin().get('/api/admin/email/usage').expect(400)).body.message).toMatch(/only send email/);
    await admin().put('/api/admin/email/api-key', { api_key: GOOD }).expect(200);
  });
});

describe('usage and domains', () => {
  it('come from Resend with the saved key', async () => {
    const usage = (await admin().get('/api/admin/email/usage').expect(200)).body;
    expect(usage).toMatchObject({ emails: { daily: { used: 10, limit: 100 }, monthly: { used: 100, limit: 3000 } }, rate_limit: { limit: 1000, duration: '1000ms' } });
    expect(resend.calls.at(-1)).toMatchObject({ method: 'GET', path: '/usage' });
    expect((await admin().get('/api/admin/email/domains').expect(200)).body).toEqual([expect.objectContaining({ name: 'appjoy.dev', status: 'verified' })]);
    await api(app, employee(U.sam)).get('/api/admin/email/usage').expect(403);
  });
});

describe('sending', () => {
  it('a test email goes through Resend, from the saved sender or else Resend\'s testing sender', async () => {
    // No from address yet: the test goes from Resend's testing sender.
    const early = (await admin().post('/api/admin/email/test', { to: 'ada@example.com' }).expect(200)).body;
    expect(early).toMatchObject({ id: expect.stringMatching(/^email-/), from: 'onboarding@resend.dev' });
    expect(resend.calls.at(-1)).toMatchObject({ method: 'POST', path: '/emails', body: { from: 'onboarding@resend.dev', to: ['ada@example.com'] } });

    await admin().put('/api/admin/email', { reply_to: 'team@appjoy.dev' }).expect(400); // no reply-to setting
    await admin().put('/api/admin/email', { from_name: 'Appjoy', from_email: 'Hello@Appjoy.dev' }).expect(200);
    expect((await admin().post('/api/admin/email/test', { to: 'ada@example.com' }).expect(200)).body.from).toBe('Appjoy <hello@appjoy.dev>');
    expect(resend.calls.at(-1)).toMatchObject({ body: { from: 'Appjoy <hello@appjoy.dev>', to: ['ada@example.com'], subject: 'Test email from JoyBot' } });
  });

  it("the app's email goes through Resend once a key and a from address are saved, otherwise the usual sender", async () => {
    // Without a from address Resend is not active: a staff reply to a ticket goes through the usual sender.
    expect((await admin().put('/api/admin/email', { from_email: '' }).expect(200)).body).toMatchObject({ active: false, from_email: null });
    const before = sender.sent.length;
    await api(app, employee(U.sam)).post('/api/tickets/5001/messages', { body: 'Through the usual sender' }).expect(201);
    expect(sender.sent.length).toBe(before + 1);
    expect(resend.calls.filter((c) => c.path === '/emails')).toEqual([]);

    // Saving a from address (the key is already saved) makes Resend active.
    expect((await admin().put('/api/admin/email', { from_email: 'hello@appjoy.dev' }).expect(200)).body.active).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    // The sending cache holds the old settings for 30 seconds; a new app instance reads them fresh.
    const fresh = await createApp({ overrides: [{ token: RESEND_HTTP, value: resend.http }, { token: MESSAGE_SENDER, value: sender }] });
    try {
      await api(fresh, employee(U.sam)).post('/api/tickets/5001/messages', { body: 'Through Resend' }).expect(201);
    } finally {
      await fresh.close();
    }
    expect(sender.sent.length).toBe(before + 1); // not the usual sender
    expect(resend.calls.find((c) => c.path === '/emails')).toMatchObject({
      body: { from: 'Appjoy <hello@appjoy.dev>', to: ['maria@example.com'], tags: [{ name: 'template', value: 'ticket' }] },
    });

    // Verification codes are the auth provider's: they keep the usual sender even with Resend on.
    const fresh2 = await createApp({ overrides: [{ token: RESEND_HTTP, value: resend.http }, { token: MESSAGE_SENDER, value: sender }] });
    try {
      const emailsBefore = resend.calls.filter((c) => c.path === '/emails').length;
      await api(fresh2, customer(C.maria)).post('/api/me/contacts', { type: 'email', value: 'maria.new@example.com' }).expect(200);
      expect(resend.calls.filter((c) => c.path === '/emails').length).toBe(emailsBefore);
      expect(sender.sent.at(-1)).toMatchObject({ template: 'contact_code', to: 'maria.new@example.com' });
    } finally {
      await fresh2.close();
    }

    // Removing the key makes it inactive again.
    expect((await admin().delete('/api/admin/email/api-key').expect(200)).body).toMatchObject({ active: false, resend_key_last4: null });
  });
});
