import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import path from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STORE_CHECKOUT, type StoreCheckout, type StoreCheckoutRequest } from '../src/store/checkout';
import { api, createApp, customer, employee } from './app';

const { customers: C, users: U } = SAMPLE;

/** Stripe stand-in: records sessions instead of calling Stripe. */
class FakeCheckout implements StoreCheckout {
  requests: StoreCheckoutRequest[] = [];
  async create(req: StoreCheckoutRequest) {
    this.requests.push(req);
    return { id: `cs_test_${this.requests.length}`, url: `https://checkout.stripe.test/c/pay/cs_test_${this.requests.length}` };
  }
}

const checkout = new FakeCheckout();
let app: INestApplication;
let migrator: Client;
const admin = () => api(app, employee(U.ada));
const visitor = () => request(app.getHttpServer());

beforeAll(async () => {
  app = await createApp({ overrides: [{ token: STORE_CHECKOUT, value: checkout }] });
  config({ path: path.resolve(__dirname, '../../../.env') });
  migrator = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await migrator.connect();
  await migrator.query('UPDATE core.settings SET stripe_enabled = true WHERE id = 1');
});
afterAll(async () => {
  await migrator.query('UPDATE core.payments SET order_id = NULL WHERE order_id IS NOT NULL');
  await migrator.query(`DELETE FROM core.payments WHERE stripe_payment_intent_id LIKE 'pi_store_%'`);
  await migrator.query('DELETE FROM core.orders');
  await migrator.query('DELETE FROM core.products');
  await migrator.query('UPDATE core.store_settings SET enabled = false, automatic_tax = false, allow_promotion_codes = false, max_quantity = 10');
  await migrator.query('UPDATE core.settings SET stripe_enabled = false WHERE id = 1');
  await migrator.end();
  await app.close();
});

let coaching: { id: string };
let guide: { id: string };

/** What the Stripe sync records when the customer pays (the worker links it by order_number). */
async function stripePays(orderId: string, amount: number, status = 'succeeded') {
  const intent = `pi_store_${orderId.slice(0, 8)}`;
  await migrator.query(
    `INSERT INTO core.payments (source, customer_id, amount, currency, method, status, stripe_payment_intent_id, paid_at, order_id)
     VALUES ('stripe', $1, $2, 'USD', 'card_online', $3, $4, now(), $5)
     ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET status = EXCLUDED.status, amount_refunded = CASE WHEN EXCLUDED.status = 'refunded' THEN core.payments.amount ELSE 0 END`,
    [C.maria, amount, status, intent, orderId],
  );
}

describe('products', () => {
  it('editors manage products; delivery is never public', async () => {
    coaching = (
      await admin()
        .post('/api/products', { slug: 'coaching-pack', name: 'Coaching pack', summary: 'Three sessions', kind: 'service', price: 150, active: true, delivery: 'We will call you to book.' })
        .expect(201)
    ).body;
    guide = (
      await admin()
        .post('/api/products', { slug: 'style-guide', name: 'Style guide (PDF)', kind: 'digital', price: 19.5, active: true, sort_order: 1, delivery: 'Download: https://example.com/guide.pdf' })
        .expect(201)
    ).body;
    await admin().post('/api/products', { slug: 'draft-item', name: 'Draft', kind: 'service', price: 10 }).expect(201);
    expect(coaching).toMatchObject({ name: 'Coaching pack', price: '150.00', delivery: 'We will call you to book.' });
    await admin().post('/api/products', { slug: 'coaching-pack', name: 'Dup', kind: 'service', price: 1 }).expect(409);
    await admin().post('/api/products', { slug: 'bad', name: 'Free', kind: 'service', price: 0 }).expect(400);

    await api(app, employee(U.sam)).post('/api/products', { slug: 'x', name: 'x', kind: 'service', price: 1 }).expect(403);
    await api(app, customer(C.maria)).get('/api/products').expect(403);

    // Closed store: nothing on sale.
    expect((await visitor().get('/api/site/store').expect(200)).body).toMatchObject({ enabled: false, products: [] });
    await visitor().get('/api/site/store/products/coaching-pack').expect(404);

    await admin().put('/api/admin/store', { enabled: true }).expect(200);
    const store = (await visitor().get('/api/site/store').expect(200)).body;
    expect(store).toMatchObject({ enabled: true, currency: 'USD', max_quantity: 10 });
    expect(store.products.map((p: { slug: string }) => p.slug)).toEqual(['coaching-pack', 'style-guide']);
    expect(JSON.stringify(store)).not.toContain('example.com/guide.pdf');
    expect((await visitor().get('/api/site/store/products/style-guide').expect(200)).body).not.toHaveProperty('delivery');
    await visitor().get('/api/site/store/products/draft-item').expect(404);
  });

  it('store settings are for admins', async () => {
    await api(app, employee(U.sam)).put('/api/admin/store', { enabled: false }).expect(403);
    await admin().put('/api/admin/store', { max_quantity: 0 }).expect(400);
    expect((await admin().get('/api/admin/store').expect(200)).body).toMatchObject({ enabled: true, automatic_tax: false });
  });
});

