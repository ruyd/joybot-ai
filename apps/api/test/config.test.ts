import { describe, expect, it } from 'vitest';
import { loadConfig, poolConfig } from '../src/config/config';

const aws = {
  NODE_ENV: 'production',
  AUTH_MODE: 'cognito',
  CUSTOMERS_USER_POOL_ID: 'us-east-1_c',
  CUSTOMERS_CLIENT_ID: 'c',
  EMPLOYEES_USER_POOL_ID: 'us-east-1_e',
  EMPLOYEES_CLIENT_ID: 'e',
  DB_HOST: 'writer.cluster',
  DB_READER_HOST: 'reader.cluster',
  APP_DB_PASSWORD: 'a',
  READER_DB_PASSWORD: 'r',
  DB_SSL: 'true',
};

describe('config', () => {
  it('builds per-role pools from host + injected credentials with verified TLS', () => {
    const cfg = loadConfig(aws);
    expect(poolConfig(cfg, 'app')).toMatchObject({ host: 'writer.cluster', user: 'joybot_app', password: 'a', ssl: { rejectUnauthorized: true } });
    expect(poolConfig(cfg, 'reader')).toMatchObject({ host: 'reader.cluster', user: 'joybot_reader', password: 'r' });
  });

  it('treats empty optional values (as CloudFormation passes them) as unset', () => {
    const cfg = loadConfig({ ...aws, SES_FROM_ADDRESS: '', MODEL_ENDPOINT: '', APP_URL: '', FRESHDESK_BASE_URL: '' });
    expect(cfg.SES_FROM_ADDRESS).toBeUndefined();
    expect(cfg.MODEL_ENDPOINT).toBeUndefined();
  });

  it('refuses dev auth in production and missing database settings', () => {
    expect(() => loadConfig({ ...aws, AUTH_MODE: 'dev' })).toThrow(/not allowed in production/);
    expect(() => loadConfig({ ...aws, APP_DB_PASSWORD: undefined })).toThrow(/APP_DB_PASSWORD/);
    expect(() => loadConfig({ ...aws, EMPLOYEES_CLIENT_ID: undefined })).toThrow(/EMPLOYEES_CLIENT_ID/);
  });

  it('allows model prompt logging only with dev auth', () => {
    expect(() => loadConfig({ ...aws, MODEL_DEBUG: 'true' })).toThrow(/MODEL_DEBUG=true is only allowed with AUTH_MODE=dev/);
    expect(loadConfig({ ...aws, NODE_ENV: 'development', AUTH_MODE: 'dev', MODEL_DEBUG: 'true' }).MODEL_DEBUG).toBe('true');
    expect(loadConfig(aws).MODEL_DEBUG).toBe('false');
  });
});
