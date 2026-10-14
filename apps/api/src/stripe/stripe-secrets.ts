import { Inject, Injectable } from '@nestjs/common';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Pool } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { APP_POOL } from '../db/db.module';
import { SecretBox } from '../email/secret-box';

type Source = 'settings' | 'server' | null;

interface StripeSecret {
  webhookSigningSecret?: string;
  /** Restricted key that may create Checkout Sessions (invoice card payments). */
  checkoutKey?: string;
}

/**
 * Stripe secrets. The API key and webhook signing secret saved in Settings › Stripe (encrypted in the
 * database) come first; else the environment locally, or the Stripe secret (Secrets Manager) in AWS.
 */
@Injectable()
export class StripeSecrets {
  private readonly client = new SecretsManagerClient({});
  private cache?: { value: StripeSecret; at: number };
  private saved?: { key: string | undefined; webhook: string | undefined; at: number };

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly box: SecretBox,
  ) {}

  async webhookSigningSecret(): Promise<string | undefined> {
    return (await this.savedSecrets()).webhook ?? (await this.configuredWebhookSecret());
  }

  async checkoutKey(): Promise<string | undefined> {
    return (await this.savedSecrets()).key ?? (await this.configuredCheckoutKey());
  }

  /** Where the key and the webhook secret in use come from, for Settings › Stripe. */
  async sources(): Promise<{ api_key: Source; webhook_secret: Source }> {
    const saved = await this.savedSecrets();
    const source = async (inSettings: unknown, configured: () => Promise<string | undefined>): Promise<Source> =>
      inSettings ? 'settings' : (await configured().catch(() => undefined)) ? 'server' : null;
    return {
      api_key: await source(saved.key, () => this.configuredCheckoutKey()),
      webhook_secret: await source(saved.webhook, () => this.configuredWebhookSecret()),
    };
  }

  /** After a secret is saved or removed. */
  forgetSaved() {
    this.saved = undefined;
  }

  private async savedSecrets() {
    if (this.saved && Date.now() - this.saved.at < 60_000) return this.saved;
    const row = (await this.pool.query<{ k: string | null; w: string | null }>('SELECT authz.stripe_key_cipher() AS k, authz.stripe_webhook_cipher() AS w')).rows[0];
    this.saved = { key: row?.k ? this.box.decrypt(row.k) : undefined, webhook: row?.w ? this.box.decrypt(row.w) : undefined, at: Date.now() };
    return this.saved;
  }

  private async configuredWebhookSecret(): Promise<string | undefined> {
    if (this.cfg.STRIPE_WEBHOOK_SECRET) return this.cfg.STRIPE_WEBHOOK_SECRET;
    return (await this.secret())?.webhookSigningSecret || undefined;
  }

  private async configuredCheckoutKey(): Promise<string | undefined> {
    if (this.cfg.STRIPE_CHECKOUT_KEY) return this.cfg.STRIPE_CHECKOUT_KEY;
    return (await this.secret())?.checkoutKey || undefined;
  }

  private async secret(): Promise<StripeSecret | undefined> {
    if (!this.cfg.STRIPE_SECRET_ARN) return undefined;
    if (this.cache && Date.now() - this.cache.at < 5 * 60_000) return this.cache.value;
    const res = await this.client.send(new GetSecretValueCommand({ SecretId: this.cfg.STRIPE_SECRET_ARN }));
    const value = JSON.parse(res.SecretString ?? '{}') as StripeSecret;
    this.cache = { value, at: Date.now() };
    return value;
  }
}
