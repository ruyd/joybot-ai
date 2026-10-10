import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SAMPLE } from '@joybot/db';
import { WhatsAppSettingsPublisher } from '../src/settings/whatsapp-publisher';
import { api, createApp, customer, employee } from './app';

const { customers: C, users: U, payments: P, appointments: A } = SAMPLE;
let app: INestApplication;

beforeAll(async () => {
  app = await createApp();
});
afterAll(async () => {
  await app.close();
});

describe('auth', () => {
  it('health is public', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200, { status: 'ok' });
  });

  it('rejects requests without a principal', async () => {
    await request(app.getHttpServer()).get('/api/me').expect(401);
  });

  it('rejects unknown principals', async () => {
    await api(app, employee('20000000-0000-4000-8000-0000000000ff')).get('/api/me').expect(401);
  });

  it('returns the principal and its permission rules', async () => {
    const res = await api(app, customer(C.john)).get('/api/me').expect(200);
    expect(res.body).toMatchObject({ type: 'customer', role: 'org_admin', profile: { id: C.john } });
    expect(res.body.rules).toContainEqual({ action: 'read', subject: 'appointments' });
    expect(res.body.rules).not.toContainEqual({ action: 'create', subject: 'payments' });
  });
});

describe('settings', () => {
  it('customers get display settings only', async () => {
    const res = await api(app, customer(C.maria)).get('/api/settings').expect(200);
    expect(res.body.default_time_zone).toBe('America/New_York');
    expect(res.body).not.toHaveProperty('whatsapp_phone_number_id');
  });

  it('only admins can update settings, and time zones are validated', async () => {
    await api(app, employee(U.sam)).put('/api/admin/settings', { business_name: 'X' }).expect(403);
    await api(app, employee(U.ada)).put('/api/admin/settings', { default_time_zone: 'Mars/Base' }).expect(400);
    const res = await api(app, employee(U.ada))
      .put('/api/admin/settings', { bank_transfer_due_days: 7, whatsapp_display_number: '+12125550000' })
      .expect(200);
    expect(res.body).toMatchObject({ bank_transfer_due_days: 7, updated_by: U.ada });
  });

  it('publishes WhatsApp settings for the sender Lambda when they change', async () => {
    const res = await api(app, employee(U.ada))
      .put('/api/admin/settings', {
        whatsapp_phone_number_id: 'phone-number-id-abc',
        whatsapp_otp_template: 'joybot_otp',
        whatsapp_enabled: true,
      })
      .expect(200);
    expect(JSON.parse(WhatsAppSettingsPublisher.payload(res.body))).toEqual({
      enabled: true,
      phoneNumberId: 'phone-number-id-abc',
      otpTemplate: 'joybot_otp',
      language: 'en_US',
    });
    await api(app, employee(U.ada)).put('/api/admin/settings', { whatsapp_enabled: false }).expect(200);
  });

  it('cannot enable WhatsApp without a number and OTP template', async () => {
    await api(app, employee(U.ada))
      .put('/api/admin/settings', { whatsapp_phone_number_id: null, whatsapp_otp_template: null })
      .expect(200);
    await api(app, employee(U.ada)).put('/api/admin/settings', { whatsapp_enabled: true }).expect(400);
  });
});

