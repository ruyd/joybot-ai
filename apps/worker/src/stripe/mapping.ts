/**
 * Pure mapping from Stripe objects to JoyBot payment fields (plan.md §4.4). Kept free of I/O so
 * the rules are unit-tested.
 */

/** Stripe currencies without minor units (amounts are already whole units). */
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

export function fromMinorUnits(amount: number, currency: string): number {
  return ZERO_DECIMAL.has(currency.toLowerCase()) ? amount : amount / 100;
}

export type PaymentStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'refunded' | 'partially_refunded' | 'disputed';

/** PaymentIntent status → JoyBot status. A failed attempt leaves the intent in requires_payment_method. */
export function intentStatus(status: string, hasFailure: boolean): PaymentStatus {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'processing':
      return 'processing';
    case 'canceled':
      return 'canceled';
    case 'requires_payment_method':
      return hasFailure ? 'failed' : 'pending';
    default:
      return 'pending';
  }
}

export function paymentMethod(type: string | undefined): 'card_online' | 'bank_transfer' | 'wallet' | 'other' {
  if (!type || type === 'card' || type === 'card_present') return 'card_online';
  if (['us_bank_account', 'sepa_debit', 'acss_debit', 'bacs_debit', 'au_becs_debit', 'customer_balance'].includes(type)) return 'bank_transfer';
  if (['link', 'cashapp', 'paypal', 'amazon_pay', 'apple_pay', 'google_pay'].includes(type)) return 'wallet';
  return 'other';
}

/** Status after refunds/disputes on the charge (they take precedence over the intent status). */
export function chargeStatus(base: PaymentStatus, amountRefundedMinor: number, amountMinor: number, disputed: boolean): PaymentStatus {
  if (disputed) return 'disputed';
  if (amountRefundedMinor > 0) return amountRefundedMinor >= amountMinor ? 'refunded' : 'partially_refunded';
  return base;
}

// Minimal shapes of the Stripe objects we read (fields documented in the Stripe API reference).
export interface StripeCharge {
  id: string;
  object: 'charge';
  payment_intent: string | null;
  amount: number;
  amount_refunded: number;
  currency: string;
  created: number;
  status: string;
  disputed: boolean;
  receipt_url?: string | null;
  customer?: string | null;
  billing_details?: { email?: string | null };
  payment_method_details?: { type?: string; card?: { brand?: string; last4?: string } };
  failure_message?: string | null;
  metadata?: Record<string, string>;
}

export interface StripePaymentIntent {
  id: string;
  object: 'payment_intent';
  amount: number;
  amount_received?: number;
  currency: string;
  status: string;
  created: number;
  customer?: string | null;
  receipt_email?: string | null;
  metadata?: Record<string, string>;
  payment_method_types?: string[];
  last_payment_error?: { message?: string } | null;
  latest_charge?: string | StripeCharge | null;
  invoice?: string | null;
}

export interface PaymentUpsert {
  intentId: string;
  chargeId: string | null;
  stripeCustomerId: string | null;
  amount: number;
  currency: string;
  method: ReturnType<typeof paymentMethod>;
  status: PaymentStatus;
  amountRefunded: number;
  failureReason: string | null;
  receiptUrl: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  paidAt: string | null;
  invoiceId: string | null;
  match: { customerNumber: string | null; appointmentNumber: string | null; email: string | null };
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/** Rejects malformed objects instead of storing them (e.g. a missing amount would become NaN). */
function assertShape(o: { id?: unknown; amount?: unknown; currency?: unknown; created?: unknown }, kind: string): void {
  const problems = [
    typeof o.id !== 'string' && 'id',
    !(Number.isInteger(o.amount) && (o.amount as number) >= 0) && 'amount',
    !(typeof o.currency === 'string' && /^[a-z]{3}$/i.test(o.currency)) && 'currency',
    !(Number.isInteger(o.created) && (o.created as number) > 0) && 'created',
  ].filter(Boolean);
  if (problems.length) throw new Error(`malformed Stripe ${kind}: invalid ${problems.join(', ')}`);
}

/** Full payment state from a PaymentIntent (optionally with its expanded latest charge). */
export function fromIntent(pi: StripePaymentIntent): PaymentUpsert {
  assertShape(pi, 'payment intent');
  const charge = typeof pi.latest_charge === 'object' && pi.latest_charge ? pi.latest_charge : null;
  const base = intentStatus(pi.status, Boolean(pi.last_payment_error));
  const status = charge ? chargeStatus(base, charge.amount_refunded, charge.amount, charge.disputed) : base;
  return {
    intentId: pi.id,
    chargeId: charge?.id ?? (typeof pi.latest_charge === 'string' ? pi.latest_charge : null),
    stripeCustomerId: pi.customer ?? null,
    amount: fromMinorUnits(pi.amount, pi.currency),
    currency: pi.currency.toUpperCase(),
    method: paymentMethod(charge?.payment_method_details?.type ?? pi.payment_method_types?.[0]),
    status,
    amountRefunded: charge ? fromMinorUnits(charge.amount_refunded, pi.currency) : 0,
    failureReason: pi.last_payment_error?.message ?? charge?.failure_message ?? null,
    receiptUrl: charge?.receipt_url ?? null,
    cardBrand: charge?.payment_method_details?.card?.brand ?? null,
    cardLast4: charge?.payment_method_details?.card?.last4 ?? null,
    paidAt: status === 'succeeded' || status === 'refunded' || status === 'partially_refunded' || status === 'disputed'
      ? iso(charge?.created ?? pi.created)
      : null,
    invoiceId: pi.invoice ?? null,
    match: {
      customerNumber: pi.metadata?.customer_number ?? null,
      appointmentNumber: pi.metadata?.appointment_number ?? null,
      email: pi.receipt_email ?? charge?.billing_details?.email ?? null,
    },
  };
}

/** Payment state from a charge (charge.* events); the intent may not have been seen yet. */
export function fromCharge(charge: StripeCharge): PaymentUpsert | undefined {
  if (!charge.payment_intent) return undefined; // legacy charges without intents are not supported
  assertShape(charge, 'charge');
  const base: PaymentStatus = charge.status === 'succeeded' ? 'succeeded' : charge.status === 'failed' ? 'failed' : 'pending';
  const status = chargeStatus(base, charge.amount_refunded, charge.amount, charge.disputed);
  return {
    intentId: charge.payment_intent,
    chargeId: charge.id,
    stripeCustomerId: charge.customer ?? null,
    amount: fromMinorUnits(charge.amount, charge.currency),
    currency: charge.currency.toUpperCase(),
    method: paymentMethod(charge.payment_method_details?.type),
    status,
    amountRefunded: fromMinorUnits(charge.amount_refunded, charge.currency),
    failureReason: charge.failure_message ?? null,
    receiptUrl: charge.receipt_url ?? null,
    cardBrand: charge.payment_method_details?.card?.brand ?? null,
    cardLast4: charge.payment_method_details?.card?.last4 ?? null,
    paidAt: base === 'succeeded' ? iso(charge.created) : null,
    invoiceId: null,
    match: {
      customerNumber: charge.metadata?.customer_number ?? null,
      appointmentNumber: charge.metadata?.appointment_number ?? null,
      email: charge.billing_details?.email ?? null,
    },
  };
}
