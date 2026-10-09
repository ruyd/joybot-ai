import path from 'node:path';
import { config } from 'dotenv';
import { Pool, type PoolClient } from 'pg';
import type { DbPrincipal } from '../src/scope';

config({ path: path.resolve(__dirname, '../../../.env') });

export const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL, max: 4 });
export const workerPool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL, max: 2 });

/** Runs fn as the principal inside a transaction that is always rolled back. */
export async function as<T>(principal: DbPrincipal | null, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    if (principal) {
      await client.query(
        `SELECT set_config('app.principal_type', $1, true), set_config('app.principal_id', $2, true),
                set_config('app.via', 'test', true)`,
        [principal.type, principal.id],
      );
    }
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

export async function ids(db: PoolClient, sql: string, params: unknown[] = []): Promise<string[]> {
  const res = await db.query<{ id: string }>(sql, params);
  return res.rows.map((r) => r.id).sort();
}

export const employee = (id: string): DbPrincipal => ({ type: 'employee', id });
export const customer = (id: string): DbPrincipal => ({ type: 'customer', id });
