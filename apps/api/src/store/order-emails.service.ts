import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Pool } from 'pg';
import { APP_POOL } from '../db/db.module';
import { MessagingService } from '../messaging/messaging.service';

export interface ClaimedOrder {
  order_id: string;
  order_number: string;
  email: string;
  first_name: string | null;
  currency: string;
  subtotal: string;
  amount_paid: string;
  business_name: string | null;
  lines: { name: string; quantity: number; amount: string; delivery: string | null }[];
}

const SWEEP_MS = 15_000;

/** "$19.50" in the order's currency. */
const money = (amount: string | number, currency: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(amount));

/** What a confirmation email can say: {{name}} in its subject or body is replaced with these. */
export const ORDER_FIELDS = {
  first_name: 'The customer’s first name (“there” when unknown)',
  order_number: 'The order number, e.g. ORD-2026-000123',
  items: 'One line per item: quantity, name and amount',
  amount_paid: 'What was paid, with tax and discounts, e.g. $39.00',
  what_you_get: '“What you get” and each product’s delivery note (empty when none have one)',
  order_link: 'The order in the customer portal',
  site_name: 'The site’s name (else the business name)',
} as const;
export type OrderField = keyof typeof ORDER_FIELDS;

export const DEFAULT_CONFIRMATION_SUBJECT = 'Your order {{order_number}}';
export const DEFAULT_CONFIRMATION_BODY = `Hi {{first_name}},

Thank you for your order. We've received your payment.

Order {{order_number}}
{{items}}
Paid: {{amount_paid}}

{{what_you_get}}

See your order any time: {{order_link}}

{{site_name}}`;

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Placeholders a text uses that aren't order fields. */
export function unknownOrderFields(...texts: string[]): string[] {
  return [...new Set(texts.flatMap((t) => [...t.matchAll(PLACEHOLDER)].map((m) => m[1]).filter((f) => !(f in ORDER_FIELDS))))];
}

export function orderFields(o: ClaimedOrder, appUrl: string): Record<OrderField, string> {
  const deliveries = o.lines.filter((l) => l.delivery?.trim());
  return {
    first_name: o.first_name ?? 'there',
    order_number: o.order_number,
    items: o.lines.map((l) => `- ${l.quantity} × ${l.name}: ${money(l.amount, o.currency)}`).join('\n'),
    amount_paid: money(o.amount_paid, o.currency),
    what_you_get: deliveries.length ? ['What you get', ...deliveries.flatMap((l) => ['', `${l.name}:`, l.delivery!.trim()])].join('\n') : '',
    order_link: `${appUrl}/portal/orders/${o.order_id}`,
    site_name: o.business_name ?? '',
  };
}

/** The confirmation email from a template (the standard one by default); empty placeholders leave no gaps. */
export function confirmationEmail(
  o: ClaimedOrder,
  appUrl: string,
  template: { subject?: string | null; body?: string | null } = {},
): { subject: string; text: string } {
  const fields = orderFields(o, appUrl);
  const fill = (text: string) => text.replace(PLACEHOLDER, (all, f: string) => (f in fields ? fields[f as OrderField] : all));
  const subject = fill(template.subject || DEFAULT_CONFIRMATION_SUBJECT)
    .replace(/\s*\n\s*/g, ' ')
    .trim();
  const text = fill(template.body || DEFAULT_CONFIRMATION_BODY)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { subject, text };
}

/** A made-up paid order for previews in Settings › Store. */
export const SAMPLE_ORDER: ClaimedOrder = {
  order_id: '00000000-0000-4000-8000-000000000000',
  order_number: 'ORD-2026-000123',
  email: 'customer@example.com',
  first_name: 'Maria',
  currency: 'USD',
  subtotal: '169.50',
  amount_paid: '169.50',
  business_name: null,
  lines: [
    { name: 'Coaching pack', quantity: 1, amount: '150.00', delivery: "We'll email you within a day to book your first session." },
    { name: 'Style guide (PDF)', quantity: 1, amount: '19.50', delivery: 'Download: https://example.com/style-guide.pdf' },
  ],
};

/**
 * Emails customers when their order is paid (Settings › Store: email_customers). Orders become paid
 * in the database when the worker applies Stripe's payment, so this sweeps every few seconds and
 * claims each order (authz.claim_order_confirmations) before sending: one email per order, retried
 * a few times when sending fails.
 */
@Injectable()
export class OrderEmailsService implements OnModuleDestroy {
  private readonly logger = new Logger('OrderEmails');
  private readonly timer: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly messaging: MessagingService,
  ) {
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** Sends the confirmations that are due; returns how many were sent. */
  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let sent = 0;
    try {
      const orders = (await this.pool.query<ClaimedOrder>('SELECT * FROM authz.claim_order_confirmations(20)')).rows;
      if (!orders.length) return 0;
      const appUrl = await this.messaging.appUrl();
      const template = (
        await this.pool.query<{ subject: string | null; body: string | null }>('SELECT confirmation_subject AS subject, confirmation_body AS body FROM core.store_settings WHERE id = 1')
      ).rows[0];
      for (const o of orders) {
        try {
          await this.messaging.send({ channel: 'email', to: o.email, template: 'order_confirmation', ...confirmationEmail(o, appUrl, template) });
          sent++;
        } catch (err) {
          this.logger.warn(`Could not email the confirmation of ${o.order_number}: ${(err as Error).message}`);
          await this.pool.query('SELECT authz.order_confirmation_failed($1)', [o.order_id]);
        }
      }
    } catch (err) {
      this.logger.warn(`Order confirmations: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
    return sent;
  }
}
