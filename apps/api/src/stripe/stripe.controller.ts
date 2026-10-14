import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  Put,
  Req,
  ServiceUnavailableException,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { Can, CurrentPrincipal, EmployeesOnly, Public, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { DbService, APP_POOL } from '../db/db.module';
import { SecretBox } from '../email/secret-box';
import { verifyStripeSignature } from './signature';
import { StripeSecrets } from './stripe-secrets';

/** A secret (sk_) or, better, restricted (rk_) key, live or test. */
const stripeKeySchema = z
  .object({ api_key: z.string().trim().regex(/^(sk|rk)_(live|test)_[A-Za-z0-9]{16,250}$/, 'Paste a Stripe secret key (sk_…) or restricted key (rk_…)') })
  .strict();
/** The webhook endpoint's signing secret. */
const webhookSecretSchema = z
  .object({ webhook_secret: z.string().trim().regex(/^whsec_[A-Za-z0-9+/=]{16,250}$/, 'Paste the signing secret (whsec_…) of the webhook endpoint') })
  .strict();

/**
 * Stripe sync, API side (plan.md §4.4): the webhook verifies and stores events; the worker applies
 * them. Staff/admin endpoints show sync status and request reconciliation.
 */
@Controller()
export class StripeController {
  constructor(
    private readonly secrets: StripeSecrets,
    private readonly box: SecretBox,
    private readonly db: DbService,
    @Inject(APP_POOL) private readonly pool: Pool,
  ) {}

  @Post('webhooks/stripe')
  @Public()
  @HttpCode(200)
  async webhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature?: string) {
    const enabled = (await this.pool.query<{ on: boolean }>('SELECT authz.stripe_enabled() AS on')).rows[0].on;
    // Acknowledge so Stripe stops retrying while the integration is switched off.
    if (!enabled) return { received: false, reason: 'stripe disabled' };

    const secret = await this.secrets.webhookSigningSecret();
    if (!secret) throw new ServiceUnavailableException('Stripe webhook secret is not configured');
    if (!req.rawBody || !verifyStripeSignature(req.rawBody, signature, secret)) {
      throw new BadRequestException('Invalid Stripe signature');
    }

    let event: { id?: unknown; type?: unknown; created?: unknown; livemode?: unknown };
    try {
      event = JSON.parse(req.rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Invalid JSON');
    }
    if (typeof event.id !== 'string' || typeof event.type !== 'string' || !Number.isInteger(event.created)) {
      throw new BadRequestException('Not a Stripe event');
    }
    const stored = await this.pool.query<{ inserted: boolean }>(
      'SELECT authz.store_stripe_event($1, $2, $3, $4, $5) AS inserted',
      [event.id, event.type, event.livemode === true, event.created, req.rawBody.toString('utf8')],
    );
    return { received: true, duplicate: !stored.rows[0].inserted };
  }

  /** Sync health for admins: event backlog, failures, unmatched payments, last reconciliation. */
  @Get('admin/stripe/status')
  @EmployeesOnly()
  @Can('update', 'settings')
  status(@CurrentPrincipal() p: Principal) {
    return this.db.as(p, async (db) => {
      const events = (
        await db.query(
          `SELECT status, count(*)::int AS count, max(received_at) AS last_received
             FROM app.stripe_events GROUP BY status ORDER BY status`,
        )
      ).rows;
      const unmatched = (await db.query(`SELECT count(*)::int AS n FROM core.payments WHERE source = 'stripe' AND customer_id IS NULL`)).rows[0].n;
      const lastJob = (
        await db.query(`SELECT status, result, requested_at, finished_at FROM app.worker_jobs WHERE kind = 'stripe_reconcile' ORDER BY requested_at DESC LIMIT 1`)
      ).rows[0] ?? null;
      const i = (await db.query('SELECT * FROM authz.stripe_secret_info()')).rows[0];
      const sources = await this.secrets.sources();
      return {
        events,
        unmatchedPayments: unmatched,
        lastReconcile: lastJob,
        encryption_available: this.box.available,
        api_key: { last4: i.api_key_last4, set_at: i.api_key_set_at, set_by_name: i.api_key_set_by_name, source: sources.api_key },
        webhook_secret: { last4: i.webhook_secret_last4, set_at: i.webhook_secret_set_at, set_by_name: i.webhook_secret_set_by_name, source: sources.webhook_secret },
      };
    });
  }

  /** Saves the Stripe API key (encrypted; only its last four characters are shown again). */
  @Put('admin/stripe/api-key')
  @EmployeesOnly()
  @Can('update', 'settings')
  setKey(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(stripeKeySchema)) body: { api_key: string }) {
    return this.saveSecret(p, 'api_key', body.api_key);
  }

  @Delete('admin/stripe/api-key')
  @EmployeesOnly()
  @Can('update', 'settings')
  removeKey(@CurrentPrincipal() p: Principal) {
    return this.saveSecret(p, 'api_key', null);
  }

  /** Saves the webhook signing secret (encrypted; only its last four characters are shown again). */
  @Put('admin/stripe/webhook-secret')
  @EmployeesOnly()
  @Can('update', 'settings')
  setWebhookSecret(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(webhookSecretSchema)) body: { webhook_secret: string }) {
    return this.saveSecret(p, 'webhook_secret', body.webhook_secret);
  }

  @Delete('admin/stripe/webhook-secret')
  @EmployeesOnly()
  @Can('update', 'settings')
  removeWebhookSecret(@CurrentPrincipal() p: Principal) {
    return this.saveSecret(p, 'webhook_secret', null);
  }

  private async saveSecret(p: Principal, kind: 'api_key' | 'webhook_secret', value: string | null) {
    await this.db.as(p, (db) =>
      db.query('SELECT authz.set_stripe_secret($1, $2, $3)', [kind, value === null ? null : this.box.encrypt(value), value === null ? null : value.slice(-4)]),
    );
    this.secrets.forgetSaved();
    return this.status(p);
  }

  @Post('admin/stripe/reconcile')
  @HttpCode(202)
  @EmployeesOnly()
  @Can('update', 'settings')
  reconcile(@CurrentPrincipal() p: Principal, @Body() body: { days?: number } = {}) {
    // Without `days`, the worker looks back as far as Settings › Stripe says.
    const days = body?.days === undefined ? undefined : Number(body.days);
    if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 90)) throw new BadRequestException('days must be 1–90');
    return this.db.as(p, async (db) =>
      (
        await db.query(
          `INSERT INTO app.worker_jobs (kind, params, requested_by) VALUES ('stripe_reconcile', $1, $2) RETURNING id, status, requested_at`,
          [days === undefined ? {} : { days }, p.id],
        )
      ).rows[0],
    );
  }
}
