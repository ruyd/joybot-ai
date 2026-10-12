import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';

const listSchema = z
  .object({
    /** Where changes came from: 'api' (the app), 'mcp' (Claude), 'worker', 'stripe_webhook', 'migration', … */
    via: z.string().regex(/^[a-z_]{2,30}$/).optional(),
    table: z.string().regex(/^[a-z_]{2,40}$/).optional(),
    /** Who made the change (an employee's or customer's id). */
    changed_by: z.string().uuid().optional(),
    /** One record's history. */
    row_id: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

/** Fields never shown, even to admins: hashes and sign-in identifiers. */
const HIDDEN = ['token_hash', 'code_hash', 'args_hash', 'cognito_sub'];

/**
 * A readable name for the changed record (`p` is a change_log row): its number or title, looked up now
 * so renamed records show their current name, else taken from the logged row (deleted records). CASE
 * only casts row_id for the matching table, so each lookup uses the primary key.
 */
const LABEL = `coalesce(
  CASE p.table_name
    WHEN 'appointments' THEN (SELECT appointment_number FROM core.appointments WHERE id = p.row_id::uuid)
    WHEN 'invoices' THEN (SELECT invoice_number FROM core.invoices WHERE id = p.row_id::uuid)
    WHEN 'invoice_lines' THEN (SELECT i.invoice_number FROM core.invoice_lines x JOIN core.invoices i ON i.id = x.invoice_id WHERE x.id = p.row_id::uuid)
    WHEN 'payments' THEN (SELECT payment_number FROM core.payments WHERE id = p.row_id::uuid)
    WHEN 'customers' THEN (SELECT concat_ws(' ', nullif(concat_ws(' ', first_name, last_name), ''), '(' || customer_number || ')') FROM core.customers WHERE id = p.row_id::uuid)
    WHEN 'users' THEN (SELECT concat_ws(' ', first_name, last_name) FROM core.users WHERE id = p.row_id::uuid)
    WHEN 'tasks' THEN (SELECT title FROM core.tasks WHERE id = p.row_id::uuid)
    WHEN 'answers' THEN (SELECT title FROM core.answers WHERE id = p.row_id::uuid)
    WHEN 'articles' THEN (SELECT title FROM core.articles WHERE id = p.row_id::uuid)
    WHEN 'services' THEN (SELECT name FROM core.services WHERE id = p.row_id::uuid)
    WHEN 'locations' THEN (SELECT name FROM core.locations WHERE id = p.row_id::uuid)
    WHEN 'organizations' THEN (SELECT name FROM core.organizations WHERE id = p.row_id::uuid)
    WHEN 'api_tokens' THEN (SELECT name FROM app.api_tokens WHERE id = p.row_id::uuid)
    WHEN 'site_pages' THEN (SELECT title FROM core.site_pages WHERE id = p.row_id::uuid)
    WHEN 'site_assets' THEN (SELECT filename FROM core.site_assets WHERE id = p.row_id::uuid)
    WHEN 'site_settings' THEN 'Website setup'
  END,
  p.diff->>'invoice_number', p.diff->>'appointment_number', p.diff->>'payment_number', p.diff->>'customer_number',
  p.diff->>'title', p.diff->>'name', p.diff->>'filename', nullif(concat_ws(' ', p.diff->>'first_name', p.diff->>'last_name'), ''))`;

/**
 * The change log (core.change_log, written by the audit triggers on every audited table), newest first,
 * one page at a time with the total. Only the page is read in full: labels and names are looked up for
 * its rows. RLS (audit_read) limits it to employees with the audit permission.
 */
@Controller('admin/audit')
@EmployeesOnly()
export class AuditController {
  constructor(private readonly db: DbService) {}

  @Get()
  @Can('read', 'audit')
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    return this.db.as(p, async (db) => {
      const filter = [q.via ?? null, q.table ?? null, q.changed_by ?? null, q.row_id ?? null];
      const where = `($1::text IS NULL OR l.changed_via = $1) AND ($2::text IS NULL OR l.table_name = $2)
                 AND ($3::uuid IS NULL OR l.changed_by = $3) AND ($4::text IS NULL OR l.row_id = $4)`;
      const { rows } = await db.query(
        `SELECT p.*, ${LABEL} AS label,
                CASE p.principal_type
                  WHEN 'employee' THEN (SELECT nullif(concat_ws(' ', u.first_name, u.last_name), '') FROM core.users u WHERE u.id = p.changed_by)
                  WHEN 'customer' THEN (SELECT nullif(concat_ws(' ', c.first_name, c.last_name), '') FROM core.customers c WHERE c.id = p.changed_by)
                END AS changed_by_name
           FROM (SELECT l.id, l.table_name, l.row_id, l.action, l.changed_by, l.principal_type, l.changed_via, l.changed_at,
                        l.diff - $7::text[] AS diff, count(*) OVER () AS total
                   FROM core.change_log l
                  WHERE ${where}
                  ORDER BY l.changed_at DESC, l.id DESC
                  LIMIT $5 OFFSET $6) p
          ORDER BY p.changed_at DESC, p.id DESC`,
        [...filter, q.limit, q.offset, HIDDEN],
      );
      // Past the last page there are no rows to carry the total: count separately.
      const total = rows.length
        ? Number(rows[0].total)
        : Number((await db.query(`SELECT count(*) AS n FROM core.change_log l WHERE ${where}`, filter)).rows[0].n);
      return { items: rows.map(({ total: _t, ...r }) => r), total };
    });
  }
}
