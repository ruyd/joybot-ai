-- Appointment types, and sales calls as appointments.
--
-- core.appointment_types: a name and a color label for each kind of appointment (the calendar draws
-- them in that color). System types (`system`) are read-only and used by the app itself: 'sales_call'.
-- The others start as 'service' and 'installation' and are edited from the calendar by whoever may
-- edit services (admins by default). Every appointment has a type; existing ones become 'service'.
--
-- Sales calls move from core.sales_calls into core.appointments with the 'sales_call' type. A visitor
-- is not a customer: the appointment has no customer, service or location, and keeps the visitor's
-- name, email and time zone (contact_*). Every other type still needs all three (checked by trigger).
-- Booked calls are 'confirmed'. After a call, staff log its outcome (follow up, conversion, potential,
-- do not call) with notes; the call is then completed.
--
-- Being appointments, sales calls now count everywhere appointments do: an employee's double-booking
-- check, colleagues' busy times on the calendar, and the hosts' availability. Staff who may read the
-- website see every sales call; a host sees their own (appointments 'own' scope).

-- Types -------------------------------------------------------------------------------------------

CREATE TABLE core.appointment_types (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  name       text NOT NULL UNIQUE CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  color      text NOT NULL CHECK (color ~ '^#[0-9a-f]{6}$'),
  system     boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO core.appointment_types (key, name, color, system, sort_order) VALUES
  ('sales_call', 'Sales call', '#8b5cf6', true, 0),
  ('service', 'Service', '#3b82f6', false, 10),
  ('installation', 'Installation', '#f59e0b', false, 20);

-- System types are read-only (also for the owner, so migrations change them on purpose only).
CREATE FUNCTION core.appointment_type_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.system THEN
      RAISE EXCEPTION 'system appointment types come with the app' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.system THEN
    RAISE EXCEPTION 'system appointment types are read-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.system OR NEW.key IS DISTINCT FROM OLD.key) THEN
    RAISE EXCEPTION 'a type''s key and system flag cannot change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON core.appointment_types FOR EACH ROW EXECUTE FUNCTION core.appointment_type_guard();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.appointment_types FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.appointment_types FOR EACH ROW EXECUTE FUNCTION core.audit_row();

ALTER TABLE core.appointment_types ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON core.appointment_types TO joybot_app, joybot_reader;
GRANT INSERT, UPDATE, DELETE ON core.appointment_types TO joybot_app;
CREATE POLICY sel ON core.appointment_types FOR SELECT TO joybot_app, joybot_reader USING (true);
CREATE POLICY ins ON core.appointment_types FOR INSERT TO joybot_app
  WITH CHECK (authz.principal_type() = 'employee' AND authz.can('services', 'create'));
CREATE POLICY upd ON core.appointment_types FOR UPDATE TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('services', 'update'))
  WITH CHECK (authz.principal_type() = 'employee' AND authz.can('services', 'update'));
CREATE POLICY del ON core.appointment_types FOR DELETE TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('services', 'delete'));

-- Appointments ------------------------------------------------------------------------------------

