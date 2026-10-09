import type { PostAuthenticationTriggerEvent } from 'aws-lambda';
import { Client } from 'pg';
import { dbConfig, required } from '../shared/db';

/**
 * Employees user pool, PostAuthentication: links the Cognito identity to the employee record an
 * admin created in JoyBot (by email, first sign-in only). Sign-in fails for anyone who is not an
 * active employee.
 */
export async function handler(event: PostAuthenticationTriggerEvent): Promise<PostAuthenticationTriggerEvent> {
  const { sub, email } = event.request.userAttributes;
  const client = new Client(await dbConfig(required('WORKER_SECRET_ARN')));
  await client.connect();
  try {
    await client.query(`SELECT set_config('app.via', 'cognito', false)`);
    const res = await client.query<{ id: string | null }>('SELECT authz.link_employee_login($1, $2) AS id', [sub, email ?? '']);
    if (!res.rows[0]?.id) throw new Error('Not an active JoyBot employee');
  } finally {
    await client.end();
  }
  return event;
}
