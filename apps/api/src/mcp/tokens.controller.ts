import { createHash, randomBytes } from 'node:crypto';
import { Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    expires_in_days: z.number().int().min(1).max(365).default(90),
  })
  .strict();

/**
 * Personal access tokens for the MCP endpoint (migration 0026). Admins create tokens for
 * themselves; every admin sees every token (to spot and revoke a leaked one). The token is returned
 * once, at creation; only its sha256 is stored.
 */
@Controller('admin/api-tokens')
@EmployeesOnly()
export class TokensController {
  constructor(private readonly db: DbService) {}

  @Get()
  list(@CurrentPrincipal() p: Principal) {
    this.adminOnly(p);
    return this.db.as(p, async (db) =>
      (
        await db.query(
          `SELECT t.id, t.name, t.prefix, t.scope, t.created_at, t.expires_at, t.last_used_at, t.revoked_at, t.user_id,
                  (t.user_id = $1) AS mine,
                  (SELECT nullif(concat_ws(' ', u.first_name, u.last_name), '') FROM core.users u WHERE u.id = t.user_id) AS owner_name,
                  (t.revoked_at IS NULL AND t.expires_at > now()) AS active
             FROM app.api_tokens t
            ORDER BY (t.revoked_at IS NULL AND t.expires_at > now()) DESC, t.created_at DESC`,
          [p.id],
        )
      ).rows,
    );
  }

  @Post()
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    this.adminOnly(p);
    const token = `jbt_${randomBytes(32).toString('base64url')}`;
    const hash = createHash('sha256').update(token).digest('hex');
    return this.db.as(p, async (db) => {
      const row = (
        await db.query(
          `INSERT INTO app.api_tokens (user_id, name, token_hash, prefix, expires_at)
           VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))
           RETURNING id, name, prefix, scope, created_at, expires_at`,
          [p.id, body.name, hash, token.slice(0, 12), body.expires_in_days],
        )
      ).rows[0];
      return { ...row, token };
    });
  }

  @Post(':id/revoke')
  @HttpCode(204)
  async revoke(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    this.adminOnly(p);
    const n = await this.db.as(
      p,
      async (db) => (await db.query('UPDATE app.api_tokens SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL', [id, p.id])).rowCount,
    );
    if (!n) throw new NotFoundException();
  }

  /** The database enforces this too (RLS); the check gives a clear 403. */
  private adminOnly(p: Principal) {
    if (p.role !== 'admin') throw new ForbiddenException('Only admins manage access tokens');
  }
}
