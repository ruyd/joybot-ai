import { Controller, Get, Query } from "@nestjs/common";
import { z } from "zod";
import {
  Can,
  CurrentPrincipal,
  EmployeesOnly,
  type Principal,
} from "../auth/principal";
import { ZodPipe } from "../common/zod.pipe";
import { DbService } from "../db/db.module";

const listSchema = z
  .object({
    /** Where changes came from: 'mcp' (Claude), 'api' (the app), 'worker', 'stripe_webhook', … */
    via: z
      .string()
      .regex(/^[a-z_]{2,30}$/)
      .optional(),
    table: z
      .string()
      .regex(/^[a-z_]{2,40}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

/** The change log (core.change_log, written by triggers), newest first, one page at a time with the total. */
@Controller("admin/audit")
@EmployeesOnly()
export class AuditController {
  constructor(private readonly db: DbService) {}

  @Get()
  @Can("read", "audit")
  list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>,
  ) {
    return this.db.as(p, async (db) => {
      const filter = [q.via ?? null, q.table ?? null];
      const where = `($1::text IS NULL OR l.changed_via = $1) AND ($2::text IS NULL OR l.table_name = $2)`;
      const { rows } = await db.query(
        `SELECT l.id, l.table_name, l.row_id, l.action, l.changed_by, l.changed_via, l.changed_at, l.diff,
                (SELECT nullif(concat_ws(' ', u.first_name, u.last_name), '') FROM core.users u WHERE u.id = l.changed_by) AS changed_by_name,
                count(*) OVER () AS total
           FROM core.change_log l
          WHERE ${where}
          ORDER BY l.changed_at DESC, l.id DESC
          LIMIT $3 OFFSET $4`,
        [...filter, q.limit, q.offset],
      );
      // Past the last page there are no rows to carry the total: count separately.
      const total = rows.length
        ? Number(rows[0].total)
        : Number(
            (
              await db.query(
                `SELECT count(*) AS n FROM core.change_log l WHERE ${where}`,
                filter,
              )
            ).rows[0].n,
          );
      return { items: rows.map(({ total: _t, ...r }) => r), total };
    });
  }
}
