import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import path from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MESSAGE_SENDER, type MessageSender, type OutgoingMessage } from '../src/messaging/messaging.service';
import { api, createApp, employee } from './app';

const { users: U } = SAMPLE;

class CapturingSender implements MessageSender {
  sent: OutgoingMessage[] = [];
  async send(m: OutgoingMessage) {
    this.sent.push(m);
    return {};
  }
}

const sender = new CapturingSender();
let app: INestApplication;
beforeAll(async () => {
  app = await createApp({ overrides: [{ token: MESSAGE_SENDER, value: sender }] });
});
afterAll(async () => {
  await app.close();
});

const admin = () => api(app, employee(U.ada));
const visitor = () => request(app.getHttpServer());
type Template = { id: string; kind: string; name: string; subject: string; body: string };
const templates = async (kind: string) => (await admin().get(`/api/website/email-templates?kind=${kind}`).expect(200)).body as Template[];

async function book(name: string, email: string, days: number) {
  const from = new Date(Date.now() + days * 86_400_000).toISOString();
  const to = new Date(Date.now() + (days + 10) * 86_400_000).toISOString();
  const [start] = (await visitor().get(`/api/site/sales-call?from=${from}&to=${to}`).expect(200)).body.slots as string[];
  return (await visitor().post('/api/site/sales-call').send({ name, email, start, time_zone: 'America/Chicago' }).expect(201)).body as { id: string };
}

