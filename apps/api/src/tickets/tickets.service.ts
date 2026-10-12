import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Principal } from '../auth/principal';
import { DbService } from '../db/db.module';
import { MessagingService } from '../messaging/messaging.service';

export const TICKET_STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;
export const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

export const createSchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    /** The request: the ticket's first message. */
    message: z.string().trim().min(1).max(10_000),
    /** Employees: whose ticket it is (customers always open their own). */
    customer_id: z.string().uuid().optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    /** Employees opening a ticket for a customer: email them the message (default true). */
    notify: z.boolean().optional(),
  })
  .strict();

export const replySchema = z
  .object({
    body: z.string().trim().min(1).max(10_000),
    /** Employees: a note only staff see. */
    internal: z.boolean().optional(),
    /** Employees: email the customer a public reply (default true). */
    notify: z.boolean().optional(),
  })
  .strict();

export const updateSchema = z
  .object({
    status: z.enum(TICKET_STATUSES),
    priority: z.enum(TICKET_PRIORITIES),
    assigned_to: z.string().uuid().nullable(),
    subject: z.string().trim().min(1).max(200),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

export type CreateTicket = z.infer<typeof createSchema>;
export type ReplyTicket = z.infer<typeof replySchema>;
export type UpdateTicket = z.infer<typeof updateSchema>;

export interface TicketSummary {
  /** The ticket number, as shown (#1001) and used in addresses. */
  id: string;
  subject: string;
  status: (typeof TICKET_STATUSES)[number];
  priority: (typeof TICKET_PRIORITIES)[number];
  created_at: string;
  updated_at: string;
  last_message_at: string;
  customer_id: string;
  customer_name: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  /** Messages this principal can see. */
  message_count: number;
}

export interface TicketMessage {
  id: string;
  body: string;
  from: 'customer' | 'support';
  author_name: string | null;
  internal: boolean;
  created_at: string;
}

export interface TicketDetail extends TicketSummary {
  messages: TicketMessage[];
}

export interface ListFilter {
  /** Customers whose tickets to list; undefined: every ticket the principal can see (employees). */
  customerIds?: string[];
  status?: string;
  /** An employee id, or 'none' for unassigned. */
  assignedTo?: string;
  limit?: number;
}

// Names come through RLS like everything else: a customer the principal cannot read shows as null.
const COLUMNS = `t.number::text AS id, t.subject, t.status, t.priority, t.created_at, t.updated_at, t.last_message_at,
  t.customer_id, t.assigned_to,
  (SELECT nullif(concat_ws(' ', c.first_name, c.last_name), '') FROM core.customers c WHERE c.id = t.customer_id) AS customer_name,
  (SELECT concat_ws(' ', s.first_name, s.last_name) FROM core.v_staff_public s WHERE s.id = t.assigned_to) AS assigned_to_name,
  (SELECT count(*)::int FROM core.ticket_messages m WHERE m.ticket_id = t.id) AS message_count`;

type Run = <T>(fn: (db: PoolClient) => Promise<T>) => Promise<T>;

/**
 * Support tickets, shared by the API, the chat tools (reader role) and anything else that needs
 * them. RLS decides whose tickets a principal sees and changes, and hides internal notes from
 * everyone who may not read the customer's private notes.
 */
@Injectable()
export class TicketsService {
  private readonly logger = new Logger('Tickets');

  constructor(
    private readonly db: DbService,
    private readonly messaging: MessagingService,
  ) {}

  list(p: Principal, f: ListFilter, via: 'app' | 'reader' = 'app'): Promise<TicketSummary[]> {
    if (f.status && !(TICKET_STATUSES as readonly string[]).includes(f.status)) throw new BadRequestException('Unknown status');
    return this.run(p, via)(async (db) => {
      const where: string[] = [];
      const args: unknown[] = [];
      if (f.customerIds) where.push(`t.customer_id = ANY($${args.push(f.customerIds)}::uuid[])`);
      if (f.status) where.push(`t.status = $${args.push(f.status)}`);
      if (f.assignedTo === 'none') where.push('t.assigned_to IS NULL');
      else if (f.assignedTo) where.push(`t.assigned_to = $${args.push(f.assignedTo)}`);
      const limit = Math.min(Math.max(f.limit ?? 200, 1), 500);
      return (
        await db.query<TicketSummary>(
          `SELECT ${COLUMNS} FROM core.tickets t ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY t.status IN ('open', 'pending') DESC, t.last_message_at DESC LIMIT ${limit}`,
          args,
        )
      ).rows;
    });
  }

  /** One ticket with the messages this principal may see; 404 when it is not theirs to see. */
  detail(p: Principal, number: string, via: 'app' | 'reader' = 'app'): Promise<TicketDetail> {
    return this.run(p, via)((db) => this.load(db, number));
  }

  async create(p: Principal, body: CreateTicket): Promise<TicketDetail> {
    const customerId = p.type === 'customer' ? p.id : body.customer_id;
    if (p.type === 'customer' && body.customer_id && body.customer_id !== p.id) throw new ForbiddenException('Customers open tickets for themselves');
    if (!customerId) throw new BadRequestException('customer_id is required');
    if (p.type === 'customer' && body.priority) throw new ForbiddenException('Staff set the priority');
    const ticket = await this.db.as(p, async (db) => {
      const number = (
        await db.query<{ number: number; id: string }>(
          `INSERT INTO core.tickets (customer_id, subject, priority, created_by_customer, created_by_user)
           VALUES ($1, $2, $3, $4, $5) RETURNING id, number`,
          [customerId, body.subject, body.priority ?? 'medium', p.type === 'customer' ? p.id : null, p.type === 'employee' ? p.id : null],
        )
      ).rows[0];
      await this.addMessage(db, p, number.id, body.message, false);
      // A new ticket waits on staff, whoever wrote the first message.
      await db.query(`UPDATE core.tickets SET status = 'open' WHERE id = $1`, [number.id]);
      return this.load(db, String(number.number));
    });
    if (p.type === 'employee' && body.notify !== false) await this.notify(p, ticket, body.message);
    return ticket;
  }

  async reply(p: Principal, number: string, body: ReplyTicket): Promise<TicketDetail> {
    if (p.type === 'customer' && body.internal) throw new ForbiddenException('Only staff add internal notes');
    const ticket = await this.db.as(p, async (db) => {
      const id = await this.idOf(db, number);
      await this.addMessage(db, p, id, body.body, Boolean(body.internal));
      return this.load(db, number);
    });
    if (p.type === 'employee' && !body.internal && body.notify !== false) await this.notify(p, ticket, body.body);
    return ticket;
  }

  update(p: Principal, number: string, body: UpdateTicket): Promise<TicketDetail> {
    if (p.type === 'customer') {
      const { status, ...rest } = body;
      if (Object.keys(rest).length || !status || !['resolved', 'closed'].includes(status)) {
        throw new ForbiddenException('Customers can only mark their tickets resolved or closed');
      }
    }
    return this.db.as(p, async (db) => {
      const id = await this.idOf(db, number);
      if (body.assigned_to && !(await db.query('SELECT 1 FROM core.v_staff_public WHERE id = $1', [body.assigned_to])).rowCount) {
        throw new BadRequestException('Assign the ticket to an active staff member');
      }
      const cols = Object.keys(body) as (keyof UpdateTicket)[];
      const res = await db.query(
        `UPDATE core.tickets SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [id, ...cols.map((c) => body[c])],
      );
      if (!res.rowCount) throw new ForbiddenException('Not allowed to change this ticket');
      return this.load(db, number);
    });
  }

  // ---------------------------------------------------------------------------------------------

  private run(p: Principal, via: 'app' | 'reader'): Run {
    return (fn) => (via === 'reader' ? this.db.read(p, fn) : this.db.as(p, fn));
  }

  private async idOf(db: PoolClient, number: string): Promise<string> {
    if (!/^\d{1,9}$/.test(number)) throw new NotFoundException('Ticket not found');
    const id = (await db.query<{ id: string }>('SELECT id FROM core.tickets WHERE number = $1', [Number(number)])).rows[0]?.id;
    if (!id) throw new NotFoundException('Ticket not found');
    return id;
  }

  private async addMessage(db: PoolClient, p: Principal, ticketId: string, body: string, internal: boolean) {
    await db.query(
      `INSERT INTO core.ticket_messages (ticket_id, body, author_customer, author_user, internal) VALUES ($1, $2, $3, $4, $5)`,
      [ticketId, body, p.type === 'customer' ? p.id : null, p.type === 'employee' ? p.id : null, internal],
    );
  }

  private async load(db: PoolClient, number: string): Promise<TicketDetail> {
    if (!/^\d{1,9}$/.test(number)) throw new NotFoundException('Ticket not found');
    const ticket = (await db.query<TicketSummary & { uuid: string }>(`SELECT t.id AS uuid, ${COLUMNS} FROM core.tickets t WHERE t.number = $1`, [Number(number)])).rows[0];
    if (!ticket) throw new NotFoundException('Ticket not found');
    const messages = (
      await db.query<TicketMessage>(
        `SELECT m.id, m.body, CASE WHEN m.author_customer IS NOT NULL THEN 'customer' ELSE 'support' END AS "from",
                coalesce((SELECT nullif(concat_ws(' ', c.first_name, c.last_name), '') FROM core.customers c WHERE c.id = m.author_customer),
                         (SELECT concat_ws(' ', s.first_name, s.last_name) FROM core.v_staff_public s WHERE s.id = m.author_user)) AS author_name,
                m.internal, m.created_at
           FROM core.ticket_messages m WHERE m.ticket_id = $1 ORDER BY m.created_at, m.id`,
        [ticket.uuid],
      )
    ).rows;
    const { uuid: _uuid, ...summary } = ticket;
    return { ...summary, messages };
  }

  /** Emails the customer a staff message (best effort: the reply stands even if the email fails). */
  private async notify(p: Principal, ticket: TicketDetail, text: string) {
    const info = await this.db.as(p, async (db) => ({
      customer: (await db.query<{ email: string | null; first_name: string | null }>('SELECT email, first_name FROM core.customers WHERE id = $1', [ticket.customer_id])).rows[0],
      business: (await db.query<{ business_name: string | null }>('SELECT business_name FROM core.settings WHERE id = 1')).rows[0]?.business_name ?? 'JoyBot',
    }));
    if (!info.customer?.email) return;
    try {
      const link = `${await this.messaging.appUrl()}/portal/tickets/${ticket.id}`;
      await this.messaging.send({
        channel: 'email',
        to: info.customer.email,
        template: 'ticket',
        subject: `[#${ticket.id}] ${ticket.subject}`,
        text: `Hi ${info.customer.first_name ?? 'there'},\n\n${info.business} replied to your support request:\n\n${text}\n\nSee the conversation and reply here: ${link}`,
      });
    } catch (err) {
      this.logger.warn(`ticket email failed: ${(err as Error).message}`);
    }
  }
}
