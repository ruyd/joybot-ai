import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, PayloadTooLargeException, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { z } from 'zod';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { previewSchema, templateCreateSchema, templateUpdateSchema, thankYouSchema, type Preview, type TemplateCreate, type TemplateUpdate, type ThankYou } from '../email/templates';
import { createPageSchema, siteSettingsSchema, updatePageSchema, type SiteSettingsInput } from './website.schemas';
import {
  assignSchema,
  listSalesCallsSchema,
  outcomeSchema,
  setStatusSchema,
  rescheduleSchema,
  salesCallSettingsSchema,
  SalesCallsService,
  type Assign,
  type ListSalesCalls,
  type Outcome,
  type SetStatus,
  type Reschedule,
  type SalesCallSettingsInput,
} from './sales-calls.service';
import { reportSchema, SiteAnalyticsService, type ReportQuery } from './analytics.service';
import { imageType, MAX_IMAGE_BYTES, WebsiteService } from './website.service';

/** Reads an upload's bytes (image types have no body parser), up to `max`. */
async function readBody(req: Request, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new PayloadTooLargeException(`Images can be up to ${max / 1024 / 1024} MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Marketing › Website: the public site's pages (with their modules), images and setup, for editors. */
@Controller('website')
@EmployeesOnly()
export class WebsiteController {
  constructor(
    private readonly website: WebsiteService,
    private readonly salesCalls: SalesCallsService,
    private readonly analytics: SiteAnalyticsService,
  ) {}

  /** Visits to the public site: daily totals, top pages, sources, devices and countries for the last `days` days. */
  @Get('analytics')
  @Can('read', 'website')
  analyticsReport(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(reportSchema)) q: ReportQuery) {
    return this.analytics.report(p, q);
  }

  /** Visitors and views today and this week, for the dashboard. */
  @Get('analytics/summary')
  @Can('read', 'website')
  analyticsSummary(@CurrentPrincipal() p: Principal) {
    return this.analytics.summary(p);
  }

  /** Sales calls booked on the site, a page at a time with the total: `when=upcoming|past`, `q` searches. */
  @Get('sales-calls')
  @Can('read', 'website')
  salesCallList(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(listSalesCallsSchema)) q: ListSalesCalls) {
    return this.salesCalls.list(p, q);
  }

  /** The booking page's setup: title, description, length, hours, hosts. */
  @Get('sales-call-settings')
  @Can('read', 'website')
  salesCallSettings(@CurrentPrincipal() p: Principal) {
    return this.salesCalls.getSettings(p);
  }

  @Put('sales-call-settings')
  @Can('update', 'website')
  updateSalesCallSettings(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(salesCallSettingsSchema)) body: SalesCallSettingsInput) {
    return this.salesCalls.updateSettings(p, body);
  }

  /** Moves a booked call to another open time; emails the visitor unless `notify: false`. */
  @Post('sales-calls/:id/reschedule')
  @HttpCode(200)
  @Can('update', 'website')
  rescheduleSalesCall(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(rescheduleSchema)) body: Reschedule) {
    return this.salesCalls.reschedule(p, id, body);
  }

  @Get('sales-calls/:id')
  @Can('read', 'website')
  salesCall(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.salesCalls.get(p, id);
  }

  // Sales call emails -------------------------------------------------------------------------

  /** Templates of a kind: the confirmation (one) or the thank-you presets. */
  @Get('email-templates')
  @Can('read', 'website')
  emailTemplates(@CurrentPrincipal() p: Principal, @Query('kind') kind?: string) {
    if (kind !== 'sales_call_confirmation' && kind !== 'sales_call_thank_you') throw new BadRequestException('kind is sales_call_confirmation or sales_call_thank_you');
    return this.salesCalls.templates(p, kind);
  }

  /** A new thank-you preset. */
  @Post('email-templates')
  @Can('update', 'website')
  createEmailTemplate(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(templateCreateSchema)) body: TemplateCreate) {
    return this.salesCalls.createThankYouPreset(p, body);
  }

  @Put('email-templates/:id')
  @Can('update', 'website')
  updateEmailTemplate(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(templateUpdateSchema)) body: TemplateUpdate) {
    return this.salesCalls.updateTemplate(p, id, body);
  }

  @Delete('email-templates/:id')
  @HttpCode(204)
  @Can('update', 'website')
  async deleteEmailTemplate(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await this.salesCalls.deleteThankYouPreset(p, id);
  }

  /** A subject and body filled in for a call (or a sample call). */
  @Post('email-templates/preview')
  @HttpCode(200)
  @Can('read', 'website')
  previewEmail(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(previewSchema)) body: Preview) {
    return this.salesCalls.preview(p, body);
  }

  /** Emails the visitor a thank-you and records it on the call. */
  @Post('sales-calls/:id/thank-you')
  @HttpCode(200)
  @Can('update', 'website')
  sendThankYou(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(thankYouSchema)) body: ThankYou) {
    return this.salesCalls.sendThankYou(p, id, body);
  }

  /** Hands a booked call to a free employee (`user_id`), or unassigns it (null). */
  @Put('sales-calls/:id/assign')
  @Can('update', 'website')
  assignSalesCall(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(assignSchema)) body: Assign) {
    return this.salesCalls.assign(p, id, body);
  }

  /** Logs a call's outcome (follow up, conversion, potential, do not call) with notes. */
  @Post('sales-calls/:id/outcome')
  @HttpCode(200)
  @Can('update', 'website')
  salesCallOutcome(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(outcomeSchema)) body: Outcome) {
    return this.salesCalls.outcome(p, id, body);
  }

  /** Marks a call completed or a no-show, or confirmed again. */
  @Put('sales-calls/:id/status')
  @Can('update', 'website')
  salesCallStatus(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(setStatusSchema)) body: SetStatus) {
    return this.salesCalls.setStatus(p, id, body);
  }

  @Post('sales-calls/:id/cancel')
  @HttpCode(200)
  @Can('update', 'website')
  cancelSalesCall(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.salesCalls.cancel(p, id);
  }

  @Get('pages')
  @Can('read', 'website')
  list(@CurrentPrincipal() p: Principal) {
    return this.website.listPages(p);
  }

  @Get('pages/:id')
  @Can('read', 'website')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.website.getPage(p, id);
  }

  @Post('pages')
  @Can('create', 'website')
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(createPageSchema)) body: z.infer<typeof createPageSchema>) {
    return this.website.createPage(p, body);
  }

  @Put('pages/:id')
  @Can('update', 'website')
  update(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updatePageSchema)) body: z.infer<typeof updatePageSchema>) {
    return this.website.updatePage(p, id, body);
  }

  @Delete('pages/:id')
  @Can('delete', 'website')
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await this.website.deletePage(p, id);
  }

  // Images ------------------------------------------------------------------------------------------

  @Get('assets')
  @Can('read', 'website')
  assets(@CurrentPrincipal() p: Principal) {
    return this.website.listAssets(p);
  }

  /** Upload: the image bytes as the body, with its type as Content-Type and `?filename=`. */
  @Post('assets')
  @Can('update', 'website')
  async upload(@CurrentPrincipal() p: Principal, @Req() req: Request, @Query('filename') filename?: string) {
    const type = imageType(req.headers['content-type'] ?? '');
    return this.website.uploadAsset(p, type, await readBody(req, MAX_IMAGE_BYTES), filename);
  }

  /** After switching to a bucket (SITE_ASSET_STORE=s3): moves the images still kept in the database. */
  @Post('assets/move')
  @Can('update', 'website')
  @HttpCode(200)
  moveAssets(@CurrentPrincipal() p: Principal) {
    return this.website.moveAssetsToStore(p);
  }

  @Delete('assets/:id')
  @Can('delete', 'website')
  @HttpCode(204)
  async removeAsset(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await this.website.deleteAsset(p, id);
  }

  // Site setup --------------------------------------------------------------------------------------

  @Get('settings')
  @Can('read', 'website')
  settings(@CurrentPrincipal() p: Principal) {
    return this.website.getSettings(p);
  }

  @Put('settings')
  @Can('update', 'website')
  updateSettings(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(siteSettingsSchema)) body: SiteSettingsInput) {
    return this.website.updateSettings(p, body);
  }
}
