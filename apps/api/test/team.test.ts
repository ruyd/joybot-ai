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
  // Shared database: no chat, test to-dos or changed settings left behind.
  await migrator.query('DELETE FROM app.team_messages');
  await migrator.query('DELETE FROM app.team_members');
  await migrator.query(`DELETE FROM app.team_channels WHERE kind <> 'everyone'`);
  await migrator.query(`DELETE FROM core.tasks WHERE title LIKE 'team test%'`);
  await migrator.query('UPDATE core.settings SET team_chat_retention = 100 WHERE id = 1');
  await migrator.query('UPDATE core.users SET chat_sound = true, chat_toast = true');
  await migrator.end();
  await app.close();
});

type Channel = { id: string; kind: string; name: string; unread: number; last_message: { body: string; link: string | null } | null };
const channels = async (who: string): Promise<Channel[]> => (await api(app, employee(who)).get('/api/team/channels').expect(200)).body;
const byKind = async (who: string, kind: string) => (await channels(who)).find((c) => c.kind === kind)!;

describe('team chat', () => {
  it('everyone channel: every employee reads it, unread counts follow, customers are kept out', async () => {
    const everyone = await byKind(U.sam, 'everyone');
    await byKind(U.lia, 'everyone'); // Lia starts reading now
    await api(app, employee(U.sam)).post(`/api/team/channels/${everyone.id}/messages`, { body: 'Morning all' }).expect(201);
    const forLia = await byKind(U.lia, 'everyone');
    expect(forLia.unread).toBe(1);
    expect(forLia.last_message?.body).toBe('Morning all');
    expect((await byKind(U.sam, 'everyone')).unread).toBe(0); // own messages are read

    const msgs = (await api(app, employee(U.lia)).get(`/api/team/channels/${everyone.id}/messages`).expect(200)).body;
    expect(msgs.at(-1)).toMatchObject({ body: 'Morning all', sender_id: U.sam, sender_name: 'Sam Staff' });
    await api(app, employee(U.lia)).post(`/api/team/channels/${everyone.id}/read`).expect(204);
    expect((await byKind(U.lia, 'everyone')).unread).toBe(0);

    await api(app, customer(C.maria)).get('/api/team/channels').expect(403);
  });

  it('direct messages are private to the two people', async () => {
    const first = (await api(app, employee(U.sam)).post('/api/team/direct', { user_id: U.lia }).expect(201)).body.id;
    const again = (await api(app, employee(U.lia)).post('/api/team/direct', { user_id: U.sam }).expect(201)).body.id;
    expect(again).toBe(first);
    await api(app, employee(U.lia)).post(`/api/team/channels/${first}/messages`, { body: 'Can you cover Friday?' }).expect(201);
    const dm = (await channels(U.sam)).find((c) => c.id === first)!;
    expect(dm).toMatchObject({ kind: 'direct', name: 'Lia Staff', unread: 1 });

    expect((await channels(U.ada)).map((c) => c.id)).not.toContain(first);
    await api(app, employee(U.ada)).get(`/api/team/channels/${first}/messages`).expect(404);
    await api(app, employee(U.ada)).post(`/api/team/channels/${first}/messages`, { body: 'hi' }).expect(403);
    await api(app, employee(U.sam)).post('/api/team/direct', { user_id: U.sam }).expect(400);
  });

  it('group channels: members only; leaving takes you out', async () => {
    const id = (await api(app, employee(U.sam)).post('/api/team/channels', { name: 'NYC front desk', member_ids: [U.ada] }).expect(201)).body.id;
    expect((await channels(U.ada)).find((c) => c.id === id)).toMatchObject({ kind: 'group', name: 'NYC front desk' });
    expect((await channels(U.lia)).map((c) => c.id)).not.toContain(id);
    await api(app, employee(U.lia)).post(`/api/team/channels/${id}/messages`, { body: 'hello?' }).expect(403);
    await api(app, employee(U.lia)).post(`/api/team/channels/${id}/members`, { member_ids: [U.lia] }).expect(403);

    await api(app, employee(U.ada)).post(`/api/team/channels/${id}/members`, { member_ids: [U.lia] }).expect(204);
    expect((await channels(U.lia)).map((c) => c.id)).toContain(id);
    await api(app, employee(U.lia)).post(`/api/team/channels/${id}/leave`).expect(204);
    expect((await channels(U.lia)).map((c) => c.id)).not.toContain(id);
    const everyone = await byKind(U.lia, 'everyone');
    await api(app, employee(U.lia)).post(`/api/team/channels/${everyone.id}/leave`).expect(404); // only groups can be left
  });

  it('notifications: the system posts there (a to-do assigned by someone else); nobody else can', async () => {
    // The sample data already notified Sam of his appointments: start from read.
    await api(app, employee(U.sam)).post(`/api/team/channels/${(await byKind(U.sam, 'notifications')).id}/read`).expect(204);
    await api(app, employee(U.ada)).post('/api/tasks', { title: 'team test: call Maria', assigned_to: U.sam }).expect(201);
    await api(app, employee(U.sam)).post('/api/tasks', { title: 'team test: my own', assigned_to: U.sam }).expect(201); // no notice for yourself
    const notes = await byKind(U.sam, 'notifications');
    expect(notes.unread).toBe(1);
    expect(notes.last_message).toMatchObject({ body: 'Ada Admin assigned you a to-do: team test: call Maria', link: '/staff/todos' });
    await api(app, employee(U.sam)).post(`/api/team/channels/${notes.id}/messages`, { body: 'reply' }).expect(403);
    expect((await channels(U.lia)).map((c) => c.id)).not.toContain(notes.id);
  });

  it('keeps only the newest messages per channel (general setting)', async () => {
    await api(app, employee(U.ada)).put('/api/admin/settings', { team_chat_retention: 10 }).expect(200);
    const id = (await api(app, employee(U.ada)).post('/api/team/direct', { user_id: U.sam }).expect(201)).body.id;
    for (let i = 1; i <= 12; i++) await api(app, employee(U.ada)).post(`/api/team/channels/${id}/messages`, { body: `note ${i}` }).expect(201);
    const msgs = (await api(app, employee(U.sam)).get(`/api/team/channels/${id}/messages?limit=200`).expect(200)).body;
    expect(msgs.map((m: { body: string }) => m.body)).toEqual(Array.from({ length: 10 }, (_, i) => `note ${i + 3}`));
    await api(app, employee(U.ada)).put('/api/admin/settings', { team_chat_retention: 5 }).expect(400); // at least 10
  });

  it('chat sound and toast are personal preferences', async () => {
    const me = (await api(app, employee(U.lia)).put('/api/me/employee', { chat_sound: false }).expect(200)).body;
    expect(me.profile).toMatchObject({ chat_sound: false, chat_toast: true });
  });
});