ALTER TABLE core.appointments
  ADD COLUMN type_id           uuid REFERENCES core.appointment_types(id),
  ADD COLUMN contact_name      text CHECK (length(btrim(contact_name)) BETWEEN 1 AND 120),
  ADD COLUMN contact_email     citext CHECK (length(contact_email) <= 254 AND contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  ADD COLUMN contact_time_zone text,
  ADD COLUMN outcome           text CHECK (outcome IN ('follow_up', 'conversion', 'potential', 'do_not_call')),
  ADD COLUMN outcome_notes     text CHECK (length(outcome_notes) <= 2000),
  ADD COLUMN outcome_at        timestamptz,
  ADD COLUMN outcome_by        uuid REFERENCES core.users(id);
UPDATE core.appointments SET type_id = (SELECT id FROM core.appointment_types WHERE key = 'service');
ALTER TABLE core.appointments
  ALTER COLUMN type_id SET NOT NULL,
  ALTER COLUMN customer_id DROP NOT NULL,
  ALTER COLUMN service_id DROP NOT NULL,
  ALTER COLUMN location_id DROP NOT NULL;
CREATE INDEX appointments_type ON core.appointments (type_id, scheduled_start);
CREATE INDEX appointments_contact_email ON core.appointments (contact_email, scheduled_start) WHERE contact_email IS NOT NULL;

-- A new appointment is a 'service' unless it says otherwise. Sales calls need the visitor's name and
-- email; every other type a customer, service and location. Nothing moves into or out of a system type.
CREATE FUNCTION core.appointment_type_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_key text;
BEGIN
  IF NEW.type_id IS NULL THEN
    NEW.type_id := (SELECT id FROM core.appointment_types WHERE key = 'service');
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.type_id IS DISTINCT FROM OLD.type_id
     AND EXISTS (SELECT 1 FROM core.appointment_types WHERE id IN (NEW.type_id, OLD.type_id) AND system) THEN
    RAISE EXCEPTION 'appointments cannot change to or from a system type' USING ERRCODE = 'check_violation';
  END IF;
  SELECT key INTO v_key FROM core.appointment_types WHERE id = NEW.type_id;
  IF v_key = 'sales_call' THEN
    IF NEW.customer_id IS NULL AND (NEW.contact_name IS NULL OR NEW.contact_email IS NULL) THEN
      RAISE EXCEPTION 'a sales call needs a name and an email' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.customer_id IS NULL OR NEW.service_id IS NULL OR NEW.location_id IS NULL THEN
    RAISE EXCEPTION 'an appointment needs a customer, a service and a location' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER type_rules BEFORE INSERT OR UPDATE ON core.appointments FOR EACH ROW EXECUTE FUNCTION core.appointment_type_rules();

-- Sales calls (no customer): employees who may read the website see them, those who may update it
-- change them. Hosts also see and change their own through the existing policies ('own' scope).
CREATE POLICY sel_sales_calls ON core.appointments FOR SELECT TO joybot_app, joybot_reader
  USING (customer_id IS NULL AND authz.principal_type() = 'employee' AND authz.can('website', 'read'));
CREATE POLICY upd_sales_calls ON core.appointments FOR UPDATE TO joybot_app
  USING (customer_id IS NULL AND authz.principal_type() = 'employee' AND authz.can('website', 'update'))
  WITH CHECK (customer_id IS NULL AND authz.principal_type() = 'employee' AND authz.can('website', 'update'));

-- Team notifications: a sales call has no service or location (its type, the business time zone).
CREATE OR REPLACE FUNCTION app.team_when(p_at timestamptz, p_location uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
    (SELECT to_char(p_at AT TIME ZONE l.time_zone, 'Dy Mon FMDD, FMHH12:MI AM') || ' (' || l.name || ')' FROM core.locations l WHERE l.id = p_location),
    (SELECT to_char(p_at AT TIME ZONE s.default_time_zone, 'Dy Mon FMDD, FMHH12:MI AM') || ' (online)' FROM core.settings s WHERE s.id = 1))
$$;

CREATE OR REPLACE FUNCTION app.team_notify_appointment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := CASE WHEN authz.principal_type() = 'employee' THEN authz.principal_id() END;
  v_service text;
  v_user uuid;
BEGIN
  SELECT coalesce((SELECT name FROM core.services WHERE id = NEW.service_id),
                  (SELECT name FROM core.appointment_types WHERE id = NEW.type_id), 'Appointment') INTO v_service;
  IF NEW.employee_id IS NOT NULL AND NEW.employee_id IS DISTINCT FROM v_actor
     AND NEW.status IN ('scheduled', 'confirmed')
     AND (TG_OP = 'INSERT' OR NEW.employee_id IS DISTINCT FROM OLD.employee_id) THEN
    PERFORM app.team_notify(NEW.employee_id,
      'New appointment for you: ' || v_service || coalesce(' with ' || NEW.contact_name, '') || ', ' || app.team_when(NEW.scheduled_start, NEW.location_id),
      CASE WHEN NEW.customer_id IS NULL THEN '/staff/sales-calls' ELSE '/staff/calendar' END);
  END IF;
  IF TG_OP = 'INSERT' AND NEW.requested_by_customer THEN
    FOR v_user IN
      SELECT ul.user_id FROM core.user_locations ul JOIN core.users u ON u.id = ul.user_id
       WHERE ul.location_id = NEW.location_id AND u.active
    LOOP
      PERFORM app.team_notify(v_user,
        'Booking request: ' || v_service || ', ' || app.team_when(NEW.scheduled_start, NEW.location_id), '/staff/review');
    END LOOP;
  END IF;
  RETURN NULL;
END $$;

-- Sales calls move in ------------------------------------------------------------------------------

ALTER TABLE core.appointments DISABLE TRIGGER team_notify;
INSERT INTO core.appointments (id, type_id, employee_id, scheduled_start, scheduled_end, status, price_quoted, currency,
                               notes_customer, contact_name, contact_email, contact_time_zone, created_at)
SELECT c.id, (SELECT id FROM core.appointment_types WHERE key = 'sales_call'), c.assigned_to, c.starts_at, c.ends_at,
       CASE c.status WHEN 'booked' THEN 'confirmed' ELSE 'cancelled' END, 0,
       (SELECT default_currency FROM core.settings WHERE id = 1), c.notes, c.name, c.email, c.time_zone, c.created_at
  FROM core.sales_calls c;
ALTER TABLE core.appointments ENABLE TRIGGER team_notify;

DROP FUNCTION authz.sales_call_details(uuid);
DROP TABLE core.sales_calls;

-- Availability, now over appointments --------------------------------------------------------------

-- Is this employee free for a call from p_start to p_end (ignoring one appointment, the one being moved)?
CREATE OR REPLACE FUNCTION core.sales_host_free(p_user uuid, p_start timestamptz, p_end timestamptz, p_ignore uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM core.users u WHERE u.id = p_user AND u.active)
     AND NOT EXISTS (SELECT 1 FROM core.time_off t WHERE t.user_id = p_user AND t.starts_at < p_end AND t.ends_at > p_start)
     AND NOT EXISTS (SELECT 1 FROM core.appointments a
                      WHERE a.employee_id = p_user AND a.status IN ('scheduled', 'confirmed') AND a.id IS DISTINCT FROM p_ignore
                        AND a.scheduled_start < p_end AND a.scheduled_end > p_start)
     AND (NOT EXISTS (SELECT 1 FROM core.working_hours h WHERE h.user_id = p_user)
          OR EXISTS (SELECT 1 FROM core.working_intervals(p_start - interval '1 day', p_end + interval '1 day') w
                      WHERE w.employee_id = p_user AND w.starts_at <= p_start AND w.ends_at >= p_end))
$$;

-- Booked sales calls (ignoring one).
CREATE FUNCTION core.sales_call_booked(p_ignore uuid DEFAULT NULL) RETURNS SETOF core.appointments
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.* FROM core.appointments a
   WHERE a.type_id = (SELECT id FROM core.appointment_types WHERE key = 'sales_call')
     AND a.status IN ('scheduled', 'confirmed') AND a.id IS DISTINCT FROM p_ignore
$$;

CREATE OR REPLACE FUNCTION core.sales_call_pick_host(p_start timestamptz, p_end timestamptz, p_ignore uuid DEFAULT NULL, p_prefer uuid DEFAULT NULL) RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT h.user_id
    FROM core.sales_call_hosts h
   WHERE core.sales_host_free(h.user_id, p_start, p_end, p_ignore)
   ORDER BY h.user_id = p_prefer DESC NULLS LAST,
            (SELECT count(*) FROM core.sales_call_booked() c WHERE c.employee_id = h.user_id AND c.scheduled_start > now()),
            h.created_at, h.user_id
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION core.sales_call_open(p_start timestamptz, p_end timestamptz, p_ignore uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM core.sales_call_hosts)
    THEN core.sales_call_pick_host(p_start, p_end, p_ignore) IS NOT NULL
    ELSE NOT EXISTS (SELECT 1 FROM core.sales_call_booked(p_ignore) c
                      WHERE c.employee_id IS NULL AND c.scheduled_start < p_end AND c.scheduled_end > p_start)
  END
$$;

CREATE OR REPLACE FUNCTION authz.book_sales_call(p_name text, p_email text, p_start timestamptz, p_time_zone text, p_notes text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id   uuid;
  v_type uuid := (SELECT id FROM core.appointment_types WHERE key = 'sales_call');
  v_end  timestamptz := p_start + make_interval(mins => (SELECT duration_minutes FROM core.sales_call_settings WHERE id = 1));
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('core.sales_calls'));
  IF NOT EXISTS (SELECT 1 FROM authz.sales_call_slots(p_start - interval '1 minute', p_start + interval '1 minute') t WHERE t = p_start) THEN
    RAISE EXCEPTION 'that time is not available; please choose another' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM core.sales_call_booked() c
       WHERE lower(c.contact_email::text) = lower(btrim(p_email)) AND c.scheduled_start > now()) >= 2 THEN
    RAISE EXCEPTION 'you already have calls booked with us' USING ERRCODE = 'check_violation';
  END IF;
  -- Booked by visitors (no employee created them) in the last hour, cancelled ones included.
  IF (SELECT count(*) FROM core.appointments
       WHERE type_id = v_type AND created_by IS NULL AND created_at > now() - interval '1 hour') >= 10 THEN
    RAISE EXCEPTION 'we are getting a lot of bookings right now; please try again later' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO core.appointments (type_id, employee_id, scheduled_start, scheduled_end, status, price_quoted, currency,
                                 notes_customer, contact_name, contact_email, contact_time_zone)
  VALUES (v_type, core.sales_call_pick_host(p_start, v_end), p_start, v_end, 'confirmed', 0,
          (SELECT default_currency FROM core.settings WHERE id = 1), nullif(btrim(p_notes), ''),
          btrim(p_name), lower(btrim(p_email)), (SELECT name FROM pg_timezone_names WHERE name = p_time_zone LIMIT 1))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Staff move a booked sales call (same length): its host when free then, else another free host.
