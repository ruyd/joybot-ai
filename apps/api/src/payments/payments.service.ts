import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Principal } from '../auth/principal';
import { DbService } from '../db/db.module';
import type {
  CreateManualPayment,
  DuplicateCheck,
  ListPayments,
  UpdateManualPayment,
} from './payments.schemas';

/** Columns customers may see (plan.md §4.4 "Customer visibility"). */
const CUSTOMER_COLUMNS = `id, payment_number, source, customer_id, appointment_id, amount, amount_refunded, currency,
  method, status, card_brand, card_last4, receipt_url, failure_reason, paid_at, expected_at, created_at`;
const EMPLOYEE_COLUMNS = `${CUSTOMER_COLUMNS}, location_id, pos_terminal_id, pos_reference, bank_reference,
  stripe_payment_intent_id, stripe_charge_id, recorded_by, void_reason, voided_by, voided_at,
  possible_duplicate_of, notes_internal, updated_at`;

const DUPLICATE_WINDOW_DAYS = 2;
const FUTURE_SKEW_MS = 5 * 60_000;

export interface DuplicateCandidate {
  id: string;
  payment_number: string;
  source: 'stripe' | 'manual';
  method: string;
  amount: string;
  status: string;
  occurred_at: string;
}

@Injectable()
export class PaymentsService {
  constructor(private readonly db: DbService) {}

  columns(p: Principal): string {
    return p.type === 'employee' ? EMPLOYEE_COLUMNS : CUSTOMER_COLUMNS;
  }

