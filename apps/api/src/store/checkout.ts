import { toMinorUnits } from '../invoices/checkout';
import { StripeSecrets } from '../stripe/stripe-secrets';

export interface StoreCheckoutRequest {
  orderNumber: string;
  customerNumber: string;
  email: string | null;
  currency: string;
  lines: { name: string; unitPrice: number; quantity: number }[];
  /** Settings › Store. */
  automaticTax: boolean;
  pricesIncludeTax: boolean;
  allowPromotionCodes: boolean;
  requireTerms: boolean;
  successUrl: string;
  cancelUrl: string;
}

/** Creates the hosted payment page for a store order. Overridden in tests. */
export interface StoreCheckout {
  create(req: StoreCheckoutRequest): Promise<{ id: string; url: string }>;
}

export const STORE_CHECKOUT = Symbol('STORE_CHECKOUT');

/** Thrown with Stripe's own message (e.g. Stripe Tax not set up), for the admin to act on. */
export class StoreCheckoutError extends Error {}

/**
 * Stripe Checkout Sessions over REST (no SDK), with the prices sent each time (no product catalog
 * in Stripe: the database is the source of truth). The PaymentIntent carries order_number and
 * customer_number metadata: the webhook and worker record the payment and link it to the order.
 */
export class StripeStoreCheckout implements StoreCheckout {
  constructor(
    private readonly secrets: StripeSecrets,
    private readonly baseUrl = 'https://api.stripe.com',
  ) {}

  async create(req: StoreCheckoutRequest) {
    const key = await this.secrets.checkoutKey();
    if (!key) throw new StoreCheckoutError('Stripe Checkout is not configured');
    const form = new URLSearchParams({
      mode: 'payment',
      success_url: req.successUrl,
      cancel_url: req.cancelUrl,
      client_reference_id: req.orderNumber,
      'metadata[order_number]': req.orderNumber,
      'payment_intent_data[metadata][order_number]': req.orderNumber,
      'payment_intent_data[metadata][customer_number]': req.customerNumber,
    });
    req.lines.forEach((l, i) => {
      form.set(`line_items[${i}][quantity]`, String(l.quantity));
      form.set(`line_items[${i}][price_data][currency]`, req.currency.toLowerCase());
      form.set(`line_items[${i}][price_data][unit_amount]`, String(toMinorUnits(l.unitPrice, req.currency)));
      form.set(`line_items[${i}][price_data][product_data][name]`, l.name);
      if (req.automaticTax) form.set(`line_items[${i}][price_data][tax_behavior]`, req.pricesIncludeTax ? 'inclusive' : 'exclusive');
    });
    if (req.automaticTax) form.set('automatic_tax[enabled]', 'true');
    if (req.allowPromotionCodes) form.set('allow_promotion_codes', 'true');
    if (req.requireTerms) form.set('consent_collection[terms_of_service]', 'required');
    if (req.email) form.set('customer_email', req.email);

    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/v1/checkout/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message;
      throw new StoreCheckoutError(`Stripe returned ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const session = (await res.json()) as { id: string; url: string };
    return { id: session.id, url: session.url };
  }
}
