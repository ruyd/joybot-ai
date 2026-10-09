import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import {
  assignSchema,
  createManualPaymentSchema,
  duplicateCheckSchema,
  listSchema,
  markReceivedSchema,
  refundSchema,
  updateManualPaymentSchema,
  voidSchema,
  type CreateManualPayment,
  type DuplicateCheck,
  type ListPayments,
  type UpdateManualPayment,
} from './payments.schemas';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** Employees: payments in scope. Customers: their own (customer-safe columns). */
  @Get()
  @Can('read', 'payments')
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(listSchema)) q: ListPayments) {
    return this.payments.list(p, q);
  }

  @Get('pending-transfers')
  @EmployeesOnly()
  @Can('read', 'payments')
  pendingTransfers(@CurrentPrincipal() p: Principal) {
    return this.payments.pendingTransfers(p);
  }

  @Get(':id')
  @Can('read', 'payments')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.get(p, id);
  }

  @Post('check-duplicates')
  @HttpCode(200)
  @EmployeesOnly()
  @Can('create', 'payments')
  checkDuplicates(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(duplicateCheckSchema)) body: DuplicateCheck) {
    return this.payments.checkDuplicates(p, body);
  }

  @Post()
  @EmployeesOnly()
  @Can('create', 'payments')
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(createManualPaymentSchema)) body: CreateManualPayment) {
    return this.payments.createManual(p, body);
  }

  @Put(':id')
  @EmployeesOnly()
  @Can('update', 'payments')
  update(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateManualPaymentSchema)) body: UpdateManualPayment,
  ) {
    return this.payments.updateManual(p, id, body);
  }

  @Post(':id/mark-received')
  @HttpCode(200)
  @EmployeesOnly()
  @Can('update', 'payments')
  markReceived(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(markReceivedSchema)) body: { bank_reference: string; paid_at: string },
  ) {
    return this.payments.markReceived(p, id, body.bank_reference, body.paid_at);
  }

  /** Unmatched Stripe payment → customer (plan.md §4.4 unmatched queue). */
  @Post(':id/assign')
  @HttpCode(200)
  @EmployeesOnly()
  @Can('update', 'payments')
  assign(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(assignSchema)) body: { customer_id: string; appointment_id?: string },
  ) {
    return this.payments.assignStripePayment(p, id, body.customer_id, body.appointment_id);
  }

  @Post(':id/void')
  @HttpCode(200)
  @EmployeesOnly()
  @Can('void', 'payments')
  void(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(voidSchema)) body: { reason: string }) {
    return this.payments.voidPayment(p, id, body.reason);
  }

  @Post(':id/refund')
  @HttpCode(200)
  @EmployeesOnly()
  @Can('refund', 'payments')
  refund(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(refundSchema)) body: { amount: number; reason: string },
  ) {
    return this.payments.refund(p, id, body.amount, body.reason);
  }
}