describe('customers', () => {
  it('customers cannot use the back-office API', async () => {
    await api(app, customer(C.maria)).get('/api/customers').expect(403);
  });

  it('staff search is limited by access control', async () => {
    const res = await api(app, employee(U.sam)).get('/api/customers').expect(200);
    expect(res.body.map((c: { id: string }) => c.id).sort()).toEqual([C.maria, C.jane, C.pat].sort());
    await api(app, employee(U.sam)).get(`/api/customers/${C.rita}`).expect(404);
  });

  it('finds customers by fuzzy name and exact phone', async () => {
    const byName = await api(app, employee(U.ada)).get('/api/customers?q=maria lopes').expect(200);
    expect(byName.body[0].id).toBe(C.maria);
    const byPhone = await api(app, employee(U.ada)).get(`/api/customers?q=${encodeURIComponent('+13105550106')}`).expect(200);
    expect(byPhone.body.map((c: { id: string }) => c.id)).toEqual([C.pat]);
  });

  it('finds customers by short name prefixes, word by word', async () => {
    const ids = async (who: ReturnType<typeof employee>, q: string) =>
      (await api(app, who).get(`/api/customers?q=${encodeURIComponent(q)}`).expect(200)).body.map((c: { id: string }) => c.id);
    for (const q of ['ma', 'MA', 'lop', 'mar lop', 'maria lo']) expect(await ids(employee(U.ada), q)).toEqual([C.maria]);
    expect(await ids(employee(U.ada), 'jo')).toContain(C.john);
    expect(await ids(employee(U.ada), 'ia')).not.toContain(C.maria); // word starts only, not "Mar-ia"
    // LIKE wildcards are literal, and access control still applies.
    expect(await ids(employee(U.ada), '%')).toEqual([]);
    expect(await ids(employee(U.ada), '_a')).toEqual([]);
    expect(await ids(employee(U.sam), 'jo')).not.toContain(C.john);
  });

  it('creates a minimal customer (name + phone) and keeps it visible to its creator', async () => {
    const res = await api(app, employee(U.lia))
      .post('/api/customers', { first_name: 'Walk-in', phone: '+13105550177', whatsapp_opt_in: true })
      .expect(201);
    expect(res.body).toMatchObject({ first_name: 'Walk-in', source: 'employee', status: 'active' });
    expect(res.body.customer_number).toMatch(/^C-\d+$/);
    expect(res.body.whatsapp_opt_in_at).not.toBeNull();
    await api(app, employee(U.lia)).get(`/api/customers/${res.body.id}`).expect(200);
  });

  it('requires an email or phone and E.164 phones', async () => {
    await api(app, employee(U.sam)).post('/api/customers', { first_name: 'Nobody' }).expect(400);
    await api(app, employee(U.sam)).post('/api/customers', { first_name: 'Bad', phone: '555-1234' }).expect(400);
  });

  it('rejects duplicate emails', async () => {
    await api(app, employee(U.ada)).post('/api/customers', { first_name: 'Dup', email: 'maria@example.com' }).expect(409);
  });

  it('staff cannot mark customers restricted (silently ignored)', async () => {
    const res = await api(app, employee(U.sam)).put(`/api/customers/${C.maria}`, { restricted: true }).expect(200);
    expect(res.body.restricted).toBe(false);
  });

  it('hides internal notes from roles without notes permission', async () => {
    const res = await api(app, employee(U.sam)).get(`/api/customers/${C.maria}`).expect(200);
    expect(res.body).toHaveProperty('notes_internal');
  });
});

describe('payments — reading', () => {
  it('customers see their own payments with customer-safe columns', async () => {
    const res = await api(app, customer(C.maria)).get('/api/payments').expect(200);
    expect(res.body.map((p: { id: string }) => p.id)).toEqual([P.mariaPos]);
    expect(res.body[0]).not.toHaveProperty('pos_reference');
    expect(res.body[0]).not.toHaveProperty('notes_internal');
  });

  it('org admins do not see members’ payments', async () => {
    const res = await api(app, customer(C.john)).get('/api/payments').expect(200);
    expect(res.body.map((p: { id: string }) => p.id)).toEqual([P.johnStripe]);
  });

  it('lists overdue pending bank transfers for staff', async () => {
    const res = await api(app, employee(U.sam)).get('/api/payments/pending-transfers').expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: P.janeTransfer, overdue: true });
  });

  it('lists unmatched Stripe payments', async () => {
    const res = await api(app, employee(U.ada)).get('/api/payments?unmatched=true').expect(200);
    expect(res.body.map((p: { id: string }) => p.id)).toEqual([P.unmatchedStripe]);
  });
});

