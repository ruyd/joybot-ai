import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import {
  AppointmentsService,
  createAppointmentSchema,
  listAppointmentsSchema,
  updateAppointmentSchema,
  type CreateAppointment,
  type ListAppointments,
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
