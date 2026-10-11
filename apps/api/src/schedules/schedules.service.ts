import { ForbiddenException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Principal } from '../auth/principal';
import { DbService } from '../db/db.module';

export const timeOffSchema = z
  .object({
    starts_at: z.string().datetime({ offset: true }),
    ends_at: z.string().datetime({ offset: true }),
    reason: z.string().trim().max(200).optional(),
  })
  .strict()
  .refine((t) => Date.parse(t.ends_at) > Date.parse(t.starts_at), { message: 'ends_at must be after starts_at', path: ['ends_at'] });

export type TimeOff = z.infer<typeof timeOffSchema>;

/** Schedule writes shared by the API and the MCP tools ('schedules' resource; RLS enforces it). */
@Injectable()
export class SchedulesService {
  constructor(private readonly db: DbService) {}

  addTimeOff(p: Principal, userId: string, body: TimeOff) {
    return this.db.as(p, async (db) => {
      if (!(await this.mayChange(db, userId, 'create'))) throw new ForbiddenException('Not allowed to change this schedule');
      return (
        await db.query(
          `INSERT INTO core.time_off (user_id, starts_at, ends_at, reason, created_by) VALUES ($1, $2, $3, $4, $5)
           RETURNING id, starts_at, ends_at, reason`,
          [userId, body.starts_at, body.ends_at, body.reason || null, p.id],
        )
      ).rows[0];
    });
  }

  async mayChange(db: PoolClient, userId: string, action: 'create' | 'update' = 'update'): Promise<boolean> {
    return (await db.query<{ ok: boolean }>('SELECT authz.schedule_in_scope($1, $2) AS ok', [userId, action])).rows[0].ok;
  }
}
