import type { PostConfirmationTriggerEvent } from 'aws-lambda';
import { Client } from 'pg';
import { dbConfig, required } from '../shared/db';

/**
 * Customers user pool, PostConfirmation: links the new login to an existing customer by
 * *verified* email/phone, creates a new customer, or queues a conflict for staff review
 * (rules in authz.link_customer_signup, plan.md §4.3).
 */
export async function handler(event: PostConfirmationTriggerEvent): Promise<PostConfirmationTriggerEvent> {
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') return event;
  const a = event.request.userAttributes;
  const client = new Client(await dbConfig(required('WORKER_SECRET_ARN')));
  await client.connect();
  try {
    await client.query(`SELECT set_config('app.via', 'cognito', false)`);
    const res = await client.query<{ outcome: string; customer_id: string | null }>(
      'SELECT * FROM authz.link_customer_signup($1, $2, $3, $4, $5)',
      [a.sub, a.email ?? null, a.email_verified === 'true', a.phone_number ?? null, a.phone_number_verified === 'true'],
    );
    // No PII in logs: outcome and ids only.
    console.log(JSON.stringify({ outcome: res.rows[0]?.outcome, customerId: res.rows[0]?.customer_id }));
  } finally {
    await client.end();
  }
  return event;
}
