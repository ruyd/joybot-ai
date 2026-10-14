import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Request } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Principal } from '../auth/principal';
import { APP_POOL, DbService } from '../db/db.module';

/** A page view the public site sends (POST /api/site/view): the path, and on arrival where it came from. */
export const viewSchema = z
  .object({
    path: z.string().max(200).regex(/^\/[^?#]*$/),
    /** document.referrer, sent on the first view of a visit only. */
    referrer: z.string().max(500).optional(),
    /** The ?utm_source= of the page the visit arrived on. */
    utm_source: z.string().max(100).optional(),
  })
  .strict();
export type View = z.infer<typeof viewSchema>;

export const reportSchema = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).strict();
export type ReportQuery = z.infer<typeof reportSchema>;

interface Event {
  at: string;
  ident: string;
  path: string;
  source: string | null;
  device: 'desktop' | 'mobile' | 'tablet';
  country: string;
}

/** Areas of the app that are not the public website, and never counted. */
const NOT_SITE = /^\/(staff|portal|auth|api|assets)(\/|$)/;
const BOTS = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|curl|wget|python|axios|node-fetch|go-http|java\//i;
const FLUSH_MS = 60_000;
/** At most this many views wait for the next write; more in a minute are dropped (a flood, not visitors). */
const MAX_BUFFERED = 10_000;
/** Views one visitor can add in a minute (someone reloading in a loop counts once a second at most). */
const MAX_PER_VISITOR = 60;

export function deviceOf(userAgent: string): Event['device'] {
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(userAgent)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android/i.test(userAgent)) return 'mobile';
  return 'desktop';
}

/** Where a visit came from: its campaign, else the other site's host. Null for direct visits and moves within this site. */
export function sourceOf(view: View, siteHosts: string[]): string | null {
  const utm = view.utm_source?.trim().toLowerCase();
  if (utm) return utm.slice(0, 100);
  if (!view.referrer) return null;
  try {
    const host = new URL(view.referrer).hostname.toLowerCase().replace(/^www\./, '');
    return host && !siteHosts.includes(host) ? host : null;
  } catch {
    return null;
  }
}

/**
 * Website analytics without cookies or a third party. The public site reports each page view to the
 * API, which counts them in memory and adds them to daily totals once a minute in one call
 * (authz.record_site_visits), so a busy site costs the database one small write a minute. Unique
 * visitors are told apart for a day only, by a salted hash the database forgets the next day.
 */
