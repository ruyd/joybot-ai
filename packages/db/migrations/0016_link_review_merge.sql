-- Link review and customer merge (plan.md §4.3: "Link-review queue; duplicate detection + staff merge").
--
-- A merge moves everything from a source customer to a target customer and leaves the source as a
-- tombstone (status 'merged', merged_into = target) without contacts or login, so it can never be
-- matched again. Tombstones are hidden from the API and chat by the customers SELECT policies.
-- Merging and resolving link reviews need the new 'merge' action on customers (admin by default).

-- Permissions -------------------------------------------------------------------------------

ALTER TABLE core.role_permissions DROP CONSTRAINT role_permissions_action_check;
ALTER TABLE core.role_permissions ADD CONSTRAINT role_permissions_action_check
  CHECK (action IN ('read', 'create', 'update', 'delete', 'void', 'refund', 'merge'));
INSERT INTO core.role_permissions (role, resource, action, scope)
VALUES ('admin', 'customers', 'merge', 'all_including_restricted');

-- Tombstones --------------------------------------------------------------------------------

ALTER TABLE core.customers ADD COLUMN merged_into uuid REFERENCES core.customers(id);
ALTER TABLE core.customers ADD COLUMN merged_at timestamptz;
ALTER TABLE core.customers DROP CONSTRAINT customers_status_check;
ALTER TABLE core.customers ADD CONSTRAINT customers_status_check
  CHECK (status IN ('active', 'inactive', 'blocked', 'merged'));
ALTER TABLE core.customers DROP CONSTRAINT customers_check;
ALTER TABLE core.customers ADD CONSTRAINT customers_contact_check
  CHECK (status = 'merged' OR email IS NOT NULL OR phone IS NOT NULL);
ALTER TABLE core.customers ADD CONSTRAINT customers_merged_check
  CHECK ((status = 'merged') = (merged_into IS NOT NULL) AND (merged_into IS NULL) = (merged_at IS NULL)
         AND merged_into IS DISTINCT FROM id);

DROP POLICY sel ON core.customers;
CREATE POLICY sel ON core.customers FOR SELECT TO joybot_app, joybot_reader
  USING (status <> 'merged' AND authz.customer_in_scope(id, 'customers', 'read'));
DROP POLICY sel_own_created ON core.customers;
CREATE POLICY sel_own_created ON core.customers FOR SELECT TO joybot_app, joybot_reader
  USING (status <> 'merged'
         AND authz.principal_type() = 'employee'
         AND created_by = authz.principal_id()
         AND authz.can('customers', 'read')
         AND (NOT restricted OR authz.has_perm('customers', 'read', 'all_including_restricted')));

-- Stripe metadata may still carry a merged customer's number or Stripe id: follow the tombstone.
CREATE OR REPLACE FUNCTION core.match_stripe_customer(p_customer_number text, p_appointment_number text,
                                                      p_stripe_customer_id text, p_email text)
