import type { StripePaymentIntent } from './mapping';

/** Minimal read-only Stripe REST client (restricted key: read PaymentIntents and Charges). */
export class StripeApi {
  constructor(
    private readonly key: string,
    private readonly baseUrl = 'https://api.stripe.com',
  ) {}

  /** PaymentIntents created since `since`, newest first, with their latest charge expanded. */
  async *paymentIntentsSince(since: Date): AsyncIterable<StripePaymentIntent> {
    let startingAfter: string | undefined;
    for (;;) {
      const params = new URLSearchParams({ limit: '100', 'created[gte]': String(Math.floor(since.getTime() / 1000)) });
      params.append('expand[]', 'data.latest_charge');
      if (startingAfter) params.set('starting_after', startingAfter);
      const res = await fetch(`${this.baseUrl}/v1/payment_intents?${params}`, {
        headers: { authorization: `Bearer ${this.key}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`Stripe API returned ${res.status}`);
      const page = (await res.json()) as { data: StripePaymentIntent[]; has_more: boolean };
      for (const pi of page.data) yield pi;
      if (!page.has_more || page.data.length === 0) return;
      startingAfter = page.data[page.data.length - 1].id;
    }
  }
}
