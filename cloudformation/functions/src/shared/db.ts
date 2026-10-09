import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { ClientConfig } from 'pg';

const secrets = new SecretsManagerClient({});
const cache = new Map<string, { username: string; password: string }>();

export async function readSecret(arn: string): Promise<{ username: string; password: string }> {
  const hit = cache.get(arn);
  if (hit) return hit;
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
  const value = JSON.parse(res.SecretString ?? '{}');
  if (!value.username || !value.password) throw new Error(`Secret ${arn} has no username/password`);
  cache.set(arn, value);
  return value;
}

/**
 * Connection settings for Aurora. TLS is verified against the RDS CA bundle that the Lambda
 * Node.js runtime ships at /var/runtime/ca-cert.pem (set NODE_EXTRA_CA_CERTS to it).
 */
export async function dbConfig(secretArn: string): Promise<ClientConfig> {
  const { username, password } = await readSecret(secretArn);
  return {
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME ?? 'joybot',
    user: username,
    password,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 10_000,
  };
}

export function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}
