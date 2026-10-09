import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  ServiceUnavailableException,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Pool } from 'pg';
import { Can, CurrentPrincipal, EmployeesOnly, Public, type Principal } from '../auth/principal';
import { DbService, APP_POOL } from '../db/db.module';
import { verifyStripeSignature } from './signature';
import { StripeSecrets } from './stripe-secrets';

/**
 * Stripe sync, API side (plan.md §4.4): the webhook verifies and stores events; the worker applies
 * them. Staff/admin endpoints show sync status and request reconciliation.
 */
@Controller()
export class StripeController {
  constructor(
    private readonly secrets: StripeSecrets,
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
    const stored = await this.pool.query(
      `INSERT INTO app.stripe_events (event_id, type, livemode, created, payload)
       VALUES ($1, $2, $3, to_timestamp($4), $5::jsonb) ON CONFLICT (event_id) DO NOTHING`,
      [event.id, event.type, event.livemode === true, event.created, req.rawBody.toString('utf8')],
    );
    return { received: true, duplicate: stored.rowCount === 0 };
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
      return { events, unmatchedPayments: unmatched, lastReconcile: lastJob };
    });
  }

  @Post('admin/stripe/reconcile')
  @HttpCode(202)
  @EmployeesOnly()
  @Can('update', 'settings')
  reconcile(@CurrentPrincipal() p: Principal, @Body() body: { days?: number } = {}) {
    const days = Number(body?.days ?? 3);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new BadRequestException('days must be 1–90');
    return this.db.as(p, async (db) =>
      (
        await db.query(
          `INSERT INTO app.worker_jobs (kind, params, requested_by) VALUES ('stripe_reconcile', $1, $2) RETURNING id, status, requested_at`,
          [{ days }, p.id],
        )
      ).rows[0],
    );
  }
}
