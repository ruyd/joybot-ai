-- Default role permissions (plan.md §4.2). Admins can tune staff permissions later; these are
-- only the initial values.

INSERT INTO core.role_permissions (role, resource, action, scope)
SELECT 'admin', r, a, 'all_including_restricted'
  FROM unnest(ARRAY['customers', 'organizations', 'appointments', 'payments', 'tickets', 'notes_internal']) r,
       unnest(ARRAY['read', 'create', 'update']) a
 WHERE NOT (r = 'tickets' AND a <> 'read');

INSERT INTO core.role_permissions (role, resource, action, scope) VALUES
  ('admin', 'payments', 'void',   'all_including_restricted'),
  ('admin', 'payments', 'refund', 'all_including_restricted');

INSERT INTO core.role_permissions (role, resource, action, scope)
SELECT 'admin', r, a, 'all'
  FROM unnest(ARRAY['services', 'locations', 'users', 'settings', 'access', 'audit']) r,
       unnest(ARRAY['read', 'create', 'update', 'delete']) a
 WHERE NOT (r IN ('settings', 'audit') AND a IN ('create', 'delete'))
   AND NOT (r = 'audit' AND a = 'update');

-- Staff: location + assigned + own for customer-centric resources
INSERT INTO core.role_permissions (role, resource, action, scope)
SELECT 'staff', r, a, s
  FROM unnest(ARRAY['customers', 'organizations', 'appointments', 'notes_internal']) r,
       unnest(ARRAY['read', 'create', 'update']) a,
       unnest(ARRAY['location', 'assigned', 'own']) s
 WHERE NOT (r = 'notes_internal' AND a = 'create');

INSERT INTO core.role_permissions (role, resource, action, scope)
SELECT 'staff', r, a, s
  FROM unnest(ARRAY['payments']) r,
       unnest(ARRAY['read', 'create']) a,
       unnest(ARRAY['location', 'assigned', 'own']) s;

INSERT INTO core.role_permissions (role, resource, action, scope) VALUES
  ('staff', 'payments',  'update', 'recorded'),     -- own manual entries, same day (API rule)
  ('staff', 'tickets',   'read',   'location'),
  ('staff', 'tickets',   'read',   'assigned'),
  ('staff', 'tickets',   'read',   'own'),
  ('staff', 'services',  'read',   'all'),
  ('staff', 'locations', 'read',   'all'),
  ('staff', 'users',     'read',   'all'),
  ('staff', 'settings',  'read',   'all');

-- Org admin (customer audience)
INSERT INTO core.role_permissions (role, resource, action, scope) VALUES
  ('org_admin', 'customers',     'read',   'self'),
  ('org_admin', 'customers',     'update', 'self'),
  ('org_admin', 'customers',     'read',   'org'),
  ('org_admin', 'customers',     'update', 'org'),     -- membership fields only (API rule)
  ('org_admin', 'organizations', 'read',   'org'),
  ('org_admin', 'appointments',  'read',   'self'),
  ('org_admin', 'appointments',  'read',   'org'),
  ('org_admin', 'payments',      'read',   'self'),    -- never members' payments
  ('org_admin', 'tickets',       'read',   'self'),
  ('org_admin', 'tickets',       'read',   'org'),
  ('org_admin', 'services',      'read',   'all'),
  ('org_admin', 'locations',     'read',   'all'),
  ('org_admin', 'settings',      'read',   'all');

-- Customer
INSERT INTO core.role_permissions (role, resource, action, scope) VALUES
  ('customer', 'customers',     'read',   'self'),
  ('customer', 'customers',     'update', 'self'),
  ('customer', 'organizations', 'read',   'self'),
  ('customer', 'appointments',  'read',   'self'),
  ('customer', 'payments',      'read',   'self'),
  ('customer', 'tickets',       'read',   'self'),
  ('customer', 'services',      'read',   'all'),
  ('customer', 'locations',     'read',   'all'),
  ('customer', 'settings',      'read',   'all');
