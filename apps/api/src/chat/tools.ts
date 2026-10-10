import { Injectable } from '@nestjs/common';
import type { Resource } from '@joybot/access';
import type { PoolClient } from 'pg';
import type { Principal } from '../auth/principal';
import { DbService } from '../db/db.module';
import { FreshdeskService } from '../freshdesk/freshdesk.service';
import { actionsFor, searchKnowledge, type ChatAction } from '../knowledge/knowledge';
import { formatLocal } from './time';

/**
 * Chat tools (plan.md §5.3): typed, read-only, executed as the principal on the joybot_reader role
 * (RLS applies). Customer/organization scope is always injected by the server — the model can only
 * choose *which* tool and filters like dates or status, never whose data.
 */

export type ToolName =
  | 'get_customer_profile'
  | 'list_appointments'
  | 'get_appointment'
  | 'list_payments'
  | 'get_payment'
  | 'get_balance'
  | 'list_services'
  | 'list_locations'
  | 'get_my_schedule'
  | 'list_pending_bank_transfers'
  | 'list_unmatched_stripe_payments'
  | 'get_organization'
  | 'list_organization_members'
  | 'search_customers'
  | 'list_tickets'
  | 'get_ticket'
  | 'search_knowledge';

export interface ChatScope {
  /** Customer the conversation is about (self for customers). */
  customerId?: string;
  /** Organization in scope (org admin's own, or one an employee resolved). */
  organizationId?: string;
  /** Time zone used to show times when a record has no location. */
  timeZone: string;
}

export interface Evidence {
  type: 'customer' | 'organization' | 'appointment' | 'payment' | 'balance' | 'service' | 'location' | 'ticket' | 'answer' | 'article';
  id: string;
  title: string;
  fields: Record<string, string | number | boolean | null>;
  url?: string;
}

export interface ToolResult {
  evidence: Evidence[];
  status: 'ok' | 'empty' | 'denied' | 'error';
  note?: string;
  /** Buttons from matched saved answers and articles (search_knowledge). */
  actions?: ChatAction[];
}

interface ToolSpec {
  description: string;
  parameters: Record<string, unknown>;
  audience: ('employee' | 'customer')[];
  requires: Resource;
  needs?: 'customer' | 'customer_or_org' | 'org';
}

