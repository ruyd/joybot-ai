import { HttpException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Principal } from '../auth/principal';
import { DbService } from '../db/db.module';
import { extractIdentifiers, hasIdentifiers, type Identifiers } from './extraction';
import { planByRules, type PlannedCall } from './intents';
import { LLM_PROVIDER, type ChatTurn, type LlmProvider } from './llm/llm.provider';
import { parseRelativeRange } from './time';
import { availableTools, ChatToolsService, toolDefinitions, validateArgs, TOOL_SPECS, type ChatScope, type Evidence, type ToolName, type ToolResult } from './tools';

/** Server-sent event sink (plan.md §5.2: status, customer, disambiguation, sources, token, citations, done, error). */
export interface ChatSink {
  event(name: string, data: unknown): void;
  readonly signal: AbortSignal;
}

interface Candidate {
  kind: 'customer' | 'organization';
  id: string;
  label: string;
  number: string;
  detail: string | null;
}

const MAX_TOOL_CALLS = 8;
const TOOL_TIMEOUT_MS = 4_000;
const MAX_EVIDENCE = 20;
const NAME_SIMILARITY = 0.45;

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly db: DbService,
    private readonly tools: ChatToolsService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  /**
   * Questions per rolling 24 hours (settings). Checked before streaming starts, so the client gets
   * a plain 429 with the time it can ask again.
   */
  async assertQuota(p: Principal): Promise<void> {
    const q = await this.db.as(p, async (db) =>
      (
        await db.query<{ used: number; limit: number; oldest: Date | null }>(
          `SELECT count(*)::int AS used, min(m.created_at) AS oldest,
                  (SELECT CASE WHEN $1 = 'customer' THEN chat_daily_limit_customer ELSE chat_daily_limit_employee END
                     FROM core.settings WHERE id = 1) AS limit
             FROM app.messages m JOIN app.conversations c ON c.id = m.conversation_id
            WHERE m.role = 'user' AND m.created_at > now() - interval '24 hours'`,
          [p.type],
        )
      ).rows[0],
    );
    if (q.used < q.limit) return;
    const retryAfter = q.oldest ? Math.max(60, Math.ceil((q.oldest.getTime() + 86_400_000 - Date.now()) / 1000)) : 3600;
    throw new HttpException(
      {
        statusCode: 429,
        code: 'chat_quota_exceeded',
        message: `You have reached the limit of ${q.limit} questions per day. Please try again later.`,
        retry_after: retryAfter,
      },
      429,
    );
  }

  /** Throws NotFound before any streaming starts when the conversation is not the principal's. */
  async assertConversation(p: Principal, conversationId: string): Promise<void> {
    const found = await this.db.as(p, async (db) =>
      (await db.query('SELECT 1 FROM app.conversations WHERE id = $1', [conversationId])).rowCount,
    );
    if (!found) throw new NotFoundException('Conversation not found');
  }

  async respond(p: Principal, conversationId: string, question: string, sink: ChatSink): Promise<void> {
    const started = Date.now();
    const ctx = await this.db.as(p, async (db) => {
      const conversation = (
        await db.query<{ active_customer_id: string | null; active_organization_id: string | null }>(
          'SELECT active_customer_id, active_organization_id FROM app.conversations WHERE id = $1',
          [conversationId],
        )
      ).rows[0];
      const history = (
        await db.query<ChatTurn>(
          `SELECT role, content FROM (
             SELECT role, content, created_at FROM app.messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 6
           ) m ORDER BY created_at`,
          [conversationId],
        )
      ).rows;
      await db.query(`INSERT INTO app.messages (conversation_id, role, content) VALUES ($1, 'user', $2)`, [conversationId, question]);
      return { conversation, history, ...(await this.principalContext(db, p)) };
    });

    // 1. Scope ------------------------------------------------------------------------------------
    let scope: ChatScope = { timeZone: ctx.timeZone };
    if (p.type === 'customer') {
      scope = { ...scope, customerId: p.id, organizationId: p.role === 'org_admin' ? (ctx.organizationId ?? undefined) : undefined };
    } else {
      scope = {
        ...scope,
        customerId: ctx.conversation.active_customer_id ?? undefined,
        organizationId: ctx.conversation.active_organization_id ?? undefined,
      };
      const ids = extractIdentifiers(question);
      if (hasIdentifiers(ids)) {
        sink.event('status', { message: 'Looking up the customer…' });
        const candidates = await this.resolve(p, ids);
        const exact = ids.emails.length + ids.phones.length + ids.customerNumbers.length + ids.orgNumbers.length +
          ids.appointmentNumbers.length + ids.paymentNumbers.length > 0;
        if (candidates.length > 1) {
          sink.event('disambiguation', { candidates });
          await this.finish(p, conversationId, 'I found more than one match. Which one did you mean?', [], [], started, sink, false);
          return;
        }
        if (candidates.length === 1) {
          const [c] = candidates;
          scope = c.kind === 'customer' ? { ...scope, customerId: c.id, organizationId: undefined } : { ...scope, organizationId: c.id, customerId: undefined };
          await this.setConversationScope(p, conversationId, scope);
          sink.event(c.kind, { id: c.id, number: c.number, name: c.label, detail: c.detail });
        } else if (exact) {
          await this.finish(p, conversationId, "I couldn't find a customer matching that among the records you have access to.", [], [], started, sink, false);
          return;
        }
        // Only name-like words matched nothing (e.g. a service name): keep the current scope.
      }
    }

    // 2. Plan --------------------------------------------------------------------------------------
    const range = parseRelativeRange(question, ctx.timeZone);
    const allowed = availableTools(p, scope);
    let calls: PlannedCall[] = planByRules(question, {
      audience: p.type,
      hasCustomerScope: Boolean(scope.customerId),
      hasOrgScope: Boolean(scope.organizationId),
      range,
    });
    const ids = extractIdentifiers(question);
    for (const n of ids.appointmentNumbers) calls.push({ tool: 'get_appointment', args: { appointment_number: n } });
    for (const n of ids.paymentNumbers) calls.push({ tool: 'get_payment', args: { payment_number: n } });

    if (calls.length === 0 && allowed.length > 0) {
      sink.event('status', { message: 'Thinking about what to look up…' });
      try {
        const planned = await this.llm.plan({
          audience: p.type,
          question,
          history: ctx.history,
          scopeSummary: this.scopeSummary(p, scope),
          now: new Date().toISOString(),
          timeZone: ctx.timeZone,
          tools: toolDefinitions(allowed),
        });
        calls = planned.map((c) => ({ tool: c.tool, args: c.args as Record<string, unknown> }));
      } catch (err) {
        this.logger.warn(`planner failed: ${(err as Error).message}`);
      }
    }
    calls = calls.filter((c) => allowed.includes(c.tool)).slice(0, MAX_TOOL_CALLS);

    // 3. Retrieve ----------------------------------------------------------------------------------
    const results = await Promise.all(
      calls.map(async (call) => {
        sink.event('status', { message: `Checking ${TOOL_SPECS[call.tool].requires.replace('_', ' ')}…` });
        const t0 = Date.now();
        let result: ToolResult;
        try {
          validateArgs(call.tool, call.args);
          result = await withTimeout(this.tools.run(p, scope, call.tool, call.args), TOOL_TIMEOUT_MS);
        } catch (err) {
          const timedOut = (err as Error).message === 'timeout';
          result = { evidence: [], status: 'error', note: timedOut ? 'timeout' : (err as Error).message };
        }
        return { call, result, ms: Date.now() - t0 };
      }),
    );
    const seen = new Set<string>();
    const evidence: Evidence[] = [];
    for (const { result } of results) {
      for (const e of result.evidence) {
        const key = `${e.type}:${e.id}`;
        if (!seen.has(key) && evidence.length < MAX_EVIDENCE) {
          seen.add(key);
          evidence.push(e);
        }
      }
    }
    sink.event('sources', results.map(({ call, result }) => ({ tool: call.tool, status: result.status, records: result.evidence.length })));
    sink.event('citations', evidence.map((e, i) => ({ n: i + 1, type: e.type, id: e.id, title: e.title, url: e.url ?? null })));

    // 4. Answer ------------------------------------------------------------------------------------
    let answer = '';
    try {
      for await (const token of this.llm.answer(
        { audience: p.type, businessName: ctx.businessName, timeZone: ctx.timeZone, question, history: ctx.history, evidence },
        sink.signal,
      )) {
        answer += token;
        sink.event('token', { text: token });
      }
    } catch (err) {
      if (sink.signal.aborted) return;
      this.logger.error(`answer failed: ${(err as Error).message}`);
      sink.event('error', { message: 'The assistant is unavailable right now. Please try again shortly.' });
      if (!answer) return;
    }

    await this.finish(p, conversationId, answer, evidence, results, started, sink, true, scope);
  }

  // ---------------------------------------------------------------------------------------------

  private async finish(
    p: Principal,
    conversationId: string,
    answer: string,
    evidence: Evidence[],
    results: { call: PlannedCall; result: ToolResult; ms: number }[],
    started: number,
    sink: ChatSink,
    streamed: boolean,
    scope?: ChatScope,
  ): Promise<void> {
    // Fixed replies (disambiguation, not found) are sent as one token.
    if (!streamed && !sink.signal.aborted) sink.event('token', { text: answer });
    const messageId = await this.db.as(p, async (db) => {
      const citations = evidence.map((e, i) => ({ n: i + 1, type: e.type, id: e.id, title: e.title, url: e.url ?? null }));
      const id = (
        await db.query<{ id: string }>(
          `INSERT INTO app.messages (conversation_id, role, content, citations, latency_ms)
           VALUES ($1, 'assistant', $2, $3, $4) RETURNING id`,
          [conversationId, answer, JSON.stringify(citations), Date.now() - started],
        )
      ).rows[0].id;
      for (const { call, result, ms } of results) {
        await db.query(
          `INSERT INTO app.retrieval_traces
             (message_id, principal_type, principal_id, customer_id, organization_id, tool, params, status, latency_ms, record_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            id,
            p.type,
            p.id,
            scope?.customerId ?? null,
            scope?.organizationId ?? null,
            call.tool,
            JSON.stringify(call.args),
            result.note === 'timeout' ? 'timeout' : result.status,
            ms,
            result.evidence.map((e) => e.id),
          ],
        );
      }
      // First question becomes the conversation title.
      await db.query(
        `UPDATE app.conversations c
            SET updated_at = now(),
                title = coalesce(c.title, (SELECT left(m.content, 80) FROM app.messages m
                                            WHERE m.conversation_id = c.id AND m.role = 'user'
                                            ORDER BY m.created_at LIMIT 1))
          WHERE c.id = $1`,
        [conversationId],
      );
      return id;
    });
    sink.event('done', { messageId });
  }

  private async principalContext(db: PoolClient, p: Principal) {
    const row = (
      await db.query<{ time_zone: string; business_name: string; organization_id: string | null }>(
        p.type === 'employee'
          ? `SELECT coalesce(u.time_zone, l.time_zone, s.default_time_zone) AS time_zone, s.business_name, NULL::uuid AS organization_id
               FROM core.users u CROSS JOIN core.settings s LEFT JOIN core.locations l ON l.id = u.home_location_id
              WHERE u.id = $1 AND s.id = 1`
          : `SELECT coalesce(c.time_zone, l.time_zone, s.default_time_zone) AS time_zone, s.business_name, c.organization_id
               FROM core.customers c CROSS JOIN core.settings s LEFT JOIN core.locations l ON l.id = c.preferred_location_id
              WHERE c.id = $1 AND s.id = 1`,
        [p.id],
      )
    ).rows[0];
    return { timeZone: row?.time_zone ?? 'UTC', businessName: row?.business_name ?? 'JoyBot', organizationId: row?.organization_id ?? null };
  }

  /** Customers and organizations matching the identifiers that this employee can access (RLS). */
  private async resolve(p: Principal, ids: Identifiers): Promise<Candidate[]> {
    return this.db.read(p, async (db) => {
      const found = new Map<string, Candidate>();
      const addCustomers = async (sql: string, params: unknown[]) => {
        for (const r of (
          await db.query(
            `SELECT c.id, c.customer_number, c.first_name, c.last_name, c.email, o.name AS org
               FROM core.customers c LEFT JOIN core.organizations o ON o.id = c.organization_id WHERE ${sql} LIMIT 6`,
            params,
          )
        ).rows) {
          found.set(r.id, {
            kind: 'customer',
            id: r.id,
            number: r.customer_number,
            label: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.customer_number,
            detail: [r.email, r.org].filter(Boolean).join(' · ') || null,
          });
        }
      };
      if (ids.customerNumbers.length) await addCustomers('c.customer_number = ANY($1)', [ids.customerNumbers]);
      if (ids.emails.length) await addCustomers('c.email = ANY($1::citext[])', [ids.emails]);
      if (ids.phones.length) await addCustomers('c.phone = ANY($1)', [ids.phones]);
      if (ids.appointmentNumbers.length) {
        await addCustomers('c.id IN (SELECT customer_id FROM core.appointments WHERE appointment_number = ANY($1))', [ids.appointmentNumbers]);
      }
      if (ids.paymentNumbers.length) {
        await addCustomers('c.id IN (SELECT customer_id FROM core.payments WHERE payment_number = ANY($1))', [ids.paymentNumbers]);
      }
      const exactCustomer = found.size > 0;
      if (!exactCustomer) {
        for (const name of ids.names) {
          await addCustomers(
            `similarity(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''), $1) >= $2
             ORDER BY similarity(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''), $1) DESC`,
            [name, NAME_SIMILARITY],
          );
        }
      }
      if (!exactCustomer && found.size === 0) {
        const orgs = (
          await db.query(
            `SELECT id, org_number, name, email FROM core.organizations
              WHERE org_number = ANY($1) OR EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE similarity(name, n) >= $3)
              LIMIT 6`,
            [ids.orgNumbers, ids.names, NAME_SIMILARITY],
          )
        ).rows;
        for (const o of orgs) found.set(o.id, { kind: 'organization', id: o.id, number: o.org_number, label: o.name, detail: o.email });
      }
      return [...found.values()];
    });
  }

  /**
   * The customer or organization a conversation is pinned to, as the scope card the chat streams
   * (same shape as the `customer`/`organization` events), so a reopened conversation can show it.
   * Read under RLS: a record the employee can no longer see comes back as null.
   */
  async scopeCard(p: Principal, conversationId: string) {
    return this.db.read(p, async (db) => {
      const conv = (
        await db.query<{ active_customer_id: string | null; active_organization_id: string | null }>(
          'SELECT active_customer_id, active_organization_id FROM app.conversations WHERE id = $1',
          [conversationId],
        )
      ).rows[0];
      if (conv?.active_customer_id) {
        const r = (
          await db.query(
            `SELECT c.id, c.customer_number, c.first_name, c.last_name, c.email, o.name AS org
               FROM core.customers c LEFT JOIN core.organizations o ON o.id = c.organization_id WHERE c.id = $1`,
            [conv.active_customer_id],
          )
        ).rows[0];
        if (!r) return null;
        return {
          kind: 'customer' as const,
          id: r.id,
          number: r.customer_number,
          name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.customer_number,
          detail: [r.email, r.org].filter(Boolean).join(' · ') || null,
        };
      }
      if (conv?.active_organization_id) {
        const o = (await db.query('SELECT id, org_number, name, email FROM core.organizations WHERE id = $1', [conv.active_organization_id])).rows[0];
        if (!o) return null;
        return { kind: 'organization' as const, id: o.id, number: o.org_number, name: o.name, detail: o.email ?? null };
      }
      return null;
    });
  }

  private async setConversationScope(p: Principal, conversationId: string, scope: ChatScope) {
    await this.db.as(p, (db) =>
      db.query('UPDATE app.conversations SET active_customer_id = $2, active_organization_id = $3 WHERE id = $1', [
        conversationId,
        scope.customerId ?? null,
        scope.organizationId ?? null,
      ]),
    );
  }

  private scopeSummary(p: Principal, scope: ChatScope): string {
    if (p.type === 'customer') return scope.organizationId ? "the customer's own records and their organization" : "the customer's own records";
    if (scope.customerId) return 'one customer selected by the employee';
    if (scope.organizationId) return 'one organization selected by the employee';
    return "no customer selected (the employee's own schedule and general information only)";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export type { ToolName };
