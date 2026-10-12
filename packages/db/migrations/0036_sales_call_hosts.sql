-- Sales calls get a host (the staff member who takes the call) and general availability hours.
--
-- Under Marketing › Sales calls, staff who may update the website choose the hosts (core.sales_call_hosts).
-- With hosts, a time is open when at least one host is free for the whole call:
--   * active, not on time off,
--   * no scheduled or confirmed appointment and no other booked sales call of theirs overlapping,
--   * within their working hours (at any location) when they have any set,
-- and always within the general hours (core.sales_call_hours, below). A booking goes to
-- the free host with the fewest upcoming calls (then the earliest added). Several hosts can take calls
-- at the same time. Without hosts, calls stay unassigned and one at a time, as before.
--
-- Rescheduling keeps the host when they are free at the new time, else picks another free host. Staff
-- reassign a call to any active employee who is free then. Writes take a transaction-level advisory
-- lock, so two bookings never hand the same host overlapping calls.

CREATE TABLE core.sales_call_hosts (
  user_id    uuid PRIMARY KEY REFERENCES core.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.sales_call_hosts FOR EACH ROW EXECUTE FUNCTION core.audit_row();
ALTER TABLE core.sales_call_hosts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON core.sales_call_hosts TO joybot_app;
CREATE POLICY sel ON core.sales_call_hosts FOR SELECT TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('website', 'read'));
CREATE POLICY ins ON core.sales_call_hosts FOR INSERT TO joybot_app
  WITH CHECK (authz.principal_type() = 'employee' AND authz.can('website', 'update'));
CREATE POLICY del ON core.sales_call_hosts FOR DELETE TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('website', 'update'));

ALTER TABLE core.sales_calls ADD COLUMN assigned_to uuid REFERENCES core.users(id);
CREATE INDEX sales_calls_assigned ON core.sales_calls (assigned_to, starts_at) WHERE status = 'booked';
-- Overlaps are now per host, checked under the lock below.
ALTER TABLE core.sales_calls DROP CONSTRAINT sales_calls_no_overlap;

-- Is this employee free for a call from p_start to p_end (ignoring one call, the one being moved)?
CREATE FUNCTION core.sales_host_free(p_user uuid, p_start timestamptz, p_end timestamptz, p_ignore uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM core.users u WHERE u.id = p_user AND u.active)
     AND NOT EXISTS (SELECT 1 FROM core.time_off t WHERE t.user_id = p_user AND t.starts_at < p_end AND t.ends_at > p_start)
     AND NOT EXISTS (SELECT 1 FROM core.appointments a
                      WHERE a.employee_id = p_user AND a.status IN ('scheduled', 'confirmed')
                        AND a.scheduled_start < p_end AND a.scheduled_end > p_start)
     AND NOT EXISTS (SELECT 1 FROM core.sales_calls c
                      WHERE c.assigned_to = p_user AND c.status = 'booked' AND c.id IS DISTINCT FROM p_ignore
                        AND c.starts_at < p_end AND c.ends_at > p_start)
     AND (NOT EXISTS (SELECT 1 FROM core.working_hours h WHERE h.user_id = p_user)
          OR EXISTS (SELECT 1 FROM core.working_intervals(p_start - interval '1 day', p_end + interval '1 day') w
                      WHERE w.employee_id = p_user AND w.starts_at <= p_start AND w.ends_at >= p_end))
$$;

-- The host for a new or moved call: p_prefer when free, else the free host with the fewest upcoming
-- calls. NULL when nobody is free (or there are no hosts).
CREATE FUNCTION core.sales_call_pick_host(p_start timestamptz, p_end timestamptz, p_ignore uuid DEFAULT NULL, p_prefer uuid DEFAULT NULL) RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT h.user_id
    FROM core.sales_call_hosts h
   WHERE core.sales_host_free(h.user_id, p_start, p_end, p_ignore)
   ORDER BY h.user_id = p_prefer DESC NULLS LAST,
            (SELECT count(*) FROM core.sales_calls c WHERE c.assigned_to = h.user_id AND c.status = 'booked' AND c.starts_at > now()),
            h.created_at, h.user_id
   LIMIT 1
$$;

-- Is the time open for a call of this length (ignoring one call)? Hosts: someone is free. No hosts:
-- no unassigned booked call overlaps.
CREATE FUNCTION core.sales_call_open(p_start timestamptz, p_end timestamptz, p_ignore uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM core.sales_call_hosts)
    THEN core.sales_call_pick_host(p_start, p_end, p_ignore) IS NOT NULL
    ELSE NOT EXISTS (SELECT 1 FROM core.sales_calls c
                      WHERE c.status = 'booked' AND c.assigned_to IS NULL AND c.id IS DISTINCT FROM p_ignore
                        AND c.starts_at < p_end AND c.ends_at > p_start)
  END
