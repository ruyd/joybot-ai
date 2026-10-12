import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
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

type Ticket = { id: string; subject: string; status: string; priority: string; customer_id: string; assigned_to: string | null; assigned_to_name: string | null };
type Detail = Ticket & { messages: { body: string; from: string; internal: boolean; author_name: string | null }[] };
const ids = (list: Ticket[]) => list.map((t) => t.id).sort();

describe('tickets: seen by the right people', () => {
  it('customers see their own tickets; org admins also their organization’s', async () => {
    expect(ids((await api(app, customer(C.maria)).get('/api/tickets').expect(200)).body)).toEqual(['5001', '5002']);
    expect(ids((await api(app, customer(C.john)).get('/api/tickets?scope=org').expect(200)).body)).toEqual(['5003', '5004']);
    expect(ids((await api(app, customer(C.jane)).get('/api/tickets?scope=org').expect(200)).body)).toEqual(['5004']); // members: only their own
    await api(app, customer(C.maria)).get('/api/tickets/5003').expect(404);
    await api(app, customer(C.maria)).get('/api/tickets/not-a-number').expect(404);
  });

  it('staff see tickets of customers in their scope; internal notes only for staff', async () => {
    expect(ids((await api(app, employee(U.sam)).get(`/api/tickets?customer_id=${C.maria}`).expect(200)).body)).toEqual(['5001', '5002']);
    expect((await api(app, employee(U.lia)).get(`/api/tickets?customer_id=${C.maria}`).expect(200)).body).toEqual([]); // LA staff
    await api(app, employee(U.lia)).get('/api/tickets/5001').expect(404);

    const staff = (await api(app, employee(U.sam)).get('/api/tickets/5001').expect(200)).body as Detail;
    expect(staff.messages.map((m) => m.internal)).toEqual([false, false, true]);
    const own = (await api(app, customer(C.maria)).get('/api/tickets/5001').expect(200)).body as Detail;
    expect(own.messages.map((m) => m.body)).not.toContain('Internal: refund approved, waiting on POS reversal.');
    expect(own.messages).toHaveLength(2);
  });

  it('the staff inbox lists every ticket in scope, filtered by status and assignee', async () => {
    const all = ids((await api(app, employee(U.ada)).get('/api/tickets').expect(200)).body);
    expect(all).toEqual(expect.arrayContaining(['5001', '5002', '5003', '5004', '5006']));
    expect(ids((await api(app, employee(U.ada)).get('/api/tickets?status=closed').expect(200)).body)).toEqual(['5004']);
    expect((await api(app, employee(U.ada)).get('/api/tickets?assigned=me').expect(200)).body).toEqual([]);
    await api(app, employee(U.ada)).get('/api/tickets?status=lost').expect(400);
    const assignees = (await api(app, employee(U.sam)).get('/api/tickets/assignees').expect(200)).body as { id: string }[];
    expect(assignees.map((s) => s.id)).toEqual(expect.arrayContaining([U.ada, U.sam, U.lia]));
    await api(app, customer(C.maria)).get('/api/tickets/assignees').expect(403);
  });
});

