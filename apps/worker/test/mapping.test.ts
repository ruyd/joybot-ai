import { describe, expect, it } from 'vitest';
import { chargeStatus, fromIntent, fromMinorUnits, intentStatus, paymentMethod } from '../src/stripe/mapping';

describe('Stripe mapping', () => {
  it('converts minor units, including zero-decimal currencies', () => {
    expect(fromMinorUnits(12050, 'usd')).toBe(120.5);
    expect(fromMinorUnits(5000, 'jpy')).toBe(5000);
  });

  it('maps intent statuses (a failed attempt is "failed", an abandoned one "pending")', () => {
    expect(intentStatus('requires_payment_method', true)).toBe('failed');
    expect(intentStatus('requires_payment_method', false)).toBe('pending');
    expect(intentStatus('succeeded', false)).toBe('succeeded');
  });

  it('lets refunds and disputes override success', () => {
    expect(chargeStatus('succeeded', 5000, 5000, false)).toBe('refunded');
    expect(chargeStatus('succeeded', 1000, 5000, false)).toBe('partially_refunded');
    expect(chargeStatus('succeeded', 0, 5000, true)).toBe('disputed');
  });

  it('rejects malformed objects', () => {
    expect(() => fromIntent({ id: 'pi_x', object: 'payment_intent', status: 'succeeded', created: 1, currency: 'usd' } as never)).toThrow(/invalid amount/);
    expect(() => fromIntent({ id: 'pi_x', object: 'payment_intent', amount: 10.5, status: 'succeeded', created: 1, currency: 'dollars' } as never)).toThrow(/amount, currency/);
  });

  it('maps payment method types', () => {
    expect(paymentMethod('card')).toBe('card_online');
    expect(paymentMethod('us_bank_account')).toBe('bank_transfer');
    expect(paymentMethod('link')).toBe('wallet');
  });

  it('reads card details and receipt from an expanded charge', () => {
    const u = fromIntent({
      id: 'pi_1', object: 'payment_intent', amount: 5000, currency: 'usd', status: 'succeeded', created: 1760000000,
      metadata: { customer_number: 'C-10001' },
      latest_charge: {
        id: 'ch_1', object: 'charge', payment_intent: 'pi_1', amount: 5000, amount_refunded: 0, currency: 'usd',
        created: 1760000100, status: 'succeeded', disputed: false, receipt_url: 'https://pay.stripe.com/r/1',
        payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242' } },
      },
    });
    expect(u).toMatchObject({
      amount: 50, currency: 'USD', status: 'succeeded', chargeId: 'ch_1', cardBrand: 'visa', cardLast4: '4242',
      receiptUrl: 'https://pay.stripe.com/r/1', paidAt: '2025-10-09T08:55:00.000Z', match: { customerNumber: 'C-10001' },
    });
  });
});