$$;

CREATE OR REPLACE FUNCTION authz.sales_call_slots(p_from timestamptz, p_to timestamptz, p_ignore uuid DEFAULT NULL) RETURNS SETOF timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT x.t
    FROM (SELECT st.default_time_zone AS tz, make_interval(mins => c.duration_minutes) AS len,
                 CASE WHEN c.duration_minutes % 30 = 0 THEN interval '30 minutes' ELSE interval '15 minutes' END AS step
            FROM core.settings st, core.sales_call_settings c WHERE st.id = 1 AND c.id = 1) s
   CROSS JOIN LATERAL generate_series(
           date_trunc('day', greatest(p_from, now()) AT TIME ZONE s.tz),
           least(p_to, now() + interval '60 days') AT TIME ZONE s.tz,
           s.step) AS l(local)
   CROSS JOIN LATERAL (SELECT l.local AT TIME ZONE s.tz AS t) x
   WHERE p_to > p_from AND p_to - p_from <= interval '45 days'
     AND extract(isodow FROM l.local) BETWEEN 1 AND 5
     AND l.local::time >= time '09:00' AND l.local::time + s.len <= time '17:00' AND l.local::time + s.len > l.local::time
     AND x.t >= greatest(p_from, now() + interval '2 hours')
     AND x.t < p_to AND x.t <= now() + interval '60 days'
     AND core.sales_call_open(x.t, x.t + s.len, p_ignore)
   ORDER BY 1
$$;

CREATE OR REPLACE FUNCTION authz.book_sales_call(p_name text, p_email text, p_start timestamptz, p_time_zone text, p_notes text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id  uuid;
  v_end timestamptz := p_start + make_interval(mins => (SELECT duration_minutes FROM core.sales_call_settings WHERE id = 1));
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('core.sales_calls'));
  IF NOT EXISTS (SELECT 1 FROM authz.sales_call_slots(p_start - interval '1 minute', p_start + interval '1 minute') t WHERE t = p_start) THEN
    RAISE EXCEPTION 'that time is not available; please choose another' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM core.sales_calls
       WHERE lower(email) = lower(btrim(p_email)) AND status = 'booked' AND starts_at > now()) >= 2 THEN
    RAISE EXCEPTION 'you already have calls booked with us' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM core.sales_calls WHERE created_at > now() - interval '1 hour') >= 10 THEN
    RAISE EXCEPTION 'we are getting a lot of bookings right now; please try again later' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO core.sales_calls (name, email, starts_at, ends_at, time_zone, notes, assigned_to)
  VALUES (btrim(p_name), lower(btrim(p_email)), p_start, v_end,
          (SELECT name FROM pg_timezone_names WHERE name = p_time_zone LIMIT 1), nullif(btrim(p_notes), ''),
          core.sales_call_pick_host(p_start, v_end))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Staff move a booked call (same length): its host when free then, else another free host.
-- SECURITY DEFINER to see everyone's bookings; the caller must be allowed to update the website.
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
  SELECT * INTO v_call FROM core.sales_calls WHERE id = p_id AND status = 'booked';
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM authz.sales_call_slots(p_start - interval '1 minute', p_start + interval '1 minute', p_id) t WHERE t = p_start) THEN
    RAISE EXCEPTION 'that time is not available; please choose another' USING ERRCODE = 'check_violation';
  END IF;
  v_end := p_start + (v_call.ends_at - v_call.starts_at);
  UPDATE core.sales_calls
     SET starts_at = p_start, ends_at = v_end,
         assigned_to = CASE WHEN EXISTS (SELECT 1 FROM core.sales_call_hosts)
                              OR (v_call.assigned_to IS NOT NULL AND NOT core.sales_host_free(v_call.assigned_to, p_start, v_end, p_id))
                            THEN core.sales_call_pick_host(p_start, v_end, p_id, v_call.assigned_to)
                            ELSE v_call.assigned_to END
   WHERE id = p_id;
  RETURN true;
END $$;

-- Staff hand a booked call to an active employee who is free then (NULL: unassigned).
CREATE FUNCTION authz.assign_sales_call(p_id uuid, p_user uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_call record;
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'employee' OR NOT authz.can('website', 'update') THEN
    RAISE EXCEPTION 'not allowed to change sales calls' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('core.sales_calls'));
  SELECT * INTO v_call FROM core.sales_calls WHERE id = p_id AND status = 'booked';
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF p_user IS NOT NULL AND p_user IS DISTINCT FROM v_call.assigned_to
     AND NOT core.sales_host_free(p_user, v_call.starts_at, v_call.ends_at, p_id) THEN
    RAISE EXCEPTION 'they are not free then (another booking, time off or outside their hours)' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE core.sales_calls SET assigned_to = p_user WHERE id = p_id;
  RETURN true;
