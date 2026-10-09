import { BadRequestException, Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { insertStatement, setClause } from '../common/sql';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';
import { EMPLOYEE_LOGINS, type EmployeeLogins } from './employee-logins';

const COLUMNS = `u.id, u.employee_number, u.first_name, u.last_name, u.email, u.phone, u.role, u.home_location_id,
  u.time_zone, u.active, u.cognito_sub IS NOT NULL AS has_login, u.created_at, u.updated_at,
  coalesce((SELECT array_agg(ul.location_id ORDER BY ul.location_id) FROM core.user_locations ul WHERE ul.user_id = u.id),
           '{}') AS location_ids`;

const fields = {
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().toLowerCase(),
  phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/).nullable(),
  role: z.enum(['admin', 'staff']),
  home_location_id: z.string().uuid().nullable(),
  time_zone: z.string().min(1).nullable(),
  active: z.boolean(),
  /** Locations the employee works at (drives the staff "location" scope). Replaces the full set. */
  location_ids: z.array(z.string().uuid()).max(100),
};
const createSchema = z
  .object(fields)
  .partial()
  .required({ first_name: true, last_name: true, email: true, role: true })
  .strict();
const updateSchema = z.object(fields).partial().strict();

/**
 * Employee directory and access-relevant attributes (role, locations), plus their sign-in accounts
 * in the employees user pool. Cognito calls run inside the database transaction after the writes
 * succeed, so a Cognito failure rolls the employee change back.
 */
@Controller('admin/users')
@EmployeesOnly()
export class UsersController {
  constructor(
    private readonly db: DbService,
    @Inject(EMPLOYEE_LOGINS) private readonly logins: EmployeeLogins,
  ) {}

  @Get()
  @Can('read', 'users')
  list(@CurrentPrincipal() p: Principal, @Query('include_inactive') includeInactive?: string) {
    return this.db.as(p, async (db) =>
      (
        await db.query(
          `SELECT ${COLUMNS} FROM core.users u ${includeInactive === 'true' ? '' : 'WHERE u.active'}
            ORDER BY u.last_name, u.first_name`,
        )
      ).rows,
    );
  }

  @Post()
  @Can('create', 'users')
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    const { location_ids, ...row } = body;
    return this.db.as(p, async (db) => {
      const q = insertStatement('core.users', row, 'id');
      const { id } = (await db.query<{ id: string }>(q.text, q.values)).rows[0];
      await this.setLocations(db, id, location_ids ?? (row.home_location_id ? [row.home_location_id] : []));
      const created = await this.load(db, id);
      if (created.active) await this.logins.invite(created.email, created.role);
      return created;
    });
  }

  /** Emails a new temporary password to an employee who has not signed in yet. */
  @Post(':id/resend-invite')
  @HttpCode(200)
  @Can('update', 'users')
  async resendInvite(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.as(p, async (db) => {
      const user = await this.load(db, id);
      if (!user) throw new NotFoundException();
      if (!user.active) throw new BadRequestException('Employee is inactive');
      if (user.has_login) throw new BadRequestException('Employee has already signed in');
      await this.logins.resendInvite(user.email);
      return { sent: true };
    });
  }

  @Put(':id')
  @Can('update', 'users')
  update(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    const { location_ids, ...fields } = body;
    if (id === p.id && (fields.role === 'staff' || fields.active === false)) {
      throw new BadRequestException('You cannot demote or deactivate yourself');
    }
    return this.db.as(p, async (db) => {
      const current = await this.load(db, id);
      if (!current) throw new NotFoundException();
      if (fields.email !== undefined && fields.email !== current.email) {
        throw new BadRequestException('The email is the sign-in name and cannot be changed; add a new employee instead');
      }
      const set = setClause(fields);
      if (!set.empty) await db.query(`UPDATE core.users SET ${set.sql} WHERE id = $1`, [id, ...set.values]);
      if (location_ids) await this.setLocations(db, id, location_ids);
      const admins = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM core.users WHERE role = 'admin' AND active`)).rows[0].n;
      if (admins === 0) throw new BadRequestException('At least one active admin is required');

      const updated = await this.load(db, id);
      if (current.active && !updated.active) await this.logins.disable(updated.email);
      if (!current.active && updated.active) await this.logins.enable(updated.email);
      if (updated.active && current.role !== updated.role) await this.logins.changeRole(updated.email, current.role, updated.role);
      return updated;
    });
  }

  private async load(db: PoolClient, id: string) {
    return (await db.query(`SELECT ${COLUMNS} FROM core.users u WHERE u.id = $1`, [id])).rows[0];
  }

  private async setLocations(db: PoolClient, userId: string, locationIds: string[]) {
    await db.query('DELETE FROM core.user_locations WHERE user_id = $1 AND NOT (location_id = ANY ($2::uuid[]))', [userId, locationIds]);
    await db.query(
      `INSERT INTO core.user_locations (user_id, location_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
      [userId, locationIds],
    );
  }
}
