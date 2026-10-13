import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MESSAGE_SENDER, type MessageSender, type OutgoingMessage } from '../src/messaging/messaging.service';
import { api, createApp, customer, employee } from './app';

const { customers: C, users: U } = SAMPLE;

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

/** No sign-in: what any visitor gets. */
const visitor = () => request(app.getHttpServer());
const DAY = 86_400_000;
const range = (days = 14) => `from=${new Date().toISOString()}&to=${new Date(Date.now() + days * DAY).toISOString()}`;
const slots = async (days = 14) => (await visitor().get(`/api/site/sales-call?${range(days)}`).expect(200)).body.slots as string[];
const book = (start: string, name = 'Pat Prospect', email = 'pat@example.com', extra: object = {}) =>
  visitor().post('/api/site/sales-call').send({ name, email, start, time_zone: 'America/Chicago', phone: '+1 555 010 0100', ...extra });

/** Wall-clock weekday and time in the business's time zone (the test settings: New York). */
const local = (iso: string) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { weekday: get('weekday'), time: `${get('hour')}:${get('minute')}` };
};

describe('sales calls: open times', () => {
  it('half hours on weekdays from 9:00 to 16:30 in the business time zone, at least two hours ahead', async () => {
    const res = (await visitor().get(`/api/site/sales-call?${range()}`).expect(200)).body as { event: { title: string; duration_minutes: number }; slots: string[] };
    expect(res.event).toEqual({ title: 'Sales call', description: expect.stringContaining('Tell us about your project'), duration_minutes: 30, call_method: 'phone' });
    expect(res.slots.length).toBeGreaterThan(40);
    for (const s of res.slots) {
      const { weekday, time } = local(s);
      expect(['Sat', 'Sun']).not.toContain(weekday);
      expect(time >= '09:00' && time <= '16:30' && /:(00|30)$/.test(time)).toBe(true);
      expect(Date.parse(s)).toBeGreaterThanOrEqual(Date.now() + 2 * 3_600_000 - 60_000);
    }
  });

  it('validates the range', async () => {
    await visitor().get('/api/site/sales-call').expect(400);
    await visitor().get(`/api/site/sales-call?from=${new Date().toISOString()}&to=${new Date(Date.now() + 60 * DAY).toISOString()}`).expect(400);
  });
});

describe('sales calls: booking', () => {
  it('a visitor books an open time with name and email; it is saved, confirmed by email and no longer open', async () => {
    const [start] = await slots();
    const sent = sender.sent.length;
    const res = (await book(start, '  Pat Prospect ', 'Pat@Example.com', { notes: 'Need a booking site' }).expect(201)).body;
    expect(res).toMatchObject({ starts_at: start, event: { title: 'Sales call' } });
    expect(Date.parse(res.ends_at) - Date.parse(start)).toBe(30 * 60_000);
    const toVisitor = sender.sent.slice(sent).filter((m) => m.template === 'sales_call'); // admins are emailed too
    expect(toVisitor).toMatchObject([{ template: 'sales_call', to: 'pat@example.com' }]); // as saved
    expect(toVisitor[0].text).toContain('(America/Chicago)');

    expect(await slots()).not.toContain(start);
    await book(start, 'Someone Else', 'else@example.com').expect(400); // taken

    const calls = (await api(app, employee(U.ada)).get('/api/website/sales-calls').expect(200)).body as { items: Record<string, unknown>[]; total: number };
    expect(calls.total).toBe(1);
    expect(calls.items).toMatchObject([{ id: res.id, name: 'Pat Prospect', email: 'pat@example.com', time_zone: 'America/Chicago', notes: 'Need a booking site', status: 'confirmed' }]);
  });

  it('rejects times outside the open hours and bad input', async () => {
    const open = await slots();
    const friday = open.map((s) => new Date(s)).find((d) => local(d.toISOString()).weekday === 'Fri')!;
    await book(new Date(friday.getTime() + 2 * DAY).toISOString()).expect(400); // the Sunday after
    await book(new Date(Date.parse(open[1]) + 10 * 60_000).toISOString()).expect(400); // not on the half hour
    await book(new Date(Date.now() - DAY).toISOString()).expect(400);
    await book(open[1], 'Pat', 'not-an-email').expect(400);
    await book(open[1], '', 'pat@example.com').expect(400);
    await book(open[1], 'Pat', 'pat@example.com', { customer_id: C.maria }).expect(400);
  });

  it('at most two upcoming calls per email', async () => {
    const open = await slots();
    await book(open[2], 'Sam Lead', 'sam.lead@example.com').expect(201);
    await book(open[4], 'Sam Lead', 'SAM.LEAD@example.com').expect(201);
    const third = await book(open[6], 'Sam Lead', 'sam.lead@example.com').expect(400);
    expect(third.body.message).toMatch(/already have calls booked/);
  });
});