describe('checkout and orders', () => {
  it('a signed-in customer checks out the cart at the products’ prices', async () => {
    await admin().put('/api/admin/store', { automatic_tax: true, allow_promotion_codes: true }).expect(200);
    const res = (
      await api(app, customer(C.maria))
        .post('/api/orders/checkout', { items: [{ product_id: coaching.id, quantity: 2 }, { product_id: guide.id, quantity: 1 }] })
        .expect(201)
    ).body;
    expect(res.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const req = checkout.requests.at(-1)!;
    expect(req).toMatchObject({
      orderNumber: res.order_number,
      customerNumber: 'C-10001',
      currency: 'USD',
      automaticTax: true,
      allowPromotionCodes: true,
      lines: [
        { name: 'Coaching pack', unitPrice: 150, quantity: 2 },
        { name: 'Style guide (PDF)', unitPrice: 19.5, quantity: 1 },
      ],
    });
    expect(req.successUrl).toContain(`/portal/orders/${res.order_id}?paid=1`);

    const order = (await api(app, customer(C.maria)).get(`/api/orders/${res.order_id}`).expect(200)).body;
    expect(order).toMatchObject({ status: 'pending', subtotal: '319.50', amount_paid: '0.00' });
    expect(order.lines.every((l: { delivery: string | null }) => l.delivery === null)).toBe(true);
    // Other customers don't see it.
    await api(app, customer(C.john)).get(`/api/orders/${res.order_id}`).expect(404);
    await admin().put('/api/admin/store', { automatic_tax: false, allow_promotion_codes: false }).expect(200);
  });

  it('refuses carts it cannot sell, and employees cannot check out', async () => {
    const cart = (items: unknown[]) => api(app, customer(C.maria)).post('/api/orders/checkout', { items });
    await cart([{ product_id: coaching.id, quantity: 11 }]).expect(400);
    await cart([{ product_id: coaching.id, quantity: 1 }, { product_id: coaching.id, quantity: 1 }]).expect(400);
    const draft = (await admin().get('/api/products').expect(200)).body.find((p: { slug: string }) => p.slug === 'draft-item');
    await cart([{ product_id: draft.id, quantity: 1 }]).expect(400);
    await cart([]).expect(400);
    await api(app, employee(U.ada)).post('/api/orders/checkout', { items: [{ product_id: coaching.id, quantity: 1 }] }).expect(403);
  });

  it('payment makes the order paid, hands over delivery and tells admins; staff fulfil it', async () => {
    const res = (await api(app, customer(C.maria)).post('/api/orders/checkout', { items: [{ product_id: coaching.id, quantity: 1 }] }).expect(201)).body;
    await stripePays(res.order_id, 150);

    const order = (await api(app, customer(C.maria)).get(`/api/orders/${res.order_id}`).expect(200)).body;
    expect(order).toMatchObject({ status: 'paid', amount_paid: '150.00' });
    expect(order.paid_at).toBeTruthy();
    expect(order.lines[0].delivery).toBe('We will call you to book.');
    expect(order.payments).toHaveLength(1);
    const note = (
      await migrator.query(
        `SELECT m.body, m.link FROM app.team_messages m JOIN app.team_channels ch ON ch.id = m.channel_id WHERE ch.owner_id = $1 AND m.body LIKE $2`,
        [U.ada, `New order ${res.order_number}%`],
      )
    ).rows[0];
    expect(note).toMatchObject({ link: `/staff/orders?order=${res.order_id}` });
    expect(note.body).toContain('1 × Coaching pack');

    // Staff list: paid orders wait to be fulfilled.
    const open = (await admin().get('/api/orders?status=open').expect(200)).body;
    expect(open.map((o: { id: string }) => o.id)).toContain(res.order_id);
    await api(app, customer(C.maria)).post(`/api/orders/${res.order_id}/status`, { status: 'fulfilled' }).expect(403);
    const done = (await admin().post(`/api/orders/${res.order_id}/status`, { status: 'fulfilled' }).expect(200)).body;
    expect(done).toMatchObject({ status: 'fulfilled', fulfilled_by_name: 'Ada Admin' });
    await admin().post(`/api/orders/${res.order_id}/status`, { status: 'cancelled' }).expect(400);

    // A full refund.
    await stripePays(res.order_id, 150, 'refunded');
    expect((await admin().get(`/api/orders/${res.order_id}`).expect(200)).body).toMatchObject({ status: 'refunded', amount_paid: '0.00' });
  });

  it('digital-only orders are fulfilled on payment; a new checkout replaces an unpaid one', async () => {
    const first = (await api(app, customer(C.maria)).post('/api/orders/checkout', { items: [{ product_id: guide.id, quantity: 1 }] }).expect(201)).body;
    const second = (await api(app, customer(C.maria)).post('/api/orders/checkout', { items: [{ product_id: guide.id, quantity: 1 }] }).expect(201)).body;
    expect((await admin().get(`/api/orders/${first.order_id}`).expect(200)).body.status).toBe('cancelled');
    // Customers don't see their abandoned checkouts.
    const mine = (await api(app, customer(C.maria)).get('/api/orders').expect(200)).body.map((o: { id: string }) => o.id);
    expect(mine).not.toContain(first.order_id);
    expect(mine).toContain(second.order_id);

    await stripePays(second.order_id, 19.5);
    const order = (await api(app, customer(C.maria)).get(`/api/orders/${second.order_id}`).expect(200)).body;
    expect(order).toMatchObject({ status: 'fulfilled' });
    expect(order.lines[0].delivery).toContain('guide.pdf');

    // The first was paid after all (its Checkout page was still open): it counts again.
    await stripePays(first.order_id, 19.5);
    expect((await admin().get(`/api/orders/${first.order_id}`).expect(200)).body.status).toBe('fulfilled');
  });

  it('staff cancel an unpaid order; nobody writes orders directly', async () => {
    const res = (await api(app, customer(C.maria)).post('/api/orders/checkout', { items: [{ product_id: coaching.id, quantity: 1 }] }).expect(201)).body;
    expect((await admin().post(`/api/orders/${res.order_id}/status`, { status: 'cancelled' }).expect(200)).body.status).toBe('cancelled');
    await admin().post(`/api/orders/${res.order_id}/status`, { status: 'fulfilled' }).expect(400);

    const appDb = new Client({ connectionString: process.env.APP_DATABASE_URL });
    await appDb.connect();
    try {
      await expect(appDb.query(`UPDATE core.orders SET status = 'paid'`)).rejects.toMatchObject({ code: '42501' });
      await expect(appDb.query('SELECT * FROM core.product_delivery')).resolves.toMatchObject({ rowCount: 0 }); // RLS: no principal sees none
    } finally {
      await appDb.end();
    }
  });
});
