-- Row-level security on the remaining app tables (plan.md §8.6). Until now joybot_app and
-- joybot_reader could read every row of these tables whatever the principal.

-- The chat reader only needs conversations and messages.
REVOKE ALL ON app.invites, app.stripe_events, app.worker_jobs, app.retrieval_traces,
              app.response_cache, app.message_deliveries FROM joybot_reader;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invites', 'stripe_events', 'worker_jobs', 'retrieval_traces', 'response_cache', 'message_deliveries'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY worker_all ON app.%I TO joybot_worker USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- Invites -------------------------------------------------------------------------------------
-- Created by employees who may update the customer, or by org admins for their members.
CREATE POLICY create_in_scope ON app.invites FOR INSERT TO joybot_app
  WITH CHECK (created_by_type = authz.principal_type() AND created_by = authz.principal_id()
              AND authz.customer_in_scope(customer_id, 'customers', 'update'));
CREATE POLICY read_in_scope ON app.invites FOR SELECT TO joybot_app
  USING (authz.customer_in_scope(customer_id, 'customers', 'read'));

/**
 * Accepts an invite by token hash for the signed-in customer, once (no race between two accepts).
 * Returns the invited customer id, or NULL when the invite is unknown, used or expired.
 */
CREATE FUNCTION authz.accept_invite(p_token_hash text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_customer uuid;
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'customer' THEN
    RAISE EXCEPTION 'only customers accept invites' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE app.invites SET accepted_at = now()
   WHERE token_hash = p_token_hash AND accepted_at IS NULL AND expires_at > now()
  RETURNING customer_id INTO v_customer;
  RETURN v_customer;
END $$;
REVOKE ALL ON FUNCTION authz.accept_invite(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.accept_invite(text) TO joybot_app;

-- Stripe events -------------------------------------------------------------------------------
-- The webhook (signature-verified, no principal) stores events through a function that can only
-- append; admins see the backlog. INSERT … ON CONFLICT would need a SELECT policy the webhook
-- cannot pass, so the API role gets no direct writes at all.
CREATE FUNCTION authz.store_stripe_event(p_event_id text, p_type text, p_livemode boolean, p_created bigint, p_payload text)
RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH ins AS (
    INSERT INTO app.stripe_events (event_id, type, livemode, created, payload)
    VALUES (p_event_id, p_type, p_livemode, to_timestamp(p_created), p_payload::jsonb)
    ON CONFLICT (event_id) DO NOTHING
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM ins)
$$;
REVOKE ALL ON FUNCTION authz.store_stripe_event(text, text, boolean, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.store_stripe_event(text, text, boolean, bigint, text) TO joybot_app;
CREATE POLICY admin_read ON app.stripe_events FOR SELECT TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('settings', 'update'));
REVOKE INSERT, UPDATE, DELETE ON app.stripe_events FROM joybot_app;

-- Worker jobs (e.g. "reconcile Stripe now") -----------------------------------------------------
CREATE POLICY admin_request ON app.worker_jobs FOR INSERT TO joybot_app
  WITH CHECK (authz.principal_type() = 'employee' AND authz.can('settings', 'update') AND requested_by = authz.principal_id());
CREATE POLICY admin_read ON app.worker_jobs FOR SELECT TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('settings', 'update'));

-- Retrieval traces: written for the principal's own messages; readable by them and by auditors.
CREATE POLICY own_insert ON app.retrieval_traces FOR INSERT TO joybot_app
  WITH CHECK (principal_type = authz.principal_type() AND principal_id = authz.principal_id());
CREATE POLICY own_or_audit_read ON app.retrieval_traces FOR SELECT TO joybot_app
  USING ((principal_type = authz.principal_type() AND principal_id = authz.principal_id())
         OR (authz.principal_type() = 'employee' AND authz.can('audit', 'read')));
REVOKE UPDATE, DELETE ON app.retrieval_traces FROM joybot_app;

-- Message deliveries: an append-only log (recipients are hashed); nobody reads it through the API.
CREATE POLICY append ON app.message_deliveries FOR INSERT TO joybot_app WITH CHECK (true);
REVOKE SELECT, UPDATE, DELETE ON app.message_deliveries FROM joybot_app;

-- Response cache: not used yet; closed to the API until it is (worker only).
REVOKE ALL ON app.response_cache FROM joybot_app;
