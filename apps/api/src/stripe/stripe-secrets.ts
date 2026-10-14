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
 * Stripe secrets. The live and test API keys and webhook signing secrets saved in Settings › Stripe
 * (encrypted in the database) come first, the key of the mode in use; else the environment locally, or
 * the Stripe secret (Secrets Manager) in AWS.
 */
@Injectable()
export class StripeSecrets {
  private readonly client = new SecretsManagerClient({});
  private cache?: { value: StripeSecret; at: number };
  private saved?: { key: string | undefined; testMode: boolean; liveWebhook: string | undefined; testWebhook: string | undefined; at: number };

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly box: SecretBox,
  ) {}

  /**
   * The signing secrets a webhook may be signed with, each with the mode it belongs to: the live and
   * test ones saved in Settings › Stripe; only while neither is saved, the server's (mode unknown).
   */
  async webhookSecrets(): Promise<{ secret: string; mode: 'live' | 'test' | null }[]> {
    const saved = await this.savedSecrets();
    const mine = [
      ...(saved.liveWebhook ? [{ secret: saved.liveWebhook, mode: 'live' as const }] : []),
      ...(saved.testWebhook ? [{ secret: saved.testWebhook, mode: 'test' as const }] : []),
    ];
    if (mine.length) return mine;
    const server = await this.configuredWebhookSecret();
    return server ? [{ secret: server, mode: null }] : [];
  }

  /** Settings › Stripe: test mode uses the test key and applies only test-mode webhooks. */
  async testMode(): Promise<boolean> {
    return (await this.savedSecrets()).testMode;
  }

  /** The API key of the mode in use, else the server's. */
  async checkoutKey(): Promise<string | undefined> {
    return (await this.savedSecrets()).key ?? (await this.configuredCheckoutKey());
  }

  /** Where the key and the webhook secret in use (this mode) come from, for Settings › Stripe. */
  async sources(): Promise<{ api_key: Source; webhook_secret: Source }> {
    const saved = await this.savedSecrets();
    const source = async (inSettings: unknown, configured: () => Promise<string | undefined>): Promise<Source> =>
      inSettings ? 'settings' : (await configured().catch(() => undefined)) ? 'server' : null;
    return {
      api_key: await source(saved.key, () => this.configuredCheckoutKey()),
      webhook_secret: await source(saved.testMode ? saved.testWebhook : saved.liveWebhook, () => this.configuredWebhookSecret()),
    };
  }

  /** After a secret is saved or removed, or the mode switched. */
  forgetSaved() {
    this.saved = undefined;
  }

  private async savedSecrets() {
    if (this.saved && Date.now() - this.saved.at < 60_000) return this.saved;
    const row = (
      await this.pool.query<{ k: string | null; test_mode: boolean | null; live_cipher: string | null; test_cipher: string | null }>(
        'SELECT authz.stripe_key_cipher() AS k, w.* FROM authz.stripe_webhook_secrets() w',
      )
    ).rows[0];
    const open = (cipher: string | null | undefined) => (cipher ? this.box.decrypt(cipher) : undefined);
    this.saved = { key: open(row?.k), testMode: row?.test_mode ?? false, liveWebhook: open(row?.live_cipher), testWebhook: open(row?.test_cipher), at: Date.now() };
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
