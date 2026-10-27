import type { INestApplication } from '@nestjs/common';
import { SAMPLE, sslFromEnv } from '@joybot/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config';
import { RESEND_HTTP } from '../src/email/resend';
import { ResendOnlySender } from '../src/messaging/messaging.service';
import { api, createApp, customer, employee } from './app';

// Options for hosts other than AWS (docs/deploy-free.md): CORS, every email through Resend, database CA.

const { users: U, customers: C } = SAMPLE;
const KEY = 're_test_key_abcd1234';

class FakeResend {
  emails: { to: string[]; subject: string; tags: { name: string; value: string }[] }[] = [];
  http = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/emails' && init.method === 'POST') {
      this.emails.push(JSON.parse(String(init.body)));
      return json(200, { id: `email-${this.emails.length}` });
    }
    if (u.pathname === '/domains') return json(200, { object: 'list', has_more: false, data: [] });
    return json(404, { name: 'not_found' });
  };
}

describe('CORS_ORIGINS', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp({ env: { CORS_ORIGINS: 'https://example.com, https://www.example.com/' } });
  });
  afterAll(async () => {
    await app.close();
  });

  it('lets the listed origins call the API (no credentials) and no others', async () => {
    const ok = await request(app.getHttpServer())
      .options('/api/site')
      .set('Origin', 'https://www.example.com')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization');
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe('https://www.example.com');
    expect(ok.headers['access-control-allow-credentials']).toBeUndefined();
    expect(ok.headers['access-control-max-age']).toBe('86400');

    const other = await request(app.getHttpServer()).options('/api/site').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'GET');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('is off unless set, and takes origins only', async () => {
    const plain = await createApp();
    try {
      const res = await request(plain.getHttpServer()).get('/api/site').set('Origin', 'https://example.com');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await plain.close();
    }
    const base = { ...process.env, AUTH_MODE: 'dev' };
    expect(() => loadConfig({ ...base, CORS_ORIGINS: 'https://example.com/app' })).toThrow(/origins only/);
    expect(() => loadConfig({ ...base, CORS_ORIGINS: 'example.com' })).toThrow();
    expect(loadConfig({ ...base, CORS_ORIGINS: '' }).CORS_ORIGINS).toBeUndefined();
    // .env.example leaves the free-tier settings empty (CI copies it): empty means unset.
    const empty = loadConfig({ ...base, MESSAGING_MODE: '', DB_SSL_CA: '', DB_SSL_CA_FILE: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_JWT_SECRET: '' });
    expect([empty.MESSAGING_MODE, empty.DB_SSL_CA, empty.SUPABASE_URL]).toEqual([undefined, undefined, undefined]);
  });
});

describe('MESSAGING_MODE=resend', () => {
  const resend = new FakeResend();
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp({ env: { MESSAGING_MODE: 'resend' }, overrides: [{ token: RESEND_HTTP, value: resend.http }] });
  });
  afterAll(async () => {
    await app.close();
  });

  it('sends every email through Resend, verification codes included; before setup it says what is missing', async () => {
    const early = await api(app, customer(C.pat)).post('/api/me/contacts', { type: 'email', value: 'pat.early@example.com' }).expect(503);
    expect(early.body.message).toMatch(/Settings › Email/);

    const admin = api(app, employee(U.ada));
    await admin.put('/api/admin/email/api-key', { api_key: KEY }).expect(200);
    await admin.put('/api/admin/email', { from_email: 'hello@example.com' }).expect(200);

    await api(app, customer(C.pat)).post('/api/me/contacts', { type: 'email', value: 'pat.new@example.com' }).expect(200);
    expect(resend.emails.at(-1)).toMatchObject({ to: ['pat.new@example.com'], tags: [{ name: 'template', value: 'contact_code' }] });
  });

  it('has no WhatsApp', async () => {
    const m = { channel: 'whatsapp', to: '+15550100777', template: 'contact_code', subject: '', text: '' } as const;
    await expect(new ResendOnlySender().send(m)).rejects.toThrow(/WhatsApp is not available/);
  });
});

describe('sslFromEnv', () => {
  it('verifies the server when DB_SSL=true, with a CA from the environment when given', () => {
    expect(sslFromEnv({})).toBeUndefined();
    expect(sslFromEnv({ DB_SSL: 'true' })).toEqual({ rejectUnauthorized: true });
    expect(sslFromEnv({ DB_SSL: 'true', DB_SSL_CA: '-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----' })).toEqual({
      rejectUnauthorized: true,
      ca: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
    });
    expect(sslFromEnv({ DB_SSL: 'false', DB_SSL_CA: 'x' })).toBeUndefined();
  });
});
