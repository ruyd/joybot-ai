import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';

const E164 = /^\+[1-9][0-9]{6,14}$/;

const BASE_COLUMNS = `id, customer_number, first_name, last_name, email, email_verified, phone, phone_verified,
  organization_id, org_role, preferred_location_id, time_zone, status, restricted, source,
  whatsapp_opt_in_at, profile_completed_at, created_at, updated_at, cognito_sub IS NOT NULL AS has_login`;

const editable = {
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100).nullable(),
  email: z.string().trim().email().toLowerCase().nullable(),
  phone: z.string().regex(E164, 'phone must be E.164, e.g. +12125550101').nullable(),
  organization_id: z.string().uuid().nullable(),
  org_role: z.enum(['member', 'org_admin']).nullable(),
  preferred_location_id: z.string().uuid().nullable(),
  time_zone: z.string().min(1).nullable(),
  notes_internal: z.string().max(5000).nullable(),
  whatsapp_opt_in: z.boolean(),
};

/** Employees create a minimal record first: a first name plus email or phone (plan.md §4.3). */
const createSchema = z
  .object(editable)
  .partial()
  .required({ first_name: true })
  .strict()
  .refine((c) => c.email || c.phone, { message: 'email or phone is required' })
  .refine((c) => !c.organization_id === !c.org_role, { message: 'organization_id and org_role go together' });

const updateSchema = z
  .object({ ...editable, status: z.enum(['active', 'inactive', 'blocked']), restricted: z.boolean() })
  .partial()
  .strict();

type CreateCustomer = z.infer<typeof createSchema>;
type UpdateCustomer = z.infer<typeof updateSchema>;

@Controller('customers')
@EmployeesOnly()
export class CustomersController {
  constructor(private readonly db: DbService) {}

  private columns(p: Principal): string {
    return p.access.can('read', 'notes_internal') ? `${BASE_COLUMNS}, notes_internal` : BASE_COLUMNS;
  }

  /**
   * Search by customer number, email, phone (exact) or name: every typed word starts a word of the
   * name ("ma", "lop", "mar lop"), or the name is close enough (fuzzy, for typos). Exact matches rank
   * first, then names starting with the term, then prefix matches, then by similarity. RLS-filtered.
   */
  @Get()
  @Can('read', 'customers')
  search(@CurrentPrincipal() p: Principal, @Query('q') q = '', @Query('limit') limit = '20') {
    const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const term = q.trim();
    return this.db.as(p, async (db) => {
      if (!term) {
        return (await db.query(`SELECT ${this.columns(p)} FROM core.customers ORDER BY updated_at DESC LIMIT $1`, [n])).rows;
      }
      // LIKE patterns: typed % and _ are literal.
      const like = (w: string) => w.replace(/[\\%_]/g, '\\$&');
      const words = term.split(/\s+/).slice(0, 5).map(like);
      const res = await db.query(
        `WITH m AS (
           SELECT c.*, coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '') AS full_name
             FROM core.customers c
         )
         SELECT ${this.columns(p)}, similarity(full_name, $1) AS score
           FROM m
          WHERE customer_number = upper($1) OR email = $1 OR phone = $1
             OR (SELECT bool_and(full_name ILIKE w || '%' OR full_name ILIKE '% ' || w || '%') FROM unnest($3::text[]) w)
             OR full_name % $1
          ORDER BY (customer_number = upper($1) OR email = $1 OR phone = $1) DESC,
                   full_name ILIKE $4 || '%' DESC,
                   (SELECT bool_and(full_name ILIKE w || '%' OR full_name ILIKE '% ' || w || '%') FROM unnest($3::text[]) w) DESC,
                   score DESC, full_name
          LIMIT $2`,
        [term, n, words, like(term)],
      );
      return res.rows;
    });
  }

  @Get(':id')
  @Can('read', 'customers')
  async get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.db.as(p, async (db) =>
      (await db.query(`SELECT ${this.columns(p)} FROM core.customers WHERE id = $1`, [id])).rows[0],
    );
    if (!row) throw new NotFoundException();
    return row;
  }

  /** Admin panel: which employees can access this customer, and why. */
  @Get(':id/access')
  @Can('read', 'access')
  access(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.as(p, async (db) => (await db.query('SELECT * FROM authz.who_can_access_customer($1)', [id])).rows);
  }

  @Post()
  @Can('create', 'customers')
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(createSchema)) body: CreateCustomer) {
    const { whatsapp_opt_in, ...fields } = body;
    if (fields.notes_internal !== undefined && !p.access.can('update', 'notes_internal')) delete fields.notes_internal;
    const cols = Object.keys(fields);
    const values = Object.values(fields);
    return this.db.as(p, async (db) => {
      const res = await db.query(
        `INSERT INTO core.customers (${[...cols, 'source', 'created_by', 'whatsapp_opt_in_at'].join(', ')})
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}${cols.length ? ', ' : ''}'employee', $${cols.length + 1},
                 CASE WHEN $${cols.length + 2}::boolean THEN now() END)
         RETURNING ${this.columns(p)}`,
        [...values, p.id, whatsapp_opt_in ?? false],
      );
      return res.rows[0];
    });
  }

  @Put(':id')
  @Can('update', 'customers')
  async update(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateSchema)) body: UpdateCustomer,
  ) {
    const { whatsapp_opt_in, ...fields } = body;
    if (fields.notes_internal !== undefined && !p.access.can('update', 'notes_internal')) delete fields.notes_internal;
    // Only admins can mark records restricted (it removes them from location-wide visibility).
    if (fields.restricted !== undefined && !p.access.can('update', 'access')) delete fields.restricted;
    const sets = Object.keys(fields).map((k, i) => `${k} = $${i + 2}`);
    if (whatsapp_opt_in !== undefined) {
      sets.push(`whatsapp_opt_in_at = ${whatsapp_opt_in ? 'coalesce(whatsapp_opt_in_at, now())' : 'NULL'}`);
    }
    const row = await this.db.as(p, async (db) => {
      if (sets.length === 0) {
        return (await db.query(`SELECT ${this.columns(p)} FROM core.customers WHERE id = $1`, [id])).rows[0];
      }
      return (
        await db.query(`UPDATE core.customers SET ${sets.join(', ')} WHERE id = $1 RETURNING ${this.columns(p)}`, [
          id,
          ...Object.values(fields),
        ])
      ).rows[0];
    });
    if (!row) throw new NotFoundException();
    return row;
  }
}
