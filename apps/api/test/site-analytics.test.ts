import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import path from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviceOf, SiteAnalyticsService, sourceOf } from '../src/website/analytics.service';
import { api, createApp, customer, employee } from './app';

const { customers: C, users: U } = SAMPLE;

let app: INestApplication;
let migrator: Client;

beforeAll(async () => {
  app = await createApp();
  config({ path: path.resolve(__dirname, '../../../.env') });
  migrator = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await migrator.connect();
});
afterAll(async () => {
  for (const t of ['site_visit_days', 'site_visit_pages', 'site_visit_sources', 'site_visit_devices', 'site_visit_countries', 'site_visit_salts', 'site_visitors_seen']) {
    await migrator.query(`DELETE FROM core.${t}`);
  }
  await migrator.end();
  await app.close();
});

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const view = (body: Record<string, unknown>, { ua = CHROME, ip = '203.0.113.7', country = 'US' } = {}) =>
  request(app.getHttpServer())
    .post('/api/site/view')
    .set('user-agent', ua)
    .set('cf-connecting-ip', ip)
    .set('cf-ipcountry', country)
    .set('origin', 'https://example.com')
    .send(body);
const flush = () => app.get(SiteAnalyticsService).flush();

describe('site analytics', () => {
  it('counts views and daily visitors without storing who they are', async () => {
    await view({ path: '/', referrer: 'https://www.google.com/search?q=x' }).expect(204);
    await view({ path: '/about' }).expect(204);
    await view({ path: '/about/' }).expect(204);
    await view({ path: '/', utm_source: 'Newsletter' }, { ua: IPHONE, ip: '198.51.100.4', country: 'MX' }).expect(204);
    // Not counted: bots, other areas of the app, moves within the site.
    await view({ path: '/' }, { ua: 'Googlebot/2.1 (+http://www.google.com/bot.html)' }).expect(204);
    await view({ path: '/staff/customers' }).expect(204);
    await view({ path: '/contact', referrer: 'https://example.com/about' }).expect(204);
    await flush();
    // The same visitor later in the day is not new.
    await view({ path: '/' }).expect(204);
    await flush();

    const r = (await api(app, employee(U.ada)).get('/api/website/analytics?days=7').expect(200)).body;
    expect(r.totals).toEqual({ views: 6, visitors: 2 });
    expect(r.daily).toHaveLength(7);
    expect(r.daily.at(-1)).toMatchObject({ day: r.today, views: 6, visitors: 2 });
    expect(r.pages).toEqual([
      { path: '/', views: 3 },
      { path: '/about', views: 2 },
      { path: '/contact', views: 1 },
    ]);
    expect(r.sources).toEqual([
      { source: 'google.com', visits: 1 },
      { source: 'newsletter', visits: 1 },
    ]);
    expect(r.devices).toEqual([
      { device: 'desktop', visitors: 1 },
      { device: 'mobile', visitors: 1 },
    ]);
    expect(r.countries).toEqual([
      { country: 'MX', visitors: 1 },
      { country: 'US', visitors: 1 },
    ]);

    const summary = (await api(app, employee(U.ada)).get('/api/website/analytics/summary').expect(200)).body;
    expect(summary.today).toEqual({ views: 6, visitors: 2 });
    expect(summary.week.views).toBeGreaterThanOrEqual(6);

    // Only salted hashes of today's (and yesterday's) visitors are kept, never addresses or browsers.
    const seen = (await migrator.query('SELECT day, hash FROM core.site_visitors_seen')).rows;
    expect(seen).toHaveLength(2);
    expect(JSON.stringify(seen)).not.toContain('203.0.113.7');
  });

  it('rejects bad views', async () => {
    await view({ path: 'about' }).expect(400);
    await view({ path: '/?q=1' }).expect(400);
    await view({ path: '/', extra: 1 }).expect(400);
  });

  it('is for website readers only', async () => {
    await api(app, employee(U.sam)).get('/api/website/analytics').expect(403);
    await api(app, employee(U.sam)).get('/api/website/analytics/summary').expect(403);
    await api(app, customer(C.maria)).get('/api/website/analytics').expect(403);
    await request(app.getHttpServer()).get('/api/website/analytics').expect(401);
    await api(app, employee(U.ada)).get('/api/website/analytics?days=0').expect(400);
  });

  it('the API role cannot write totals except through the counting function', async () => {
    const appDb = new Client({ connectionString: process.env.APP_DATABASE_URL });
    await appDb.connect();
    try {
      await expect(appDb.query(`INSERT INTO core.site_visit_days (day, views) VALUES ('2020-01-01', 1)`)).rejects.toMatchObject({ code: '42501' });
      await expect(appDb.query('SELECT * FROM core.site_visit_salts')).rejects.toMatchObject({ code: '42501' });
      await expect(appDb.query('SELECT * FROM core.site_visitors_seen')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await appDb.end();
    }
  });
});

describe('privacy policy', () => {
  it('the standard policy says how visits are counted', async () => {
    const page = (await request(app.getHttpServer()).get('/api/site/pages/privacy-policy').expect(200)).body;
    const html = page.modules[0].html as string;
    expect(html).toContain('<h2>Visits to our website</h2>');
    expect(html.indexOf('Visits to our website')).toBeLessThan(html.indexOf('How we use it'));
  });
});

describe('helpers', () => {
  it('tells devices apart', () => {
    expect(deviceOf(CHROME)).toBe('desktop');
    expect(deviceOf(IPHONE)).toBe('mobile');
    expect(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
    expect(deviceOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari')).toBe('mobile');
    expect(deviceOf('Mozilla/5.0 (Linux; Android 14; SM-X710) Safari')).toBe('tablet');
  });

  it('finds where a visit came from', () => {
    expect(sourceOf({ path: '/', referrer: 'https://www.facebook.com/' }, ['example.com'])).toBe('facebook.com');
    expect(sourceOf({ path: '/', referrer: 'https://example.com/x' }, ['example.com'])).toBeNull();
    expect(sourceOf({ path: '/', utm_source: ' Spring ', referrer: 'https://x.com' }, [])).toBe('spring');
    expect(sourceOf({ path: '/', referrer: 'not a url' }, [])).toBeNull();
  });
});
