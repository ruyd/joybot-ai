import { Client, type ClientConfig } from 'pg';

/** Fixed IDs for sample data, so tests and local demos can refer to them. */
export const SAMPLE = {
  locations: {
    nyc: '10000000-0000-4000-8000-000000000001',
    la: '10000000-0000-4000-8000-000000000002',
  },
  users: {
    ada: '20000000-0000-4000-8000-000000000001', // admin, NYC
    sam: '20000000-0000-4000-8000-000000000002', // staff, NYC
    lia: '20000000-0000-4000-8000-000000000003', // staff, LA
  },
  orgs: {
    acme: '30000000-0000-4000-8000-000000000001',
    vip: '30000000-0000-4000-8000-000000000002', // restricted organization
  },
  customers: {
    maria: '40000000-0000-4000-8000-000000000001', // no org, NYC
    john: '40000000-0000-4000-8000-000000000002', // Acme org_admin, LA
    jane: '40000000-0000-4000-8000-000000000003', // Acme member, NYC
    victor: '40000000-0000-4000-8000-000000000004', // member of restricted VIP org, NYC
    rita: '40000000-0000-4000-8000-000000000005', // restricted customer, NYC
    pat: '40000000-0000-4000-8000-000000000006', // phone only, LA
  },
  services: {
    haircut: '50000000-0000-4000-8000-000000000001',
    deepClean: '50000000-0000-4000-8000-000000000002',
  },
  appointments: {
    mariaDone: '60000000-0000-4000-8000-000000000001',
    mariaNext: '60000000-0000-4000-8000-000000000002',
    johnDone: '60000000-0000-4000-8000-000000000003',
    janeNext: '60000000-0000-4000-8000-000000000004',
    victorNext: '60000000-0000-4000-8000-000000000005',
    patNext: '60000000-0000-4000-8000-000000000006',
  },
  payments: {
    mariaPos: '70000000-0000-4000-8000-000000000001',
    johnStripe: '70000000-0000-4000-8000-000000000002',
    janeTransfer: '70000000-0000-4000-8000-000000000003',
    unmatchedStripe: '70000000-0000-4000-8000-000000000004',
  },
} as const;

export interface SettingsDefaults {
  businessName: string;
  defaultTimeZone: string;
  defaultCurrency: string;
}

