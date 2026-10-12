-- Notifying admins when a visitor books a sales call.
--
-- 1. A JoyBot notification (Team › Notifications) to every active admin, linking to the call. The
--    call's host already gets "New appointment for you" (app.team_notify_appointment), so an admin
--    who is the host is skipped here.
-- 2. An email to every active admin with the call and an add-to-calendar invite, sent by the API
--    after booking, when the booking page's setup allows it (sales_call_settings.email_admins,
--    toggled in the Hosts section; on by default). authz.sales_call_admin_recipients() lists them.

ALTER TABLE core.sales_call_settings ADD COLUMN email_admins boolean NOT NULL DEFAULT true;

CREATE FUNCTION app.notify_sales_call_booked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_admin uuid;
BEGIN
  IF NEW.type_id IS DISTINCT FROM (SELECT id FROM core.appointment_types WHERE key = 'sales_call')
     OR NEW.status NOT IN ('scheduled', 'confirmed') THEN
    RETURN NULL;
  END IF;
  FOR v_admin IN SELECT u.id FROM core.users u WHERE u.role = 'admin' AND u.active AND u.id IS DISTINCT FROM NEW.employee_id LOOP
    PERFORM app.team_notify(v_admin,
      'New sales call booked: ' || coalesce(NEW.contact_name, 'a visitor') || ', ' || app.team_when(NEW.scheduled_start, NEW.location_id)
        || coalesce(' with ' || (SELECT nullif(concat_ws(' ', s.first_name, s.last_name), '') FROM core.users s WHERE s.id = NEW.employee_id), ' (no host yet)'),
      '/staff/sales-calls?call=' || NEW.id);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER notify_sales_call_booked AFTER INSERT ON core.appointments
  FOR EACH ROW EXECUTE FUNCTION app.notify_sales_call_booked();

-- Who gets the "new sales call" email: active admins with an email address, when it is on.
CREATE FUNCTION authz.sales_call_admin_recipients() RETURNS TABLE (email text, first_name text, time_zone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.email::text, u.first_name, coalesce(u.time_zone, (SELECT default_time_zone FROM core.settings WHERE id = 1))
    FROM core.users u
   WHERE u.role = 'admin' AND u.active AND u.email IS NOT NULL
     AND (SELECT email_admins FROM core.sales_call_settings WHERE id = 1)
   ORDER BY u.email
$$;
REVOKE ALL ON FUNCTION authz.sales_call_admin_recipients() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.sales_call_admin_recipients() TO joybot_app;
