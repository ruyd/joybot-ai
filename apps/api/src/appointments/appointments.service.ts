import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Principal } from '../auth/principal';
import { insertStatement, setClause } from '../common/sql';
import { DbService } from '../db/db.module';

const isoDateTime = z.string().datetime({ offset: true });
const money = z.coerce.number().min(0).multipleOf(0.01);

export const createAppointmentSchema = z
  .object({
    customer_id: z.string().uuid(),
    service_id: z.string().uuid(),
    location_id: z.string().uuid(),
    employee_id: z.string().uuid().nullable().optional(),
    scheduled_start: isoDateTime,
    scheduled_end: isoDateTime.optional(), // defaults to start + service duration
    price_quoted: money.optional(), // defaults to the service price
    notes_customer: z.string().max(2000).optional(),
    notes_internal: z.string().max(5000).optional(),
    /** Set after the API reported an employee double-booking and the user confirmed. */
    confirm_overlap: z.boolean().optional(),
  })
  .strict();

export const updateAppointmentSchema = z
  .object({
    service_id: z.string().uuid(),
    location_id: z.string().uuid(),
    employee_id: z.string().uuid().nullable(),
    scheduled_start: isoDateTime,
    scheduled_end: isoDateTime,
    status: z.enum(['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show']),
    price_quoted: money,
    notes_customer: z.string().max(2000).nullable(),
    notes_internal: z.string().max(5000).nullable(),
    confirm_overlap: z.boolean(),
  })
  .partial()
  .strict();

