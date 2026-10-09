import { Inject, Injectable } from '@nestjs/common';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { APP_CONFIG, type AppConfig } from '../config/config';

/** Webhook signing secret: STRIPE_WEBHOOK_SECRET locally, the Stripe secret (Secrets Manager) in AWS. */
@Injectable()
export class StripeSecrets {
  private readonly client = new SecretsManagerClient({});
  private cache?: { value: string | undefined; at: number };

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  async webhookSigningSecret(): Promise<string | undefined> {
    if (this.cfg.STRIPE_WEBHOOK_SECRET) return this.cfg.STRIPE_WEBHOOK_SECRET;
    if (!this.cfg.STRIPE_SECRET_ARN) return undefined;
    if (this.cache && Date.now() - this.cache.at < 5 * 60_000) return this.cache.value;
    const res = await this.client.send(new GetSecretValueCommand({ SecretId: this.cfg.STRIPE_SECRET_ARN }));
    const value = JSON.parse(res.SecretString ?? '{}').webhookSigningSecret || undefined;
    this.cache = { value, at: Date.now() };
    return value;
  }
}