  list(p: Principal, f: ListPayments) {
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      args.push(v);
      where.push(sql.replace('?', `$${args.length}`));
    };
    if (f.customer_id) add('customer_id = ?', f.customer_id);
    if (f.status) add('status = ?', f.status);
    if (f.source) add('source = ?', f.source);
    if (f.method) add('method = ?', f.method);
    if (f.unmatched === 'true') where.push('customer_id IS NULL');
    args.push(f.limit);
    return this.db.as(p, async (db) =>
      (
        await db.query(
          `SELECT ${this.columns(p)} FROM core.payments
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY coalesce(paid_at, created_at) DESC LIMIT $${args.length}`,
          args,
        )
      ).rows,
    );
  }

  pendingTransfers(p: Principal) {
    return this.db.as(p, async (db) =>
      (
        await db.query(
          `SELECT ${EMPLOYEE_COLUMNS}, overdue FROM core.v_pending_bank_transfers
            ORDER BY overdue DESC, coalesce(expected_at, created_at::date)`,
        )
      ).rows,
    );
  }

  async get(p: Principal, id: string) {
    const row = await this.db.as(p, async (db) =>
      (await db.query(`SELECT ${this.columns(p)} FROM core.payments WHERE id = $1`, [id])).rows[0],
    );
    if (!row) throw new NotFoundException();
    return row;
  }

  checkDuplicates(p: Principal, q: DuplicateCheck) {
    return this.db.as(p, (db) => this.findDuplicates(db, q.customer_id, q.amount, q.on ?? new Date().toISOString()));
  }

  /** Records a manual payment (POS / bank transfer / cash / other) with validation and duplicate detection. */
  async createManual(p: Principal, input: CreateManualPayment) {
    if (input.method === 'other' && p.role !== 'admin') {
      throw new ForbiddenException('Only admins can record "other" payments');
    }

    return this.db.as(p, async (db) => {
      const settings = (
        await db.query<{ default_currency: string; manual_payment_methods: string[] }>(
          'SELECT default_currency, manual_payment_methods FROM core.settings WHERE id = 1',
        )
      ).rows[0];
      if (!settings.manual_payment_methods.includes(input.method)) {
        throw new BadRequestException(`Manual payment method "${input.method}" is disabled in settings`);
      }

      // The customer must be visible to this employee (RLS); otherwise it "does not exist".
      const customer = (await db.query('SELECT id FROM core.customers WHERE id = $1', [input.customer_id])).rows[0];
      if (!customer) throw new NotFoundException('Customer not found');

      const warnings: string[] = [];
      let locationId = input.location_id ?? null;
      let currency = input.currency ?? null;

      if (input.appointment_id) {
        const appt = (
          await db.query<{ customer_id: string; currency: string; location_id: string; status: string }>(
            'SELECT customer_id, currency, location_id, status FROM core.appointments WHERE id = $1',
            [input.appointment_id],
          )
        ).rows[0];
        if (!appt || appt.customer_id !== input.customer_id) {
          throw new BadRequestException('Appointment does not belong to this customer');
        }
        if (appt.status === 'cancelled') warnings.push('Appointment is cancelled');
        locationId ??= appt.location_id;
        if (currency && currency !== appt.currency) {
          warnings.push(`Currency ${currency} differs from the appointment currency ${appt.currency}`);
        }
        currency ??= appt.currency;
      }
      currency ??= settings.default_currency;

      const paidAt = 'paid_at' in input ? input.paid_at : undefined;
      if (paidAt && new Date(paidAt).getTime() > Date.now() + FUTURE_SKEW_MS) {
        throw new BadRequestException('paid_at cannot be in the future');
      }

      const on = paidAt ?? (input.method === 'bank_transfer' ? input.expected_at : undefined) ?? new Date().toISOString();
      const duplicates = await this.findDuplicates(db, input.customer_id, input.amount, on);
      if (duplicates.length > 0 && !input.confirm_duplicate) {
        throw new ConflictException({
          statusCode: 409,
          code: 'possible_duplicate',
          message: 'A payment with the same amount for this customer already exists around this date',
          candidates: duplicates,
        });
      }

      const notes = [
        input.notes_internal,
        input.method === 'cash' && input.receipt_number ? `Cash receipt #${input.receipt_number}` : undefined,
        input.method === 'other' ? input.description : undefined,
      ]
        .filter(Boolean)
        .join('\n');

      const isPendingTransfer = input.method === 'bank_transfer' && !input.bank_reference;
      const row = {
        source: 'manual',
        customer_id: input.customer_id,
        appointment_id: input.appointment_id ?? null,
        location_id: locationId,
        amount: input.amount,
        currency,
        method: input.method,
        status: isPendingTransfer ? 'pending' : 'succeeded',
        paid_at: paidAt ?? null,
        pos_reference: input.method === 'card_pos' ? input.pos_reference : null,
        pos_terminal_id: input.method === 'card_pos' ? (input.pos_terminal_id ?? null) : null,
        card_brand: input.method === 'card_pos' ? (input.card_brand ?? null) : null,
        card_last4: input.method === 'card_pos' ? (input.card_last4 ?? null) : null,
        bank_reference: input.method === 'bank_transfer' ? (input.bank_reference ?? null) : null,
        expected_at: input.method === 'bank_transfer' ? (input.expected_at ?? null) : null,
        recorded_by: p.id,
        possible_duplicate_of: duplicates[0]?.id ?? null,
        notes_internal: notes || null,
      };
      const cols = Object.keys(row);
      const created = (
        await db.query(
          `INSERT INTO core.payments (${cols.join(', ')})
           VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
           RETURNING ${EMPLOYEE_COLUMNS}`,
          Object.values(row),
        )
      ).rows[0];
      return { payment: created, warnings };
    });
  }

  /** Staff: own manual entries, same day (location time zone). Admin: any manual payment. */
  async updateManual(p: Principal, id: string, input: UpdateManualPayment) {
    return this.db.as(p, async (db) => {
      const current = await this.loadForChange(db, p, id);
      if (input.appointment_id) {
        const appt = (await db.query('SELECT customer_id FROM core.appointments WHERE id = $1', [input.appointment_id])).rows[0];
        if (!appt || appt.customer_id !== current.customer_id) {
          throw new BadRequestException('Appointment does not belong to this customer');
        }
      }
      if (input.paid_at && new Date(input.paid_at).getTime() > Date.now() + FUTURE_SKEW_MS) {
        throw new BadRequestException('paid_at cannot be in the future');
      }
      if (input.amount !== undefined && input.amount < Number(current.amount_refunded)) {
        throw new BadRequestException('amount cannot be lower than the refunded amount');
      }
      const methodFields: Record<string, string[]> = {
        card_pos: ['pos_reference', 'pos_terminal_id', 'card_brand', 'card_last4'],
        bank_transfer: ['bank_reference', 'expected_at'],
      };
      for (const key of ['pos_reference', 'pos_terminal_id', 'card_brand', 'card_last4', 'bank_reference', 'expected_at']) {
        if (key in input && !(methodFields[current.method] ?? []).includes(key)) {
          throw new BadRequestException(`${key} does not apply to ${current.method} payments`);
        }
      }

      const entries = Object.entries(input);
      if (entries.length === 0) return current;
      const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
      const res = await db.query(`UPDATE core.payments SET ${sets} WHERE id = $1 RETURNING ${EMPLOYEE_COLUMNS}`, [
        id,
        ...entries.map(([, v]) => v),
      ]);
      if (res.rowCount === 0) throw new ForbiddenException('Not allowed to edit this payment');
      return res.rows[0];
    });
  }

  async markReceived(p: Principal, id: string, bankReference: string, paidAt: string) {
    if (new Date(paidAt).getTime() > Date.now() + FUTURE_SKEW_MS) {
      throw new BadRequestException('paid_at cannot be in the future');
    }
    return this.db.as(p, async (db) => {
      const current = await this.loadVisible(db, p, id);
      if (current.source !== 'manual' || current.method !== 'bank_transfer' || current.status !== 'pending') {
        throw new BadRequestException('Only pending manual bank transfers can be marked as received');
      }
      const res = await db.query(
        `UPDATE core.payments SET status = 'succeeded', bank_reference = $2, paid_at = $3
          WHERE id = $1 RETURNING ${EMPLOYEE_COLUMNS}`,
        [id, bankReference, paidAt],
      );
      if (res.rowCount === 0) throw new ForbiddenException('Not allowed to update this payment');
      return res.rows[0];
    });
  }

  async voidPayment(p: Principal, id: string, reason: string) {
    if (!p.access.can('void', 'payments')) throw new ForbiddenException('Only admins can void payments');
    return this.db.as(p, async (db) => {
      const current = await this.loadVisible(db, p, id);
      if (current.source !== 'manual') throw new BadRequestException('Stripe payments are refunded in Stripe');
      if (current.status === 'voided') throw new BadRequestException('Payment is already voided');
      if (Number(current.amount_refunded) > 0) throw new BadRequestException('Refunded payments cannot be voided');
      const res = await db.query(
        `UPDATE core.payments SET status = 'voided', void_reason = $2, voided_by = $3, voided_at = now()
          WHERE id = $1 RETURNING ${EMPLOYEE_COLUMNS}`,
        [id, reason, p.id],
      );
      if (res.rowCount === 0) throw new ForbiddenException();
      return res.rows[0];
    });
  }

  async refund(p: Principal, id: string, amount: number, reason: string) {
    if (!p.access.can('refund', 'payments')) throw new ForbiddenException('Only admins can refund payments');
    return this.db.as(p, async (db) => {
      const current = await this.loadVisible(db, p, id);
      if (current.source !== 'manual') throw new BadRequestException('Stripe payments are refunded in Stripe');
      if (!['succeeded', 'partially_refunded'].includes(current.status)) {
        throw new BadRequestException(`Cannot refund a ${current.status} payment`);
      }
      const refunded = Math.round((Number(current.amount_refunded) + amount) * 100) / 100;
      if (refunded > Number(current.amount)) {
        throw new BadRequestException('Refund exceeds the remaining paid amount');
      }
      const status = refunded === Number(current.amount) ? 'refunded' : 'partially_refunded';
      const note = `Refund ${amount.toFixed(2)} ${current.currency} by ${p.id} on ${new Date().toISOString()}: ${reason}`;
      const res = await db.query(
        `UPDATE core.payments
            SET amount_refunded = $2, status = $3,
                notes_internal = concat_ws(E'\\n', notes_internal, $4::text)
          WHERE id = $1 RETURNING ${EMPLOYEE_COLUMNS}`,
        [id, refunded, status, note],
      );
      if (res.rowCount === 0) throw new ForbiddenException();
      return res.rows[0];
    });
  }

  /** Links an unmatched Stripe payment to a customer (and optionally an appointment). */
  async assignStripePayment(p: Principal, id: string, customerId: string, appointmentId?: string) {
    return this.db.as(p, async (db) => {
      const current = await this.loadVisible(db, p, id);
      if (current.source !== 'stripe' || current.customer_id) {
        throw new BadRequestException('Only unmatched Stripe payments can be assigned');
      }
      const customer = (await db.query('SELECT id, preferred_location_id FROM core.customers WHERE id = $1', [customerId])).rows[0];
      if (!customer) throw new NotFoundException('Customer not found');
      let locationId = current.location_id ?? customer.preferred_location_id;
      if (appointmentId) {
        const appt = (await db.query('SELECT customer_id, location_id FROM core.appointments WHERE id = $1', [appointmentId])).rows[0];
        if (!appt || appt.customer_id !== customerId) throw new BadRequestException('Appointment does not belong to this customer');
        locationId = appt.location_id;
      }
      const res = await db.query(
        `UPDATE core.payments SET customer_id = $2, appointment_id = $3, location_id = coalesce(location_id, $4)
          WHERE id = $1 AND customer_id IS NULL RETURNING ${EMPLOYEE_COLUMNS}`,
        [id, customerId, appointmentId ?? null, locationId],
      );
      if (res.rowCount === 0) throw new ForbiddenException('Not allowed to assign this payment');
      return res.rows[0];
    });
  }

  // ---------------------------------------------------------------------------------------

  private async findDuplicates(db: PoolClient, customerId: string, amount: number, on: string): Promise<DuplicateCandidate[]> {
    const res = await db.query<DuplicateCandidate>(
      `SELECT id, payment_number, source, method, amount, status,
              coalesce(paid_at, expected_at::timestamptz, created_at) AS occurred_at
         FROM core.payments
        WHERE customer_id = $1 AND amount = $2
          AND status NOT IN ('voided', 'failed', 'canceled')
          AND coalesce(paid_at, expected_at::timestamptz, created_at)
              BETWEEN $3::timestamptz - make_interval(days => $4) AND $3::timestamptz + make_interval(days => $4)
        ORDER BY abs(extract(epoch FROM coalesce(paid_at, expected_at::timestamptz, created_at) - $3::timestamptz))`,
      [customerId, amount, on, DUPLICATE_WINDOW_DAYS],
    );
    return res.rows;
  }

  private async loadVisible(db: PoolClient, _p: Principal, id: string) {
    const row = (await db.query(`SELECT ${EMPLOYEE_COLUMNS} FROM core.payments WHERE id = $1`, [id])).rows[0];
    if (!row) throw new NotFoundException();
    return row;
  }

  /** Manual payment the principal may edit: admin any; staff only their own, recorded today. */
  private async loadForChange(db: PoolClient, p: Principal, id: string) {
    const row = (
      await db.query(
        `SELECT ${EMPLOYEE_COLUMNS.split(',').map((c) => `p.${c.trim()}`).join(', ')},
                (p.created_at AT TIME ZONE tz.zone)::date = (now() AT TIME ZONE tz.zone)::date AS recorded_today
           FROM core.payments p
           LEFT JOIN core.locations l ON l.id = p.location_id
           CROSS JOIN LATERAL (
             SELECT coalesce(l.time_zone, (SELECT default_time_zone FROM core.settings WHERE id = 1)) AS zone) tz
          WHERE p.id = $1`,
        [id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException();
    if (row.source !== 'manual') throw new BadRequestException('Stripe payments cannot be edited');
    if (row.status === 'voided') throw new BadRequestException('Voided payments cannot be edited');
    if (p.role !== 'admin') {
      if (row.recorded_by !== p.id) throw new ForbiddenException('You can only edit payments you recorded');
      if (!row.recorded_today) throw new ForbiddenException('Payments can only be edited on the day they were recorded');
    }
    delete row.recorded_today;
    return row;
  }
}
