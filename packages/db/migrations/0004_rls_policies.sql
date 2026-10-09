-- Row-Level Security policies (plan.md §4.2 "Enforcement").
-- RLS is enabled (not forced): the migration owner and SECURITY DEFINER authz functions bypass it,
-- while joybot_app / joybot_reader (non-owners) are always subject to it.
-- joybot_worker is the system principal (Stripe sync, Cognito triggers) with full access.

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA core TO joybot_app;
GRANT DELETE ON core.services, core.locations, core.user_locations, core.assignments,
                core.record_grants, core.role_permissions, core.external_links TO joybot_app;
GRANT SELECT ON ALL TABLES IN SCHEMA core TO joybot_reader;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO joybot_worker;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA core TO joybot_app, joybot_worker;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['locations', 'users', 'user_locations', 'settings', 'organizations',
                           'customers', 'services', 'appointments', 'payments', 'external_links',
                           'role_permissions', 'assignments', 'record_grants'] LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY worker_all ON core.%I TO joybot_worker USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- Reference data readable by every authenticated principal --------------------------------

CREATE POLICY read_all ON core.settings FOR SELECT TO joybot_app, joybot_reader
  USING (authz.principal_role() IS NOT NULL);
CREATE POLICY admin_update ON core.settings FOR UPDATE TO joybot_app
  USING (authz.can('settings', 'update')) WITH CHECK (authz.can('settings', 'update'));

CREATE POLICY read_all ON core.locations FOR SELECT TO joybot_app, joybot_reader
  USING (authz.principal_role() IS NOT NULL);
CREATE POLICY manage ON core.locations FOR ALL TO joybot_app
  USING (authz.can('locations', 'update')) WITH CHECK (authz.can('locations', 'update'));

CREATE POLICY read_all ON core.services FOR SELECT TO joybot_app, joybot_reader
  USING (authz.principal_role() IS NOT NULL);
CREATE POLICY manage ON core.services FOR ALL TO joybot_app
  USING (authz.can('services', 'update')) WITH CHECK (authz.can('services', 'update'));

-- Employees directory: employees only (customers see staff names through appointment views).
CREATE POLICY read_employees ON core.users FOR SELECT TO joybot_app, joybot_reader
  USING (authz.principal_type() = 'employee' AND authz.can('users', 'read'));
CREATE POLICY manage ON core.users FOR INSERT TO joybot_app
  WITH CHECK (authz.can('users', 'create'));
CREATE POLICY manage_update ON core.users FOR UPDATE TO joybot_app
  USING (authz.can('users', 'update')) WITH CHECK (authz.can('users', 'update'));

-- Access-control tables: employees can read (needed for "who can access"); admins manage.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_locations', 'role_permissions', 'assignments', 'record_grants'] LOOP
    EXECUTE format($p$CREATE POLICY read_employees ON core.%I FOR SELECT TO joybot_app, joybot_reader
                      USING (authz.principal_type() = 'employee' AND authz.principal_role() IS NOT NULL)$p$, t);
    EXECUTE format($p$CREATE POLICY manage ON core.%I FOR ALL TO joybot_app
                      USING (authz.can('access', 'update')) WITH CHECK (authz.can('access', 'update'))$p$, t);
  END LOOP;
END $$;

-- Organizations ---------------------------------------------------------------------------

CREATE POLICY sel ON core.organizations FOR SELECT TO joybot_app, joybot_reader
  USING (authz.org_in_scope(id, 'read'));
CREATE POLICY ins ON core.organizations FOR INSERT TO joybot_app
  WITH CHECK (authz.principal_type() = 'employee' AND authz.can('organizations', 'create')
              AND created_by = authz.principal_id());
CREATE POLICY upd ON core.organizations FOR UPDATE TO joybot_app
  USING (authz.org_in_scope(id, 'update')) WITH CHECK (authz.org_in_scope(id, 'update'));

-- Customers -------------------------------------------------------------------------------

CREATE POLICY sel ON core.customers FOR SELECT TO joybot_app, joybot_reader
  USING (authz.customer_in_scope(id, 'customers', 'read'));
-- Employees create customers; self sign-up rows are created by the worker (Cognito trigger).
CREATE POLICY ins ON core.customers FOR INSERT TO joybot_app
  WITH CHECK (authz.principal_type() = 'employee' AND authz.can('customers', 'create')
              AND created_by = authz.principal_id() AND source = 'employee'
              AND (organization_id IS NULL OR authz.org_in_scope(organization_id, 'read')));
