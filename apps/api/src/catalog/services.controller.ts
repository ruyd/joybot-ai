import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { insertStatement, setClause } from '../common/sql';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';

const COLUMNS = 'id, code, name, description, category, duration_minutes, price, currency, active, created_at, updated_at';

const fields = {
  code: z.string().trim().min(1).max(40).transform((s) => s.toUpperCase()),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).nullable(),
  category: z.string().trim().max(100).nullable(),
  duration_minutes: z.number().int().positive().max(24 * 60).nullable(),
  price: z.coerce.number().min(0).multipleOf(0.01),
  currency: z.string().regex(/^[A-Z]{3}$/),
  active: z.boolean(),
};
const createSchema = z.object(fields).partial().required({ code: true, name: true, price: true }).strict();
const updateSchema = z.object(fields).partial().strict();

/** Generic price list (plan.md §4.1 — no subscriptions/packages). */
@Controller()
export class ServicesController {
  constructor(private readonly db: DbService) {}

  @Get('services')
  list(
    @CurrentPrincipal() p: Principal,
    @Query('category') category?: string,
    @Query('q') q?: string,
    @Query('include_inactive') includeInactive?: string,
  ) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (!(includeInactive === 'true' && p.type === 'employee')) where.push('active');
    if (category) {
      args.push(category);
      where.push(`category = $${args.length}`);
    }
    if (q?.trim()) {
      args.push(`%${q.trim()}%`);
      where.push(`(name ILIKE $${args.length} OR description ILIKE $${args.length} OR code ILIKE $${args.length})`);
    }
    return this.db.as(p, async (db) =>
      (
        await db.query(
          `SELECT ${COLUMNS} FROM core.services ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY category NULLS LAST, name`,
          args,
        )
      ).rows,
    );
  }

  @Get('services/:id')
  async get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.db.as(p, async (db) =>
      (await db.query(`SELECT ${COLUMNS} FROM core.services WHERE id = $1 ${p.type === 'customer' ? 'AND active' : ''}`, [id])).rows[0],
    );
    if (!row) throw new NotFoundException();
    return row;
  }

  @Post('admin/services')
  @EmployeesOnly()
  @Can('create', 'services')
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return this.db.as(p, async (db) => {
      const currency =
        body.currency ?? (await db.query<{ c: string }>('SELECT default_currency AS c FROM core.settings WHERE id = 1')).rows[0].c;
      const q = insertStatement('core.services', { ...body, currency }, COLUMNS);
      return (await db.query(q.text, q.values)).rows[0];
    });
  }

  @Put('admin/services/:id')
  @EmployeesOnly()
  @Can('update', 'services')
  async update(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    const set = setClause(body);
    const row = await this.db.as(p, async (db) =>
      set.empty
        ? (await db.query(`SELECT ${COLUMNS} FROM core.services WHERE id = $1`, [id])).rows[0]
        : (await db.query(`UPDATE core.services SET ${set.sql} WHERE id = $1 RETURNING ${COLUMNS}`, [id, ...set.values])).rows[0],
    );
    if (!row) throw new NotFoundException();
    return row;
  }
}
