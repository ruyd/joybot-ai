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

type SecretKind = 'api_key' | 'webhook_secret' | 'test_api_key' | 'test_webhook_secret';

/** A secret (sk_) or, better, restricted (rk_) key of the given mode. */
const keySchema = (mode: 'live' | 'test') =>
  z
    .object({
      api_key: z
        .string()
        .trim()
        .regex(new RegExp(`^(sk|rk)_${mode}_[A-Za-z0-9]{16,250}$`), `Paste a ${mode} key: sk_${mode}_… or, better, rk_${mode}_…`),
    })
    .strict();
/** A webhook endpoint's signing secret. */
const webhookSecretSchema = z
  .object({ webhook_secret: z.string().trim().regex(/^whsec_[A-Za-z0-9+/=]{16,250}$/, 'Paste the signing secret (whsec_…) of the webhook endpoint') })
  .strict();
const modeSchema = z.object({ mode: z.enum(['live', 'test']) }).strict();

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

    const secrets = await this.secrets.webhookSecrets();
    if (!secrets.length) throw new ServiceUnavailableException('Stripe webhook secret is not configured');
    const raw = req.rawBody;
    const signedWith = raw ? secrets.find((s) => verifyStripeSignature(raw, signature, s.secret)) : undefined;
    if (!raw || !signedWith) throw new BadRequestException('Invalid Stripe signature');
    // Live and test endpoints both call here: only the mode in use is applied.
    if (signedWith.mode && (signedWith.mode === 'test') !== (await this.secrets.testMode())) {
      return { received: false, reason: `${signedWith.mode} mode event while in ${signedWith.mode === 'test' ? 'live' : 'test'} mode` };
    }

    let event: { id?: unknown; type?: unknown; created?: unknown; livemode?: unknown };
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new BadRequestException('Invalid JSON');
    }
    if (typeof event.id !== 'string' || typeof event.type !== 'string' || !Number.isInteger(event.created)) {
      throw new BadRequestException('Not a Stripe event');
    }
    const stored = await this.pool.query<{ inserted: boolean }>(
      'SELECT authz.store_stripe_event($1, $2, $3, $4, $5) AS inserted',
      [event.id, event.type, event.livemode === true, event.created, raw.toString('utf8')],
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
      const saved = Object.fromEntries(
        (await db.query<{ kind: SecretKind; last4: string | null; set_at: string | null; set_by_name: string | null }>('SELECT * FROM authz.stripe_secret_info()')).rows.map(
          ({ kind, ...rest }) => [kind, rest],
        ),
      );
      return {
        events,
        unmatchedPayments: unmatched,
        lastReconcile: lastJob,
        encryption_available: this.box.available,
        mode: (await this.secrets.testMode()) ? 'test' : 'live',
        /** Where the key and webhook secret of the mode in use come from. */
        active: await this.secrets.sources(),
        api_key: saved.api_key,
        webhook_secret: saved.webhook_secret,
        test_api_key: saved.test_api_key,
        test_webhook_secret: saved.test_webhook_secret,
      };
    });
  }

  /** Saves the live API key (encrypted; only its last four characters are shown again). */
  @Put('admin/stripe/api-key')
  @EmployeesOnly()
  @Can('update', 'settings')
  setKey(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(keySchema('live'))) body: { api_key: string }) {
    return this.saveSecret(p, 'api_key', body.api_key);
  }

  @Delete('admin/stripe/api-key')
  @EmployeesOnly()
  @Can('update', 'settings')
  removeKey(@CurrentPrincipal() p: Principal) {
    return this.saveSecret(p, 'api_key', null);
  }

  @Put('admin/stripe/test-api-key')
  @EmployeesOnly()
  @Can('update', 'settings')
  setTestKey(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(keySchema('test'))) body: { api_key: string }) {
    return this.saveSecret(p, 'test_api_key', body.api_key);
  }

  @Delete('admin/stripe/test-api-key')
  @EmployeesOnly()
  @Can('update', 'settings')
  removeTestKey(@CurrentPrincipal() p: Principal) {
    return this.saveSecret(p, 'test_api_key', null);
  }

  /** Saves the live webhook endpoint's signing secret (encrypted). */
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

  @Put('admin/stripe/test-webhook-secret')
  @EmployeesOnly()
  @Can('update', 'settings')
  setTestWebhookSecret(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(webhookSecretSchema)) body: { webhook_secret: string }) {
    return this.saveSecret(p, 'test_webhook_secret', body.webhook_secret);
  }

  @Delete('admin/stripe/test-webhook-secret')
  @EmployeesOnly()
  @Can('update', 'settings')
  removeTestWebhookSecret(@CurrentPrincipal() p: Principal) {
    return this.saveSecret(p, 'test_webhook_secret', null);
  }

  /** Live or test: which key checkout and reconciling use, and which webhooks are applied. */
  @Put('admin/stripe/mode')
  @EmployeesOnly()
  @Can('update', 'settings')
  async setMode(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(modeSchema)) body: { mode: 'live' | 'test' }) {
    await this.db.as(p, (db) => db.query('UPDATE core.settings SET stripe_test_mode = $1 WHERE id = 1', [body.mode === 'test']));
    this.secrets.forgetSaved();
    return this.status(p);
  }

  private async saveSecret(p: Principal, kind: SecretKind, value: string | null) {
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
