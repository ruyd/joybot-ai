import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, PayloadTooLargeException, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { z } from 'zod';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { createPageSchema, siteSettingsSchema, updatePageSchema, type SiteSettingsInput } from './website.schemas';
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
  constructor(private readonly website: WebsiteService) {}

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
