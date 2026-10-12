import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseError, type Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import type { Principal } from '../auth/principal';
import { APP_POOL, DbService } from '../db/db.module';
import { MessagingService } from '../messaging/messaging.service';

/** The lengths a sales call can have (also checked in SQL). */
export const SALES_CALL_DURATIONS = [15, 20, 30, 45, 60, 90] as const;

const isoDateTime = z.string().datetime({ offset: true });
/** 'HH:MM' on a quarter hour. */
const quarterHour = z.string().regex(/^([01]\d|2[0-3]):(00|15|30|45)$/, 'Use a time on the quarter hour (HH:MM)');

export const slotsQuerySchema = z
  .object({ from: isoDateTime, to: isoDateTime })
  .strict()
  .refine((q) => Date.parse(q.to) > Date.parse(q.from) && Date.parse(q.to) - Date.parse(q.from) <= 45 * 86_400_000, {
    message: 'to must be after from, at most 45 days later',
  });

export const bookSalesCallSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(254),
    start: isoDateTime,
    /** The visitor's time zone (IANA), for the confirmation. */
    time_zone: z.string().max(64).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

export const salesCallSettingsSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    description: z
      .string()
      .trim()
      .max(1000)
      .nullable()
      .transform((v) => v || null),
    duration_minutes: z.number().int().refine((d) => (SALES_CALL_DURATIONS as readonly number[]).includes(d), `Choose ${SALES_CALL_DURATIONS.join(', ')} minutes`),
    meeting_url: z
      .string()
      .trim()
      .max(500)
      .regex(/^https:\/\/\S+$/, 'Use an https:// link')
      .nullable()
      .or(z.literal('').transform(() => null)),
    /** General availability: weekly intervals in the business time zone (weekday 0 = Sunday), replacing the current ones. */
    hours: z
      .array(
        z
          .object({ weekday: z.number().int().min(0).max(6), starts: quarterHour, ends: quarterHour.or(z.literal('24:00')) })
          .strict()
          .refine((h) => h.ends > h.starts, 'Each interval must end after it starts'),
      )
      .max(28)
      .superRefine((hours, ctx) => {
        for (const a of hours)
          for (const b of hours)
            if (a !== b && a.weekday === b.weekday && a.starts < b.ends && b.starts < a.ends) {
              ctx.addIssue({ code: 'custom', message: 'Intervals on the same day overlap' });
              return;
            }
      }),
    /** The staff who take calls, replacing the current ones (none: unassigned, one call at a time). */
    host_ids: z.array(z.string().uuid()).max(50),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

export const OUTCOMES = ['follow_up', 'conversion', 'potential', 'do_not_call'] as const;
export const outcomeSchema = z
  .object({ outcome: z.enum(OUTCOMES), notes: z.string().trim().max(2000).optional() })
  .strict();
export type Outcome = z.infer<typeof outcomeSchema>;

export const setStatusSchema = z.object({ status: z.enum(['confirmed', 'completed', 'no_show']) }).strict();
export type SetStatus = z.infer<typeof setStatusSchema>;

export const assignSchema = z.object({ user_id: z.string().uuid().nullable() }).strict();
export type Assign = z.infer<typeof assignSchema>;

export const rescheduleSchema = z
  .object({
    start: isoDateTime,
    /** Email the visitor the new time (default true). */
    notify: z.boolean().optional(),
  })
  .strict();

