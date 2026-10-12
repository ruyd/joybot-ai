-- Sales calls: visitors of the public website book a call at /book-a-call (no sign-in).
--
-- One fixed event type: a 30-minute "Sales call", on weekdays from 9:00 to 17:00 in the business's
-- default time zone (core.settings), from two hours to 60 days ahead, one call at a time. The visitor
-- leaves a name, an email and optionally a note; core.sales_calls keeps them. Visitors never read the
-- table: they see open times through authz.sales_call_slots and book through authz.book_sales_call.
-- Employees who may read the website (admins by default) see the calls; those who may update it cancel them.

-- The booking page's address is the app's.
ALTER TABLE core.site_pages DROP CONSTRAINT site_pages_slug_check;
ALTER TABLE core.site_pages ADD CONSTRAINT site_pages_slug_check
  CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 60
         AND slug NOT IN ('portal', 'staff', 'auth', 'api', 'assets', 'login', 'book-a-call'));

CREATE TABLE core.sales_calls (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  email      text NOT NULL CHECK (length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  -- The visitor's time zone, for showing the time as they chose it.
  time_zone  text,
  notes      text CHECK (length(notes) <= 2000),
  status     text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
-- One call at a time (also when two visitors pick the same time at once).
CREATE UNIQUE INDEX sales_calls_one_at_a_time ON core.sales_calls (starts_at) WHERE status = 'booked';
CREATE INDEX sales_calls_email ON core.sales_calls (lower(email), starts_at);

CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.sales_calls FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.sales_calls FOR EACH ROW EXECUTE FUNCTION core.audit_row();

ALTER TABLE core.sales_calls ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE ON core.sales_calls TO joybot_app;
CREATE POLICY sel ON core.sales_calls FOR SELECT TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('website', 'read'));
CREATE POLICY upd ON core.sales_calls FOR UPDATE TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('website', 'update'))
  WITH CHECK (authz.principal_type() = 'employee' AND authz.can('website', 'update'));

-- Open start times between two instants (at most 45 days apart): every half hour of the hours
-- above, not taken by a booked call.
CREATE FUNCTION authz.sales_call_slots(p_from timestamptz, p_to timestamptz) RETURNS SETOF timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT x.t
    FROM (SELECT default_time_zone AS tz FROM core.settings WHERE id = 1) s
   CROSS JOIN LATERAL generate_series(
           date_trunc('day', greatest(p_from, now()) AT TIME ZONE s.tz),
           least(p_to, now() + interval '60 days') AT TIME ZONE s.tz,
           interval '30 minutes') AS l(local)
   CROSS JOIN LATERAL (SELECT l.local AT TIME ZONE s.tz AS t) x
   WHERE p_to > p_from AND p_to - p_from <= interval '45 days'
     AND extract(isodow FROM l.local) BETWEEN 1 AND 5
     AND l.local::time BETWEEN time '09:00' AND time '16:30'
     AND x.t >= greatest(p_from, now() + interval '2 hours')
     AND x.t < p_to AND x.t <= now() + interval '60 days'
     AND NOT EXISTS (SELECT 1 FROM core.sales_calls c
                      WHERE c.status = 'booked' AND c.starts_at < x.t + interval '30 minutes' AND c.ends_at > x.t)
   ORDER BY 1
$$;

-- A visitor books an open time; at most two upcoming calls per email, and at most ten new bookings an
-- hour in all (anyone can book, so a flood cannot fill the calendar).
CREATE FUNCTION authz.book_sales_call(p_name text, p_email text, p_start timestamptz, p_time_zone text, p_notes text)
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
  VALUES (btrim(p_name), lower(btrim(p_email)), p_start, p_start + interval '30 minutes',
          (SELECT name FROM pg_timezone_names WHERE name = p_time_zone LIMIT 1), nullif(btrim(p_notes), ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION authz.sales_call_slots(timestamptz, timestamptz), authz.book_sales_call(text, text, timestamptz, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.sales_call_slots(timestamptz, timestamptz), authz.book_sales_call(text, text, timestamptz, text, text) TO joybot_app;