const range = {
  from: { type: 'string', description: 'ISO date-time, inclusive' },
  to: { type: 'string', description: 'ISO date-time, exclusive' },
};

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  get_customer_profile: {
    description: 'Profile of the customer in scope: name, contact details, organization, preferred location.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    audience: ['employee', 'customer'],
    requires: 'customers',
    needs: 'customer',
  },
  list_appointments: {
    description: 'Appointments of the customer (or organization members) in scope, optionally within a date range or status.',
    parameters: {
      type: 'object',
      properties: {
        ...range,
        status: { type: 'string', enum: ['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show'] },
        upcoming_only: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    audience: ['employee', 'customer'],
    requires: 'appointments',
    needs: 'customer_or_org',
  },
  get_appointment: {
    description: 'One appointment by its number, e.g. A-2026-000123.',
    parameters: {
      type: 'object',
      properties: { appointment_number: { type: 'string', pattern: '^A-\\d{4}-\\d{4,}$' } },
      required: ['appointment_number'],
      additionalProperties: false,
    },
    audience: ['employee', 'customer'],
    requires: 'appointments',
  },
  list_payments: {
    description: 'Payments (Stripe and manual: POS card, bank transfer, cash) of the customer in scope.',
    parameters: {
      type: 'object',
      properties: {
        ...range,
        status: { type: 'string', enum: ['pending', 'succeeded', 'failed', 'refunded', 'partially_refunded', 'voided', 'disputed'] },
        method: { type: 'string', enum: ['card_online', 'card_pos', 'bank_transfer', 'cash', 'other'] },
      },
      additionalProperties: false,
    },
    audience: ['employee', 'customer'],
    requires: 'payments',
    needs: 'customer',
  },
  get_payment: {
    description: 'One payment by its number, e.g. P-2026-000456.',
    parameters: {
      type: 'object',
      properties: { payment_number: { type: 'string', pattern: '^P-\\d{4}-\\d{4,}$' } },
      required: ['payment_number'],
      additionalProperties: false,
    },
    audience: ['employee', 'customer'],
    requires: 'payments',
  },
  get_balance: {
    description: 'Amount owed by the customer in scope: completed appointments minus payments.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    audience: ['employee', 'customer'],
    requires: 'payments',
    needs: 'customer',
  },
  list_services: {
    description: 'Services and prices offered.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, category: { type: 'string' } },
      additionalProperties: false,
    },
    audience: ['employee', 'customer'],
    requires: 'services',
  },
  list_locations: {
    description: 'Locations with address, phone and time zone.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    audience: ['employee', 'customer'],
    requires: 'locations',
  },
  get_my_schedule: {
    description: "The signed-in employee's own appointments.",
    parameters: { type: 'object', properties: { ...range }, additionalProperties: false },
    audience: ['employee'],
    requires: 'appointments',
  },
  list_pending_bank_transfers: {
    description: 'Bank transfers not yet received (optionally only overdue ones).',
    parameters: { type: 'object', properties: { overdue_only: { type: 'boolean' } }, additionalProperties: false },
    audience: ['employee'],
    requires: 'payments',
  },
  list_unmatched_stripe_payments: {
    description: 'Stripe payments not yet linked to a customer.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    audience: ['employee'],
    requires: 'payments',
  },
  get_organization: {
    description: 'The organization in scope.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    audience: ['employee', 'customer'],
    requires: 'organizations',
    needs: 'org',
  },
  list_organization_members: {
    description: 'Members of the organization in scope.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    audience: ['employee', 'customer'],
    requires: 'customers',
    needs: 'org',
  },
  list_tickets: {
    description: 'Support tickets (Freshdesk) of the customer or organization members in scope.',
    parameters: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['open', 'pending', 'resolved', 'closed'] } },
      additionalProperties: false,
    },
    audience: ['employee', 'customer'],
    requires: 'tickets',
    needs: 'customer_or_org',
  },
  get_ticket: {
    description: 'One support ticket with its public replies, by ticket number.',
    parameters: {
      type: 'object',
      properties: { ticket_id: { type: 'string', pattern: '^\\d{1,12}$' } },
      required: ['ticket_id'],
      additionalProperties: false,
    },
    audience: ['employee', 'customer'],
    requires: 'tickets',
  },
  search_knowledge: {
    description:
      'Saved answers and help articles written by the business: how-to, policies, booking, payments and account help. ' +
      'The server already searches the question itself; call this with other wording when that may find more.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 3 } },
      required: ['query'],
      additionalProperties: false,
    },
    audience: ['employee', 'customer'],
    requires: 'knowledge',
  },
  search_customers: {
    description: 'Find customers by name, email, phone or customer number.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 2 } },
      required: ['query'],
      additionalProperties: false,
    },
    audience: ['employee'],
    requires: 'customers',
  },
};

/** Tools this principal may use with this scope (plan.md §5.2 step 3). */
export function availableTools(p: Principal, scope: ChatScope): ToolName[] {
  return (Object.keys(TOOL_SPECS) as ToolName[]).filter((name) => {
    const spec = TOOL_SPECS[name];
    if (!spec.audience.includes(p.type) || !p.access.can('read', spec.requires)) return false;
    if (spec.needs === 'customer') return Boolean(scope.customerId);
    if (spec.needs === 'org') return Boolean(scope.organizationId);
    if (spec.needs === 'customer_or_org') return Boolean(scope.customerId || scope.organizationId);
    return true;
  });
}

/** OpenAI-style tool definitions for the planner. */
export function toolDefinitions(names: ToolName[]) {
  return names.map((name) => ({
    type: 'function' as const,
    function: { name, description: TOOL_SPECS[name].description, parameters: TOOL_SPECS[name].parameters },
  }));
}

