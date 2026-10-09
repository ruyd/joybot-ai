-- Rows inserted in the current statement are not visible to the STABLE security-definer lookups
-- (they read the statement snapshot), so INSERT ... RETURNING by the creator would fail.
-- Let the creator see what they just created, judged on the row's own columns.

CREATE POLICY sel_own_created ON core.customers FOR SELECT TO joybot_app, joybot_reader
  USING (authz.principal_type() = 'employee'
         AND created_by = authz.principal_id()
         AND authz.can('customers', 'read')
         AND (NOT restricted OR authz.has_perm('customers', 'read', 'all_including_restricted')));

CREATE POLICY sel_own_created ON core.organizations FOR SELECT TO joybot_app, joybot_reader
  USING (authz.principal_type() = 'employee'
         AND created_by = authz.principal_id()
         AND authz.can('organizations', 'read')
         AND (NOT restricted OR authz.has_perm('organizations', 'read', 'all_including_restricted')));
