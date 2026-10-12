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

const listSchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().refine((n) => [10, 25, 50, 100].includes(n), 'limit is 10, 25, 50 or 100').default(25),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();
type ListQuery = z.infer<typeof listSchema>;

/**
 * The search as SQL over core.customers with a full name: exact number, email or phone, every word
 * starting a word of the name, or a close name (trigram). No term: everyone (no order of its own).
 */
function matching(q: string): { from: string; where: string; order?: string; args: unknown[]; whereArgs: unknown[] } {
  const from = `SELECT *, coalesce(first_name, '') || ' ' || coalesce(last_name, '') AS full_name FROM core.customers`;
  const term = q.trim();
  if (!term) return { from, where: '', args: [], whereArgs: [] };
  // LIKE patterns: typed % and _ are literal.
  const like = (w: string) => w.replace(/[\\%_]/g, '\\$&');
  const words = term.split(/\s+/).slice(0, 5).map(like);
  const exact = `(customer_number = upper($1) OR email = $1 OR phone = $1)`;
  const prefixes = `(SELECT bool_and(full_name ILIKE w || '%' OR full_name ILIKE '% ' || w || '%') FROM unnest($2::text[]) w)`;
  return {
    from,
    where: `WHERE ${exact} OR ${prefixes} OR full_name % $1`,
    order: `${exact} DESC, full_name ILIKE $3 || '%' DESC, ${prefixes} DESC, similarity(full_name, $1) DESC, full_name`,
    args: [term, words, like(term)],
    // The WHERE alone uses only $1 and $2 (Postgres rejects unused parameters).
    whereArgs: [term, words],
  };
}

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
   * Used by the pickers; the Customers page uses `list` (pages and the total).
   */
  @Get()
  @Can('read', 'customers')
  search(@CurrentPrincipal() p: Principal, @Query('q') q = '', @Query('limit') limit = '20') {
    const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const m = matching(q);
    return this.db.as(p, async (db) => {
      const order = m.order ?? 'updated_at DESC';
      return (await db.query(`SELECT ${this.columns(p)} FROM (${m.from}) c ${m.where} ORDER BY ${order} LIMIT $${m.args.length + 1}`, [...m.args, n])).rows;
    });
  }

  /** Customers page: a page of customers (by name, or by relevance when searching) with the total. */
  @Get('list')
  @Can('read', 'customers')
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(listSchema)) query: ListQuery) {
    const m = matching(query.q ?? '');
    return this.db.as(p, async (db) => {
      const order = m.order ?? 'last_name NULLS LAST, first_name, customer_number';
      const args = [...m.args, query.limit, query.offset];
      const [items, count] = await Promise.all([
        db.query(`SELECT ${this.columns(p)} FROM (${m.from}) c ${m.where} ORDER BY ${order} LIMIT $${args.length - 1} OFFSET $${args.length}`, args),
        db.query<{ total: number }>(`SELECT count(*)::int AS total FROM (${m.from}) c ${m.where}`, m.whereArgs),
      ]);
      return { items: items.rows, total: count.rows[0].total };
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
