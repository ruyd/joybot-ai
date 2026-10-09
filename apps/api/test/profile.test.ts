import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MESSAGE_SENDER, type MessageSender, type OutgoingMessage } from '../src/messaging/messaging.service';
import { CUSTOMER_LOGINS, type CustomerLogins } from '../src/profile/customer-logins';
import { api, createApp, customer, employee } from './app';

const { customers: C, users: U, orgs: O } = SAMPLE;

class FakeSender implements MessageSender {
  sent: OutgoingMessage[] = [];
  async send(m: OutgoingMessage) {
    this.sent.push(m);
    return { providerMessageId: `msg-${this.sent.length}` };
  }
  last() {
    return this.sent[this.sent.length - 1];
  }
  code() {
    return /\b(\d{6})\b/.exec(this.last().text)![1];
  }
  link() {
    return /(http\S+)/.exec(this.last().text)![1];
  }
}

class FakeLogins implements CustomerLogins {
  calls: string[] = [];
  async setVerifiedContact(sub: string, type: 'email' | 'phone', value: string) {
    this.calls.push(`${sub} ${type} ${value}`);
  }
}

const sender = new FakeSender();
const logins = new FakeLogins();
let app: INestApplication;
let migrator: Client;

beforeAll(async () => {
  config({ path: path.resolve(__dirname, '../../../.env') });
  migrator = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await migrator.connect();
  app = await createApp({
    env: { APP_URL: 'https://app.joybot.example' },
    overrides: [
      { token: MESSAGE_SENDER, value: sender },
      { token: CUSTOMER_LOGINS, value: logins },
    ],
  });
});
afterAll(async () => {
  await app.close();
  await migrator.end();
});
beforeEach(() => {
  sender.sent = [];
  logins.calls = [];
});

const enableWhatsApp = () =>
  migrator.query(
    `UPDATE core.settings SET whatsapp_enabled = true, whatsapp_phone_number_id = 'phone-number-id-1',
            whatsapp_otp_template = 'joybot_otp', whatsapp_invite_template = 'joybot_invite'`,
  );

