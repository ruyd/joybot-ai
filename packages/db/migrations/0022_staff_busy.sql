-- Calendar: when staff are booked, across all customers. Staff may not see every
-- customer's appointments through RLS, but the calendar still has to show that a colleague is busy.
-- Returns only times, staff and location: never the customer, service or notes. The appointment id
-- lets the API drop the ones the caller can already see; it never leaves the API.

CREATE FUNCTION core.staff_busy(p_from timestamptz, p_to timestamptz, p_location uuid DEFAULT NULL)
RETURNS TABLE (appointment_id uuid, employee_id uuid, location_id uuid, scheduled_start timestamptz, scheduled_end timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.id, a.employee_id, a.location_id, a.scheduled_start, a.scheduled_end
    FROM core.appointments a
   WHERE authz.principal_type() = 'employee'
     AND a.employee_id IS NOT NULL
     AND a.status IN ('scheduled', 'confirmed')
     AND p_to > p_from AND p_to - p_from <= interval '45 days'
     AND a.scheduled_end > p_from AND a.scheduled_start < p_to
     AND (p_location IS NULL OR a.location_id = p_location)
   ORDER BY a.scheduled_start
   LIMIT 2000
$$;

GRANT EXECUTE ON FUNCTION core.staff_busy(timestamptz, timestamptz, uuid) TO joybot_app;
