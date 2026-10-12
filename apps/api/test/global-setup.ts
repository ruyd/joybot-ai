import { bootstrapRoleLogins, migrate, seedSampleData, seedSettings } from '@joybot/db';
import { envFile, onServer, quoteIdent, testDatabases, withDatabase } from './test-db';

/**
 * Once per run: build the template database every test file copies (migrated, role logins set,
 * seeded). Afterwards: drop it and the workers' copies.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const env = envFile();
  const { migrator, template } = testDatabases(env);
  await onServer(migrator, `DROP DATABASE IF EXISTS ${quoteIdent(template)} WITH (FORCE)`, `CREATE DATABASE ${quoteIdent(template)}`);
  const url = withDatabase(migrator, template);
  await migrate(url, () => undefined);
  await bootstrapRoleLogins(url, {
    joybot_app: env.APP_DB_PASSWORD,
    joybot_reader: env.READER_DB_PASSWORD,
    joybot_worker: env.WORKER_DB_PASSWORD,
  });
  await seedSettings(url, { businessName: 'JoyBot Test', defaultTimeZone: 'America/New_York', defaultCurrency: 'USD' });
  await seedSampleData(url);

  return async () => {
    const { Client } = await import('pg');
    const client = new Client({ connectionString: withDatabase(migrator, 'postgres') });
    await client.connect();
    try {
      const names = (await client.query<{ datname: string }>(`SELECT datname FROM pg_database WHERE datname LIKE $1`, [`${template.replace(/_template$/, '')}\\_%`])).rows;
      for (const { datname } of names) await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(datname)} WITH (FORCE)`);
    } finally {
      await client.end();
    }
  };
}
