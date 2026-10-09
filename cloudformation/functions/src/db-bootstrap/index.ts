import path from 'node:path';
import type { CloudFormationCustomResourceEvent, Context } from 'aws-lambda';
import { bootstrapRoleLogins, migrate, seedSampleData, seedSettings } from '@joybot/db';
import { Client } from 'pg';
import { respond } from '../shared/custom-resource';
import { dbConfig, readSecret, required } from '../shared/db';

const PHYSICAL_ID = 'joybot-db-bootstrap';

/**
 * Custom resource (plan.md §8.4 "Database schema"): runs forward-only migrations, gives the app
 * roles their logins, creates the settings row, the first admin employee and optional sample data.
 * Runs on Create and on every Update (e.g. new ArtifactsVersion). Delete is a no-op: the database
 * is kept by its own DeletionPolicy.
 */
export async function handler(event: CloudFormationCustomResourceEvent, context: Context): Promise<void> {
  if (event.RequestType === 'Delete') {
    await respond(event, 'SUCCESS', event.PhysicalResourceId);
    return;
  }
  // Leave time to report failure before Lambda times out.
  const timer = setTimeout(
    () => void respond(event, 'FAILED', PHYSICAL_ID, {}, 'Timed out'),
    Math.max(context.getRemainingTimeInMillis() - 10_000, 1_000),
  );
  try {
    const props = event.ResourceProperties as unknown as {
      AdminEmail: string;
      BusinessName: string;
      DefaultTimeZone: string;
      DefaultCurrency: string;
      SeedSampleData: string;
    };
    const master = await dbConfig(required('MASTER_SECRET_ARN'));
    const applied = await migrate(master, (m) => console.log(m), path.join(__dirname, 'migrations'));

    const [app, reader, worker] = await Promise.all(
      ['APP_SECRET_ARN', 'READER_SECRET_ARN', 'WORKER_SECRET_ARN'].map((k) => readSecret(required(k))),
    );
    await bootstrapRoleLogins(master, {
      joybot_app: app.password,
      joybot_reader: reader.password,
      joybot_worker: worker.password,
    });
    await seedSettings(master, {
      businessName: props.BusinessName,
      defaultTimeZone: props.DefaultTimeZone,
      defaultCurrency: props.DefaultCurrency,
    });

    const client = new Client(master);
    await client.connect();
    try {
      await client.query(`SELECT set_config('app.via', 'migration', false)`);
      await client.query('SELECT authz.ensure_admin($1, $2, $3)', [props.AdminEmail, 'Admin', 'User']);
      // First location uses the default time zone so appointments can be created right away.
      await client.query(
        `INSERT INTO core.locations (code, name, time_zone)
         SELECT 'MAIN', 'Main location', default_time_zone FROM core.settings
          WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM core.locations)`,
      );
    } finally {
      await client.end();
    }
    if (props.SeedSampleData === 'true') await seedSampleData(master);

    clearTimeout(timer);
    await respond(event, 'SUCCESS', PHYSICAL_ID, { AppliedMigrations: String(applied.length) });
  } catch (err) {
    clearTimeout(timer);
    console.error(err);
    await respond(event, 'FAILED', PHYSICAL_ID, {}, err instanceof Error ? err.message : String(err));
  }
}
