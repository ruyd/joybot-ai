import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { Can, CurrentPrincipal, CustomersOnly, EmployeesOnly, Public, type Principal } from '../auth/principal';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { ZodPipe } from '../common/zod.pipe';
import { APP_POOL, DbService } from '../db/db.module';
import { maskContact, MessagingService } from '../messaging/messaging.service';

const INVITE_DAYS = 14;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

const staffInviteSchema = z.object({ channel: z.enum(['email', 'whatsapp']) }).strict();
const orgInviteSchema = z
  .object({
    first_name: z.string().trim().min(1).max(100),
    last_name: z.string().trim().max(100).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/).optional(),
  })
  .strict()
  .refine((b) => b.email || b.phone, { message: 'email or phone is required' });
const acceptSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

interface InviteTarget {
  id: string;
  first_name: string | null;
  email: string | null;
  phone: string | null;
  whatsapp_opt_in_at: string | null;
  cognito_sub: string | null;
  organization_id: string | null;
  org_role: string | null;
}

/**
 * Portal invites (plan.md §4.3). Staff invite customers by email or WhatsApp (WhatsApp needs the
 * customer's recorded opt-in); org admins add members, who get an email invite. Tokens are random,
 * stored hashed, single-use and expire. Signing up with the invited, verified contact links the
 * account automatically; accepting with a different account goes to staff review.
 */
@Controller()
export class InvitesController {
  constructor(
    private readonly db: DbService,
    private readonly messaging: MessagingService,
    @Inject(APP_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Post('customers/:id/invite')
  @HttpCode(200)
  @EmployeesOnly()
  @Can('update', 'customers')
  async staffInvite(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(staffInviteSchema)) body: z.infer<typeof staffInviteSchema>) {
    return this.db.as(p, async (db) => {
      // Inviting needs permission to *update* this customer, not just read it.
      const target = (
        await db.query<InviteTarget>(
          `SELECT id, first_name, email, phone, whatsapp_opt_in_at, cognito_sub, organization_id, org_role
             FROM core.customers WHERE id = $1 AND authz.customer_in_scope(id, 'customers', 'update')`,
          [id],
        )
      ).rows[0];
      if (!target) throw new NotFoundException('Customer not found');
      return this.invite(db, p, target, body.channel);
    });
  }

  /** Org admins add a member to their organization and email them an invite (when they have an email). */
  @Post('org/invites')
  @CustomersOnly()
  async orgInvite(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(orgInviteSchema)) body: z.infer<typeof orgInviteSchema>) {
    if (p.role !== 'org_admin') throw new ForbiddenException('Only organization admins can add members');
    return this.db.as(p, async (db) => {
      const { id } = (
        await db.query<{ id: string }>('SELECT authz.create_org_member($1, $2, $3, $4) AS id', [
          body.first_name,
          body.last_name ?? null,
          body.email ?? null,
          body.phone ?? null,
        ])
      ).rows[0];
      const target = (await db.query<InviteTarget>(
        'SELECT id, first_name, email, phone, whatsapp_opt_in_at, cognito_sub, organization_id, org_role FROM core.customers WHERE id = $1', [id])).rows[0];
      if (!target.email) {
        // No WhatsApp consent yet for a new member: they can sign up themselves with their phone.
        return { member_id: id, sent: false, reason: 'They can sign up with their phone number; they will join your organization automatically.' };
      }
      return { member_id: id, ...(await this.invite(db, p, target, 'email')) };
    });
  }

  @Delete('org/members/:id')
  @HttpCode(204)
  @CustomersOnly()
  async removeMember(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const removed = await this.db.as(p, async (db) => (await db.query<{ ok: boolean }>('SELECT authz.remove_org_member($1) AS ok', [id])).rows[0].ok);
    if (!removed) throw new NotFoundException('Member not found');
  }

  /** Invite preview for the landing page: who it is for, without revealing contact details. */
  @Get('invites/:token')
  @Public()
  async preview(@Param('token') token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException('Invite not found');
    const row = (await this.pool.query('SELECT * FROM authz.invite_preview($1)', [tokenHash(token)])).rows[0];
    if (!row) throw new NotFoundException('This invite is no longer valid');
    return { business_name: row.business_name, organization: row.organization, channel: row.channel, sent_to: row.sent_to, expires_at: row.expires_at };
  }

