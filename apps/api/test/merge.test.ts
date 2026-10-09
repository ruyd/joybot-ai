import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createApp, customer, employee } from './app';

const { customers: C, users: U, locations: L } = SAMPLE;

let app: INestApplication;
let migrator: Client;
let worker: Client;

const newCustomer = async (fields: Record<string, unknown>) =>
  (
    await migrator.query<{ id: string; customer_number: string }>(
      `INSERT INTO core.customers (${Object.keys(fields).join(', ')}, source, preferred_location_id)
       VALUES (${Object.keys(fields).map((_, i) => `$${i + 1}`).join(', ')}, 'employee', '${L.nyc}')
       RETURNING id, customer_number`,
      Object.values(fields),
    )
  ).rows[0];

const signup = async (sub: string, email: string) =>
  (await worker.query('SELECT * FROM authz.link_customer_signup($1, $2, true, NULL, false)', [sub, email])).rows[0];

const principalFor = async (sub: string) =>
  (await migrator.query(`SELECT principal_id FROM authz.resolve_principal('customer', $1)`, [sub])).rows[0]?.principal_id;

beforeAll(async () => {
  config({ path: path.resolve(__dirname, '../../../.env') });
  migrator = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  worker = new Client({ connectionString: process.env.WORKER_DATABASE_URL });
  await Promise.all([migrator.connect(), worker.connect()]);
  app = await createApp();
});
afterAll(async () => {
  await app.close();
  await Promise.all([migrator.end(), worker.end()]);
});

describe('who can merge', () => {
  it('admins only; staff cannot be given the permission', async () => {
    await api(app, employee(U.ada)).get('/api/duplicates').expect(200);
    await api(app, employee(U.sam)).get('/api/duplicates').expect(403);
    await api(app, employee(U.sam)).get('/api/link-reviews').expect(403);
    await api(app, employee(U.sam)).post(`/api/customers/${C.rita}/merge`, { into: C.maria, reason: 'same person' }).expect(403);
    await api(app, customer(C.john)).get('/api/link-reviews').expect(403);
    const res = await api(app, employee(U.ada))
      .put('/api/admin/permissions/staff', { permissions: [{ resource: 'customers', action: 'merge', scope: 'location' }] })
      .expect(400);
    expect(res.body.message).toMatch(/cannot be allowed to merge customers/);
  });

  it('the review queue is hidden from staff and customers in the database too', async () => {
    const app_ = new Client({ connectionString: process.env.APP_DATABASE_URL });
    await app_.connect();
    try {
      await migrator.query(`INSERT INTO app.link_review_queue (cognito_sub, contact_hash, reason) VALUES ('sub-hidden', 'x', 'test')`);
      for (const [type, id] of [['employee', U.sam], ['customer', C.maria]]) {
        await app_.query('BEGIN');
        await app_.query(`SELECT set_config('app.principal_type', $1, true), set_config('app.principal_id', $2, true)`, [type, id]);
        expect((await app_.query('SELECT count(*)::int AS n FROM app.link_review_queue')).rows[0].n).toBe(0);
        await app_.query('ROLLBACK');
      }
    } finally {
      await migrator.query(`DELETE FROM app.link_review_queue WHERE cognito_sub = 'sub-hidden'`);
      await app_.end();
    }
  });
});

