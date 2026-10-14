import { Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Pool } from 'pg';
import { Public } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { APP_POOL } from '../db/db.module';
import { SITE_ASSET_STORE, type SiteAssetStore } from './asset-store';
import { bookSalesCallSchema, SalesCallsService, slotsQuerySchema, type BookSalesCall, type SlotsQuery } from './sales-calls.service';
import { SETTINGS_COLUMNS } from './website.service';

const PAGE_COLUMNS = 'slug, title, description, is_home, show_in_header, show_in_footer, sort_order';

/**
 * The public website: published pages and their images, for anyone (no sign-in). Queries run with no
 * principal, so RLS shows only published pages, whoever is browsing.
 */
@Controller('site')
@Public()
export class SiteController {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    @Inject(SITE_ASSET_STORE) private readonly store: SiteAssetStore | null,
    private readonly salesCalls: SalesCallsService,
  ) {}

  /**
   * The site's name (its own, else the business name), the site setup (look and header) and the
   * published pages, for the header and footer.
   */
  @Get()
  async site(@Res({ passthrough: true }) res: Response) {
    const [info, settings, pages] = await Promise.all([
      this.pool.query<{ business_name: string | null }>('SELECT * FROM authz.site_info()'),
      this.pool.query(`SELECT ${SETTINGS_COLUMNS} FROM core.site_settings WHERE id = 1`),
      this.pool.query(`SELECT ${PAGE_COLUMNS} FROM core.site_pages WHERE published ORDER BY sort_order, title`),
    ]);
    res.set('Cache-Control', 'public, max-age=60');
    const business = info.rows[0]?.business_name ?? null;
    return { name: settings.rows[0]?.site_name ?? business, business_name: business, settings: settings.rows[0] ?? null, pages: pages.rows };
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

  /** The booking page (/book-a-call): the sales call and its open start times between `from` and `to`. */
  @Get('sales-call')
  salesCallSlots(@Query(new ZodPipe(slotsQuerySchema)) q: SlotsQuery) {
    return this.salesCalls.slots(q);
  }

  /** A visitor books a sales call (name and email; no sign-in). */
  @Post('sales-call')
  bookSalesCall(@Body(new ZodPipe(bookSalesCallSchema)) body: BookSalesCall) {
    return this.salesCalls.book(body);
  }

  /** An uploaded image. Ids are not guessable; images never change once uploaded, so they cache for good. */
  @Get('assets/:id')
  async asset(@Res() res: Response, @Param('id', ParseUUIDPipe) id: string) {
    const row = (
      await this.pool.query<{ content_type: string; storage: 'db' | 's3'; bytes: Buffer | null }>(
        'SELECT a.content_type, a.storage, d.bytes FROM core.site_assets a LEFT JOIN core.site_asset_data d ON d.asset_id = a.id WHERE a.id = $1',
        [id],
      )
    ).rows[0];
    // In the bucket: send the browser to the CDN (pages normally link there directly).
    if (row?.storage === 's3' && this.store) {
      res.set('Cache-Control', 'public, max-age=86400').redirect(301, this.store.publicUrl(id));
      return;
    }
    if (!row?.bytes) throw new NotFoundException('Image not found');
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
