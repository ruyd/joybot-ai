-- Team chat for employees (the drawer behind the user icon): an "everyone" channel, direct messages,
-- group channels of chosen staff, and a personal notifications channel for system messages.
-- Each channel keeps its newest messages only (settings.team_chat_retention, 100 by default).
-- Customers never see any of it. Employees choose whether new messages make a sound or a toast.

ALTER TABLE core.settings
  ADD COLUMN team_chat_retention int NOT NULL DEFAULT 100 CHECK (team_chat_retention BETWEEN 10 AND 10000);

ALTER TABLE core.users
  ADD COLUMN chat_sound boolean NOT NULL DEFAULT true,
  ADD COLUMN chat_toast boolean NOT NULL DEFAULT true;

-- Employees edit their own chat preferences along with name and time zone.
CREATE OR REPLACE FUNCTION authz.update_own_employee_profile(p_fields jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'employee' THEN
    RAISE EXCEPTION 'only employees edit an employee profile' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE core.users SET
    first_name = CASE WHEN p_fields ? 'first_name' THEN p_fields ->> 'first_name' ELSE first_name END,
    last_name  = CASE WHEN p_fields ? 'last_name'  THEN p_fields ->> 'last_name'  ELSE last_name  END,
    time_zone  = CASE WHEN p_fields ? 'time_zone'  THEN p_fields ->> 'time_zone'  ELSE time_zone  END,
    chat_sound = CASE WHEN p_fields ? 'chat_sound' THEN (p_fields ->> 'chat_sound')::boolean ELSE chat_sound END,
    chat_toast = CASE WHEN p_fields ? 'chat_toast' THEN (p_fields ->> 'chat_toast')::boolean ELSE chat_toast END
  WHERE id = authz.principal_id() AND active;
END $$;

CREATE TABLE app.team_channels (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('everyone', 'direct', 'group', 'notifications')),
  name       text CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  direct_key text UNIQUE, -- the two user ids, sorted, for a direct message
  owner_id   uuid REFERENCES core.users(id) ON DELETE CASCADE, -- whose notifications
  created_by uuid REFERENCES core.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'group') = (name IS NOT NULL)),
  CHECK ((kind = 'direct') = (direct_key IS NOT NULL)),
  CHECK ((kind = 'notifications') = (owner_id IS NOT NULL))
);
CREATE UNIQUE INDEX team_channels_one_everyone ON app.team_channels ((true)) WHERE kind = 'everyone';
CREATE UNIQUE INDEX team_channels_notifications ON app.team_channels (owner_id) WHERE kind = 'notifications';
INSERT INTO app.team_channels (kind) VALUES ('everyone');