/** Creates the settings row if missing (DB bootstrap). */
export async function seedSettings(connectionString: string | ClientConfig, defaults: SettingsDefaults): Promise<void> {
  const client = new Client(typeof connectionString === 'string' ? { connectionString } : connectionString);
  await client.connect();
  try {
    await client.query(`SELECT set_config('app.via', 'seed', false)`);
    await client.query(
      `INSERT INTO core.settings (id, business_name, default_time_zone, default_currency)
       VALUES (1, $1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [defaults.businessName, defaults.defaultTimeZone, defaults.defaultCurrency],
    );
  } finally {
    await client.end();
  }
}

/** Sample data for local development and tests (SeedSampleData=true). Idempotent. */
export async function seedSampleData(connectionString: string | ClientConfig): Promise<void> {
  const S = SAMPLE;
  const client = new Client(typeof connectionString === 'string' ? { connectionString } : connectionString);
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.via', 'seed', true)`);

    await client.query(
      `INSERT INTO core.locations (id, code, name, time_zone) VALUES
         ($1, 'NYC', 'New York — Midtown', 'America/New_York'),
         ($2, 'LA',  'Los Angeles — Downtown', 'America/Los_Angeles')
       ON CONFLICT (id) DO NOTHING`,
      [S.locations.nyc, S.locations.la],
    );

    await client.query(
      `INSERT INTO core.users (id, first_name, last_name, email, role, home_location_id) VALUES
         ($1, 'Ada', 'Admin', 'ada@example.com', 'admin', $4),
         ($2, 'Sam', 'Staff', 'sam@example.com', 'staff', $4),
         ($3, 'Lia', 'Staff', 'lia@example.com', 'staff', $5)
       ON CONFLICT (id) DO NOTHING`,
      [S.users.ada, S.users.sam, S.users.lia, S.locations.nyc, S.locations.la],
    );
    await client.query(
      `INSERT INTO core.user_locations (user_id, location_id) VALUES ($1, $3), ($2, $3), ($4, $5)
       ON CONFLICT DO NOTHING`,
      [S.users.ada, S.users.sam, S.locations.nyc, S.users.lia, S.locations.la],
    );

    await client.query(
      `INSERT INTO core.organizations (id, name, email, restricted, created_by) VALUES
         ($1, 'Acme Corp', 'billing@acme.example', false, $3),
         ($2, 'VIP Holdings', 'office@vip.example', true, $3)
       ON CONFLICT (id) DO NOTHING`,
      [S.orgs.acme, S.orgs.vip, S.users.ada],
    );

    const c = S.customers;
    await client.query(
      `INSERT INTO core.customers
         (id, first_name, last_name, email, email_verified, phone, phone_verified, organization_id, org_role,
          preferred_location_id, restricted, source, created_by)
       VALUES
         ($1, 'Maria',  'Lopez',  'maria@example.com',  true,  '+12125550101', true,  NULL, NULL,        $7, false, 'employee', $9),
         ($2, 'John',   'Smith',  'john@acme.example',  true,  NULL,           false, $10, 'org_admin', $8, false, 'employee', $9),
         ($3, 'Jane',   'Doe',    'jane@acme.example',  true,  NULL,           false, $10, 'member',    $7, false, 'employee', $9),
         ($4, 'Victor', 'Vance',  'victor@vip.example', true,  NULL,           false, $11, 'member',    $7, false, 'employee', $9),
         ($5, 'Rita',   'Reyes',  'rita@example.com',   true,  NULL,           false, NULL, NULL,       $7, true,  'employee', $9),
         ($6, 'Pat',    'Kim',    NULL,                 false, '+13105550106', true,  NULL, NULL,       $8, false, 'self_signup', NULL)
       ON CONFLICT (id) DO NOTHING`,
      [c.maria, c.john, c.jane, c.victor, c.rita, c.pat, S.locations.nyc, S.locations.la, S.users.ada,
       S.orgs.acme, S.orgs.vip],
    );

    await client.query(
      `INSERT INTO core.services (id, code, name, category, duration_minutes, price, currency) VALUES
         ($1, 'HAIRCUT', 'Haircut', 'Hair', 45, 50.00, 'USD'),
         ($2, 'DEEP-CLEAN', 'Deep clean', 'Cleaning', 120, 120.00, 'USD')
       ON CONFLICT (id) DO NOTHING`,
      [S.services.haircut, S.services.deepClean],
    );

    const a = S.appointments;
    await client.query(
      `INSERT INTO core.appointments
         (id, customer_id, service_id, employee_id, location_id, scheduled_start, scheduled_end, status,
          price_quoted, currency, notes_internal)
       VALUES
         ($1, $7,  $12, $14, $16, now() - interval '10 days', now() - interval '10 days' + interval '45 minutes', 'completed', 50.00,  'USD', 'Prefers short appointments'),
         ($2, $7,  $12, $14, $16, now() + interval '2 days',  now() + interval '2 days' + interval '45 minutes',  'scheduled', 50.00,  'USD', NULL),
         ($3, $8,  $13, $15, $17, now() - interval '5 days',  now() - interval '5 days' + interval '2 hours',     'completed', 120.00, 'USD', NULL),
         ($4, $9,  $12, $14, $16, now() + interval '3 days',  now() + interval '3 days' + interval '45 minutes',  'scheduled', 50.00,  'USD', NULL),
         ($5, $10, $13, NULL, $16, now() + interval '4 days', now() + interval '4 days' + interval '2 hours',     'scheduled', 120.00, 'USD', 'VIP — discreet'),
         ($6, $11, $12, $15, $17, now() + interval '1 day',   now() + interval '1 day' + interval '45 minutes',   'scheduled', 50.00,  'USD', NULL)
       ON CONFLICT (id) DO NOTHING`,
      [a.mariaDone, a.mariaNext, a.johnDone, a.janeNext, a.victorNext, a.patNext,
       c.maria, c.john, c.jane, c.victor, c.pat,
       S.services.haircut, S.services.deepClean, S.users.sam, S.users.lia,
       S.locations.nyc, S.locations.la],
    );

    const p = S.payments;
    await client.query(
      `INSERT INTO core.payments
         (id, source, customer_id, appointment_id, location_id, amount, currency, method, status,
          pos_reference, pos_terminal_id, card_brand, card_last4, bank_reference, expected_at,
          stripe_payment_intent_id, receipt_url, paid_at, recorded_by, created_at)
       VALUES
         ($1, 'manual', $5, $8,  $11, 50.00,  'USD', 'card_pos',      'succeeded', 'POS-1001', 'T1', 'visa', '4242', NULL, NULL,
          NULL, NULL, now() - interval '10 days', $13, now() - interval '10 days'),
         ($2, 'stripe', $6, $9,  $12, 120.00, 'USD', 'card_online',   'succeeded', NULL, NULL, 'mastercard', '4444', NULL, NULL,
          'pi_sample_john', 'https://pay.stripe.com/receipts/sample', now() - interval '5 days', NULL, now() - interval '5 days'),
         ($3, 'manual', $7, $10, $11, 50.00,  'USD', 'bank_transfer', 'pending',   NULL, NULL, NULL, NULL, NULL, current_date - 10,
          NULL, NULL, NULL, $13, now() - interval '12 days'),
         ($4, 'stripe', NULL, NULL, $11, 35.00, 'USD', 'card_online',  'succeeded', NULL, NULL, 'visa', '1881', NULL, NULL,
          'pi_sample_unmatched', NULL, now() - interval '1 day', NULL, now() - interval '1 day')
       ON CONFLICT (id) DO NOTHING`,
      [p.mariaPos, p.johnStripe, p.janeTransfer, p.unmatchedStripe,
       c.maria, c.john, c.jane, a.mariaDone, a.johnDone, a.janeNext,
       S.locations.nyc, S.locations.la, S.users.sam],
    );

    // Lia (LA staff) is assigned to the restricted VIP organization.
    await client.query(
      `INSERT INTO core.assignments (id, user_id, organization_id, created_by)
       VALUES ('80000000-0000-4000-8000-000000000001', $1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [S.users.lia, S.orgs.vip, S.users.ada],
    );
    // Sam (NYC staff) has a read grant on Pat (LA); Lia's grant on Maria has expired.
    await client.query(
      `INSERT INTO core.record_grants (id, user_id, resource, record_id, actions, reason, granted_by, expires_at) VALUES
         ('90000000-0000-4000-8000-000000000001', $1, 'customer', $3, '{read}', 'Covering LA front desk', $5, now() + interval '7 days'),
         ('90000000-0000-4000-8000-000000000002', $2, 'customer', $4, '{read}', 'Old escalation', $5, now() - interval '1 day')
       ON CONFLICT (id) DO NOTHING`,
      [S.users.sam, S.users.lia, c.pat, c.maria, S.users.ada],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}
