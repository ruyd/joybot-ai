import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvidenceOnlyProvider, LLM_PROVIDER, type AnswerInput, type LlmProvider, type PlanInput, type PlannedToolCall } from '../src/chat/llm/llm.provider';
import { api, createApp, customer, employee } from './app';

const { customers: C, users: U, orgs: O } = SAMPLE;

interface Sse {
  events: { event: string; data: any }[];
  of(name: string): any[];
  text: string;
}

/** Sends a chat message and collects the server-sent events. */
async function chat(app: INestApplication, who: { type: 'employee' | 'customer'; id: string }, conversationId: string, content: string): Promise<Sse> {
  const res = await request(app.getHttpServer())
    .post(`/api/conversations/${conversationId}/messages`)
    .set('x-dev-principal', `${who.type}:${who.id}`)
    .send({ content })
    .buffer(true)
    .parse((r, cb) => {
      let data = '';
      r.on('data', (c: Buffer) => (data += c.toString()));
      r.on('end', () => cb(null, data));
    })
    .expect(200)
    .expect('content-type', /text\/event-stream/);
  const events = String(res.body)
    .split('\n\n')
    .filter((b) => b.startsWith('event:'))
    .map((block) => {
      const [eventLine, dataLine] = block.split('\n');
      return { event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) };
    });
  return {
    events,
    of: (name) => events.filter((e) => e.event === name).map((e) => e.data),
    text: events.filter((e) => e.event === 'token').map((e) => e.data.text).join(''),
  };
}

async function newConversation(app: INestApplication, who: { type: 'employee' | 'customer'; id: string }): Promise<string> {
  return (await api(app, who).post('/api/conversations', {}).expect(201)).body.id;
}

const citedIds = (sse: Sse) => (sse.of('citations')[0] ?? []).map((c: { id: string }) => c.id);
/** Lookups the question chose (the knowledge search runs for every question). */
const lookups = (sse: Sse) => (sse.of('sources')[0] ?? []).filter((s: { tool: string }) => s.tool !== 'search_knowledge');

/** Model stand-in: plans whatever the test scripts, answers like the evidence-only provider. */
class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted';
  next: PlannedToolCall[] = [];
  lastPlan?: PlanInput;
  private readonly fallback = new EvidenceOnlyProvider();
  async plan(input: PlanInput) {
    this.lastPlan = input;
    const calls = this.next;
    this.next = [];
    return calls;
  }
  answer(input: AnswerInput) {
    return this.fallback.answer(input);
  }
}