CREATE OR REPLACE FUNCTION authz.reschedule_sales_call(p_id uuid, p_start timestamptz) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_call record;
  v_end  timestamptz;
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'employee' OR NOT authz.can('website', 'update') THEN
    RAISE EXCEPTION 'not allowed to change sales calls' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('core.sales_calls'));
  SELECT * INTO v_call FROM core.sales_call_booked() c WHERE c.id = p_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM authz.sales_call_slots(p_start - interval '1 minute', p_start + interval '1 minute', p_id) t WHERE t = p_start) THEN
    RAISE EXCEPTION 'that time is not available; please choose another' USING ERRCODE = 'check_violation';
  END IF;
  v_end := p_start + (v_call.scheduled_end - v_call.scheduled_start);
  UPDATE core.appointments
     SET scheduled_start = p_start, scheduled_end = v_end,
         employee_id = CASE WHEN EXISTS (SELECT 1 FROM core.sales_call_hosts)
                              OR (v_call.employee_id IS NOT NULL AND NOT core.sales_host_free(v_call.employee_id, p_start, v_end, p_id))
                            THEN core.sales_call_pick_host(p_start, v_end, p_id, v_call.employee_id)
                            ELSE v_call.employee_id END
   WHERE id = p_id;
  RETURN true;
END $$;

