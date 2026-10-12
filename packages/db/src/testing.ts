/**
 * Test databases (tests only). Each suite works in its own `<db>_test_<suffix>` next to the
 * development database named in .env, which tests never touch: the API copies a seeded template per
 * worker, the db and worker packages use one seeded database per run.
 */
import { Client } from 'pg';
import { bootstrapRoleLogins, migrate } from './migrate';
import { seedSampleData, seedSettings } from './seed';

/** The connection URLs that name a database; tests and the apps read them from the environment. */
export const DATABASE_URL_VARS = ['MIGRATOR_DATABASE_URL', 'APP_DATABASE_URL', 'READER_DATABASE_URL', 'WORKER_DATABASE_URL'] as const;

type Env = Record<string, string | undefined>;

/** The same connection URL, pointed at another database. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** `<db>_test_<suffix>`, from the development database in MIGRATOR_DATABASE_URL. */
export function testDatabaseName(env: Env, suffix: string): string {
  const migrator = env.MIGRATOR_DATABASE_URL;
  if (!migrator) throw new Error('MIGRATOR_DATABASE_URL is not set (copy .env.example to .env)');
  return `${new URL(migrator).pathname.slice(1) || 'joybot'}_test_${suffix}`;
}

/** The database URLs of `env`, pointed at `database` (for a test run's environment). */
export function testEnv(env: Env, database: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of DATABASE_URL_VARS) {
    const url = env[name];
    if (url) out[name] = withDatabase(url, database);
  }
  return out;
}

/** Runs statements on the server's maintenance database (CREATE/DROP DATABASE cannot run inside the target). */
export async function onServer(migratorUrl: string, ...statements: string[]): Promise<void> {
  const client = new Client({ connectionString: withDatabase(migratorUrl, 'postgres') });
  await client.connect();
  try {
    for (const sql of statements) await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Drops (if there) and creates `database`, empty or as a copy of `template`. */
export function recreateDatabase(migratorUrl: string, database: string, template?: string): Promise<void> {
  return onServer(
    migratorUrl,
    `DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`,
    `CREATE DATABASE ${quoteIdent(database)}${template ? ` TEMPLATE ${quoteIdent(template)}` : ''}`,
  );
}

export function dropDatabase(migratorUrl: string, database: string): Promise<void> {
  return onServer(migratorUrl, `DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`);
}

/** A fresh database with every migration, the role logins from `env` and the sample data. */
export async function createSeededDatabase(env: Env, database: string): Promise<void> {
  const migrator = env.MIGRATOR_DATABASE_URL!;
  await recreateDatabase(migrator, database);
  const url = withDatabase(migrator, database);
  await migrate(url, () => undefined);
  await bootstrapRoleLogins(url, {
    joybot_app: env.APP_DB_PASSWORD,
    joybot_reader: env.READER_DB_PASSWORD,
    joybot_worker: env.WORKER_DB_PASSWORD,
  });
  await seedSettings(url, { businessName: 'JoyBot Test', defaultTimeZone: 'America/New_York', defaultCurrency: 'USD' });
  await seedSampleData(url);
}
