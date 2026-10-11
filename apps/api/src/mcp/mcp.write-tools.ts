import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createAppointmentSchema, updateAppointmentSchema, type AppointmentsService } from '../appointments/appointments.service';
import { draftSchema, sendSchema, voidSchema, type InvoicesService } from '../invoices/invoices.service';
import { createManualPaymentSchema } from '../payments/payments.schemas';
import type { PaymentsService } from '../payments/payments.service';
import { timeOffSchema, type SchedulesService } from '../schedules/schedules.service';
import { createSchema as createTaskSchema, updateSchema as updateTaskSchema, type TasksService } from '../tasks/tasks.service';
import { failure, json, type ToolContext } from './mcp.tools';

export interface WriteContext extends ToolContext {
  tokenId: string;
  tasks: TasksService;
  invoices: InvoicesService;
  schedules: SchedulesService;
}

const uuid = z.string().uuid();
const isoDateTime = z.string().datetime({ offset: true });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const confirmation = z.string().uuid().optional().describe('From the preview of a first call; only after the user agreed');

/** Additive or easily undone (no confirmation step; MCP clients still ask before non-read-only tools). */
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
/** Hard to undo: a first call only previews and returns a confirmation id. */
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

/**
 * The write tools for 'read_write' tokens (Phase 6, step 2). Each validates with the API's own
 * schemas and calls the same services as the web app, so access rules, double-booking and
 * working-hours checks, invoice rules and duplicate-payment checks all apply. Cancelling an
 * appointment, sending or voiding an invoice and recording a payment need a confirmation round trip.
 */
