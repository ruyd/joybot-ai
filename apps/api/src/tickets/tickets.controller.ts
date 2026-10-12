import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Put, Query } from '@nestjs/common';
import { Can, CurrentPrincipal, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';
import { createSchema, replySchema, TicketsService, updateSchema, type CreateTicket, type ReplyTicket, type UpdateTicket } from './tickets.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Support tickets: customers' requests and staff replies (RLS decides scope). */
@Controller('tickets')
export class TicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly db: DbService,
  ) {}

  /**
   * Customers: their own tickets (org admins: `scope=org` for their organization's).
   * Employees: every ticket they can see, or one customer's (`customer_id`) or organization's
   * (`organization_id`); `assigned=me|none|<id>` and `status` filter.
   */
  @Get()
  @Can('read', 'tickets')
  async list(
    @CurrentPrincipal() p: Principal,
    @Query('customer_id') customerId?: string,
    @Query('organization_id') organizationId?: string,
    @Query('scope') scope?: string,
    @Query('status') status?: string,
    @Query('assigned') assigned?: string,
  ) {
    for (const v of [customerId, organizationId]) if (v && !UUID.test(v)) throw new BadRequestException('Invalid id');
    if (assigned && assigned !== 'me' && assigned !== 'none' && !UUID.test(assigned)) throw new BadRequestException('Invalid assigned');
    let customerIds: string[] | undefined;
    if (p.type === 'customer') {
      customerIds = scope === 'org' && p.role === 'org_admin' ? await this.orgMembers(p) : [p.id];
    } else if (customerId) {
      customerIds = [customerId];
    } else if (organizationId) {
      customerIds = await this.orgMembers(p, organizationId);
    }
    return this.tickets.list(p, {
      customerIds,
      status: status || undefined,
      assignedTo: p.type === 'employee' && assigned ? (assigned === 'me' ? p.id : assigned) : undefined,
    });
  }

  /** Staff a ticket can be assigned to (active employees), for staff who may change tickets. */
  @Get('assignees')
  @Can('update', 'tickets')
  assignees(@CurrentPrincipal() p: Principal) {
    if (p.type !== 'employee') throw new ForbiddenException();
    return this.db.as(p, async (db) => (await db.query('SELECT id, first_name, last_name FROM core.v_staff_public ORDER BY first_name, last_name')).rows);
  }

  @Get(':number')
  @Can('read', 'tickets')
  detail(@CurrentPrincipal() p: Principal, @Param('number') number: string) {
    return this.tickets.detail(p, number);
  }

  @Post()
  @Can('create', 'tickets')
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(createSchema)) body: CreateTicket) {
    return this.tickets.create(p, body);
  }

  @Post(':number/messages')
  @Can('update', 'tickets')
  reply(@CurrentPrincipal() p: Principal, @Param('number') number: string, @Body(new ZodPipe(replySchema)) body: ReplyTicket) {
    return this.tickets.reply(p, number, body);
  }

  @Put(':number')
  @Can('update', 'tickets')
  update(@CurrentPrincipal() p: Principal, @Param('number') number: string, @Body(new ZodPipe(updateSchema)) body: UpdateTicket) {
    return this.tickets.update(p, number, body);
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
