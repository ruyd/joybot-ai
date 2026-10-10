import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createApp, customer, employee } from './app';

const { customers: C, users: U, services: S, locations: L, articles: A, answers: ANS } = SAMPLE;

let app: INestApplication;

beforeAll(async () => {
  app = await createApp();
});
afterAll(async () => {
  await app.close();
});

const slugs = (rows: { slug: string }[]) => rows.map((r) => r.slug).sort();

/** Next day at a given UTC hour, as ISO. */
const inDays = (d: number, hour = 15) => {
  const t = new Date(Date.now() + d * 86_400_000);
  t.setUTCHours(hour, 0, 0, 0);
  return t.toISOString();
};

async function chat(who: { type: 'employee' | 'customer'; id: string }, content: string) {
  const conv = (await api(app, who).post('/api/conversations', {}).expect(201)).body.id;
  const res = await request(app.getHttpServer())
    .post(`/api/conversations/${conv}/messages`)
    .set('x-dev-principal', `${who.type}:${who.id}`)
    .set('accept', 'text/event-stream')
    .send({ content })
    .expect(200);
  const events = res.text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
  return { conv, of: (name: string) => events.filter((e) => e.event === name).map((e) => e.data) };
}

describe('help articles', () => {
  it('everyone reads published articles meant for them; editors also see drafts', async () => {
    const draft = (
      await api(app, employee(U.ada)).post('/api/articles', { slug: 'draft-notes', title: 'Draft', body: 'Not yet.', audience: 'all' }).expect(201)
    ).body;
    expect(draft.published).toBe(false);

    expect(slugs((await api(app, customer(C.maria)).get('/api/articles').expect(200)).body)).toEqual(['payment-options', 'reschedule-or-cancel']);
    expect(slugs((await api(app, employee(U.sam)).get('/api/articles').expect(200)).body)).toEqual(['handling-booking-requests', 'reschedule-or-cancel']);
    expect(slugs((await api(app, employee(U.ada)).get('/api/articles').expect(200)).body)).toContain('draft-notes');

    await api(app, customer(C.maria)).get('/api/articles/handling-booking-requests').expect(404);
    await api(app, employee(U.sam)).get('/api/articles/draft-notes').expect(404);
    const read = await api(app, customer(C.maria)).get('/api/articles/payment-options').expect(200);
    expect(read.body.body).toMatch(/## Bank transfer/);
    await api(app, employee(U.ada)).delete(`/api/articles/${draft.id}`).expect(204);
  });

  it('admins write articles; their sections become searchable; staff cannot edit', async () => {
    const body = '## Parking\nThere is free parking behind the Midtown salon.\n\n## Accessibility\nStep-free entrance on 5th Avenue.';
    const created = (
      await api(app, employee(U.ada)).post('/api/articles', { slug: 'getting-here', title: 'Getting here', body, audience: 'all', published: true }).expect(201)
    ).body;
    expect(slugs((await api(app, customer(C.pat)).get('/api/articles?q=free parking').expect(200)).body)).toEqual(['getting-here']);
    const match = (await api(app, employee(U.ada)).get('/api/knowledge/match?as=customer&q=is there free parking').expect(200)).body;
    expect(match.passages[0]).toMatchObject({ slug: 'getting-here', heading: 'Parking' });
    expect(match.actions).toEqual([{ type: 'article', label: 'Read: Getting here', slug: 'getting-here' }]);

    await api(app, employee(U.sam)).post('/api/articles', { slug: 'x', title: 'x' }).expect(403);
    await api(app, employee(U.sam)).put(`/api/articles/${created.id}`, { slug: 'getting-here', title: 'Hacked' }).expect(403);
    await api(app, customer(C.maria)).delete(`/api/articles/${created.id}`).expect(403);
    await api(app, employee(U.ada)).post('/api/articles', { slug: 'Bad Slug', title: 'x' }).expect(400);
    await api(app, employee(U.ada)).post('/api/articles', { slug: 'getting-here', title: 'dupe' }).expect(409);
  });
});

describe('saved answers', () => {
  it('admins manage answers; actions must point at real services and articles', async () => {
    await api(app, employee(U.sam)).get('/api/answers').expect(403);
    const list = (await api(app, employee(U.ada)).get('/api/answers').expect(200)).body;
    expect(list.total).toBe(3);
    expect(list.items.map((a: { id: string }) => a.id).sort()).toEqual(Object.values(ANS).sort());

    const bad = { title: 'x', body: 'y', actions: [{ type: 'book', service_id: C.maria }] };
    await api(app, employee(U.ada)).post('/api/answers', bad).expect(400);
    await api(app, employee(U.ada)).post('/api/answers', { ...bad, actions: [{ type: 'article', article_id: S.haircut }] }).expect(400);

    const created = (
      await api(app, employee(U.ada))
        .post('/api/answers', {
          title: 'Deep clean',
          questions: ['How long does a deep clean take?'],
          body: 'About two hours.',
          actions: [{ type: 'book', service_id: S.deepClean }],
        })
        .expect(201)
    ).body;
    const match = (await api(app, employee(U.ada)).get('/api/knowledge/match?as=customer&q=how long does a deep clean take').expect(200)).body;
    expect(match.answers[0].id).toBe(created.id);
    expect(match.actions).toEqual([{ type: 'book', label: 'Book deep clean', service_id: S.deepClean }]);

    // Inactive answers and services drop out.
    await api(app, employee(U.ada)).put(`/api/answers/${created.id}`, { ...created }).expect(400); // id, timestamps: not editable
    await api(app, employee(U.ada))
      .put(`/api/answers/${created.id}`, { title: 'Deep clean', questions: ['How long does a deep clean take?'], body: 'About two hours.', active: false })
      .expect(200);
    expect((await api(app, employee(U.ada)).get('/api/knowledge/match?as=customer&q=how long does a deep clean take').expect(200)).body.answers).toEqual([]);
    await api(app, employee(U.ada)).delete(`/api/answers/${created.id}`).expect(204);
  });

  it('the editor list searches, filters, sorts and pages', async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 12; i++) {
      const body = { title: `Policy ${String(i).padStart(2, '0')}`, questions: [`policy question ${i}`], body: i % 2 ? 'Odd text' : 'Even text', audience: i % 3 ? 'all' : 'employee', active: i !== 5 };
      ids.push((await api(app, employee(U.ada)).post('/api/answers', body).expect(201)).body.id);
    }
    const page = async (qs: string) => (await api(app, employee(U.ada)).get(`/api/answers?${qs}`).expect(200)).body;
    const titles = (r: { items: { title: string }[] }) => r.items.map((a) => a.title);

    const first = await page('q=policy&limit=5');
    expect(first.total).toBe(12);
    expect(titles(first)).toEqual(['Policy 01', 'Policy 02', 'Policy 03', 'Policy 04', 'Policy 05']);
    expect(titles(await page('q=policy&limit=5&offset=10'))).toEqual(['Policy 11', 'Policy 12']);
    expect(await page('q=policy&limit=5&offset=50')).toEqual({ items: [], total: 12 });

    expect((await page('q=even text')).total).toBe(6); // answer text
    expect((await page('q=POLICY QUESTION 7')).items.map((a: { id: string }) => a.id)).toEqual([ids[6]]); // example questions
    expect((await page('q=policy&audience=employee')).total).toBe(4);
    expect(titles(await page('q=policy&active=false'))).toEqual(['Policy 05']);
    expect(titles(await page('sort=updated&limit=1'))).toEqual(['Policy 12']);
    expect((await page('q=%')).total).toBe(0); // wildcards are literal
    await api(app, employee(U.ada)).get('/api/answers?limit=500').expect(400);
    for (const id of ids) await api(app, employee(U.ada)).delete(`/api/answers/${id}`).expect(204);
  });

  it('chat cites the saved answer and offers its buttons, kept with the message', async () => {
    const { conv, of } = await chat(customer(C.maria), 'How do I reschedule my appointment?');
    expect(of('citations')[0]).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'answer', id: ANS.reschedule })]));
    const actions = of('actions')[0];
    expect(actions).toEqual([
      { type: 'book', label: 'Book an appointment', service_id: null },
      { type: 'article', label: 'Read: Rescheduling or cancelling an appointment', slug: 'reschedule-or-cancel' },
    ]);
    const messages = (await api(app, customer(C.maria)).get(`/api/conversations/${conv}/messages`).expect(200)).body;
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', actions });
  });

  it('only what is meant for the asker: staff get no button for a customer-only article', async () => {
    const staff = await chat(employee(U.sam), 'What payment methods do you accept?');
    expect(staff.of('citations')[0].map((c: { id: string }) => c.id)).toContain(ANS.waysToPay);
    expect(staff.of('actions')).toEqual([]);
    const cust = await chat(customer(C.pat), 'How do I confirm a booking request?');
    expect((cust.of('citations')[0] ?? []).map((c: { id: string }) => c.id)).not.toContain('handling-booking-requests');
    expect(A.bookingRequests).toBeTruthy();
  });
});

