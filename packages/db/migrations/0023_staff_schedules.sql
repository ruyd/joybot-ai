-- Staff working hours and time off (the calendar shades the hours outside them; booking warns).
--
-- Working hours are weekly, per location, on that location's wall clock (weekday 0 = Sunday); a day
-- may have more than one interval (a split shift). Time off is a range of instants with an optional
-- reason. Staff who have no hours at a location are not restricted there.
--
-- Access uses the new 'schedules' resource:
--   'all' — every employee's schedule
--   'own' — the employee's own schedule
-- Staff read every schedule (the calendar shows when colleagues work) and change their own; admins
-- change anyone's. The API shows a time-off reason only to its owner and to those who may change it.

ALTER TABLE core.role_permissions DROP CONSTRAINT role_permissions_resource_check;
ALTER TABLE core.role_permissions ADD CONSTRAINT role_permissions_resource_check
  CHECK (resource IN ('customers', 'organizations', 'appointments', 'payments', 'services', 'locations',
                      'tickets', 'users', 'settings', 'audit', 'notes_internal', 'access', 'tasks', 'knowledge',
                      'schedules'));

INSERT INTO core.role_permissions (role, resource, action, scope) VALUES
  ('admin', 'schedules', 'read', 'all'), ('admin', 'schedules', 'create', 'all'),
  ('admin', 'schedules', 'update', 'all'), ('admin', 'schedules', 'delete', 'all'),
  ('staff', 'schedules', 'read', 'all'), ('staff', 'schedules', 'create', 'own'),
  ('staff', 'schedules', 'update', 'own'), ('staff', 'schedules', 'delete', 'own');

CREATE TABLE core.working_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES core.locations(id) ON DELETE CASCADE,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  starts      time NOT NULL,
  ends        time NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends > starts)
);
CREATE INDEX working_hours_user ON core.working_hours (user_id, location_id, weekday);

CREATE TABLE core.time_off (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  reason     text CHECK (length(reason) <= 200),
  created_by uuid NOT NULL REFERENCES core.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (ends_at - starts_at <= interval '366 days')
);
CREATE INDEX time_off_user ON core.time_off (user_id, starts_at);

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.working_hours
  FOR EACH ROW EXECUTE FUNCTION core.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.time_off
  FOR EACH ROW EXECUTE FUNCTION core.audit_row();

-- Is this employee's schedule in the caller's scope for p_action? ('all', or 'own': their own)
CREATE FUNCTION authz.schedule_in_scope(p_user uuid, p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT authz.principal_type() = 'employee' AND (
    authz.has_perm('schedules', p_action, 'all')
    OR (authz.has_perm('schedules', p_action, 'own') AND authz.principal_id() = p_user))
$$;
REVOKE ALL ON FUNCTION authz.schedule_in_scope(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.schedule_in_scope(uuid, text) TO joybot_app;

ALTER TABLE core.working_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.time_off ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.working_hours, core.time_off TO joybot_app;

CREATE POLICY sel ON core.working_hours FOR SELECT TO joybot_app USING (authz.schedule_in_scope(user_id, 'read'));
-- Hours only at a location the employee works at.
CREATE POLICY ins ON core.working_hours FOR INSERT TO joybot_app
  WITH CHECK (authz.schedule_in_scope(user_id, 'create')
              AND EXISTS (SELECT 1 FROM core.user_locations ul WHERE ul.user_id = working_hours.user_id AND ul.location_id = working_hours.location_id));
CREATE POLICY upd ON core.working_hours FOR UPDATE TO joybot_app
  USING (authz.schedule_in_scope(user_id, 'update')) WITH CHECK (authz.schedule_in_scope(user_id, 'update'));
CREATE POLICY del ON core.working_hours FOR DELETE TO joybot_app USING (authz.schedule_in_scope(user_id, 'delete'));

CREATE POLICY sel ON core.time_off FOR SELECT TO joybot_app USING (authz.schedule_in_scope(user_id, 'read'));
CREATE POLICY ins ON core.time_off FOR INSERT TO joybot_app
  WITH CHECK (created_by = authz.principal_id() AND authz.schedule_in_scope(user_id, 'create'));
CREATE POLICY upd ON core.time_off FOR UPDATE TO joybot_app
  USING (authz.schedule_in_scope(user_id, 'update')) WITH CHECK (authz.schedule_in_scope(user_id, 'update'));
CREATE POLICY del ON core.time_off FOR DELETE TO joybot_app USING (authz.schedule_in_scope(user_id, 'delete'));

-- Concrete working intervals between two instants (each weekly row on each matching local day).
CREATE FUNCTION core.working_intervals(p_from timestamptz, p_to timestamptz, p_location uuid DEFAULT NULL)
RETURNS TABLE (employee_id uuid, location_id uuid, starts_at timestamptz, ends_at timestamptz)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT h.user_id, h.location_id, (d.day + h.starts) AT TIME ZONE l.time_zone, (d.day + h.ends) AT TIME ZONE l.time_zone
    FROM core.working_hours h
    JOIN core.locations l ON l.id = h.location_id
    CROSS JOIN LATERAL (
      SELECT g::date AS day
        FROM generate_series((p_from AT TIME ZONE l.time_zone)::date - 1, (p_to AT TIME ZONE l.time_zone)::date, interval '1 day') g
    ) d
   WHERE extract(dow FROM d.day) = h.weekday
     AND (p_location IS NULL OR h.location_id = p_location)
     AND (d.day + h.ends) AT TIME ZONE l.time_zone > p_from
     AND (d.day + h.starts) AT TIME ZONE l.time_zone < p_to
   ORDER BY 3
$$;
GRANT EXECUTE ON FUNCTION core.working_intervals(timestamptz, timestamptz, uuid) TO joybot_app;

-- Why an employee cannot take a booking at this location and time: time off, or outside the
-- working hours they have there (none set there = no restriction). Empty when they can.
CREATE FUNCTION core.employee_unavailable(p_employee uuid, p_location uuid, p_start timestamptz, p_end timestamptz)
RETURNS text[]
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN EXISTS (SELECT 1 FROM core.time_off t
                       WHERE t.user_id = p_employee AND t.starts_at < p_end AND t.ends_at > p_start)
         THEN 'time_off' END,
    CASE WHEN EXISTS (SELECT 1 FROM core.working_hours h WHERE h.user_id = p_employee AND h.location_id = p_location)
          AND NOT EXISTS (SELECT 1 FROM core.working_intervals(p_start - interval '1 day', p_end + interval '1 day', p_location) w
                           WHERE w.employee_id = p_employee AND w.starts_at <= p_start AND w.ends_at >= p_end)
         THEN 'outside_hours' END
  ], NULL)
$$;
GRANT EXECUTE ON FUNCTION core.employee_unavailable(uuid, uuid, timestamptz, timestamptz) TO joybot_app;
