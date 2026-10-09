-- Stripe sync (plan.md §4.4): app.stripe_events is both the idempotent event store and the work
-- queue the worker drains (FOR UPDATE SKIP LOCKED). Out-of-order events are ignored per payment.

ALTER TABLE core.payments
  ADD COLUMN stripe_customer_id text,
  -- Stripe "created" time of the newest event applied to this row; older events are skipped.
  ADD COLUMN stripe_synced_at timestamptz;

ALTER TABLE app.stripe_events
  ADD COLUMN attempts int NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
DROP INDEX app.stripe_events_pending;
CREATE INDEX stripe_events_pending ON app.stripe_events (next_attempt_at, created) WHERE status = 'received';

-- Requests from the API to the worker (e.g. "reconcile Stripe now").
CREATE TABLE app.worker_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('stripe_reconcile')),
  params       jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  result       jsonb,
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX worker_jobs_queued ON app.worker_jobs (requested_at) WHERE status = 'queued';
GRANT SELECT, INSERT ON app.worker_jobs TO joybot_app;
GRANT SELECT, INSERT, UPDATE ON app.worker_jobs TO joybot_worker;

/**
 * Customer for a Stripe payment, in order of confidence:
 * metadata customer_number → metadata appointment_number → linked Stripe customer → verified email.
 * Returns NULL when nothing matches (the payment goes to the unmatched queue).
 */
CREATE FUNCTION core.match_stripe_customer(p_customer_number text, p_appointment_number text,
                                           p_stripe_customer_id text, p_email text)
RETURNS TABLE (customer_id uuid, appointment_id uuid, location_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.id, a.id, a.location_id
    FROM core.appointments a JOIN core.customers c ON c.id = a.customer_id
   WHERE p_appointment_number IS NOT NULL AND a.appointment_number = upper(p_appointment_number)
     AND (p_customer_number IS NULL OR c.customer_number = upper(p_customer_number))
  UNION ALL
  SELECT c.id, NULL, c.preferred_location_id FROM core.customers c
   WHERE p_customer_number IS NOT NULL AND c.customer_number = upper(p_customer_number)
  UNION ALL
  SELECT c.id, NULL, c.preferred_location_id FROM core.customers c
   WHERE p_stripe_customer_id IS NOT NULL AND c.stripe_customer_id = p_stripe_customer_id
  UNION ALL
  SELECT c.id, NULL, c.preferred_location_id FROM core.customers c
   WHERE p_email IS NOT NULL AND c.email = lower(p_email) AND c.email_verified
  LIMIT 1
$$;
GRANT EXECUTE ON FUNCTION core.match_stripe_customer(text, text, text, text) TO joybot_worker;

-- The webhook endpoint has no principal (Stripe calls it), so it reads the toggle through this.
CREATE FUNCTION authz.stripe_enabled() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce((SELECT stripe_enabled FROM core.settings WHERE id = 1), false)
$$;
GRANT EXECUTE ON FUNCTION authz.stripe_enabled() TO joybot_app, joybot_worker;

-- numeric accepts NaN (and NaN > 0 is true in PostgreSQL): reject it explicitly.
ALTER TABLE core.payments ADD CONSTRAINT payments_amounts_not_nan CHECK (amount <> 'NaN' AND amount_refunded <> 'NaN');
