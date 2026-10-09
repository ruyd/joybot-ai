import { Controller, ForbiddenException, Get, NotFoundException } from '@nestjs/common';
import { CurrentPrincipal, CustomersOnly, type Principal } from '../auth/principal';
import { DbService } from '../db/db.module';

/** Organization area for org admins (plan.md §7): their organization and its members (RLS). */
@Controller('org')
@CustomersOnly()
export class OrgController {
  constructor(private readonly db: DbService) {}

  @Get()
  async get(@CurrentPrincipal() p: Principal) {
    if (p.role !== 'org_admin') throw new ForbiddenException('Only organization admins can see the organization');
    return this.db.as(p, async (db) => {
      const organization = (
        await db.query(
          `SELECT o.id, o.org_number, o.name, o.email, o.phone
             FROM core.organizations o JOIN core.customers me ON me.organization_id = o.id WHERE me.id = $1`,
          [p.id],
        )
      ).rows[0];
      if (!organization) throw new NotFoundException();
      const members = (
        await db.query(
          `SELECT id, customer_number, first_name, last_name, email, phone, org_role, status, cognito_sub IS NOT NULL AS has_login
             FROM core.customers WHERE organization_id = $1 ORDER BY org_role = 'org_admin' DESC, last_name, first_name`,
          [organization.id],
        )
      ).rows;
      return { organization, members };
    });
  }
}
