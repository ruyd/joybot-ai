import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CheckoutRequest, InvoiceCheckout } from '../src/invoices/checkout';
import { INVOICE_CHECKOUT } from '../src/invoices/checkout';
import { MESSAGE_SENDER, type MessageSender, type OutgoingMessage } from '../src/messaging/messaging.service';
import { api, createApp, customer, employee } from './app';

const { customers: C, services: S, users: U } = SAMPLE;

/** Stripe stand-in: records sessions instead of calling Stripe. */
class FakeCheckout implements InvoiceCheckout {
  enabled = true;
  requests: CheckoutRequest[] = [];
  async available() {
    return this.enabled;
  }
  async create(req: CheckoutRequest) {
    this.requests.push(req);
    return { id: 'cs_test_1', url: 'https://checkout.stripe.test/c/pay/cs_test_1' };
  }
}

class CapturingSender implements MessageSender {
  sent: OutgoingMessage[] = [];
  async send(m: OutgoingMessage) {
    this.sent.push(m);
    return {};
  }
}

const checkout = new FakeCheckout();
const sender = new CapturingSender();
let app: INestApplication;
let migrator: Client;

beforeAll(async () => {
  app = await createApp({ overrides: [{ token: INVOICE_CHECKOUT, value: checkout }, { token: MESSAGE_SENDER, value: sender }] });
  config({ path: path.resolve(__dirname, '../../../.env') });
  migrator = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await migrator.connect();
  await migrator.query('UPDATE core.settings SET stripe_enabled = true WHERE id = 1');
});
afterAll(async () => {
  // Shared database: no invoices, their payments or changed settings left behind.
  await migrator.query('DELETE FROM core.payments WHERE invoice_id IS NOT NULL');
  await migrator.query('DELETE FROM core.invoices'); // lines go with them
  await migrator.query('UPDATE core.settings SET stripe_enabled = false WHERE id = 1');
  await migrator.end();
  await app.close();
});

const draft = (lines = [{ description: 'Haircut', quantity: 2, unit_price: 50, service_id: S.haircut }, { description: 'Hair product', unit_price: 20 }]) =>
  api(app, employee(U.sam)).post('/api/invoices', { customer_id: C.maria, notes: 'Thanks for coming in!', lines });

const cash = (invoiceId: string, amount: number, who: string = U.sam, customerId: string = C.maria) =>
  api(app, employee(who)).post('/api/payments', {
    customer_id: customerId,
    invoice_id: invoiceId,
    method: 'cash',
    amount,
    paid_at: new Date().toISOString(),
    confirm_duplicate: true,
  });

