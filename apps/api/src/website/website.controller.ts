import { createHash } from 'node:crypto';
import { BadRequestException, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req, Body, PayloadTooLargeException } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { insertStatement, setClause } from '../common/sql';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';
import { createPageSchema, updatePageSchema } from './website.schemas';

const LIST_COLUMNS = `p.id, p.slug, p.title, p.description, p.is_home, p.published, p.show_in_header, p.show_in_footer, p.sort_order,
  jsonb_array_length(p.modules) AS module_count, p.updated_at,
  (SELECT nullif(concat_ws(' ', u.first_name, u.last_name), '') FROM core.users u WHERE u.id = p.updated_by) AS updated_by_name`;

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The image types the site accepts, by their first bytes (the declared type must match). */
const SIGNATURES: { type: string; test: (b: Buffer) => boolean }[] = [
  { type: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', test: (b) => b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a' },
  { type: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

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

/** Marketing › Website: the public site's pages (with their modules) and images, for editors. */
@Controller('website')
@EmployeesOnly()
export class WebsiteController {
  constructor(private readonly db: DbService) {}

  @Get('pages')
  @Can('read', 'website')
  list(@CurrentPrincipal() p: Principal) {
    return this.db.as(p, async (db) => (await db.query(`SELECT ${LIST_COLUMNS} FROM core.site_pages p ORDER BY p.is_home DESC, p.sort_order, p.title`)).rows);
  }

  @Get('pages/:id')
  @Can('read', 'website')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.as(p, (db) => this.load(db, id));
  }

  @Post('pages')
  @Can('create', 'website')
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(createPageSchema)) body: z.infer<typeof createPageSchema>) {
    return this.db.as(p, async (db) => {
      const row = { ...body, modules: JSON.stringify(body.modules ?? []), created_by: p.id, updated_by: p.id };
      const q = insertStatement('core.site_pages', row, 'id');
      return this.load(db, (await db.query<{ id: string }>(q.text, q.values)).rows[0].id);
    });
  }

  @Put('pages/:id')
  @Can('update', 'website')
  update(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updatePageSchema)) body: z.infer<typeof updatePageSchema>) {
    return this.db.as(p, async (db) => {
      const current = await this.load(db, id);
      const { is_home, modules, ...fields } = body;
      if ((current.is_home || is_home) && fields.published === false) throw new BadRequestException('The home page is always published');
      if (is_home) {
        // One home page: the current one hands over first (the unique index is not deferrable).
        await db.query('UPDATE core.site_pages SET is_home = false, updated_by = $2 WHERE is_home AND id <> $1', [id, p.id]);
        Object.assign(fields, { published: true });
      }
      const set = setClause({ ...fields, ...(is_home ? { is_home } : {}), ...(modules ? { modules: JSON.stringify(modules) } : {}), updated_by: p.id });
      await db.query(`UPDATE core.site_pages SET ${set.sql} WHERE id = $1`, [id, ...set.values]);
      return this.load(db, id);
    });
  }

  @Delete('pages/:id')
  @Can('delete', 'website')
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.as(p, async (db) => {
      if ((await this.load(db, id)).is_home) throw new BadRequestException('Choose another home page before deleting this one');
      await db.query('DELETE FROM core.site_pages WHERE id = $1', [id]);
    });
  }

  // Images ------------------------------------------------------------------------------------------

  @Get('assets')
  @Can('read', 'website')
  assets(@CurrentPrincipal() p: Principal) {
    return this.db.as(p, async (db) => (await db.query('SELECT id, filename, content_type, size_bytes, created_at FROM core.site_assets ORDER BY created_at DESC LIMIT 200')).rows);
  }

  /** Upload: the image bytes as the body, with its type as Content-Type and `?filename=`. */
  @Post('assets')
  @Can('update', 'website')
  async upload(@CurrentPrincipal() p: Principal, @Req() req: Request, @Query('filename') filename?: string) {
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const signature = SIGNATURES.find((s) => s.type === type);
    if (!signature) throw new BadRequestException('Upload a PNG, JPEG, WebP or GIF image');
    const bytes = await readBody(req, MAX_IMAGE_BYTES);
    if (!bytes.length || !signature.test(bytes)) throw new BadRequestException(`That file is not a ${type.slice(6).toUpperCase()} image`);
    const name = (filename ?? '').replace(/[^\w .()-]/g, '').trim().slice(0, 200) || `image.${type.slice(6)}`;
    return this.db.as(p, async (db) => {
      const asset = (
        await db.query(
          `INSERT INTO core.site_assets (filename, content_type, size_bytes, sha256, created_by) VALUES ($1, $2, $3, $4, $5)
           RETURNING id, filename, content_type, size_bytes, created_at`,
          [name, type, bytes.length, createHash('sha256').update(bytes).digest('hex'), p.id],
        )
      ).rows[0];
      await db.query('INSERT INTO core.site_asset_data (asset_id, bytes) VALUES ($1, $2)', [asset.id, bytes]);
      return asset;
    });
  }

  @Delete('assets/:id')
  @Can('delete', 'website')
  @HttpCode(204)
  async removeAsset(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const deleted = await this.db.as(p, async (db) => (await db.query('DELETE FROM core.site_assets WHERE id = $1', [id])).rowCount);
    if (!deleted) throw new NotFoundException();
  }

  private async load(db: PoolClient, id: string) {
    const page = (await db.query(`SELECT ${LIST_COLUMNS}, p.modules FROM core.site_pages p WHERE p.id = $1`, [id])).rows[0];
    if (!page) throw new NotFoundException();
    return page;
  }
}
