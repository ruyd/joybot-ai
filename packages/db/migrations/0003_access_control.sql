-- Access control for records and organizations (plan.md §4.2).
--
-- The API sets these per transaction (SET LOCAL / set_config(..., true)):
--   app.principal_type  'employee' | 'customer'
--   app.principal_id    core.users.id or core.customers.id
-- The principal's role is always derived from the database, never trusted from the session.

CREATE TABLE core.role_permissions (
  role     text NOT NULL CHECK (role IN ('admin', 'staff', 'org_admin', 'customer')),
  resource text NOT NULL CHECK (resource IN ('customers', 'organizations', 'appointments', 'payments',
                                             'services', 'locations', 'tickets', 'users', 'settings',
                                             'audit', 'notes_internal', 'access')),
  action   text NOT NULL CHECK (action IN ('read', 'create', 'update', 'delete', 'void', 'refund')),
  scope    text NOT NULL CHECK (scope IN ('all_including_restricted', 'all', 'location', 'assigned',
                                          'own', 'recorded', 'org', 'self')),
  PRIMARY KEY (role, resource, action, scope)
);

CREATE TABLE core.assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES core.organizations(id) ON DELETE CASCADE,
  customer_id     uuid REFERENCES core.customers(id) ON DELETE CASCADE,
  starts_at       timestamptz NOT NULL DEFAULT now(),
  ends_at         timestamptz,
  created_by      uuid REFERENCES core.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((organization_id IS NULL) <> (customer_id IS NULL)),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX assignments_user ON core.assignments (user_id);
