-- Sales call status from the Sales calls page: staff mark a call completed (any time, e.g. held early)
-- or a no-show (once it has started), or put it back to confirmed. Completed and no-show calls leave
-- the upcoming list. Cancelled calls stay cancelled (book again instead).

CREATE FUNCTION authz.set_sales_call_status(p_id uuid, p_status text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_call record;
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'employee' OR NOT authz.can('website', 'update') THEN
    RAISE EXCEPTION 'not allowed to change sales calls' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_status NOT IN ('confirmed', 'completed', 'no_show') THEN
    RAISE EXCEPTION 'a sales call can be confirmed, completed or a no-show' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('core.sales_calls'));
  SELECT a.* INTO v_call FROM core.appointments a
   WHERE a.id = p_id AND a.status <> 'cancelled'
     AND a.type_id = (SELECT id FROM core.appointment_types WHERE key = 'sales_call');
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF p_status = 'no_show' AND v_call.scheduled_start > now() THEN
    RAISE EXCEPTION 'a call can be a no-show only once it has started' USING ERRCODE = 'check_violation';
  END IF;
  -- Back to confirmed: the host must still be free then.
  IF p_status = 'confirmed' AND v_call.status NOT IN ('scheduled', 'confirmed') AND v_call.employee_id IS NOT NULL
     AND NOT core.sales_host_free(v_call.employee_id, v_call.scheduled_start, v_call.scheduled_end, p_id) THEN
    RAISE EXCEPTION 'the host has another booking then; reassign or reschedule the call' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE core.appointments SET status = p_status WHERE id = p_id;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION authz.set_sales_call_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.set_sales_call_status(uuid, text) TO joybot_app;
