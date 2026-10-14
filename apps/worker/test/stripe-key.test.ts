import path from 'node:path';
import { sealSecret } from '@joybot/db';
import { config } from 'dotenv';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcileSettings, stripeRestrictedKey } from '../src/config';

config({ path: path.resolve(__dirname, '../../../.env') });
const worker = new Pool({ connectionString: process.env.WORKER_DATABASE_URL, max: 2 });
const migrator = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
const clear = () => migrator.query('UPDATE core.stripe_secret SET api_key_cipher = NULL, api_key_last4 = NULL');

beforeAll(() => migrator.connect());
afterAll(async () => {
  await clear();
  await migrator.query('UPDATE core.settings SET stripe_reconcile_interval_hours = 24, stripe_reconcile_days = 3');
  await migrator.end();
  await worker.end();
});

describe('Stripe key for reconciling', () => {
  it('uses the key saved in Settings › Stripe before the environment', async () => {
    await clear();
    expect(await stripeRestrictedKey(worker, { STRIPE_RESTRICTED_KEY: 'rk_test_env' })).toBe('rk_test_env');
    expect(await stripeRestrictedKey(worker, {})).toBeUndefined();

    await migrator.query(`UPDATE core.stripe_secret SET api_key_cipher = $1, api_key_last4 = 'aved'`, [sealSecret('rk_test_saved', 'k1')]);
    expect(await stripeRestrictedKey(worker, { SETTINGS_ENCRYPTION_KEY: 'k1', STRIPE_RESTRICTED_KEY: 'rk_test_env' })).toBe('rk_test_saved');
    await expect(stripeRestrictedKey(worker, {})).rejects.toThrow(/SETTINGS_ENCRYPTION_KEY/);
    await expect(stripeRestrictedKey(worker, { SETTINGS_ENCRYPTION_KEY: 'wrong' })).rejects.toThrow();
  });

  it('reads the reconcile schedule from Settings › Stripe', async () => {
    expect(await reconcileSettings(worker)).toEqual({ intervalHours: 24, days: 3 });
    await migrator.query('UPDATE core.settings SET stripe_reconcile_interval_hours = 6, stripe_reconcile_days = 10');
    expect(await reconcileSettings(worker)).toEqual({ intervalHours: 6, days: 10 });
  });
});
