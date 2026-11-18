import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, statementsOf } from '../src/migrate';
import { withPrincipal } from '../src/scope';
import { SAMPLE } from '../src/seed';
import { onServer, recreateDatabase, withDatabase } from '../src/testing';
import { DATABASE } from './database';

const migratorUrl = process.env.MIGRATOR_DATABASE_URL!;
// A scratch database of its own, so these files never touch the suite's migrated one.
const scratch = `${DATABASE}_migrate`;
const scratchUrl = withDatabase(migratorUrl, scratch);
let dir: string;
const quiet = () => undefined;

beforeAll(async () => {
  await recreateDatabase(migratorUrl, scratch);
  dir = await mkdtemp(path.join(os.tmpdir(), 'joybot-migrate-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await onServer(migratorUrl, `DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
});

describe('migrate', () => {
  it('splits a no-transaction file into its statements', () => {
    expect(statementsOf('-- migrate: no-transaction\n-- why\nCREATE INDEX CONCURRENTLY a ON t (x);\n\nCREATE INDEX b ON t (y); -- note\n')).toEqual([
      'CREATE INDEX CONCURRENTLY a ON t (x)',
      'CREATE INDEX b ON t (y)',
    ]);
  });

  it('runs no-transaction files one statement at a time, so CREATE INDEX CONCURRENTLY works', async () => {
    await writeFile(path.join(dir, '0001_table.sql'), 'CREATE TABLE t (x int, y int);');
    await writeFile(
      path.join(dir, '0002_index.sql'),
      '-- migrate: no-transaction\n-- built without blocking writes\nCREATE INDEX CONCURRENTLY IF NOT EXISTS t_x ON t (x);\nCREATE INDEX CONCURRENTLY IF NOT EXISTS t_y ON t (y);\n',
    );
    expect(await migrate(scratchUrl, quiet, dir)).toEqual(['0001_table.sql', '0002_index.sql']);
    const db = new Client({ connectionString: scratchUrl });
    await db.connect();
    try {
      const idx = (await db.query(`SELECT indexname FROM pg_indexes WHERE tablename = 't' ORDER BY 1`)).rows.map((r) => r.indexname);
      expect(idx).toEqual(['t_x', 't_y']);
      // The session's lock_timeout doesn't linger after the file.
      expect(await migrate(scratchUrl, quiet, dir)).toEqual([]);
    } finally {
      await db.end();
    }
  });

  it('gives up waiting for a busy table after the lock timeout, retries, and succeeds once it is free', async () => {
    await writeFile(path.join(dir, '0003_column.sql'), 'ALTER TABLE t ADD COLUMN z int;');
    const holder = new Client({ connectionString: scratchUrl });
    await holder.connect();
    const logs: string[] = [];
    try {
      // A long transaction holds the table, as a slow query would.
      await holder.query('BEGIN; LOCK TABLE t IN ACCESS SHARE MODE');
      const started = Date.now();
      await expect(migrate(scratchUrl, (m) => logs.push(m), dir, { lockTimeoutMs: 100, attempts: 2 })).rejects.toThrow(/0003_column\.sql failed: .*lock timeout/);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(logs.some((l) => l.includes('trying again (1/1)'))).toBe(true);
      await holder.query('ROLLBACK');
      expect(await migrate(scratchUrl, quiet, dir, { lockTimeoutMs: 100 })).toEqual(['0003_column.sql']);
    } finally {
      await holder.end();
    }
  });
});

describe('function grants and read-only transactions (0061)', () => {
  const pool = (url: string) => new Pool({ connectionString: url, max: 1 });

  it('the chat role cannot run functions that write; read-only transactions refuse writes', async () => {
    const reader = pool(process.env.READER_DATABASE_URL!);
    const app = pool(process.env.APP_DATABASE_URL!);
    try {
      const run = (p: Pool, sql: string, opts: { readOnly?: boolean } = {}) =>
        withPrincipal(p, { type: 'customer', id: SAMPLE.customers.john }, (db) => db.query(sql), 'test', opts);
      await expect(run(reader, `SELECT authz.remove_org_member('${SAMPLE.customers.jane}')`)).rejects.toMatchObject({ code: '42501' });
      await expect(run(reader, `SELECT core.order_refresh(gen_random_uuid())`)).rejects.toMatchObject({ code: '42501' });
      await expect(run(reader, `SELECT authz.customer_access_reason('customer', gen_random_uuid(), gen_random_uuid(), 'customers', 'read')`)).rejects.toMatchObject({
        code: '42501',
      });
      // The API's role still can (the function checks the org admin itself), but not inside a read-only transaction.
      await expect(run(app, `SELECT authz.remove_org_member('${SAMPLE.customers.jane}')`, { readOnly: true })).rejects.toMatchObject({ code: '25006' });
    } finally {
      await reader.end();
      await app.end();
    }
  });
});
