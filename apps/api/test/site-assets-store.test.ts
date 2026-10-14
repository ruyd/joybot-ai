import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { config } from 'dotenv';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { S3SiteAssetStore, SITE_ASSET_STORE, type SiteAssetStore } from '../src/website/asset-store';
import { loadConfig } from '../src/config/config';
import { api, createApp, employee } from './app';

const { users: U } = SAMPLE;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const CDN = 'https://cdn.example.test';

/** A bucket in memory. */
class FakeStore implements SiteAssetStore {
  objects = new Map<string, { bytes: Buffer; type: string }>();
  deleted: string[] = [];
  async put(id: string, bytes: Buffer, type: string) {
    this.objects.set(id, { bytes, type });
  }
  async delete(id: string) {
    this.objects.delete(id);
    this.deleted.push(id);
  }
  publicUrl(id: string) {
    return `${CDN}/site/${id}`;
  }
}

const store = new FakeStore();
let app: INestApplication;
beforeAll(async () => {
  app = await createApp({ overrides: [{ token: SITE_ASSET_STORE, value: store }] });
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  store.objects.clear();
  store.deleted = [];
});

const admin = () => api(app, employee(U.ada));
const upload = (who = employee(U.ada)) =>
  request(app.getHttpServer()).post('/api/website/assets?filename=dot.png').set('x-dev-principal', `${who.type}:${who.id}`).set('content-type', 'image/png').send(PNG);

async function asOwner<T>(sql: string, args: unknown[] = []): Promise<T[]> {
  config({ path: path.resolve(__dirname, '../../../.env') });
  const db = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await db.connect();
  try {
    return (await db.query(sql, args)).rows as T[];
  } finally {
    await db.end();
  }
}

describe('website images in a bucket (SITE_ASSET_STORE=s3)', () => {
  it('uploads go to the bucket, not the database, and the API sends visitors to the CDN', async () => {
    const asset = (await upload().expect(201)).body;
    expect(asset).toMatchObject({ storage: 's3', size_bytes: PNG.length });
    expect(store.objects.get(asset.id)).toEqual({ bytes: PNG, type: 'image/png' });
    expect(await asOwner('SELECT 1 FROM core.site_asset_data WHERE asset_id = $1', [asset.id])).toHaveLength(0);

    const res = await request(app.getHttpServer()).get(`/api/site/assets/${asset.id}`).expect(301);
    expect(res.headers.location).toBe(`${CDN}/site/${asset.id}`);
  });

  it('a refused upload leaves nothing in the bucket', async () => {
    await upload(employee(U.sam)).expect(403);
    expect(store.objects.size).toBe(0);
  });

  it('deleting removes the object', async () => {
    const asset = (await upload().expect(201)).body;
    await admin().delete(`/api/website/assets/${asset.id}`).expect(204);
    expect(store.deleted).toEqual([asset.id]);
    await request(app.getHttpServer()).get(`/api/site/assets/${asset.id}`).expect(404);
  });

  it('images still in the database are moved by an editor, and keep their ids', async () => {
    const id = randomUUID();
    await asOwner(
      `INSERT INTO core.site_assets (id, filename, content_type, size_bytes, sha256) VALUES ($1, 'old.png', 'image/png', $2, $3)`,
      [id, PNG.length, createHash('sha256').update(PNG).digest('hex')],
    );
    await asOwner('INSERT INTO core.site_asset_data (asset_id, bytes) VALUES ($1, $2)', [id, PNG]);
    // Until moved, the API still serves it.
    await request(app.getHttpServer()).get(`/api/site/assets/${id}`).expect(200);

    await api(app, employee(U.sam)).post('/api/website/assets/move', {}).expect(403);
    expect((await admin().post('/api/website/assets/move', {}).expect(200)).body).toEqual({ moved: 1, remaining: 0 });
    expect(store.objects.get(id)?.bytes.equals(PNG)).toBe(true);
    expect(await asOwner('SELECT storage FROM core.site_assets WHERE id = $1', [id])).toEqual([{ storage: 's3' }]);
    expect(await asOwner('SELECT 1 FROM core.site_asset_data WHERE asset_id = $1', [id])).toHaveLength(0);
    expect((await request(app.getHttpServer()).get(`/api/site/assets/${id}`).expect(301)).headers.location).toBe(`${CDN}/site/${id}`);
    expect((await admin().post('/api/website/assets/move', {}).expect(200)).body).toEqual({ moved: 0, remaining: 0 });
  });
});

describe('S3SiteAssetStore', () => {
  const base = { APP_DATABASE_URL: 'postgres://x', READER_DATABASE_URL: 'postgres://x', AUTH_MODE: 'dev' };

  it('needs a bucket and a public address', () => {
    expect(() => loadConfig({ ...base, SITE_ASSET_STORE: 's3' })).toThrow(/S3_BUCKET is required.*SITE_ASSET_BASE_URL is required|SITE_ASSET_BASE_URL/s);
    expect(loadConfig({ ...base, SITE_ASSET_STORE: '' }).SITE_ASSET_STORE).toBeUndefined();
  });

  it('purges a deleted image from Cloudflare when a token is set', async () => {
    const cfg = loadConfig({
      ...base,
      SITE_ASSET_STORE: 's3',
      S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
      S3_BUCKET: 'site',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'secret',
      SITE_ASSET_BASE_URL: `${CDN}/`,
      CLOUDFLARE_API_TOKEN: 'cf-token',
      CLOUDFLARE_ZONE_ID: 'zone1',
    });
    const calls: { url: string; init: RequestInit }[] = [];
    const s = new S3SiteAssetStore(cfg, async (url, init) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    });
    (s as unknown as { s3: { send: () => Promise<object> } }).s3 = { send: async () => ({}) };
    expect(s.publicUrl('abc')).toBe(`${CDN}/site/abc`);
    await s.delete('abc');
    expect(calls).toEqual([
      {
        url: 'https://api.cloudflare.com/client/v4/zones/zone1/purge_cache',
        init: expect.objectContaining({ method: 'POST', body: JSON.stringify({ files: [`${CDN}/site/abc`] }) }),
      },
    ]);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer cf-token');
  });
});
