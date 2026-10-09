import { Body, Controller, Get, Put } from '@nestjs/common';
import { z } from 'zod';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';

const PUBLIC_FIELDS = `business_name, default_time_zone, default_currency, default_locale,
  whatsapp_enabled, whatsapp_display_number, freshdesk_portal_url, stripe_enabled`;
const ALL_FIELDS = `${PUBLIC_FIELDS}, chat_retention_days, whatsapp_phone_number_id, whatsapp_otp_template,
  whatsapp_invite_template, whatsapp_template_language, freshdesk_domain, manual_payment_methods,
  bank_transfer_due_days, updated_by, updated_at`;

const updateSchema = z
  .object({
    business_name: z.string().min(1).max(200),
    default_time_zone: z.string().min(1),
    default_currency: z.string().regex(/^[A-Z]{3}$/),
    default_locale: z.string().min(2).max(20),
    chat_retention_days: z.number().int().positive(),
    whatsapp_enabled: z.boolean(),
    whatsapp_phone_number_id: z.string().min(1).nullable(),
    whatsapp_display_number: z.string().regex(/^\+[1-9][0-9]{6,14}$/).nullable(),
    whatsapp_otp_template: z.string().min(1).nullable(),
    whatsapp_invite_template: z.string().min(1).nullable(),
    whatsapp_template_language: z.string().min(2),
    freshdesk_domain: z.string().regex(/^[a-z0-9-]+\.freshdesk\.com$/).nullable(),
    freshdesk_portal_url: z.string().url().nullable(),
    stripe_enabled: z.boolean(),
    manual_payment_methods: z.array(z.enum(['card_pos', 'bank_transfer', 'cash', 'other'])).min(1),
    bank_transfer_due_days: z.number().int().positive(),
  })
  .partial()
  .strict();
type SettingsUpdate = z.infer<typeof updateSchema>;

@Controller()
export class SettingsController {
  constructor(private readonly db: DbService) {}

  /** Display settings for any signed-in principal (time zone, currency, feature toggles). */
  @Get('settings')
  get(@CurrentPrincipal() p: Principal) {
    const fields = p.type === 'employee' && p.access.can('update', 'settings') ? ALL_FIELDS : PUBLIC_FIELDS;
    return this.db.as(p, async (db) => (await db.query(`SELECT ${fields} FROM core.settings WHERE id = 1`)).rows[0]);
  }

  @Put('admin/settings')
  @EmployeesOnly()
  @Can('update', 'settings')
  update(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(updateSchema)) body: SettingsUpdate) {
    const entries = Object.entries(body);
    return this.db.as(p, async (db) => {
      if (entries.length > 0) {
        const sets = entries.map(([k], i) => `${k} = $${i + 1}`).join(', ');
        await db.query(`UPDATE core.settings SET ${sets}, updated_by = $${entries.length + 1} WHERE id = 1`, [
          ...entries.map(([, v]) => v),
          p.id,
        ]);
      }
      // WhatsApp settings are also published to SSM for the Cognito sender Lambda (Phase 3).
      return (await db.query(`SELECT ${ALL_FIELDS} FROM core.settings WHERE id = 1`)).rows[0];
    });
  }
}
