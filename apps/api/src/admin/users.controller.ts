import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { insertStatement, setClause } from '../common/sql';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';

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

/** Employee directory and access-relevant attributes (role, locations). Admin only.
 *  Cognito login provisioning is added with the auth stack (Phase 1 infra). */
@Controller('admin/users')
@EmployeesOnly()
export class UsersController {
  constructor(private readonly db: DbService) {}

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
      return this.load(db, id);
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
      const set = setClause(fields);
      if (!set.empty) await db.query(`UPDATE core.users SET ${set.sql} WHERE id = $1`, [id, ...set.values]);
      if (location_ids) await this.setLocations(db, id, location_ids);
      const admins = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM core.users WHERE role = 'admin' AND active`)).rows[0].n;
      if (admins === 0) throw new BadRequestException('At least one active admin is required');
      return this.load(db, id);
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