export const listAppointmentsSchema = z
  .object({
    customer_id: z.string().uuid().optional(),
    organization_id: z.string().uuid().optional(),
    employee_id: z.string().uuid().optional(),
    location_id: z.string().uuid().optional(),
    status: z.enum(['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show']).optional(),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    mine: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export type CreateAppointment = z.infer<typeof createAppointmentSchema>;
export type UpdateAppointment = z.infer<typeof updateAppointmentSchema>;
export type ListAppointments = z.infer<typeof listAppointmentsSchema>;

/** Allowed status changes. Terminal statuses can only be reopened by admins. */
const TRANSITIONS: Record<string, string[]> = {
  scheduled: ['confirmed', 'completed', 'cancelled', 'no_show'],
  confirmed: ['scheduled', 'completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: [],
  no_show: [],
};

const CUSTOMER_COLUMNS = `a.id, a.appointment_number, a.customer_id, a.service_id, s.name AS service_name,
  a.location_id, l.name AS location_name, l.time_zone, a.employee_id,
  nullif(concat_ws(' ', st.first_name, st.last_name), '') AS employee_name,
  a.scheduled_start, a.scheduled_end,
  to_char(a.scheduled_start AT TIME ZONE l.time_zone, 'YYYY-MM-DD"T"HH24:MI') AS local_start,
  a.status, a.price_quoted, a.currency, a.notes_customer, a.created_at, a.updated_at`;
// The customer subquery runs under RLS like the rest: a customer the employee cannot read comes back null.
const EMPLOYEE_COLUMNS = `${CUSTOMER_COLUMNS}, a.created_by,
  (SELECT nullif(concat_ws(' ', c.first_name, c.last_name), '') FROM core.customers c WHERE c.id = a.customer_id) AS customer_name,
  (SELECT c.customer_number FROM core.customers c WHERE c.id = a.customer_id) AS customer_number`;
const FROM = `core.appointments a
  JOIN core.services s ON s.id = a.service_id
  JOIN core.locations l ON l.id = a.location_id
  LEFT JOIN core.v_staff_public st ON st.id = a.employee_id`;

@Injectable()
export class AppointmentsService {
  constructor(private readonly db: DbService) {}

  private columns(p: Principal) {
    if (p.type === 'customer') return CUSTOMER_COLUMNS;
    return p.access.can('read', 'notes_internal') ? `${EMPLOYEE_COLUMNS}, a.notes_internal` : EMPLOYEE_COLUMNS;
  }

  list(p: Principal, f: ListAppointments) {
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      args.push(v);
      where.push(sql.replaceAll('?', `$${args.length}`));
    };
    if (f.customer_id) add('a.customer_id = ?', f.customer_id);
    if (f.organization_id) add('a.customer_id IN (SELECT id FROM core.customers WHERE organization_id = ?)', f.organization_id);
    if (f.employee_id) add('a.employee_id = ?', f.employee_id);
    if (f.mine === 'true' && p.type === 'employee') add('a.employee_id = ?', p.id);
    if (f.location_id) add('a.location_id = ?', f.location_id);
    if (f.status) add('a.status = ?', f.status);
    if (f.from) add('a.scheduled_end >= ?', f.from);
    if (f.to) add('a.scheduled_start < ?', f.to);
    args.push(f.limit);
    return this.db.as(p, async (db) =>
      (
        await db.query(
          `SELECT ${this.columns(p)} FROM ${FROM}
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY a.scheduled_start LIMIT $${args.length}`,
          args,
        )
      ).rows,
    );
  }

  async get(p: Principal, id: string) {
    const row = await this.db.as(p, (db) => this.load(db, p, id));
    if (!row) throw new NotFoundException();
    return row;
  }

  async create(p: Principal, input: CreateAppointment) {
    return this.db.as(p, async (db) => {
      const customer = (await db.query('SELECT id, status FROM core.customers WHERE id = $1', [input.customer_id])).rows[0];
      if (!customer) throw new NotFoundException('Customer not found');
      if (customer.status !== 'active') throw new BadRequestException(`Customer is ${customer.status}`);

      const service = await this.activeService(db, input.service_id);
      await this.activeLocation(db, input.location_id);
      if (input.employee_id) await this.employeeWorksAt(db, input.employee_id, input.location_id);

      const start = new Date(input.scheduled_start);
      const end = input.scheduled_end
        ? new Date(input.scheduled_end)
        : service.duration_minutes
          ? new Date(start.getTime() + service.duration_minutes * 60_000)
          : undefined;
      if (!end) throw new BadRequestException('scheduled_end is required for services without a duration');
      if (end <= start) throw new BadRequestException('scheduled_end must be after scheduled_start');

      if (input.employee_id && !input.confirm_overlap) {
        await this.assertNoConflicts(db, input.employee_id, start, end);
      }

      const row: Record<string, unknown> = {
        customer_id: input.customer_id,
        service_id: input.service_id,
        location_id: input.location_id,
        employee_id: input.employee_id ?? null,
        scheduled_start: start.toISOString(),
        scheduled_end: end.toISOString(),
        price_quoted: input.price_quoted ?? service.price,
        currency: service.currency,
        notes_customer: input.notes_customer ?? null,
        created_by: p.id,
      };
      if (input.notes_internal && p.access.can('update', 'notes_internal')) row.notes_internal = input.notes_internal;
      const q = insertStatement('core.appointments', row, 'id');
      const { id } = (await db.query<{ id: string }>(q.text, q.values)).rows[0];
      return this.load(db, p, id);
    });
  }

  async update(p: Principal, id: string, input: UpdateAppointment) {
    return this.db.as(p, async (db) => {
      const current = await this.load(db, p, id);
      if (!current) throw new NotFoundException();
      const { confirm_overlap, ...changes } = input;

      if (changes.status && changes.status !== current.status) {
        const allowed = TRANSITIONS[current.status] ?? [];
        if (!allowed.includes(changes.status) && p.role !== 'admin') {
          throw new BadRequestException(`Cannot change status from ${current.status} to ${changes.status}`);
        }
        const startsAt = new Date(changes.scheduled_start ?? current.scheduled_start);
        if ((changes.status === 'completed' || changes.status === 'no_show') && startsAt.getTime() > Date.now()) {
          throw new BadRequestException(`A future appointment cannot be marked ${changes.status}`);
        }
      } else if (['completed', 'cancelled', 'no_show'].includes(current.status) && p.role !== 'admin') {
        throw new ForbiddenException(`Only admins can change a ${current.status} appointment`);
      }

      if (changes.service_id) await this.activeService(db, changes.service_id);
      const locationId = changes.location_id ?? current.location_id;
      if (changes.location_id) await this.activeLocation(db, changes.location_id);
      const employeeId = changes.employee_id === undefined ? current.employee_id : changes.employee_id;
      if (employeeId && (changes.employee_id !== undefined || changes.location_id)) {
        await this.employeeWorksAt(db, employeeId, locationId);
      }

      const start = new Date(changes.scheduled_start ?? current.scheduled_start);
      const end = new Date(changes.scheduled_end ?? current.scheduled_end);
      if (end <= start) throw new BadRequestException('scheduled_end must be after scheduled_start');
      const timeOrEmployeeChanged =
        changes.scheduled_start !== undefined || changes.scheduled_end !== undefined || changes.employee_id !== undefined;
      const active = (changes.status ?? current.status) === 'scheduled' || (changes.status ?? current.status) === 'confirmed';
      if (employeeId && timeOrEmployeeChanged && active && !confirm_overlap) {
        await this.assertNoConflicts(db, employeeId, start, end, id);
      }

      const fields: Record<string, unknown> = { ...changes };
      if (fields.notes_internal !== undefined && !p.access.can('update', 'notes_internal')) delete fields.notes_internal;
      const set = setClause(fields);
      if (!set.empty) {
        const res = await db.query(`UPDATE core.appointments SET ${set.sql} WHERE id = $1`, [id, ...set.values]);
        if (res.rowCount === 0) throw new ForbiddenException('Not allowed to update this appointment');
      }
      return this.load(db, p, id);
    });
  }

  // -----------------------------------------------------------------------------------------

  private async load(db: PoolClient, p: Principal, id: string) {
    return (await db.query(`SELECT ${this.columns(p)} FROM ${FROM} WHERE a.id = $1`, [id])).rows[0];
  }

  private async activeService(db: PoolClient, id: string) {
    const s = (
      await db.query<{ price: string; currency: string; duration_minutes: number | null; active: boolean }>(
        'SELECT price, currency, duration_minutes, active FROM core.services WHERE id = $1',
        [id],
      )
    ).rows[0];
    if (!s) throw new BadRequestException('Service not found');
    if (!s.active) throw new BadRequestException('Service is inactive');
    return s;
  }

  private async activeLocation(db: PoolClient, id: string) {
    const l = (await db.query<{ active: boolean }>('SELECT active FROM core.locations WHERE id = $1', [id])).rows[0];
    if (!l) throw new BadRequestException('Location not found');
    if (!l.active) throw new BadRequestException('Location is inactive');
  }

  private async employeeWorksAt(db: PoolClient, employeeId: string, locationId: string) {
    const ok = (
      await db.query(
        `SELECT 1 FROM core.v_staff_public s
          WHERE s.id = $1 AND EXISTS (SELECT 1 FROM core.user_locations ul WHERE ul.user_id = $1 AND ul.location_id = $2)`,
        [employeeId, locationId],
      )
    ).rowCount;
    if (!ok) throw new BadRequestException('Employee is inactive or does not work at this location');
  }

  private async assertNoConflicts(db: PoolClient, employeeId: string, start: Date, end: Date, excludeId?: string) {
    const conflicts = (
      await db.query('SELECT * FROM core.employee_conflicts($1, $2, $3, $4)', [
        employeeId,
        start.toISOString(),
        end.toISOString(),
        excludeId ?? null,
      ])
    ).rows;
    if (conflicts.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        code: 'employee_double_booked',
        message: 'The employee already has an appointment at this time',
        conflicts,
      });
    }
  }
}
