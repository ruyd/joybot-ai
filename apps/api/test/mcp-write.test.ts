import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import path from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MESSAGE_SENDER, type MessageSender, type OutgoingMessage } from '../src/messaging/messaging.service';
import { api, createApp, employee } from './app';

const { customers: C, locations: L, services: S, users: U } = SAMPLE;

class CapturingSender implements MessageSender {
  sent: OutgoingMessage[] = [];
  async send(m: OutgoingMessage) {
    this.sent.push(m);
    return {};
  }
}

const sender = new CapturingSender();
let app: INestApplication;
let migrator: Client;
let seq = 0;
let rw: string; // read-and-write token
let ro: string; // read-only token

beforeAll(async () => {
  app = await createApp({ overrides: [{ token: MESSAGE_SENDER, value: sender }] });
  config({ path: path.resolve(__dirname, '../../../.env') });
  migrator = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await migrator.connect();
  rw = (await api(app, employee(U.ada)).post('/api/admin/api-tokens', { name: 'Claude writes', scope: 'read_write' }).expect(201)).body.token;
  ro = (await api(app, employee(U.ada)).post('/api/admin/api-tokens', { name: 'Claude reads' }).expect(201)).body.token;
});
afterAll(async () => {
  // Shared database: remove what the tools created.
  await migrator.query(`DELETE FROM core.payments WHERE invoice_id IS NOT NULL OR notes_internal = 'mcp test'`);
  await migrator.query('DELETE FROM core.invoices');
  await migrator.query(`DELETE FROM core.appointments WHERE notes_customer = 'mcp test'`);
  await migrator.query(`DELETE FROM core.tasks WHERE title LIKE 'mcp test%'`);
  await migrator.query(`DELETE FROM core.time_off WHERE reason = 'mcp test'`);
  await migrator.query(`DELETE FROM core.site_pages WHERE slug LIKE 'mcp-%'`);
  await migrator.query('DELETE FROM core.site_assets');
  await migrator.query('DELETE FROM core.site_settings');
  await migrator.query('INSERT INTO core.site_settings (id) VALUES (1)');
  await migrator.query('DELETE FROM app.api_tokens');
  await migrator.end();
  await app.close();
});

const rpc = (token: string, method: string, params: Record<string, unknown> = {}) =>
  request(app.getHttpServer())
    .post('/api/mcp')
    .set('accept', 'application/json, text/event-stream')
    .set('content-type', 'application/json')
    .set('mcp-protocol-version', '2025-06-18')
    .set('authorization', `Bearer ${token}`)
    .send({ jsonrpc: '2.0', id: ++seq, method, params });

const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const res = (await rpc(token, 'tools/call', { name, arguments: args }).expect(200)).body;
  const r = res.result ?? { isError: true, content: [{ text: JSON.stringify(res.error) }] };
  const text = r.content[0].text as string;
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // plain-text error
  }
  // Tool results are JSON of many shapes: tests read the fields they check.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { isError: Boolean(r.isError), data: data as any };
};

/** A UTC instant `days` ahead at `hour`:00 UTC (16 UTC is midday in New York). */
const at = (days: number, hour: number) => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

