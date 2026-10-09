-- Access checks evaluated for an explicit principal, returning *why* access is granted.
-- Powers the admin "who can access this record" panel; the session-based functions used by RLS
-- now delegate here so both always agree.

CREATE FUNCTION authz.role_has_perm(p_role text, p_resource text, p_action text, p_scope text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM core.role_permissions
                  WHERE role = p_role AND resource = p_resource AND action = p_action AND scope = p_scope)
$$;

CREATE FUNCTION authz.role_can(p_role text, p_resource text, p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM core.role_permissions
                  WHERE role = p_role AND resource = p_resource AND action = p_action)
$$;

/** Reason the principal may perform p_action on the customer's p_resource, or NULL. */
CREATE FUNCTION authz.customer_access_reason(p_type text, p_me uuid, p_customer uuid,
                                             p_resource text, p_action text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_role text := authz.role_of(p_type, p_me);
  c      record;
  v_restricted boolean;
BEGIN
  IF p_me IS NULL OR p_customer IS NULL OR v_role IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT cu.id, cu.organization_id, cu.restricted, cu.preferred_location_id, cu.created_by,
         coalesce(o.restricted, false) AS org_restricted
    INTO c
    FROM core.customers cu
    LEFT JOIN core.organizations o ON o.id = cu.organization_id
   WHERE cu.id = p_customer;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF p_type = 'customer' THEN
    IF p_customer = p_me AND authz.role_has_perm(v_role, p_resource, p_action, 'self') THEN
      RETURN 'self';
    END IF;
    IF c.organization_id IS NOT NULL AND authz.role_has_perm(v_role, p_resource, p_action, 'org')
       AND EXISTS (SELECT 1 FROM core.customers me
                    WHERE me.id = p_me AND me.organization_id = c.organization_id
                      AND me.org_role = 'org_admin' AND me.status = 'active') THEN
      RETURN 'org_admin';
    END IF;
    RETURN NULL;
  END IF;

  IF p_type <> 'employee' THEN
    RETURN NULL;
  END IF;

  v_restricted := c.restricted OR c.org_restricted;

  IF authz.role_has_perm(v_role, p_resource, p_action, 'all_including_restricted') THEN
    RETURN 'role:all_including_restricted';
  END IF;
  IF NOT v_restricted AND authz.role_has_perm(v_role, p_resource, p_action, 'all') THEN
    RETURN 'role:all';
  END IF;
  IF NOT v_restricted AND authz.role_has_perm(v_role, p_resource, p_action, 'location') AND (
       c.preferred_location_id IN (SELECT location_id FROM core.user_locations WHERE user_id = p_me)
       OR EXISTS (SELECT 1 FROM core.appointments a
                   JOIN core.user_locations ul ON ul.location_id = a.location_id AND ul.user_id = p_me
                  WHERE a.customer_id = p_customer)) THEN
    RETURN 'location';
  END IF;
  IF authz.role_has_perm(v_role, p_resource, p_action, 'assigned') AND EXISTS (
       SELECT 1 FROM core.assignments s
        WHERE s.user_id = p_me
          AND (s.customer_id = p_customer
               OR (c.organization_id IS NOT NULL AND s.organization_id = c.organization_id))
          AND s.starts_at <= now() AND (s.ends_at IS NULL OR s.ends_at > now())) THEN
    RETURN 'assignment';
  END IF;
  IF NOT v_restricted AND authz.role_has_perm(v_role, p_resource, p_action, 'own') AND (
       c.created_by = p_me
       OR EXISTS (SELECT 1 FROM core.appointments a WHERE a.customer_id = p_customer AND a.employee_id = p_me)) THEN
    RETURN 'own';
  END IF;
  IF p_action IN ('read', 'create', 'update') AND authz.role_can(v_role, p_resource, p_action) AND EXISTS (
       SELECT 1 FROM core.record_grants g
        WHERE g.user_id = p_me
          AND p_action = ANY (g.actions)
          AND (g.expires_at IS NULL OR g.expires_at > now())
          AND ((g.resource = 'customer' AND g.record_id = p_customer)
               OR (g.resource = 'organization' AND g.record_id = c.organization_id))) THEN
    RETURN 'grant';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION authz.org_access_reason(p_type text, p_me uuid, p_org uuid, p_action text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_role text := authz.role_of(p_type, p_me);
  o      record;
BEGIN
  IF p_me IS NULL OR p_org IS NULL OR v_role IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT id, restricted, created_by INTO o FROM core.organizations WHERE id = p_org;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF p_type = 'customer' THEN
    IF EXISTS (SELECT 1 FROM core.customers me
                WHERE me.id = p_me AND me.organization_id = p_org AND me.status = 'active'
                  AND me.org_role = 'org_admin') AND authz.role_has_perm(v_role, 'organizations', p_action, 'org') THEN
      RETURN 'org_admin';
    END IF;
    IF EXISTS (SELECT 1 FROM core.customers me
                WHERE me.id = p_me AND me.organization_id = p_org AND me.status = 'active')
       AND authz.role_has_perm(v_role, 'organizations', p_action, 'self') THEN
      RETURN 'member';
    END IF;
    RETURN NULL;
  END IF;

  IF p_type <> 'employee' THEN
    RETURN NULL;
  END IF;

  IF authz.role_has_perm(v_role, 'organizations', p_action, 'all_including_restricted') THEN
    RETURN 'role:all_including_restricted';
  END IF;
  IF NOT o.restricted AND authz.role_has_perm(v_role, 'organizations', p_action, 'all') THEN
    RETURN 'role:all';
  END IF;
  IF NOT o.restricted AND authz.role_has_perm(v_role, 'organizations', p_action, 'location') AND EXISTS (
       SELECT 1 FROM core.customers m
        WHERE m.organization_id = p_org
          AND (m.preferred_location_id IN (SELECT location_id FROM core.user_locations WHERE user_id = p_me)
               OR EXISTS (SELECT 1 FROM core.appointments a
                           JOIN core.user_locations ul ON ul.location_id = a.location_id AND ul.user_id = p_me
                          WHERE a.customer_id = m.id))) THEN
    RETURN 'location';
  END IF;
  IF authz.role_has_perm(v_role, 'organizations', p_action, 'assigned') AND EXISTS (
       SELECT 1 FROM core.assignments s
        WHERE s.user_id = p_me AND s.organization_id = p_org
          AND s.starts_at <= now() AND (s.ends_at IS NULL OR s.ends_at > now())) THEN
    RETURN 'assignment';
  END IF;
  IF NOT o.restricted AND authz.role_has_perm(v_role, 'organizations', p_action, 'own') AND o.created_by = p_me THEN
    RETURN 'own';
  END IF;
  IF p_action IN ('read', 'create', 'update') AND authz.role_can(v_role, 'organizations', p_action) AND EXISTS (
       SELECT 1 FROM core.record_grants g
        WHERE g.user_id = p_me AND g.resource = 'organization' AND g.record_id = p_org
          AND p_action = ANY (g.actions)
          AND (g.expires_at IS NULL OR g.expires_at > now())) THEN
    RETURN 'grant';
  END IF;
  RETURN NULL;
END $$;

-- Session-based checks used by RLS now delegate to the explicit versions.
CREATE OR REPLACE FUNCTION authz.customer_in_scope(p_customer uuid, p_resource text, p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT authz.customer_access_reason(authz.principal_type(), authz.principal_id(), p_customer, p_resource, p_action)
         IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION authz.org_in_scope(p_org uuid, p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT authz.org_access_reason(authz.principal_type(), authz.principal_id(), p_org, p_action) IS NOT NULL
$$;

/** Employees who can access a customer, with the reason (admin "who can access" panel). */
CREATE FUNCTION authz.who_can_access_customer(p_customer uuid)
RETURNS TABLE (user_id uuid, first_name text, last_name text, role text, can_read text, can_update text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.id, u.first_name, u.last_name, u.role,
         authz.customer_access_reason('employee', u.id, p_customer, 'customers', 'read'),
         authz.customer_access_reason('employee', u.id, p_customer, 'customers', 'update')
    FROM core.users u
   WHERE u.active
     AND authz.customer_access_reason('employee', u.id, p_customer, 'customers', 'read') IS NOT NULL
     -- Only callers allowed to manage access may ask.
     AND authz.can('access', 'read')
   ORDER BY u.role, u.last_name, u.first_name
$$;

CREATE FUNCTION authz.who_can_access_org(p_org uuid)
RETURNS TABLE (user_id uuid, first_name text, last_name text, role text, can_read text, can_update text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.id, u.first_name, u.last_name, u.role,
         authz.org_access_reason('employee', u.id, p_org, 'read'),
         authz.org_access_reason('employee', u.id, p_org, 'update')
    FROM core.users u
   WHERE u.active
     AND authz.org_access_reason('employee', u.id, p_org, 'read') IS NOT NULL
     AND authz.can('access', 'read')
   ORDER BY u.role, u.last_name, u.first_name
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA authz TO joybot_app, joybot_reader, joybot_worker;
