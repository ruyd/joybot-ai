-- DBA review fixes (access and races).
--
-- 1. Functions that run with the owner's rights were callable by every role (PUBLIC), so the read-only
--    chat role (joybot_reader) could run ones that write. Each now goes only to the roles that call it;
--    the others are reached through triggers or other SECURITY DEFINER functions, which run as the owner.
--    New functions no longer get EXECUTE for PUBLIC by default: grant each one explicitly.
-- 2. Customers' appointment requests take a lock per customer before their checks.

-- Recompute an invoice or order from its payments: only their triggers call these.
REVOKE ALL ON FUNCTION core.invoice_refresh(uuid), core.order_refresh(uuid) FROM PUBLIC;

-- Org admins add and remove members through the API.
REVOKE ALL ON FUNCTION authz.create_org_member(text, text, text, text), authz.remove_org_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.create_org_member(text, text, text, text), authz.remove_org_member(uuid) TO joybot_app;

-- Matching a Stripe customer bypasses RLS by design: the worker only.
REVOKE ALL ON FUNCTION core.match_stripe_customer(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.match_stripe_customer(text, text, text, text) TO joybot_worker;

-- These answer for any principal given as an argument ("what can X see about Y"). The scope checks and
-- who-can-access lists call them as the owner; the API's auth guard reads a principal's role.
-- (0003 and 0010 granted every authz function to all three app roles by name, so revoke from them too.)
REVOKE ALL ON FUNCTION authz.customer_access_reason(text, uuid, uuid, text, text), authz.org_access_reason(text, uuid, uuid, text)
  FROM PUBLIC, joybot_app, joybot_reader, joybot_worker;
REVOKE ALL ON FUNCTION authz.role_of(text, uuid) FROM PUBLIC, joybot_reader;

-- From now on, functions the migrator creates are not executable by PUBLIC until granted.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE OR REPLACE FUNCTION authz.request_appointment(p_service uuid, p_location uuid, p_start timestamptz, p_notes text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_customer uuid := authz.principal_id();
  v_service  record;
  v_end      timestamptz;
  v_id       uuid;
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'customer'
     OR NOT EXISTS (SELECT 1 FROM core.customers WHERE id = v_customer AND status = 'active') THEN
    RAISE EXCEPTION 'only active customers request appointments' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- One request at a time per customer: the "three waiting" limit and the overlap check below are
  -- check-then-insert, so two requests sent at the same moment could otherwise both pass.
  PERFORM pg_advisory_xact_lock(hashtext('authz.request_appointment'), hashtext(v_customer::text));
  SELECT duration_minutes, price, currency INTO v_service FROM core.services WHERE id = p_service AND active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown service' USING ERRCODE = 'check_violation';
  END IF;
  IF v_service.duration_minutes IS NULL THEN
    RAISE EXCEPTION 'this service cannot be booked online' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.locations WHERE id = p_location AND active) THEN
    RAISE EXCEPTION 'unknown location' USING ERRCODE = 'check_violation';
  END IF;
  IF p_start < now() + interval '1 hour' OR p_start > now() + interval '180 days' THEN
    RAISE EXCEPTION 'choose a time between one hour and 180 days from now' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM core.appointments
       WHERE customer_id = v_customer AND requested_by_customer AND reviewed_at IS NULL
         AND status = 'scheduled' AND scheduled_start > now()) >= 3 THEN
    RAISE EXCEPTION 'you already have three requests waiting for confirmation' USING ERRCODE = 'check_violation';
  END IF;
  v_end := p_start + make_interval(mins => v_service.duration_minutes);
  IF EXISTS (SELECT 1 FROM core.appointments
              WHERE customer_id = v_customer AND status IN ('scheduled', 'confirmed')
                AND scheduled_start < v_end AND scheduled_end > p_start) THEN
    RAISE EXCEPTION 'you already have an appointment at that time' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO core.appointments (customer_id, service_id, location_id, scheduled_start, scheduled_end,
                                 price_quoted, currency, notes_customer, requested_by_customer)
  VALUES (v_customer, p_service, p_location, p_start, v_end, v_service.price, v_service.currency,
          nullif(btrim(p_notes), ''), true)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
