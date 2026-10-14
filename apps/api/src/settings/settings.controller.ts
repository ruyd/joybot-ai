import { Body, Controller, Get, Put } from '@nestjs/common';
import { z } from 'zod';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';
import { WhatsAppSettingsPublisher } from './whatsapp-publisher';

const PUBLIC_FIELDS = `business_name, default_time_zone, default_currency, default_locale,
  whatsapp_enabled, whatsapp_display_number, stripe_enabled, assistant_customers, assistant_employees`;
const ALL_FIELDS = `${PUBLIC_FIELDS}, chat_retention_days, whatsapp_phone_number_id, whatsapp_otp_template,
  whatsapp_invite_template, whatsapp_template_language, manual_payment_methods,
  bank_transfer_due_days, chat_daily_limit_customer, chat_daily_limit_employee, team_chat_retention, invoice_due_days, bank_transfer_instructions,
  stripe_reconcile_interval_hours, stripe_reconcile_days, updated_by, updated_at`;

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
    stripe_enabled: z.boolean(),
    /** Settings › Stripe: how often the worker reconciles on its own, and how many days back. */
    stripe_reconcile_interval_hours: z.number().int().min(1).max(168),
    stripe_reconcile_days: z.number().int().min(1).max(90),
    manual_payment_methods: z.array(z.enum(['card_pos', 'bank_transfer', 'cash', 'other'])).min(1),
    bank_transfer_due_days: z.number().int().positive(),
    chat_daily_limit_customer: z.number().int().min(1).max(10_000),
    chat_daily_limit_employee: z.number().int().min(1).max(100_000),
    /** Team chat: messages kept per channel (older ones are deleted). */
    team_chat_retention: z.number().int().min(10).max(10_000),
    /** Invoices: days to pay (due date when sent) and what customers see under "Pay by bank transfer". */
    invoice_due_days: z.number().int().min(0).max(365),
    bank_transfer_instructions: z.string().trim().max(2000).nullable(),
    /** Admin › AI: the assistant is shown (and answers) in the portal / the staff console. */
    assistant_customers: z.boolean(),
    assistant_employees: z.boolean(),
  })
  .partial()
  .strict();
type SettingsUpdate = z.infer<typeof updateSchema>;

@Controller()
export class SettingsController {
  constructor(
    private readonly db: DbService,
    private readonly whatsapp: WhatsAppSettingsPublisher,
  ) {}

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
      const row = (await db.query(`SELECT ${ALL_FIELDS} FROM core.settings WHERE id = 1`)).rows[0];
      // Inside the transaction: if publishing fails, the settings change is rolled back too.
      if (entries.some(([k]) => k.startsWith('whatsapp_'))) await this.whatsapp.publish(row);
      return row;
    });
  }
}