/** Validates model-supplied arguments against the tool's schema (subset: types, enums, patterns). */
export function validateArgs(name: ToolName, args: unknown): Record<string, unknown> {
  const schema = TOOL_SPECS[name].parameters as {
    properties: Record<string, { type: string; enum?: string[]; pattern?: string; minLength?: number }>;
    required?: string[];
  };
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('arguments must be an object');
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties[key];
    if (!prop) throw new Error(`unknown argument ${key}`);
    if (value === null || value === undefined) continue;
    if (prop.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
    if (prop.type === 'string') {
      if (typeof value !== 'string') throw new Error(`${key} must be a string`);
      if (prop.enum && !prop.enum.includes(value)) throw new Error(`${key} must be one of ${prop.enum.join(', ')}`);
      if (prop.pattern && !new RegExp(prop.pattern).test(value)) throw new Error(`${key} has an invalid format`);
      if (prop.minLength && value.length < prop.minLength) throw new Error(`${key} is too short`);
      if ((key === 'from' || key === 'to') && Number.isNaN(Date.parse(value))) throw new Error(`${key} must be a date`);
    }
    out[key] = value;
  }
  for (const key of schema.required ?? []) if (out[key] === undefined) throw new Error(`missing argument ${key}`);
  return out;
}

const money = (amount: string | number, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(amount));

const METHOD_LABEL: Record<string, string> = {
  card_online: 'card (online)',
  card_pos: 'card (in person)',
  bank_transfer: 'bank transfer',
  cash: 'cash',
  wallet: 'wallet',
  other: 'other',
};

@Injectable()
export class ChatToolsService {
  constructor(
    private readonly db: DbService,
    private readonly freshdesk: FreshdeskService,
  ) {}

  async run(p: Principal, scope: ChatScope, name: ToolName, rawArgs: unknown): Promise<ToolResult> {
    if (!availableTools(p, scope).includes(name)) return { evidence: [], status: 'denied', note: 'tool not available' };
    const args = validateArgs(name, rawArgs);
    if (name === 'list_tickets' || name === 'get_ticket') {
      const evidence = await this.tickets(p, scope, name, args);
      return { evidence, status: evidence.length ? 'ok' : 'empty' };
    }
    if (name === 'search_knowledge') return this.db.read(p, (db) => this.knowledge(db, p, String(args.query)));
    return this.db.read(p, async (db) => {
      const evidence = await this.execute(db, p, scope, name, args);
      return { evidence, status: evidence.length ? 'ok' : 'empty' };
    });
  }

  /** Saved answers (approved replies) and article passages, with their buttons. */
  private async knowledge(db: PoolClient, p: Principal, query: string): Promise<ToolResult> {
    const { answers, passages } = await searchKnowledge(db, query, p.type);
    const evidence: Evidence[] = [
      ...answers.map((a) => ({ type: 'answer' as const, id: a.id, title: a.title, fields: { approved_answer: a.body } })),
      ...passages.map((s) => ({
        type: 'article' as const,
        id: s.slug,
        title: s.heading ? `${s.title} — ${s.heading}` : s.title,
        fields: { article: s.title, section: s.heading, text: s.body },
      })),
    ];
    return { evidence, status: evidence.length ? 'ok' : 'empty', actions: await actionsFor(db, answers, passages, p.type) };
  }

  /** Freshdesk tools: same ownership checks as the API (reader role), private notes for staff only. */
  private async tickets(p: Principal, scope: ChatScope, name: 'list_tickets' | 'get_ticket', a: Record<string, unknown>): Promise<Evidence[]> {
    if (name === 'get_ticket') {
      const hints = await this.db.read(p, async (db) =>
        (
          await db.query<{ id: string }>(
            scope.organizationId ? 'SELECT id FROM core.customers WHERE organization_id = $1' : 'SELECT id FROM core.customers WHERE id = $1',
            [scope.organizationId ?? scope.customerId ?? null],
          )
        ).rows.map((r) => r.id),
      );
      const t = await this.freshdesk.ticketDetail(p, String(a.ticket_id), 'reader', hints);
      const replies = t.conversation.slice(-5).map((c) => `${c.from}${c.private ? ' (private note)' : ''}: ${c.body.slice(0, 400)}`);
      return [
        {
          type: 'ticket',
          id: `#${t.id}`,
          title: `${t.subject} — ${t.status}`,
          url: t.url ?? undefined,
          fields: {
            ticket: `#${t.id}`,
            status: t.status,
            priority: t.priority,
            opened: formatLocal(t.created_at, scope.timeZone),
            last_update: formatLocal(t.updated_at, scope.timeZone),
            description: t.description?.slice(0, 600) ?? null,
            latest_replies: replies.join(' | ') || null,
          },
        },
      ];
    }
    const customerIds = await this.db.read(p, async (db) =>
      (
        await db.query<{ id: string }>(
          scope.organizationId ? 'SELECT id FROM core.customers WHERE organization_id = $1' : 'SELECT id FROM core.customers WHERE id = $1',
          [scope.organizationId ?? scope.customerId],
        )
      ).rows.map((r) => r.id),
    );
    const tickets = await this.freshdesk.listTickets(p, customerIds, 'reader', a.status as string | undefined);
    return tickets.slice(0, 10).map((t) => ({
      type: 'ticket' as const,
      id: `#${t.id}`,
      title: `${t.subject} — ${t.status}`,
      url: t.url ?? undefined,
      fields: {
        ticket: `#${t.id}`,
        status: t.status,
        priority: t.priority,
        last_update: formatLocal(t.updated_at, scope.timeZone),
        ...(p.type === 'employee' || scope.organizationId ? { customer: t.customer_name } : {}),
      },
    }));
  }

