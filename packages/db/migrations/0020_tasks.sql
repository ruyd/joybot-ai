-- Staff to-dos (the staff "To-dos" page and the home page's pending list).
--
-- A task has a title, optional notes, an optional due date, an optional customer, and an assignee
-- (an active employee; the creator by default). It is open until completed.
--
-- Access uses the new 'tasks' resource:
--   'own' — tasks assigned to or created by the employee (staff default)
--   'all' — every task (admin default)
-- Linking a customer needs read access to that customer. Customers never see tasks.

ALTER TABLE core.role_permissions DROP CONSTRAINT role_permissions_resource_check;
ALTER TABLE core.role_permissions ADD CONSTRAINT role_permissions_resource_check
  CHECK (resource IN ('customers', 'organizations', 'appointments', 'payments', 'services', 'locations',
                      'tickets', 'users', 'settings', 'audit', 'notes_internal', 'access', 'tasks'));

INSERT INTO core.role_permissions (role, resource, action, scope) VALUES
  ('admin', 'tasks', 'read', 'all'), ('admin', 'tasks', 'create', 'all'),
  ('admin', 'tasks', 'update', 'all'), ('admin', 'tasks', 'delete', 'all'),
  ('staff', 'tasks', 'read', 'own'), ('staff', 'tasks', 'create', 'own'),
  ('staff', 'tasks', 'update', 'own'), ('staff', 'tasks', 'delete', 'own');

CREATE TABLE core.tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  notes        text CHECK (length(notes) <= 5000),
  due_on       date,
  customer_id  uuid REFERENCES core.customers(id) ON DELETE SET NULL,
  assigned_to  uuid NOT NULL REFERENCES core.users(id),
  created_by   uuid NOT NULL REFERENCES core.users(id),
  completed_at timestamptz,
  completed_by uuid REFERENCES core.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((completed_at IS NULL) = (completed_by IS NULL))
);
CREATE INDEX tasks_assignee_open ON core.tasks (assigned_to, due_on) WHERE completed_at IS NULL;
CREATE INDEX tasks_creator ON core.tasks (created_by);
CREATE INDEX tasks_customer ON core.tasks (customer_id) WHERE customer_id IS NOT NULL;

CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.tasks
  FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.tasks
  FOR EACH ROW EXECUTE FUNCTION core.audit_row();

-- Is this task in the employee's scope for p_action? ('all', or 'own': assigned to or created by them)
CREATE FUNCTION authz.task_in_scope(p_assigned_to uuid, p_created_by uuid, p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT authz.principal_type() = 'employee' AND (
    authz.has_perm('tasks', p_action, 'all')
    OR (authz.has_perm('tasks', p_action, 'own') AND authz.principal_id() IN (p_assigned_to, p_created_by)))
$$;
REVOKE ALL ON FUNCTION authz.task_in_scope(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.task_in_scope(uuid, uuid, text) TO joybot_app;

ALTER TABLE core.tasks ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.tasks TO joybot_app;

CREATE POLICY sel ON core.tasks FOR SELECT TO joybot_app
  USING (authz.task_in_scope(assigned_to, created_by, 'read'));
-- New tasks are created by the caller (so 'own' covers them), for an active employee, and may only
-- link a customer the caller can read.
CREATE POLICY ins ON core.tasks FOR INSERT TO joybot_app
  WITH CHECK (
    created_by = authz.principal_id()
    AND authz.task_in_scope(assigned_to, created_by, 'create')
    AND EXISTS (SELECT 1 FROM core.v_staff_public s WHERE s.id = assigned_to)
    AND (customer_id IS NULL OR authz.customer_in_scope(customer_id, 'customers', 'read')));
CREATE POLICY upd ON core.tasks FOR UPDATE TO joybot_app
  USING (authz.task_in_scope(assigned_to, created_by, 'update'))
  WITH CHECK (
    authz.task_in_scope(assigned_to, created_by, 'update')
    AND (customer_id IS NULL OR authz.customer_in_scope(customer_id, 'customers', 'read')));
CREATE POLICY del ON core.tasks FOR DELETE TO joybot_app
  USING (authz.task_in_scope(assigned_to, created_by, 'delete'));

-- Customer merges (authz.merge_customers) move everything to the target; tasks follow the tombstone.
CREATE FUNCTION core.move_tasks_on_merge() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE core.tasks SET customer_id = NEW.merged_into WHERE customer_id = NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER move_tasks_on_merge AFTER UPDATE OF merged_into ON core.customers
  FOR EACH ROW WHEN (NEW.merged_into IS NOT NULL AND OLD.merged_into IS DISTINCT FROM NEW.merged_into)
  EXECUTE FUNCTION core.move_tasks_on_merge();
