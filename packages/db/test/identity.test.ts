import { afterAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { SAMPLE } from '../src/seed';
import { appPool, workerPool } from './helpers';

const { customers: C, users: U } = SAMPLE;

afterAll(async () => {
  await appPool.end();
  await workerPool.end();
});

/** Runs as joybot_worker (the Cognito trigger Lambdas), always rolled back. */
async function asWorker<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await workerPool.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.via', 'cognito', true)`);
    return await fn(db);
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
}

const signup = (db: PoolClient, sub: string, email: string | null, ev: boolean, phone: string | null, pv: boolean) =>
  db
    .query<{ outcome: string; customer_id: string | null }>('SELECT * FROM authz.link_customer_signup($1, $2, $3, $4, $5)', [
      sub,
      email,
      ev,
      phone,
      pv,
    ])
    .then((r) => r.rows[0]);

describe('customer sign-up linking', () => {
  it('links a staff-created customer by verified email', async () => {
    await asWorker(async (db) => {
      expect(await signup(db, 'sub-maria', 'MARIA@example.com', true, null, false)).toEqual({ outcome: 'linked', customer_id: C.maria });
      expect(await signup(db, 'sub-maria', 'maria@example.com', true, null, false)).toEqual({ outcome: 'existing', customer_id: C.maria });
      const resolved = await db.query('SELECT * FROM authz.resolve_principal($1, $2)', ['customer', 'sub-maria']);
      expect(resolved.rows[0]).toMatchObject({ principal_type: 'customer', principal_id: C.maria, role: 'customer' });
    });
  });

  it('links by verified phone (WhatsApp) and records WhatsApp opt-in', async () => {
    await asWorker(async (db) => {
      expect(await signup(db, 'sub-pat', null, false, '+13105550106', true)).toEqual({ outcome: 'linked', customer_id: C.pat });
      const row = (await db.query('SELECT whatsapp_opt_in_at FROM core.customers WHERE id = $1', [C.pat])).rows[0];
      expect(row.whatsapp_opt_in_at).not.toBeNull();
    });
  });

  it('never matches on unverified contacts — creates a new customer instead', async () => {
    await asWorker(async (db) => {
      await expect(signup(db, 'sub-x', 'maria@example.com', false, null, false)).rejects.toThrow(/verified email or phone/);
    });
    await asWorker(async (db) => {
      const res = await signup(db, 'sub-new', 'new.person@example.com', true, null, false);
      expect(res.outcome).toBe('created');
      const row = (await db.query('SELECT source, email_verified FROM core.customers WHERE id = $1', [res.customer_id])).rows[0];
      expect(row).toEqual({ source: 'self_signup', email_verified: true });
    });
  });

  it('sends contacts already linked to another login to review', async () => {
    await asWorker(async (db) => {
      await signup(db, 'sub-john-1', 'john@acme.example', true, null, false);
      expect(await signup(db, 'sub-john-2', 'john@acme.example', true, null, false)).toEqual({ outcome: 'review', customer_id: null });
      const q = await db.query(`SELECT reason, candidate_customer_id FROM app.link_review_queue WHERE cognito_sub = 'sub-john-2'`);
      expect(q.rows[0]).toEqual({ reason: 'contact_linked_to_other_login', candidate_customer_id: C.john });
    });
  });

  it('sends contacts that point to two different customers to review', async () => {
    await asWorker(async (db) => {
      // maria's email + pat's phone
      expect(await signup(db, 'sub-mix', 'maria@example.com', true, '+13105550106', true)).toEqual({ outcome: 'review', customer_id: null });
    });
  });

  it('is not callable by the API role', async () => {
    const db = await appPool.connect();
    try {
      await expect(db.query(`SELECT * FROM authz.link_customer_signup('s', 'a@b.c', true, NULL, false)`)).rejects.toThrow(/permission denied/);
    } finally {
      db.release();
    }
  });
});

describe('employee login linking', () => {
  it('links the first sign-in by email, then resolves by sub', async () => {
    await asWorker(async (db) => {
      const linked = await db.query('SELECT authz.link_employee_login($1, $2) AS id', ['sub-sam', 'Sam@Example.com']);
      expect(linked.rows[0].id).toBe(U.sam);
      const again = await db.query('SELECT authz.link_employee_login($1, $2) AS id', ['sub-sam', 'sam@example.com']);
      expect(again.rows[0].id).toBe(U.sam);
      const other = await db.query('SELECT authz.link_employee_login($1, $2) AS id', ['sub-attacker', 'sam@example.com']);
      expect(other.rows[0].id).toBeNull();
    });
  });

  it('does not link inactive or unknown employees', async () => {
    await asWorker(async (db) => {
      await db.query(`UPDATE core.users SET active = false WHERE id = $1`, [U.lia]);
      expect((await db.query('SELECT authz.link_employee_login($1, $2) AS id', ['sub-lia', 'lia@example.com'])).rows[0].id).toBeNull();
      expect((await db.query('SELECT authz.link_employee_login($1, $2) AS id', ['sub-z', 'nobody@example.com'])).rows[0].id).toBeNull();
    });
  });
});
