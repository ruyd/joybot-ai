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
import { createPageSchema, moduleSchema, siteSettingsSchema, updatePageSchema, type SiteModule } from '../website/website.schemas';
import { MAX_IMAGE_BYTES } from '../website/website.service';
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

  // Website ---------------------------------------------------------------------------------------

  const pageFields = {
    title: z.string().max(120).optional(),
    description: z.string().max(300).nullable().optional().describe('For search engines'),
    published: z.boolean().optional().describe('Drafts are only seen by editors'),
    show_in_header: z.boolean().optional(),
    show_in_footer: z.boolean().optional(),
    sort_order: z.number().int().optional().describe('Header and footer order, lowest first'),
    modules: z.array(moduleSchema).max(60).optional().describe(`Replaces all of the page’s modules. ${MODULES_HELP}`),
  };

  tool(
    'create_site_page',
    'Create a website page',
    'Adds a page to the public website at /slug, as a draft unless published is true.',
    { slug: z.string().max(60).describe('Lowercase letters, numbers and dashes'), ...pageFields, title: z.string().min(1).max(120) },
    WRITE,
    async (a) => ctx.website.createPage(p, createPageSchema.parse(a)),
  );

  tool(
    'update_site_page',
    'Update a website page',
    'Changes a page’s title, address, description, publishing, header and footer placement, or replaces its modules; make_home makes it the home page (served at /). Use set_site_module to change one module.',
    { page_id: uuid, slug: z.string().max(60).optional(), ...pageFields, make_home: z.literal(true).optional() },
    WRITE,
    async ({ page_id, make_home, ...a }) => ctx.website.updatePage(p, page_id, updatePageSchema.parse({ ...a, ...(make_home ? { is_home: true } : {}) })),
  );

  tool(
    'set_site_module',
    'Add or replace a page module',
    `Replaces the module with the same id on a page, or adds it (at position, 0 = first; default last). ${MODULES_HELP}`,
    { page_id: uuid, module: moduleSchema, position: z.number().int().min(0).optional() },
    WRITE,
    async ({ page_id, module, position }) => {
      const page = (await ctx.website.getPage(p, page_id)) as { modules: SiteModule[] };
      const modules = [...page.modules];
      const at = modules.findIndex((m) => m.id === module.id);
      if (at >= 0) modules[at] = module as SiteModule;
      else modules.splice(position ?? modules.length, 0, module as SiteModule);
      return ctx.website.updatePage(p, page_id, updatePageSchema.parse({ modules }));
    },
  );

  tool(
    'remove_site_module',
    'Remove a page module',
    'Removes one module from a page by its id.',
    { page_id: uuid, module_id: z.string().max(64) },
    WRITE,
    async ({ page_id, module_id }) => {
      const page = (await ctx.website.getPage(p, page_id)) as { modules: SiteModule[] };
      const modules = page.modules.filter((m) => m.id !== module_id);
      if (modules.length === page.modules.length) throw new Error('No module with that id on this page');
      return ctx.website.updatePage(p, page_id, updatePageSchema.parse({ modules }));
    },
  );

  tool(
    'delete_site_page',
    'Delete a website page',
    'Deletes a page (not the home page) and all its modules. Two calls: the first returns a preview and a confirmation id.',
    { page_id: uuid, confirmation },
    DESTRUCTIVE,
    async (args) => {
      const page = (await ctx.website.getPage(p, args.page_id)) as { slug: string; title: string; is_home: boolean; published: boolean; modules: unknown[] };
      const stop = await gate('delete_site_page', args, async () => {
        if (page.is_home) throw new Error('This is the home page: make another page the home page first');
        return `Delete the page “${page.title}” (/${page.slug}, ${page.published ? 'published' : 'draft'}) and its ${page.modules.length} module(s). This cannot be undone.`;
      });
      if (stop) return stop;
      await ctx.website.deletePage(p, args.page_id);
      return { deleted: true, slug: page.slug };
    },
  );

  tool(
    'update_site_setup',
    'Update website setup',
    'Changes how the public site looks and its header: site_name (the name shown; null for the business name), tagline under the name, logo (an uploaded image id), favicon (favicon_asset_id: the browser tab icon, an uploaded image id; null uses the logo), accent and accent_to colors (#rrggbb; buttons are a gradient between them, white text goes on accent), highlight_color (a second brand color for highlighted cards and the hero glow; null for accent_to), heading_font and body_font (names from get_site_setup), header_links (label + url such as "/#services"; replaces the list), the header button (label and url together; null removes it) and show_customer_login.',
    {
      site_name: z.string().max(80).nullable().optional(),
      tagline: z.string().max(60).nullable().optional(),
      logo_asset_id: uuid.nullable().optional(),
      favicon_asset_id: uuid.nullable().optional(),
      accent: z.string().optional(),
      accent_to: z.string().optional(),
      highlight_color: z.string().nullable().optional(),
      heading_font: z.string().optional(),
      body_font: z.string().optional(),
      header_links: z.array(z.object({ label: z.string(), url: z.string() })).max(8).optional(),
      header_button_label: z.string().max(40).nullable().optional(),
      header_button_url: z.string().max(500).nullable().optional(),
      show_customer_login: z.boolean().optional(),
    },
    { ...WRITE, idempotentHint: true },
    async (a) => ctx.website.updateSettings(p, siteSettingsSchema.parse(a)),
  );

  tool(
    'upload_site_image',
    'Upload a website image',
    'Uploads a PNG, JPEG, WebP or GIF (up to 5 MB, base64) for pages and the logo; returns its id. SVG is not accepted.',
    {
      filename: z.string().min(1).max(200),
      content_type: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
      data_base64: z.string().min(1).max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4),
    },
    WRITE,
    async ({ filename, content_type, data_base64 }) => {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data_base64.replace(/\s/g, ''))) throw new Error('data_base64 is not base64');
      return ctx.website.uploadAsset(p, content_type, Buffer.from(data_base64, 'base64'), filename);
    },
  );
}

/** What the module types hold, for the tools that take modules (the schema has the details). */
const MODULES_HELP = [
  'Modules are the page’s sections, top to bottom; each needs an id unique on the page (letters, numbers, - and _).',
  'Every module may have: anchor (makes it reachable at /page#anchor), background (default, alt, dark, accent), eyebrow (a small label above the heading), eyebrow_style (text, or badge: a rounded label in the highlight color), heading, heading_accent (words of the heading to highlight, e.g. "on demand"), align (center or left), intro (Markdown).',
  'Types: hero (heading, badge (a short rounded label before the eyebrow, e.g. "Open source"), text, up to 2 buttons {label, url, style?}: by default the first filled and the second outlined, or style primary, secondary or highlight);',
  'cards (items: icon, highlight (true: in the highlight color), eyebrow, heading, Markdown text with lists for bullets and --- for a divider, link_label + link_url; variant cards, large (heading-font headings, arrow bullets, button links), numbered for steps or compact; icon_position top or side; icon_color accent or highlight; buttons_position below or header (beside a left-aligned heading); columns 2-4; up to 12 items; optional buttons);',
  'faq (items: question, Markdown answer); compare (before and after, each {label, core (a bar across the top, optional), items: [{label, note}]}: chips in a dashed box, an arrow, then chips in the highlight color); cta (heading, text, buttons; looks best on background accent or dark);',
  'columns (1-4 columns of heading, Markdown text, image, link); html (sanitized: no scripts, styles or classes); image (image_id from upload_site_image, alt, caption, size); video (YouTube or Vimeo url).',
  'Links start with https://, /, mailto:, tel: or #. Icons and fonts: see get_site_setup.',
].join(' ');

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
