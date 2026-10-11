import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import path from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createApp, customer, employee } from './app';

const { customers: C, users: U } = SAMPLE;

let app: INestApplication;
let staffPermissions: { resource: string; action: string; scope: string }[];

beforeAll(async () => {
  app = await createApp();
  staffPermissions = ((await api(app, employee(U.ada)).get('/api/admin/permissions').expect(200)).body as { role: string; resource: string; action: string; scope: string }[])
    .filter((p) => p.role === 'staff')
    .map(({ resource, action, scope }) => ({ resource, action, scope }));
});
afterAll(async () => {
  // Shared settings: put the staff permissions back as they were, and the pages and images too.
  await api(app, employee(U.ada)).put('/api/admin/permissions/staff', { permissions: staffPermissions }).expect(200);
  config({ path: path.resolve(__dirname, '../../../.env') });
  const migrator = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await migrator.connect();
  await migrator.query(`DELETE FROM core.site_pages WHERE slug IN ('spring-offer', 'html-test', 'modules-test')`);
  await migrator.query(`UPDATE core.site_pages SET title = 'About us' WHERE slug = 'about'`);
  await migrator.query('DELETE FROM core.site_assets');
  await migrator.end();
  await app.close();
});

/** No sign-in: what any visitor gets. */
const visitor = () => request(app.getHttpServer());
const admin = () => api(app, employee(U.ada));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

type Page = { id: string; slug: string; title: string; is_home: boolean; published: boolean; modules: Record<string, unknown>[] };

describe('website: the public site', () => {
  it('serves the standard pages to anyone, with what goes in the header and footer', async () => {
    const site = (await visitor().get('/api/site').expect(200)).body as { business_name: string; pages: (Page & { show_in_header: boolean; show_in_footer: boolean })[] };
    expect(site.business_name).toBe('JoyBot Test');
    expect(site.pages.map((p) => p.slug)).toEqual(['home', 'about', 'contact', 'privacy-policy', 'terms']);
    expect(site.pages.filter((p) => p.show_in_header).map((p) => p.slug)).toEqual(['about', 'contact']);
    expect(site.pages.filter((p) => p.show_in_footer).map((p) => p.slug)).toEqual(['contact', 'privacy-policy', 'terms']);

    const home = (await visitor().get('/api/site/home').expect(200)).body as Page;
    expect(home).toMatchObject({ slug: 'home', is_home: true });
    expect(home.modules.map((m) => m.type)).toEqual(['html', 'columns']);
    expect((await visitor().get('/api/site/pages/terms').expect(200)).body.title).toBe('Terms and conditions');
    await visitor().get('/api/site/pages/nope').expect(404);
    await visitor().get('/api/site/pages/..%2Fapi').expect(404);
  });

  it('shows a page only once published; editors see drafts', async () => {
    const draft = (await admin().post('/api/website/pages', { slug: 'spring-offer', title: 'Spring offer' }).expect(201)).body as Page;
    expect(draft.published).toBe(false);
    await visitor().get('/api/site/pages/spring-offer').expect(404);
    expect((await visitor().get('/api/site').expect(200)).body.pages.map((p: Page) => p.slug)).not.toContain('spring-offer');
    expect((await admin().get('/api/website/pages').expect(200)).body.map((p: Page) => p.slug)).toContain('spring-offer');

    await admin().put(`/api/website/pages/${draft.id}`, { published: true, show_in_header: true }).expect(200);
    expect((await visitor().get('/api/site/pages/spring-offer').expect(200)).body.title).toBe('Spring offer');

    await admin().delete(`/api/website/pages/${draft.id}`).expect(204);
    await visitor().get('/api/site/pages/spring-offer').expect(404);
  });
});