describe('sales calls: setup', () => {
  it('staff who may read the website see the setup; those who may update it change title, text and length (no fixed meeting link)', async () => {
    await api(app, employee(U.sam)).get('/api/website/sales-call-settings').expect(403);
    await api(app, employee(U.sam)).put('/api/website/sales-call-settings', { title: 'x' }).expect(403);
    expect((await api(app, employee(U.ada)).get('/api/website/sales-call-settings').expect(200)).body).toMatchObject({ title: 'Sales call', duration_minutes: 30 });

    const saved = (await api(app, employee(U.ada))
      .put('/api/website/sales-call-settings', { title: 'Discovery call', description: 'Let us talk.', duration_minutes: 60 })
      .expect(200)).body;
    expect(saved).toMatchObject({ title: 'Discovery call', description: 'Let us talk.', duration_minutes: 60 });
    expect(saved).not.toHaveProperty('meeting_url');

    // The page shows the new event (no Meet links set up, so callbacks), and hour-long calls end by 17:00.
    const res = (await visitor().get(`/api/site/sales-call?${range()}`).expect(200)).body as { event: Record<string, unknown>; slots: string[] };
    expect(res.event).toEqual({ title: 'Discovery call', description: 'Let us talk.', duration_minutes: 60, call_method: 'phone' });
    expect(res.slots.map((t) => local(t).time)).not.toContain('16:30');
    expect(res.slots.map((t) => local(t).time)).toContain('16:00');

    // A callback: the confirmation says who calls which number; the call lasts an hour.
    const booked = (await book(res.slots[0], 'Lee Long', 'lee@example.com').expect(201)).body;
    expect(Date.parse(booked.ends_at) - Date.parse(booked.starts_at)).toBe(60 * 60_000);
    const toLee = sender.sent.findLast((m) => m.to === 'lee@example.com')!;
    expect(toLee).toMatchObject({ subject: expect.stringContaining('Discovery call') });
    expect(toLee.text).toMatch(/will call you on \+1 555 010 0100 at that time\./);
    // A half-hour start inside it is taken too.
    expect(await slots()).not.toContain(new Date(Date.parse(res.slots[0]) + 30 * 60_000).toISOString());
    await api(app, employee(U.ada)).post(`/api/website/sales-calls/${booked.id}/cancel`).expect(200);

    await api(app, employee(U.ada)).put('/api/website/sales-call-settings', { duration_minutes: 25 }).expect(400);
    await api(app, employee(U.ada)).put('/api/website/sales-call-settings', { meeting_url: 'https://meet.example.com/appjoy' }).expect(400); // gone
    await api(app, employee(U.ada)).put('/api/website/sales-call-settings', { title: '' }).expect(400);
    await api(app, employee(U.ada)).put('/api/website/sales-call-settings', {}).expect(400);
    // Back to the defaults for the tests below.
    await api(app, employee(U.ada)).put('/api/website/sales-call-settings', { title: 'Sales call', duration_minutes: 30 }).expect(200);
  });

  it('how calls are handled: video meetings fall back to a callback number until meeting links are set up', async () => {
    const s = (await api(app, employee(U.ada)).get('/api/website/sales-call-settings').expect(200)).body;
    expect(s).toMatchObject({ call_method: 'video', meet_ready: false });
    // Video chosen, but no Google account: the page asks for a number.
    expect((await visitor().get(`/api/site/sales-call?${range()}`).expect(200)).body.event.call_method).toBe('phone');
    const open = await slots();
    const noPhone = await book(open[0], 'No Phone', 'nophone@example.com', { phone: undefined }).expect(400);
    expect(noPhone.body.message).toContain('phone number');
    await book(open[0], 'Bad Phone', 'badphone@example.com', { phone: 'call me maybe' }).expect(400);

    await api(app, employee(U.ada)).put('/api/website/sales-call-settings', { call_method: 'fax' }).expect(400);
    await api(app, employee(U.sam)).put('/api/website/sales-call-settings', { call_method: 'phone' }).expect(403);
    expect((await api(app, employee(U.ada)).put('/api/website/sales-call-settings', { call_method: 'phone' }).expect(200)).body.call_method).toBe('phone');

    // The number is kept on the call, shown to staff, searchable, and in the admin email and invite.
    const before = sender.sent.length;
    const call = (await book(open[0], 'Pho Ne', 'phone@example.com', { phone: ' +1 (555) 010-0300 ' }).expect(201)).body as { id: string };
    const listed = (await api(app, employee(U.ada)).get('/api/website/sales-calls?q=010-0300').expect(200)).body.items as { id: string; phone: string; meeting_url: string | null }[];
    expect(listed).toEqual([expect.objectContaining({ id: call.id, phone: '+1 (555) 010-0300', meeting_url: null })]);
    const toAdmin = sender.sent.slice(before).find((m) => m.template === 'sales_call_admin');
    if (toAdmin) expect(toAdmin.text).toContain('Call them back on: +1 (555) 010-0300');
    await api(app, employee(U.ada)).post(`/api/website/sales-calls/${call.id}/cancel`).expect(200);

    await api(app, employee(U.ada)).put('/api/website/sales-call-settings', { call_method: 'video' }).expect(200);
  });
});