END $$;

-- The host's name goes into the emails.
DROP FUNCTION authz.sales_call_details(uuid);
CREATE FUNCTION authz.sales_call_details(p_id uuid)
RETURNS TABLE (name text, email text, starts_at timestamptz, ends_at timestamptz, time_zone text, title text, meeting_url text, site_name text, host_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.name, c.email, c.starts_at, c.ends_at, c.time_zone, s.title, s.meeting_url,
         coalesce((SELECT ss.site_name FROM core.site_settings ss WHERE ss.id = 1), (SELECT st.business_name FROM core.settings st WHERE st.id = 1)),
         (SELECT nullif(concat_ws(' ', u.first_name, u.last_name), '') FROM core.users u WHERE u.id = c.assigned_to)
    FROM core.sales_calls c, core.sales_call_settings s
   WHERE c.id = p_id AND c.status = 'booked' AND s.id = 1
$$;

REVOKE ALL ON FUNCTION core.sales_host_free(uuid, timestamptz, timestamptz, uuid), core.sales_call_pick_host(timestamptz, timestamptz, uuid, uuid),
  core.sales_call_open(timestamptz, timestamptz, uuid), authz.assign_sales_call(uuid, uuid), authz.sales_call_details(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.assign_sales_call(uuid, uuid), authz.sales_call_details(uuid) TO joybot_app;

-- General availability: the weekly hours calls can be booked in (the business time zone; weekday 0 =
-- Sunday; more than one interval a day allowed), set in the booking page setup. Weekdays 9:00–17:00 to
-- start with. Hosts' own hours, bookings and time off then narrow it down.
CREATE TABLE core.sales_call_hours (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  starts  time NOT NULL CHECK (extract(minute FROM starts)::int % 15 = 0 AND extract(second FROM starts) = 0),
  ends    time NOT NULL CHECK (extract(minute FROM ends)::int % 15 = 0 AND extract(second FROM ends) = 0),
  CHECK (ends > starts)
);
INSERT INTO core.sales_call_hours (weekday, starts, ends) SELECT d, '09:00', '17:00' FROM generate_series(1, 5) d;
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.sales_call_hours FOR EACH ROW EXECUTE FUNCTION core.audit_row();
ALTER TABLE core.sales_call_hours ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON core.sales_call_hours TO joybot_app;
CREATE POLICY sel ON core.sales_call_hours FOR SELECT TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('website', 'read'));
CREATE POLICY ins ON core.sales_call_hours FOR INSERT TO joybot_app
  WITH CHECK (authz.principal_type() = 'employee' AND authz.can('website', 'update'));
CREATE POLICY del ON core.sales_call_hours FOR DELETE TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('website', 'update'));

CREATE OR REPLACE FUNCTION authz.sales_call_slots(p_from timestamptz, p_to timestamptz, p_ignore uuid DEFAULT NULL) RETURNS SETOF timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT x.t
    FROM (SELECT st.default_time_zone AS tz, make_interval(mins => c.duration_minutes) AS len,
                 CASE WHEN c.duration_minutes % 30 = 0 THEN interval '30 minutes' ELSE interval '15 minutes' END AS step
            FROM core.settings st, core.sales_call_settings c WHERE st.id = 1 AND c.id = 1) s
   CROSS JOIN LATERAL generate_series(
           date_trunc('day', greatest(p_from, now()) AT TIME ZONE s.tz),
           least(p_to, now() + interval '60 days') AT TIME ZONE s.tz,
           s.step) AS l(local)
   CROSS JOIN LATERAL (SELECT l.local AT TIME ZONE s.tz AS t) x
   WHERE p_to > p_from AND p_to - p_from <= interval '45 days'
     AND EXISTS (SELECT 1 FROM core.sales_call_hours h
                  WHERE h.weekday = extract(dow FROM l.local)
                    AND l.local::time >= h.starts AND l.local::time + s.len <= h.ends AND l.local::time + s.len > l.local::time)
     AND x.t >= greatest(p_from, now() + interval '2 hours')
     AND x.t < p_to AND x.t <= now() + interval '60 days'
     AND core.sales_call_open(x.t, x.t + s.len, p_ignore)
   ORDER BY 1
$$;