describe('MCP write tools', () => {
  it('only read-and-write tokens get them, with honest hints', async () => {
    const roTools = (await rpc(ro, 'tools/list').expect(200)).body.result.tools.map((t: { name: string }) => t.name);
    expect(roTools).not.toContain('create_todo');
    expect((await call(ro, 'create_todo', { title: 'mcp test: nope' })).isError).toBe(true);

    const tools = (await rpc(rw, 'tools/list').expect(200)).body.result.tools as { name: string; annotations: Record<string, boolean> }[];
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    for (const name of ['book_appointment', 'reschedule_appointment', 'cancel_appointment', 'create_todo', 'set_todo_done', 'add_time_off', 'create_invoice_draft', 'send_invoice', 'void_invoice', 'record_payment', 'create_site_page', 'update_site_page', 'set_site_module', 'remove_site_module', 'delete_site_page', 'update_site_setup', 'upload_site_image']) {
      expect(by[name]).toMatchObject({ readOnlyHint: false });
    }
    expect(by.cancel_appointment.destructiveHint).toBe(true);
    expect(by.void_invoice.destructiveHint).toBe(true);
    expect(by.send_invoice.openWorldHint).toBe(true);
    expect(by.delete_site_page.destructiveHint).toBe(true);
    expect(by.get_site_page.readOnlyHint).toBe(true);
    expect(roTools).toEqual(expect.arrayContaining(['list_site_pages', 'get_site_page', 'get_site_setup']));
    expect(roTools).not.toContain('update_site_setup');
    expect(by.find_customers.readOnlyHint).toBe(true); // the read tools are still there
    expect((await call(rw, 'whoami')).data.token).toMatchObject({ scope: 'read and write' });
  });

  it('writes run as the admin and show up in the audit log as MCP changes', async () => {
    const todo = (await call(rw, 'create_todo', { title: 'mcp test: call Maria', customer_id: C.maria })).data as { id: string; assigned_to: string };
    expect(todo.assigned_to).toBe(U.ada);
    expect((await call(rw, 'set_todo_done', { todo_id: todo.id, done: true })).data).toMatchObject({ completed_by: U.ada });

    const audit = (await api(app, employee(U.ada)).get('/api/admin/audit?via=mcp&table=tasks').expect(200)).body as {
      items: { row_id: string; action: string; changed_via: string; changed_by_name: string; label: string }[];
    };
    expect(audit.items.filter((a) => a.row_id === todo.id).map((a) => a.action).sort()).toEqual(['INSERT', 'UPDATE']);
    expect(audit.items[0]).toMatchObject({ changed_via: 'mcp', changed_by_name: 'Ada Admin', label: 'mcp test: call Maria' });
  });

  it('books with the app’s conflict checks; booking anyway needs an explicit flag', async () => {
    const booking = { customer_id: C.maria, service_id: S.haircut, location_id: L.nyc, employee_id: U.sam, scheduled_start: at(20, 16), notes_customer: 'mcp test' };
    const first = await call(rw, 'book_appointment', booking);
    expect(first.isError).toBe(false);
    const clash = await call(rw, 'book_appointment', booking);
    expect(clash.isError).toBe(true);
    expect(clash.data).toMatchObject({ code: 'employee_double_booked' });
    expect((await call(rw, 'book_appointment', { ...booking, book_despite_conflicts: true })).isError).toBe(false);

    const moved = (await call(rw, 'reschedule_appointment', { appointment_id: (first.data as { id: string }).id, scheduled_start: at(21, 15) })).data as { scheduled_start: string; scheduled_end: string };
    expect(Date.parse(moved.scheduled_end) - Date.parse(moved.scheduled_start)).toBe(45 * 60_000); // keeps its length
  });

  it('cancelling needs the confirmation from a preview, for the same arguments, once', async () => {
    const appt = (await call(rw, 'book_appointment', { customer_id: C.maria, service_id: S.haircut, location_id: L.nyc, scheduled_start: at(22, 16), notes_customer: 'mcp test' })).data as {
      id: string;
      appointment_number: string;
    };
    const other = (await call(rw, 'book_appointment', { customer_id: C.maria, service_id: S.haircut, location_id: L.nyc, scheduled_start: at(23, 16), notes_customer: 'mcp test' })).data as { id: string };

    const preview = (await call(rw, 'cancel_appointment', { appointment_id: appt.id })).data as { status: string; preview: string; confirmation: string };
    expect(preview.status).toBe('confirmation_required');
    expect(preview.preview).toContain(appt.appointment_number);
    expect(preview.preview).toContain('Maria Lopez');
    expect((await migrator.query('SELECT status FROM core.appointments WHERE id = $1', [appt.id])).rows[0].status).toBe('scheduled'); // nothing yet

    const wrong = await call(rw, 'cancel_appointment', { appointment_id: other.id, confirmation: preview.confirmation });
    expect(wrong.isError).toBe(true);
    const done = await call(rw, 'cancel_appointment', { appointment_id: appt.id, confirmation: preview.confirmation });
    expect(done.data).toMatchObject({ status: 'cancelled' });
    expect((await call(rw, 'cancel_appointment', { appointment_id: appt.id, confirmation: preview.confirmation })).isError).toBe(true); // used

    const late = (await call(rw, 'cancel_appointment', { appointment_id: other.id })).data as { confirmation: string };
    await migrator.query(`UPDATE app.mcp_confirmations SET expires_at = now() - interval '1 second' WHERE id = $1`, [late.confirmation]);
    expect((await call(rw, 'cancel_appointment', { appointment_id: other.id, confirmation: late.confirmation })).isError).toBe(true);
  });

  it('drafts, sends (with the email in the preview), takes a payment and refuses to void a paid invoice', async () => {
    const draft = (await call(rw, 'create_invoice_draft', { customer_id: C.maria, lines: [{ description: 'Haircut', unit_price: 50, service_id: S.haircut }] })).data as {
      id: string;
      status: string;
    };
    expect(draft.status).toBe('draft');

    const p1 = (await call(rw, 'send_invoice', { invoice_id: draft.id })).data as { preview: string; confirmation: string };
    expect(p1.preview).toMatch(/\$50\.00.*emailed at maria@example\.com/);
    const sent = (await call(rw, 'send_invoice', { invoice_id: draft.id, confirmation: p1.confirmation })).data as { invoice: { status: string } };
    expect(sent.invoice.status).toBe('sent');
    expect(sender.sent.at(-1)).toMatchObject({ template: 'invoice', to: 'maria@example.com' });

    const pay = { customer_id: C.maria, amount: 50, method: 'cash', invoice_id: draft.id, record_despite_duplicate: true };
    const p2 = (await call(rw, 'record_payment', pay)).data as { preview: string; confirmation: string };
    expect(p2.preview).toMatch(/Record \$50\.00 by cash from Maria Lopez/);
    const paid = (await call(rw, 'record_payment', { ...pay, confirmation: p2.confirmation })).data as { payment: { status: string } };
    expect(paid.payment.status).toBe('succeeded');
    expect((await call(rw, 'list_invoices', { customer_id: C.maria })).data[0]).toMatchObject({ status: 'paid' });

    const v = await call(rw, 'void_invoice', { invoice_id: draft.id, reason: 'mistake' });
    expect(v.isError).toBe(true);
    expect(String(v.data)).toMatch(/has payments/);
  });

  it('adds time off; invalid arguments come back as errors Claude can fix', async () => {
    const off = await call(rw, 'add_time_off', { employee_id: U.sam, starts_at: at(30, 0), ends_at: at(31, 0), reason: 'mcp test' });
    expect(off.isError).toBe(false);
    const backwards = await call(rw, 'add_time_off', { employee_id: U.sam, starts_at: at(31, 0), ends_at: at(30, 0) });
    expect(backwards.isError).toBe(true);
    expect(String(backwards.data)).toMatch(/ends_at must be after starts_at/);
    const noRef = await call(rw, 'record_payment', { customer_id: C.maria, amount: 10, method: 'card_pos' });
    expect(String(noRef.data)).toMatch(/POS reference is required/);
  });

  it('builds a website page: page, modules, images and setup, with a confirmed delete', async () => {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const image = (await call(rw, 'upload_site_image', { filename: 'logo.png', content_type: 'image/png', data_base64: PNG })).data as { id: string };
    expect(image.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await call(rw, 'upload_site_image', { filename: 'x.jpg', content_type: 'image/jpeg', data_base64: PNG })).isError).toBe(true); // bytes are a PNG
    // Bigger than the API's default 100 kB body limit: about 1.5 MB of base64.
    const big = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(1_100_000)]).toString('base64');
    expect((await call(rw, 'upload_site_image', { filename: 'big.png', content_type: 'image/png', data_base64: big })).isError).toBe(false);

    const page = (
      await call(rw, 'create_site_page', {
        slug: 'mcp-landing',
        title: 'Landing',
        modules: [{ id: 'hero', type: 'hero', heading: 'Embrace the AI revolution', heading_accent: 'AI revolution', buttons: [{ label: 'Book', url: '/contact' }] }],
      })
    ).data as { id: string; published: boolean };
    expect(page.published).toBe(false);

    const faq = { id: 'faq', type: 'faq', anchor: 'faq', items: [{ question: 'Who is this for?', answer: 'Everyone.' }] };
    await call(rw, 'set_site_module', { page_id: page.id, module: faq });
    await call(rw, 'set_site_module', { page_id: page.id, module: { id: 'top', type: 'cards', items: [{ icon: 'bot', heading: 'AI assistant' }] }, position: 0 });
    const replaced = (await call(rw, 'set_site_module', { page_id: page.id, module: { ...faq, heading: 'FAQ' } })).data as { modules: { id: string; heading?: string }[] };
    expect(replaced.modules.map((m) => m.id)).toEqual(['top', 'hero', 'faq']);
    expect(replaced.modules[2].heading).toBe('FAQ');
    const bad = await call(rw, 'set_site_module', { page_id: page.id, module: { id: 'x', type: 'cards', items: [{ icon: 'skull' }] } });
    expect(bad.isError).toBe(true);

    expect(((await call(rw, 'remove_site_module', { page_id: page.id, module_id: 'top' })).data as { modules: unknown[] }).modules).toHaveLength(2);
    expect((await call(rw, 'update_site_page', { page_id: page.id, published: true, show_in_header: true })).data).toMatchObject({ published: true });
    expect((await request(app.getHttpServer()).get('/api/site/pages/mcp-landing').expect(200)).body.modules[0].type).toBe('hero');
    expect((await call(ro, 'get_site_page', { slug: 'mcp-landing' })).data).toMatchObject({ id: page.id, title: 'Landing' });

    const setup = (
      await call(rw, 'update_site_setup', { site_name: 'Acme', tagline: 'Software Development', logo_asset_id: image.id, accent: '#6d5dfc', heading_font: 'instrument-serif', header_links: [{ label: 'FAQ', url: '/mcp-landing#faq' }] })
    ).data;
    expect(setup).toMatchObject({ site_name: 'Acme', tagline: 'Software Development', accent: '#6d5dfc', heading_font: 'instrument-serif' });
    expect((await call(rw, 'update_site_setup', { body_font: 'papyrus' })).isError).toBe(true);
    const read = (await call(ro, 'get_site_setup')).data as { settings: { accent: string }; fonts: string[]; icons: string[]; images: { id: string }[] };
    expect(read.settings.accent).toBe('#6d5dfc');
    expect(read.fonts).toContain('instrument-serif');
    expect(read.icons).toContain('bot');
    expect(read.images.map((i) => i.id)).toContain(image.id);

    const preview = (await call(rw, 'delete_site_page', { page_id: page.id })).data as { status: string; preview: string; confirmation: string };
    expect(preview.status).toBe('confirmation_required');
    expect(preview.preview).toContain('/mcp-landing');
    expect((await call(rw, 'get_site_page', { page_id: page.id })).isError).toBe(false); // still there
    expect((await call(rw, 'delete_site_page', { page_id: page.id, confirmation: preview.confirmation })).data).toMatchObject({ deleted: true });
    expect((await call(rw, 'get_site_page', { page_id: page.id })).isError).toBe(true);

    const home = ((await call(ro, 'list_site_pages')).data as { id: string; is_home: boolean }[]).find((pg) => pg.is_home)!;
    expect(String((await call(rw, 'delete_site_page', { page_id: home.id })).data)).toMatch(/home page/);

    const audit = (await api(app, employee(U.ada)).get('/api/admin/audit?via=mcp&table=site_settings').expect(200)).body as { items: { changed_via: string }[] };
    expect(audit.items[0]).toMatchObject({ changed_via: 'mcp' });
  });
});
