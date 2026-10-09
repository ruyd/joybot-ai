import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { insertStatement, setClause } from '../common/sql';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';

const COLUMNS = 'id, code, name, address, phone, time_zone, active, created_at, updated_at';

const fields = {
  code: z.string().trim().min(1).max(20).transform((s) => s.toUpperCase()),
  name: z.string().trim().min(1).max(200),
  time_zone: z.string().min(1),
  address: z.record(z.string(), z.unknown()).nullable(),
  phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/).nullable(),
  active: z.boolean(),
};
const createSchema = z.object(fields).partial().required({ code: true, name: true, time_zone: true }).strict();
const updateSchema = z.object(fields).partial().strict();

@Controller()
export class LocationsController {
  constructor(private readonly db: DbService) {}

  /** Everyone signed in can list active locations (address, phone, time zone). */
  @Get('locations')
  list(@CurrentPrincipal() p: Principal, @Query('include_inactive') includeInactive?: string) {
    const all = includeInactive === 'true' && p.type === 'employee';
    return this.db.as(p, async (db) =>
      (await db.query(`SELECT ${COLUMNS} FROM core.locations ${all ? '' : 'WHERE active'} ORDER BY name`)).rows,
    );
  }

  @Post('admin/locations')
  @EmployeesOnly()
  @Can('create', 'locations')
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return this.db.as(p, async (db) => {
      const q = insertStatement('core.locations', body, COLUMNS);
      return (await db.query(q.text, q.values)).rows[0];
    });
  }

  @Put('admin/locations/:id')
  @EmployeesOnly()
  @Can('update', 'locations')
  async update(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    const set = setClause(body);
    const row = await this.db.as(p, async (db) =>
      set.empty
        ? (await db.query(`SELECT ${COLUMNS} FROM core.locations WHERE id = $1`, [id])).rows[0]
        : (await db.query(`UPDATE core.locations SET ${set.sql} WHERE id = $1 RETURNING ${COLUMNS}`, [id, ...set.values])).rows[0],
    );
    if (!row) throw new NotFoundException();
    return row;
  }
}
