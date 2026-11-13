import { Controller, Get } from '@nestjs/common';
import { CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { DbService } from '../db/db.module';

/** The business's "today" and Monday of this week, in its own time zone (like the analytics). */
const DAYS = `WITH tz AS (SELECT coalesce((SELECT default_time_zone FROM core.settings WHERE id = 1), 'UTC') AS zone),
  d AS (SELECT zone, (now() AT TIME ZONE zone)::date AS today FROM tz)`;

export interface DashboardSummary {
  currency: string;
  /** Open = waiting on staff; pending = waiting on the customer. Only with tickets read. */
  tickets?: { open: number; pending: number; oldest_open_at: string | null };
  /** Collected = succeeded payments less refunds, in the default currency. Only with payments read. */
  payments?: { collected_week: string; collected_last_week: string; pending_transfers: number };
  /** Sent invoices past their due date. Only with payments read. */
  invoices?: { overdue_total: string; overdue_count: number; overdue_names: string[] };
}

/**
 * The staff dashboard's summary numbers. Every query runs as the employee, so RLS limits them to
 * the records they may see, and each section appears only with the matching permission.
 */
@Controller('dashboard')
@EmployeesOnly()
export class DashboardController {
  constructor(private readonly db: DbService) {}

  @Get()
  summary(@CurrentPrincipal() p: Principal): Promise<DashboardSummary> {
    const tickets = p.access.can('read', 'tickets');
    const payments = p.access.can('read', 'payments');
    return this.db.as(p, async (db) => {
      const currency =
        (await db.query<{ currency: string }>(`SELECT coalesce((SELECT default_currency FROM core.settings WHERE id = 1), 'USD') AS currency`)).rows[0]
          ?.currency ?? 'USD';
      const out: DashboardSummary = { currency };

      if (tickets) {
        const r = await db.query<{ open: number; pending: number; oldest_open_at: Date | null }>(
          `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
                  count(*) FILTER (WHERE status = 'pending')::int AS pending,
                  min(created_at) FILTER (WHERE status IN ('open', 'pending')) AS oldest_open_at
             FROM core.tickets`,
        );
        const t = r.rows[0];
        out.tickets = { open: t.open, pending: t.pending, oldest_open_at: t.oldest_open_at?.toISOString() ?? null };
      }

      if (payments) {
        // This week from Monday until now, and last week over the same stretch (Monday until a week ago).
        const r = await db.query<{ week: string; last_week: string; pending: number }>(
          `${DAYS},
           w AS (SELECT (date_trunc('week', today)::timestamp AT TIME ZONE zone) AS start FROM d)
           SELECT coalesce(sum(p.amount - p.amount_refunded) FILTER (WHERE p.paid_at >= w.start), 0)::text AS week,
                  coalesce(sum(p.amount - p.amount_refunded)
                           FILTER (WHERE p.paid_at >= w.start - interval '7 days' AND p.paid_at < now() - interval '7 days'), 0)::text AS last_week,
                  (SELECT count(*)::int FROM core.v_pending_bank_transfers) AS pending
             FROM w LEFT JOIN core.payments p
               ON p.status IN ('succeeded', 'partially_refunded') AND p.currency = $1 AND p.paid_at >= w.start - interval '7 days'
            GROUP BY w.start`,
          [currency],
        );
        const row = r.rows[0];
        out.payments = { collected_week: row.week, collected_last_week: row.last_week, pending_transfers: row.pending };

        // Names through RLS: the organization's, else the customer's; null when not visible.
        const inv = await db.query<{ total: string; n: number; names: (string | null)[] }>(
          `${DAYS}
           SELECT coalesce(sum(greatest(i.total - i.amount_paid, 0)), 0)::text AS total, count(*)::int AS n,
                  coalesce(array_agg(DISTINCT coalesce(o.name, nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '')))
                           FILTER (WHERE coalesce(o.name, c.first_name, c.last_name) IS NOT NULL), '{}') AS names
             FROM d, core.invoices i
             LEFT JOIN core.customers c ON c.id = i.customer_id
             LEFT JOIN core.organizations o ON o.id = c.organization_id
            WHERE i.status = 'sent' AND i.due_on < d.today AND i.currency = $1`,
          [currency],
        );
        const v = inv.rows[0];
        out.invoices = { overdue_total: v.total, overdue_count: v.n, overdue_names: v.names.filter((n): n is string => Boolean(n)).sort() };
      }
      return out;
    });
  }
}
