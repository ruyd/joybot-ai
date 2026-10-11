import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM (24-hour)');

/** A location's weekly hours for one employee, replacing what was there (empty = no hours there). */
const hoursSchema = z
  .object({
    location_id: z.string().uuid(),
    intervals: z
      .array(z.object({ weekday: z.number().int().min(0).max(6), starts: clock, ends: clock }).strict())
      .max(28)
      .superRefine((list, ctx) => {
        list.forEach((iv, i) => {
          if (iv.ends <= iv.starts) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'ends'], message: 'must be after starts' });
          for (const other of list.slice(0, i)) {
            if (other.weekday === iv.weekday && other.starts < iv.ends && iv.starts < other.ends) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: 'overlaps another interval that day' });
            }
          }
        });
      }),
  })
  .strict();

const timeOffSchema = z
  .object({
    starts_at: z.string().datetime({ offset: true }),
    ends_at: z.string().datetime({ offset: true }),
    reason: z.string().trim().max(200).optional(),
  })
  .strict()
  .refine((t) => Date.parse(t.ends_at) > Date.parse(t.starts_at), { message: 'ends_at must be after starts_at', path: ['ends_at'] });

/**
 * Working hours and time off (migration 0023). Staff read everyone's schedule and change their own;
 * admins change anyone's (the 'schedules' resource; RLS enforces it). A time-off reason is shown only
 * to those who may change that schedule.
 */
@Controller()
@EmployeesOnly()
export class SchedulesController {
  constructor(private readonly db: DbService) {}

  /** Active employees, for the schedule page's picker. */
  @Get('staff')
  @Can('read', 'schedules')
  staff(@CurrentPrincipal() p: Principal) {
    return this.db.as(p, async (db) => (await db.query('SELECT id, first_name, last_name FROM core.v_staff_public ORDER BY first_name, last_name')).rows);
  }

  /** One employee's locations, weekly hours and time off from 30 days ago on, and whether the caller may change them. */
  @Get('staff/:id/schedule')
  @Can('read', 'schedules')
  schedule(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.as(p, async (db) => {
      const staff = (await db.query('SELECT id, first_name, last_name FROM core.v_staff_public WHERE id = $1', [id])).rows[0];
      if (!staff) throw new NotFoundException();
      const locations = (
        await db.query(
          `SELECT l.id, l.name, l.time_zone FROM core.locations l
            WHERE EXISTS (SELECT 1 FROM core.user_locations ul WHERE ul.user_id = $1 AND ul.location_id = l.id)
            ORDER BY l.name`,
          [id],
        )
      ).rows;
      const hours = (
        await db.query(
          `SELECT location_id, weekday, to_char(starts, 'HH24:MI') AS starts, to_char(ends, 'HH24:MI') AS ends
             FROM core.working_hours WHERE user_id = $1 ORDER BY location_id, weekday, starts`,
          [id],
        )
      ).rows;
      const timeOff = (
        await db.query(
          `SELECT id, starts_at, ends_at, CASE WHEN authz.schedule_in_scope(user_id, 'update') THEN reason END AS reason
             FROM core.time_off WHERE user_id = $1 AND ends_at > now() - interval '30 days' ORDER BY starts_at`,
          [id],
        )
      ).rows;
      return { staff, locations, hours, time_off: timeOff, can_edit: await this.mayChange(db, id) };
    });
  }

  @Put('staff/:id/hours')
  @Can('update', 'schedules')
  setHours(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(hoursSchema)) body: z.infer<typeof hoursSchema>) {
    return this.db.as(p, async (db) => {
      if (!(await this.mayChange(db, id))) throw new ForbiddenException('Not allowed to change this schedule');
      await db.query('DELETE FROM core.working_hours WHERE user_id = $1 AND location_id = $2', [id, body.location_id]);
      for (const iv of body.intervals) {
        // RLS rejects a location the employee does not work at (42501 → 403).
        await db.query('INSERT INTO core.working_hours (user_id, location_id, weekday, starts, ends) VALUES ($1, $2, $3, $4, $5)', [
          id,
          body.location_id,
          iv.weekday,
          iv.starts,
          iv.ends,
        ]);
      }
      return { ok: true };
    });
  }

  @Post('staff/:id/time-off')
  @Can('create', 'schedules')
  addTimeOff(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(timeOffSchema)) body: z.infer<typeof timeOffSchema>) {
    return this.db.as(p, async (db) => {
      if (!(await this.mayChange(db, id, 'create'))) throw new ForbiddenException('Not allowed to change this schedule');
      return (
        await db.query(
          `INSERT INTO core.time_off (user_id, starts_at, ends_at, reason, created_by) VALUES ($1, $2, $3, $4, $5)
           RETURNING id, starts_at, ends_at, reason`,
          [id, body.starts_at, body.ends_at, body.reason || null, p.id],
        )
      ).rows[0];
    });
  }

  @Delete('time-off/:id')
  @HttpCode(204)
  @Can('delete', 'schedules')
  async removeTimeOff(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const deleted = await this.db.as(p, async (db) => (await db.query('DELETE FROM core.time_off WHERE id = $1', [id])).rowCount);
    if (!deleted) throw new NotFoundException();
  }

  private async mayChange(db: PoolClient, userId: string, action: 'create' | 'update' = 'update'): Promise<boolean> {
    return (await db.query<{ ok: boolean }>('SELECT authz.schedule_in_scope($1, $2) AS ok', [userId, action])).rows[0].ok;
  }
}