RETURNS TABLE (customer_id uuid, appointment_id uuid, location_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT t.id, m.appointment_id, coalesce(m.location_id, t.preferred_location_id)
    FROM (
      SELECT c.id AS customer_id, a.id AS appointment_id, a.location_id
        FROM core.appointments a JOIN core.customers c ON c.id = a.customer_id
       WHERE p_appointment_number IS NOT NULL AND a.appointment_number = upper(p_appointment_number)
         AND (p_customer_number IS NULL OR c.customer_number = upper(p_customer_number)
              OR EXISTS (SELECT 1 FROM core.customers x
                          WHERE x.customer_number = upper(p_customer_number) AND x.merged_into = c.id))
      UNION ALL
      SELECT c.id, NULL, NULL FROM core.customers c
       WHERE p_customer_number IS NOT NULL AND c.customer_number = upper(p_customer_number)
      UNION ALL
      SELECT c.id, NULL, NULL FROM core.customers c
       WHERE p_stripe_customer_id IS NOT NULL AND c.stripe_customer_id = p_stripe_customer_id
      UNION ALL
      SELECT c.id, NULL, NULL FROM core.customers c
       WHERE p_email IS NOT NULL AND c.email = lower(p_email) AND c.email_verified
      LIMIT 1
    ) m
    JOIN core.customers c ON c.id = m.customer_id
    JOIN core.customers t ON t.id = coalesce(c.merged_into, c.id)
$$;

-- Merge -------------------------------------------------------------------------------------

/**
 * Merges p_source into p_target. The caller needs 'merge' on both customers. The target keeps its
 * own values; empty fields are filled from the source. Refused when both have a portal login, or
 * when either is blocked. Every change is recorded by the change_log triggers.
 */
CREATE FUNCTION authz.merge_customers(p_source uuid, p_target uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  s core.customers;
  t core.customers;
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'employee' THEN
    RAISE EXCEPTION 'only employees can merge customers' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF nullif(trim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_source = p_target THEN
    RAISE EXCEPTION 'cannot merge a customer into itself' USING ERRCODE = 'check_violation';
  END IF;
  -- Lock both rows in a stable order so concurrent merges cannot deadlock or interleave.
  PERFORM 1 FROM core.customers WHERE id IN (p_source, p_target) ORDER BY id FOR UPDATE;
  SELECT * INTO s FROM core.customers WHERE id = p_source;
  SELECT * INTO t FROM core.customers WHERE id = p_target;
  IF s.id IS NULL OR t.id IS NULL OR s.status = 'merged' OR t.status = 'merged'
     OR NOT authz.customer_in_scope(s.id, 'customers', 'merge')
     OR NOT authz.customer_in_scope(t.id, 'customers', 'merge') THEN
    RAISE EXCEPTION 'customer not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF s.cognito_sub IS NOT NULL AND t.cognito_sub IS NOT NULL THEN
    RAISE EXCEPTION 'both customers have a portal login' USING ERRCODE = 'check_violation';
  END IF;
  IF s.status = 'blocked' OR t.status = 'blocked' THEN
    RAISE EXCEPTION 'unblock the customer before merging' USING ERRCODE = 'check_violation';
  END IF;

  -- Free the source's unique identifiers before the target takes them. A Stripe id the target
  -- cannot take stays on the tombstone, where Stripe matching follows merged_into.
  UPDATE core.customers
     SET status = 'merged', merged_into = t.id, merged_at = now(),
         cognito_sub = NULL, email = NULL, email_verified = false, phone = NULL, phone_verified = false,
         stripe_customer_id = CASE WHEN t.stripe_customer_id IS NULL THEN NULL ELSE stripe_customer_id END,
         organization_id = NULL, org_role = NULL,
         notes_internal = coalesce(notes_internal || E'\n', '') || 'Merged into ' || t.customer_number || ': ' || p_reason
   WHERE id = s.id;

  UPDATE core.customers c
     SET cognito_sub           = coalesce(t.cognito_sub, s.cognito_sub),
         first_name            = coalesce(t.first_name, s.first_name),
         last_name             = coalesce(t.last_name, s.last_name),
         email                 = coalesce(t.email, s.email),
         email_verified        = CASE WHEN t.email IS NOT NULL THEN t.email_verified ELSE s.email_verified END,
         phone                 = coalesce(t.phone, s.phone),
         phone_verified        = CASE WHEN t.phone IS NOT NULL THEN t.phone_verified ELSE s.phone_verified END,
         whatsapp_opt_in_at    = CASE WHEN t.phone IS NOT NULL THEN t.whatsapp_opt_in_at
                                      ELSE coalesce(t.whatsapp_opt_in_at, s.whatsapp_opt_in_at) END,
         time_zone             = coalesce(t.time_zone, s.time_zone),
         preferred_location_id = coalesce(t.preferred_location_id, s.preferred_location_id),
         date_of_birth         = coalesce(t.date_of_birth, s.date_of_birth),
         address               = coalesce(t.address, s.address),
         stripe_customer_id    = coalesce(t.stripe_customer_id, s.stripe_customer_id),
         organization_id       = CASE WHEN t.organization_id IS NULL THEN s.organization_id ELSE t.organization_id END,
         org_role              = CASE WHEN t.organization_id IS NULL THEN s.org_role ELSE t.org_role END,
         preferred_employee_id = coalesce(t.preferred_employee_id, s.preferred_employee_id),
         restricted            = t.restricted OR s.restricted,
         profile_completed_at  = coalesce(t.profile_completed_at, s.profile_completed_at),
         notes_internal        = CASE WHEN s.notes_internal IS NULL THEN t.notes_internal
                                      ELSE coalesce(t.notes_internal || E'\n', '') || 'From ' || s.customer_number || ': ' || s.notes_internal END
   WHERE c.id = t.id;

  UPDATE core.appointments SET customer_id = t.id WHERE customer_id = s.id;
  UPDATE core.payments SET customer_id = t.id WHERE customer_id = s.id;
  UPDATE core.assignments SET customer_id = t.id WHERE customer_id = s.id;
  UPDATE core.record_grants SET record_id = t.id WHERE resource = 'customer' AND record_id = s.id;
  INSERT INTO core.external_links (entity_type, entity_id, source, external_id, matched_by, excluded, refreshed_at)
  SELECT 'customer', t.id, source, external_id, matched_by, excluded, refreshed_at
    FROM core.external_links WHERE entity_type = 'customer' AND entity_id = s.id
  ON CONFLICT DO NOTHING;
  DELETE FROM core.external_links WHERE entity_type = 'customer' AND entity_id = s.id;

  -- The source's own chats (if it had a login) and staff chats about it follow the customer.
  UPDATE app.conversations SET principal_id = t.id WHERE principal_type = 'customer' AND principal_id = s.id;
  UPDATE app.conversations SET active_customer_id = t.id WHERE active_customer_id = s.id;
  UPDATE app.invites SET customer_id = t.id WHERE customer_id = s.id;
  DELETE FROM app.contact_verifications WHERE customer_id = s.id;
  UPDATE app.link_review_queue SET candidate_customer_id = t.id WHERE candidate_customer_id = s.id;
  UPDATE app.link_review_queue SET account_customer_id = t.id WHERE account_customer_id = s.id;
  -- Older tombstones point straight at the surviving customer.
  UPDATE core.customers SET merged_into = t.id WHERE merged_into = s.id;
  RETURN t.id;
END $$;

-- Pairs that staff checked and decided are different people, so duplicate detection skips them.
CREATE TABLE app.duplicate_dismissals (
  customer_a   uuid NOT NULL REFERENCES core.customers(id) ON DELETE CASCADE,
  customer_b   uuid NOT NULL REFERENCES core.customers(id) ON DELETE CASCADE,
  dismissed_by uuid NOT NULL REFERENCES core.users(id),
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_a, customer_b),
  CHECK (customer_a < customer_b)
);
GRANT SELECT, INSERT ON app.duplicate_dismissals TO joybot_app;
ALTER TABLE app.duplicate_dismissals ENABLE ROW LEVEL SECURITY;
CREATE POLICY review ON app.duplicate_dismissals TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('customers', 'merge'))
  WITH CHECK (authz.principal_type() = 'employee' AND authz.can('customers', 'merge')
              AND dismissed_by = authz.principal_id());

-- Link review -------------------------------------------------------------------------------

ALTER TABLE app.link_review_queue
  ADD COLUMN account_customer_id uuid REFERENCES core.customers(id),   -- invite accepted by this account
  ADD COLUMN resolution_note text;
ALTER TABLE app.link_review_queue DROP CONSTRAINT link_review_queue_status_check;
ALTER TABLE app.link_review_queue ADD CONSTRAINT link_review_queue_status_check
  CHECK (status IN ('open', 'linked', 'merged', 'rejected'));
CREATE INDEX link_review_queue_open ON app.link_review_queue (created_at) WHERE status = 'open';

ALTER TABLE app.link_review_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY review ON app.link_review_queue FOR SELECT TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('customers', 'merge'));
-- Customers queue their own invite acceptances; everything else is written by the functions below.
CREATE POLICY customer_insert ON app.link_review_queue FOR INSERT TO joybot_app
  WITH CHECK (authz.principal_type() = 'customer' AND account_customer_id = authz.principal_id()
              AND reason = 'invite_accepted_by_other_account' AND status = 'open');
