import { afterAll, describe, expect, it } from 'vitest';
import { SAMPLE } from '../src/seed';
import { appPool, as, customer, employee, ids, workerPool } from './helpers';

const { customers: C, users: U, orgs: O, payments: P, appointments: A } = SAMPLE;
const sorted = (...xs: string[]) => [...xs].sort();

afterAll(async () => {
  await appPool.end();
  await workerPool.end();
});

describe('no principal', () => {
  it('sees nothing', async () => {
    await as(null, async (db) => {
      expect(await ids(db, 'SELECT id FROM core.customers')).toEqual([]);
      expect(await ids(db, 'SELECT id FROM core.payments')).toEqual([]);
      expect((await db.query('SELECT * FROM core.settings')).rowCount).toBe(0);
    });
  });

  it('cannot spoof a role through session settings', async () => {
    await as(null, async (db) => {
      await db.query(`SELECT set_config('app.role', 'admin', true)`);
      expect(await ids(db, 'SELECT id FROM core.customers')).toEqual([]);
    });
  });
});

describe('customer', () => {
  it('sees only their own customer record, appointments and payments', async () => {
    await as(customer(C.maria), async (db) => {
      expect(await ids(db, 'SELECT id FROM core.customers')).toEqual([C.maria]);
      expect(await ids(db, 'SELECT id FROM core.appointments')).toEqual(sorted(A.mariaDone, A.mariaNext));
      expect(await ids(db, 'SELECT id FROM core.payments')).toEqual([P.mariaPos]);
      expect(await ids(db, 'SELECT id FROM core.organizations')).toEqual([]);
    });
  });

  it('a member sees their organization but not other members', async () => {
    await as(customer(C.jane), async (db) => {
      expect(await ids(db, 'SELECT id FROM core.customers')).toEqual([C.jane]);
      expect(await ids(db, 'SELECT id FROM core.organizations')).toEqual([O.acme]);
    });
  });

  it('can read the price list, locations and settings', async () => {
    await as(customer(C.pat), async (db) => {
      expect((await db.query('SELECT id FROM core.services')).rowCount).toBe(2);
      expect((await db.query('SELECT id FROM core.locations')).rowCount).toBe(2);
      expect((await db.query('SELECT id FROM core.settings')).rowCount).toBe(1);
      expect((await db.query('SELECT id FROM core.users')).rowCount).toBe(0);
    });
  });

  it('cannot create customers or payments', async () => {
    await as(customer(C.maria), async (db) => {
      await expect(
        db.query(`INSERT INTO core.customers (email, source) VALUES ('x@example.com', 'employee')`),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it('blocked customers lose access', async () => {
    await as(employee(U.ada), async (db) => {
      await db.query(`UPDATE core.customers SET status = 'blocked' WHERE id = $1`, [C.maria]);
      await db.query(
        `SELECT set_config('app.principal_type', 'customer', true), set_config('app.principal_id', $1, true)`,
        [C.maria],
      );
      expect((await db.query('SELECT id FROM core.customers')).rowCount).toBe(0);
      expect((await db.query('SELECT id FROM core.payments')).rowCount).toBe(0);
    });
  });
});

describe('org admin', () => {
  it('sees organization members and their appointments, but only their own payments', async () => {
    await as(customer(C.john), async (db) => {
      expect(await ids(db, 'SELECT id FROM core.customers')).toEqual(sorted(C.john, C.jane));
      expect(await ids(db, 'SELECT id FROM core.organizations')).toEqual([O.acme]);
      expect(await ids(db, 'SELECT id FROM core.appointments')).toEqual(sorted(A.johnDone, A.janeNext));
      expect(await ids(db, 'SELECT id FROM core.payments')).toEqual([P.johnStripe]);
    });
  });
});

describe('admin', () => {
  it('sees everything including restricted records and unmatched Stripe payments', async () => {
    await as(employee(U.ada), async (db) => {
      expect(await ids(db, 'SELECT id FROM core.customers')).toEqual(sorted(...Object.values(C)));
      expect(await ids(db, 'SELECT id FROM core.organizations')).toEqual(sorted(O.acme, O.vip));
      expect(await ids(db, 'SELECT id FROM core.payments')).toEqual(sorted(...Object.values(P)));
    });
  });

  it('can void a manual payment', async () => {
    await as(employee(U.ada), async (db) => {
      const res = await db.query(
        `UPDATE core.payments SET status = 'voided', void_reason = 'test', voided_by = $1, voided_at = now()
          WHERE id = $2`,
        [U.ada, P.mariaPos],
      );
      expect(res.rowCount).toBe(1);
    });
  });
});

describe('staff', () => {
  it('NYC staff see customers at their location, own customers and granted records — not restricted ones', async () => {
    await as(employee(U.sam), async (db) => {
      // maria + jane: NYC; pat: active read grant. Not john (LA), victor (restricted org), rita (restricted).
      expect(await ids(db, 'SELECT id FROM core.customers')).toEqual(sorted(C.maria, C.jane, C.pat));
      expect(await ids(db, 'SELECT id FROM core.organizations')).toEqual([O.acme]);
    });
  });

  it('LA staff see LA customers and the restricted organization they are assigned to', async () => {
    await as(employee(U.lia), async (db) => {
      // john + pat: LA; victor: via assignment to VIP org. Expired grant on maria does nothing.
      expect(await ids(db, 'SELECT id FROM core.customers')).toEqual(sorted(C.john, C.pat, C.victor));
      // Acme is visible because its org admin (john) is an LA customer.
      expect(await ids(db, 'SELECT id FROM core.organizations')).toEqual(sorted(O.acme, O.vip));
    });
  });

  it('a read grant does not allow updates', async () => {
    await as(employee(U.sam), async (db) => {
      const res = await db.query(`UPDATE core.customers SET first_name = 'Patricia' WHERE id = $1`, [C.pat]);
      expect(res.rowCount).toBe(0);
    });
  });

  it('see payments in scope plus unmatched Stripe payments at their location', async () => {
    await as(employee(U.sam), async (db) => {
      expect(await ids(db, 'SELECT id FROM core.payments')).toEqual(
        sorted(P.mariaPos, P.janeTransfer, P.unmatchedStripe),
      );
    });
    await as(employee(U.lia), async (db) => {
      expect(await ids(db, 'SELECT id FROM core.payments')).toEqual([P.johnStripe]);
    });
  });

  it('can update only manual payments they recorded', async () => {
    await as(employee(U.sam), async (db) => {
      const own = await db.query(`UPDATE core.payments SET notes_internal = 'checked' WHERE id = $1`, [P.janeTransfer]);
      expect(own.rowCount).toBe(1);
    });
    await as(employee(U.lia), async (db) => {
      const stripe = await db.query(`UPDATE core.payments SET notes_internal = 'x' WHERE id = $1`, [P.johnStripe]);
      expect(stripe.rowCount).toBe(0);
    });
  });

  it('can record a manual payment for a customer in scope, not for one out of scope', async () => {
    await as(employee(U.sam), async (db) => {
      const ok = await db.query(
        `INSERT INTO core.payments (source, customer_id, amount, currency, method, status, paid_at, recorded_by)
         VALUES ('manual', $1, 20, 'USD', 'cash', 'succeeded', now(), $2) RETURNING id`,
        [C.maria, U.sam],
      );
      expect(ok.rowCount).toBe(1);
      await expect(
        db.query(
          `INSERT INTO core.payments (source, customer_id, amount, currency, method, status, paid_at, recorded_by)
           VALUES ('manual', $1, 20, 'USD', 'cash', 'succeeded', now(), $2)`,
          [C.john, U.sam],
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it('cannot record a payment on behalf of another employee', async () => {
    await as(employee(U.sam), async (db) => {
      await expect(
        db.query(
          `INSERT INTO core.payments (source, customer_id, amount, currency, method, status, paid_at, recorded_by)
           VALUES ('manual', $1, 20, 'USD', 'cash', 'succeeded', now(), $2)`,
          [C.maria, U.ada],
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it('cannot change settings or access-control tables', async () => {
    await as(employee(U.sam), async (db) => {
      const res = await db.query(`UPDATE core.settings SET business_name = 'x'`);
      expect(res.rowCount).toBe(0);
      await expect(
        db.query(`INSERT INTO core.role_permissions VALUES ('staff', 'customers', 'read', 'all')`),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it('customers created by staff stay visible to them (own scope)', async () => {
    await as(employee(U.lia), async (db) => {
      const res = await db.query<{ id: string }>(
        `INSERT INTO core.customers (first_name, phone, source, created_by)
         VALUES ('Walk-in', '+13105550199', 'employee', $1) RETURNING id`,
        [U.lia],
      );
      expect(await ids(db, 'SELECT id FROM core.customers WHERE id = $1', [res.rows[0].id])).toEqual([res.rows[0].id]);
    });
  });
});

describe('balance view', () => {
  it('combines Stripe and manual payments and respects RLS', async () => {
    await as(customer(C.maria), async (db) => {
      const rows = (await db.query('SELECT customer_id, billed, paid, balance FROM core.v_customer_balance')).rows;
      expect(rows).toEqual([{ customer_id: C.maria, billed: '50.00', paid: '50.00', balance: '0.00' }]);
    });
    await as(customer(C.john), async (db) => {
      const rows = (await db.query('SELECT customer_id, balance FROM core.v_customer_balance ORDER BY customer_id')).rows;
      expect(rows.map((r) => r.customer_id)).toEqual(sorted(C.john, C.jane));
    });
  });

  it('flags overdue bank transfers', async () => {
    await as(employee(U.sam), async (db) => {
      const rows = (await db.query('SELECT id, overdue FROM core.v_pending_bank_transfers')).rows;
      expect(rows).toEqual([{ id: P.janeTransfer, overdue: true }]);
    });
  });
});

describe('audit log', () => {
  it('records who changed what', async () => {
    await as(employee(U.ada), async (db) => {
      await db.query(`UPDATE core.customers SET last_name = 'López' WHERE id = $1`, [C.maria]);
      const log = await db.query(
        `SELECT changed_by, principal_type, changed_via, diff FROM core.change_log
          WHERE table_name = 'customers' AND row_id = $1 AND action = 'UPDATE'
          ORDER BY id DESC LIMIT 1`,
        [C.maria],
      );
      expect(log.rows[0]).toMatchObject({
        changed_by: U.ada,
        principal_type: 'employee',
        changed_via: 'test',
        diff: { last_name: { old: 'Lopez', new: 'López' } },
      });
    });
  });

  it('is not readable by staff', async () => {
    await as(employee(U.sam), async (db) => {
      expect((await db.query('SELECT id FROM core.change_log')).rowCount).toBe(0);
    });
  });
});

describe('data rules', () => {
  it('rejects invalid time zones', async () => {
    await as(employee(U.ada), async (db) => {
      await expect(db.query(`UPDATE core.settings SET default_time_zone = 'Mars/Olympus'`)).rejects.toThrow(
        /invalid time zone/,
      );
    });
  });

  it('requires a POS reference for manual card payments', async () => {
    await as(employee(U.ada), async (db) => {
      await expect(
        db.query(
          `INSERT INTO core.payments (source, customer_id, amount, currency, method, status, paid_at, recorded_by)
           VALUES ('manual', $1, 20, 'USD', 'card_pos', 'succeeded', now(), $2)`,
          [C.maria, U.ada],
        ),
      ).rejects.toThrow(/check constraint/);
    });
  });

  it('requires an email or phone on every customer', async () => {
    await as(employee(U.ada), async (db) => {
      await expect(
        db.query(`INSERT INTO core.customers (first_name, source, created_by) VALUES ('Nobody', 'employee', $1)`, [U.ada]),
      ).rejects.toThrow(/check constraint/);
    });
  });
});
