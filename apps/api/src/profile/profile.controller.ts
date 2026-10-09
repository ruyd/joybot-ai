import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Put,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseError } from 'pg';
import { z } from 'zod';
import { CurrentPrincipal, CustomersOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';
import { maskContact, MessagingService } from '../messaging/messaging.service';
import { CUSTOMER_LOGINS, type CustomerLogins } from './customer-logins';

const E164 = /^\+[1-9][0-9]{6,14}$/;
const CODE_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;

const profileSchema = z
  .object({
    first_name: z.string().trim().min(1).max(100),
    last_name: z.string().trim().min(1).max(100),
    time_zone: z.string().min(1).nullable(),
    preferred_location_id: z.string().uuid().nullable(),
    date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    /** Consent for business-initiated WhatsApp messages (invites, reminders). */
    whatsapp_opt_in: z.boolean(),
  })
  .partial()
  .strict();

const contactSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('email'), value: z.string().trim().toLowerCase().email() }).strict(),
  z.object({ type: z.literal('phone'), value: z.string().trim().regex(E164, 'phone must be E.164, e.g. +12125550101') }).strict(),
]);

const verifySchema = z.object({ verification_id: z.string().uuid(), code: z.string().regex(/^\d{6}$/) }).strict();

const PROFILE_COLUMNS = `id, customer_number, first_name, last_name, email, email_verified, phone, phone_verified,
  time_zone, preferred_location_id, date_of_birth, organization_id, org_role, whatsapp_opt_in_at, profile_completed_at`;

const codeHash = (verificationId: string, code: string) => createHash('sha256').update(`${verificationId}:${code}`).digest();

/**
 * Customer self-service (plan.md §4.3): profile fields, and adding or changing email/phone with a
 * one-time code (email via SES, phone via WhatsApp). Contacts only change once verified, and the
 * Cognito login is updated so the customer can sign in with either.
 */
@Controller('me')
@CustomersOnly()
export class ProfileController {
  constructor(
    private readonly db: DbService,
    private readonly messaging: MessagingService,
    @Inject(CUSTOMER_LOGINS) private readonly logins: CustomerLogins,
  ) {}

