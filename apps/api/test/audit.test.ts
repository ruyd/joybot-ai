import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createApp, customer, employee } from './app';

const { customers: C, users: U } = SAMPLE;

let app: INestApplication;
let migrator: Client;

beforeAll(async () => {
  app = await createApp();
  config({ path: path.resolve(__dirname, '../../../.env') });
  migrator = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await migrator.connect();
});
afterAll(async () => {
  await migrator.query(`DELETE FROM core.tasks WHERE title LIKE 'audit test%'`);
  await migrator.query('DELETE FROM app.api_tokens');
  await migrator.end();
  await app.close();
});

type Entry = { id: string; table_name: string; row_id: string; action: string; changed_via: string; changed_by: string; changed_by_name: string; label: string | null; diff: Record<string, unknown> };
type Page = { items: Entry[]; total: number };
const audit = async (query: string) => (await api(app, employee(U.ada)).get(`/api/admin/audit?${query}`).expect(200)).body as Page;

describe('audit log', () => {
  it('records every change with who, where from and which record, and filters by person and record', async () => {
    const todo = (await api(app, employee(U.sam)).post('/api/tasks', { title: 'audit test: first name' }).expect(201)).body as { id: string };
    await api(app, employee(U.sam)).put(`/api/tasks/${todo.id}`, { title: 'audit test: renamed' }).expect(200);

    const history = await audit(`row_id=${todo.id}`);
    expect(history.total).toBe(2);
    expect(history.items.map((e) => e.action)).toEqual(['UPDATE', 'INSERT']); // newest first
    // Labelled with the record's current title; the update's diff has old and new.
    expect(history.items[0]).toMatchObject({ table_name: 'tasks', changed_via: 'api', changed_by: U.sam, changed_by_name: 'Sam Staff', label: 'audit test: renamed' });
    expect(history.items[0].diff.title).toEqual({ old: 'audit test: first name', new: 'audit test: renamed' });

    const bySam = await audit(`changed_by=${U.sam}&table=tasks`);
    expect(bySam.items.every((e) => e.changed_by === U.sam)).toBe(true);
    expect(bySam.items.map((e) => e.row_id)).toContain(todo.id);
  });

  it('pages through everything with the same total, past the end too', async () => {
    const all = await audit('limit=5');
    expect(all.items).toHaveLength(5);
    expect(all.total).toBeGreaterThan(5); // the seed alone writes many entries
    const second = await audit('limit=5&offset=5');
    expect(second.total).toBe(all.total);
    expect(second.items.map((e) => e.id)).not.toContain(all.items[0].id);
    expect(await audit(`offset=${all.total}`)).toEqual({ items: [], total: all.total });
  });

  it('never shows token hashes, and using a token is not a change; revoking it is', async () => {
    const token = (await api(app, employee(U.ada)).post('/api/admin/api-tokens', { name: 'audit test token' }).expect(201)).body as { id: string; token: string };
    const [created] = (await audit(`table=api_tokens&row_id=${token.id}`)).items;
    expect(created).toMatchObject({ action: 'INSERT', label: 'audit test token' });
    expect(created.diff).not.toHaveProperty('token_hash');
    expect(created.diff).toHaveProperty('prefix');

    await migrator.query(`SELECT * FROM authz.resolve_api_token(encode(sha256(convert_to($1, 'UTF8')), 'hex'))`, [token.token]);
    expect((await migrator.query('SELECT last_used_at FROM app.api_tokens WHERE id = $1', [token.id])).rows[0].last_used_at).not.toBeNull();
    expect((await audit(`table=api_tokens&row_id=${token.id}`)).total).toBe(1);

    await api(app, employee(U.ada)).post(`/api/admin/api-tokens/${token.id}/revoke`).expect(204);
    const [revoked] = (await audit(`table=api_tokens&row_id=${token.id}`)).items;
    expect(revoked).toMatchObject({ action: 'UPDATE', changed_by_name: 'Ada Admin' });
    expect(Object.keys(revoked.diff).sort()).toEqual(['revoked_at', 'revoked_by']);
  });

  it('is for admins only', async () => {
    await api(app, employee(U.sam)).get('/api/admin/audit').expect(403);
    await api(app, customer(C.maria)).get('/api/admin/audit').expect(403);
    await api(app, employee(U.ada)).get('/api/admin/audit?changed_by=nope').expect(400);
  });
});
