import { Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { Principal } from '../auth/principal';
import { APP_POOL, DbService } from '../db/db.module';
import { MessagingService } from '../messaging/messaging.service';
import { STORE_CHECKOUT, StoreCheckoutError, type StoreCheckout } from './checkout';
import { confirmationEmail, DEFAULT_CONFIRMATION_BODY, DEFAULT_CONFIRMATION_SUBJECT, ORDER_FIELDS, SAMPLE_ORDER, unknownOrderFields } from './order-emails.service';

const money = z.coerce.number().positive().multipleOf(0.01).max(999_999);

export const productSchema = z
  .object({
    slug: z.string().trim().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and dashes').max(60),
    name: z.string().trim().min(1).max(120),
    summary: z.string().trim().max(300).nullable().optional(),
    /** Markdown, on the product's own page. */
    description: z.string().trim().max(10_000).nullable().optional(),
    kind: z.enum(['service', 'digital']),
    price: money,
    image_asset_id: z.string().uuid().nullable().optional(),
    active: z.boolean().default(false),
    sort_order: z.coerce.number().int().min(0).max(10_000).default(0),
    /** Markdown the buyer gets once paid (a download link, access details, what happens next). Never public. */
    delivery: z.string().trim().max(4000).nullable().optional(),
  })
  .strict();
export const productUpdateSchema = productSchema.partial().strict();
export type ProductInput = z.infer<typeof productSchema>;

export const storeSettingsSchema = z
  .object({
    enabled: z.boolean(),
    automatic_tax: z.boolean(),
    prices_include_tax: z.boolean(),
    allow_promotion_codes: z.boolean(),
    require_terms: z.boolean(),
    notify_admins: z.boolean(),
    /** Email customers a confirmation when their order is paid. */
    email_customers: z.boolean(),
    max_quantity: z.number().int().min(1).max(100),
    /** The confirmation email; null sends the standard text. */
    confirmation_subject: z.string().trim().min(1).max(200).nullable(),
    confirmation_body: z.string().trim().min(1).max(10_000).nullable(),
  })
  .partial()
  .strict()
  .superRefine((b, ctx) => {
    const unknown = unknownOrderFields(b.confirmation_subject ?? '', b.confirmation_body ?? '');
    if (unknown.length) ctx.addIssue({ code: 'custom', message: `Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => `{{${u}}}`).join(', ')}` });
  });

export const confirmationPreviewSchema = z.object({ subject: z.string().max(200), body: z.string().max(10_000) }).strict();

export const checkoutSchema = z
  .object({
    items: z
      .array(z.object({ product_id: z.string().uuid(), quantity: z.number().int().min(1).max(100) }).strict())
      .min(1)
      .max(20),
  })
  .strict();

export const orderListSchema = z
  .object({
    /** open: paid and waiting to be fulfilled. */
    status: z.enum(['open', 'pending', 'paid', 'fulfilled', 'cancelled', 'refunded', 'all']).default('all'),
    customer_id: z.string().uuid().optional(),
    q: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

export const orderStatusSchema = z.object({ status: z.enum(['fulfilled', 'paid', 'cancelled']) }).strict();

const PRODUCT_COLUMNS = `p.id, p.slug, p.name, p.summary, p.description, p.kind, p.price, p.image_asset_id,
  (SELECT a.storage FROM core.site_assets a WHERE a.id = p.image_asset_id) AS image_storage, p.active, p.sort_order`;
const STORE_COLUMNS = `enabled, automatic_tax, prices_include_tax, allow_promotion_codes, require_terms, notify_admins, email_customers, max_quantity,
  confirmation_subject, confirmation_body, updated_at`;
const ORDER_COLUMNS = `o.id, o.order_number, o.customer_id, o.currency, o.status, o.subtotal, o.amount_paid, o.paid_at, o.fulfilled_at, o.cancelled_at, o.confirmation_sent_at,
  o.created_at, o.updated_at,
  (SELECT nullif(concat_ws(' ', c.first_name, c.last_name), '') FROM core.customers c WHERE c.id = o.customer_id) AS customer_name,
  (SELECT c.customer_number FROM core.customers c WHERE c.id = o.customer_id) AS customer_number,
  (SELECT nullif(concat_ws(' ', u.first_name, u.last_name), '') FROM core.users u WHERE u.id = o.fulfilled_by) AS fulfilled_by_name,
  (SELECT string_agg(l.quantity || ' × ' || l.name, ', ' ORDER BY l.position) FROM core.order_lines l WHERE l.order_id = o.id) AS summary`;

/**
 * The store (migration 0051): products (part of the website), Settings › Store, and orders that
 * signed-in customers pay through Stripe Checkout. Payments come back through the Stripe sync and
 * move the order along (core.order_refresh); staff then fulfil services.
 */
@Injectable()
export class StoreService {
  private readonly logger = new Logger('Store');

  constructor(
    private readonly db: DbService,
    @Inject(APP_POOL) private readonly pool: Pool,
    @Inject(STORE_CHECKOUT) private readonly checkout: StoreCheckout,
    private readonly messaging: MessagingService,
  ) {}

  // Public site -------------------------------------------------------------------------------

  /** For visitors: whether the store is open, its currency and limit, and the products on sale. */
  async publicStore() {
    const [store, currency, products] = await Promise.all([
      this.pool.query('SELECT enabled, max_quantity, prices_include_tax, automatic_tax FROM core.store_settings WHERE id = 1'),
      this.pool.query<{ currency: string }>('SELECT authz.store_currency() AS currency'),
      this.pool.query(`SELECT ${PRODUCT_COLUMNS} FROM core.products p WHERE p.active ORDER BY p.sort_order, p.name`),
    ]);
    const s = store.rows[0];
    return { ...s, currency: currency.rows[0]?.currency ?? 'USD', products: s?.enabled ? products.rows : [] };
  }

  async publicProduct(slug: string) {
    const row = (await this.pool.query(`SELECT ${PRODUCT_COLUMNS} FROM core.products p WHERE p.active AND p.slug = $1`, [slug])).rows[0];
    const open = (await this.pool.query<{ enabled: boolean }>('SELECT enabled FROM core.store_settings WHERE id = 1')).rows[0]?.enabled;
    if (!row || !open) throw new NotFoundException('Product not found');
    return row;
  }

  // Products (Website › Products) ---------------------------------------------------------------

  listProducts(p: Principal) {
    return this.db.as(p, async (db) =>
      (await db.query(`SELECT ${PRODUCT_COLUMNS}, d.content AS delivery FROM core.products p LEFT JOIN core.product_delivery d ON d.product_id = p.id ORDER BY p.sort_order, p.name`)).rows,
    );
  }

  createProduct(p: Principal, input: ProductInput) {
    return this.db.as(p, async (db) => {
      const { delivery, ...fields } = input;
      const cols = Object.keys(fields) as (keyof typeof fields)[];
      const id = (
        await db.query<{ id: string }>(
          `INSERT INTO core.products (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
          cols.map((c) => fields[c] ?? null),
        )
      ).rows[0].id;
      await this.writeDelivery(db, id, delivery);
      return this.loadProduct(db, id);
    });
  }

  updateProduct(p: Principal, id: string, input: Partial<ProductInput>) {
    return this.db.as(p, async (db) => {
      const { delivery, ...fields } = input;
      const cols = Object.keys(fields) as (keyof typeof fields)[];
      if (cols.length) {
        const res = await db.query(`UPDATE core.products SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...cols.map((c) => fields[c] ?? null)]);
        if (!res.rowCount) throw new NotFoundException('Product not found');
      }
      if (delivery !== undefined) await this.writeDelivery(db, id, delivery);
      return this.loadProduct(db, id);
    });
  }

  deleteProduct(p: Principal, id: string) {
    return this.db.as(p, async (db) => {
      const res = await db.query('DELETE FROM core.products WHERE id = $1', [id]);
      if (!res.rowCount) throw new NotFoundException('Product not found');
    });
  }

  private async writeDelivery(db: PoolClient, id: string, delivery: string | null | undefined) {
    if (delivery === undefined) return;
    if (delivery) {
      await db.query('INSERT INTO core.product_delivery (product_id, content) VALUES ($1, $2) ON CONFLICT (product_id) DO UPDATE SET content = EXCLUDED.content', [id, delivery]);
    } else {
      await db.query('DELETE FROM core.product_delivery WHERE product_id = $1', [id]);
    }
  }

  private async loadProduct(db: PoolClient, id: string) {
    const row = (await db.query(`SELECT ${PRODUCT_COLUMNS}, d.content AS delivery FROM core.products p LEFT JOIN core.product_delivery d ON d.product_id = p.id WHERE p.id = $1`, [id])).rows[0];
    if (!row) throw new NotFoundException('Product not found');
    return row;
  }

  // Settings › Store ----------------------------------------------------------------------------

  /** With the confirmation email's standard text and placeholders, for the editor. */
  getSettings(p: Principal) {
    return this.db.as(p, async (db) => this.withEmailHelp((await db.query(`SELECT ${STORE_COLUMNS} FROM core.store_settings WHERE id = 1`)).rows[0]));
  }

  /** The confirmation email as a made-up order would get it. */
  async previewConfirmation(subject: string, body: string) {
    const unknown = unknownOrderFields(subject, body);
    const site = (await this.pool.query<{ name: string | null }>(
      `SELECT coalesce((SELECT nullif(site_name, '') FROM core.site_settings WHERE id = 1), (SELECT business_name FROM authz.site_info())) AS name`,
    )).rows[0]?.name ?? null;
    return { ...confirmationEmail({ ...SAMPLE_ORDER, business_name: site }, await this.messaging.appUrl(), { subject, body }), unknown };
  }

  private withEmailHelp(row: Record<string, unknown>) {
    return { ...row, confirmation_defaults: { subject: DEFAULT_CONFIRMATION_SUBJECT, body: DEFAULT_CONFIRMATION_BODY }, confirmation_fields: ORDER_FIELDS };
  }

  updateSettings(p: Principal, input: z.infer<typeof storeSettingsSchema>) {
    return this.db.as(p, async (db) => {
      const cols = Object.keys(input) as (keyof typeof input)[];
      if (cols.length) await db.query(`UPDATE core.store_settings SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = 1`, cols.map((c) => input[c]));
      return this.withEmailHelp((await db.query(`SELECT ${STORE_COLUMNS} FROM core.store_settings WHERE id = 1`)).rows[0]);
    });
  }

  // Orders --------------------------------------------------------------------------------------

  /** A signed-in customer's cart: a pending order and its Stripe Checkout page. */
  async checkoutCart(p: Principal, body: z.infer<typeof checkoutSchema>) {
    const { order, lines, customer, store } = await this.db.as(p, async (db) => {
      const enabled = (await db.query<{ on: boolean }>('SELECT authz.stripe_enabled() AS on')).rows[0].on;
      if (!enabled) throw new ServiceUnavailableException('Card payments are not available');
      const order = (await db.query<{ id: string; order_number: string; currency: string }>('SELECT * FROM authz.create_order($1)', [JSON.stringify(body.items)])).rows[0];
      const lines = (await db.query<{ name: string; unit_price: string; quantity: number }>('SELECT name, unit_price, quantity FROM core.order_lines WHERE order_id = $1 ORDER BY position', [order.id])).rows;
      const customer = (
        await db.query<{ customer_number: string; email: string | null; email_verified: boolean }>('SELECT customer_number, email, email_verified FROM core.customers WHERE id = $1', [p.id])
      ).rows[0];
      const store = (await db.query(`SELECT ${STORE_COLUMNS} FROM core.store_settings WHERE id = 1`)).rows[0];
      return { order, lines, customer, store };
    });
    const base = await this.messaging.appUrl();
    let session: { id: string; url: string };
    try {
      session = await this.checkout.create({
        orderNumber: order.order_number,
        customerNumber: customer.customer_number,
        email: customer.email_verified ? customer.email : null,
        currency: order.currency,
        lines: lines.map((l) => ({ name: l.name, unitPrice: Number(l.unit_price), quantity: l.quantity })),
        automaticTax: store.automatic_tax,
        pricesIncludeTax: store.prices_include_tax,
        allowPromotionCodes: store.allow_promotion_codes,
        requireTerms: store.require_terms,
        successUrl: `${base}/portal/orders/${order.id}?paid=1`,
        cancelUrl: `${base}/shop/cart`,
      });
    } catch (err) {
      this.logger.error(`checkout failed for ${order.order_number}: ${(err as Error).message}`);
      if (err instanceof StoreCheckoutError) throw new ServiceUnavailableException('Checkout could not be started. Please try again shortly.');
      throw err;
    }
    await this.db.as(p, (db) => db.query('SELECT authz.attach_order_checkout($1, $2)', [order.id, session.id]));
    return { order_id: order.id, order_number: order.order_number, url: session.url };
  }

  /** Orders the principal may see: customers their own (not abandoned ones), employees by payments scope. */
  listOrders(p: Principal, q: z.infer<typeof orderListSchema>) {
    return this.db.as(p, async (db) => {
      const where: string[] = [];
      const args: unknown[] = [];
      if (p.type === 'customer') where.push(`o.status <> 'cancelled' OR o.amount_paid > 0`);
      if (q.status === 'open') where.push(`o.status = 'paid'`);
      else if (q.status !== 'all') where.push(`o.status = $${args.push(q.status)}`);
      if (q.customer_id) where.push(`o.customer_id = $${args.push(q.customer_id)}`);
      if (q.q) {
        const n = args.push(`%${q.q}%`);
        where.push(`(o.order_number ILIKE $${n} OR EXISTS (SELECT 1 FROM core.customers c WHERE c.id = o.customer_id
          AND (concat_ws(' ', c.first_name, c.last_name) ILIKE $${n} OR c.customer_number ILIKE $${n} OR c.email ILIKE $${n})))`);
      }
      args.push(q.limit);
      return (
        await db.query(
          `SELECT ${ORDER_COLUMNS} FROM core.orders o ${where.length ? `WHERE ${where.map((w) => `(${w})`).join(' AND ')}` : ''}
           ORDER BY o.created_at DESC LIMIT $${args.length}`,
          args,
        )
      ).rows;
    });
  }

  getOrder(p: Principal, id: string) {
    return this.db.as(p, (db) => this.loadOrder(db, id));
  }

  setOrderStatus(p: Principal, id: string, status: z.infer<typeof orderStatusSchema>['status']) {
    return this.db.as(p, async (db) => {
      await this.loadOrder(db, id); // 404 when not visible
      await db.query('SELECT authz.set_order_status($1, $2)', [id, status]);
      return this.loadOrder(db, id);
    });
  }

  private async loadOrder(db: PoolClient, id: string) {
    const order = (await db.query(`SELECT ${ORDER_COLUMNS} FROM core.orders o WHERE o.id = $1`, [id])).rows[0];
    if (!order) throw new NotFoundException('Order not found');
    order.lines = (
      await db.query(
        `SELECT l.id, l.product_id, l.name, l.kind, l.unit_price, l.quantity, round(l.unit_price * l.quantity, 2) AS amount, l.delivery,
                (SELECT p.slug FROM core.products p WHERE p.id = l.product_id) AS product_slug
           FROM core.order_lines l WHERE l.order_id = $1 ORDER BY l.position`,
        [id],
      )
    ).rows;
    order.payments = (
      await db.query(
        `SELECT p.id, p.amount, p.amount_refunded, p.currency, p.status, p.paid_at, p.receipt_url, p.card_brand, p.card_last4
           FROM core.payments p WHERE p.order_id = $1 ORDER BY p.created_at`,
        [id],
      )
    ).rows;
    return order;
  }
}