describe('tickets: the conversation', () => {
  it('a customer opens a ticket; staff reply (emailed), add a note, assign; the customer replies and resolves it', async () => {
    const created = (await api(app, customer(C.maria)).post('/api/tickets', { subject: 'Gift card', message: 'Can I buy a gift card?' }).expect(201)).body as Detail;
    expect(created).toMatchObject({ subject: 'Gift card', status: 'open', priority: 'medium', customer_id: C.maria });
    expect(created.messages).toMatchObject([{ body: 'Can I buy a gift card?', from: 'customer' }]);
    expect(Number(created.id)).toBeGreaterThan(5006);
    const n = created.id;

    expect(ids((await api(app, employee(U.sam)).get('/api/tickets?status=open').expect(200)).body)).toContain(n);

    const sent = sender.sent.length;
    const replied = (await api(app, employee(U.sam)).post(`/api/tickets/${n}/messages`, { body: 'Yes, at the front desk.' }).expect(201)).body as Detail;
    expect(replied.status).toBe('pending'); // waiting on the customer now
    expect(sender.sent.slice(sent)).toMatchObject([{ template: 'ticket', to: 'maria@example.com', subject: `[#${n}] Gift card` }]);

    await api(app, employee(U.sam)).post(`/api/tickets/${n}/messages`, { body: 'She is a regular.', internal: true }).expect(201);
    expect(sender.sent.length).toBe(sent + 1); // notes are not emailed
    await api(app, employee(U.sam)).post(`/api/tickets/${n}/messages`, { body: 'Quiet reply', notify: false }).expect(201);
    expect(sender.sent.length).toBe(sent + 1);

    const assigned = (await api(app, employee(U.sam)).put(`/api/tickets/${n}`, { assigned_to: U.sam, priority: 'high' }).expect(200)).body as Detail;
    expect(assigned).toMatchObject({ assigned_to: U.sam, assigned_to_name: 'Sam Staff', priority: 'high' });
    expect(ids((await api(app, employee(U.sam)).get('/api/tickets?assigned=me').expect(200)).body)).toEqual([n]);

    const seen = (await api(app, customer(C.maria)).get(`/api/tickets/${n}`).expect(200)).body as Detail;
    expect(seen.messages.map((m) => m.from)).toEqual(['customer', 'support', 'support']); // no internal note

    const reopened = (await api(app, customer(C.maria)).post(`/api/tickets/${n}/messages`, { body: 'Thanks! One more question.' }).expect(201)).body as Detail;
    expect(reopened.status).toBe('open');
    expect((await api(app, customer(C.maria)).put(`/api/tickets/${n}`, { status: 'resolved' }).expect(200)).body.status).toBe('resolved');
  });

  it('staff open tickets for customers in scope only', async () => {
    const t = (await api(app, employee(U.sam)).post('/api/tickets', { subject: 'Called about parking', message: 'Asked by phone.', customer_id: C.jane, notify: false }).expect(201)).body as Detail;
    expect(t).toMatchObject({ status: 'open', customer_id: C.jane });
    await api(app, employee(U.lia)).post('/api/tickets', { subject: 'x', message: 'y', customer_id: C.maria }).expect(403);
    await api(app, employee(U.sam)).post('/api/tickets', { subject: 'x', message: 'y' }).expect(400); // whose?
  });

  it('customers cannot set priority, assign, add notes or touch other tickets', async () => {
    await api(app, customer(C.maria)).post('/api/tickets', { subject: 'x', message: 'y', priority: 'urgent' }).expect(403);
    await api(app, customer(C.maria)).post('/api/tickets', { subject: 'x', message: 'y', customer_id: C.john }).expect(403);
    await api(app, customer(C.maria)).put('/api/tickets/5001', { priority: 'urgent' }).expect(403);
    await api(app, customer(C.maria)).put('/api/tickets/5001', { status: 'open' }).expect(403);
    await api(app, customer(C.maria)).post('/api/tickets/5001/messages', { body: 'x', internal: true }).expect(403);
    await api(app, customer(C.maria)).post('/api/tickets/5003/messages', { body: 'x' }).expect(404);
    await api(app, customer(C.maria)).put('/api/tickets/5003', { status: 'closed' }).expect(404);
  });

  it('validates input', async () => {
    await api(app, customer(C.maria)).post('/api/tickets', { subject: '', message: 'y' }).expect(400);
    await api(app, customer(C.maria)).post('/api/tickets', { subject: 'x', message: 'y', extra: 1 }).expect(400);
    await api(app, employee(U.ada)).put('/api/tickets/5001', {}).expect(400);
    await api(app, employee(U.ada)).put('/api/tickets/5001', { status: 'lost' }).expect(400);
    await api(app, employee(U.ada)).put('/api/tickets/5001', { assigned_to: C.maria }).expect(400); // not staff
    await api(app, employee(U.ada)).post('/api/tickets/5001/messages', { body: ' ' }).expect(400);
  });
});
