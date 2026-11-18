import { Body, Controller, Delete, Get, HttpCode, Param, ParseEnumPipe, ParseIntPipe, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import {
  aiKeySchema,
  AiService,
  CAPABILITIES,
  connectionSchema,
  JOB_STATUSES,
  newJobSchema,
  modelUpdateSchema,
  newConnectionSchema,
  newModelSchema,
  slotSchema,
  type Capability,
  type ConnectionInput,
  type JobInput,
  type ModelInput,
  type SlotInput,
} from './ai.service';

/** Settings › AI (admins): connections to providers, their models, the slot per capability, the call log and tests. */
@Controller('admin/ai')
@EmployeesOnly()
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get()
  @Can('update', 'settings')
  overview(@CurrentPrincipal() p: Principal) {
    return this.ai.overview(p);
  }

  @Post('connections')
  @Can('update', 'settings')
  createConnection(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(newConnectionSchema)) body: ConnectionInput) {
    return this.ai.createConnection(p, body);
  }

  @Put('connections/:id')
  @Can('update', 'settings')
  updateConnection(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(connectionSchema)) body: ConnectionInput) {
    return this.ai.updateConnection(p, id, body);
  }

  @Delete('connections/:id')
  @HttpCode(204)
  @Can('update', 'settings')
  deleteConnection(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.ai.deleteConnection(p, id);
  }

  /** Stores the connection's API key (kept encrypted, never shown again). */
  @Put('connections/:id/api-key')
  @Can('update', 'settings')
  setKey(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(aiKeySchema)) body: { api_key: string }) {
    return this.ai.setKey(p, id, body.api_key);
  }

  @Delete('connections/:id/api-key')
  @Can('update', 'settings')
  removeKey(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.ai.removeKey(p, id);
  }

  /** Checks the address and key (lists the provider's models; costs nothing). */
  @Post('connections/:id/test')
  @HttpCode(200)
  @Can('update', 'settings')
  testConnection(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.ai.testConnection(p, id);
  }

  @Post('models')
  @Can('update', 'settings')
  createModel(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(newModelSchema)) body: ModelInput) {
    return this.ai.createModel(p, body);
  }

  @Put('models/:id')
  @Can('update', 'settings')
  updateModel(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(modelUpdateSchema)) body: ModelInput) {
    return this.ai.updateModel(p, id, body);
  }

  @Delete('models/:id')
  @HttpCode(204)
  @Can('update', 'settings')
  deleteModel(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.ai.deleteModel(p, id);
  }

  /** One short prompt (General) or a spoken sentence (text to speech) from this model. */
  @Post('models/:id/test')
  @HttpCode(200)
  @Can('update', 'settings')
  testModel(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.ai.testModel(p, id);
  }

  @Put('slots/:capability')
  @Can('update', 'settings')
  updateSlot(
    @CurrentPrincipal() p: Principal,
    @Param('capability', new ParseEnumPipe(Object.fromEntries(CAPABILITIES.map((c) => [c, c])))) capability: Capability,
    @Body(new ZodPipe(slotSchema)) body: SlotInput,
  ) {
    return this.ai.updateSlot(p, capability, body);
  }

  /** Queues a job for a capability delivered through the Postgres queue (the worker runs it). */
  @Post('jobs')
  @Can('update', 'settings')
  enqueue(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(newJobSchema)) body: JobInput) {
    return this.ai.enqueue(p, body);
  }

  @Get('jobs')
  @Can('update', 'settings')
  jobs(
    @CurrentPrincipal() p: Principal,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 50,
    @Query('status', new ParseEnumPipe(Object.fromEntries(JOB_STATUSES.map((s) => [s, s])), { optional: true })) status?: (typeof JOB_STATUSES)[number],
  ) {
    return this.ai.jobs(p, Math.min(Math.max(limit, 1), 200), status);
  }

  @Get('jobs/:id')
  @Can('update', 'settings')
  job(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.ai.job(p, id);
  }

  @Post('jobs/:id/retry')
  @HttpCode(200)
  @Can('update', 'settings')
  retryJob(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.ai.jobAction(p, id, 'retry');
  }

  @Post('jobs/:id/cancel')
  @HttpCode(200)
  @Can('update', 'settings')
  cancelJob(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.ai.jobAction(p, id, 'cancel');
  }

  /** The latest calls: model, tokens or characters, cost, time and result (no prompt or reply text). */
  @Get('calls')
  @Can('update', 'settings')
  calls(@CurrentPrincipal() p: Principal, @Query('limit', new ParseIntPipe({ optional: true })) limit = 50) {
    return this.ai.calls(p, Math.min(Math.max(limit, 1), 200));
  }
}
