import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import type { z } from 'zod';
import { Can, CurrentPrincipal, CustomersOnly, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { draftSchema, InvoicesService, listSchema, sendSchema, updateSchema, voidSchema } from './invoices.service';

/** HTTP routes for invoices; the logic is in InvoicesService (shared with the MCP tools). */
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @Can('read', 'payments')
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    return this.invoices.list(p, q);
  }

  /** One invoice with its lines and payments; for customers also how they can pay. */
  @Get(':id')
  @Can('read', 'payments')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.get(p, id);
  }

  @Post()
  @EmployeesOnly()
  @Can('create', 'payments')
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(draftSchema)) body: z.infer<typeof draftSchema>) {
    return this.invoices.create(p, body);
  }

  /** Drafts only: fields, and the lines replaced when given. */
  @Put(':id')
  @EmployeesOnly()
  @Can('create', 'payments')
  update(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>) {
    return this.invoices.update(p, id, body);
  }

  @Delete(':id')
  @EmployeesOnly()
  @Can('create', 'payments')
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await this.invoices.remove(p, id);
  }

  /** Sends a draft: it shows in the customer's portal, and they get an email when they have one. */
  @Post(':id/send')
  @EmployeesOnly()
  @Can('create', 'payments')
  send(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(sendSchema)) body: z.infer<typeof sendSchema>) {
    return this.invoices.send(p, id, body);
  }

  @Post(':id/void')
  @EmployeesOnly()
  @Can('create', 'payments')
  void(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(voidSchema)) body: z.infer<typeof voidSchema>) {
    return this.invoices.void(p, id, body);
  }

  /** Customers: a Stripe Checkout page for what is still due. */
  @Post(':id/checkout')
  @CustomersOnly()
  pay(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.pay(p, id);
  }
}
