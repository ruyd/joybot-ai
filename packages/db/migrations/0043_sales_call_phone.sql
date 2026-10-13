-- How sales calls are handled (Marketing › Sales calls › Booking page): video meetings or a callback.
--
-- core.sales_call_settings.call_method is the choice. 'video' only takes effect while a Google account is
-- connected (Setup meeting links); until then, and with 'phone', the booking page asks for a number and
-- the host calls the visitor. core.sales_call_method() is the method in effect, used by the booking page,
-- booking and the API. The visitor's number is kept on the appointment (contact_phone).

ALTER TABLE core.sales_call_settings
  ADD COLUMN call_method text NOT NULL DEFAULT 'video' CHECK (call_method IN ('video', 'phone'));

ALTER TABLE core.appointments
  ADD COLUMN contact_phone text CHECK (contact_phone ~ '^\+?[0-9][0-9 ().-]{5,30}$');

-- The method in effect: video only while Google is connected, otherwise a callback.
CREATE FUNCTION core.sales_call_method() RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN s.call_method = 'video' AND EXISTS (SELECT 1 FROM core.video_settings v WHERE v.id = 1 AND v.google_connected_at IS NOT NULL)
              THEN 'video' ELSE 'phone' END
    FROM core.sales_call_settings s WHERE s.id = 1
$$;
REVOKE ALL ON FUNCTION core.sales_call_method() FROM PUBLIC;

-- What the booking page shows: the method in effect (video: a Meet link by email; phone: a number to call).
DROP FUNCTION authz.sales_call_event();
CREATE FUNCTION authz.sales_call_event() RETURNS TABLE (title text, description text, duration_minutes int, call_method text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.title, s.description, s.duration_minutes, core.sales_call_method() FROM core.sales_call_settings s WHERE s.id = 1
$$;

-- Booking now takes the visitor's phone number, required while calls are callbacks.
DROP FUNCTION authz.book_sales_call(text, text, timestamptz, text, text);
CREATE FUNCTION authz.book_sales_call(p_name text, p_email text, p_start timestamptz, p_time_zone text, p_notes text, p_phone text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id    uuid;
  v_type  uuid := (SELECT id FROM core.appointment_types WHERE key = 'sales_call');
  v_end   timestamptz := p_start + make_interval(mins => (SELECT duration_minutes FROM core.sales_call_settings WHERE id = 1));
  v_phone text := nullif(btrim(p_phone), '');
BEGIN
  IF v_phone IS NULL AND core.sales_call_method() = 'phone' THEN
    RAISE EXCEPTION 'please leave a phone number we can call you on' USING ERRCODE = 'check_violation';
  END IF;
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
                                 notes_customer, contact_name, contact_email, contact_time_zone, contact_phone)
  VALUES (v_type, core.sales_call_pick_host(p_start, v_end), p_start, v_end, 'confirmed', 0,
          (SELECT default_currency FROM core.settings WHERE id = 1), nullif(btrim(p_notes), ''),
          btrim(p_name), lower(btrim(p_email)), (SELECT name FROM pg_timezone_names WHERE name = p_time_zone LIMIT 1), v_phone)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- A call's details for its emails, now with the visitor's phone number.
DROP FUNCTION authz.sales_call_details(uuid);
CREATE FUNCTION authz.sales_call_details(p_id uuid)
RETURNS TABLE (name text, email text, starts_at timestamptz, ends_at timestamptz, time_zone text, title text, meeting_url text, site_name text, host_name text, phone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.contact_name, c.contact_email::text, c.scheduled_start, c.scheduled_end, c.contact_time_zone, s.title, c.meeting_url,
         coalesce((SELECT ss.site_name FROM core.site_settings ss WHERE ss.id = 1), (SELECT st.business_name FROM core.settings st WHERE st.id = 1)),
         (SELECT nullif(concat_ws(' ', u.first_name, u.last_name), '') FROM core.users u WHERE u.id = c.employee_id),
         c.contact_phone
    FROM core.sales_call_booked() c, core.sales_call_settings s
   WHERE c.id = p_id AND s.id = 1
$$;

REVOKE ALL ON FUNCTION authz.sales_call_event(), authz.book_sales_call(text, text, timestamptz, text, text, text), authz.sales_call_details(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.sales_call_event(), authz.book_sales_call(text, text, timestamptz, text, text, text), authz.sales_call_details(uuid) TO joybot_app;