  @Put()
  update(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(profileSchema)) body: z.infer<typeof profileSchema>) {
    const { whatsapp_opt_in, ...fields } = body;
    const sets = Object.keys(fields).map((k, i) => `${k} = $${i + 2}`);
    if (whatsapp_opt_in !== undefined) sets.push(`whatsapp_opt_in_at = ${whatsapp_opt_in ? 'coalesce(whatsapp_opt_in_at, now())' : 'NULL'}`);
    return this.db.as(p, async (db) => {
      if (fields.preferred_location_id && !(await db.query('SELECT 1 FROM core.locations WHERE id = $1 AND active', [fields.preferred_location_id])).rowCount) {
        throw new BadRequestException('Unknown location');
      }
      if (sets.length) await db.query(`UPDATE core.customers SET ${sets.join(', ')} WHERE id = $1`, [p.id, ...Object.values(fields)]);
      return this.completeProfile(db, p.id);
    });
  }

  /** Sends a 6-digit code to a new email (SES) or phone (WhatsApp). */
  @Post('contacts')
  @HttpCode(200)
  async requestCode(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(contactSchema)) body: z.infer<typeof contactSchema>) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const { verificationId, expiresAt, whatsapp } = await this.db.as(p, async (db) => {
      const me = (await db.query('SELECT email, email_verified, phone, phone_verified FROM core.customers WHERE id = $1', [p.id])).rows[0];
      if ((body.type === 'email' && me.email === body.value && me.email_verified) || (body.type === 'phone' && me.phone === body.value && me.phone_verified)) {
        throw new BadRequestException('This contact is already verified on your account');
      }
      const recent = (await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM app.contact_verifications WHERE customer_id = $1 AND created_at > now() - interval '1 hour'`, [p.id])).rows[0].n;
      if (recent >= MAX_CODES_PER_HOUR) throw new BadRequestException('Too many codes requested. Please try again later.');
      const s = (await db.query('SELECT whatsapp_enabled, whatsapp_phone_number_id, whatsapp_otp_template, whatsapp_template_language FROM core.settings WHERE id = 1')).rows[0];
      if (body.type === 'phone' && !s.whatsapp_enabled) throw new ServiceUnavailableException('Phone verification is not available yet. Please use email.');
      const row = (await db.query<{ id: string; expires_at: string }>(
        `INSERT INTO app.contact_verifications (customer_id, type, value, code_hash, expires_at)
         VALUES ($1, $2, $3, 'pending', now() + make_interval(mins => $4)) RETURNING id, expires_at`,
        [p.id, body.type, body.value, CODE_TTL_MIN],
      )).rows[0];
      await db.query('UPDATE app.contact_verifications SET code_hash = $2 WHERE id = $1', [row.id, codeHash(row.id, code).toString('hex')]);
      return { verificationId: row.id, expiresAt: row.expires_at, whatsapp: s };
    });

    await this.messaging.send(
      body.type === 'email'
        ? { channel: 'email', to: body.value, template: 'contact_code', subject: 'Your verification code', text: `Your code is ${code}. It expires in ${CODE_TTL_MIN} minutes. If you did not ask for it, ignore this email.` }
        : {
            channel: 'whatsapp',
            to: body.value,
            template: 'contact_code',
            subject: 'Verification code',
            text: `Your code is ${code}.`,
            whatsapp: {
              phoneNumberId: whatsapp.whatsapp_phone_number_id,
              template: whatsapp.whatsapp_otp_template,
              language: whatsapp.whatsapp_template_language,
              bodyParams: [code],
              buttonParam: code,
            },
          },
    );
    return { verification_id: verificationId, expires_at: expiresAt, sent_to: maskContact(body.value), channel: body.type === 'email' ? 'email' : 'whatsapp' };
  }

  @Post('contacts/verify')
  @HttpCode(200)
  async verify(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(verifySchema)) body: z.infer<typeof verifySchema>) {
    // Count the attempt in its own transaction so a wrong code is never rolled back.
    const v = await this.db.as(p, async (db) => {
      const row = (
        await db.query<{ id: string; type: 'email' | 'phone'; value: string; code_hash: string; attempts: number; expired: boolean; verified_at: string | null }>(
          `UPDATE app.contact_verifications SET attempts = attempts + 1
            WHERE id = $1 RETURNING id, type, value, code_hash, attempts, expires_at < now() AS expired, verified_at`,
          [body.verification_id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Verification not found');
      return row;
    });
    if (v.verified_at) throw new BadRequestException('This code was already used');
    if (v.expired) throw new BadRequestException('This code has expired. Please request a new one.');
    if (v.attempts > MAX_ATTEMPTS) throw new ForbiddenException('Too many attempts. Please request a new code.');
    const expected = Buffer.from(v.code_hash, 'hex');
    const given = codeHash(v.id, body.code);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new BadRequestException('That code is not correct');

    try {
      return await this.db.as(p, async (db) => {
        await db.query('UPDATE app.contact_verifications SET verified_at = now() WHERE id = $1', [v.id]);
        const columns = v.type === 'email' ? 'email = $2, email_verified = true' : 'phone = $2, phone_verified = true';
        const me = (await db.query<{ cognito_sub: string | null }>(`UPDATE core.customers SET ${columns} WHERE id = $1 RETURNING cognito_sub`, [p.id, v.value])).rows[0];
        // Inside the transaction: if Cognito refuses, the contact change is rolled back too.
        if (me.cognito_sub) await this.logins.setVerifiedContact(me.cognito_sub, v.type, v.value);
        return this.completeProfile(db, p.id);
      });
    } catch (err) {
      if (err instanceof DatabaseError && err.code === '23505') throw new ConflictException('This contact is already used by another account');
      throw err;
    }
  }

  /** Marks the profile complete once name + a verified contact exist. */
  private async completeProfile(db: PoolClient, id: string) {
    return (
      await db.query(
        `UPDATE core.customers
            SET profile_completed_at = coalesce(profile_completed_at,
                  CASE WHEN first_name IS NOT NULL AND last_name IS NOT NULL AND (email_verified OR phone_verified) THEN now() END)
          WHERE id = $1 RETURNING ${PROFILE_COLUMNS}`,
        [id],
      )
    ).rows[0];
  }
}