  /** Called after sign-in from the invite link. */
  @Post('me/invites/accept')
  @HttpCode(200)
  @CustomersOnly()
  async accept(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(acceptSchema)) body: z.infer<typeof acceptSchema>) {
    // One transaction: the invite is used once, and an accept by another account is queued with it.
    const status = await this.db.as(p, async (db) => {
      const invitedId = (await db.query<{ id: string | null }>('SELECT authz.accept_invite($1) AS id', [tokenHash(body.token)])).rows[0].id;
      if (!invitedId) throw new NotFoundException('This invite is no longer valid');
      if (invitedId === p.id) return 'linked' as const;
      // Signed up with a different email/phone than the one invited: staff decide whether to merge.
      const me = (await db.query<{ cognito_sub: string | null }>('SELECT cognito_sub FROM core.customers WHERE id = $1', [p.id])).rows[0];
      await db.query(
        `INSERT INTO app.link_review_queue (cognito_sub, contact_hash, candidate_customer_id, account_customer_id, reason)
         VALUES ($1, $2, $3, $4, 'invite_accepted_by_other_account')`,
        [me?.cognito_sub ?? `customer:${p.id}`, tokenHash(body.token), invitedId, p.id],
      );
      return 'review' as const;
    });
    return { status };
  }

  // ---------------------------------------------------------------------------------------------

  private async invite(db: PoolClient, p: Principal, target: InviteTarget, channel: 'email' | 'whatsapp') {
    if (target.cognito_sub) throw new BadRequestException('This customer already has a portal account');
    const to = channel === 'email' ? target.email : target.phone;
    if (!to) throw new BadRequestException(`The customer has no ${channel === 'email' ? 'email' : 'phone'} on file`);
    const s = (await db.query('SELECT business_name, whatsapp_enabled, whatsapp_phone_number_id, whatsapp_invite_template, whatsapp_template_language FROM core.settings WHERE id = 1')).rows[0];
    if (channel === 'whatsapp') {
      if (!target.whatsapp_opt_in_at) throw new BadRequestException('The customer has not agreed to WhatsApp messages');
      if (!s.whatsapp_enabled || !s.whatsapp_invite_template) throw new BadRequestException('WhatsApp invites are not set up');
    }
    const token = randomBytes(32).toString('base64url');
    const expires = (
      await db.query<{ expires_at: string }>(
        `INSERT INTO app.invites (token_hash, customer_id, organization_id, org_role, channel, sent_to_hash, sent_to_mask, expires_at, created_by_type, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8), $9, $10) RETURNING expires_at`,
        [tokenHash(token), target.id, target.organization_id, target.org_role, channel, tokenHash(to.toLowerCase()), maskContact(to), INVITE_DAYS, p.type, p.id],
      )
    ).rows[0].expires_at;
    const link = `${await this.messaging.appUrl()}/portal/invite?token=${token}`;
    const name = target.first_name ?? 'there';
    await this.messaging.send(
      channel === 'email'
        ? {
            channel: 'email',
            to,
            template: 'invite',
            subject: `Your ${s.business_name ?? 'JoyBot'} account`,
            text: `Hi ${name},\n\nYou're invited to the ${s.business_name ?? 'JoyBot'} customer portal, where you can see your appointments, payments and support tickets, or just ask the assistant.\n\nCreate your account with this email: ${link}\n\nThe link expires in ${INVITE_DAYS} days.`,
          }
        : {
            channel: 'whatsapp',
            to,
            template: 'invite',
            subject: 'Portal invite',
            text: link,
            whatsapp: {
              phoneNumberId: s.whatsapp_phone_number_id,
              template: s.whatsapp_invite_template,
              language: s.whatsapp_template_language,
              bodyParams: [name, link],
            },
          },
    );
    // The link is only returned in local development (it is never needed by staff otherwise).
    return { sent: true, channel, sent_to: maskContact(to), expires_at: expires, ...(this.cfg.AUTH_MODE === 'dev' ? { dev_link: link } : {}) };
  }
}
