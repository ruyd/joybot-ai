import { Client } from 'pg';
import { createSeededDatabase, quoteIdent, withDatabase } from '@joybot/db';
import { envFile, testDatabases } from './test-db';

/**
 * Once per run: build the template database every test file copies (migrated, role logins set,
 * seeded). Afterwards: drop it and the workers' copies (only this suite's: `<db>_test_<n>`).
 */
export default async function setup(): Promise<() => Promise<void>> {
  const env = envFile();
  const { migrator, template, worker } = testDatabases(env);
  await createSeededDatabase(env, template);

  return async () => {
    const client = new Client({ connectionString: withDatabase(migrator, 'postgres') });
    await client.connect();
    try {
      const prefix = worker('');
      const names = (await client.query<{ datname: string }>('SELECT datname FROM pg_database')).rows
        .map((r) => r.datname)
        .filter((n) => n === template || (n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length))));
      for (const name of names) await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    } finally {
      await client.end();
    }
  };
}