describe('duplicates and merge', () => {
  let dup: { id: string; customer_number: string };
  let dupAppointment: string;

  beforeAll(async () => {
    dup = await newCustomer({ first_name: 'maria', last_name: 'LOPEZ', email: 'maria.l@work.example', email_verified: true, date_of_birth: '1990-04-02', stripe_customer_id: 'cus_dup' });
    dupAppointment = (
      await migrator.query(
        `INSERT INTO core.appointments (customer_id, service_id, location_id, scheduled_start, scheduled_end, price_quoted, currency)
         SELECT $1, service_id, location_id, scheduled_start + interval '40 days', scheduled_end + interval '40 days', price_quoted, currency
           FROM core.appointments WHERE customer_id = $2 LIMIT 1 RETURNING id`,
        [dup.id, C.maria],
      )
    ).rows[0].id;
    await migrator.query(
      `INSERT INTO core.payments (source, customer_id, amount, currency, method, status, recorded_by, paid_at)
       VALUES ('manual', $1, 25, 'USD', 'cash', 'succeeded', $2, now())`,
      [dup.id, U.ada],
    );
  });

  it('finds likely duplicates and can dismiss a pair', async () => {
    const res = await api(app, employee(U.ada)).get('/api/duplicates').expect(200);
    const pair = res.body.find((d: { customers: { id: string }[] }) => d.customers.some((c) => c.id === dup.id));
    expect(pair.reason).toBe('same_name');
    expect(pair.customers.map((c: { id: string }) => c.id).sort()).toEqual([C.maria, dup.id].sort());

    const other = await newCustomer({ first_name: 'Maria', last_name: 'Lopez', phone: '+12125550188' });
    await api(app, employee(U.ada)).post('/api/duplicates/dismiss', { customer_ids: [other.id, C.maria] }).expect(204);
    const after = (await api(app, employee(U.ada)).get('/api/duplicates').expect(200)).body;
    const pairs = after.map((d: { customers: { id: string }[] }) => d.customers.map((c) => c.id).sort().join());
    expect(pairs).not.toContain([C.maria, other.id].sort().join());
    expect(pairs).toContain([C.maria, dup.id].sort().join());
  });

  it('previews what moves and what is dropped', async () => {
    const res = await api(app, employee(U.ada)).get(`/api/customers/${dup.id}/merge-preview?into=${C.maria}`).expect(200);
    expect(res.body).toMatchObject({ moves: { appointments: 1, payments: 1 }, filled: [], dropped: ['first_name', 'last_name', 'email'], blockers: [] });
  });

  it('merges records into the target and hides the source', async () => {
    const res = await api(app, employee(U.ada)).post(`/api/customers/${dup.id}/merge`, { into: C.maria, reason: 'Same person, work email' }).expect(200);
    expect(res.body).toMatchObject({ id: C.maria, email: 'maria@example.com', has_stripe: true });

    await api(app, employee(U.ada)).get(`/api/customers/${dup.id}`).expect(404);
    const search = await api(app, employee(U.ada)).get('/api/customers?q=Maria Lopez').expect(200);
    expect(search.body.map((c: { id: string }) => c.id)).not.toContain(dup.id);
    const appt = await api(app, employee(U.ada)).get(`/api/appointments/${dupAppointment}`).expect(200);
    expect(appt.body.customer_id).toBe(C.maria);

    const tomb = (await migrator.query('SELECT status, merged_into, email, stripe_customer_id FROM core.customers WHERE id = $1', [dup.id])).rows[0];
    expect(tomb).toEqual({ status: 'merged', merged_into: C.maria, email: null, stripe_customer_id: null });
    const maria = (await migrator.query('SELECT stripe_customer_id, date_of_birth::text AS dob FROM core.customers WHERE id = $1', [C.maria])).rows[0];
    expect(maria).toEqual({ stripe_customer_id: 'cus_dup', dob: '1990-04-02' });

    const log = (await migrator.query(`SELECT count(*)::int AS n FROM core.change_log WHERE row_id = $1 AND changed_by = $2`, [dup.id, U.ada])).rows[0];
    expect(log.n).toBeGreaterThan(0);
  });

  it('Stripe matching follows the tombstone', async () => {
    const m = (await worker.query('SELECT customer_id FROM core.match_stripe_customer($1, NULL, NULL, NULL)', [dup.customer_number])).rows[0];
    expect(m.customer_id).toBe(C.maria);
  });

  it('refuses unsafe merges with a clear reason', async () => {
    const admin = api(app, employee(U.ada));
    await admin.post(`/api/customers/${dup.id}/merge`, { into: C.maria, reason: 'again' }).expect(404);
    expect((await admin.post(`/api/customers/${C.maria}/merge`, { into: C.maria, reason: 'self' }).expect(400)).body.message).toMatch(/into itself/);

    const a = await newCustomer({ first_name: 'Ann', last_name: 'One', email: 'ann1@example.com', cognito_sub: 'sub-ann-1' });
    const b = await newCustomer({ first_name: 'Ann', last_name: 'One', email: 'ann2@example.com', cognito_sub: 'sub-ann-2' });
    const preview = await admin.get(`/api/customers/${a.id}/merge-preview?into=${b.id}`).expect(200);
    expect(preview.body.blockers).toEqual(['Both customers have a portal login.']);
    expect((await admin.post(`/api/customers/${a.id}/merge`, { into: b.id, reason: 'same' }).expect(400)).body.message).toBe('both customers have a portal login');
  });
});

