import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { insertStatement, setClause } from '../common/sql';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';

const BASE_COLUMNS = `o.id, o.org_number, o.name, o.legal_name, o.tax_id, o.email, o.phone, o.address,
  o.restricted, o.status, o.created_by, o.created_at, o.updated_at`;

const fields = {
  name: z.string().trim().min(1).max(200),
  legal_name: z.string().trim().max(200).nullable(),
  tax_id: z.string().trim().max(50).nullable(),
  email: z.string().trim().email().toLowerCase().nullable(),
  phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/).nullable(),
  address: z.record(z.string(), z.unknown()).nullable(),
  notes_internal: z.string().max(5000).nullable(),
};
const createSchema = z.object(fields).partial().required({ name: true }).strict();
const updateSchema = z
  .object({ ...fields, status: z.enum(['active', 'inactive']), restricted: z.boolean() })
  .partial()
  .strict();

@Controller('organizations')
@EmployeesOnly()
export class OrganizationsController {
  constructor(private readonly db: DbService) {}

  private columns(p: Principal) {
    return p.access.can('read', 'notes_internal') ? `${BASE_COLUMNS}, o.notes_internal` : BASE_COLUMNS;
  }

  /** Search by org number (exact) or name / legal name (fuzzy); RLS-filtered. Member counts only
   *  include members the employee can see. */
  @Get()
  @Can('read', 'organizations')
  search(@CurrentPrincipal() p: Principal, @Query('q') q = '', @Query('limit') limit = '20') {
    const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const term = q.trim();
    return this.db.as(p, async (db) => {
      const select = `SELECT ${this.columns(p)},
                             (SELECT count(*)::int FROM core.customers c WHERE c.organization_id = o.id) AS visible_members
                        FROM core.organizations o`;
      if (!term) return (await db.query(`${select} ORDER BY o.name LIMIT $1`, [n])).rows;
      return (
        await db.query(
          `${select}
            WHERE o.org_number = upper($1) OR o.name % $1 OR o.legal_name % $1 OR o.name ILIKE '%' || $1 || '%'
            ORDER BY (o.org_number = upper($1)) DESC,
                     greatest(similarity(o.name, $1), similarity(coalesce(o.legal_name, ''), $1)) DESC
            LIMIT $2`,
          [term, n],
        )
      ).rows;
    });
  }

  @Get(':id')
  @Can('read', 'organizations')
  async get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.db.as(p, async (db) =>
      (await db.query(`SELECT ${this.columns(p)} FROM core.organizations o WHERE o.id = $1`, [id])).rows[0],
    );
    if (!row) throw new NotFoundException();
    return row;
  }

  @Get(':id/members')
  @Can('read', 'customers')
  async members(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.as(p, async (db) => {
      const org = (await db.query('SELECT id FROM core.organizations WHERE id = $1', [id])).rows[0];
      if (!org) throw new NotFoundException();
      return (
        await db.query(
          `SELECT id, customer_number, first_name, last_name, email, phone, org_role, status, restricted
             FROM core.customers WHERE organization_id = $1
            ORDER BY org_role = 'org_admin' DESC, last_name, first_name`,
          [id],
        )
      ).rows;
    });
  }

  /** Admin panel: which employees can access this organization, and why. */
  @Get(':id/access')
  @Can('read', 'access')
  access(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.as(p, async (db) => (await db.query('SELECT * FROM authz.who_can_access_org($1)', [id])).rows);
  }

  @Post()
  @Can('create', 'organizations')
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    const row: Record<string, unknown> = { ...body, created_by: p.id };
    if (row.notes_internal !== undefined && !p.access.can('update', 'notes_internal')) delete row.notes_internal;
    return this.db.as(p, async (db) => {
      const q = insertStatement('core.organizations', row, this.columns(p).replaceAll('o.', ''));
      return (await db.query(q.text, q.values)).rows[0];
    });
  }

  @Put(':id')
  @Can('update', 'organizations')
  async update(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    const fields: Record<string, unknown> = { ...body };
    if (fields.notes_internal !== undefined && !p.access.can('update', 'notes_internal')) delete fields.notes_internal;
    if (fields.restricted !== undefined && !p.access.can('update', 'access')) delete fields.restricted;
    const set = setClause(fields);
    const cols = this.columns(p).replaceAll('o.', '');
    const row = await this.db.as(p, async (db) =>
      set.empty
        ? (await db.query(`SELECT ${cols} FROM core.organizations WHERE id = $1`, [id])).rows[0]
        : (await db.query(`UPDATE core.organizations SET ${set.sql} WHERE id = $1 RETURNING ${cols}`, [id, ...set.values])).rows[0],
    );
    if (!row) throw new NotFoundException();
    return row;
  }
}
