import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import path from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MESSAGE_SENDER, type MessageSender, type OutgoingMessage } from '../src/messaging/messaging.service';
import { GOOGLE_HTTP } from '../src/video/google';
import { api, createApp, customer, employee } from './app';

const { users: U, customers: C } = SAMPLE;

const CLIENT_ID = '123456789012-abcdefghij.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-test-secret-value';
const REFRESH = 'refresh-token-from-google';

const SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';

/** A fake Google: token endpoint, calendars the app made and their events, recording requests. */
class FakeGoogle {
  calls: { method: string; url: URL; body: unknown }[] = [];
  revoked = false;
  calendars = new Map<string, { summary: string; timeZone?: string }>();
  made = 0;
  events = new Map<string, { calendar: string; start: string; end: string }>();
  http = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const raw = init.body ? String(init.body) : undefined;
    const body = raw && init.headers && JSON.stringify(init.headers).includes('x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(raw)) : raw ? JSON.parse(raw) : undefined;
    this.calls.push({ method: init.method ?? 'GET', url: u, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u.host === 'oauth2.googleapis.com') {
      const f = body as Record<string, string>;
      if (f.client_id !== CLIENT_ID || f.client_secret !== CLIENT_SECRET) return json(401, { error: 'invalid_client' });
      if (f.grant_type === 'authorization_code') {
        if (f.code !== 'good-code' && f.code !== 'no-calendar-code') return json(400, { error: 'invalid_grant', error_description: 'Bad code' });
        const idToken = ['x', Buffer.from(JSON.stringify({ email: 'owner@example.com' })).toString('base64url'), 'sig'].join('.');
        // Granular consent: the account may untick the calendar permission.
        const scope = f.code === 'good-code' ? `openid ${SCOPE} https://www.googleapis.com/auth/userinfo.email` : 'openid https://www.googleapis.com/auth/userinfo.email';
        return json(200, { access_token: 'access-1', refresh_token: REFRESH, id_token: idToken, expires_in: 3600, scope });
      }
      if (this.revoked || f.refresh_token !== REFRESH) return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: 'access-2', expires_in: 3600 });
    }
    if (u.host === 'www.googleapis.com') {
      if (this.revoked) return json(401, { error: { message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } });
      const notFound = () => json(404, { error: { message: 'Not Found', status: 'NOT_FOUND' } });
      const [, cal, , id] = u.pathname.replace('/calendar/v3/calendars', '').split('/').map(decodeURIComponent);
      if (!cal) {
        const c = body as { summary: string; timeZone?: string };
        const calId = `joybot-${++this.made}@group.calendar.google.com`;
        this.calendars.set(calId, c);
        return json(200, { id: calId, ...c });
      }
      if (!this.calendars.has(cal)) return notFound();
      if (!u.pathname.includes('/events')) return json(200, { id: cal, ...this.calendars.get(cal) });
      if (init.method === 'POST') {
        const e = body as { start: { dateTime: string }; end: { dateTime: string }; conferenceData: { createRequest: { requestId: string } } };
        const eventId = `evt-${this.events.size + 1}`;
        this.events.set(eventId, { calendar: cal, start: e.start.dateTime, end: e.end.dateTime });
        return json(200, { id: eventId, hangoutLink: `https://meet.google.com/${e.conferenceData.createRequest.requestId.slice(-12)}` });
      }
      if (init.method === 'PATCH') {
        const e = body as { start: { dateTime: string }; end: { dateTime: string } };
        if (this.events.get(id)?.calendar !== cal) return notFound();
        this.events.set(id, { calendar: cal, start: e.start.dateTime, end: e.end.dateTime });
        return json(200, { id });
      }
      if (init.method === 'DELETE') {
        this.events.delete(id);
        return new Response(null, { status: 204 });
      }
    }
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

const google = new FakeGoogle();
const sender = new CapturingSender();
let app: INestApplication;
beforeAll(async () => {
  app = await createApp({
    env: { API_PUBLIC_URL: 'https://api.joybot.test', APP_URL: 'https://app.joybot.test' },
    overrides: [
      { token: GOOGLE_HTTP, value: google.http },
      { token: MESSAGE_SENDER, value: sender },
    ],
  });
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  google.calls = [];
});

const admin = () => api(app, employee(U.ada));
const visitor = () => request(app.getHttpServer());
const REDIRECT = 'https://api.joybot.test/api/website/video/google/callback';

async function asOwner<T>(sql: string, args: unknown[] = []): Promise<T[]> {
  config({ path: path.resolve(__dirname, '../../../.env') });
  const db = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await db.connect();
  try {
    return (await db.query(sql, args)).rows as T[];
  } finally {
    await db.end();
  }
}

async function book(name: string, email: string, days: number, phone?: string) {
  const from = new Date(Date.now() + days * 86_400_000).toISOString();
  const to = new Date(Date.now() + (days + 10) * 86_400_000).toISOString();
  const open = (await visitor().get(`/api/site/sales-call?from=${from}&to=${to}`).expect(200)).body.slots as string[];
  const call = (await visitor().post('/api/site/sales-call').send({ name, email, start: open[0], phone }).expect(201)).body as { id: string };
  return { ...call, open };
}

describe('Google Meet setup', () => {
  it('is for those who may change the website, with the redirect URI to paste into the OAuth client', async () => {
    const s = (await admin().get('/api/website/video').expect(200)).body;
    expect(s).toMatchObject({ google_client_id: null, google_secret_set_at: null, google_account_email: null, checklist: [], redirect_uri: REDIRECT });
    await api(app, employee(U.sam)).get('/api/website/video').expect(403);
    await api(app, customer(C.maria)).get('/api/website/video').expect(403);
  });

  it('saves the project, the checklist, the client ID and the secret (encrypted, never shown)', async () => {
    await admin().put('/api/website/video', { google_client_id: 'not-a-client-id' }).expect(400);
    await admin().put('/api/website/video', { checklist: ['project', 'nope'] }).expect(400);
    const saved = (await admin().put('/api/website/video', { google_project_id: 'acme-site', checklist: ['project', 'api'], google_client_id: CLIENT_ID }).expect(200)).body;
    expect(saved).toMatchObject({ google_project_id: 'acme-site', checklist: ['project', 'api'], google_client_id: CLIENT_ID });

    await admin().post('/api/website/video/google/connect').expect(400); // no secret yet
    const withSecret = (await admin().put('/api/website/video/google/secret', { client_secret: CLIENT_SECRET }).expect(200)).body;
    expect(withSecret.google_secret_set_at).toEqual(expect.any(String));
    expect(JSON.stringify(withSecret)).not.toContain(CLIENT_SECRET);
    const [secret] = await asOwner<{ google_client_secret_cipher: string }>('SELECT google_client_secret_cipher FROM core.video_secret');
    expect(secret.google_client_secret_cipher).toMatch(/^v1\./);
    expect(secret.google_client_secret_cipher).not.toContain(CLIENT_SECRET);
    await admin().put('/api/website/video', { meet_enabled: true }).expect(400); // no switch: connected means on
  });

  it('connects a Google account through the consent screen; the state works once', async () => {
    const { url } = (await admin().post('/api/website/video/google/connect').expect(200)).body as { url: string };
    const consent = new URL(url);
    expect(consent.origin + consent.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(consent.searchParams)).toMatchObject({ client_id: CLIENT_ID, redirect_uri: REDIRECT, access_type: 'offline', prompt: 'consent', response_type: 'code' });
    expect(consent.searchParams.get('scope')!.split(' ').sort()).toEqual(['email', 'openid', SCOPE].sort());
    const state = consent.searchParams.get('state')!;
    const [stored] = await asOwner<{ state_hash: string }>('SELECT state_hash FROM app.oauth_states ORDER BY created_at DESC LIMIT 1');
    expect(stored.state_hash).not.toBe(state); // only its hash

    // Unticking the calendar permission on Google's screen: not connected.
    const narrow = (await admin().post('/api/website/video/google/connect').expect(200)).body as { url: string };
    const refused = await visitor().get(`/api/website/video/google/callback?state=${new URL(narrow.url).searchParams.get('state')}&code=no-calendar-code`).expect(302);
    expect(decodeURIComponent(refused.headers.location)).toContain('permission to make and manage its own calendar');
    expect((await admin().get('/api/website/video').expect(200)).body.google_connected_at).toBeNull();

    const wrong = await visitor().get(`/api/website/video/google/callback?state=forged&code=good-code`).expect(302);
    expect(wrong.headers.location).toMatch(/^https:\/\/app\.joybot\.test\/staff\/sales-calls\?tab=video&google_error=/);
    const cancelled = await visitor().get(`/api/website/video/google/callback?error=access_denied`).expect(302);
    expect(decodeURIComponent(cancelled.headers.location)).toContain('You cancelled');

    const ok = await visitor().get(`/api/website/video/google/callback?state=${state}&code=good-code`).expect(302);
    expect(ok.headers.location).toBe('https://app.joybot.test/staff/sales-calls?tab=video&google=connected&account=owner%40example.com');
    expect(google.calls.find((c) => c.url.host === 'oauth2.googleapis.com')?.body).toMatchObject({ grant_type: 'authorization_code', redirect_uri: REDIRECT });
    const connected = (await admin().get('/api/website/video').expect(200)).body;
    expect(connected).toMatchObject({ google_account_email: 'owner@example.com', google_connected_at: expect.any(String), google_calendar_id: expect.stringMatching(/^joybot-/) });
    // JoyBot's own calendar, named after the site, in the business's time zone.
    expect(google.calendars.get(connected.google_calendar_id)).toEqual({ summary: expect.stringMatching(/ sales calls$/), description: expect.any(String), timeZone: expect.any(String) });
    const [tokens] = await asOwner<{ google_refresh_token_cipher: string }>('SELECT google_refresh_token_cipher FROM core.video_secret');
    expect(tokens.google_refresh_token_cipher).not.toContain(REFRESH);

    const again = await visitor().get(`/api/website/video/google/callback?state=${state}&code=good-code`).expect(302);
    expect(decodeURIComponent(again.headers.location)).toContain('expired or was already used');
  });

  it('a test meeting proves the connection (and is removed again)', async () => {
    const { meet_url } = (await admin().post('/api/website/video/google/test').expect(200)).body;
    expect(meet_url).toMatch(/^https:\/\/meet\.google\.com\//);
    expect(google.calls.map((c) => c.method).filter((m) => m !== 'POST' || true)).toEqual(expect.arrayContaining(['POST', 'DELETE']));
    expect(google.events.size).toBe(0);
    // The last setup step is done.
    expect((await admin().get('/api/website/video').expect(200)).body.checklist).toContain('test');
  });
});

describe('Meet links for sales calls', () => {
  it('each booking gets an event with a Meet link, in the confirmation; rescheduling moves it, cancelling removes it', async () => {
    const before = sender.sent.length;
    const call = await book('Meet Me', 'meetme@example.com', 4);

    expect((await visitor().get(`/api/site/sales-call?from=${new Date().toISOString()}&to=${new Date(Date.now() + 86_400_000).toISOString()}`).expect(200)).body.event.call_method).toBe('video');
    const created = google.calls.find((c) => c.method === 'POST' && c.url.host === 'www.googleapis.com')!;
    const { google_calendar_id } = (await admin().get('/api/website/video').expect(200)).body;
    expect(created.url.pathname).toBe(`/calendar/v3/calendars/${encodeURIComponent(google_calendar_id)}/events`);
    expect(created.url.searchParams.get('conferenceDataVersion')).toBe('1');
    expect(created.url.searchParams.get('sendUpdates')).toBe('none');
    expect(created.body).toMatchObject({ summary: 'Sales call: Meet Me', conferenceData: { createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } } } });

    const listed = ((await admin().get('/api/website/sales-calls?limit=100').expect(200)).body.items as { id: string; meeting_url: string | null }[]).find((c) => c.id === call.id)!;
    expect(listed.meeting_url).toMatch(/^https:\/\/meet\.google\.com\//);
    const confirmation = sender.sent.slice(before).find((m) => m.to === 'meetme@example.com')!;
    expect(confirmation.text).toContain(`Join the call here: ${listed.meeting_url}`);

    const newStart = call.open[6];
    await admin().post(`/api/website/sales-calls/${call.id}/reschedule`, { start: newStart, notify: false }).expect(200);
    expect(google.calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({ start: { dateTime: newStart } });

    await admin().post(`/api/website/sales-calls/${call.id}/cancel`).expect(200);
    expect(google.calls.some((c) => c.method === 'DELETE')).toBe(true);
    const [row] = await asOwner<{ meeting_url: string | null; calendar_event_id: string | null }>('SELECT meeting_url, calendar_event_id FROM core.appointments WHERE id = $1', [call.id]);
    expect(row).toEqual({ meeting_url: null, calendar_event_id: null });
  });

  it('a booking still works when Google refuses (no link)', async () => {
    google.revoked = true;
    const call = await book('No Link', 'nolink@example.com', 6);
    const [row] = await asOwner<{ meeting_url: string | null }>('SELECT meeting_url FROM core.appointments WHERE id = $1', [call.id]);
    expect(row.meeting_url).toBeNull();
    google.revoked = false;
  });

  it('makes the calendar again when it was deleted in Google Calendar', async () => {
    const { google_calendar_id: old } = (await admin().get('/api/website/video').expect(200)).body;
    google.calendars.delete(old);
    const call = await book('New Calendar', 'newcal@example.com', 10);
    const { google_calendar_id } = (await admin().get('/api/website/video').expect(200)).body;
    expect(google_calendar_id).not.toBe(old);
    const [row] = await asOwner<{ calendar_event_id: string }>('SELECT calendar_event_id FROM core.appointments WHERE id = $1', [call.id]);
    expect(google.events.get(row.calendar_event_id)?.calendar).toBe(google_calendar_id);
  });

  it('callbacks chosen on the booking page: no Meet link even while connected', async () => {
    await admin().put('/api/website/sales-call-settings', { call_method: 'phone' }).expect(200);
    google.calls = [];
    const call = await book('Ring Me', 'ringme@example.com', 12, '+1 555 010 0500');
    expect(google.calls.filter((c) => c.url.host === 'www.googleapis.com')).toEqual([]);
    const [row] = await asOwner<{ meeting_url: string | null; contact_phone: string }>('SELECT meeting_url, contact_phone FROM core.appointments WHERE id = $1', [call.id]);
    expect(row).toEqual({ meeting_url: null, contact_phone: '+1 555 010 0500' });
    await admin().put('/api/website/sales-call-settings', { call_method: 'video' }).expect(200);
  });

  it('reconnecting the same account reuses its calendar', async () => {
    const { google_calendar_id } = (await admin().get('/api/website/video').expect(200)).body;
    const { url } = (await admin().post('/api/website/video/google/connect').expect(200)).body as { url: string };
    google.calls = [];
    await visitor().get(`/api/website/video/google/callback?state=${new URL(url).searchParams.get('state')}&code=good-code`).expect(302);
    expect((await admin().get('/api/website/video').expect(200)).body.google_calendar_id).toBe(google_calendar_id);
    expect(google.calls.some((c) => c.method === 'POST' && c.url.pathname === '/calendar/v3/calendars')).toBe(false);
  });

  it('disconnecting stops Meet links; removing the secret disconnects too', async () => {
    const off = (await admin().delete('/api/website/video/google/connection').expect(200)).body;
    expect(off).toMatchObject({ google_account_email: null, google_connected_at: null });
    expect(off.checklist).not.toContain('test'); // to be tested again with the next account
    google.calls = [];
    const call = await book('Off Again', 'offagain@example.com', 8, '+1 555 010 0400');
    expect(google.calls.filter((c) => c.url.host === 'www.googleapis.com')).toEqual([]);
    const [row] = await asOwner<{ meeting_url: string | null }>('SELECT meeting_url FROM core.appointments WHERE id = $1', [call.id]);
    expect(row.meeting_url).toBeNull();
    const page = (await visitor().get(`/api/site/sales-call?from=${new Date().toISOString()}&to=${new Date(Date.now() + 86_400_000).toISOString()}`).expect(200)).body;
    expect(page.event.call_method).toBe('phone'); // back to callbacks
    expect((await admin().delete('/api/website/video/google/secret').expect(200)).body).toMatchObject({ google_secret_set_at: null });
    await api(app, employee(U.sam)).delete('/api/website/video/google/secret').expect(403);
  });
});
