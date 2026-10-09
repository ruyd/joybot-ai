import type { Pool, PoolClient } from 'pg';

export type PrincipalType = 'employee' | 'customer';

export interface DbPrincipal {
  type: PrincipalType;
  id: string;
}

/** Where a write came from; recorded in core.change_log.changed_via. */
export type ChangeVia = 'api' | 'chat' | 'worker' | 'stripe_webhook' | 'cognito' | 'seed' | 'test';

/**
 * Runs `fn` inside a transaction whose RLS context is the given principal.
 * Every query that touches core/app tables must go through this (or withSystem for the worker),
 * so Postgres Row-Level Security sees who is asking.
 */
export async function withPrincipal<T>(
  pool: Pool,
  principal: DbPrincipal,
  fn: (client: PoolClient) => Promise<T>,
  via: ChangeVia = 'api',
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.principal_type', $1, true),
              set_config('app.principal_id', $2, true),
              set_config('app.via', $3, true)`,
      [principal.type, principal.id, via],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Transaction without a principal; only meaningful for the joybot_worker role (system access). */
export async function withSystem<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  via: ChangeVia = 'worker',
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.via', $1, true)`, [via]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
