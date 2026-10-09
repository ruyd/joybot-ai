import { BadRequestException, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { DbService } from '../db/db.module';
import { FreshdeskService } from './freshdesk.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller()
export class TicketsController {
  constructor(
    private readonly freshdesk: FreshdeskService,
    private readonly db: DbService,
  ) {}

  /**
   * Customers: their own tickets (org admins: `scope=org` for their organization's).
   * Employees: `customer_id` or `organization_id` (members they can access).
   */
  @Get('tickets')
  @Can('read', 'tickets')
  async list(
    @CurrentPrincipal() p: Principal,
    @Query('customer_id') customerId?: string,
    @Query('organization_id') organizationId?: string,
    @Query('scope') scope?: string,
    @Query('status') status?: string,
  ) {
    for (const v of [customerId, organizationId]) if (v && !UUID.test(v)) throw new BadRequestException('Invalid id');
    let ids: string[];
    if (p.type === 'customer') {
      ids = scope === 'org' && p.role === 'org_admin' ? await this.orgMembers(p) : [p.id];
    } else if (customerId) {
      ids = [customerId];
    } else if (organizationId) {
      ids = await this.orgMembers(p, organizationId);
    } else {
      throw new BadRequestException('customer_id or organization_id is required');
    }
    // RLS: only customers this principal can see remain.
    const visible = await this.db.as(p, async (db) =>
      (await db.query<{ id: string }>('SELECT id FROM core.customers WHERE id = ANY($1::uuid[])', [ids])).rows.map((r) => r.id),
    );
    return this.freshdesk.listTickets(p, visible, 'app', status);
  }

  /** `customer_id` (staff) hints whose contacts to refresh when the ticket is opened by direct link. */
  @Get('tickets/:id')
  @Can('read', 'tickets')
  detail(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Query('customer_id') customerId?: string) {
    if (customerId && !UUID.test(customerId)) throw new BadRequestException('Invalid customer_id');
    return this.freshdesk.ticketDetail(p, id, 'app', customerId ? [customerId] : []);
  }

  @Post('admin/settings/freshdesk/test')
  @HttpCode(200)
  @EmployeesOnly()
  @Can('update', 'settings')
  test(@CurrentPrincipal() p: Principal) {
    return this.freshdesk.testConnection(p);
  }

  private orgMembers(p: Principal, organizationId?: string): Promise<string[]> {
    return this.db.as(p, async (db) =>
      (
        await db.query<{ id: string }>(
          organizationId
            ? 'SELECT id FROM core.customers WHERE organization_id = $1'
            : 'SELECT m.id FROM core.customers m JOIN core.customers me ON me.organization_id = m.organization_id WHERE me.id = $1',
          [organizationId ?? p.id],
        )
      ).rows.map((r) => r.id),
    );
  }
}
