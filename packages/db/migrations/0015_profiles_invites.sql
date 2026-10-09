-- Profile self-service and invites (plan.md §4.3).

-- Codes for adding/changing a customer's email or phone (stored hashed; short-lived).
CREATE TABLE app.contact_verifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES core.customers(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('email', 'phone')),
  value       text NOT NULL,
  code_hash   text NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_verifications_customer ON app.contact_verifications (customer_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON app.contact_verifications TO joybot_app;
ALTER TABLE app.contact_verifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY own ON app.contact_verifications TO joybot_app
  USING (authz.principal_type() = 'customer' AND customer_id = authz.principal_id())
  WITH CHECK (authz.principal_type() = 'customer' AND customer_id = authz.principal_id());

-- Members added by an org admin.
ALTER TABLE core.customers DROP CONSTRAINT customers_source_check;
ALTER TABLE core.customers ADD CONSTRAINT customers_source_check CHECK (source IN ('employee', 'self_signup', 'org_admin'));

/** Org admins add a member to their own organization (customers cannot insert customers directly). */
CREATE FUNCTION authz.create_org_member(p_first_name text, p_last_name text, p_email text, p_phone text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid;
  v_id  uuid;
BEGIN
  SELECT c.organization_id INTO v_org FROM core.customers c
   WHERE authz.principal_type() = 'customer' AND c.id = authz.principal_id()
     AND c.org_role = 'org_admin' AND c.status = 'active';
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'only organization admins can add members' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO core.customers (first_name, last_name, email, phone, organization_id, org_role, source,
                              preferred_location_id)
  SELECT p_first_name, p_last_name, lower(nullif(trim(p_email), '')), nullif(trim(p_phone), ''), v_org, 'member', 'org_admin',
         me.preferred_location_id
    FROM core.customers me WHERE me.id = authz.principal_id()
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

/** Org admins remove a member from their organization (the member keeps their own account). */
CREATE FUNCTION authz.remove_org_member(p_customer uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT c.organization_id INTO v_org FROM core.customers c
   WHERE authz.principal_type() = 'customer' AND c.id = authz.principal_id()
     AND c.org_role = 'org_admin' AND c.status = 'active';
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'only organization admins can remove members' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_customer = authz.principal_id() THEN
    RAISE EXCEPTION 'you cannot remove yourself' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE core.customers SET organization_id = NULL, org_role = NULL
   WHERE id = p_customer AND organization_id = v_org AND org_role = 'member';
  RETURN FOUND;
END $$;

GRANT EXECUTE ON FUNCTION authz.create_org_member(text, text, text, text), authz.remove_org_member(uuid) TO joybot_app;

-- Where an invite went, masked (shown on the public invite page).
ALTER TABLE app.invites ADD COLUMN sent_to_mask text;

/** Public invite page: minimal, non-identifying details for a valid token hash. */
CREATE FUNCTION authz.invite_preview(p_token_hash text)
RETURNS TABLE (channel text, expires_at timestamptz, sent_to text, organization text, business_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT i.channel, i.expires_at, i.sent_to_mask, o.name, s.business_name
    FROM app.invites i
    LEFT JOIN core.organizations o ON o.id = i.organization_id
    CROSS JOIN core.settings s
   WHERE i.token_hash = p_token_hash AND s.id = 1 AND i.accepted_at IS NULL AND i.expires_at > now()
$$;
GRANT EXECUTE ON FUNCTION authz.invite_preview(text) TO joybot_app;