-- Members of direct, group and notification channels; for "everyone" a row only tracks reading.
CREATE TABLE app.team_members (
  channel_id   uuid NOT NULL REFERENCES app.team_channels(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX team_members_user ON app.team_members (user_id);

CREATE TABLE app.team_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES app.team_channels(id) ON DELETE CASCADE,
  sender_id  uuid REFERENCES core.users(id) ON DELETE SET NULL, -- NULL: a system notification
  body       text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  link       text CHECK (link ~ '^/staff(/|$)'), -- in-app path a notification opens
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX team_messages_channel ON app.team_messages (channel_id, created_at DESC);

-- Access --------------------------------------------------------------------------------------

/** May the calling employee see this channel? Everyone: all employees; others: members. */
CREATE FUNCTION app.team_can_see(p_channel uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT authz.principal_type() = 'employee' AND EXISTS (
    SELECT 1 FROM app.team_channels c
     WHERE c.id = p_channel
       AND (c.kind = 'everyone' OR EXISTS (SELECT 1 FROM app.team_members m WHERE m.channel_id = c.id AND m.user_id = authz.principal_id())))
$$;
REVOKE ALL ON FUNCTION app.team_can_see(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.team_can_see(uuid) TO joybot_app;

GRANT SELECT ON app.team_channels TO joybot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.team_members TO joybot_app;
GRANT SELECT, INSERT ON app.team_messages TO joybot_app;
ALTER TABLE app.team_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.team_messages ENABLE ROW LEVEL SECURITY;

-- Channels are created through the functions below (they check who may be added).
CREATE POLICY sel ON app.team_channels FOR SELECT TO joybot_app USING (app.team_can_see(id));
CREATE POLICY sel ON app.team_members FOR SELECT TO joybot_app USING (app.team_can_see(channel_id));
-- Own row only: start reading "everyone", mark read, leave a group.
CREATE POLICY ins ON app.team_members FOR INSERT TO joybot_app
  WITH CHECK (user_id = authz.principal_id() AND app.team_can_see(channel_id));
CREATE POLICY upd ON app.team_members FOR UPDATE TO joybot_app
  USING (user_id = authz.principal_id()) WITH CHECK (user_id = authz.principal_id());
CREATE POLICY del ON app.team_members FOR DELETE TO joybot_app
  USING (user_id = authz.principal_id()
         AND EXISTS (SELECT 1 FROM app.team_channels c WHERE c.id = channel_id AND c.kind = 'group'));
CREATE POLICY sel ON app.team_messages FOR SELECT TO joybot_app USING (app.team_can_see(channel_id));
-- People post as themselves; notification channels take system messages only.
CREATE POLICY ins ON app.team_messages FOR INSERT TO joybot_app
  WITH CHECK (sender_id = authz.principal_id() AND link IS NULL AND app.team_can_see(channel_id)
              AND EXISTS (SELECT 1 FROM app.team_channels c WHERE c.id = channel_id AND c.kind <> 'notifications'));

/** The caller's direct-message channel with another active employee (created on first use). */
CREATE FUNCTION app.team_open_direct(p_other uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_me uuid := authz.principal_id();
  v_key text;
  v_id uuid;
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'employee' THEN
    RAISE EXCEPTION 'team chat is for employees' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_other = v_me OR NOT EXISTS (SELECT 1 FROM core.users u WHERE u.id = p_other AND u.active) THEN
    RAISE EXCEPTION 'not an active colleague' USING ERRCODE = 'check_violation';
  END IF;
  v_key := least(v_me::text, p_other::text) || ':' || greatest(v_me::text, p_other::text);
  INSERT INTO app.team_channels (kind, direct_key, created_by) VALUES ('direct', v_key, v_me)
    ON CONFLICT (direct_key) DO NOTHING;
  SELECT id INTO v_id FROM app.team_channels WHERE direct_key = v_key;
  INSERT INTO app.team_members (channel_id, user_id) VALUES (v_id, v_me), (v_id, p_other) ON CONFLICT DO NOTHING;
  RETURN v_id;
END $$;

/** A named channel of chosen active employees, the caller included. */
CREATE FUNCTION app.team_create_group(p_name text, p_members uuid[]) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_me uuid := authz.principal_id();
  v_id uuid;
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'employee' THEN
    RAISE EXCEPTION 'team chat is for employees' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO app.team_channels (kind, name, created_by) VALUES ('group', btrim(p_name), v_me) RETURNING id INTO v_id;
  INSERT INTO app.team_members (channel_id, user_id)
    SELECT v_id, u.id FROM core.users u WHERE u.active AND (u.id = v_me OR u.id = ANY (p_members));
  RETURN v_id;
END $$;

/** Adds active employees to a group channel the caller belongs to. */
CREATE FUNCTION app.team_add_members(p_channel uuid, p_members uuid[]) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT app.team_can_see(p_channel) OR NOT EXISTS (SELECT 1 FROM app.team_channels WHERE id = p_channel AND kind = 'group') THEN
    RAISE EXCEPTION 'not a group channel of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO app.team_members (channel_id, user_id)
    SELECT p_channel, u.id FROM core.users u WHERE u.active AND u.id = ANY (p_members)
  ON CONFLICT DO NOTHING;
END $$;

/**
 * The caller's own rows for "everyone" and their notifications channel, so unread counts start from
 * the first time they open the chat instead of counting every old message.
 */
CREATE FUNCTION app.team_join_defaults() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_me uuid := authz.principal_id();
  v_id uuid;
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'employee' THEN RETURN; END IF;
  INSERT INTO app.team_members (channel_id, user_id)
    SELECT id, v_me FROM app.team_channels WHERE kind = 'everyone' ON CONFLICT DO NOTHING;
  INSERT INTO app.team_channels (kind, owner_id) VALUES ('notifications', v_me) ON CONFLICT DO NOTHING;
  SELECT id INTO v_id FROM app.team_channels WHERE kind = 'notifications' AND owner_id = v_me;
  INSERT INTO app.team_members (channel_id, user_id) VALUES (v_id, v_me) ON CONFLICT DO NOTHING;
END $$;

REVOKE ALL ON FUNCTION app.team_open_direct(uuid), app.team_create_group(text, uuid[]),
                       app.team_add_members(uuid, uuid[]), app.team_join_defaults() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.team_open_direct(uuid), app.team_create_group(text, uuid[]),
                          app.team_add_members(uuid, uuid[]), app.team_join_defaults() TO joybot_app;

-- Retention: keep the newest N messages per channel ------------------------------------------

CREATE FUNCTION app.team_trim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM app.team_messages
   WHERE id IN (SELECT id FROM app.team_messages WHERE channel_id = NEW.channel_id
                 ORDER BY created_at DESC, id DESC
                OFFSET (SELECT team_chat_retention FROM core.settings WHERE id = 1));
  RETURN NULL;
END $$;
CREATE TRIGGER team_trim AFTER INSERT ON app.team_messages FOR EACH ROW EXECUTE FUNCTION app.team_trim();

-- System notifications -----------------------------------------------------------------------

/** Posts a system message to an employee's notifications channel (created on first use). */
CREATE FUNCTION app.team_notify(p_user uuid, p_body text, p_link text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.users WHERE id = p_user AND active) THEN RETURN; END IF;
  INSERT INTO app.team_channels (kind, owner_id) VALUES ('notifications', p_user) ON CONFLICT DO NOTHING;
  SELECT id INTO v_id FROM app.team_channels WHERE kind = 'notifications' AND owner_id = p_user;
  -- First notification ever: the member row starts "read" just before it, so it counts as new.
  INSERT INTO app.team_members (channel_id, user_id, last_read_at) VALUES (v_id, p_user, now() - interval '1 second')
    ON CONFLICT DO NOTHING;
  INSERT INTO app.team_messages (channel_id, body, link) VALUES (v_id, left(p_body, 4000), p_link);
END $$;
REVOKE ALL ON FUNCTION app.team_notify(uuid, text, text) FROM PUBLIC;

-- "Mon Oct 12, 3:30 PM" at the appointment's location.
CREATE FUNCTION app.team_when(p_at timestamptz, p_location uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT to_char(p_at AT TIME ZONE l.time_zone, 'Dy Mon FMDD, FMHH12:MI AM') || ' (' || l.name || ')'
    FROM core.locations l WHERE l.id = p_location
$$;

/** Someone else assigned a to-do to an employee. */
CREATE FUNCTION app.team_notify_task() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := authz.principal_id();
  v_name text;
BEGIN
  IF NEW.assigned_to IS DISTINCT FROM v_actor AND NEW.completed_at IS NULL
     AND (TG_OP = 'INSERT' OR NEW.assigned_to IS DISTINCT FROM OLD.assigned_to) THEN
    SELECT concat_ws(' ', first_name, last_name) INTO v_name FROM core.users WHERE id = v_actor;
    PERFORM app.team_notify(NEW.assigned_to,
      coalesce(nullif(v_name, ''), 'Someone') || ' assigned you a to-do: ' || NEW.title, '/staff/todos');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER team_notify AFTER INSERT OR UPDATE OF assigned_to ON core.tasks
  FOR EACH ROW EXECUTE FUNCTION app.team_notify_task();

/** An appointment was booked for an employee by someone else; or a customer asked for one. */
CREATE FUNCTION app.team_notify_appointment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := CASE WHEN authz.principal_type() = 'employee' THEN authz.principal_id() END;
  v_service text;
  v_user uuid;
BEGIN
  SELECT name INTO v_service FROM core.services WHERE id = NEW.service_id;
  IF NEW.employee_id IS NOT NULL AND NEW.employee_id IS DISTINCT FROM v_actor
     AND NEW.status IN ('scheduled', 'confirmed')
     AND (TG_OP = 'INSERT' OR NEW.employee_id IS DISTINCT FROM OLD.employee_id) THEN
    PERFORM app.team_notify(NEW.employee_id,
      'New appointment for you: ' || v_service || ', ' || app.team_when(NEW.scheduled_start, NEW.location_id), '/staff/calendar');
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
CREATE TRIGGER team_notify AFTER INSERT OR UPDATE OF employee_id ON core.appointments
  FOR EACH ROW EXECUTE FUNCTION app.team_notify_appointment();
