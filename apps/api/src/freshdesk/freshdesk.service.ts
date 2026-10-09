import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { PoolClient } from 'pg';
import type { Principal } from '../auth/principal';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DbService } from '../db/db.module';
import {
  FreshdeskClient,
  FreshdeskError,
  phoneVariants,
  ticketPriority,
  ticketStatus,
  type FreshdeskConversation,
  type FreshdeskTicket,
} from './freshdesk.client';

export interface TicketSummary {
  id: string;
  subject: string;
  status: string;
  priority: string;
  created_at: string;
  updated_at: string;
  customer_id: string;
  customer_name: string | null;
  url: string | null;
}

export interface TicketDetail extends TicketSummary {
  description: string | null;
  conversation: { id: string; body: string; from: 'customer' | 'support'; private: boolean; created_at: string }[];
}

const CONTACT_TTL_MS = 24 * 3_600_000;
const TICKETS_TTL_MS = 90_000;
const BREAKER_THRESHOLD = 5;
const BREAKER_OPEN_MS = 60_000;
const MAX_CUSTOMERS = 50;

type Run = <T>(fn: (db: PoolClient) => Promise<T>) => Promise<T>;

/**
 * Freshdesk tickets for customers in the principal's scope (plan.md §4.5). Contacts are matched only
 * by *verified* email/phone; every ticket is checked against those contacts before it is returned;
 * private notes are only shown to employees.
 */