describe('website: editing', () => {
  it('cleans HTML: no scripts, handlers, javascript: links or embeds', async () => {
    const page = (
      await admin()
        .post('/api/website/pages', {
          slug: 'html-test',
          title: 'HTML test',
          published: true,
          modules: [
            {
              id: 'm1',
              type: 'html',
              html: '<h2 onclick="x()">Hi</h2><script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">bad</a><a href="https://example.com" target="_blank">ok</a><iframe src="https://evil.example"></iframe><p style="color:red">text</p>',
            },
          ],
        })
        .expect(201)
    ).body as Page;
    const html = page.modules[0].html as string;
    expect(html).toBe('<h2>Hi</h2><img /><a>bad</a><a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a><p>text</p>');
    expect((await visitor().get('/api/site/pages/html-test').expect(200)).body.modules[0].html).toBe(html);
  });

  it('validates modules: video hosts, link schemes, column count, unique ids', async () => {
    const page = (await admin().post('/api/website/pages', { slug: 'modules-test', title: 'Modules' }).expect(201)).body as Page;
    const put = (modules: unknown[]) => admin().put(`/api/website/pages/${page.id}`, { modules });

    await put([{ id: 'v', type: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }]).expect(200);
    await put([{ id: 'v', type: 'video', url: 'https://vimeo.com/76979871' }]).expect(200);
    await put([{ id: 'v', type: 'video', url: 'https://evil.example/video.mp4' }]).expect(400);
    await put([{ id: 'c', type: 'columns', columns: [{ heading: 'A', link_url: 'javascript:alert(1)' }] }]).expect(400);
    await put([{ id: 'c', type: 'columns', columns: [{}, {}, {}, {}, {}] }]).expect(400);
    await put([{ id: 'i', type: 'image', image_id: 'not-a-uuid' }]).expect(400);
    await put([{ id: 'x', type: 'html', html: '' }, { id: 'x', type: 'html', html: '' }]).expect(400);
    await put([{ id: 'x', type: 'marquee' }]).expect(400);

    const saved = (await put([{ id: 'c', type: 'columns', heading: 'Three', columns: [{ heading: 'A', text: '**bold**', link_url: '/portal/book', link_label: 'Book' }, {}, {}] }]).expect(200)).body as Page;
    expect(saved.modules[0]).toMatchObject({ type: 'columns', heading: 'Three' });
  });

  it('keeps addresses unique and clear of the app’s own', async () => {
    await admin().post('/api/website/pages', { slug: 'about', title: 'Again' }).expect(409);
    await admin().post('/api/website/pages', { slug: 'portal', title: 'Portal' }).expect(400);
    await admin().post('/api/website/pages', { slug: 'Not Valid', title: 'x' }).expect(400);
  });

  it('always has one published home page, which cannot be deleted', async () => {
    const pages = (await admin().get('/api/website/pages').expect(200)).body as Page[];
    const home = pages.find((p) => p.is_home)!;
    const about = pages.find((p) => p.slug === 'about')!;
    await admin().put(`/api/website/pages/${home.id}`, { published: false }).expect(400);
    await admin().delete(`/api/website/pages/${home.id}`).expect(400);

    await admin().put(`/api/website/pages/${about.id}`, { is_home: true }).expect(200);
    expect((await visitor().get('/api/site/home').expect(200)).body.slug).toBe('about');
    await admin().put(`/api/website/pages/${home.id}`, { is_home: true }).expect(200); // and back
    expect((await visitor().get('/api/site/home').expect(200)).body.slug).toBe('home');
  });
});

describe('website: images', () => {
  it('uploads checked images and serves them to anyone', async () => {
    const upload = (type: string, body: Buffer, as = employee(U.ada)) =>
      request(app.getHttpServer()).post('/api/website/assets?filename=dot<script>.png').set('x-dev-principal', `${as.type}:${as.id}`).set('content-type', type).send(body);

    const asset = (await upload('image/png', PNG).expect(201)).body as { id: string; filename: string; size_bytes: number };
    expect(asset).toMatchObject({ filename: 'dotscript.png', size_bytes: PNG.length });
    const served = await visitor().get(`/api/site/assets/${asset.id}`).expect(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(served.body).equals(PNG)).toBe(true);

    await upload('image/jpeg', PNG).expect(400); // the bytes are a PNG
    await upload('image/svg+xml', Buffer.from('<svg onload="alert(1)"/>')).expect(400);
    await upload('image/png', Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)])).expect(413);
    await upload('image/png', PNG, employee(U.sam)).expect(403);
    expect((await admin().get('/api/website/assets').expect(200)).body.map((a: { id: string }) => a.id)).toContain(asset.id);
  });
});

describe('website: who may edit', () => {
  it('admins by default; staff once allowed in Access; never customers', async () => {
    const about = ((await admin().get('/api/website/pages').expect(200)).body as Page[]).find((p) => p.slug === 'about')!;
    await api(app, employee(U.sam)).get('/api/website/pages').expect(403);
    await api(app, employee(U.sam)).put(`/api/website/pages/${about.id}`, { title: 'Sam was here' }).expect(403);
    await api(app, customer(C.maria)).get('/api/website/pages').expect(403);

    await admin()
      .put('/api/admin/permissions/staff', { permissions: [...staffPermissions, { resource: 'website', action: 'read', scope: 'all' }, { resource: 'website', action: 'update', scope: 'all' }] })
      .expect(200);
    await api(app, employee(U.sam)).put(`/api/website/pages/${about.id}`, { title: 'About the team' }).expect(200);
    expect((await visitor().get('/api/site/pages/about').expect(200)).body.title).toBe('About the team');
    await api(app, employee(U.sam)).delete(`/api/website/pages/${about.id}`).expect(403); // no delete
  });
});
