import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createApp, customer, employee } from './app';

const { customers: C, users: U } = SAMPLE;

let app: INestApplication;

beforeAll(async () => {
  app = await createApp();
});
afterAll(async () => {
  await app.close();
});

type Task = { id: string; title: string; assigned_to: string; completed_at: string | null; due_on: string | null };
const titles = (rows: Task[]) => rows.map((t) => t.title);

async function create(who: ReturnType<typeof employee>, body: Record<string, unknown>) {
  return (await api(app, who).post('/api/tasks', body).expect(201)).body as Task & Record<string, unknown>;
}

describe('to-dos: who sees and changes what', () => {
  it('staff see tasks assigned to or created by them; admins see all', async () => {
    const own = await create(employee(U.sam), { title: 'Sam: call supplier', due_on: '2026-10-20' });
    expect(own).toMatchObject({ assigned_to: U.sam, created_by: U.sam, assigned_to_name: 'Sam Staff', completed_at: null, due_on: '2026-10-20' });
    const handed = await create(employee(U.sam), { title: 'Lia: check LA stock', assigned_to: U.lia });

    const sam = titles((await api(app, employee(U.sam)).get('/api/tasks').expect(200)).body);
    expect(sam).toEqual(expect.arrayContaining(['Sam: call supplier', 'Lia: check LA stock']));
    const lia = titles((await api(app, employee(U.lia)).get('/api/tasks').expect(200)).body);
    expect(lia).toContain('Lia: check LA stock');
    expect(lia).not.toContain('Sam: call supplier');
    const ada = titles((await api(app, employee(U.ada)).get('/api/tasks').expect(200)).body);
    expect(ada).toEqual(expect.arrayContaining(['Sam: call supplier', 'Lia: check LA stock']));

    // mine=true: assigned to me only.
    expect(titles((await api(app, employee(U.sam)).get('/api/tasks?mine=true').expect(200)).body)).not.toContain('Lia: check LA stock');

    // Invisible tasks cannot be changed or deleted.
    await api(app, employee(U.lia)).put(`/api/tasks/${own.id}`, { done: true }).expect(404);
    await api(app, employee(U.lia)).delete(`/api/tasks/${own.id}`).expect(404);

    // The assignee completes; an assignee who did not create it cannot hand it to someone else.
    const done = await api(app, employee(U.lia)).put(`/api/tasks/${handed.id}`, { done: true }).expect(200);
    expect(done.body).toMatchObject({ completed_by: U.lia, completed_at: expect.any(String) });
    await api(app, employee(U.lia)).put(`/api/tasks/${handed.id}`, { assigned_to: U.ada }).expect(403);
    expect(titles((await api(app, employee(U.lia)).get('/api/tasks?status=done').expect(200)).body)).toContain('Lia: check LA stock');
    expect(titles((await api(app, employee(U.lia)).get('/api/tasks').expect(200)).body)).not.toContain('Lia: check LA stock');

    const reopened = await api(app, employee(U.sam)).put(`/api/tasks/${handed.id}`, { done: false }).expect(200);
    expect(reopened.body).toMatchObject({ completed_at: null, completed_by: null });
    await api(app, employee(U.sam)).delete(`/api/tasks/${handed.id}`).expect(204);
  });

  it('links only customers the employee can read, and only active employees as assignees', async () => {
    await api(app, employee(U.sam)).post('/api/tasks', { title: 'x', customer_id: C.john }).expect(404);
    await api(app, employee(U.sam)).post('/api/tasks', { title: 'x', assigned_to: C.maria }).expect(400);
    await api(app, employee(U.sam)).post('/api/tasks', { title: '   ' }).expect(400);
    await api(app, employee(U.sam)).post('/api/tasks', { title: 'x', completed_at: '2026-01-01' }).expect(400);
    const linked = await create(employee(U.sam), { title: 'Follow up with Maria', customer_id: C.maria });
    expect(linked).toMatchObject({ customer_id: C.maria, customer_name: 'Maria Lopez', customer_number: expect.any(String) });
    await api(app, employee(U.sam)).put(`/api/tasks/${linked.id}`, { customer_id: C.john }).expect(404);
  });

  it('open tasks come soonest-due first, undated last', async () => {
    await create(employee(U.lia), { title: 'later', due_on: '2026-12-01' });
    await create(employee(U.lia), { title: 'undated' });
    await create(employee(U.lia), { title: 'sooner', due_on: '2026-10-15' });
    const mine = titles((await api(app, employee(U.lia)).get('/api/tasks?mine=true').expect(200)).body);
    expect(mine.filter((t) => ['later', 'undated', 'sooner'].includes(t))).toEqual(['sooner', 'later', 'undated']);
  });

  it('customers have no access', async () => {
    await api(app, customer(C.maria)).get('/api/tasks').expect(403);
    await api(app, customer(C.maria)).post('/api/tasks', { title: 'x' }).expect(403);
  });

  it('tasks follow a customer merge to the surviving record', async () => {
    const dupe = (
      await api(app, employee(U.ada)).post('/api/customers', { first_name: 'Maria', last_name: 'Lopez', email: 'maria.dupe@example.com' }).expect(201)
    ).body;
    const task = await create(employee(U.ada), { title: 'Call the duplicate', customer_id: dupe.id });
    await api(app, employee(U.ada)).post(`/api/customers/${dupe.id}/merge`, { into: C.maria, reason: 'same person' }).expect(200);
    const after = (await api(app, employee(U.ada)).get('/api/tasks').expect(200)).body.find((t: Task) => t.id === task.id);
    expect(after).toMatchObject({ customer_id: C.maria, customer_name: 'Maria Lopez' });
  });
});