export function registerWriteTools(server: McpServer, ctx: WriteContext) {
  const { principal: p, db } = ctx;
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { title: string; description: string; inputSchema: z.ZodRawShape; annotations: Record<string, unknown> },
    cb: (args: never) => Promise<CallToolResult>,
  ) => void;
  const tool = <S extends z.ZodRawShape>(
    name: string,
    title: string,
    description: string,
    input: S,
    hints: typeof WRITE | typeof DESTRUCTIVE | Record<string, boolean>,
    run: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown>,
  ) =>
    register(name, { title, description, inputSchema: input, annotations: { title, ...hints } }, async (args: z.objectOutputType<S, z.ZodTypeAny>) => {
      try {
        const out = await run(args);
        return isResult(out) ? out : json(out);
      } catch (err) {
        return failure(err);
      }
    });

  /**
   * First call (no confirmation): store a single-use confirmation and return the preview. Second call
   * with the confirmation and the same arguments: consume it and go ahead (returns undefined).
   */
  const gate = async (name: string, args: Record<string, unknown>, preview: () => Promise<string>): Promise<CallToolResult | undefined> => {
    const { confirmation: given, ...rest } = args;
    const hash = createHash('sha256').update(`${name}\n${canonical(rest)}`).digest('hex');
    if (!given) {
      const text = await preview();
      const id = await db.as(
        p,
        async (c) =>
          (
            await c.query<{ id: string }>(`INSERT INTO app.mcp_confirmations (token_id, user_id, tool, args_hash, preview) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
              ctx.tokenId,
              p.id,
              name,
              hash,
              text,
            ])
          ).rows[0].id,
      );
      return json({
        status: 'confirmation_required',
        preview: text,
        confirmation: id,
        expires_in_minutes: 10,
        next: `Show this preview to the user. Only if they agree, call ${name} again with exactly the same arguments plus "confirmation": "${id}". Nothing has changed yet.`,
      });
    }
    const used = await db.as(p, async (c) =>
      (
        await c.query(
          `UPDATE app.mcp_confirmations SET used_at = now()
            WHERE id = $1 AND token_id = $2 AND tool = $3 AND args_hash = $4 AND used_at IS NULL AND expires_at > now()`,
          [given, ctx.tokenId, name, hash],
        )
      ).rowCount,
    );
    if (!used) throw new Error('That confirmation is unknown, expired, already used, or the arguments changed. Call again without "confirmation" for a new preview.');
    return undefined;
  };

  // Appointments ----------------------------------------------------------------------------------

  tool(
    'book_appointment',
    'Book an appointment',
    'Books a customer for a service at a location and time (ISO with offset); the end and price default to the service. Refused with details when the staff member is double-booked, off or outside working hours; set book_despite_conflicts only if the user says so.',
    {
      customer_id: uuid,
      service_id: uuid,
      location_id: uuid,
      scheduled_start: isoDateTime,
      employee_id: uuid.optional(),
      notes_customer: z.string().max(2000).optional(),
      book_despite_conflicts: z.boolean().optional(),
    },
    WRITE,
    async ({ book_despite_conflicts, ...a }) => ctx.appointments.create(p, createAppointmentSchema.parse({ ...a, confirm_overlap: book_despite_conflicts || undefined })),
  );

  tool(
    'reschedule_appointment',
    'Reschedule an appointment',
    'Moves an appointment to a new start time (keeping its length) and/or another staff member. Same conflict checks as booking.',
    { appointment_id: uuid, scheduled_start: isoDateTime.optional(), employee_id: uuid.nullable().optional(), book_despite_conflicts: z.boolean().optional() },
    WRITE,
    async ({ appointment_id, scheduled_start, employee_id, book_despite_conflicts }) => {
      if (scheduled_start === undefined && employee_id === undefined) throw new Error('Give a new scheduled_start and/or employee_id');
      const current = (await ctx.appointments.get(p, appointment_id)) as { scheduled_start: string; scheduled_end: string };
      const length = Date.parse(current.scheduled_end) - Date.parse(current.scheduled_start);
      return ctx.appointments.update(
        p,
        appointment_id,
        updateAppointmentSchema.parse({
          ...(scheduled_start ? { scheduled_start, scheduled_end: new Date(Date.parse(scheduled_start) + length).toISOString() } : {}),
          ...(employee_id !== undefined ? { employee_id } : {}),
          ...(book_despite_conflicts ? { confirm_overlap: true } : {}),
        }),
      );
    },
  );

  tool(
    'cancel_appointment',
    'Cancel an appointment',
    'Cancels an appointment (only an admin can reopen it). Two calls: the first returns a preview and a confirmation id.',
    { appointment_id: uuid, confirmation },
    DESTRUCTIVE,
    async (args) => {
      const a = (await ctx.appointments.get(p, args.appointment_id)) as Record<string, string>;
      const stop = await gate('cancel_appointment', args, async () => {
        if (!['scheduled', 'confirmed'].includes(a.status)) throw new Error(`This appointment is ${a.status}; only scheduled or confirmed ones can be cancelled`);
        return `Cancel ${a.appointment_number}: ${a.service_name} for ${a.customer_name ?? 'the customer'} on ${local(a.scheduled_start, a.time_zone)} at ${a.location_name}${a.employee_name ? ` with ${a.employee_name}` : ''}.`;
      });
      return stop ?? ctx.appointments.update(p, args.appointment_id, updateAppointmentSchema.parse({ status: 'cancelled' }));
    },
  );

  // To-dos and time off ----------------------------------------------------------------------------

  tool(
    'create_todo',
    'Create a to-do',
    'Adds a to-do, assigned to the token’s admin unless assigned_to (an active staff member) is given; optionally due on a date and linked to a customer.',
    { title: z.string().min(1).max(200), notes: z.string().max(5000).optional(), due_on: isoDate.optional(), customer_id: uuid.optional(), assigned_to: uuid.optional() },
    WRITE,
    async (a) => ctx.tasks.create(p, createTaskSchema.parse(a)),
  );

  tool('set_todo_done', 'Complete or reopen a to-do', 'Marks a to-do done (or not done).', { todo_id: uuid, done: z.boolean() }, { ...WRITE, idempotentHint: true }, async ({ todo_id, done }) =>
    ctx.tasks.update(p, todo_id, updateTaskSchema.parse({ done })),
  );

  tool(
    'add_time_off',
    'Add time off',
    'Adds time off for a staff member (ISO date-times with offset); booking then warns for that time. The reason is shown only to them and admins.',
    { employee_id: uuid, starts_at: isoDateTime, ends_at: isoDateTime, reason: z.string().max(200).optional() },
    WRITE,
    async ({ employee_id, ...a }) => ctx.schedules.addTimeOff(p, employee_id, timeOffSchema.parse(a)),
  );

  // Invoices and payments --------------------------------------------------------------------------

  tool(
    'create_invoice_draft',
    'Draft an invoice',
    'Creates a draft invoice for a customer (only staff see drafts). Lines: description, quantity (default 1), unit_price, optional service_id. Send it with send_invoice.',
    {
      customer_id: uuid,
      lines: z
        .array(z.object({ description: z.string().min(1).max(300), quantity: z.number().positive().optional(), unit_price: z.number().min(0), service_id: uuid.optional() }))
        .min(1)
        .max(50),
      due_on: isoDate.optional(),
      notes: z.string().max(2000).optional().describe('Shown to the customer'),
    },
    WRITE,
    async (a) => ctx.invoices.create(p, draftSchema.parse(a)),
  );

  tool(
    'send_invoice',
    'Send an invoice',
    'Sends a draft invoice: it appears in the customer’s portal and, unless email_customer is false, they are emailed. Two calls: the first returns a preview and a confirmation id.',
    { invoice_id: uuid, email_customer: z.boolean().default(true), confirmation },
    { ...DESTRUCTIVE, destructiveHint: false, openWorldHint: true },
    async (args) => {
      const stop = await gate('send_invoice', args, async () => {
        const inv = await db.as(p, (c) => ctx.invoices.load(c, args.invoice_id));
        if (inv.status !== 'draft') throw new Error(`This invoice is already ${inv.status}`);
        const email = (await db.as(p, async (c) => (await c.query<{ email: string | null }>('SELECT email FROM core.customers WHERE id = $1', [inv.customer_id])).rows[0]))
          ?.email;
        return `Send ${inv.invoice_number} to ${inv.customer_name ?? 'the customer'} (${inv.customer_number}): ${money(inv.total, inv.currency)}, ${inv.lines.length} line(s)${
          inv.due_on ? `, due ${inv.due_on}` : ', due per the default terms'
        }. ${args.email_customer && email ? `They will be emailed at ${email}.` : 'No email; it will only appear in their portal.'}`;
      });
      return stop ?? ctx.invoices.send(p, args.invoice_id, sendSchema.parse({ notify: args.email_customer }));
    },
  );

  tool(
    'void_invoice',
    'Void an invoice',
    'Voids a sent invoice that has no payments (the customer can no longer pay it). Two calls: the first returns a preview and a confirmation id.',
    { invoice_id: uuid, reason: z.string().min(1).max(500), confirmation },
    DESTRUCTIVE,
    async (args) => {
      const stop = await gate('void_invoice', args, async () => {
        const inv = await db.as(p, (c) => ctx.invoices.load(c, args.invoice_id));
        if (Number(inv.amount_paid) > 0) throw new Error('This invoice has payments; it cannot be voided');
        if (inv.status !== 'sent') throw new Error(`Only sent invoices can be voided; this one is ${inv.status}`);
        return `Void ${inv.invoice_number} for ${inv.customer_name ?? 'the customer'} (${money(inv.total, inv.currency)}). Reason: ${args.reason}.`;
      });
      return stop ?? ctx.invoices.void(p, args.invoice_id, voidSchema.parse({ reason: args.reason }));
    },
  );

  tool(
    'record_payment',
    'Record a payment',
    'Records a payment received in person or by bank transfer (cash, card at the front desk with its POS reference, or a received bank transfer with its reference), optionally toward an invoice or appointment. Two calls: the first returns a preview and a confirmation id.',
    {
      customer_id: uuid,
      amount: z.number().positive(),
      method: z.enum(['cash', 'card_pos', 'bank_transfer']),
      reference: z.string().max(100).optional().describe('POS reference (card_pos) or transfer reference (bank_transfer); required for those'),
      paid_at: isoDateTime.optional().describe('Default: now'),
      invoice_id: uuid.optional(),
      appointment_id: uuid.optional(),
      record_despite_duplicate: z.boolean().optional(),
      confirmation,
    },
    { ...DESTRUCTIVE, destructiveHint: false },
    async (args) => {
      const { confirmation: _c, record_despite_duplicate, reference, method, paid_at, ...rest } = args;
      if (method !== 'cash' && !reference) throw new Error(`A ${method === 'card_pos' ? 'POS' : 'transfer'} reference is required`);
      const at = paid_at ?? new Date().toISOString();
      const input = createManualPaymentSchema.parse({
        ...rest,
        method,
        paid_at: at,
        ...(method === 'card_pos' ? { pos_reference: reference } : {}),
        ...(method === 'bank_transfer' ? { bank_reference: reference } : {}),
        ...(record_despite_duplicate ? { confirm_duplicate: true } : {}),
      });
      // paid_at is part of the confirmed arguments: fix it at the first call's "now" through the preview.
      const stop = await gate('record_payment', { ...args, paid_at: args.paid_at ?? null }, async () => {
        const c = (
          await db.as(p, async (q) =>
            (await q.query<{ name: string | null; customer_number: string }>(`SELECT nullif(concat_ws(' ', first_name, last_name), '') AS name, customer_number FROM core.customers WHERE id = $1`, [args.customer_id])).rows,
          )
        )[0];
        if (!c) throw new Error('No customer with that id that you can see');
        const inv = args.invoice_id ? await db.as(p, (q) => ctx.invoices.load(q, args.invoice_id!)) : null;
        const currency = inv?.currency ?? (await db.as(p, async (q) => (await q.query<{ c: string }>('SELECT default_currency AS c FROM core.settings WHERE id = 1')).rows[0].c));
        const label = { cash: 'cash', card_pos: 'card at the front desk', bank_transfer: 'bank transfer' }[method];
        return `Record ${money(args.amount, currency)} by ${label}${reference ? ` (reference ${reference})` : ''} from ${c.name ?? 'the customer'} (${c.customer_number})${
          inv ? ` toward ${inv.invoice_number} (due ${money(inv.balance, inv.currency)})` : ''
        }, paid ${args.paid_at ?? 'now'}.`;
      });
      return stop ?? ctx.payments.createManual(p, input);
    },
  );
}

const isResult = (v: unknown): v is CallToolResult => typeof v === 'object' && v !== null && Array.isArray((v as CallToolResult).content);

/** Stable JSON (sorted keys) so the same arguments always hash the same. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

const money = (v: string | number, currency: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(v));
const local = (iso: string, zone: string) =>
  new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: zone }).format(new Date(iso)) + ` (${zone.replaceAll('_', ' ')})`;
