-- Maps an authenticated identity to a principal before any RLS context exists.
-- SECURITY DEFINER so the API (joybot_app) can resolve logins without broad read access.

CREATE FUNCTION authz.resolve_principal(p_audience text, p_cognito_sub text)
RETURNS TABLE (principal_type text, principal_id uuid, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT 'employee', u.id, u.role
    FROM core.users u
   WHERE p_audience = 'employee' AND u.cognito_sub = p_cognito_sub AND u.active
  UNION ALL
  SELECT 'customer', c.id, CASE WHEN c.org_role = 'org_admin' THEN 'org_admin' ELSE 'customer' END
    FROM core.customers c
   WHERE p_audience = 'customer' AND c.cognito_sub = p_cognito_sub AND c.status = 'active'
$$;

-- Role of an explicit principal id (used by local dev auth and tests).
CREATE FUNCTION authz.role_of(p_type text, p_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE p_type
    WHEN 'employee' THEN (SELECT u.role FROM core.users u WHERE u.id = p_id AND u.active)
    WHEN 'customer' THEN (SELECT CASE WHEN c.org_role = 'org_admin' THEN 'org_admin' ELSE 'customer' END
                            FROM core.customers c WHERE c.id = p_id AND c.status = 'active')
  END
$$;

GRANT EXECUTE ON FUNCTION authz.resolve_principal(text, text), authz.role_of(text, uuid)
  TO joybot_app, joybot_worker;

-- Permission matrix for the API's ability builder (customers cannot read core.role_permissions directly).
CREATE FUNCTION authz.permission_rows()
RETURNS TABLE (role text, resource text, action text, scope text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT role, resource, action, scope FROM core.role_permissions
$$;
GRANT EXECUTE ON FUNCTION authz.permission_rows() TO joybot_app, joybot_reader, joybot_worker;