CREATE POLICY worker_all ON app.link_review_queue TO joybot_worker USING (true) WITH CHECK (true);

/**
 * Resolves a link review.
 * - 'link': attach the waiting login (sign-up conflicts) to p_customer, which must have no login.
 * - 'merge': merge the account that accepted an invite into the invited customer.
 * - 'reject': close without changes.
 */
CREATE FUNCTION authz.resolve_link_review(p_id uuid, p_action text, p_customer uuid, p_note text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r app.link_review_queue;
  v_target uuid;
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'employee' OR NOT authz.can('customers', 'merge') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO r FROM app.link_review_queue WHERE id = p_id FOR UPDATE;
  IF r.id IS NULL THEN
    RAISE EXCEPTION 'review not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF r.status <> 'open' THEN
    RAISE EXCEPTION 'this review is already resolved' USING ERRCODE = 'check_violation';
  END IF;

  IF p_action = 'link' THEN
    IF r.account_customer_id IS NOT NULL THEN
      RAISE EXCEPTION 'this account already has a customer record; merge instead' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM core.customers WHERE cognito_sub = r.cognito_sub) THEN
      RAISE EXCEPTION 'this login is already linked' USING ERRCODE = 'check_violation';
    END IF;
    v_target := coalesce(p_customer, r.candidate_customer_id);
    UPDATE core.customers SET cognito_sub = r.cognito_sub
     WHERE id = v_target AND cognito_sub IS NULL AND status IN ('active', 'inactive')
       AND authz.customer_in_scope(id, 'customers', 'merge');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the customer already has a login, is blocked, or was not found' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE app.link_review_queue
       SET status = 'linked', candidate_customer_id = v_target, resolution_note = p_note,
           resolved_by = authz.principal_id(), resolved_at = now()
     WHERE id = r.id;
    RETURN 'linked';
  ELSIF p_action = 'merge' THEN
    IF r.account_customer_id IS NULL OR r.candidate_customer_id IS NULL THEN
      RAISE EXCEPTION 'nothing to merge for this review; link instead' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM authz.merge_customers(r.account_customer_id, r.candidate_customer_id,
                                  coalesce(nullif(trim(p_note), ''), 'Invite accepted by another account'));
    UPDATE app.link_review_queue
       SET status = 'merged', resolution_note = p_note, resolved_by = authz.principal_id(), resolved_at = now()
     WHERE id = r.id;
    RETURN 'merged';
  ELSIF p_action = 'reject' THEN
    UPDATE app.link_review_queue
       SET status = 'rejected', resolution_note = p_note, resolved_by = authz.principal_id(), resolved_at = now()
     WHERE id = r.id;
    RETURN 'rejected';
  END IF;
  RAISE EXCEPTION 'unknown action %', p_action USING ERRCODE = 'check_violation';
END $$;

-- The API tells a signed-in but unlinked customer that their account is waiting for review.
CREATE FUNCTION authz.link_review_pending(p_cognito_sub text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM app.link_review_queue
                  WHERE cognito_sub = p_cognito_sub AND status = 'open' AND account_customer_id IS NULL)
$$;
GRANT EXECUTE ON FUNCTION authz.link_review_pending(text) TO joybot_app;

REVOKE ALL ON FUNCTION authz.merge_customers(uuid, uuid, text), authz.resolve_link_review(uuid, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.merge_customers(uuid, uuid, text), authz.resolve_link_review(uuid, text, uuid, text) TO joybot_app;
