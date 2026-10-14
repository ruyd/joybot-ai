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
  await migrator.query(`DELETE FROM core.site_pages WHERE slug IN ('spring-offer', 'html-test', 'modules-test', 'sections-test', 'big-test')`);
  await migrator.query('DELETE FROM core.site_settings');
  await migrator.query('INSERT INTO core.site_settings (id) VALUES (1)');
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

describe('website: sections and setup', () => {
  it('takes hero, cards, faq and cta modules with section options, and checks them', async () => {
    const page = (await admin().post('/api/website/pages', { slug: 'sections-test', title: 'Sections', published: true }).expect(201)).body as Page;
    const put = (modules: unknown[]) => admin().put(`/api/website/pages/${page.id}`, { modules });
    const hero = { id: 'hero', type: 'hero', badge: 'Open source', eyebrow: 'Meet JoyBot AI', heading: 'Embrace the AI revolution', heading_accent: 'AI revolution', buttons: [{ label: 'Book a call', url: 'mailto:hello@example.com' }, { label: 'Choose your path', url: '#paths' }] };
    const cards = {
      id: 'paths',
      type: 'cards',
      anchor: 'paths',
      background: 'alt',
      eyebrow: 'Two ways',
      heading: 'Build or quickstart',
      heading_accent: 'quickstart',
      intro: 'Either way you **own** it.',
      columns: 2,
      icon_position: 'side',
      items: [
        { icon: 'rocket', eyebrow: 'Path 1', heading: 'Custom build', text: '- Tailored\n- Integrated', link_label: 'Plan it', link_url: '/contact' },
        { icon: 'sparkles', heading: 'Quickstart', text: 'Start fast' },
      ],
    };
    const faq = { id: 'faq', type: 'faq', anchor: 'faq', heading: 'Questions', items: [{ question: 'Is this for me?', answer: 'Yes, **really**.' }] };
    const cta = { id: 'cta', type: 'cta', background: 'accent', heading: 'Your business, your software', buttons: [{ label: 'Talk to us', url: '/contact' }] };

    const saved = (await put([hero, cards, faq, cta]).expect(200)).body as Page;
    expect(saved.modules.map((m) => m.type)).toEqual(['hero', 'cards', 'faq', 'cta']);
    expect(saved.modules[0]).toMatchObject({ badge: 'Open source' });
    expect(saved.modules[1]).toMatchObject({ variant: 'cards', icon_position: 'side', columns: 2, anchor: 'paths', background: 'alt', heading_accent: 'quickstart' });
    expect((await visitor().get('/api/site/pages/sections-test').expect(200)).body.modules[0]).toMatchObject({ heading_accent: 'AI revolution' });

    await put([{ ...hero, heading: '' }]).expect(400); // a hero needs a headline
    await put([{ ...hero, buttons: [...hero.buttons, { label: 'Third', url: '/x' }] }]).expect(400);
    await put([{ ...hero, buttons: [{ label: 'Bad', url: 'javascript:alert(1)' }] }]).expect(400);
    await put([{ ...cards, items: [{ icon: 'skull' }] }]).expect(400); // not in the icon set
    await put([{ ...cards, items: Array.from({ length: 13 }, () => ({ heading: 'x' })) }]).expect(400);
    await put([{ ...cards, columns: 5 }]).expect(400);
    await put([{ ...cards, anchor: 'Not An Anchor' }]).expect(400);
    await put([{ ...faq, items: [] }]).expect(400);
    await put([{ ...cta, heading: undefined }]).expect(400);
    await put([cards, { ...faq, anchor: 'paths' }]).expect(400); // anchors are unique on a page
    await put([{ ...hero, background: 'neon' }]).expect(400);
    await put([{ ...cards, heading_accent: 'x'.repeat(81) }]).expect(400);
    await put([{ ...cards, icon_position: 'left' }]).expect(400);
    // Large cards with a highlighted one, under a left-aligned heading.
    const large = { ...cards, id: 'large', anchor: 'large', variant: 'large', align: 'left', items: [{ heading: 'Path 1' }, { heading: 'Path 2', highlight: true, text: '- one\n\n---\n\n**Best for:** you' }] };
    expect(((await put([large]).expect(200)).body as Page).modules[0]).toMatchObject({ variant: 'large', align: 'left', items: [{ heading: 'Path 1' }, { highlight: true }] });
    await put([{ ...large, align: 'right' }]).expect(400);
    await put([{ ...large, variant: 'huge' }]).expect(400);
    // Badge label, buttons beside the heading, button styles, highlight-color icons.
    const quick = {
      ...cards,
      id: 'joybot',
      anchor: 'joybot',
      align: 'left',
      eyebrow: '★ Open source',
      eyebrow_style: 'badge',
      icon_color: 'highlight',
      buttons_position: 'header',
      buttons: [{ label: 'View on GitHub', url: 'https://github.com/ruyd/joybot-ai', style: 'secondary' }, { label: 'Get JoyBot', url: 'mailto:hello@example.com', style: 'highlight' }],
    };
    expect(((await put([quick]).expect(200)).body as Page).modules[0]).toMatchObject({ eyebrow_style: 'badge', icon_color: 'highlight', buttons_position: 'header', buttons: [{ style: 'secondary' }, { style: 'highlight' }] });
    await put([{ ...quick, eyebrow_style: 'pill' }]).expect(400);
    await put([{ ...quick, buttons: [{ label: 'x', url: '/x', style: 'ghost' }] }]).expect(400);
    await put([{ ...quick, buttons_position: 'top' }]).expect(400);
    // Before and after.
    const compare = {
      id: 'vision',
      type: 'compare',
      background: 'dark',
      before: { label: 'Today', items: [{ label: 'CRM', note: 'per seat' }] },
      after: { label: 'With us', core: 'Your core app + AI', items: [{ label: 'Customers' }] },
    };
    expect(((await put([compare]).expect(200)).body as Page).modules[0]).toMatchObject({ type: 'compare', after: { core: 'Your core app + AI' } });
    await put([{ ...compare, before: { items: [{ label: '' }] } }]).expect(400); // a chip needs a name
    await put([{ ...compare, after: { items: Array.from({ length: 17 }, () => ({ label: 'x' })) } }]).expect(400);
    await put([{ ...compare, before: { items: [], extra: 1 } }]).expect(400);
    await put([{ ...hero, badge: 'x'.repeat(41) }]).expect(400);
    await put([{ ...cta, heading_accent: 'your software' }]).expect(200); // kept even when not in the heading (it just isn't shown)
    // Section options on the original module types too.
    await put([{ id: 'h', type: 'html', anchor: 'about', eyebrow: 'Who we are', heading: 'About', html: '<p>Hi</p>' }]).expect(200);
  });

  it('accepts pages larger than the default body limit', async () => {
    const html = `<p>${'x'.repeat(90_000)}</p>`;
    const modules = [1, 2, 3].map((i) => ({ id: `h${i}`, type: 'html', html }));
    await admin().post('/api/website/pages', { slug: 'big-test', title: 'Big', modules }).expect(201);
  });

  it('keeps the site setup: look and header, for editors to change and anyone to read', async () => {
    const before = (await admin().get('/api/website/settings').expect(200)).body;
    expect(before).toMatchObject({ highlight_color: null, favicon_asset_id: null, site_name: null, business_name: 'JoyBot Test', accent: '#0878ab', accent_to: '#34868f', heading_font: 'system', body_font: 'system', header_links: [], show_customer_login: true, header_button_label: null });

    const logo = (
      await request(app.getHttpServer()).post('/api/website/assets?filename=logo.png').set('x-dev-principal', `employee:${U.ada}`).set('content-type', 'image/png').send(PNG).expect(201)
    ).body as { id: string };
    const saved = (
      await admin()
        .put('/api/website/settings', {
          tagline: 'Software Development',
          logo_asset_id: logo.id,
          favicon_asset_id: logo.id,
          accent: '#6D5DFC',
          accent_to: '#a855f7',
          highlight_color: '#FF7A45',
          heading_font: 'instrument-serif',
          body_font: 'inter',
          header_links: [{ label: 'Services', url: '/#services' }, { label: 'FAQ', url: '/#faq' }],
          header_button_label: "Let's talk",
          header_button_url: 'mailto:hello@example.com',
          show_customer_login: false,
        })
        .expect(200)
    ).body;
    expect(saved).toMatchObject({ highlight_color: '#ff7a45', accent: '#6d5dfc', heading_font: 'instrument-serif', updated_by_name: 'Ada Admin' });

    const site = (await visitor().get('/api/site').expect(200)).body;
    expect(site.settings).toMatchObject({ tagline: 'Software Development', logo_asset_id: logo.id, favicon_asset_id: logo.id, accent: '#6d5dfc', show_customer_login: false, header_links: [{ label: 'Services', url: '/#services' }, { label: 'FAQ', url: '/#faq' }] });
    expect(site.settings.updated_by).toBeUndefined();
    expect(site.name).toBe('JoyBot Test'); // no site name yet: the business name

    // The site's own name, for website editors; blank goes back to the business name.
    expect((await admin().put('/api/website/settings', { site_name: '  appjoy ' }).expect(200)).body).toMatchObject({ site_name: 'appjoy', business_name: 'JoyBot Test' });
    expect((await visitor().get('/api/site').expect(200)).body).toMatchObject({ name: 'appjoy', business_name: 'JoyBot Test' });
    await admin().put('/api/website/settings', { site_name: 'x'.repeat(81) }).expect(400);
    await admin().put('/api/website/settings', { site_name: '' }).expect(200);
    expect((await visitor().get('/api/site').expect(200)).body.name).toBe('JoyBot Test');

    await admin().put('/api/website/settings', { accent: 'purple' }).expect(400);
    await admin().put('/api/website/settings', { highlight_color: 'orange' }).expect(400);
    expect((await admin().put('/api/website/settings', { highlight_color: '' }).expect(200)).body.highlight_color).toBeNull(); // back to the gradient color
    await admin().put('/api/website/settings', { highlight_color: '#ff7a45' }).expect(200);
    await admin().put('/api/website/settings', { heading_font: 'comic-sans' }).expect(400);
    await admin().put('/api/website/settings', { header_links: [{ label: 'x', url: 'javascript:alert(1)' }] }).expect(400);
    await admin().put('/api/website/settings', { header_button_url: null }).expect(400); // the label is still set
    await admin().put('/api/website/settings', { header_button_label: '', header_button_url: '' }).expect(200); // both cleared
    await admin().put('/api/website/settings', { logo_asset_id: '00000000-0000-4000-8000-000000000000' }).expect(400);
    expect((await admin().put('/api/website/settings', { favicon_asset_id: '00000000-0000-4000-8000-000000000000' }).expect(400)).body.message).toMatch(/browser tab icon/);
    await admin().put('/api/website/settings', { unknown: true }).expect(400);

    // Staff as by default (another test here lets them edit pages).
    await admin().put('/api/admin/permissions/staff', { permissions: staffPermissions }).expect(200);
    await api(app, employee(U.sam)).get('/api/website/settings').expect(403);
    await api(app, employee(U.sam)).put('/api/website/settings', { tagline: 'Sam' }).expect(403);
    await api(app, customer(C.maria)).put('/api/website/settings', { tagline: 'Maria' }).expect(403);

    // Deleting the image leaves the site without a logo and favicon rather than broken.
    await admin().delete(`/api/website/assets/${logo.id}`).expect(204);
    expect((await admin().get('/api/website/settings').expect(200)).body).toMatchObject({ logo_asset_id: null, favicon_asset_id: null });
  });
});