  private async execute(db: PoolClient, p: Principal, scope: ChatScope, name: ToolName, a: Record<string, unknown>): Promise<Evidence[]> {
    const staff = p.type === 'employee';
    switch (name) {
      case 'get_customer_profile': {
        const notes = staff && p.access.can('read', 'notes_internal') ? ', c.notes_internal' : '';
        const rows = (
          await db.query(
            `SELECT c.id, c.customer_number, c.first_name, c.last_name, c.email, c.phone, c.status, c.org_role,
                    o.name AS organization, l.name AS preferred_location ${notes}
               FROM core.customers c
               LEFT JOIN core.organizations o ON o.id = c.organization_id
               LEFT JOIN core.locations l ON l.id = c.preferred_location_id
              WHERE c.id = $1`,
            [scope.customerId],
          )
        ).rows;
        return rows.map((r) => ({
          type: 'customer' as const,
          id: r.customer_number,
          title: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.customer_number,
          fields: {
            customer_number: r.customer_number,
            email: r.email,
            phone: r.phone,
            status: r.status,
            organization: r.organization,
            organization_role: r.org_role,
            preferred_location: r.preferred_location,
            ...(notes ? { internal_notes: r.notes_internal } : {}),
          },
        }));
      }

      case 'list_appointments':
      case 'get_appointment':
      case 'get_my_schedule': {
        const where: string[] = [];
        const params: unknown[] = [];
        const add = (sql: string, v: unknown) => {
          params.push(v);
          where.push(sql.replaceAll('?', `$${params.length}`));
        };
        if (name === 'get_appointment') add('a.appointment_number = ?', a.appointment_number);
        else if (name === 'get_my_schedule') add('a.employee_id = ?', p.id);
        else if (scope.customerId && !scope.organizationId) add('a.customer_id = ?', scope.customerId);
        else if (scope.organizationId)
          add('a.customer_id IN (SELECT id FROM core.customers WHERE organization_id = ?)', scope.organizationId);
        if (a.status) add('a.status = ?', a.status);
        let order = 'a.scheduled_start';
        if (a.from) add('a.scheduled_end > ?', a.from);
        if (a.to) add('a.scheduled_start < ?', a.to);
        if (name === 'get_my_schedule' && !a.from && !a.to) {
          where.push(`a.scheduled_end > now() AND a.scheduled_start < now() + interval '7 days'`);
        } else if (a.upcoming_only) {
          where.push(`a.scheduled_end > now() AND a.status IN ('scheduled', 'confirmed')`);
        } else if (name === 'list_appointments' && !a.from && !a.to) {
          // Default: what is coming up first, then the most recent past ones.
          order = `(a.scheduled_end > now()) DESC, CASE WHEN a.scheduled_end > now() THEN a.scheduled_start END,
                   a.scheduled_start DESC`;
        }
        const notes = staff && p.access.can('read', 'notes_internal') ? ', a.notes_internal' : '';
        const rows = (
          await db.query(
            `SELECT a.appointment_number, a.scheduled_start, a.status, a.price_quoted, a.currency, a.notes_customer,
                    s.name AS service, l.name AS location, l.time_zone,
                    nullif(concat_ws(' ', st.first_name, st.last_name), '') AS employee,
                    nullif(concat_ws(' ', c.first_name, c.last_name), '') AS customer ${notes}
               FROM core.appointments a
               JOIN core.services s ON s.id = a.service_id
               JOIN core.locations l ON l.id = a.location_id
               LEFT JOIN core.v_staff_public st ON st.id = a.employee_id
               LEFT JOIN core.customers c ON c.id = a.customer_id
              ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
              ORDER BY ${order}
              LIMIT 10`,
            params,
          )
        ).rows;
        return rows.map((r) => ({
          type: 'appointment' as const,
          id: r.appointment_number,
          title: `${r.service} — ${formatLocal(r.scheduled_start.toISOString(), r.time_zone)}`,
          fields: {
            appointment_number: r.appointment_number,
            when: formatLocal(r.scheduled_start.toISOString(), r.time_zone),
            status: r.status,
            service: r.service,
            location: r.location,
            with: r.employee,
            ...(staff || scope.organizationId ? { customer: r.customer } : {}),
            price: money(r.price_quoted, r.currency),
            note: r.notes_customer,
            ...(notes ? { internal_notes: r.notes_internal } : {}),
          },
        }));
      }

      case 'list_payments':
      case 'get_payment':
      case 'list_pending_bank_transfers':
      case 'list_unmatched_stripe_payments': {
        const where: string[] = [];
        const params: unknown[] = [];
        const add = (sql: string, v: unknown) => {
          params.push(v);
          where.push(sql.replaceAll('?', `$${params.length}`));
        };
        if (name === 'get_payment') add('p.payment_number = ?', a.payment_number);
        if (name === 'list_payments') add('p.customer_id = ?', scope.customerId);
        if (name === 'list_pending_bank_transfers') where.push(`p.method = 'bank_transfer' AND p.status = 'pending'`);
        if (name === 'list_unmatched_stripe_payments') where.push(`p.source = 'stripe' AND p.customer_id IS NULL`);
        if (a.status) add('p.status = ?', a.status);
        if (a.method) add('p.method = ?', a.method);
        if (a.from) add('coalesce(p.paid_at, p.created_at) >= ?', a.from);
        if (a.to) add('coalesce(p.paid_at, p.created_at) < ?', a.to);
        const rows = (
          await db.query(
            `SELECT p.payment_number, p.source, p.method, p.status, p.amount, p.amount_refunded, p.currency, p.paid_at,
                    to_char(p.expected_at, 'YYYY-MM-DD') AS expected_at, p.created_at, p.receipt_url, p.failure_reason, p.card_brand, p.card_last4,
                    p.pos_reference, p.bank_reference, a.appointment_number,
                    nullif(concat_ws(' ', c.first_name, c.last_name), '') AS customer,
                    coalesce(l.time_zone, $${params.length + 1}) AS time_zone,
                    (p.method = 'bank_transfer' AND p.status = 'pending'
                     AND coalesce(p.expected_at, p.created_at::date)
                         + (SELECT bank_transfer_due_days FROM core.settings WHERE id = 1) < current_date) AS overdue
               FROM core.payments p
               LEFT JOIN core.appointments a ON a.id = p.appointment_id
               LEFT JOIN core.customers c ON c.id = p.customer_id
               LEFT JOIN core.locations l ON l.id = p.location_id
              ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
              ORDER BY coalesce(p.paid_at, p.created_at) DESC
              LIMIT 10`,
            [...params, scope.timeZone],
          )
        ).rows.filter((r) => (a.overdue_only ? r.overdue : true));
        return rows.map((r) => {
          const transferState =
            r.method === 'bank_transfer' ? (r.status === 'pending' ? (r.overdue ? 'pending (overdue)' : 'pending — not received yet') : 'received') : undefined;
          return {
            type: 'payment' as const,
            id: r.payment_number,
            title: `${money(r.amount, r.currency)} by ${METHOD_LABEL[r.method] ?? r.method} — ${transferState ?? r.status}`,
            url: r.receipt_url ?? undefined,
            fields: {
              payment_number: r.payment_number,
              amount: money(r.amount, r.currency),
              refunded: Number(r.amount_refunded) > 0 ? money(r.amount_refunded, r.currency) : null,
              method: METHOD_LABEL[r.method] ?? r.method,
              status: transferState ?? r.status,
              date: r.paid_at ? formatLocal(r.paid_at.toISOString(), r.time_zone) : null,
              expected: r.expected_at,
              card: r.card_last4 ? `${r.card_brand ?? 'card'} •••• ${r.card_last4}` : null,
              failure_reason: r.failure_reason,
              appointment: r.appointment_number,
              ...(staff
                ? { customer: r.customer, source: r.source, pos_reference: r.pos_reference, bank_reference: r.bank_reference }
                : {}),
            },
          };
        });
      }

      case 'get_balance': {
        const r = (await db.query('SELECT billed, paid, balance FROM core.v_customer_balance WHERE customer_id = $1', [scope.customerId])).rows[0];
        if (!r) return [];
        const currency = (await db.query<{ c: string }>('SELECT default_currency AS c FROM core.settings WHERE id = 1')).rows[0].c;
        return [
          {
            type: 'balance',
            id: 'balance',
            title: Number(r.balance) > 0 ? `${money(r.balance, currency)} owed` : 'Nothing owed',
            fields: { billed: money(r.billed, currency), paid: money(r.paid, currency), balance: money(r.balance, currency) },
          },
        ];
      }

      case 'list_services': {
        const params: unknown[] = [];
        const where = ['active'];
        if (a.category) {
          params.push(a.category);
          where.push(`category ILIKE $${params.length}`);
        }
        if (a.query) {
          params.push(`%${a.query}%`);
          where.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`);
        }
        const rows = (
          await db.query(
            `SELECT code, name, description, category, duration_minutes, price, currency FROM core.services
              WHERE ${where.join(' AND ')} ORDER BY category NULLS LAST, name LIMIT 20`,
            params,
          )
        ).rows;
        return rows.map((r) => ({
          type: 'service' as const,
          id: r.code,
          title: `${r.name} — ${money(r.price, r.currency)}`,
          fields: { name: r.name, price: money(r.price, r.currency), duration_minutes: r.duration_minutes, category: r.category, description: r.description },
        }));
      }

      case 'list_locations': {
        const rows = (await db.query('SELECT code, name, address, phone, time_zone FROM core.locations WHERE active ORDER BY name')).rows;
        return rows.map((r) => ({
          type: 'location' as const,
          id: r.code,
          title: r.name,
          fields: { name: r.name, phone: r.phone, time_zone: r.time_zone, address: r.address ? JSON.stringify(r.address) : null },
        }));
      }

      case 'get_organization': {
        const rows = (
          await db.query(
            `SELECT o.org_number, o.name, o.email, o.phone,
                    (SELECT count(*)::int FROM core.customers m WHERE m.organization_id = o.id) AS members
               FROM core.organizations o WHERE o.id = $1`,
            [scope.organizationId],
          )
        ).rows;
        return rows.map((r) => ({
          type: 'organization' as const,
          id: r.org_number,
          title: r.name,
          fields: { org_number: r.org_number, name: r.name, email: r.email, phone: r.phone, members: r.members },
        }));
      }

      case 'list_organization_members': {
        const rows = (
          await db.query(
            `SELECT customer_number, first_name, last_name, email, org_role, status
               FROM core.customers WHERE organization_id = $1 ORDER BY org_role = 'org_admin' DESC, last_name LIMIT 50`,
            [scope.organizationId],
          )
        ).rows;
        return rows.map((r) => ({
          type: 'customer' as const,
          id: r.customer_number,
          title: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.customer_number,
          fields: { customer_number: r.customer_number, email: r.email, role: r.org_role, status: r.status },
        }));
      }

      case 'list_tickets':
      case 'get_ticket':
        return []; // handled by tickets() before reaching SQL tools

      case 'search_knowledge':
        return []; // handled in run() (it also returns buttons)

      case 'search_customers': {
        const rows = (
          await db.query(
            `SELECT customer_number, first_name, last_name, email, phone, status
               FROM core.customers
              WHERE customer_number = upper($1) OR email = $1 OR phone = $1
                 OR (coalesce(first_name, '') || ' ' || coalesce(last_name, '')) % $1
              ORDER BY similarity(coalesce(first_name, '') || ' ' || coalesce(last_name, ''), $1) DESC
              LIMIT 10`,
            [a.query],
          )
        ).rows;
        return rows.map((r) => ({
          type: 'customer' as const,
          id: r.customer_number,
          title: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.customer_number,
          fields: { customer_number: r.customer_number, email: r.email, phone: r.phone, status: r.status },
        }));
      }
    }
  }
}
