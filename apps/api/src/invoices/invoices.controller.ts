import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Can, CurrentPrincipal, CustomersOnly, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';
import { maskContact, MessagingService } from '../messaging/messaging.service';
import { INVOICE_CHECKOUT, type InvoiceCheckout } from './checkout';

const money = z.coerce.number().min(0).multipleOf(0.01).max(1_000_000);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

const lineSchema = z
  .object({
    description: z.string().trim().min(1).max(300),
    quantity: z.coerce.number().positive().multipleOf(0.01).max(10_000).default(1),
    unit_price: money,
    service_id: z.string().uuid().nullable().optional(),
    appointment_id: z.string().uuid().nullable().optional(),
  })
  .strict();

const draftSchema = z
  .object({
    customer_id: z.string().uuid(),
    location_id: z.string().uuid().nullable().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    due_on: isoDate.nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    lines: z.array(lineSchema).min(1).max(50),
  })
  .strict();
const updateSchema = draftSchema.omit({ customer_id: true }).partial().strict();

const listSchema = z
  .object({
    status: z.enum(['draft', 'sent', 'paid', 'void', 'open', 'all']).default('all'),
    customer_id: z.string().uuid().optional(),
    q: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

const sendSchema = z.object({ notify: z.boolean().default(true) }).strict();
const voidSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

// Customer name and number through RLS (null when the employee cannot read the customer).
const COLUMNS = `i.id, i.invoice_number, i.customer_id, i.location_id, i.currency, i.status, i.total, i.amount_paid,
  greatest(i.total - i.amount_paid, 0) AS balance, i.due_on, i.notes, i.sent_at, i.paid_at, i.voided_at, i.void_reason,
  i.created_at, i.updated_at,
  (i.status = 'sent' AND i.due_on < current_date) AS overdue,
  (SELECT nullif(concat_ws(' ', c.first_name, c.last_name), '') FROM core.customers c WHERE c.id = i.customer_id) AS customer_name,
  (SELECT c.customer_number FROM core.customers c WHERE c.id = i.customer_id) AS customer_number,
  (SELECT l.name FROM core.locations l WHERE l.id = i.location_id) AS location_name`;

/**
 * Invoices (migration 0025). Staff draft, send and void them and record payments against them
 * (POST /payments with invoice_id); customers see theirs in the portal and pay by card (Stripe
 * Checkout) or bank transfer. Access follows 'payments' (RLS); customers never see drafts.
 */
@Controller('invoices')
export class InvoicesController {
  private readonly logger = new Logger(InvoicesController.name);

  constructor(
    private readonly db: DbService,
    private readonly messaging: MessagingService,
    @Inject(INVOICE_CHECKOUT) private readonly checkout: InvoiceCheckout,
  ) {}

  @Get()
  @Can('read', 'payments')
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      args.push(v);
      where.push(sql.replaceAll('?', `$${args.length}`));
    };
    if (q.status === 'open') where.push(`i.status = 'sent'`);
    else if (q.status !== 'all') add('i.status = ?', q.status);
    if (q.customer_id) add('i.customer_id = ?', q.customer_id);
    if (q.q) {
      add(
        `(i.invoice_number ILIKE '%' || ? || '%' OR i.customer_id IN (SELECT c.id FROM core.customers c
            WHERE concat_ws(' ', c.first_name, c.last_name) ILIKE '%' || $${args.length} || '%' OR c.customer_number ILIKE $${args.length}))`,
        q.q,
      );
    }
    args.push(q.limit);
    return this.db.as(p, async (db) => {
      const items = (
        await db.query(
          `SELECT ${COLUMNS} FROM core.invoices i ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY CASE i.status WHEN 'draft' THEN 0 WHEN 'sent' THEN 1 ELSE 2 END, i.created_at DESC LIMIT $${args.length}`,
          args,
        )
      ).rows;
      return { items, card_payments: p.type === 'customer' ? await this.cardAvailable(db) : undefined };
    });
  }

  /** One invoice with its lines and payments; for customers also how they can pay. */
  @Get(':id')
  @Can('read', 'payments')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.as(p, async (db) => {
      const invoice = await this.load(db, id);
      const payments = (
        await db.query(
          `SELECT id, payment_number, amount, amount_refunded, currency, method, status, paid_at, expected_at, bank_reference, created_at
             FROM core.payments WHERE invoice_id = $1 ORDER BY created_at`,
          [id],
        )
      ).rows;
      const settings = (await db.query<{ bank_transfer_instructions: string | null }>('SELECT bank_transfer_instructions FROM core.settings WHERE id = 1')).rows[0];
      return {
        ...invoice,
        payments,
        pay: { card: invoice.status === 'sent' && (await this.cardAvailable(db)), bank_transfer_instructions: settings.bank_transfer_instructions },
      };
    });
  }

  @Post()
  @EmployeesOnly()
  @Can('create', 'payments')
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(draftSchema)) body: z.infer<typeof draftSchema>) {
    return this.db.as(p, async (db) => {
      const customer = (await db.query<{ preferred_location_id: string | null }>('SELECT preferred_location_id FROM core.customers WHERE id = $1', [body.customer_id]))
        .rows[0];
      if (!customer) throw new NotFoundException('Customer not found');
      const currency = body.currency ?? (await db.query<{ c: string }>('SELECT default_currency AS c FROM core.settings WHERE id = 1')).rows[0].c;
      const id = (
        await db.query<{ id: string }>(
          `INSERT INTO core.invoices (customer_id, location_id, currency, due_on, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [body.customer_id, body.location_id ?? customer.preferred_location_id, currency, body.due_on ?? null, body.notes ?? null, p.id],
        )
      ).rows[0].id;
      await this.writeLines(db, id, body.customer_id, body.lines);
      return this.load(db, id);
    });
  }

  /** Drafts only: fields, and the lines replaced when given. */
  @Put(':id')
  @EmployeesOnly()
  @Can('create', 'payments')
  update(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>) {
    return this.db.as(p, async (db) => {
      const current = await this.load(db, id);
      if (current.status !== 'draft') throw new ConflictException('Only draft invoices can be edited; void it and make a new one');
      const { lines, ...fields } = body;
      const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
      if (entries.length) {
        const res = await db.query(`UPDATE core.invoices SET ${entries.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [
          id,
          ...entries.map(([, v]) => v),
        ]);
        if (!res.rowCount) throw new ForbiddenException('Not allowed to change this invoice');
      }
      if (lines) {
        await db.query('DELETE FROM core.invoice_lines WHERE invoice_id = $1', [id]);
        await this.writeLines(db, id, current.customer_id, lines);
      }
      return this.load(db, id);
    });
  }

  @Delete(':id')
  @EmployeesOnly()
  @Can('create', 'payments')
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.as(p, async (db) => {
      const current = await this.load(db, id);
      if (current.status !== 'draft') throw new ConflictException('Only drafts can be deleted; void a sent invoice instead');
      await db.query('DELETE FROM core.invoice_lines WHERE invoice_id = $1', [id]);
      if (!(await db.query('DELETE FROM core.invoices WHERE id = $1', [id])).rowCount) throw new ForbiddenException('Not allowed to delete this invoice');
    });
  }

  /** Sends a draft: it shows in the customer's portal, and they get an email when they have one. */
  @Post(':id/send')
  @EmployeesOnly()
  @Can('create', 'payments')
  async send(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(sendSchema)) body: z.infer<typeof sendSchema>) {
    const { invoice, email, business } = await this.db.as(p, async (db) => {
      const current = await this.load(db, id);
      if (current.status !== 'draft') throw new ConflictException('This invoice was already sent');
      if (Number(current.total) <= 0) throw new BadRequestException('Add at least one line with an amount before sending');
      const res = await db.query(
        `UPDATE core.invoices SET status = 'sent', sent_at = now(),
                due_on = coalesce(due_on, current_date + (SELECT invoice_due_days FROM core.settings WHERE id = 1))
          WHERE id = $1`,
        [id],
      );
      if (!res.rowCount) throw new ForbiddenException('Not allowed to send this invoice');
      const c = (await db.query<{ email: string | null; first_name: string | null }>('SELECT email, first_name FROM core.customers WHERE id = $1', [current.customer_id])).rows[0];
      const s = (await db.query<{ business_name: string | null }>('SELECT business_name FROM core.settings WHERE id = 1')).rows[0];
      return { invoice: await this.load(db, id), email: c?.email ? { to: c.email, name: c.first_name } : null, business: s.business_name ?? 'JoyBot' };
    });

    let notified: string | null = null;
    if (body.notify && email) {
      const link = `${await this.messaging.appUrl()}/portal/invoices/${id}`;
      try {
        await this.messaging.send({
          channel: 'email',
          to: email.to,
          template: 'invoice',
          subject: `Invoice ${invoice.invoice_number} from ${business}`,
          text:
            `Hi ${email.name ?? 'there'},\n\n${business} sent you invoice ${invoice.invoice_number} for ` +
            `${new Intl.NumberFormat('en-US', { style: 'currency', currency: invoice.currency }).format(Number(invoice.total))}` +
            `${invoice.due_on ? `, due ${invoice.due_on}` : ''}.\n\nView and pay it here: ${link}`,
        });
        notified = maskContact(email.to);
      } catch (err) {
        // The invoice is sent (it is in the portal) even if the email could not go out.
        this.logger.warn(`invoice email failed: ${(err as Error).message}`);
      }
    }
    return { invoice, notified };
  }

  @Post(':id/void')
  @EmployeesOnly()
  @Can('create', 'payments')
  void(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(voidSchema)) body: z.infer<typeof voidSchema>) {
    return this.db.as(p, async (db) => {
      const current = await this.load(db, id);
      if (current.status === 'draft') throw new ConflictException('Delete a draft instead of voiding it');
      if (current.status === 'void') throw new ConflictException('Already void');
      if (Number(current.amount_paid) > 0) throw new ConflictException('This invoice has payments; refund or move them first');
      const res = await db.query(`UPDATE core.invoices SET status = 'void', voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1`, [
        id,
        p.id,
        body.reason,
      ]);
      if (!res.rowCount) throw new ForbiddenException('Not allowed to void this invoice');
      return this.load(db, id);
    });
  }

  /** Customers: a Stripe Checkout page for what is still due. */
  @Post(':id/checkout')
  @CustomersOnly()
  async pay(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const { invoice, email } = await this.db.as(p, async (db) => {
      const invoice = await this.load(db, id);
      if (invoice.customer_id !== p.id) throw new ForbiddenException('Only the invoiced customer pays it here');
      if (invoice.status !== 'sent' || Number(invoice.balance) <= 0) throw new ConflictException('Nothing is due on this invoice');
      if (!(await this.cardAvailable(db))) throw new ServiceUnavailableException('Card payments are not available');
      const c = (await db.query<{ email: string | null; email_verified: boolean }>('SELECT email, email_verified FROM core.customers WHERE id = $1', [p.id])).rows[0];
      return { invoice, email: c?.email_verified ? c.email : null };
    });
    const base = await this.messaging.appUrl();
    try {
      return await this.checkout.create({
        invoiceNumber: invoice.invoice_number,
        customerNumber: invoice.customer_number,
        email,
        amount: Number(invoice.balance),
        currency: invoice.currency,
        description: `Invoice ${invoice.invoice_number}`,
        successUrl: `${base}/portal/invoices/${id}?paid=1`,
        cancelUrl: `${base}/portal/invoices/${id}`,
      });
    } catch (err) {
      this.logger.error(`checkout failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException('Card payment could not be started. Please try again shortly.');
    }
  }

  // ---------------------------------------------------------------------------------------------

  private async load(db: PoolClient, id: string) {
    const invoice = (await db.query(`SELECT ${COLUMNS} FROM core.invoices i WHERE i.id = $1`, [id])).rows[0];
    if (!invoice) throw new NotFoundException();
    invoice.lines = (
      await db.query(
        `SELECT l.id, l.description, l.quantity, l.unit_price, round(l.quantity * l.unit_price, 2) AS amount, l.service_id, l.appointment_id,
                (SELECT a.appointment_number FROM core.appointments a WHERE a.id = l.appointment_id) AS appointment_number
           FROM core.invoice_lines l WHERE l.invoice_id = $1 ORDER BY l.position, l.id`,
        [id],
      )
    ).rows;
    return invoice;
  }

  /** Lines in order; a linked appointment must be this customer's (and visible to the employee). */
  private async writeLines(db: PoolClient, invoiceId: string, customerId: string, lines: z.infer<typeof lineSchema>[]) {
    for (const [i, line] of lines.entries()) {
      if (line.appointment_id) {
        const a = (await db.query<{ customer_id: string }>('SELECT customer_id FROM core.appointments WHERE id = $1', [line.appointment_id])).rows[0];
        if (!a || a.customer_id !== customerId) throw new BadRequestException(`Line ${i + 1}: the appointment is not this customer's`);
      }
      await db.query(
        `INSERT INTO core.invoice_lines (invoice_id, position, description, quantity, unit_price, service_id, appointment_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [invoiceId, i, line.description, line.quantity, line.unit_price, line.service_id ?? null, line.appointment_id ?? null],
      );
    }
  }

  /** Card payments need Stripe sync on (settings) and a Checkout key. */
  private async cardAvailable(db: PoolClient): Promise<boolean> {
    const enabled = (await db.query<{ on: boolean }>('SELECT authz.stripe_enabled() AS on')).rows[0].on;
    return enabled && (await this.checkout.available());
  }
}
