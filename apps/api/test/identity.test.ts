import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EMPLOYEE_LOGINS, type EmployeeLogins, type EmployeeRole } from '../src/admin/employee-logins';
import { JWT_VERIFIERS, type AudienceVerifier } from '../src/auth/auth.guard';
import { api, createApp, employee } from './app';

const { users: U, customers: C } = SAMPLE;

/** Records Cognito calls; can be told to fail to check that employee changes roll back. */
class FakeLogins implements EmployeeLogins {
  calls: string[] = [];
  failNext = false;
  private record(call: string) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Cognito unavailable');
    }
    this.calls.push(call);
  }
  async invite(email: string, role: EmployeeRole) {
    this.record(`invite ${email} ${role}`);
  }
  async resendInvite(email: string) {
    this.record(`resend ${email}`);
  }
  async changeRole(email: string, from: EmployeeRole, to: EmployeeRole) {
    this.record(`role ${email} ${from}->${to}`);
  }
  async disable(email: string) {
    this.record(`disable ${email}`);
  }
  async enable(email: string) {
    this.record(`enable ${email}`);
  }
}

describe('employee logins (admin API ↔ Cognito)', () => {
  const logins = new FakeLogins();
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp({ overrides: [{ token: EMPLOYEE_LOGINS, value: logins }] });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    logins.calls = [];
  });

  it('invites new employees, with their role as group', async () => {
    const res = await api(app, employee(U.ada))
      .post('/api/admin/users', { first_name: 'Nia', last_name: 'New', email: 'Nia@Example.com', role: 'staff' })
      .expect(201);
    expect(res.body.email).toBe('nia@example.com');
    expect(logins.calls).toEqual(['invite nia@example.com staff']);
  });

  it('rolls the employee back if Cognito fails', async () => {
    logins.failNext = true;
    await api(app, employee(U.ada))
      .post('/api/admin/users', { first_name: 'Rex', last_name: 'Fail', email: 'rex@example.com', role: 'staff' })
      .expect(500);
    const list = await api(app, employee(U.ada)).get('/api/admin/users?include_inactive=true').expect(200);
    expect(list.body.map((u: { email: string }) => u.email)).not.toContain('rex@example.com');
  });

  it('keeps Cognito in step with deactivation, reactivation and role changes', async () => {
    const created = await api(app, employee(U.ada))
      .post('/api/admin/users', { first_name: 'Ivy', last_name: 'Cycle', email: 'ivy@example.com', role: 'staff' })
      .expect(201);
    const id = created.body.id;
    await api(app, employee(U.ada)).put(`/api/admin/users/${id}`, { active: false }).expect(200);
    await api(app, employee(U.ada)).put(`/api/admin/users/${id}`, { active: true }).expect(200);
    await api(app, employee(U.ada)).put(`/api/admin/users/${id}`, { role: 'admin' }).expect(200);
    await api(app, employee(U.ada)).put(`/api/admin/users/${id}`, { first_name: 'Ivy-May' }).expect(200);
    expect(logins.calls).toEqual([
      'invite ivy@example.com staff',
      'disable ivy@example.com',
      'enable ivy@example.com',
      'role ivy@example.com staff->admin',
    ]);
  });

  it('does not allow changing the sign-in email', async () => {
    await api(app, employee(U.ada)).put(`/api/admin/users/${U.sam}`, { email: 'samuel@example.com' }).expect(400);
    await api(app, employee(U.ada)).put(`/api/admin/users/${U.sam}`, { email: 'sam@example.com' }).expect(200);
  });

  it('resends invites only to employees who have not signed in', async () => {
    await api(app, employee(U.ada)).post(`/api/admin/users/${U.lia}/resend-invite`).expect(200, { sent: true });
    expect(logins.calls).toEqual(['resend lia@example.com']);
    await api(app, employee(U.sam)).post(`/api/admin/users/${U.lia}/resend-invite`).expect(403);
  });
});

