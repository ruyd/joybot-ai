import { StripeSecrets } from '../stripe/stripe-secrets';

export interface CheckoutRequest {
  invoiceNumber: string;
  customerNumber: string;
  email: string | null;
  /** Amount due, in major units (e.g. 50.00). */
  amount: number;
  currency: string;
  description: string;
  successUrl: string;
  cancelUrl: string;
}

/** Creates the hosted payment page for an invoice. Overridden in tests. */
export interface InvoiceCheckout {
  /** False when card payments are not set up (no key): the portal offers bank transfer only. */
  available(): Promise<boolean>;
  create(req: CheckoutRequest): Promise<{ id: string; url: string }>;
}

export const INVOICE_CHECKOUT = Symbol('INVOICE_CHECKOUT');

/** Stripe currencies without minor units (amounts are whole units). */
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
export const toMinorUnits = (amount: number, currency: string) => (ZERO_DECIMAL.has(currency.toLowerCase()) ? Math.round(amount) : Math.round(amount * 100));

/**
 * Stripe Checkout Sessions over REST (no SDK). The PaymentIntent carries invoice_number and
 * customer_number metadata: the webhook and worker record the payment and link it to the invoice.
 */
export class StripeInvoiceCheckout implements InvoiceCheckout {
  constructor(
    private readonly secrets: StripeSecrets,
    private readonly baseUrl = 'https://api.stripe.com',
  ) {}

  async available() {
    return Boolean(await this.secrets.checkoutKey());
  }

  async create(req: CheckoutRequest) {
    const key = await this.secrets.checkoutKey();
    if (!key) throw new Error('Stripe Checkout is not configured');
    const form = new URLSearchParams({
      mode: 'payment',
      success_url: req.successUrl,
      cancel_url: req.cancelUrl,
      client_reference_id: req.invoiceNumber,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': req.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(toMinorUnits(req.amount, req.currency)),
      'line_items[0][price_data][product_data][name]': req.description,
      'metadata[invoice_number]': req.invoiceNumber,
      'payment_intent_data[metadata][invoice_number]': req.invoiceNumber,
      'payment_intent_data[metadata][customer_number]': req.customerNumber,
    });
    if (req.email) form.set('customer_email', req.email);
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/v1/checkout/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Stripe returned ${res.status}`);
    const session = (await res.json()) as { id: string; url: string };
    return { id: session.id, url: session.url };
  }
}
