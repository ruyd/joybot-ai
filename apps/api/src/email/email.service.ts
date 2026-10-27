import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Principal } from '../auth/principal';
import { APP_POOL, DbService } from '../db/db.module';
import { assertResendKey, ResendClient, ResendError, type ResendDomain, type ResendUsage } from './resend';
import { SecretBox } from './secret-box';

const email = z.string().trim().toLowerCase().email().max(254);
const optionalEmail = email.nullable().or(z.literal('').transform(() => null));

export const emailSettingsSchema = z
  .object({
    from_name: z
      .string()
      .trim()
      .max(80)
      .regex(/^[^<>"\r\n]*$/, 'No <, >, " or line breaks in the name')
      .nullable()
      .transform((v) => v || null),
    from_email: optionalEmail,
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

export const apiKeySchema = z.object({ api_key: z.string().trim().min(1).max(300) }).strict();
export const testEmailSchema = z.object({ to: email }).strict();

export type EmailSettingsInput = z.infer<typeof emailSettingsSchema>;

export interface EmailSettings {
  /** Resend sends the app's email: a key and a from address are saved. */
  active: boolean;
  resend_key_last4: string | null;
  resend_key_set_at: string | null;
  from_name: string | null;
  from_email: string | null;
  updated_at: string;
  /** Secrets can be stored (SETTINGS_ENCRYPTION_KEY set, or local development). */
  encryption_available: boolean;
}

/** What sending needs: the decrypted key and the sender. */
export interface ResendDelivery {
  key: string;
  from: string;
}

const COLUMNS = '(resend_key_last4 IS NOT NULL AND from_email IS NOT NULL) AS active, resend_key_last4, resend_key_set_at, from_name, from_email::text AS from_email, updated_at';

/**
 * Email through Resend (Admin › Email): the settings, the API key (encrypted at rest, never returned),
 * Resend's usage and domains for the admin page, a test email, and what sending uses.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger('Email');
  private cache?: { value: ResendDelivery | null; at: number };

  constructor(
    private readonly db: DbService,
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly box: SecretBox,
    private readonly resend: ResendClient,
  ) {}

  getSettings(p: Principal): Promise<EmailSettings> {
    return this.db.as(p, async (db) => {
      const row = (await db.query(`SELECT ${COLUMNS} FROM core.email_settings WHERE id = 1`)).rows[0];
      if (!row) throw new NotFoundException();
      return { ...row, encryption_available: this.box.available };
    });
  }

  async updateSettings(p: Principal, input: EmailSettingsInput): Promise<EmailSettings> {
    const cols = Object.keys(input) as (keyof EmailSettingsInput)[];
    await this.db.as(p, (db) => db.query(`UPDATE core.email_settings SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = 1`, cols.map((c) => input[c])));
    this.cache = undefined;
    return this.getSettings(p);
  }

  /** Checks the key with Resend (a sending-only key is fine), then stores it encrypted. */
  async setKey(p: Principal, key: string): Promise<EmailSettings> {
    assertResendKey(key);
    try {
      await this.resend.domains(key);
    } catch (err) {
      const restricted = err instanceof ResendError && (err.getResponse() as { code?: string }).code === 'restricted_api_key';
      if (!restricted) throw err;
    }
    await this.db.as(p, (db) => db.query('SELECT authz.set_resend_key($1, $2)', [this.box.encrypt(key), key.slice(-4)]));
    this.cache = undefined;
    return this.getSettings(p);
  }

  async removeKey(p: Principal): Promise<EmailSettings> {
    await this.db.as(p, (db) => db.query('SELECT authz.set_resend_key(NULL, NULL)'));
    this.cache = undefined;
    return this.getSettings(p);
  }

  async usage(): Promise<ResendUsage> {
    return this.resend.usage(await this.key());
  }

  async domains(): Promise<ResendDomain[]> {
    return this.resend.domains(await this.key());
  }

  /** Sends a test email with the saved key, from the saved address or else Resend's testing sender. */
  async sendTest(to: string): Promise<{ id: string; from: string }> {
    const settings = await this.stored();
    if (!settings.cipher) throw new BadRequestException('Add an API key first');
    const from = settings.from_email ? fromHeader(settings.from_name, settings.from_email) : fromHeader(settings.from_name, RESEND_TEST_SENDER);
    const res = await this.resend.send(this.box.decrypt(settings.cipher), {
      from,
      to: [to],
      subject: 'Test email from JoyBot',
      text: `This is a test email from JoyBot.\n\nIf you can read this, email through Resend works.`,
      tags: [{ name: 'template', value: 'test' }],
    });
    return { id: res.id, from };
  }

  /** For sending: Resend's key and sender once both are saved (cached for 30 seconds), else null. */
  async delivery(): Promise<ResendDelivery | null> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.value;
    const s = await this.stored();
    let value: ResendDelivery | null = null;
    if (s.cipher && s.from_email) {
      try {
        value = { key: this.box.decrypt(s.cipher), from: fromHeader(s.from_name, s.from_email) };
      } catch (err) {
        this.logger.error(`Resend key cannot be decrypted (was SETTINGS_ENCRYPTION_KEY changed?): ${(err as Error).message}`);
      }
    }
    this.cache = { value, at: Date.now() };
    return value;
  }

  // ---------------------------------------------------------------------------------------------

  private async stored() {
    const row = (
      await this.pool.query<{ resend_key_cipher: string | null; from_name: string | null; from_email: string | null }>(
        'SELECT * FROM authz.email_delivery()',
      )
    ).rows[0];
    return { ...row, cipher: row?.resend_key_cipher ?? null };
  }

  private async key(): Promise<string> {
    const { cipher } = await this.stored();
    if (!cipher) throw new BadRequestException('Add an API key first');
    return this.box.decrypt(cipher);
  }
}

/** Resend's testing sender: works before a domain is verified, but only to the account's own address. */
export const RESEND_TEST_SENDER = 'onboarding@resend.dev';

/** "Acme <hello@example.com>", or just the address. */
export const fromHeader = (name: string | null, address: string) => (name ? `${name} <${address}>` : address);
