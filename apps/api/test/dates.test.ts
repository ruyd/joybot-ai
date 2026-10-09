import type { INestApplication } from '@nestjs/common';
import { SAMPLE } from '@joybot/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { api, createApp, employee } from './app';

let app: INestApplication;
beforeAll(async () => {
  app = await createApp();
});
afterAll(async () => {
  await app.close();
});

it('returns DATE columns as plain calendar dates', async () => {
  const res = await api(app, employee(SAMPLE.users.sam)).get('/api/payments/pending-transfers').expect(200);
  expect(res.body[0].expected_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