@Injectable()
export class SiteAnalyticsService implements OnModuleDestroy {
  private readonly logger = new Logger('SiteAnalytics');
  private buffer: Event[] = [];
  private perVisitor = new Map<string, number>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly db: DbService,
  ) {
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.flush();
  }

  /** Counts one page view, unless it is a bot, not the public site, or one visitor flooding. */
  record(req: Request, view: View) {
    const ua = req.get('user-agent') ?? '';
    if (!ua || BOTS.test(ua) || NOT_SITE.test(view.path)) return;
    const ip = req.get('cf-connecting-ip') ?? req.get('x-forwarded-for')?.split(',')[0].trim() ?? req.socket.remoteAddress ?? '';
    const ident = `${ip}|${ua}`;
    const seen = this.perVisitor.get(ident) ?? 0;
    if (seen >= MAX_PER_VISITOR || this.buffer.length >= MAX_BUFFERED) return;
    this.perVisitor.set(ident, seen + 1);
    // The site's own hosts (where the request came from), so moving between its pages isn't a source.
    const origin = req.get('origin') ?? req.get('referer');
    const hosts = [req.hostname, origin ? safeHost(origin) : ''].filter(Boolean).map((h) => h.replace(/^www\./, ''));
    const country = (req.get('cf-ipcountry') ?? '').toUpperCase();
    this.buffer.push({
      at: new Date().toISOString(),
      ident,
      path: view.path.length > 1 ? view.path.replace(/\/+$/, '') : view.path,
      source: sourceOf(view, hosts),
      device: deviceOf(ua),
      country: /^[A-Z]{2}$/.test(country) && country !== 'XX' && country !== 'T1' ? country : '',
    });
  }

  /** Adds the waiting views to the daily totals (every minute, and on shutdown). */
  async flush() {
    const events = this.buffer;
    this.buffer = [];
    this.perVisitor = new Map();
    if (!events.length) return;
    try {
      await this.pool.query('SELECT authz.record_site_visits($1::jsonb)', [JSON.stringify(events)]);
    } catch (err) {
      // Lost views are only lost counts; keep a failed batch for the next try while there is room.
      this.logger.warn(`Could not save ${events.length} page views: ${(err as Error).message}`);
      if (this.buffer.length + events.length <= MAX_BUFFERED) this.buffer.unshift(...events);
    }
  }

  /** Visitors and views today and this week (from Monday), for the staff dashboard. */
  summary(p: Principal) {
    return this.db.as(p, async (db) => {
      const r = await db.query(
        `WITH t AS (SELECT (now() AT TIME ZONE coalesce((SELECT default_time_zone FROM core.settings WHERE id = 1), 'UTC'))::date AS today)
         SELECT coalesce(sum(views) FILTER (WHERE day = t.today), 0)::int AS today_views,
                coalesce(sum(visitors) FILTER (WHERE day = t.today), 0)::int AS today_visitors,
                coalesce(sum(views), 0)::int AS week_views,
                coalesce(sum(visitors), 0)::int AS week_visitors
         FROM t LEFT JOIN core.site_visit_days d ON d.day BETWEEN date_trunc('week', t.today)::date AND t.today
         GROUP BY t.today`,
      );
      const row = r.rows[0];
      return { today: { views: row.today_views, visitors: row.today_visitors }, week: { views: row.week_views, visitors: row.week_visitors } };
    });
  }

  /** The last `days` days (today included): totals with the period before, each day, and the top pages, sources, devices and countries. */
  report(p: Principal, { days }: ReportQuery) {
    return this.db.as(p, async (db) => {
      const today = (
        await db.query<{ today: string }>(
          `SELECT (now() AT TIME ZONE coalesce((SELECT default_time_zone FROM core.settings WHERE id = 1), 'UTC'))::date::text AS today`,
        )
      ).rows[0].today;
      const range = [today, days];
      const from = `($1::date - ($2::int - 1))`;
      // One connection: one query at a time.
      const daily = await db.query(
        `SELECT g.day::date::text AS day, coalesce(d.views, 0) AS views, coalesce(d.visitors, 0) AS visitors
         FROM generate_series(${from}, $1::date, interval '1 day') g(day) LEFT JOIN core.site_visit_days d ON d.day = g.day::date ORDER BY 1`,
        range,
      );
      const previous = await db.query(
        `SELECT coalesce(sum(views), 0)::int AS views, coalesce(sum(visitors), 0)::int AS visitors FROM core.site_visit_days
         WHERE day BETWEEN ${from} - $2::int AND ${from} - 1`,
        range,
      );
      const pages = await db.query(`SELECT path, sum(views)::int AS views FROM core.site_visit_pages WHERE day BETWEEN ${from} AND $1 GROUP BY path ORDER BY 2 DESC, 1 LIMIT 20`, range);
      const sources = await db.query(`SELECT source, sum(visits)::int AS visits FROM core.site_visit_sources WHERE day BETWEEN ${from} AND $1 GROUP BY source ORDER BY 2 DESC, 1 LIMIT 20`, range);
      const devices = await db.query(`SELECT device, sum(visitors)::int AS visitors FROM core.site_visit_devices WHERE day BETWEEN ${from} AND $1 GROUP BY device ORDER BY 2 DESC, 1`, range);
      const countries = await db.query(`SELECT country, sum(visitors)::int AS visitors FROM core.site_visit_countries WHERE day BETWEEN ${from} AND $1 GROUP BY country ORDER BY 2 DESC, 1 LIMIT 20`, range);
      const sum = (k: 'views' | 'visitors') => daily.rows.reduce((n, d) => n + Number(d[k]), 0);
      return {
        days,
        today,
        totals: { views: sum('views'), visitors: sum('visitors') },
        previous: previous.rows[0],
        daily: daily.rows,
        pages: pages.rows,
        sources: sources.rows,
        devices: devices.rows,
        countries: countries.rows,
      };
    });
  }
}

function safeHost(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}