@Injectable()
export class FreshdeskService {
  private readonly secrets = new SecretsManagerClient({});
  private apiKey?: { value: string | undefined; at: number };
  private readonly ticketCache = new Map<string, { at: number; tickets: FreshdeskTicket[] }>();
  private failures = 0;
  private openUntil = 0;

  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Ticket lists for customers in scope (RLS decides which customers are visible). */
  async listTickets(p: Principal, customerIds: string[], via: 'app' | 'reader' = 'app', status?: string): Promise<TicketSummary[]> {
    const run = this.runner(p, via);
    const { client, links } = await this.prepare(run);
    const all: TicketSummary[] = [];
    await Promise.all(
      customerIds.slice(0, MAX_CUSTOMERS).map(async (customerId) => {
        const contactIds = await this.contactIds(run, client, customerId);
        if (contactIds.length === 0) return;
        const tickets = await this.ticketsFor(client, contactIds);
        const name = await run(async (db) => (await db.query<{ n: string | null }>(
          `SELECT nullif(concat_ws(' ', first_name, last_name), '') AS n FROM core.customers WHERE id = $1`, [customerId])).rows[0]?.n ?? null);
        for (const t of tickets) {
          // Ownership filter: only tickets requested by this customer's own contacts.
          if (!contactIds.includes(String(t.requester_id))) continue;
          all.push(this.summary(t, customerId, name, p, links));
        }
      }),
    );
    return all
      .filter((t) => !status || t.status === status)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  /** One ticket, only if it belongs to a customer the principal may read tickets for. */
  async ticketDetail(p: Principal, ticketId: string, via: 'app' | 'reader' = 'app', hintCustomerIds: string[] = []): Promise<TicketDetail> {
    if (!/^\d{1,12}$/.test(ticketId)) throw new NotFoundException('Ticket not found');
    const run = this.runner(p, via);
    const { client, links } = await this.prepare(run);
    let ticket: FreshdeskTicket;
    try {
      ticket = await this.call(() => client.ticket(ticketId));
    } catch (err) {
      if (err instanceof FreshdeskError && err.status === 404) throw new NotFoundException('Ticket not found');
      throw err;
    }
    const owner = () =>
      run(async (db) =>
        (await db.query<{ id: string | null }>('SELECT authz.customer_for_freshdesk_contact($1) AS id', [String(ticket.requester_id)])).rows[0].id,
      );
    let customerId = await owner();
    if (!customerId) {
      // Opened by direct link before the contact links were cached (or they are stale):
      // refresh the plausible owners, then check again. Still limited to customers in scope.
      const candidates = await run(async (db) =>
        (
          p.type === 'customer'
            ? await db.query<{ id: string }>(
                `SELECT m.id FROM core.customers m JOIN core.customers me ON me.id = $1
                  WHERE m.id = me.id OR (me.org_role = 'org_admin' AND m.organization_id = me.organization_id)`,
                [p.id],
              )
            : await db.query<{ id: string }>('SELECT id FROM core.customers WHERE id = ANY($1::uuid[])', [hintCustomerIds])
        ).rows.map((r) => r.id),
      );
      for (const candidate of candidates.slice(0, MAX_CUSTOMERS)) await this.contactIds(run, client, candidate, true);
      customerId = await owner();
    }
    if (!customerId) throw new NotFoundException('Ticket not found');
    const name = await run(async (db) => (await db.query<{ n: string | null }>(
      `SELECT nullif(concat_ws(' ', first_name, last_name), '') AS n FROM core.customers WHERE id = $1`, [customerId])).rows[0]?.n ?? null);
    const conversations = await this.call(() => client.conversations(ticketId));
    const employee = p.type === 'employee';
    return {
      ...this.summary(ticket, customerId, name, p, links),
      description: ticket.description_text ?? null,
      conversation: conversations
        .filter((c: FreshdeskConversation) => employee || !c.private)
        .map((c) => ({
          id: String(c.id),
          body: c.body_text,
          from: c.incoming || c.user_id === ticket.requester_id ? 'customer' : 'support',
          private: c.private,
          created_at: c.created_at,
        })),
    };
  }

  async testConnection(p: Principal): Promise<{ ok: true }> {
    const { client } = await this.prepare(this.runner(p, 'app'));
    await client.ping();
    return { ok: true };
  }

  // ---------------------------------------------------------------------------------------------

  private runner(p: Principal, via: 'app' | 'reader'): Run {
    return (fn) => (via === 'reader' ? this.db.read(p, fn) : this.db.as(p, fn));
  }

  private async prepare(run: Run) {
    const s = await run(async (db) =>
      (await db.query<{ freshdesk_domain: string | null; freshdesk_portal_url: string | null }>(
        'SELECT freshdesk_domain, freshdesk_portal_url FROM core.settings WHERE id = 1',
      )).rows[0],
    );
    const key = await this.key();
    const base = this.cfg.FRESHDESK_BASE_URL ?? (s?.freshdesk_domain ? `https://${s.freshdesk_domain}` : undefined);
    if (!base || !key) {
      throw new ServiceUnavailableException({ statusCode: 503, code: 'freshdesk_not_configured', message: 'Support tickets are not set up yet.' });
    }
    return {
      client: new FreshdeskClient(base, key),
      links: {
        portal: s?.freshdesk_portal_url ?? (s?.freshdesk_domain ? `https://${s.freshdesk_domain}` : null),
        agent: s?.freshdesk_domain ? `https://${s.freshdesk_domain}` : null,
      },
    };
  }

  private async key(): Promise<string | undefined> {
    if (this.cfg.FRESHDESK_API_KEY) return this.cfg.FRESHDESK_API_KEY;
    if (!this.cfg.FRESHDESK_SECRET_ARN) return undefined;
    if (this.apiKey && Date.now() - this.apiKey.at < 5 * 60_000) return this.apiKey.value;
    const res = await this.secrets.send(new GetSecretValueCommand({ SecretId: this.cfg.FRESHDESK_SECRET_ARN }));
    this.apiKey = { value: JSON.parse(res.SecretString ?? '{}').apiKey || undefined, at: Date.now() };
    return this.apiKey.value;
  }

  /** Freshdesk contact IDs for a customer: cached links, refreshed daily from verified contacts. */
  private async contactIds(run: Run, client: FreshdeskClient, customerId: string, force = false): Promise<string[]> {
    const cached = await run(async (db) =>
      (await db.query<{ external_id: string; refreshed_at: Date }>('SELECT * FROM authz.freshdesk_contacts($1)', [customerId])).rows,
    );
    if (!force && cached.length > 0 && cached.every((c) => Date.now() - c.refreshed_at.getTime() < CONTACT_TTL_MS)) {
      return cached.map((c) => c.external_id);
    }
    const contact = await run(async (db) =>
      (await db.query<{ email: string | null; email_verified: boolean; phone: string | null; phone_verified: boolean }>(
        'SELECT email, email_verified, phone, phone_verified FROM core.customers WHERE id = $1',
        [customerId],
      )).rows[0],
    );
    if (!contact) return [];
    const found = new Map<string, string>();
    if (contact.email && contact.email_verified) {
      for (const c of await this.call(() => client.contacts({ email: contact.email! }))) found.set(String(c.id), 'email');
    }
    if (contact.phone && contact.phone_verified) {
      for (const variant of phoneVariants(contact.phone)) {
        for (const field of ['phone', 'mobile'] as const) {
          for (const c of await this.call(() => client.contacts({ [field]: variant }))) if (!found.has(String(c.id))) found.set(String(c.id), 'phone');
        }
      }
    }
    await run((db) => db.query('SELECT authz.cache_freshdesk_contacts($1, $2, $3)', [customerId, [...found.keys()], [...found.values()]]));
    // Re-read so contacts staff excluded as wrong matches stay excluded.
    return run(async (db) => (await db.query<{ external_id: string }>('SELECT external_id FROM authz.freshdesk_contacts($1)', [customerId])).rows.map((r) => r.external_id));
  }

  private async ticketsFor(client: FreshdeskClient, contactIds: string[]): Promise<FreshdeskTicket[]> {
    const key = [...contactIds].sort().join(',');
    const hit = this.ticketCache.get(key);
    if (hit && Date.now() - hit.at < TICKETS_TTL_MS) return hit.tickets;
    const tickets = (await Promise.all(contactIds.map((id) => this.call(() => client.ticketsByRequester(id))))).flat();
    this.ticketCache.set(key, { at: Date.now(), tickets });
    return tickets;
  }

  /** Circuit breaker: after repeated failures, stop calling Freshdesk for a minute. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    if (Date.now() < this.openUntil) {
      throw new ServiceUnavailableException({ statusCode: 503, code: 'freshdesk_unavailable', message: 'Support tickets are unavailable right now.' });
    }
    try {
      const result = await fn();
      this.failures = 0;
      return result;
    } catch (err) {
      if (err instanceof FreshdeskError && err.status === 404) throw err;
      if (++this.failures >= BREAKER_THRESHOLD) this.openUntil = Date.now() + BREAKER_OPEN_MS;
      throw new ServiceUnavailableException({ statusCode: 503, code: 'freshdesk_unavailable', message: 'Support tickets are unavailable right now.' });
    }
  }

  private summary(t: FreshdeskTicket, customerId: string, customerName: string | null, p: Principal, links: { portal: string | null; agent: string | null }): TicketSummary {
    const url = p.type === 'employee'
      ? links.agent && `${links.agent}/a/tickets/${t.id}`
      : links.portal && `${links.portal.replace(/\/$/, '')}/support/tickets/${t.id}`;
    return {
      id: String(t.id),
      subject: t.subject,
      status: ticketStatus(t.status),
      priority: ticketPriority(t.priority),
      created_at: t.created_at,
      updated_at: t.updated_at,
      customer_id: customerId,
      customer_name: customerName,
      url: url || null,
    };
  }

  /** Test hook: forget cached tickets and breaker state. */
  reset(): void {
    this.ticketCache.clear();
    this.failures = 0;
    this.openUntil = 0;
  }
}