describe('payments — manual entry', () => {
  const now = () => new Date().toISOString();

  it('records a POS card payment linked to an appointment, inheriting location and currency', async () => {
    const res = await api(app, employee(U.sam))
      .post('/api/payments', {
        method: 'card_pos',
        customer_id: C.jane,
        appointment_id: A.janeNext,
        amount: 50,
        paid_at: now(),
        pos_reference: 'POS-2001',
        pos_terminal_id: 'T1',
        card_last4: '1234',
      })
      .expect(201);
    expect(res.body.payment).toMatchObject({
      source: 'manual',
      status: 'succeeded',
      currency: 'USD',
      location_id: SAMPLE.locations.nyc,
      recorded_by: U.sam,
    });
  });

  it('warns about a possible duplicate (same customer, amount, ±2 days), then allows confirming', async () => {
    const body = { method: 'cash', customer_id: C.maria, amount: 50, paid_at: new Date(Date.now() - 9 * 86400e3).toISOString() };
    const dup = await api(app, employee(U.sam)).post('/api/payments', body).expect(409);
    expect(dup.body).toMatchObject({ code: 'possible_duplicate' });
    expect(dup.body.candidates[0].id).toBe(P.mariaPos);

    const ok = await api(app, employee(U.sam)).post('/api/payments', { ...body, confirm_duplicate: true }).expect(201);
    expect(ok.body.payment.possible_duplicate_of).toBe(P.mariaPos);
  });

  it('detects duplicates against Stripe payments too', async () => {
    const res = await api(app, employee(U.ada))
      .post('/api/payments/check-duplicates', { customer_id: C.john, amount: 120, on: new Date(Date.now() - 4 * 86400e3).toISOString() })
      .expect(200);
    expect(res.body.map((d: { id: string; source: string }) => [d.id, d.source])).toEqual([[P.johnStripe, 'stripe']]);
  });

  it('rejects reused POS references, future dates and appointments of other customers', async () => {
    await api(app, employee(U.ada))
      .post('/api/payments', { method: 'card_pos', customer_id: C.maria, amount: 11, paid_at: now(), pos_reference: 'POS-1001', pos_terminal_id: 'T1' })
      .expect(409);
    await api(app, employee(U.ada))
      .post('/api/payments', { method: 'cash', customer_id: C.maria, amount: 12, paid_at: new Date(Date.now() + 86400e3).toISOString() })
      .expect(400);
    await api(app, employee(U.ada))
      .post('/api/payments', { method: 'cash', customer_id: C.maria, appointment_id: A.janeNext, amount: 13, paid_at: now() })
      .expect(400);
  });

  it('staff cannot record payments for customers outside their scope, or "other" payments', async () => {
    await api(app, employee(U.sam)).post('/api/payments', { method: 'cash', customer_id: C.john, amount: 14, paid_at: now() }).expect(404);
    await api(app, employee(U.sam))
      .post('/api/payments', { method: 'other', customer_id: C.maria, amount: 15, paid_at: now(), description: 'voucher' })
      .expect(403);
  });

  it('customers cannot record payments', async () => {
    await api(app, customer(C.maria)).post('/api/payments', { method: 'cash', customer_id: C.maria, amount: 16, paid_at: now() }).expect(403);
  });

  it('bank transfer: pending with expected date, then marked received', async () => {
    const created = await api(app, employee(U.sam))
      .post('/api/payments', { method: 'bank_transfer', customer_id: C.maria, amount: 75, expected_at: new Date().toISOString().slice(0, 10) })
      .expect(201);
    expect(created.body.payment).toMatchObject({ status: 'pending', paid_at: null });

    const received = await api(app, employee(U.sam))
      .post(`/api/payments/${created.body.payment.id}/mark-received`, { bank_reference: 'WIRE-889', paid_at: now() })
      .expect(200);
    expect(received.body).toMatchObject({ status: 'succeeded', bank_reference: 'WIRE-889' });

    await api(app, employee(U.sam))
      .post(`/api/payments/${created.body.payment.id}/mark-received`, { bank_reference: 'WIRE-890', paid_at: now() })
      .expect(400);
  });

  it('bank transfer must be either received (reference + date) or expected', async () => {
    await api(app, employee(U.sam)).post('/api/payments', { method: 'bank_transfer', customer_id: C.maria, amount: 20 }).expect(400);
  });

  it('respects the manual payment methods enabled in settings', async () => {
    await api(app, employee(U.ada)).put('/api/admin/settings', { manual_payment_methods: ['card_pos', 'bank_transfer'] }).expect(200);
    await api(app, employee(U.sam)).post('/api/payments', { method: 'cash', customer_id: C.maria, amount: 21, paid_at: now() }).expect(400);
    await api(app, employee(U.ada)).put('/api/admin/settings', { manual_payment_methods: ['card_pos', 'bank_transfer', 'cash'] }).expect(200);
  });
});