describe('sales call email templates', () => {
  it('start with a confirmation and three thank-you presets, for those who may read the website', async () => {
    expect((await templates('sales_call_confirmation')).map((t) => t.name)).toEqual(['Confirmation']);
    expect((await templates('sales_call_thank_you')).map((t) => t.name)).toEqual(['Thanks for your time', 'Next steps', 'Sorry we missed you']);
    await api(app, employee(U.sam)).get('/api/website/email-templates?kind=sales_call_thank_you').expect(403);
    await admin().get('/api/website/email-templates?kind=invoice').expect(400);
  });

  it('the confirmation is edited (known placeholders only) and sent when someone books', async () => {
    const [confirmation] = await templates('sales_call_confirmation');
    await admin().put(`/api/website/email-templates/${confirmation.id}`, { body: 'Hi {{nickname}}' }).expect(400);
    await api(app, employee(U.sam)).put(`/api/website/email-templates/${confirmation.id}`, { subject: 'x' }).expect(403);
    await admin()
      .put(`/api/website/email-templates/${confirmation.id}`, { subject: 'See you {{date}}, {{first_name}}', body: 'Hi {{first_name}},\n\n{{call_title}} at {{time}} ({{time_zone}}).\n{{meeting_details}}\nAnother time? {{booking_link}}' })
      .expect(200);

    const before = sender.sent.length;
    await book('Robin Lee', 'robin@example.com', 3);
    const mail = sender.sent.slice(before).find((m) => m.to === 'robin@example.com')!;
    expect(mail).toMatchObject({ template: 'sales_call', to: 'robin@example.com', subject: expect.stringMatching(/^See you \w+day, \w+ \d+, 2\d{3}, Robin$/) });
    expect(mail.text).toMatch(/^Hi Robin,\n\nSales call at \d+:\d\d [AP]M \(America\/Chicago\)\.\nWe'll send the meeting details before the call\.\nAnother time\? http.*\/book-a-call$/);
    expect(mail.text).not.toContain('{{');
  });

  it('thank-you presets are added, renamed and deleted; the confirmation cannot be deleted', async () => {
    const preset = (await admin().post('/api/website/email-templates', { name: 'Proposal attached', subject: 'Your proposal, {{first_name}}', body: 'Hi {{first_name}}, here it is.' }).expect(201)).body as Template;
    expect(preset.kind).toBe('sales_call_thank_you');
    await admin().post('/api/website/email-templates', { name: 'Proposal attached', subject: 'x', body: 'y' }).expect(409);
    await admin().post('/api/website/email-templates', { name: 'Bad', subject: '{{price}}', body: 'y' }).expect(400);
    expect((await admin().put(`/api/website/email-templates/${preset.id}`, { name: 'Proposal' }).expect(200)).body.name).toBe('Proposal');
    await admin().delete(`/api/website/email-templates/${preset.id}`).expect(204);
    const [confirmation] = await templates('sales_call_confirmation');
    await admin().delete(`/api/website/email-templates/${confirmation.id}`).expect(404);
  });

  it('previews fill the placeholders for a sample call or a real one', async () => {
    const sample = (await admin().post('/api/website/email-templates/preview', { subject: 'Hi {{first_name}}', body: '{{host_name}} · {{duration}} min · {{site_name}}' }).expect(200)).body;
    expect(sample.subject).toBe('Hi Pat');
    expect(sample.body).toMatch(/^Ada \S+ · 30 min · /);
    await admin().post('/api/website/email-templates/preview', { subject: 'x', body: '{{oops}}' }).expect(400);

    const call = await book('Sam Visitor', 'samv@example.com', 5);
    const real = (await admin().post('/api/website/email-templates/preview', { subject: 'Thanks {{first_name}}', body: '{{name}}', call_id: call.id }).expect(200)).body;
    expect(real).toEqual({ subject: 'Thanks Sam', body: 'Sam Visitor' });
  });
});

describe('sending a thank-you', () => {
  it('emails the visitor the (edited) preset and records it on the call', async () => {
    const call = await book('Jordan Park', 'jordan@example.com', 7);
    const [preset] = await templates('sales_call_thank_you');
    await api(app, employee(U.sam)).post(`/api/website/sales-calls/${call.id}/thank-you`, { subject: 'x', body: 'y' }).expect(403);

    const before = sender.sent.length;
    const res = (await admin()
      .post(`/api/website/sales-calls/${call.id}/thank-you`, { template_id: preset.id, subject: preset.subject, body: `${preset.body}\n\nP.S. Loved the idea, {{first_name}}.` })
      .expect(200)).body;
    expect(res.thank_you_sent_at).toEqual(expect.any(String));
    const mail = sender.sent.slice(before)[0];
    expect(mail).toMatchObject({ template: 'sales_call_thank_you', to: 'jordan@example.com', subject: 'Thanks for talking with us, Jordan' });
    expect(mail.text).toContain('P.S. Loved the idea, Jordan.');
    expect(mail.text).not.toContain('{{');

    const listed = (await admin().get('/api/website/sales-calls?limit=100').expect(200)).body.items as { id: string; thank_you_sent_at: string | null }[];
    expect(listed.find((c) => c.id === call.id)?.thank_you_sent_at).toEqual(expect.any(String));

    await admin().post(`/api/website/sales-calls/${call.id}/thank-you`, { subject: 'x', body: '{{nope}}' }).expect(400);
    await admin().post(`/api/website/sales-calls/${call.id}/cancel`).expect(200);
    await admin().post(`/api/website/sales-calls/${call.id}/thank-you`, { subject: 'x', body: 'y' }).expect(404); // cancelled
  });
});

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

/** The bodies of an employee's JoyBot notifications, newest first. */
const notifications = (user: string) =>
  asOwner<{ body: string; link: string }>(
    `SELECT m.body, m.link FROM app.team_messages m JOIN app.team_channels c ON c.id = m.channel_id
      WHERE c.kind = 'notifications' AND c.owner_id = $1 ORDER BY m.created_at DESC`,
    [user],
  );

describe('admins hear about new bookings', () => {
  it('a JoyBot notification and an email with an add-to-calendar invite to every admin', async () => {
    expect((await admin().get('/api/website/sales-call-settings').expect(200)).body.email_admins).toBe(true);
    const before = sender.sent.length;
    const call = await book('Casey Notify', 'casey@example.com', 9);

    const [note] = await notifications(U.ada);
    expect(note).toMatchObject({ body: expect.stringMatching(/^New sales call booked: Casey Notify, .+ \(no host yet\)$/), link: `/staff/sales-calls?call=${call.id}` });
    expect(await notifications(U.sam)).not.toContainEqual(expect.objectContaining({ link: `/staff/sales-calls?call=${call.id}` })); // staff: no

    const toAda = sender.sent.slice(before).find((m) => m.template === 'sales_call_admin');
    expect(toAda).toMatchObject({ to: 'ada@example.com', subject: expect.stringMatching(/^New sales call: Casey Notify, /) });
    expect(toAda!.text).toContain('casey@example.com');
    expect(toAda!.text).toMatch(/Google Calendar: https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);
    expect(toAda!.text).toContain(`/staff/sales-calls?call=${call.id}`);
    const [invite] = toAda!.attachments!;
    expect(invite).toMatchObject({ filename: 'sales-call.ics', contentType: expect.stringContaining('text/calendar') });
    expect(invite.content).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(invite.content).toContain('SUMMARY:Sales call: Casey Notify');
    expect(invite.content).toMatch(/DTSTART:\d{8}T\d{6}Z\r\n/);
    expect(invite.content).toContain(`UID:sales-call-${call.id}@joybot`);
    // The visitor still gets their confirmation, without the invite.
    expect(sender.sent.slice(before).find((m) => m.to === 'casey@example.com')).toMatchObject({ template: 'sales_call' });
    expect(sender.sent.slice(before).find((m) => m.to === 'casey@example.com')?.attachments).toBeUndefined();
  });

  it('the email can be turned off in the setup (the notification stays)', async () => {
    await api(app, employee(U.sam)).put('/api/website/sales-call-settings', { email_admins: false }).expect(403);
    expect((await admin().put('/api/website/sales-call-settings', { email_admins: false }).expect(200)).body.email_admins).toBe(false);
    const before = sender.sent.length;
    const call = await book('Quiet Booking', 'quiet@example.com', 11);
    expect(sender.sent.slice(before).filter((m) => m.template === 'sales_call_admin')).toEqual([]);
    expect((await notifications(U.ada))[0].link).toBe(`/staff/sales-calls?call=${call.id}`);
    await admin().put('/api/website/sales-call-settings', { email_admins: true }).expect(200);
  });

  it("an admin who hosts the call gets the host's notice instead of a second one", async () => {
    await admin().put('/api/website/sales-call-settings', { host_ids: [U.ada] }).expect(200);
    const call = await book('Host Admin', 'hostadmin@example.com', 13);
    const mine = (await notifications(U.ada)).filter((n) => n.link?.includes(call.id) || n.body.includes('Host Admin'));
    expect(mine).toHaveLength(1);
    expect(mine[0].body).toMatch(/^New appointment for you: Sales call with Host Admin/);
    await admin().put('/api/website/sales-call-settings', { host_ids: [] }).expect(200);
  });
});
