-- Employee double-booking check across all customers (staff may not see every customer's
-- appointments through RLS). Returns only the conflicting appointment numbers and times.

CREATE FUNCTION core.employee_conflicts(p_employee uuid, p_start timestamptz, p_end timestamptz,
                                        p_exclude uuid DEFAULT NULL)
RETURNS TABLE (appointment_number text, scheduled_start timestamptz, scheduled_end timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.appointment_number, a.scheduled_start, a.scheduled_end
    FROM core.appointments a
   WHERE authz.principal_type() = 'employee'
     AND a.employee_id = p_employee
     AND a.status IN ('scheduled', 'confirmed')
     AND (p_exclude IS NULL OR a.id <> p_exclude)
     AND tstzrange(a.scheduled_start, a.scheduled_end) && tstzrange(p_start, p_end)
   ORDER BY a.scheduled_start
$$;

GRANT EXECUTE ON FUNCTION core.employee_conflicts(uuid, timestamptz, timestamptz, uuid) TO joybot_app;

-- Appointment views join staff names; customers read them through core.v_staff_public.
CREATE INDEX appointments_employee_active ON core.appointments (employee_id, scheduled_start)
  WHERE status IN ('scheduled', 'confirmed');

-- Ending an assignment must take effect immediately, even right after it started.
ALTER TABLE core.assignments DROP CONSTRAINT assignments_check1;
ALTER TABLE core.assignments ADD CONSTRAINT assignments_period_check CHECK (ends_at IS NULL OR ends_at >= starts_at);