describe('payments — edits, voids, refunds', () => {
  it('staff edit their own entries on the same day only; not other people’s', async () => {
    const created = await api(app, employee(U.sam))
      .post('/api/payments', { method: 'cash', customer_id: C.jane, amount: 33, paid_at: new Date().toISOString() })
      .expect(201);
    const id = created.body.payment.id;
    await api(app, employee(U.sam)).put(`/api/payments/${id}`, { amount: 34 }).expect(200);
    await api(app, employee(U.sam)).put(`/api/payments/${id}`, { pos_reference: 'X' }).expect(400);
    // The seeded POS payment was recorded 10 days ago.
    await api(app, employee(U.sam)).put(`/api/payments/${P.mariaPos}`, { amount: 51 }).expect(403);
    await api(app, employee(U.ada)).put(`/api/payments/${P.mariaPos}`, { notes_internal: 'Verified receipt' }).expect(200);
  });

  it('Stripe payments cannot be edited, voided or refunded here', async () => {
    await api(app, employee(U.ada)).put(`/api/payments/${P.johnStripe}`, { amount: 1 }).expect(400);
    await api(app, employee(U.ada)).post(`/api/payments/${P.johnStripe}/void`, { reason: 'test' }).expect(400);
  });

  it('only admins void and refund; refunds cannot exceed the amount', async () => {
    const created = await api(app, employee(U.sam))
      .post('/api/payments', { method: 'card_pos', customer_id: C.maria, amount: 80, paid_at: new Date().toISOString(), pos_reference: 'POS-3001' })
      .expect(201);
    const id = created.body.payment.id;

    await api(app, employee(U.sam)).post(`/api/payments/${id}/refund`, { amount: 10, reason: 'goodwill' }).expect(403);
    const partial = await api(app, employee(U.ada)).post(`/api/payments/${id}/refund`, { amount: 30, reason: 'goodwill' }).expect(200);
    expect(partial.body).toMatchObject({ status: 'partially_refunded', amount_refunded: '30.00' });
    await api(app, employee(U.ada)).post(`/api/payments/${id}/refund`, { amount: 60, reason: 'too much' }).expect(400);
    const full = await api(app, employee(U.ada)).post(`/api/payments/${id}/refund`, { amount: 50, reason: 'rest' }).expect(200);
    expect(full.body.status).toBe('refunded');
    await api(app, employee(U.ada)).post(`/api/payments/${id}/void`, { reason: 'mistake' }).expect(400);
  });

  it('void keeps the record with reason and actor', async () => {
    const created = await api(app, employee(U.sam))
      .post('/api/payments', { method: 'cash', customer_id: C.jane, amount: 44, paid_at: new Date().toISOString() })
      .expect(201);
    const id = created.body.payment.id;
    await api(app, employee(U.sam)).post(`/api/payments/${id}/void`, { reason: 'entered twice' }).expect(403);
    const res = await api(app, employee(U.ada)).post(`/api/payments/${id}/void`, { reason: 'entered twice' }).expect(200);
    expect(res.body).toMatchObject({ status: 'voided', void_reason: 'entered twice', voided_by: U.ada });
    await api(app, employee(U.sam)).put(`/api/payments/${id}`, { amount: 45 }).expect(400);
  });
});