describe('sales calls: rescheduling', () => {
  it('staff who may update the website move a call to another open time; the visitor is emailed', async () => {
    const open = await slots();
    const call = (await book(open[8], 'Rae Move', 'rae@example.com').expect(201)).body as { id: string };
    await api(app, employee(U.sam)).post(`/api/website/sales-calls/${call.id}/reschedule`, { start: open[12] }).expect(403);

    const sent = sender.sent.length;
    const moved = (await api(app, employee(U.ada)).post(`/api/website/sales-calls/${call.id}/reschedule`, { start: open[12] }).expect(200)).body;
    expect(moved).toMatchObject({ id: call.id, starts_at: open[12], status: 'confirmed' });
    expect(Date.parse(moved.ends_at) - Date.parse(open[12])).toBe(30 * 60_000);
    expect(sender.sent.slice(sent)).toMatchObject([{ to: 'rae@example.com', subject: expect.stringMatching(/^New time: /) }]);
    const freed = await slots();
    expect(freed).toContain(open[8]);
    expect(freed).not.toContain(open[12]);

    // Its own time is fine (a few minutes' move within it is not a start time, though).
    await api(app, employee(U.ada)).post(`/api/website/sales-calls/${call.id}/reschedule`, { start: open[12], notify: false }).expect(200);
    expect(sender.sent.length).toBe(sent + 1);
    // Not onto another call, outside the hours, or a cancelled call.
    const other = (await book(open[14], 'Other Lead', 'other@example.com').expect(201)).body as { id: string };
    await api(app, employee(U.ada)).post(`/api/website/sales-calls/${call.id}/reschedule`, { start: open[14] }).expect(400);
    await api(app, employee(U.ada)).post(`/api/website/sales-calls/${call.id}/reschedule`, { start: new Date(Date.parse(open[12]) + 10 * 60_000).toISOString() }).expect(400);
    await api(app, employee(U.ada)).post(`/api/website/sales-calls/${other.id}/cancel`).expect(200);
    await api(app, employee(U.ada)).post(`/api/website/sales-calls/${other.id}/reschedule`, { start: open[16] }).expect(404);
    await api(app, employee(U.ada)).post(`/api/website/sales-calls/${call.id}/cancel`).expect(200);
  });
});

