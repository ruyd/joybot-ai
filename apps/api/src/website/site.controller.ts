import { Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Pool } from 'pg';
import { Public } from '../auth/principal';
import { APP_POOL } from '../db/db.module';

const PAGE_COLUMNS = 'slug, title, description, is_home, show_in_header, show_in_footer, sort_order';

/**
 * The public website: published pages and their images, for anyone (no sign-in). Queries run with no
 * principal, so RLS shows only published pages, whoever is browsing.
 */
@Controller('site')
@Public()
export class SiteController {
  constructor(@Inject(APP_POOL) private readonly pool: Pool) {}

  /** The business name and the published pages, for the header and footer. */
  @Get()
  async site(@Res({ passthrough: true }) res: Response) {
    const [info, pages] = await Promise.all([
      this.pool.query<{ business_name: string | null }>('SELECT * FROM authz.site_info()'),
      this.pool.query(`SELECT ${PAGE_COLUMNS} FROM core.site_pages WHERE published ORDER BY sort_order, title`),
    ]);
    res.set('Cache-Control', 'public, max-age=60');
    return { business_name: info.rows[0]?.business_name ?? null, pages: pages.rows };
  }

  @Get('home')
  home(@Res({ passthrough: true }) res: Response) {
    return this.page(res, 'is_home');
  }

  @Get('pages/:slug')
  bySlug(@Res({ passthrough: true }) res: Response, @Param('slug') slug: string) {
    if (!/^[a-z0-9-]{1,60}$/.test(slug)) throw new NotFoundException('Page not found');
    return this.page(res, 'slug = $1', [slug]);
  }

  /** An uploaded image. Ids are not guessable; images never change once uploaded, so they cache for good. */
  @Get('assets/:id')
  async asset(@Res() res: Response, @Param('id', ParseUUIDPipe) id: string) {
    const row = (
      await this.pool.query<{ content_type: string; bytes: Buffer }>(
        'SELECT a.content_type, d.bytes FROM core.site_assets a JOIN core.site_asset_data d ON d.asset_id = a.id WHERE a.id = $1',
        [id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException('Image not found');
    res
      .set({
        'Content-Type': row.content_type,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
      })
      .send(row.bytes);
  }

  private async page(res: Response, where: string, args: unknown[] = []) {
    const page = (await this.pool.query(`SELECT ${PAGE_COLUMNS}, modules, updated_at FROM core.site_pages WHERE published AND ${where}`, args)).rows[0];
    if (!page) throw new NotFoundException('Page not found');
    res.set('Cache-Control', 'public, max-age=60');
    return page;
  }
}