describe('link review', () => {
  it('links a waiting sign-up to a customer without a login', async () => {
    const owner = await newCustomer({ first_name: 'Lee', last_name: 'Owner', email: 'lee@example.com', email_verified: true, cognito_sub: 'sub-lee-old' });
    expect(await signup('sub-lee-new', 'lee@example.com')).toEqual({ outcome: 'review', customer_id: null });

    const admin = api(app, employee(U.ada));
    const review = (await admin.get('/api/link-reviews').expect(200)).body.find((r: { candidate: { id: string } | null }) => r.candidate?.id === owner.id);
    expect(review).toMatchObject({ reason: 'contact_linked_to_other_login', matched_on: 'email', account: null, actions: ['link', 'reject'] });

    // The candidate already has a login: linking there is refused.
    const refused = await admin.post(`/api/link-reviews/${review.id}/resolve`, { action: 'link' }).expect(400);
    expect(refused.body.message).toMatch(/already has a login/);
    await admin.post(`/api/link-reviews/${review.id}/resolve`, { action: 'merge' }).expect(400);

    const target = await newCustomer({ first_name: 'Lee', last_name: 'Owner', phone: '+12125550177' });
    await admin.post(`/api/link-reviews/${review.id}/resolve`, { action: 'link', customer_id: target.id, note: 'Called the customer' }).expect(200, { status: 'linked' });
    expect(await principalFor('sub-lee-new')).toBe(target.id);
    await admin.post(`/api/link-reviews/${review.id}/resolve`, { action: 'reject' }).expect(400);

    const done = (await admin.get('/api/link-reviews?status=linked').expect(200)).body.find((r: { id: string }) => r.id === review.id);
    expect(done).toMatchObject({ resolution_note: 'Called the customer', resolved_by_name: 'Ada Admin', candidate: { id: target.id } });
  });

  it('merges an account that accepted someone else’s invite into the invited customer', async () => {
    const invited = await newCustomer({ first_name: 'Ivy', last_name: 'Invited', email: 'ivy@company.example', email_verified: true });
    const account = await newCustomer({ first_name: 'Ivy', last_name: 'Invited', email: 'ivy@home.example', email_verified: true, cognito_sub: 'sub-ivy' });
    const token = randomBytes(32).toString('base64url');
    await migrator.query(
      `INSERT INTO app.invites (token_hash, customer_id, channel, sent_to_hash, expires_at, created_by_type, created_by)
       VALUES ($1, $2, 'email', 'x', now() + interval '1 day', 'employee', $3)`,
      [createHash('sha256').update(token).digest('hex'), invited.id, U.ada],
    );
    const ivy = api(app, customer(account.id));
    const conv = (await ivy.post('/api/conversations', {}).expect(201)).body.id;
    await ivy.post('/api/me/invites/accept', { token }).expect(200, { status: 'review' });

    const admin = api(app, employee(U.ada));
    const review = (await admin.get('/api/link-reviews').expect(200)).body.find((r: { account: { id: string } | null }) => r.account?.id === account.id);
    expect(review).toMatchObject({ reason: 'invite_accepted_by_other_account', candidate: { id: invited.id }, actions: ['merge', 'reject'] });
    await admin.post(`/api/link-reviews/${review.id}/resolve`, { action: 'link' }).expect(400);
    await admin.post(`/api/link-reviews/${review.id}/resolve`, { action: 'merge' }).expect(200, { status: 'merged' });

    // The login now opens the invited record, with its chats.
    expect(await principalFor('sub-ivy')).toBe(invited.id);
    await api(app, customer(invited.id)).get(`/api/conversations/${conv}/messages`).expect(200);
    const me = (await api(app, customer(invited.id)).get('/api/me').expect(200)).body.profile;
    expect(me.email).toBe('ivy@company.example');
  });
});