describe('sales calls: staff', () => {
  it('those who read the website list them; others cannot; cancelling frees the time', async () => {
    await visitor().get('/api/website/sales-calls').expect(401);
    await api(app, employee(U.sam)).get('/api/website/sales-calls').expect(403);
    await api(app, customer(C.maria)).get('/api/website/sales-calls').expect(403);
    expect((await api(app, employee(U.ada)).get('/api/website/sales-calls?when=past').expect(200)).body).toEqual({ items: [], total: 0 });

    const call = ((await api(app, employee(U.ada)).get('/api/website/sales-calls').expect(200)).body.items as { id: string; starts_at: string; status: string }[]).find((c) => c.status === 'confirmed')!;
    await api(app, employee(U.sam)).post(`/api/website/sales-calls/${call.id}/cancel`).expect(403);
    expect((await api(app, employee(U.ada)).post(`/api/website/sales-calls/${call.id}/cancel`).expect(200)).body.status).toBe('cancelled');
    await api(app, employee(U.ada)).post(`/api/website/sales-calls/${call.id}/cancel`).expect(404);
    expect((await api(app, employee(U.ada)).get(`/api/website/sales-calls/${call.id}`).expect(200)).body).toMatchObject({ id: call.id, status: 'cancelled' });
    await api(app, employee(U.sam)).get(`/api/website/sales-calls/${call.id}`).expect(403);
    await api(app, employee(U.ada)).get('/api/website/sales-calls/00000000-0000-4000-8000-000000000000').expect(404);
    expect(await slots()).toContain(new Date(call.starts_at).toISOString());
  });

  it('searches by name, email or notes, a page at a time with the total', async () => {
    const list = (q: string) => api(app, employee(U.ada)).get(`/api/website/sales-calls?${q}`).expect(200).then((r) => r.body as { items: { name: string; email: string }[]; total: number });
    const all = await list('');
    expect(all.total).toBeGreaterThanOrEqual(5);
    expect((await list('q=sam.lead')).items.map((c) => c.email)).toEqual(['sam.lead@example.com', 'sam.lead@example.com']);
    expect((await list('q=BOOKING%20SITE')).items.map((c) => c.name)).toEqual(['Pat Prospect']); // notes, any case
    expect(await list('q=100%25')).toEqual({ items: [], total: 0 }); // % is a character, not a wildcard
    const first = await list('limit=2');
    const second = await list('limit=2&offset=2');
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(all.total);
    expect(second.items[0]).not.toEqual(first.items[0]);
    await api(app, employee(U.ada)).get('/api/website/sales-calls?limit=500').expect(400);
    await api(app, employee(U.ada)).get('/api/website/sales-calls?when=soon').expect(400);
  });

  it('the booking page address cannot be used by a site page', async () => {
    await api(app, employee(U.ada)).post('/api/website/pages', { slug: 'book-a-call', title: 'Book' }).expect(400);
  });
});

