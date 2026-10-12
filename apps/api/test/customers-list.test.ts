import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createApp, customer, employee } from './app';

const { customers: C, users: U, locations: L } = SAMPLE;

let app: INestApplication;
beforeAll(async () => {
  app = await createApp();
  // 24 more customers in New York (sample data has 6), so there are pages to turn.
  for (let i = 0; i < 24; i++) {
    await api(app, employee(U.ada))
      .post('/api/customers', { first_name: `Page${String(i).padStart(2, '0')}`, last_name: `Zztest${String(i).padStart(2, '0')}`, email: `page${i}@example.com`, preferred_location_id: L.nyc })
      .expect(201);
  }
});
afterAll(async () => {
  await app.close();
});

type Row = { id: string; first_name: string; last_name: string | null };
const list = (who: string, q = '') => api(app, employee(who)).get(`/api/customers/list${q ? `?${q}` : ''}`);

describe('customers list (pages with the total)', () => {
  it('pages through everyone the employee can see, by last name, with the total', async () => {
    const first = (await list(U.ada, 'limit=10').expect(200)).body as { items: Row[]; total: number };
    expect(first.total).toBe(30);
    expect(first.items).toHaveLength(10);
    const names = first.items.map((r) => r.last_name ?? '');
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);

    const pages = await Promise.all([0, 10, 20].map(async (offset) => ((await list(U.ada, `limit=10&offset=${offset}`).expect(200)).body.items as Row[]).map((r) => r.id)));
    expect(new Set(pages.flat()).size).toBe(30); // no repeats across pages
    expect((await list(U.ada, 'limit=10&offset=30').expect(200)).body).toEqual({ items: [], total: 30 }); // past the end: still the total
    expect((await list(U.ada).expect(200)).body.items).toHaveLength(25); // 25 by default
  });

  it('searches with the same matching as the pickers, and counts the matches', async () => {
    const zz = (await list(U.ada, 'q=zztest&limit=10').expect(200)).body as { items: Row[]; total: number };
    expect(zz.total).toBe(24);
    expect(zz.items).toHaveLength(10);
    expect((await list(U.ada, 'q=zztest&limit=10&offset=20').expect(200)).body.items).toHaveLength(4);
    const maria = (await list(U.ada, 'q=maria').expect(200)).body as { items: Row[]; total: number };
    expect(maria.items[0].id).toBe(C.maria);
    expect((await list(U.ada, 'q=100%25').expect(200)).body.total).toBe(0); // % is a character
    // The picker search still answers with a plain list.
    expect((await api(app, employee(U.ada)).get('/api/customers?q=zztest&limit=5').expect(200)).body).toHaveLength(5);
  });

  it('shows staff only the customers in their scope, and validates the page', async () => {
    const lia = (await list(U.lia, 'limit=100').expect(200)).body as { items: Row[]; total: number };
    expect(lia.total).toBeLessThan(30); // LA staff: not the New York customers
    expect(lia.items.map((r) => r.id)).not.toContain(C.maria);
    await list(U.ada, 'limit=7').expect(400);
    await list(U.ada, 'offset=-1').expect(400);
    await list(U.ada, 'sort=name').expect(400);
    await api(app, customer(C.maria)).get('/api/customers/list').expect(403);
  });
});
