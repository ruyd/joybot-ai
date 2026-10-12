-- Sales call setup and rescheduling.
--
-- The booking page's title, description, the call's length and the meeting link (sent in the
-- confirmation email, never shown on the page) are now set under Marketing › Sales calls
-- (core.sales_call_settings, one row; the 'website' resource). The hours stay fixed: weekdays
-- 9:00–17:00 in the business time zone, a call ending by 17:00. Start times are every half hour, or
-- every quarter hour for lengths that are not a multiple of 30 minutes.
--
-- Calls of different lengths may not overlap (an exclusion constraint replaces the unique start
-- time). Staff who may update the website move a booked call to another open time.

CREATE TABLE core.sales_call_settings (
  id               int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  title            text NOT NULL DEFAULT 'Sales call' CHECK (length(btrim(title)) BETWEEN 1 AND 80),
  description      text CHECK (length(description) <= 1000),
  duration_minutes int NOT NULL DEFAULT 30 CHECK (duration_minutes IN (15, 20, 30, 45, 60, 90)),
  meeting_url      text CHECK (length(meeting_url) <= 500 AND meeting_url ~ '^https://'),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
INSERT INTO core.sales_call_settings (id, description)
VALUES (1, 'Tell us about your project and we''ll find the best way to help. Looking forward to meeting you!');

CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.sales_call_settings FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.sales_call_settings FOR EACH ROW EXECUTE FUNCTION core.audit_row();

ALTER TABLE core.sales_call_settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE ON core.sales_call_settings TO joybot_app;
CREATE POLICY sel ON core.sales_call_settings FOR SELECT TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('website', 'read'));
CREATE POLICY upd ON core.sales_call_settings FOR UPDATE TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('website', 'update'))
  WITH CHECK (authz.principal_type() = 'employee' AND authz.can('website', 'update'));

-- What the booking page shows (no meeting link).
CREATE FUNCTION authz.sales_call_event() RETURNS TABLE (title text, description text, duration_minutes int, has_meeting_url boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.title, s.description, s.duration_minutes, s.meeting_url IS NOT NULL FROM core.sales_call_settings s WHERE s.id = 1
$$;

-- No overlapping booked calls, whatever their length.
DROP INDEX core.sales_calls_one_at_a_time;
ALTER TABLE core.sales_calls ADD CONSTRAINT sales_calls_no_overlap
  EXCLUDE USING gist (tstzrange(starts_at, ends_at) WITH &&) WHERE (status = 'booked');

-- Open start times between two instants (at most 45 days apart), ignoring one call (the one being
-- moved), for the current length.
DROP FUNCTION authz.sales_call_slots(timestamptz, timestamptz);
CREATE FUNCTION authz.sales_call_slots(p_from timestamptz, p_to timestamptz, p_ignore uuid DEFAULT NULL) RETURNS SETOF timestamptz
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
     AND NOT EXISTS (SELECT 1 FROM core.sales_calls c
                      WHERE c.status = 'booked' AND c.id IS DISTINCT FROM p_ignore
                        AND c.starts_at < x.t + s.len AND c.ends_at > x.t)
   ORDER BY 1
$$;

CREATE OR REPLACE FUNCTION authz.book_sales_call(p_name text, p_email text, p_start timestamptz, p_time_zone text, p_notes text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
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
  INSERT INTO core.sales_calls (name, email, starts_at, ends_at, time_zone, notes)
  VALUES (btrim(p_name), lower(btrim(p_email)), p_start,
          p_start + make_interval(mins => (SELECT duration_minutes FROM core.sales_call_settings WHERE id = 1)),
          (SELECT name FROM pg_timezone_names WHERE name = p_time_zone LIMIT 1), nullif(btrim(p_notes), ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Staff move a booked call to another open time (keeping its length). Runs under the caller's RLS:
-- only those who may update the website change a call.
CREATE FUNCTION authz.reschedule_sales_call(p_id uuid, p_start timestamptz) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM authz.sales_call_slots(p_start - interval '1 minute', p_start + interval '1 minute', p_id) t WHERE t = p_start) THEN
    RAISE EXCEPTION 'that time is not available; please choose another' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE core.sales_calls SET starts_at = p_start, ends_at = p_start + (ends_at - starts_at)
   WHERE id = p_id AND status = 'booked';
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION authz.sales_call_event(), authz.sales_call_slots(timestamptz, timestamptz, uuid), authz.reschedule_sales_call(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.sales_call_event(), authz.sales_call_slots(timestamptz, timestamptz, uuid), authz.reschedule_sales_call(uuid, timestamptz) TO joybot_app;

-- For the confirmation and rescheduling emails: a booked call with the event's title and the
-- meeting link (the API sends it to the address the visitor gave; ids are not guessable).
CREATE FUNCTION authz.sales_call_details(p_id uuid)
RETURNS TABLE (name text, email text, starts_at timestamptz, ends_at timestamptz, time_zone text, title text, meeting_url text, site_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.name, c.email, c.starts_at, c.ends_at, c.time_zone, s.title, s.meeting_url,
         coalesce((SELECT ss.site_name FROM core.site_settings ss WHERE ss.id = 1), (SELECT st.business_name FROM core.settings st WHERE st.id = 1))
    FROM core.sales_calls c, core.sales_call_settings s
   WHERE c.id = p_id AND c.status = 'booked' AND s.id = 1
$$;
REVOKE ALL ON FUNCTION authz.sales_call_details(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.sales_call_details(uuid) TO joybot_app;