describe('profile self-service', () => {
  it('customers edit their profile; it becomes complete with name + verified contact', async () => {
    const res = await api(app, customer(C.maria))
      .put('/api/me', { last_name: 'López', time_zone: 'America/Chicago', preferred_location_id: SAMPLE.locations.la, whatsapp_opt_in: true })
      .expect(200);
    expect(res.body).toMatchObject({ last_name: 'López', time_zone: 'America/Chicago', preferred_location_id: SAMPLE.locations.la });
    expect(res.body.whatsapp_opt_in_at).not.toBeNull();
    expect(res.body.profile_completed_at).not.toBeNull();
    await api(app, customer(C.maria)).put('/api/me', { time_zone: 'Mars/Base' }).expect(400);
    await api(app, customer(C.maria)).put('/api/me', { email: 'x@example.com' }).expect(400); // contacts need verification
    await api(app, employee(U.sam)).put('/api/me', { first_name: 'X' }).expect(403);
  });

  it('adds a new email with a code, then updates the Cognito login', async () => {
    await migrator.query(`UPDATE core.customers SET cognito_sub = 'sub-pat' WHERE id = $1`, [C.pat]);
    const req = await api(app, customer(C.pat)).post('/api/me/contacts', { type: 'email', value: 'Pat@Example.com' }).expect(200);
    expect(req.body).toMatchObject({ channel: 'email', sent_to: 'p•••t@example.com' });
    expect(sender.last()).toMatchObject({ channel: 'email', to: 'pat@example.com', template: 'contact_code' });

    await api(app, customer(C.pat)).post('/api/me/contacts/verify', { verification_id: req.body.verification_id, code: '000000' === sender.code() ? '111111' : '000000' }).expect(400);
    const ok = await api(app, customer(C.pat)).post('/api/me/contacts/verify', { verification_id: req.body.verification_id, code: sender.code() }).expect(200);
    expect(ok.body).toMatchObject({ email: 'pat@example.com', email_verified: true });
    expect(logins.calls).toEqual(['sub-pat email pat@example.com']);
    const me = await api(app, customer(C.pat)).get('/api/me').expect(200);
    expect(me.body.profile).toMatchObject({ email: 'pat@example.com', email_verified: true, phone_verified: true });
    await api(app, customer(C.pat)).post('/api/me/contacts/verify', { verification_id: req.body.verification_id, code: sender.code() }).expect(400);
  });

  it('refuses a contact that belongs to another customer (nothing changes)', async () => {
    const req = await api(app, customer(C.jane)).post('/api/me/contacts', { type: 'email', value: 'maria@example.com' }).expect(200);
    await api(app, customer(C.jane)).post('/api/me/contacts/verify', { verification_id: req.body.verification_id, code: sender.code() }).expect(409);
    const jane = (await migrator.query('SELECT email FROM core.customers WHERE id = $1', [C.jane])).rows[0];
    expect(jane.email).toBe('jane@acme.example');
  });

  it('locks a code after 5 wrong attempts, and expires codes', async () => {
    const req = await api(app, customer(C.jane)).post('/api/me/contacts', { type: 'email', value: 'jane.doe@example.com' }).expect(200);
    const code = sender.code();
    const wrong = code === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) {
      await api(app, customer(C.jane)).post('/api/me/contacts/verify', { verification_id: req.body.verification_id, code: wrong }).expect(400);
    }
    await api(app, customer(C.jane)).post('/api/me/contacts/verify', { verification_id: req.body.verification_id, code }).expect(403);

    const req2 = await api(app, customer(C.jane)).post('/api/me/contacts', { type: 'email', value: 'jane.d@example.com' }).expect(200);
    await migrator.query(`UPDATE app.contact_verifications SET expires_at = now() - interval '1 minute' WHERE id = $1`, [req2.body.verification_id]);
    const expired = await api(app, customer(C.jane)).post('/api/me/contacts/verify', { verification_id: req2.body.verification_id, code: sender.code() }).expect(400);
    expect(expired.body.message).toMatch(/expired/);
  });

  it("cannot verify someone else's code and limits codes per hour", async () => {
    const req = await api(app, customer(C.maria)).post('/api/me/contacts', { type: 'email', value: 'maria.new@example.com' }).expect(200);
    await api(app, customer(C.jane)).post('/api/me/contacts/verify', { verification_id: req.body.verification_id, code: sender.code() }).expect(404);
    for (let i = 0; i < 4; i++) await api(app, customer(C.maria)).post('/api/me/contacts', { type: 'email', value: `m${i}@example.com` }).expect(200);
    const limited = await api(app, customer(C.maria)).post('/api/me/contacts', { type: 'email', value: 'm9@example.com' }).expect(400);
    expect(limited.body.message).toMatch(/Too many/);
  });

  it('verifies phones over WhatsApp only when WhatsApp is set up', async () => {
    await migrator.query(`UPDATE core.settings SET whatsapp_enabled = false`);
    await api(app, customer(C.john)).post('/api/me/contacts', { type: 'phone', value: '+13105550199' }).expect(503);
    await enableWhatsApp();
    const req = await api(app, customer(C.john)).post('/api/me/contacts', { type: 'phone', value: '+13105550199' }).expect(200);
    expect(sender.last()).toMatchObject({
      channel: 'whatsapp',
      to: '+13105550199',
      whatsapp: { phoneNumberId: 'phone-number-id-1', template: 'joybot_otp', bodyParams: [sender.code()], buttonParam: sender.code() },
    });
    const ok = await api(app, customer(C.john)).post('/api/me/contacts/verify', { verification_id: req.body.verification_id, code: sender.code() }).expect(200);
    expect(ok.body).toMatchObject({ phone: '+13105550199', phone_verified: true });
  });
});

