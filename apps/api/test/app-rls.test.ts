import path from 'node:path';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { customers: C, users: U } = SAMPLE;

/**
 * Database-level isolation of the app tables (migration 0017): what the API (joybot_app) and chat
 * (joybot_reader) roles can see for each principal, independent of the API code.
 */
describe('app tables: row-level security', () => {
  let migrator: Client;
  let app: Client;
  let reader: Client;

  /** Runs `sql` as the API role with `who` as principal (or no principal) and returns the rows. */
  async function asApp(who: [string, string] | null, sql: string, params: unknown[] = []) {
    await app.query('BEGIN');
    try {
      if (who) await app.query(`SELECT set_config('app.principal_type', $1, true), set_config('app.principal_id', $2, true)`, who);
      return (await app.query(sql, params)).rows;
    } finally {
      await app.query('ROLLBACK');
    }
  }
  const count = async (who: [string, string] | null, table: string) =>
    (await asApp(who, `SELECT count(*)::int AS n FROM app.${table}`))[0].n as number;

  beforeAll(async () => {
    config({ path: path.resolve(__dirname, '../../../.env') });
    migrator = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
    app = new Client({ connectionString: process.env.APP_DATABASE_URL });
    reader = new Client({ connectionString: process.env.READER_DATABASE_URL });
    await Promise.all([migrator.connect(), app.connect(), reader.connect()]);
    await migrator.query(
      `INSERT INTO app.invites (token_hash, customer_id, channel, sent_to_hash, expires_at, created_by_type, created_by)
       VALUES ('h-rita', $1, 'email', 'x', now() + interval '1 day', 'employee', $3),
              ('h-maria', $2, 'email', 'x', now() + interval '1 day', 'employee', $3)`,
      [C.rita, C.maria, U.ada],
    );
    await migrator.query(`INSERT INTO app.stripe_events (event_id, type, livemode, created, payload) VALUES ('evt_rls', 'charge.succeeded', false, now(), '{}')`);
    await migrator.query(`INSERT INTO app.worker_jobs (kind, params, requested_by) VALUES ('stripe_reconcile', '{}', $1)`, [U.ada]);
    await migrator.query(
      `INSERT INTO app.retrieval_traces (principal_type, principal_id, tool, status) VALUES ('customer', $1, 'list_payments', 'ok'), ('customer', $2, 'list_payments', 'ok')`,
      [C.maria, C.john],
    );
    await migrator.query(`INSERT INTO app.message_deliveries (channel, template, to_hash, status) VALUES ('email', 'invite', 'x', 'sent')`);
  });
  afterAll(async () => {
    await Promise.all([migrator.end(), app.end(), reader.end()]);
  });

  const maria: [string, string] = ['customer', C.maria];
  const sam: [string, string] = ['employee', U.sam];
  const ada: [string, string] = ['employee', U.ada];

  it('invites: only for customers in scope', async () => {
    // A customer sees invites addressed to them (hashes only), never anyone else's.
    expect((await asApp(maria, 'SELECT customer_id FROM app.invites')).map((r) => r.customer_id)).toEqual([C.maria]);
    expect(await count(sam, 'invites')).toBe(1); // Maria's, not restricted Rita's
    expect(await count(ada, 'invites')).toBe(2);
    await expect(
      asApp(sam, `INSERT INTO app.invites (token_hash, customer_id, channel, sent_to_hash, expires_at, created_by_type, created_by)
                  VALUES ('h2', $1, 'email', 'x', now() + interval '1 day', 'employee', $2)`, [C.rita, U.sam]),
    ).rejects.toThrow(/row-level security/);
  });

  it('invites are accepted once, through the function only', async () => {
    expect((await asApp(maria, `SELECT authz.accept_invite('h-maria') AS id`))[0].id).toBe(C.maria);
    await expect(asApp(maria, `UPDATE app.invites SET accepted_at = now() WHERE token_hash = 'h-rita'`)).resolves.toEqual([]);
    expect((await migrator.query(`SELECT accepted_at FROM app.invites WHERE token_hash = 'h-rita'`)).rows[0].accepted_at).toBeNull();
    await expect(asApp(sam, `SELECT authz.accept_invite('h-rita')`)).rejects.toThrow(/only customers/);
  });

  it('Stripe events: the webhook appends, only admins read', async () => {
    expect(await count(null, 'stripe_events')).toBe(0);
    expect(await count(sam, 'stripe_events')).toBe(0);
    expect(await count(ada, 'stripe_events')).toBe(1);
    expect((await asApp(null, `SELECT authz.store_stripe_event('evt_new', 'x', false, 1700000000, '{}') AS ok`))[0].ok).toBe(true);
    expect((await asApp(null, `SELECT authz.store_stripe_event('evt_rls', 'x', false, 1700000000, '{}') AS ok`))[0].ok).toBe(false);
    await expect(
      asApp(maria, `INSERT INTO app.stripe_events (event_id, type, livemode, created, payload) VALUES ('evt_forged', 'x', false, now(), '{}')`),
    ).rejects.toThrow(/permission denied/);
    await expect(asApp(ada, `UPDATE app.stripe_events SET status = 'processed'`)).rejects.toThrow(/permission denied/);
  });

  it('worker jobs and retrieval traces', async () => {
    expect(await count(sam, 'worker_jobs')).toBe(0);
    expect(await count(ada, 'worker_jobs')).toBe(1);
    expect(await count(maria, 'retrieval_traces')).toBe(1); // her own only
    expect(await count(sam, 'retrieval_traces')).toBe(0);
    expect(await count(ada, 'retrieval_traces')).toBe(2); // audit
    await expect(
      asApp(maria, `INSERT INTO app.retrieval_traces (principal_type, principal_id, tool, status) VALUES ('customer', $1, 'x', 'ok')`, [C.john]),
    ).rejects.toThrow(/row-level security/);
  });

  it('message deliveries are write-only; the response cache is closed', async () => {
    await expect(count(ada, 'message_deliveries')).rejects.toThrow(/permission denied/);
    await expect(asApp(null, `INSERT INTO app.message_deliveries (channel, template, to_hash, status) VALUES ('email', 'x', 'y', 'sent')`)).resolves.toEqual([]);
    await expect(count(ada, 'response_cache')).rejects.toThrow(/permission denied/);
  });

  it('the chat reader cannot read any of them', async () => {
    for (const t of ['invites', 'stripe_events', 'worker_jobs', 'retrieval_traces', 'response_cache', 'message_deliveries']) {
      await expect(reader.query(`SELECT 1 FROM app.${t} LIMIT 1`)).rejects.toThrow(/permission denied/);
    }
  });
});
