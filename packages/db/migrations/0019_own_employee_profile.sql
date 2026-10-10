-- Employees edit their own name and time zone (the staff "My profile" page). Staff have no UPDATE on
-- core.users (only admins with users:update), so this function updates just these columns on the
-- caller's own row. Email and role stay admin-managed: email is the sign-in identity.
-- p_fields holds only the fields being changed: first_name, last_name, time_zone (null = use the
-- location or business default). Time zones are validated by the assert_tz trigger.
CREATE FUNCTION authz.update_own_employee_profile(p_fields jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'employee' THEN
    RAISE EXCEPTION 'only employees edit an employee profile' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE core.users SET
    first_name = CASE WHEN p_fields ? 'first_name' THEN p_fields ->> 'first_name' ELSE first_name END,
    last_name  = CASE WHEN p_fields ? 'last_name'  THEN p_fields ->> 'last_name'  ELSE last_name  END,
    time_zone  = CASE WHEN p_fields ? 'time_zone'  THEN p_fields ->> 'time_zone'  ELSE time_zone  END
  WHERE id = authz.principal_id() AND active;
END $$;
REVOKE ALL ON FUNCTION authz.update_own_employee_profile(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.update_own_employee_profile(jsonb) TO joybot_app;