describe('invites', () => {
  const token = (link: string) => new URL(link).searchParams.get('token')!;

  it('staff invite a customer by email; the link previews and is accepted once', async () => {
    const res = await api(app, employee(U.sam)).post(`/api/customers/${C.jane}/invite`, { channel: 'email' }).expect(200);
    expect(res.body).toMatchObject({ sent: true, channel: 'email', sent_to: 'j•••e@acme.example' });
    expect(sender.last()).toMatchObject({ channel: 'email', to: 'jane@acme.example', template: 'invite' });
    expect(sender.link()).toMatch(/^https:\/\/app\.joybot\.example\/portal\/invite\?token=/);
    expect(res.body.dev_link).toBe(sender.link());

    const t = token(sender.link());
    const preview = await request(app.getHttpServer()).get(`/api/invites/${t}`).expect(200);
    expect(preview.body).toMatchObject({ organization: 'Acme Corp', channel: 'email', sent_to: 'j•••e@acme.example' });
    expect(JSON.stringify(preview.body)).not.toContain('jane@acme.example');

    await api(app, customer(C.jane)).post('/api/me/invites/accept', { token: t }).expect(200, { status: 'linked' });
    await request(app.getHttpServer()).get(`/api/invites/${t}`).expect(404);
    await api(app, customer(C.jane)).post('/api/me/invites/accept', { token: t }).expect(404);
  });

  it('accepting with a different account goes to staff review', async () => {
    await api(app, employee(U.ada)).post(`/api/customers/${C.rita}/invite`, { channel: 'email' }).expect(200);
    const res = await api(app, customer(C.maria)).post('/api/me/invites/accept', { token: token(sender.link()) }).expect(200);
    expect(res.body).toEqual({ status: 'review' });
    const queued = (await migrator.query(`SELECT candidate_customer_id, reason FROM app.link_review_queue WHERE reason = 'invite_accepted_by_other_account'`)).rows;
    expect(queued).toEqual([{ candidate_customer_id: C.rita, reason: 'invite_accepted_by_other_account' }]);
  });

  it('WhatsApp invites need the customer’s opt-in', async () => {
    await enableWhatsApp();
    await migrator.query(`UPDATE core.customers SET whatsapp_opt_in_at = NULL WHERE id = $1`, [C.pat]);
    await migrator.query(`UPDATE core.customers SET cognito_sub = NULL WHERE id = $1`, [C.pat]);
    await api(app, employee(U.lia)).post(`/api/customers/${C.pat}/invite`, { channel: 'whatsapp' }).expect(400);
    await migrator.query(`UPDATE core.customers SET whatsapp_opt_in_at = now() WHERE id = $1`, [C.pat]);
    await api(app, employee(U.lia)).post(`/api/customers/${C.pat}/invite`, { channel: 'whatsapp' }).expect(200);
    expect(sender.last()).toMatchObject({ channel: 'whatsapp', to: '+13105550106', whatsapp: { template: 'joybot_invite', bodyParams: ['Pat', expect.stringContaining('/portal/invite?token=')] } });
  });

  it('staff cannot invite customers outside their scope or who already have an account', async () => {
    await api(app, employee(U.sam)).post(`/api/customers/${C.john}/invite`, { channel: 'email' }).expect(404);
    await api(app, employee(U.sam)).post(`/api/customers/${C.pat}/invite`, { channel: 'email' }).expect(404); // read grant only
    await migrator.query(`UPDATE core.customers SET cognito_sub = 'sub-maria' WHERE id = $1`, [C.maria]);
    await api(app, employee(U.sam)).post(`/api/customers/${C.maria}/invite`, { channel: 'email' }).expect(400);
    await api(app, customer(C.maria)).post(`/api/customers/${C.maria}/invite`, { channel: 'email' }).expect(403);
  });

  it('org admins add and remove members; members cannot', async () => {
    const res = await api(app, customer(C.john)).post('/api/org/invites', { first_name: 'Ana', last_name: 'New', email: 'ana@acme.example' }).expect(201);
    expect(res.body).toMatchObject({ sent: true, channel: 'email' });
    const ana = (await migrator.query('SELECT organization_id, org_role, source FROM core.customers WHERE id = $1', [res.body.member_id])).rows[0];
    expect(ana).toEqual({ organization_id: O.acme, org_role: 'member', source: 'org_admin' });

    const phoneOnly = await api(app, customer(C.john)).post('/api/org/invites', { first_name: 'Raj', phone: '+12125550177' }).expect(201);
    expect(phoneOnly.body).toMatchObject({ sent: false });

    await api(app, customer(C.jane)).post('/api/org/invites', { first_name: 'X', email: 'x@acme.example' }).expect(403);
    await api(app, customer(C.jane)).delete(`/api/org/members/${res.body.member_id}`).expect(403);
    await api(app, customer(C.john)).delete(`/api/org/members/${C.john}`).expect(400);
    await api(app, customer(C.john)).delete(`/api/org/members/${C.maria}`).expect(404);
    await api(app, customer(C.john)).delete(`/api/org/members/${res.body.member_id}`).expect(204);
    const removed = (await migrator.query('SELECT organization_id FROM core.customers WHERE id = $1', [res.body.member_id])).rows[0];
    expect(removed.organization_id).toBeNull();
  });
});
