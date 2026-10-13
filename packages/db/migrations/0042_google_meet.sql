-- Video calls for sales calls: Google Meet (Marketing › Sales calls › Setup meeting links).
--
-- core.video_settings (one row, audited): the Google Cloud project (for links into its console), the
-- OAuth client ID, which Google account is connected (connected means every sales call gets a Meet
-- link; there is no separate switch), and which setup steps were ticked. Secrets — the OAuth client secret and the connected account's refresh
-- token — are encrypted by the API (SecretBox) in core.video_secret: no grants, not audited, reached only
-- through the functions below, never returned to the browser.
--
-- Connecting: an admin starts the Google consent screen with a single-use state (app.oauth_states,
-- sha256 only, ten minutes); Google's redirect to the API carries it back, which says who connected.
--
-- Google access is the non-sensitive scope calendar.app.created: JoyBot makes its own calendar in the
-- connected account (google_calendar_id, "<site> sales calls") and can see and change only calendars it
-- made, never the account's other calendars.
--
-- While connected, a booking creates an event with a Meet link in that calendar; the
-- appointment keeps the link and event (meeting_url, calendar_event_id), emails use that link, and
-- rescheduling or cancelling updates the event. Generated links replace the one fixed meeting link
-- from the booking page setup (core.sales_call_settings.meeting_url is dropped).

CREATE TABLE core.video_settings (
  id                    int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  google_project_id     text CHECK (google_project_id ~ '^[a-z][a-z0-9-]{4,29}$'),
  google_client_id      text CHECK (google_client_id ~ '^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$'),
  google_secret_set_at  timestamptz,
  google_account_email  text CHECK (length(google_account_email) <= 254),
  google_connected_at   timestamptz,
  google_connected_by   uuid REFERENCES core.users(id),
  -- JoyBot's own calendar in the connected account (kept on disconnect, reused when the same account reconnects).
  google_calendar_id    text CHECK (length(google_calendar_id) <= 300),
  -- Setup steps done in Google's console (ticked by hand): 'project', 'api', 'consent'; and 'test' once a
  -- test meeting worked for the connected account (cleared when the account changes).
  checklist             text[] NOT NULL DEFAULT '{}' CHECK (checklist <@ ARRAY['project', 'api', 'consent', 'test']),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
INSERT INTO core.video_settings (id) VALUES (1);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.video_settings FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.video_settings FOR EACH ROW EXECUTE FUNCTION core.audit_row();

CREATE TABLE core.video_secret (
  id                         int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  google_client_secret_cipher text CHECK (length(google_client_secret_cipher) <= 2000),
  google_refresh_token_cipher text CHECK (length(google_refresh_token_cipher) <= 4000)
);
INSERT INTO core.video_secret (id) VALUES (1);
ALTER TABLE core.video_secret ENABLE ROW LEVEL SECURITY;

ALTER TABLE core.video_settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE ON core.video_settings TO joybot_app;
CREATE POLICY sel ON core.video_settings FOR SELECT TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('website', 'read'));
CREATE POLICY upd ON core.video_settings FOR UPDATE TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('website', 'update'))
  WITH CHECK (authz.principal_type() = 'employee' AND authz.can('website', 'update'));

CREATE TABLE app.oauth_states (
  state_hash text PRIMARY KEY,
  provider   text NOT NULL CHECK (provider IN ('google')),
  user_id    uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  used_at    timestamptz
);
ALTER TABLE app.oauth_states ENABLE ROW LEVEL SECURITY;

ALTER TABLE core.appointments
  ADD COLUMN meeting_url       text CHECK (length(meeting_url) <= 500),
  ADD COLUMN calendar_event_id text CHECK (length(calendar_event_id) <= 200);

-- Who may change video settings (website update), checked inside the functions below.
CREATE FUNCTION authz.can_change_video() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT authz.principal_type() = 'employee' AND authz.can('website', 'update')
$$;