describe('Cognito authentication', () => {
  // Fake pools: each accepts one token and returns a fixed sub.
  const verifiers: AudienceVerifier[] = [
    { audience: 'employee', verifier: { verify: async (t) => (t === 'staff-token' ? { sub: 'sub-sam' } : Promise.reject(new Error('bad'))) } },
    {
      audience: 'customer',
      verifier: {
        verify: async (t) => {
          if (t === 'maria-token') return { sub: 'sub-maria' };
          if (t === 'stranger-token') return { sub: 'sub-unlinked' };
          throw new Error('bad');
        },
      },
    },
  ];
  let app: INestApplication;
  let migrator: Client;

  beforeAll(async () => {
    config({ path: path.resolve(__dirname, '../../../.env') });
    migrator = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
    await migrator.connect();
    await migrator.query(`UPDATE core.users SET cognito_sub = 'sub-sam' WHERE id = $1`, [U.sam]);
    await migrator.query(`UPDATE core.customers SET cognito_sub = 'sub-maria' WHERE id = $1`, [C.maria]);
    app = await createApp({
      env: {
        AUTH_MODE: 'cognito',
        CUSTOMERS_USER_POOL_ID: 'us-east-1_customers',
        CUSTOMERS_CLIENT_ID: 'customers-client',
        EMPLOYEES_USER_POOL_ID: 'us-east-1_employees',
        EMPLOYEES_CLIENT_ID: 'employees-client',
      },
      overrides: [
        { token: JWT_VERIFIERS, value: verifiers },
        { token: EMPLOYEE_LOGINS, value: new FakeLogins() },
      ],
    });
  });
  afterAll(async () => {
    await app.close();
    await migrator.query(`UPDATE core.users SET cognito_sub = NULL WHERE id = $1`, [U.sam]);
    await migrator.query(`UPDATE core.customers SET cognito_sub = NULL WHERE id = $1`, [C.maria]);
    await migrator.end();
  });

  const get = (url: string, token?: string) => {
    const r = request(app.getHttpServer()).get(url);
    return token ? r.set('authorization', `Bearer ${token}`) : r;
  };

  it('resolves employees and customers from their pool tokens', async () => {
    const staff = await get('/api/me', 'staff-token').expect(200);
    expect(staff.body).toMatchObject({ type: 'employee', role: 'staff', profile: { id: U.sam } });
    const customer = await get('/api/me', 'maria-token').expect(200);
    expect(customer.body).toMatchObject({ type: 'customer', role: 'customer', profile: { id: C.maria } });
  });

  it('rejects missing, invalid and unlinked tokens', async () => {
    await get('/api/me').expect(401);
    await get('/api/me', 'forged-token').expect(401);
    const unlinked = await get('/api/me', 'stranger-token').expect(401);
    expect(unlinked.body.message).toBe('Account is not linked');
  });

  it('tells a sign-up waiting for review that it is being checked (403, so the app does not sign out)', async () => {
    await migrator.query(`INSERT INTO app.link_review_queue (cognito_sub, contact_hash, reason) VALUES ('sub-unlinked', 'x', 'contact_linked_to_other_login')`);
    try {
      const res = await get('/api/me', 'stranger-token').expect(403);
      expect(res.body.code).toBe('account_in_review');
    } finally {
      await migrator.query(`DELETE FROM app.link_review_queue WHERE cognito_sub = 'sub-unlinked'`);
    }
  });

  it('ignores the dev header in Cognito mode', async () => {
    await request(app.getHttpServer()).get('/api/me').set('x-dev-principal', `employee:${U.ada}`).expect(401);
  });

  it('enforces access with Cognito principals too', async () => {
    const res = await get('/api/customers', 'staff-token').expect(200);
    expect(res.body.map((c: { id: string }) => c.id).sort()).toEqual([C.jane, C.maria, C.pat].sort());
    await get('/api/customers', 'maria-token').expect(403);
  });
});