CREATE POLICY upd ON core.customers FOR UPDATE TO joybot_app
  USING (authz.customer_in_scope(id, 'customers', 'update'))
  WITH CHECK (authz.customer_in_scope(id, 'customers', 'update'));

-- Appointments ------------------------------------------------------------------------------

CREATE POLICY sel ON core.appointments FOR SELECT TO joybot_app, joybot_reader
  USING (authz.appointment_in_scope(customer_id, employee_id, 'read'));
CREATE POLICY ins ON core.appointments FOR INSERT TO joybot_app
  WITH CHECK (authz.principal_type() = 'employee'
              AND authz.customer_in_scope(customer_id, 'appointments', 'create'));
CREATE POLICY upd ON core.appointments FOR UPDATE TO joybot_app
  USING (authz.appointment_in_scope(customer_id, employee_id, 'update'))
  WITH CHECK (authz.appointment_in_scope(customer_id, employee_id, 'update'));

-- Payments ----------------------------------------------------------------------------------

CREATE POLICY sel ON core.payments FOR SELECT TO joybot_app, joybot_reader
  USING (authz.payment_in_scope(customer_id, location_id, source, recorded_by, 'read'));
-- The API inserts manual payments only; Stripe rows come from the worker.
CREATE POLICY ins ON core.payments FOR INSERT TO joybot_app
  WITH CHECK (authz.principal_type() = 'employee' AND source = 'manual'
              AND recorded_by = authz.principal_id()
              AND authz.customer_in_scope(customer_id, 'payments', 'create'));
CREATE POLICY upd ON core.payments FOR UPDATE TO joybot_app
  USING (authz.payment_in_scope(customer_id, location_id, source, recorded_by, 'update')
         OR (source = 'stripe' AND customer_id IS NULL
             AND authz.payment_in_scope(customer_id, location_id, source, recorded_by, 'read')
             AND authz.can('payments', 'update')))
  WITH CHECK (authz.payment_in_scope(customer_id, location_id, source, recorded_by, 'update')
              OR (source = 'stripe' AND authz.can('payments', 'update')
                  AND authz.customer_in_scope(customer_id, 'payments', 'read')));

-- External links: employees in scope of the customer/org; customers never read them directly.
CREATE POLICY sel ON core.external_links FOR SELECT TO joybot_app, joybot_reader
  USING (authz.principal_type() = 'employee' AND (
           (entity_type = 'customer' AND authz.customer_in_scope(entity_id, 'customers', 'read'))
           OR (entity_type = 'organization' AND authz.org_in_scope(entity_id, 'read'))));
CREATE POLICY manage ON core.external_links FOR ALL TO joybot_app
  USING (authz.principal_type() = 'employee' AND entity_type = 'customer'
         AND authz.customer_in_scope(entity_id, 'customers', 'update'))
  WITH CHECK (authz.principal_type() = 'employee' AND entity_type = 'customer'
              AND authz.customer_in_scope(entity_id, 'customers', 'update'));

-- Views (security_invoker: RLS of the caller applies) -------------------------------------

CREATE VIEW core.v_customer_balance WITH (security_invoker = true) AS
SELECT c.id AS customer_id,
       coalesce(billed.total, 0)                            AS billed,
       coalesce(paid.total, 0)                              AS paid,
       coalesce(billed.total, 0) - coalesce(paid.total, 0)  AS balance
  FROM core.customers c
  LEFT JOIN LATERAL (
    SELECT sum(a.price_quoted) AS total
      FROM core.appointments a
     WHERE a.customer_id = c.id AND a.status = 'completed') billed ON true
  LEFT JOIN LATERAL (
    SELECT sum(p.amount - p.amount_refunded) AS total
      FROM core.payments p
     WHERE p.customer_id = c.id
       AND p.status IN ('succeeded', 'partially_refunded', 'refunded', 'disputed')) paid ON true;

CREATE VIEW core.v_pending_bank_transfers WITH (security_invoker = true) AS
SELECT p.*,
       (coalesce(p.expected_at, p.created_at::date)
          + (SELECT s.bank_transfer_due_days FROM core.settings s WHERE s.id = 1)) < current_date AS overdue
  FROM core.payments p
 WHERE p.method = 'bank_transfer' AND p.status = 'pending';

-- Staff names for customer-facing answers ("your appointment with Ana"), no other employee data.
CREATE VIEW core.v_staff_public AS
SELECT id, first_name, last_name FROM core.users WHERE active;

GRANT SELECT ON core.v_customer_balance, core.v_pending_bank_transfers, core.v_staff_public
  TO joybot_app, joybot_reader, joybot_worker;
