-- Change log for every write to core tables (plan.md §4.1 core.change_log).

CREATE TABLE core.change_log (
  id          bigserial PRIMARY KEY,
  table_name  text NOT NULL,
  row_id      text NOT NULL,
  action      text NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  changed_by  uuid,                 -- principal id (employee or customer), null for system
  principal_type text,
  changed_via text,                 -- 'api' | 'worker' | 'stripe_webhook' | 'cognito' | 'migration' …
  changed_at  timestamptz NOT NULL DEFAULT now(),
  diff        jsonb NOT NULL
);
CREATE INDEX change_log_row ON core.change_log (table_name, row_id, changed_at DESC);
CREATE INDEX change_log_actor ON core.change_log (changed_by, changed_at DESC);

CREATE FUNCTION core.audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_old jsonb := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
  v_diff jsonb;
  v_row_id text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT coalesce(jsonb_object_agg(n.key, jsonb_build_object('old', v_old -> n.key, 'new', n.value)), '{}')
      INTO v_diff
      FROM jsonb_each(v_new) n
     WHERE n.key <> 'updated_at' AND (v_old -> n.key) IS DISTINCT FROM n.value;
    IF v_diff = '{}' THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    v_diff := v_new;
  ELSE
    v_diff := v_old;
  END IF;

  v_row_id := coalesce(v_new, v_old) ->> 'id';
  IF v_row_id IS NULL THEN
    -- composite keys (e.g. user_locations, role_permissions)
    v_row_id := coalesce(v_new, v_old)::text;
  END IF;

  INSERT INTO core.change_log (table_name, row_id, action, changed_by, principal_type, changed_via, diff)
  VALUES (TG_TABLE_NAME, v_row_id, TG_OP, authz.principal_id(), authz.principal_type(),
          coalesce(nullif(current_setting('app.via', true), ''), 'unknown'), v_diff);
  RETURN coalesce(NEW, OLD);
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['locations', 'users', 'user_locations', 'settings', 'organizations',
                           'customers', 'services', 'appointments', 'payments', 'external_links',
                           'role_permissions', 'assignments', 'record_grants'] LOOP
    EXECUTE format('CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.%I
                    FOR EACH ROW EXECUTE FUNCTION core.audit_row()', t);
  END LOOP;
END $$;

ALTER TABLE core.change_log ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON core.change_log TO joybot_app;
CREATE POLICY audit_read ON core.change_log FOR SELECT TO joybot_app
  USING (authz.can('audit', 'read'));