CREATE INDEX assignments_org ON core.assignments (organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX assignments_customer ON core.assignments (customer_id) WHERE customer_id IS NOT NULL;

CREATE TABLE core.record_grants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  resource   text NOT NULL CHECK (resource IN ('customer', 'organization')),
  record_id  uuid NOT NULL,
  actions    text[] NOT NULL CHECK (actions <> '{}' AND actions <@ ARRAY['read', 'create', 'update']),
  reason     text NOT NULL,
  granted_by uuid NOT NULL REFERENCES core.users(id),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX record_grants_user ON core.record_grants (user_id, resource, record_id);

-- Principal helpers ------------------------------------------------------------------

CREATE FUNCTION authz.principal_type() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.principal_type', true), '')
$$;

CREATE FUNCTION authz.principal_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.principal_id', true), '')::uuid
$$;

-- Role derived from the database: active employee role, or 'org_admin' / 'customer'.
CREATE FUNCTION authz.principal_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE authz.principal_type()
    WHEN 'employee' THEN (SELECT u.role FROM core.users u WHERE u.id = authz.principal_id() AND u.active)
    WHEN 'customer' THEN (
      SELECT CASE WHEN c.org_role = 'org_admin' THEN 'org_admin' ELSE 'customer' END
      FROM core.customers c
      WHERE c.id = authz.principal_id() AND c.status = 'active')
  END
$$;

CREATE FUNCTION authz.has_perm(p_resource text, p_action text, p_scope text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.role_permissions
    WHERE role = authz.principal_role() AND resource = p_resource
      AND action = p_action AND scope = p_scope)
$$;

-- Capability check without a specific record (any scope).
CREATE FUNCTION authz.can(p_resource text, p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.role_permissions
    WHERE role = authz.principal_role() AND resource = p_resource AND action = p_action)
$$;

CREATE FUNCTION authz.my_location_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT location_id FROM core.user_locations
  WHERE authz.principal_type() = 'employee' AND user_id = authz.principal_id()
$$;

-- Record-level checks ------------------------------------------------------------------

-- Is the customer (and its records of p_resource) in the principal's scope for p_action?
CREATE FUNCTION authz.customer_in_scope(p_customer uuid, p_resource text, p_action text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_type text := authz.principal_type();
  v_me   uuid := authz.principal_id();
  c      record;
  v_restricted boolean;
BEGIN
  IF v_me IS NULL OR p_customer IS NULL OR authz.principal_role() IS NULL THEN
    RETURN false;
  END IF;

  SELECT cu.id, cu.organization_id, cu.restricted, cu.preferred_location_id, cu.created_by,
         coalesce(o.restricted, false) AS org_restricted
    INTO c
    FROM core.customers cu
    LEFT JOIN core.organizations o ON o.id = cu.organization_id
   WHERE cu.id = p_customer;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_type = 'customer' THEN
    IF p_customer = v_me AND authz.has_perm(p_resource, p_action, 'self') THEN
      RETURN true;
    END IF;
    IF c.organization_id IS NOT NULL AND authz.has_perm(p_resource, p_action, 'org') THEN
      RETURN EXISTS (SELECT 1 FROM core.customers me
                      WHERE me.id = v_me AND me.organization_id = c.organization_id
                        AND me.org_role = 'org_admin' AND me.status = 'active');
    END IF;
    RETURN false;
  END IF;

  IF v_type <> 'employee' THEN
    RETURN false;
  END IF;

  v_restricted := c.restricted OR c.org_restricted;

  IF authz.has_perm(p_resource, p_action, 'all_including_restricted') THEN
    RETURN true;
  END IF;

  IF NOT v_restricted AND authz.has_perm(p_resource, p_action, 'all') THEN
    RETURN true;
  END IF;

  IF NOT v_restricted AND authz.has_perm(p_resource, p_action, 'location') AND (
       c.preferred_location_id IN (SELECT authz.my_location_ids())
       OR EXISTS (SELECT 1 FROM core.appointments a
                   WHERE a.customer_id = p_customer
                     AND a.location_id IN (SELECT authz.my_location_ids()))) THEN
    RETURN true;
  END IF;

  -- Assignments include restricted records (that is their purpose).
  IF authz.has_perm(p_resource, p_action, 'assigned') AND EXISTS (
       SELECT 1 FROM core.assignments s
        WHERE s.user_id = v_me
          AND (s.customer_id = p_customer
               OR (c.organization_id IS NOT NULL AND s.organization_id = c.organization_id))
          AND s.starts_at <= now() AND (s.ends_at IS NULL OR s.ends_at > now())) THEN
    RETURN true;
  END IF;

  IF NOT v_restricted AND authz.has_perm(p_resource, p_action, 'own') AND (
       c.created_by = v_me
       OR EXISTS (SELECT 1 FROM core.appointments a
                   WHERE a.customer_id = p_customer AND a.employee_id = v_me)) THEN
    RETURN true;
  END IF;

  -- Record grants: extend reach, never capability (the role must allow the action somewhere).
  IF p_action IN ('read', 'create', 'update') AND authz.can(p_resource, p_action) AND EXISTS (
       SELECT 1 FROM core.record_grants g
        WHERE g.user_id = v_me
          AND p_action = ANY (g.actions)
          AND (g.expires_at IS NULL OR g.expires_at > now())
          AND ((g.resource = 'customer' AND g.record_id = p_customer)
               OR (g.resource = 'organization' AND g.record_id = c.organization_id))) THEN
    RETURN true;
  END IF;

  RETURN false;
END $$;

CREATE FUNCTION authz.org_in_scope(p_org uuid, p_action text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_type text := authz.principal_type();
  v_me   uuid := authz.principal_id();
  o      record;
BEGIN
  IF v_me IS NULL OR p_org IS NULL OR authz.principal_role() IS NULL THEN
    RETURN false;
  END IF;

  SELECT id, restricted, created_by INTO o FROM core.organizations WHERE id = p_org;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_type = 'customer' THEN
    RETURN EXISTS (
      SELECT 1 FROM core.customers me
       WHERE me.id = v_me AND me.organization_id = p_org AND me.status = 'active'
         AND (authz.has_perm('organizations', p_action, 'self')
              OR (me.org_role = 'org_admin' AND authz.has_perm('organizations', p_action, 'org'))));
  END IF;

  IF v_type <> 'employee' THEN
    RETURN false;
  END IF;

  IF authz.has_perm('organizations', p_action, 'all_including_restricted') THEN
    RETURN true;
  END IF;
  IF NOT o.restricted AND authz.has_perm('organizations', p_action, 'all') THEN
    RETURN true;
  END IF;
  IF NOT o.restricted AND authz.has_perm('organizations', p_action, 'location') AND EXISTS (
       SELECT 1 FROM core.customers m
        WHERE m.organization_id = p_org
          AND (m.preferred_location_id IN (SELECT authz.my_location_ids())
               OR EXISTS (SELECT 1 FROM core.appointments a
                           WHERE a.customer_id = m.id
                             AND a.location_id IN (SELECT authz.my_location_ids())))) THEN
    RETURN true;
  END IF;
  IF authz.has_perm('organizations', p_action, 'assigned') AND EXISTS (
       SELECT 1 FROM core.assignments s
        WHERE s.user_id = v_me AND s.organization_id = p_org
          AND s.starts_at <= now() AND (s.ends_at IS NULL OR s.ends_at > now())) THEN
    RETURN true;
  END IF;
  IF NOT o.restricted AND authz.has_perm('organizations', p_action, 'own') AND o.created_by = v_me THEN
    RETURN true;
  END IF;
  IF p_action IN ('read', 'create', 'update') AND authz.can('organizations', p_action) AND EXISTS (
       SELECT 1 FROM core.record_grants g
        WHERE g.user_id = v_me AND g.resource = 'organization' AND g.record_id = p_org
          AND p_action = ANY (g.actions)
          AND (g.expires_at IS NULL OR g.expires_at > now())) THEN
    RETURN true;
  END IF;
  RETURN false;
END $$;

CREATE FUNCTION authz.appointment_in_scope(p_customer uuid, p_employee uuid, p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT authz.customer_in_scope(p_customer, 'appointments', p_action)
      OR (authz.principal_type() = 'employee'
          AND p_employee = authz.principal_id()
          AND authz.has_perm('appointments', p_action, 'own'))
$$;

CREATE FUNCTION authz.payment_in_scope(p_customer uuid, p_location uuid, p_source text,
                                       p_recorded_by uuid, p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    -- Staff may edit only manual payments they recorded (same-day rule enforced by the API).
    WHEN p_action = 'update' AND authz.principal_type() = 'employee'
         AND p_source = 'manual' AND p_recorded_by = authz.principal_id()
         AND authz.has_perm('payments', 'update', 'recorded') THEN true
    -- Unmatched Stripe payments (no customer yet): employees by broad or location scope.
    WHEN p_customer IS NULL THEN
      authz.principal_type() = 'employee' AND (
        authz.has_perm('payments', p_action, 'all_including_restricted')
        OR authz.has_perm('payments', p_action, 'all')
        OR (authz.has_perm('payments', p_action, 'location')
            AND p_location IN (SELECT authz.my_location_ids())))
    ELSE authz.customer_in_scope(p_customer, 'payments', p_action)
  END
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA authz TO joybot_app, joybot_reader, joybot_worker;