describe('sales calls: general hours and hosts', () => {
  const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, starts: '09:00', ends: '17:00' }));
  const admin = () => api(app, employee(U.ada));
  type Call = { id: string; assigned_to: string | null; assigned_to_name: string | null; starts_at: string };
  const callById = async (id: string) =>
    ((await admin().get('/api/website/sales-calls?limit=100').expect(200)).body.items as Call[]).find((c) => c.id === id)!;

  afterAll(async () => {
    await admin().put('/api/website/sales-call-settings', { hours: WEEKDAYS_9_TO_5, host_ids: [] }).expect(200);
  });

  it('open times follow the general hours', async () => {
    const saved = (await admin()
      .put('/api/website/sales-call-settings', { hours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, starts: '10:00', ends: '12:00' })) })
      .expect(200)).body;
    expect(saved.hours).toHaveLength(5);
    expect(saved.hours[0]).toEqual({ weekday: 1, starts: '10:00', ends: '12:00' });
    const times = new Set((await slots()).map((t) => local(t).time));
    expect([...times].sort()).toEqual(['10:00', '10:30', '11:00', '11:30']);

    // A Saturday morning too.
    await admin().put('/api/website/sales-call-settings', { hours: [...saved.hours, { weekday: 6, starts: '09:00', ends: '10:00' }] }).expect(200);
    expect((await slots()).some((t) => local(t).weekday === 'Sat')).toBe(true);

    await admin().put('/api/website/sales-call-settings', { hours: [{ weekday: 1, starts: '10:10', ends: '12:00' }] }).expect(400);
    await admin().put('/api/website/sales-call-settings', { hours: [{ weekday: 1, starts: '12:00', ends: '10:00' }] }).expect(400);
    await admin()
      .put('/api/website/sales-call-settings', { hours: [{ weekday: 1, starts: '09:00', ends: '12:00' }, { weekday: 1, starts: '11:00', ends: '13:00' }] })
      .expect(400);
    // No hours: nothing to book.
    await admin().put('/api/website/sales-call-settings', { hours: [] }).expect(200);
    expect(await slots()).toEqual([]);
    await admin().put('/api/website/sales-call-settings', { hours: WEEKDAYS_9_TO_5 }).expect(200);
  });

  it('with hosts, a call goes to a free host (fewest upcoming calls first); a time stays open while anyone is free', async () => {
    await admin().put('/api/website/sales-call-settings', { host_ids: [U.lia, 'not-a-uuid'] }).expect(400);
    await admin().put('/api/website/sales-call-settings', { host_ids: [C.maria] }).expect(400); // not staff
    const saved = (await admin().put('/api/website/sales-call-settings', { host_ids: [U.sam, U.lia] }).expect(200)).body;
    expect(saved.host_ids).toEqual([U.sam, U.lia]);
    expect(saved.staff.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining([U.ada, U.sam, U.lia]));

    const open = (await slots()).filter((t) => local(t).weekday !== 'Fri');
    const [a, b, c] = [open[20], open[24], open[28]];
    const first = (await book(a, 'Host One', 'host1@example.com').expect(201)).body as { id: string };
    const sent = sender.sent.findLast((m) => m.to === 'host1@example.com')!;
    expect(sent.text).toContain('Sam Staff');
    const second = (await book(a, 'Host Two', 'host2@example.com').expect(201)).body as { id: string }; // same time, other host
    expect((await callById(first.id)).assigned_to).toBe(U.sam);
    expect(await callById(second.id)).toMatchObject({ assigned_to: U.lia, assigned_to_name: 'Lia Staff' });
    expect(await slots()).not.toContain(a); // both busy now
    await book(a, 'Host Three', 'host3@example.com').expect(400);

    // Lia's time off at b: b goes to Sam, then closes.
    await admin().post(`/api/staff/${U.lia}/time-off`, { starts_at: b, ends_at: new Date(Date.parse(b) + 60 * 60_000).toISOString(), reason: 'Dentist' }).expect(201);
    const third = (await book(b, 'Host Four', 'host4@example.com').expect(201)).body as { id: string };
    expect((await callById(third.id)).assigned_to).toBe(U.sam);
    expect(await slots()).not.toContain(b);

    // Reassigning: only to someone free then; anyone active (not just hosts); or nobody.
    await admin().put(`/api/website/sales-calls/${first.id}/assign`, { user_id: U.lia }).expect(400); // Lia has the other call at a
    expect((await admin().put(`/api/website/sales-calls/${first.id}/assign`, { user_id: U.ada }).expect(200)).body).toMatchObject({ assigned_to: U.ada, assigned_to_name: expect.stringContaining('Ada') });
    expect((await admin().put(`/api/website/sales-calls/${first.id}/assign`, { user_id: null }).expect(200)).body.assigned_to).toBeNull();
    await api(app, employee(U.sam)).put(`/api/website/sales-calls/${first.id}/assign`, { user_id: U.sam }).expect(403);

    // Rescheduling keeps the host when they are free at the new time.
    expect((await admin().post(`/api/website/sales-calls/${second.id}/reschedule`, { start: c, notify: false }).expect(200)).body).toMatchObject({ starts_at: c, assigned_to: U.lia });
    for (const id of [first.id, second.id, third.id]) await admin().post(`/api/website/sales-calls/${id}/cancel`).expect(200);
  });
});

describe('sales calls: flooding', () => {
  it('at most ten new bookings an hour in all', async () => {
    const open = (await slots(30)).slice(40);
    // Calls booked above count too (cancelled or not): book until the limit.
    let refused: request.Response | undefined;
    for (let i = 0; i < 10 && !refused; i++) {
      const res = await book(open[i * 2], `Lead ${i}`, `lead${i}@example.com`);
      if (res.status !== 201) refused = res;
    }
    expect(refused?.status).toBe(400);
    expect(refused?.body.message).toMatch(/try again later/);
  });
});
