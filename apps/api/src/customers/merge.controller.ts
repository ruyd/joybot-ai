import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';

const SUMMARY = `id, customer_number, first_name, last_name, email, email_verified, phone, phone_verified,
  organization_id, org_role, preferred_location_id, status, restricted, stripe_customer_id IS NOT NULL AS has_stripe,
  cognito_sub IS NOT NULL AS has_login, created_at`;

/** Fields the target keeps; the source only fills them when empty. Shown in the merge preview. */
const FIELDS = ['first_name', 'last_name', 'email', 'phone', 'organization_id', 'preferred_location_id'] as const;

const mergeSchema = z.object({ into: z.string().uuid(), reason: z.string().trim().min(3).max(500) }).strict();
const dismissSchema = z.object({ customer_ids: z.tuple([z.string().uuid(), z.string().uuid()]) }).strict();
const resolveSchema = z
  .object({
    action: z.enum(['link', 'merge', 'reject']),
    customer_id: z.string().uuid().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

type Row = Record<string, unknown> & { id: string; has_login: boolean; status: string };

/**
 * Duplicate customers and the link-review queue (plan.md §4.3). Needs 'merge' on customers,
 * which only admins have: linking a login to a record decides who sees that customer's data.
 * The rules live in authz.merge_customers / authz.resolve_link_review.
 */
@Controller()
@EmployeesOnly()
export class MergeController {
  constructor(private readonly db: DbService) {}

  /** Likely duplicates: same full name, or same last name and date of birth. */
  @Get('duplicates')
  @Can('merge', 'customers')
  duplicates(@CurrentPrincipal() p: Principal) {
    return this.db.as(p, async (db) => {
      const pairs = (
        await db.query<{ a: string; b: string; reason: string }>(
          `SELECT a.id AS a, b.id AS b,
                  CASE WHEN lower(a.first_name) = lower(b.first_name) AND lower(a.last_name) = lower(b.last_name)
                       THEN 'same_name' ELSE 'same_last_name_and_birth_date' END AS reason
             FROM core.customers a
             JOIN core.customers b ON a.id < b.id AND lower(a.last_name) = lower(b.last_name)
            WHERE (lower(a.first_name) = lower(b.first_name) OR a.date_of_birth = b.date_of_birth)
              AND NOT EXISTS (SELECT 1 FROM app.duplicate_dismissals d WHERE d.customer_a = a.id AND d.customer_b = b.id)
            ORDER BY greatest(a.created_at, b.created_at) DESC
            LIMIT 50`,
        )
      ).rows;
      const ids = [...new Set(pairs.flatMap((x) => [x.a, x.b]))];
      const byId = new Map(
        (await db.query<Row>(`SELECT ${SUMMARY} FROM core.customers WHERE id = ANY($1)`, [ids])).rows.map((r) => [r.id, r]),
      );
      return pairs.map((x) => ({ reason: x.reason, customers: [byId.get(x.a), byId.get(x.b)] }));
    });
  }

  @Post('duplicates/dismiss')
  @HttpCode(204)
  @Can('merge', 'customers')
  async dismiss(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(dismissSchema)) body: z.infer<typeof dismissSchema>) {
    const [a, b] = [...body.customer_ids].sort();
    if (a === b) throw new BadRequestException('Pick two different customers');
    await this.db.as(p, (db) =>
      db.query(
        `INSERT INTO app.duplicate_dismissals (customer_a, customer_b, dismissed_by)
         SELECT $1, $2, $3 WHERE (SELECT count(*) FROM core.customers WHERE id IN ($1, $2)) = 2
         ON CONFLICT DO NOTHING`,
        [a, b, p.id],
      ),
    );
  }

  /** What a merge of :id into ?into= would do, and why it might be refused. */
  @Get('customers/:id/merge-preview')
  @Can('merge', 'customers')
  preview(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Query('into', ParseUUIDPipe) into: string) {
    return this.db.as(p, async (db) => {
      const rows = (await db.query<Row>(`SELECT ${SUMMARY} FROM core.customers WHERE id IN ($1, $2)`, [id, into])).rows;
      const source = rows.find((r) => r.id === id);
      const target = rows.find((r) => r.id === into);
      if (!source || !target) throw new NotFoundException('Customer not found');
      const counts = (
        await db.query(
          `SELECT (SELECT count(*)::int FROM core.appointments WHERE customer_id = $1) AS appointments,
                  (SELECT count(*)::int FROM core.payments WHERE customer_id = $1) AS payments`,
          [id],
        )
      ).rows[0];
      const blockers: string[] = [];
      if (id === into) blockers.push('Pick two different customers.');
      if (source.has_login && target.has_login) blockers.push('Both customers have a portal login.');
      if (source.status === 'blocked' || target.status === 'blocked') blockers.push('Unblock the customer before merging.');
      const filled = FIELDS.filter((f) => target[f] == null && source[f] != null);
      const dropped = FIELDS.filter((f) => target[f] != null && source[f] != null && target[f] !== source[f]);
      return { source, target, moves: counts, filled, dropped, blockers };
    });
  }

  /** Merges :id into body.into; :id becomes a hidden tombstone. */
  @Post('customers/:id/merge')
  @HttpCode(200)
  @Can('merge', 'customers')
  async merge(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(mergeSchema)) body: z.infer<typeof mergeSchema>) {
    return this.db.as(p, async (db) => {
      await db.query('SELECT authz.merge_customers($1, $2, $3)', [id, body.into, body.reason]);
      return (await db.query(`SELECT ${SUMMARY} FROM core.customers WHERE id = $1`, [body.into])).rows[0];
    });
  }

  @Get('link-reviews')
  @Can('merge', 'customers')
  reviews(@CurrentPrincipal() p: Principal, @Query('status') status = 'open') {
    if (!['open', 'linked', 'merged', 'rejected'].includes(status)) throw new BadRequestException('Unknown status');
    return this.db.as(p, async (db) => {
      const rows = (
        await db.query(
          `SELECT r.id, r.reason, r.status, r.created_at, r.resolved_at, r.resolution_note,
                  r.candidate_customer_id, r.account_customer_id,
                  CASE WHEN c.email IS NOT NULL AND encode(sha256(convert_to(c.email::text, 'UTF8')), 'hex') = r.contact_hash THEN 'email'
                       WHEN c.phone IS NOT NULL AND encode(sha256(convert_to(c.phone, 'UTF8')), 'hex') = r.contact_hash THEN 'phone' END AS matched_on,
                  u.first_name || ' ' || u.last_name AS resolved_by_name
             FROM app.link_review_queue r
             LEFT JOIN core.customers c ON c.id = r.candidate_customer_id
             LEFT JOIN core.users u ON u.id = r.resolved_by
            WHERE r.status = $1
            ORDER BY r.created_at ${status === 'open' ? 'ASC' : 'DESC'}
            LIMIT 100`,
          [status],
        )
      ).rows;
      const ids = [...new Set(rows.flatMap((r) => [r.candidate_customer_id, r.account_customer_id]).filter(Boolean))];
      const byId = new Map(
        (await db.query<Row>(`SELECT ${SUMMARY} FROM core.customers WHERE id = ANY($1)`, [ids])).rows.map((r) => [r.id, r]),
      );
      return rows.map(({ candidate_customer_id, account_customer_id, ...r }) => ({
        ...r,
        candidate: candidate_customer_id ? (byId.get(candidate_customer_id) ?? null) : null,
        account: account_customer_id ? (byId.get(account_customer_id) ?? null) : null,
        actions: account_customer_id ? ['merge', 'reject'] : ['link', 'reject'],
      }));
    });
  }

  @Post('link-reviews/:id/resolve')
  @HttpCode(200)
  @Can('merge', 'customers')
  resolve(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(resolveSchema)) body: z.infer<typeof resolveSchema>) {
    return this.db.as(p, async (db) => {
      const { status } = (
        await db.query<{ status: string }>('SELECT authz.resolve_link_review($1, $2, $3, $4) AS status', [
          id,
          body.action,
          body.customer_id ?? null,
          body.note ?? null,
        ])
      ).rows[0];
      return { status };
    });
  }
}