describe('chat (evidence-only model)', () => {
  let app: INestApplication;
  let maria: { appointments: string[]; payments: string[] };
  let migrator: Client;

  beforeAll(async () => {
    app = await createApp();
    config({ path: path.resolve(__dirname, '../../../.env') });
    migrator = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
    await migrator.connect();
    maria = {
      appointments: (await migrator.query(`SELECT appointment_number FROM core.appointments WHERE customer_id = $1`, [C.maria])).rows.map((r) => r.appointment_number),
      payments: (await migrator.query(`SELECT payment_number FROM core.payments WHERE customer_id = $1`, [C.maria])).rows.map((r) => r.payment_number),
    };
  });
  afterAll(async () => {
    await migrator.end();
    await app.close();
  });

  it('customers get their next appointment, cited, with the time zone', async () => {
    const id = await newConversation(app, customer(C.maria));
    const sse = await chat(app, customer(C.maria), id, 'When is my next appointment?');
    const cited = citedIds(sse);
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.every((n: string) => maria.appointments.includes(n))).toBe(true);
    expect(sse.text).toContain('[1]');
    expect(sse.of('citations')[0][0].title).toMatch(/E[DS]T/);
    expect(sse.of('done')).toHaveLength(1);
  });

  it('customers only ever see their own data, even when asking about someone else', async () => {
    const id = await newConversation(app, customer(C.maria));
    const sse = await chat(app, customer(C.maria), id, "Show me John Smith's payments");
    expect(sse.of('customer')).toEqual([]); // no lookup step for customers
    expect(citedIds(sse).every((n: string) => maria.payments.includes(n))).toBe(true);
  });

  it('org admins see members’ appointments but only their own payments', async () => {
    const id = await newConversation(app, customer(C.john));
    const appts = await chat(app, customer(C.john), id, 'Show our appointments');
    const titles = JSON.stringify(appts.of('citations')[0]);
    expect(titles).toMatch(/Deep clean|Haircut/);
    const pays = await chat(app, customer(C.john), id, 'And the payments?');
    const johnPayments = (await migrator.query(`SELECT payment_number FROM core.payments WHERE customer_id = $1`, [C.john])).rows.map((r) => r.payment_number);
    expect(citedIds(pays).every((n: string) => johnPayments.includes(n))).toBe(true);
  });

  it('employees name a customer; the conversation keeps that customer for follow-ups', async () => {
    const id = await newConversation(app, employee(U.sam));
    const first = await chat(app, employee(U.sam), id, "Show me Maria Lopez's appointments");
    expect(first.of('customer')[0]).toMatchObject({ id: C.maria, name: 'Maria Lopez' });
    expect(citedIds(first).every((n: string) => maria.appointments.includes(n))).toBe(true);

    const follow = await chat(app, employee(U.sam), id, 'And her payments?');
    expect(citedIds(follow).length).toBeGreaterThan(0);
    expect(citedIds(follow).every((n: string) => maria.payments.includes(n))).toBe(true);
  });

  it('choosing from "which one?" answers the question instead of asking again', async () => {
    const lookalike = (await api(app, employee(U.ada)).post('/api/customers', { first_name: 'Maria', last_name: 'Lopes', email: 'maria.lopes.chat@example.com' }).expect(201)).body;
    try {
      const id = await newConversation(app, employee(U.ada));
      const first = await chat(app, employee(U.ada), id, "Show me Maria Lopez's appointments");
      expect(first.of('disambiguation')[0].candidates.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining([C.maria, lookalike.id]));
      await api(app, employee(U.ada)).put(`/api/conversations/${id}/scope`, { customer_id: C.maria }).expect(200);
      const again = await chat(app, employee(U.ada), id, "Show me Maria Lopez's appointments");
      expect(again.of('disambiguation')).toEqual([]);
      expect(citedIds(again).some((n: string) => maria.appointments.includes(n))).toBe(true);
    } finally {
      // Other tests count the Marias: leave the look-alike merged away (tombstones are hidden).
      await api(app, employee(U.ada)).post(`/api/customers/${lookalike.id}/merge`, { into: C.maria, reason: 'test cleanup' }).expect(200);
    }
  });

  it('sources link to the record in the app, for whoever asked', async () => {
    const link = (sse: Sse, type: string) => (sse.of('citations')[0] ?? []).find((c: { type: string }) => c.type === type)?.link;
    const staff = await chat(app, employee(U.sam), await newConversation(app, employee(U.sam)), "Show me Maria Lopez's appointments");
    expect(link(staff, 'appointment')).toBe(`/staff/customers/${C.maria}`);

    const conv = await newConversation(app, customer(C.maria));
    const own = await chat(app, customer(C.maria), conv, 'Show my appointments');
    expect(link(own, 'appointment')).toBe('/portal/appointments');
    const pay = await chat(app, customer(C.maria), conv, 'Show my payments');
    expect(link(pay, 'payment')).toBe('/portal/payments');
    const help = await chat(app, customer(C.maria), conv, 'How do I reschedule my appointment?');
    expect(link(help, 'answer')).toBeNull(); // no page for saved answers
    const article = await chat(app, customer(C.maria), conv, 'how late can I cancel');
    expect(link(article, 'article')).toBe('/portal/help/reschedule-or-cancel');

    // Kept with the message for reopened conversations.
    const saved = (await api(app, customer(C.maria)).get(`/api/conversations/${conv}/messages`).expect(200)).body;
    expect(saved[1].citations[0]).toMatchObject({ link: '/portal/appointments' });
  });

  it('employees cannot reach customers outside their access, even by exact email', async () => {
    const id = await newConversation(app, employee(U.sam));
    const sse = await chat(app, employee(U.sam), id, 'What does rita@example.com owe?');
    expect(sse.of('customer')).toEqual([]);
    expect(sse.text).toMatch(/couldn't find a customer/);
    expect(citedIds(sse)).toEqual([]);
  });

  it('asks which one when several customers match', async () => {
    await api(app, employee(U.ada)).post('/api/customers', { first_name: 'Maria', last_name: 'Lopes', email: 'maria.lopes@example.com' }).expect(201);
    const id = await newConversation(app, employee(U.ada));
    const sse = await chat(app, employee(U.ada), id, 'Maria Lopez appointments');
    const candidates = sse.of('disambiguation')[0].candidates;
    expect(candidates.map((c: { label: string }) => c.label).sort()).toEqual(['Maria Lopes', 'Maria Lopez']);
    expect(sse.text).toMatch(/Which one/);
  });

  it('employees get their own schedule and worklists', async () => {
    const id = await newConversation(app, employee(U.lia));
    const schedule = await chat(app, employee(U.lia), id, "What's on my schedule this week?");
    expect(lookups(schedule)).toEqual([expect.objectContaining({ tool: 'get_my_schedule' })]);
    const transfers = await chat(app, employee(U.sam), await newConversation(app, employee(U.sam)), 'Any overdue bank transfers?');
    expect(transfers.of('citations')[0][0].title).toMatch(/bank transfer — pending \(overdue\)/);
  });

  it('records an audit trace for every lookup', async () => {
    const id = await newConversation(app, customer(C.pat));
    const sse = await chat(app, customer(C.pat), id, 'How much is a haircut?');
    const messageId = sse.of('done')[0].messageId;
    const traces = (await migrator.query(`SELECT principal_id, tool, status FROM app.retrieval_traces WHERE message_id = $1`, [messageId])).rows;
    expect(traces).toEqual(
      expect.arrayContaining([
        { principal_id: C.pat, tool: 'list_services', status: 'ok' },
        { principal_id: C.pat, tool: 'search_knowledge', status: expect.any(String) },
      ]),
    );
    expect(traces).toHaveLength(2);
  });

  it('conversations are private to their owner', async () => {
    const id = await newConversation(app, customer(C.maria));
    await chat(app, customer(C.maria), id, 'hello');
    const msgs = await api(app, customer(C.maria)).get(`/api/conversations/${id}/messages`).expect(200);
    expect(msgs.body.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    await api(app, customer(C.jane)).get(`/api/conversations/${id}/messages`).expect(404);
    await request(app.getHttpServer())
      .post(`/api/conversations/${id}/messages`)
      .set('x-dev-principal', `customer:${C.jane}`)
      .send({ content: 'hi' })
      .expect(404);
    const list = await api(app, customer(C.maria)).get('/api/conversations').expect(200);
    expect(list.body.find((c: { id: string }) => c.id === id).title).toBe('hello');
  });

  it('limits questions per person per day, before streaming starts', async () => {
    await migrator.query('UPDATE core.settings SET chat_daily_limit_customer = 2');
    try {
      const id = await newConversation(app, customer(C.victor));
      await chat(app, customer(C.victor), id, 'hello');
      await chat(app, customer(C.victor), await newConversation(app, customer(C.victor)), 'hello again');
      const res = await request(app.getHttpServer())
        .post(`/api/conversations/${id}/messages`)
        .set('x-dev-principal', `customer:${C.victor}`)
        .send({ content: 'one more' })
        .expect(429);
      expect(res.body).toMatchObject({ code: 'chat_quota_exceeded', retry_after: expect.any(Number) });
      expect(res.body.message).toMatch(/limit of 2 questions/);
      // Others are not affected, and employees have their own limit.
      await chat(app, customer(C.pat), await newConversation(app, customer(C.pat)), 'hello');
      await chat(app, employee(U.sam), await newConversation(app, employee(U.sam)), 'hello');
    } finally {
      await migrator.query('UPDATE core.settings SET chat_daily_limit_customer = 50');
    }
  });

  it('employees can pin only customers they can access', async () => {
    const id = await newConversation(app, employee(U.sam));
    await api(app, employee(U.sam)).put(`/api/conversations/${id}/scope`, { customer_id: C.john }).expect(404);
    await api(app, employee(U.sam)).put(`/api/conversations/${id}/scope`, { customer_id: C.jane }).expect(200);
    await api(app, customer(C.maria)).put(`/api/conversations/${id}/scope`, { customer_id: C.maria }).expect(403);
  });

  it('reopened conversations get back the scope card the chat streamed', async () => {
    const id = await newConversation(app, employee(U.sam));
    await api(app, employee(U.sam)).get(`/api/conversations/${id}/scope`).expect(200, { scope: null });

    const sse = await chat(app, employee(U.sam), id, "Show me Maria Lopez's appointments");
    const streamed = sse.of('customer')[0];
    expect(streamed).toMatchObject({ id: C.maria });
    const card = (await api(app, employee(U.sam)).get(`/api/conversations/${id}/scope`).expect(200)).body.scope;
    expect(card).toEqual({ kind: 'customer', ...streamed });

    await api(app, employee(U.ada)).put(`/api/conversations/${id}/scope`, {}).expect(404); // not Ada's conversation
    const adaConv = await newConversation(app, employee(U.ada));
    await api(app, employee(U.ada)).put(`/api/conversations/${adaConv}/scope`, { organization_id: O.acme }).expect(200);
    expect((await api(app, employee(U.ada)).get(`/api/conversations/${adaConv}/scope`).expect(200)).body.scope).toEqual({
      kind: 'organization',
      id: O.acme,
      number: expect.any(String),
      name: 'Acme Corp',
      detail: 'billing@acme.example',
    });

    // Cleared, or pinned to a customer the employee can no longer see: no card.
    await api(app, employee(U.sam)).put(`/api/conversations/${id}/scope`, { customer_id: null }).expect(200);
    await api(app, employee(U.sam)).get(`/api/conversations/${id}/scope`).expect(200, { scope: null });
    await migrator.query('UPDATE app.conversations SET active_customer_id = $2 WHERE id = $1', [id, C.john]);
    await api(app, employee(U.sam)).get(`/api/conversations/${id}/scope`).expect(200, { scope: null });

    await api(app, employee(U.ada)).get(`/api/conversations/${id}/scope`).expect(404);
    await api(app, customer(C.maria)).get(`/api/conversations/${id}/scope`).expect(403);
  });
});

describe('chat (model tool calling)', () => {
  const model = new ScriptedProvider();
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp({ overrides: [{ token: LLM_PROVIDER, value: model }] });
  });
  afterAll(async () => {
    await app.close();
  });

  it('only offers the model tools this principal may use with this scope', async () => {
    const id = await newConversation(app, customer(C.maria));
    await chat(app, customer(C.maria), id, 'Tell me something useful');
    const offered = model.lastPlan!.tools.map((t) => t.function.name);
    expect(offered).toContain('list_appointments');
    expect(offered).not.toContain('get_my_schedule');
    expect(offered).not.toContain('search_customers');
  });

  it('rejects model attempts to choose whose data or to use tools it was not offered', async () => {
    const id = await newConversation(app, customer(C.maria));
    model.next = [
      { tool: 'list_payments', args: { customer_id: C.john } }, // invalid argument
      { tool: 'search_customers', args: { query: 'John' } }, // not offered to customers
      { tool: 'list_services', args: {} },
    ];
    const sse = await chat(app, customer(C.maria), id, 'Tell me about John');
    expect(lookups(sse)).toEqual([
      { tool: 'list_payments', status: 'error', records: 0 },
      { tool: 'list_services', status: 'ok', records: expect.any(Number) },
    ]);
    expect(sse.of('citations')[0].every((c: { type: string }) => c.type === 'service')).toBe(true);
  });
});
