import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import type { Principal } from '../auth/principal';
import { insertStatement, setClause } from '../common/sql';
import { DbService } from '../db/db.module';
import type { createPageSchema, SiteSettingsInput, updatePageSchema } from './website.schemas';

const LIST_COLUMNS = `p.id, p.slug, p.title, p.description, p.is_home, p.published, p.show_in_header, p.show_in_footer, p.sort_order,
  jsonb_array_length(p.modules) AS module_count, p.updated_at,
  (SELECT nullif(concat_ws(' ', u.first_name, u.last_name), '') FROM core.users u WHERE u.id = p.updated_by) AS updated_by_name`;

/** Site setup columns, as editors and the public site get them. */
export const SETTINGS_COLUMNS = `tagline, logo_asset_id, accent, accent_to, heading_font, body_font, header_links,
  header_button_label, header_button_url, show_customer_login`;

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The image types the site accepts, by their first bytes (the declared type must match). */
const SIGNATURES: { type: string; test: (b: Buffer) => boolean }[] = [
  { type: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', test: (b) => b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a' },
  { type: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

/** The image type a declared Content-Type stands for, or a 400 when the site does not take it. */
export function imageType(contentType: string): string {
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (!SIGNATURES.some((s) => s.type === type)) throw new BadRequestException('Upload a PNG, JPEG, WebP or GIF image');
  return type;
}

/**
 * Marketing › Website for editors: pages (with their modules), images and site setup. Shared by the
 * web app's controller and the MCP tools, so both go through the same rules.
 */
@Injectable()
export class WebsiteService {
  constructor(private readonly db: DbService) {}

  listPages(p: Principal) {
    return this.db.as(p, async (db) => (await db.query(`SELECT ${LIST_COLUMNS} FROM core.site_pages p ORDER BY p.is_home DESC, p.sort_order, p.title`)).rows);
  }

  getPage(p: Principal, id: string) {
    return this.db.as(p, (db) => this.load(db, id));
  }

  /** A page by its address (drafts too, for editors). */
  async getPageBySlug(p: Principal, slug: string) {
    const id = await this.db.as(p, async (db) => (await db.query<{ id: string }>('SELECT id FROM core.site_pages WHERE slug = $1', [slug])).rows[0]?.id);
    if (!id) throw new NotFoundException('No page with that address');
    return this.getPage(p, id);
  }

  createPage(p: Principal, body: z.infer<typeof createPageSchema>) {
    return this.db.as(p, async (db) => {
      const row = { ...body, modules: JSON.stringify(body.modules ?? []), created_by: p.id, updated_by: p.id };
      const q = insertStatement('core.site_pages', row, 'id');
      return this.load(db, (await db.query<{ id: string }>(q.text, q.values)).rows[0].id);
    });
  }

  updatePage(p: Principal, id: string, body: z.infer<typeof updatePageSchema>) {
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

  async deletePage(p: Principal, id: string) {
    await this.db.as(p, async (db) => {
      if ((await this.load(db, id)).is_home) throw new BadRequestException('Choose another home page before deleting this one');
      await db.query('DELETE FROM core.site_pages WHERE id = $1', [id]);
    });
  }

  // Images ------------------------------------------------------------------------------------------

  listAssets(p: Principal) {
    return this.db.as(p, async (db) => (await db.query('SELECT id, filename, content_type, size_bytes, created_at FROM core.site_assets ORDER BY created_at DESC LIMIT 200')).rows);
  }

  /** Stores an image after checking its bytes are the declared type (`imageType`). */
  uploadAsset(p: Principal, type: string, bytes: Buffer, filename?: string) {
    const signature = SIGNATURES.find((s) => s.type === type);
    if (!signature) throw new BadRequestException('Upload a PNG, JPEG, WebP or GIF image');
    if (bytes.length > MAX_IMAGE_BYTES) throw new BadRequestException(`Images can be up to ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
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

  async deleteAsset(p: Principal, id: string) {
    const deleted = await this.db.as(p, async (db) => (await db.query('DELETE FROM core.site_assets WHERE id = $1', [id])).rowCount);
    if (!deleted) throw new NotFoundException();
  }

  // Site setup --------------------------------------------------------------------------------------

  getSettings(p: Principal) {
    return this.db.as(p, (db) => this.loadSettings(db));
  }

  updateSettings(p: Principal, body: SiteSettingsInput) {
    return this.db.as(p, async (db) => {
      const current = await this.loadSettings(db);
      const label = body.header_button_label !== undefined ? body.header_button_label : current.header_button_label;
      const url = body.header_button_url !== undefined ? body.header_button_url : current.header_button_url;
      if ((label === null) !== (url === null)) throw new BadRequestException('A header button needs both a label and a link');
      if (body.logo_asset_id && !(await db.query('SELECT 1 FROM core.site_assets WHERE id = $1', [body.logo_asset_id])).rowCount) {
        throw new BadRequestException('Choose an uploaded image for the logo');
      }
      const { header_links, ...fields } = body;
      const set = setClause({ ...fields, ...(header_links ? { header_links: JSON.stringify(header_links) } : {}), updated_by: p.id });
      await db.query(`UPDATE core.site_settings SET ${set.sql} WHERE id = $1`, [1, ...set.values]);
      return this.loadSettings(db);
    });
  }

  private async loadSettings(db: PoolClient) {
    return (
      await db.query(
        `SELECT ${SETTINGS_COLUMNS}, updated_at,
                (SELECT nullif(concat_ws(' ', u.first_name, u.last_name), '') FROM core.users u WHERE u.id = s.updated_by) AS updated_by_name
           FROM core.site_settings s WHERE s.id = 1`,
      )
    ).rows[0];
  }

  private async load(db: PoolClient, id: string) {
    const page = (await db.query(`SELECT ${LIST_COLUMNS}, p.modules FROM core.site_pages p WHERE p.id = $1`, [id])).rows[0];
    if (!page) throw new NotFoundException();
    return page;
  }
}