-- The OAuth client secret (or NULL to remove it, which also disconnects).
CREATE FUNCTION authz.set_google_client_secret(p_cipher text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT authz.can_change_video() THEN
    RAISE EXCEPTION 'not allowed to change video call settings' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE core.video_secret SET google_client_secret_cipher = p_cipher,
         google_refresh_token_cipher = CASE WHEN p_cipher IS NULL THEN NULL ELSE google_refresh_token_cipher END WHERE id = 1;
  UPDATE core.video_settings SET google_secret_set_at = CASE WHEN p_cipher IS NULL THEN NULL ELSE now() END,
         google_account_email = CASE WHEN p_cipher IS NULL THEN NULL ELSE google_account_email END,
         google_connected_at = CASE WHEN p_cipher IS NULL THEN NULL ELSE google_connected_at END,
         google_connected_by = CASE WHEN p_cipher IS NULL THEN NULL ELSE google_connected_by END,
         checklist = CASE WHEN p_cipher IS NULL THEN array_remove(checklist, 'test') ELSE checklist END
   WHERE id = 1;
END $$;

-- Starts connecting: a state for Google's redirect (by an employee who may change video settings).
CREATE FUNCTION authz.begin_google_connect(p_state_hash text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT authz.can_change_video() THEN
    RAISE EXCEPTION 'not allowed to change video call settings' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM app.oauth_states WHERE expires_at < now() - interval '1 day';
  INSERT INTO app.oauth_states (state_hash, provider, user_id) VALUES (p_state_hash, 'google', authz.principal_id());
END $$;

-- Google's redirect came back with this state: who started it (once, within ten minutes), else NULL.
CREATE FUNCTION authz.claim_google_connect(p_state_hash text) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE app.oauth_states SET used_at = now()
   WHERE state_hash = p_state_hash AND provider = 'google' AND used_at IS NULL AND expires_at > now()
     AND EXISTS (SELECT 1 FROM core.users u WHERE u.id = user_id AND u.active)
  RETURNING user_id
$$;

-- Stores the connected account (refresh token encrypted) and its JoyBot calendar for the employee who started it.
CREATE FUNCTION authz.finish_google_connect(p_user uuid, p_refresh_cipher text, p_email text, p_calendar_id text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE core.video_secret SET google_refresh_token_cipher = p_refresh_cipher WHERE id = 1;
  UPDATE core.video_settings SET google_account_email = p_email, google_connected_at = now(), google_connected_by = p_user,
         google_calendar_id = p_calendar_id, checklist = array_remove(checklist, 'test') WHERE id = 1;
$$;

-- JoyBot's calendar was made again (someone deleted it in Google Calendar).
CREATE FUNCTION authz.set_google_calendar(p_calendar_id text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE core.video_settings SET google_calendar_id = p_calendar_id WHERE id = 1 AND google_connected_at IS NOT NULL;
$$;

CREATE FUNCTION authz.disconnect_google() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT authz.can_change_video() THEN
    RAISE EXCEPTION 'not allowed to change video call settings' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE core.video_secret SET google_refresh_token_cipher = NULL WHERE id = 1;
  UPDATE core.video_settings SET google_account_email = NULL, google_connected_at = NULL, google_connected_by = NULL,
         checklist = array_remove(checklist, 'test') WHERE id = 1;
END $$;

-- What creating meetings needs: the client and the connected account (encrypted), and JoyBot's calendar
-- (with the name and time zone for making it).
CREATE FUNCTION authz.video_delivery()
RETURNS TABLE (google_client_id text, client_secret_cipher text, refresh_token_cipher text,
               google_account_email text, calendar_id text, calendar_name text, time_zone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT v.google_client_id, s.google_client_secret_cipher, s.google_refresh_token_cipher,
         v.google_account_email, v.google_calendar_id,
         coalesce((SELECT ss.site_name FROM core.site_settings ss WHERE ss.id = 1), (SELECT st.business_name FROM core.settings st WHERE st.id = 1), 'JoyBot') || ' sales calls',
         (SELECT st.default_time_zone FROM core.settings st WHERE st.id = 1)
    FROM core.video_settings v, core.video_secret s WHERE v.id = 1 AND s.id = 1
$$;

-- A sales call's meeting (link and calendar event), set after booking or cleared.
CREATE FUNCTION authz.set_sales_call_meeting(p_id uuid, p_url text, p_event_id text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE core.appointments SET meeting_url = p_url, calendar_event_id = p_event_id
   WHERE id = p_id AND type_id = (SELECT id FROM core.appointment_types WHERE key = 'sales_call')
$$;

-- Emails use the call's own meeting link (none when Meet links are off or Google failed).
CREATE OR REPLACE FUNCTION authz.sales_call_details(p_id uuid)
RETURNS TABLE (name text, email text, starts_at timestamptz, ends_at timestamptz, time_zone text, title text, meeting_url text, site_name text, host_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.contact_name, c.contact_email::text, c.scheduled_start, c.scheduled_end, c.contact_time_zone, s.title, c.meeting_url,
         coalesce((SELECT ss.site_name FROM core.site_settings ss WHERE ss.id = 1), (SELECT st.business_name FROM core.settings st WHERE st.id = 1)),
         (SELECT nullif(concat_ws(' ', u.first_name, u.last_name), '') FROM core.users u WHERE u.id = c.employee_id)
    FROM core.sales_call_booked() c, core.sales_call_settings s
   WHERE c.id = p_id AND s.id = 1
$$;

ALTER TABLE core.sales_call_settings DROP COLUMN meeting_url;

-- A sales call's calendar event, for rescheduling and cancelling (any status).
CREATE FUNCTION authz.sales_call_event(p_id uuid) RETURNS TABLE (calendar_event_id text, starts_at timestamptz, ends_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.calendar_event_id, a.scheduled_start, a.scheduled_end FROM core.appointments a
   WHERE a.id = p_id AND a.type_id = (SELECT id FROM core.appointment_types WHERE key = 'sales_call')
$$;

REVOKE ALL ON FUNCTION authz.can_change_video(), authz.set_google_client_secret(text), authz.begin_google_connect(text),
  authz.claim_google_connect(text), authz.finish_google_connect(uuid, text, text, text), authz.set_google_calendar(text), authz.disconnect_google(), authz.video_delivery(),
  authz.set_sales_call_meeting(uuid, text, text), authz.sales_call_event(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.set_google_client_secret(text), authz.begin_google_connect(text), authz.claim_google_connect(text),
  authz.finish_google_connect(uuid, text, text, text), authz.set_google_calendar(text), authz.disconnect_google(), authz.video_delivery(),
  authz.set_sales_call_meeting(uuid, text, text), authz.sales_call_event(uuid) TO joybot_app;