-- Staff hand a booked sales call to an active employee who is free then (NULL: unassigned).
CREATE OR REPLACE FUNCTION authz.assign_sales_call(p_id uuid, p_user uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_call record;
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'employee' OR NOT authz.can('website', 'update') THEN
    RAISE EXCEPTION 'not allowed to change sales calls' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('core.sales_calls'));
  SELECT * INTO v_call FROM core.sales_call_booked() c WHERE c.id = p_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF p_user IS NOT NULL AND p_user IS DISTINCT FROM v_call.employee_id
     AND NOT core.sales_host_free(p_user, v_call.scheduled_start, v_call.scheduled_end, p_id) THEN
    RAISE EXCEPTION 'they are not free then (another booking, time off or outside their hours)' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE core.appointments SET employee_id = p_user WHERE id = p_id;
  RETURN true;
END $$;

-- Staff log how a sales call went (again to change it). A call that has started is then completed.
CREATE FUNCTION authz.log_sales_call_outcome(p_id uuid, p_outcome text, p_notes text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'employee' OR NOT authz.can('website', 'update') THEN
    RAISE EXCEPTION 'not allowed to change sales calls' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE core.appointments
     SET outcome = p_outcome, outcome_notes = nullif(btrim(p_notes), ''), outcome_at = now(), outcome_by = authz.principal_id(),
         status = CASE WHEN status IN ('scheduled', 'confirmed') AND scheduled_start <= now() THEN 'completed' ELSE status END
   WHERE id = p_id AND status <> 'cancelled'
     AND type_id = (SELECT id FROM core.appointment_types WHERE key = 'sales_call');
  RETURN FOUND;
END $$;

-- For the confirmation and rescheduling emails.
CREATE FUNCTION authz.sales_call_details(p_id uuid)
RETURNS TABLE (name text, email text, starts_at timestamptz, ends_at timestamptz, time_zone text, title text, meeting_url text, site_name text, host_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.contact_name, c.contact_email::text, c.scheduled_start, c.scheduled_end, c.contact_time_zone, s.title, s.meeting_url,
         coalesce((SELECT ss.site_name FROM core.site_settings ss WHERE ss.id = 1), (SELECT st.business_name FROM core.settings st WHERE st.id = 1)),
         (SELECT nullif(concat_ws(' ', u.first_name, u.last_name), '') FROM core.users u WHERE u.id = c.employee_id)
    FROM core.sales_call_booked() c, core.sales_call_settings s
   WHERE c.id = p_id AND s.id = 1
$$;

REVOKE ALL ON FUNCTION core.sales_call_booked(uuid), authz.log_sales_call_outcome(uuid, text, text), authz.sales_call_details(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.log_sales_call_outcome(uuid, text, text), authz.sales_call_details(uuid) TO joybot_app;
