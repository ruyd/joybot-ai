import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ACTIONS, RESOURCES, type Resource } from '@joybot/access';
import { z } from 'zod';
import { PermissionsService } from '../auth/permissions.service';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';

/** Staff can be tuned by admins, but never given admin-level powers (plan.md §4.2). */
const STAFF_SCOPES = ['all', 'location', 'assigned', 'own', 'recorded'] as const;
const STAFF_FORBIDDEN: Partial<Record<Resource, readonly string[]>> = {
  access: ['create', 'update', 'delete'],
  users: ['create', 'update', 'delete'],
  settings: ['update'],
  payments: ['void', 'refund'],
};

const staffPermissionsSchema = z
  .object({
    permissions: z
      .array(
        z
          .object({ resource: z.enum(RESOURCES), action: z.enum(ACTIONS), scope: z.enum(STAFF_SCOPES) })
          .strict(),
      )
      .max(500),
  })
  .strict();

const assignmentSchema = z
  .object({
    user_id: z.string().uuid(),
    organization_id: z.string().uuid().optional(),
    customer_id: z.string().uuid().optional(),
    ends_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((a) => Boolean(a.organization_id) !== Boolean(a.customer_id), {
    message: 'provide exactly one of organization_id or customer_id',
  });

const MAX_GRANT_DAYS = 90;
const grantSchema = z
  .object({
    user_id: z.string().uuid(),
    resource: z.enum(['customer', 'organization']),
    record_id: z.string().uuid(),
    actions: z.array(z.enum(['read', 'create', 'update'])).min(1).max(3),
    reason: z.string().trim().min(3).max(500),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict();

@Controller('admin')
@EmployeesOnly()
export class AccessController {
  constructor(
    private readonly db: DbService,
    private readonly permissions: PermissionsService,
  ) {}

  // Permissions ------------------------------------------------------------------------------

  @Get('permissions')
  @Can('read', 'access')
  listPermissions(@CurrentPrincipal() p: Principal) {
    return this.db.as(p, async (db) =>
      (await db.query('SELECT role, resource, action, scope FROM core.role_permissions ORDER BY role, resource, action, scope')).rows,
    );
  }

  /** Replaces the staff permission set. Admin, org_admin and customer permissions are fixed. */
  @Put('permissions/staff')
  @Can('update', 'access')
  async replaceStaffPermissions(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(staffPermissionsSchema)) body: z.infer<typeof staffPermissionsSchema>,
  ) {
    for (const perm of body.permissions) {
      if (STAFF_FORBIDDEN[perm.resource]?.includes(perm.action)) {
        throw new BadRequestException(`Staff cannot be allowed to ${perm.action} ${perm.resource}`);
      }
      if (perm.scope === 'recorded' && !(perm.resource === 'payments' && perm.action === 'update')) {
        throw new BadRequestException('Scope "recorded" only applies to updating payments');
      }
    }
    const rows = await this.db.as(p, async (db) => {
      await db.query(`DELETE FROM core.role_permissions WHERE role = 'staff'`);
      await db.query(
        `INSERT INTO core.role_permissions (role, resource, action, scope)
         SELECT DISTINCT 'staff', r, a, s FROM unnest($1::text[], $2::text[], $3::text[]) AS t(r, a, s)`,
        [body.permissions.map((x) => x.resource), body.permissions.map((x) => x.action), body.permissions.map((x) => x.scope)],
      );
      return (
        await db.query(`SELECT role, resource, action, scope FROM core.role_permissions WHERE role = 'staff' ORDER BY resource, action, scope`)
      ).rows;
    });
    this.permissions.invalidate();
    return rows;
  }

  // Assignments (employee ↔ organization / customer) ---------------------------------------

  @Get('assignments')
  @Can('read', 'access')
  listAssignments(
    @CurrentPrincipal() p: Principal,
    @Query('user_id') userId?: string,
    @Query('organization_id') orgId?: string,
    @Query('customer_id') customerId?: string,
    @Query('active') active?: string,
  ) {
    const where: string[] = [];
    const args: unknown[] = [];
    for (const [col, v] of [['user_id', userId], ['organization_id', orgId], ['customer_id', customerId]] as const) {
      if (v) {
        if (!z.string().uuid().safeParse(v).success) throw new BadRequestException(`${col} must be a UUID`);
        args.push(v);
        where.push(`${col} = $${args.length}`);
      }
    }
    if (active !== 'false') where.push('starts_at <= now() AND (ends_at IS NULL OR ends_at > now())');
    return this.db.as(p, async (db) =>
      (
        await db.query(
          `SELECT * FROM core.assignments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`,
          args,
        )
      ).rows,
    );
  }

  @Post('assignments')
  @Can('update', 'access')
  createAssignment(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(assignmentSchema)) body: z.infer<typeof assignmentSchema>) {
    return this.db.as(p, async (db) => {
      await this.assertActiveEmployee(db, body.user_id);
      return (
        await db.query(
          `INSERT INTO core.assignments (user_id, organization_id, customer_id, ends_at, created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [body.user_id, body.organization_id ?? null, body.customer_id ?? null, body.ends_at ?? null, p.id],
        )
      ).rows[0];
    });
  }

  /** Ends an assignment now (kept for history rather than deleted). */
  @Post('assignments/:id/end')
  @Can('update', 'access')
  async endAssignment(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.db.as(p, async (db) =>
      (
        await db.query(
          `UPDATE core.assignments SET ends_at = greatest(starts_at, now())
            WHERE id = $1 AND (ends_at IS NULL OR ends_at > now()) RETURNING *`,
          [id],
        )
      ).rows[0],
    );
    if (!row) throw new NotFoundException('Active assignment not found');
    return row;
  }

  // Record grants -----------------------------------------------------------------------------

  @Get('record-grants')
  @Can('read', 'access')
  listGrants(@CurrentPrincipal() p: Principal, @Query('user_id') userId?: string, @Query('record_id') recordId?: string) {
    const where = ['(expires_at IS NULL OR expires_at > now())'];
    const args: unknown[] = [];
    for (const [col, v] of [['user_id', userId], ['record_id', recordId]] as const) {
      if (v) {
        if (!z.string().uuid().safeParse(v).success) throw new BadRequestException(`${col} must be a UUID`);
        args.push(v);
        where.push(`${col} = $${args.length}`);
      }
    }
    return this.db.as(p, async (db) =>
      (await db.query(`SELECT * FROM core.record_grants WHERE ${where.join(' AND ')} ORDER BY created_at DESC`, args)).rows,
    );
  }

  /** Temporary, audited access to one customer or organization (max 90 days). */
  @Post('record-grants')
  @Can('update', 'access')
  createGrant(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(grantSchema)) body: z.infer<typeof grantSchema>) {
    const expires = new Date(body.expires_at).getTime();
    if (expires <= Date.now()) throw new BadRequestException('expires_at must be in the future');
    if (expires > Date.now() + MAX_GRANT_DAYS * 86_400_000) {
      throw new BadRequestException(`Grants can last at most ${MAX_GRANT_DAYS} days`);
    }
    return this.db.as(p, async (db) => {
      await this.assertActiveEmployee(db, body.user_id);
      const table = body.resource === 'customer' ? 'core.customers' : 'core.organizations';
      if (!(await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [body.record_id])).rowCount) {
        throw new NotFoundException(`${body.resource} not found`);
      }
      return (
        await db.query(
          `INSERT INTO core.record_grants (user_id, resource, record_id, actions, reason, granted_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [body.user_id, body.resource, body.record_id, body.actions, body.reason, p.id, body.expires_at],
        )
      ).rows[0];
    });
  }

  @Post('record-grants/:id/revoke')
  @Can('update', 'access')
  async revokeGrant(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.db.as(p, async (db) =>
      (
        await db.query(
          `UPDATE core.record_grants SET expires_at = now()
            WHERE id = $1 AND (expires_at IS NULL OR expires_at > now()) RETURNING *`,
          [id],
        )
      ).rows[0],
    );
    if (!row) throw new NotFoundException('Active grant not found');
    return row;
  }

  private async assertActiveEmployee(db: import('pg').PoolClient, userId: string) {
    const u = (await db.query<{ active: boolean }>('SELECT active FROM core.users WHERE id = $1', [userId])).rows[0];
    if (!u) throw new NotFoundException('Employee not found');
    if (!u.active) throw new BadRequestException('Employee is inactive');
  }
}