export const listSalesCallsSchema = z
  .object({
    /** Upcoming (soonest first) or past (latest first). */
    when: z.enum(['upcoming', 'past']).default('upcoming'),
    /** Matches name, email or notes. */
    q: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type ListSalesCalls = z.infer<typeof listSalesCallsSchema>;
export type SlotsQuery = z.infer<typeof slotsQuerySchema>;
export type BookSalesCall = z.infer<typeof bookSalesCallSchema>;
export type SalesCallSettingsInput = z.infer<typeof salesCallSettingsSchema>;
export type Reschedule = z.infer<typeof rescheduleSchema>;

export interface SalesCall {
  id: string;
  name: string;
  email: string;
  starts_at: string;
  ends_at: string;
  time_zone: string | null;
  notes: string | null;
  status: 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
  created_at: string;
  assigned_to: string | null;
  assigned_to_name: string | null;
  appointment_number: string;
  outcome: (typeof OUTCOMES)[number] | null;
  outcome_notes: string | null;
  outcome_at: string | null;
}

/** What the booking page shows. */
export interface SalesCallEvent {
  title: string;
  description: string | null;
  duration_minutes: number;
  has_meeting_url: boolean;
}

// Sales calls are appointments of the 'sales_call' type, read under RLS with the visitor's details.
const SALES = `(SELECT a.id, a.appointment_number, a.contact_name AS name, a.contact_email::text AS email,
    a.scheduled_start AS starts_at, a.scheduled_end AS ends_at, a.contact_time_zone AS time_zone, a.notes_customer AS notes,
    a.status, a.created_at, a.employee_id AS assigned_to,
    a.outcome, a.outcome_notes, a.outcome_at
  FROM core.appointments a JOIN core.appointment_types t ON t.id = a.type_id AND t.key = 'sales_call') c`;
// The host's name through core.v_staff_public (null once they are inactive).
const COLUMNS = `c.*, (SELECT nullif(concat_ws(' ', s.first_name, s.last_name), '') FROM core.v_staff_public s WHERE s.id = c.assigned_to) AS assigned_to_name`;
const SETTINGS_COLUMNS = 'title, description, duration_minutes, meeting_url, updated_at';

/**
 * Sales calls booked from the public site (/book-a-call). Visitors have no principal: they see the
 * event and open times and book only through the authz functions. Staff who may read the website
 * list the calls and the setup; those who may update it change the setup, cancel and reschedule.
 */
@Injectable()
export class SalesCallsService {
  private readonly logger = new Logger('SalesCalls');

  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly db: DbService,
    private readonly messaging: MessagingService,
  ) {}

  /** The event and its open start times in a range. */
  async slots(q: SlotsQuery) {
    const [event, slots] = await Promise.all([
      this.pool.query<SalesCallEvent>('SELECT * FROM authz.sales_call_event()'),
      this.pool.query<{ t: Date }>('SELECT t FROM authz.sales_call_slots($1, $2) t', [q.from, q.to]),
    ]);
    return { event: event.rows[0], slots: slots.rows.map((r) => r.t.toISOString()) };
  }

  async book(input: BookSalesCall) {
    let id: string;
    try {
      id = (
        await this.pool.query<{ id: string }>('SELECT authz.book_sales_call($1, $2, $3, $4, $5) AS id', [
          input.name,
          input.email,
          input.start,
          input.time_zone ?? null,
          input.notes ?? null,
        ])
      ).rows[0].id;
    } catch (err) {
      throw this.bookingError(err);
    }
    const call = await this.email(id, 'booked');
    const event = (await this.pool.query<SalesCallEvent>('SELECT * FROM authz.sales_call_event()')).rows[0];
    return { id, event, starts_at: call?.starts_at.toISOString() ?? input.start, ends_at: call?.ends_at.toISOString() };
  }

  /** A page of calls with the total, optionally searched by name, email or notes. */
  list(p: Principal, f: ListSalesCalls): Promise<{ items: SalesCall[]; total: number }> {
    const upcoming = f.when === 'upcoming';
    // Upcoming: not over and not marked completed or a no-show (cancelled ones show until their time).
    const where = [upcoming ? `c.ends_at > now() AND c.status NOT IN ('completed', 'no_show')` : `(c.ends_at <= now() OR c.status IN ('completed', 'no_show'))`];
    const args: unknown[] = [];
    if (f.q) {
      args.push(`%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where.push(`(c.name ILIKE $1 OR c.email ILIKE $1 OR c.notes ILIKE $1 OR c.outcome_notes ILIKE $1)`);
    }
    return this.db.as(p, async (db) => {
      const [rows, count] = await Promise.all([
        db.query<SalesCall>(
          `SELECT ${COLUMNS} FROM ${SALES} WHERE ${where.join(' AND ')}
            ORDER BY c.starts_at ${upcoming ? 'ASC' : 'DESC'}, c.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
          [...args, f.limit, f.offset],
        ),
        db.query<{ total: number }>(`SELECT count(*)::int AS total FROM ${SALES} WHERE ${where.join(' AND ')}`, args),
      ]);
      return { items: rows.rows, total: count.rows[0].total };
    });
  }

  cancel(p: Principal, id: string): Promise<SalesCall> {
    return this.db.as(p, async (db) => {
      const res = await db.query(
        `UPDATE core.appointments SET status = 'cancelled'
          WHERE id = $1 AND status IN ('scheduled', 'confirmed') AND type_id = (SELECT id FROM core.appointment_types WHERE key = 'sales_call')`,
        [id],
      );
      if (!res.rowCount) throw new NotFoundException('No booked call with that id');
      return this.load(db, id);
    });
  }

  /** Moves a booked call to another open time (same length); emails the visitor unless told not to. */
  async reschedule(p: Principal, id: string, input: Reschedule): Promise<SalesCall> {
    const row = await this.db
      .as(p, async (db) => {
        const moved = (await db.query<{ ok: boolean }>('SELECT authz.reschedule_sales_call($1, $2) AS ok', [id, input.start])).rows[0].ok;
        if (!moved) throw new NotFoundException('No booked call with that id');
        return this.load(db, id);
      })
      .catch((err) => {
        throw this.bookingError(err);
      });
    if (input.notify !== false) await this.email(id, 'rescheduled');
    return row;
  }

  /** The setup with its general hours, hosts, and the staff who could host. */
  getSettings(p: Principal) {
    return this.db.as(p, (db) => this.loadSettings(db));
  }

  updateSettings(p: Principal, input: SalesCallSettingsInput) {
    const { hours, host_ids, ...fields } = input;
    const cols = Object.keys(fields) as (keyof typeof fields)[];
    return this.db.as(p, async (db) => {
      if (cols.length) {
        const res = await db.query(`UPDATE core.sales_call_settings SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = 1`, cols.map((c) => fields[c]));
        if (!res.rowCount) throw new ForbiddenException('Not allowed to change the booking page');
      }
      if (hours) {
        await db.query('DELETE FROM core.sales_call_hours');
        if (hours.length) {
          await db.query(
            `INSERT INTO core.sales_call_hours (weekday, starts, ends)
             SELECT * FROM unnest($1::smallint[], $2::time[], $3::time[])`,
            [hours.map((h) => h.weekday), hours.map((h) => h.starts), hours.map((h) => h.ends)],
          );
        }
      }
      if (host_ids) {
        const active = (await db.query<{ id: string }>('SELECT id FROM core.v_staff_public WHERE id = ANY($1::uuid[])', [host_ids])).rows.map((r) => r.id);
        if (active.length !== new Set(host_ids).size) throw new BadRequestException('Hosts must be active staff');
        await db.query('DELETE FROM core.sales_call_hosts WHERE NOT (user_id = ANY($1::uuid[]))', [host_ids]);
        await db.query('INSERT INTO core.sales_call_hosts (user_id) SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING', [host_ids]);
      }
      return this.loadSettings(db);
    });
  }

  /** Hands a booked call to an active employee who is free then, or unassigns it (null). */
  async assign(p: Principal, id: string, input: Assign): Promise<SalesCall> {
    return this.db.as(p, async (db) => {
      const ok = (await db.query<{ ok: boolean }>('SELECT authz.assign_sales_call($1, $2) AS ok', [id, input.user_id])).rows[0].ok;
      if (!ok) throw new NotFoundException('No booked call with that id');
      return this.load(db, id);
    });
  }

  /** Logs how a call went (follow up, conversion, potential, do not call) with notes; a call that started is then completed. */
  async outcome(p: Principal, id: string, input: Outcome): Promise<SalesCall> {
    return this.db.as(p, async (db) => {
      const ok = (await db.query<{ ok: boolean }>('SELECT authz.log_sales_call_outcome($1, $2, $3) AS ok', [id, input.outcome, input.notes ?? null])).rows[0].ok;
      if (!ok) throw new NotFoundException('No sales call with that id (or it was cancelled)');
      return this.load(db, id);
    });
  }

  /** One call (to open it from the calendar or Home). */
  get(p: Principal, id: string): Promise<SalesCall> {
    return this.db.as(p, (db) => this.load(db, id));
  }

  /** Marks a call completed or a no-show (it leaves the upcoming list), or confirmed again. */
  async setStatus(p: Principal, id: string, input: SetStatus): Promise<SalesCall> {
    return this.db.as(p, async (db) => {
      const ok = (await db.query<{ ok: boolean }>('SELECT authz.set_sales_call_status($1, $2) AS ok', [id, input.status])).rows[0].ok;
      if (!ok) throw new NotFoundException('No sales call with that id (or it was cancelled)');
      return this.load(db, id);
    });
  }

  private async load(db: PoolClient, id: string): Promise<SalesCall> {
    const row = (await db.query<SalesCall>(`SELECT ${COLUMNS} FROM ${SALES} WHERE c.id = $1`, [id])).rows[0];
    if (!row) throw new NotFoundException('No sales call with that id');
    return row;
  }

  private async loadSettings(db: PoolClient) {
    const settings = (await db.query(`SELECT ${SETTINGS_COLUMNS} FROM core.sales_call_settings WHERE id = 1`)).rows[0];
    if (!settings) throw new NotFoundException();
    const hours = (
      await db.query(
        `SELECT weekday, to_char(starts, 'HH24:MI') AS starts, to_char(ends, 'HH24:MI') AS ends
           FROM core.sales_call_hours ORDER BY weekday, starts`,
      )
    ).rows;
    const hostIds = (await db.query<{ user_id: string }>('SELECT user_id FROM core.sales_call_hosts ORDER BY created_at, user_id')).rows.map((r) => r.user_id);
    const staff = (await db.query('SELECT id, first_name, last_name FROM core.v_staff_public ORDER BY first_name, last_name')).rows;
    return { ...settings, hours, host_ids: hostIds, staff };
  }

  // ---------------------------------------------------------------------------------------------

  private bookingError(err: unknown) {
    if (err instanceof DatabaseError && (err.code === '23505' || err.code === '23P01')) return new ConflictException('That time was just booked; please choose another');
    if (err instanceof DatabaseError && err.code === '23514' && err.constraint) return new BadRequestException('Please check your name and email');
    return err;
  }

  /** Emails the visitor their booking or its new time (best effort: the booking stands if the email fails). */
  private async email(id: string, kind: 'booked' | 'rescheduled') {
    const call = (
      await this.pool.query<{ name: string; email: string; starts_at: Date; ends_at: Date; time_zone: string | null; title: string; meeting_url: string | null; site_name: string | null; host_name: string | null }>(
        'SELECT * FROM authz.sales_call_details($1)',
        [id],
      )
    ).rows[0];
    if (!call) return undefined;
    try {
      const zone = call.time_zone && isTimeZone(call.time_zone) ? call.time_zone : 'UTC';
      const when = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: zone }).format(call.starts_at);
      const minutes = Math.round((call.ends_at.getTime() - call.starts_at.getTime()) / 60_000);
      const who = call.host_name ? `${call.host_name}${call.site_name ? ` (${call.site_name})` : ''}` : (call.site_name ?? 'us');
      const join = call.meeting_url ? `Join the call here: ${call.meeting_url}` : "We'll send the meeting details before the call.";
      await this.messaging.send({
        channel: 'email',
        to: call.email,
        template: 'sales_call',
        subject: `${kind === 'rescheduled' ? 'New time: ' : ''}${call.title} with ${who}: ${when}`,
        text:
          `Hi ${call.name},\n\n` +
          (kind === 'rescheduled'
            ? `Your ${minutes}-minute ${call.title.toLowerCase()} with ${who} has moved to ${when} (${zone}).`
            : `Your ${minutes}-minute ${call.title.toLowerCase()} with ${who} is booked for ${when} (${zone}).`) +
          `\n\n${join}\n\nReply to this email if you need to change it.`,
      });
    } catch (err) {
      this.logger.warn(`sales call email failed: ${(err as Error).message}`);
    }
    return call;
  }
}

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
