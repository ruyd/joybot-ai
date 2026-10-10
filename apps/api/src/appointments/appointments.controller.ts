import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { Can, CurrentPrincipal, CustomersOnly, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import {
  AppointmentsService,
  createAppointmentSchema,
  listAppointmentsSchema,
  requestAppointmentSchema,
  reviewRequestSchema,
  updateAppointmentSchema,
  type CreateAppointment,
  type ListAppointments,
  type RequestAppointment,
  type ReviewRequest,
  type UpdateAppointment,
} from './appointments.service';

@Controller('appointments')
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  /** Employees: appointments in scope (filters, `mine=true`). Customers/org admins: their own / org's. */
  @Get()
  @Can('read', 'appointments')
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(listAppointmentsSchema)) q: ListAppointments) {
    return this.appointments.list(p, q);
  }

  /** Review page: customer booking requests waiting for confirmation. */
  @Get('requests')
  @EmployeesOnly()
  @Can('update', 'appointments')
  requests(@CurrentPrincipal() p: Principal) {
    return this.appointments.requests(p);
  }

  /** Customers request an appointment for themselves (self-booking page). */
  @Post('requests')
  @CustomersOnly()
  request(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(requestAppointmentSchema)) body: RequestAppointment) {
    return this.appointments.request(p, body);
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @CustomersOnly()
  withdraw(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.appointments.withdraw(p, id);
  }

  @Post(':id/review')
  @HttpCode(200)
  @EmployeesOnly()
  @Can('update', 'appointments')
  review(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(reviewRequestSchema)) body: ReviewRequest) {
    return this.appointments.review(p, id, body);
  }

  @Get(':id')
  @Can('read', 'appointments')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.appointments.get(p, id);
  }

  @Post()
  @EmployeesOnly()
  @Can('create', 'appointments')
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(createAppointmentSchema)) body: CreateAppointment) {
    return this.appointments.create(p, body);
  }

  @Put(':id')
  @EmployeesOnly()
  @Can('update', 'appointments')
  update(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateAppointmentSchema)) body: UpdateAppointment,
  ) {
    return this.appointments.update(p, id, body);
  }
}