describe('self-booking', () => {
  const book = (who = C.maria, body: Record<string, unknown> = {}) =>
    api(app, customer(who)).post('/api/appointments/requests', { service_id: S.haircut, location_id: L.nyc, scheduled_start: inDays(3), ...body });

  it('customers request appointments within limits; staff confirm or decline on the Review page', async () => {
    const req = (await book().expect(201)).body;
    expect(req).toMatchObject({ status: 'scheduled', requested_by_customer: true, reviewed_at: null, price_quoted: '50.00', employee_id: null });
    expect(req).not.toHaveProperty('notes_internal');

    await book(C.maria, { scheduled_start: new Date(Date.now() + 30 * 60_000).toISOString() }).expect(400);
    await book(C.maria, { scheduled_start: inDays(400) }).expect(400);
    const overlap = await book().expect(400);
    expect(overlap.body.message).toMatch(/already have an appointment at that time/);
    await book(C.maria, { scheduled_start: inDays(4) }).expect(201);
    await book(C.maria, { scheduled_start: inDays(5) }).expect(201);
    const limit = await book(C.maria, { scheduled_start: inDays(6) }).expect(400);
    expect(limit.body.message).toMatch(/three requests/);

    // Staff in scope see the queue; customers and out-of-scope staff do not.
    await api(app, customer(C.maria)).get('/api/appointments/requests').expect(403);
    await api(app, employee(U.sam)).post('/api/appointments/requests', { service_id: S.haircut, location_id: L.nyc, scheduled_start: inDays(3) }).expect(403);
    const queue = (await api(app, employee(U.sam)).get('/api/appointments/requests').expect(200)).body;
    expect(queue.map((a: { id: string }) => a.id)).toContain(req.id);
    expect(queue[0]).toMatchObject({ customer_name: 'Maria Lopez' });
    expect((await api(app, employee(U.lia)).get('/api/appointments/requests').expect(200)).body.map((a: { id: string }) => a.id)).not.toContain(req.id);

    // Confirm with a staff member who works there; reviewing twice is a conflict.
    await api(app, employee(U.sam)).post(`/api/appointments/${req.id}/review`, { decision: 'confirm', employee_id: U.lia }).expect(400);
    const confirmed = (await api(app, employee(U.sam)).post(`/api/appointments/${req.id}/review`, { decision: 'confirm', employee_id: U.sam }).expect(200)).body;
    expect(confirmed).toMatchObject({ status: 'confirmed', employee_id: U.sam, reviewed_at: expect.any(String) });
    await api(app, employee(U.sam)).post(`/api/appointments/${req.id}/review`, { decision: 'decline' }).expect(409);
    await api(app, customer(C.maria)).post(`/api/appointments/${req.id}/withdraw`).expect(404);

    // Decline another; withdraw the third.
    const [second, third] = (await api(app, employee(U.sam)).get('/api/appointments/requests').expect(200)).body;
    expect((await api(app, employee(U.sam)).post(`/api/appointments/${second.id}/review`, { decision: 'decline' }).expect(200)).body.status).toBe('cancelled');
    expect((await api(app, customer(C.maria)).post(`/api/appointments/${third.id}/withdraw`).expect(200)).body.status).toBe('cancelled');
    await api(app, customer(C.jane)).post(`/api/appointments/${third.id}/withdraw`).expect(404);
    expect((await api(app, employee(U.sam)).get('/api/appointments/requests').expect(200)).body).toEqual([]);
  });
});