describe('invoices', () => {
  it('staff draft an invoice; the customer sees it only once sent, with an email', async () => {
    const inv = (await draft().expect(201)).body;
    expect(inv).toMatchObject({ status: 'draft', total: '120.00', balance: '120.00', currency: 'USD' });
    expect(inv.invoice_number).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(inv.lines.map((l: { amount: string }) => l.amount)).toEqual(['100.00', '20.00']);

    await api(app, customer(C.maria)).get(`/api/invoices/${inv.id}`).expect(404);
    expect((await api(app, customer(C.maria)).get('/api/invoices').expect(200)).body.items).toEqual([]);

    const sent = (await api(app, employee(U.sam)).post(`/api/invoices/${inv.id}/send`, {}).expect(201)).body;
    expect(sent.invoice).toMatchObject({ status: 'sent' });
    expect(sent.invoice.due_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sent.notified).toBe('m•••a@example.com');
    expect(sender.sent.at(-1)).toMatchObject({ channel: 'email', to: 'maria@example.com', template: 'invoice' });
    expect(sender.sent.at(-1)!.text).toContain(`/portal/invoices/${inv.id}`);

    const mine = (await api(app, customer(C.maria)).get(`/api/invoices/${inv.id}`).expect(200)).body;
    expect(mine).toMatchObject({ invoice_number: inv.invoice_number, balance: '120.00', pay: { card: true } });
    expect(mine.lines).toHaveLength(2);

    // Sent invoices are fixed: void them instead.
    await api(app, employee(U.sam)).put(`/api/invoices/${inv.id}`, { notes: 'changed' }).expect(409);
    await api(app, employee(U.sam)).delete(`/api/invoices/${inv.id}`).expect(409);
  });

  it('only those who may handle the customer’s payments see or bill them', async () => {
    const inv = (await draft().expect(201)).body;
    await api(app, customer(C.john)).get(`/api/invoices/${inv.id}`).expect(404);
    await api(app, employee(U.lia)).get(`/api/invoices/${inv.id}`).expect(404); // Lia (LA) cannot see Maria (NYC)
    await api(app, employee(U.lia)).post('/api/invoices', { customer_id: C.maria, lines: [{ description: 'x', unit_price: 1 }] }).expect(404);
    await api(app, customer(C.maria)).post('/api/invoices', { customer_id: C.maria, lines: [{ description: 'x', unit_price: 1 }] }).expect(403);
    await api(app, employee(U.sam)).delete(`/api/invoices/${inv.id}`).expect(204);
  });

  it('payments recorded against an invoice mark it paid when they cover it', async () => {
    const inv = (await draft().expect(201)).body;
    await cash(inv.id, 50).expect(400); // drafts take no payments
    await api(app, employee(U.sam)).post(`/api/invoices/${inv.id}/send`, { notify: false }).expect(201);

    await cash(inv.id, 50).expect(201);
    let now = (await api(app, employee(U.sam)).get(`/api/invoices/${inv.id}`).expect(200)).body;
    expect(now).toMatchObject({ status: 'sent', amount_paid: '50.00', balance: '70.00' });
    await cash(inv.id, 70).expect(201);
    now = (await api(app, employee(U.sam)).get(`/api/invoices/${inv.id}`).expect(200)).body;
    expect(now).toMatchObject({ status: 'paid', balance: '0.00' });
    expect(now.paid_at).not.toBeNull();
    expect(now.payments).toHaveLength(2);

    // Another customer's payment cannot count toward it; a paid invoice cannot be voided.
    await cash(inv.id, 10, U.ada, C.jane).expect(400);
    await api(app, employee(U.sam)).post(`/api/invoices/${inv.id}/void`, { reason: 'mistake' }).expect(409);
  });

  it('customers pay what is due by card through Stripe Checkout', async () => {
    const inv = (await draft().expect(201)).body;
    await api(app, employee(U.sam)).post(`/api/invoices/${inv.id}/send`, { notify: false }).expect(201);
    await cash(inv.id, 20).expect(201);

    const res = (await api(app, customer(C.maria)).post(`/api/invoices/${inv.id}/checkout`).expect(201)).body;
    expect(res.url).toBe('https://checkout.stripe.test/c/pay/cs_test_1');
    expect(checkout.requests.at(-1)).toMatchObject({ invoiceNumber: inv.invoice_number, customerNumber: 'C-10001', amount: 100, currency: 'USD' });
    expect(checkout.requests.at(-1)!.successUrl).toContain(`/portal/invoices/${inv.id}?paid=1`);

    await api(app, employee(U.sam)).post(`/api/invoices/${inv.id}/checkout`).expect(403);
    await api(app, customer(C.john)).post(`/api/invoices/${inv.id}/checkout`).expect(404);
    checkout.enabled = false;
    await api(app, customer(C.maria)).post(`/api/invoices/${inv.id}/checkout`).expect(503);
    expect((await api(app, customer(C.maria)).get(`/api/invoices/${inv.id}`).expect(200)).body.pay.card).toBe(false);
    checkout.enabled = true;
  });

  it('voids a sent invoice without payments; drafts are deleted instead', async () => {
    const inv = (await draft().expect(201)).body;
    await api(app, employee(U.sam)).post(`/api/invoices/${inv.id}/void`, { reason: 'wrong' }).expect(409);
    await api(app, employee(U.sam)).post(`/api/invoices/${inv.id}/send`, { notify: false }).expect(201);
    const v = (await api(app, employee(U.sam)).post(`/api/invoices/${inv.id}/void`, { reason: 'Billed twice' }).expect(201)).body;
    expect(v).toMatchObject({ status: 'void', void_reason: 'Billed twice' });
    await api(app, customer(C.maria)).post(`/api/invoices/${inv.id}/checkout`).expect(409);
  });
});
