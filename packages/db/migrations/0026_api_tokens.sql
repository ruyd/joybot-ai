-- Personal access tokens for the MCP endpoint (Phase 6): an admin lets Claude (Claude Code, Claude
-- Desktop) read their business data as them. Only the sha256 of a token is stored; the token is shown
-- once. A token works while it is not revoked or expired and its owner is still an active admin;
-- every MCP call then runs as that admin, so RLS decides what it can see.
--
-- Scope 'read' only for now (read-only tools); 'read_write' comes with write tools.

CREATE TABLE app.api_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  prefix       text NOT NULL, -- first characters, to tell tokens apart
  scope        text NOT NULL DEFAULT 'read' CHECK (scope IN ('read')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES core.users(id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '366 days')
);
CREATE INDEX api_tokens_user ON app.api_tokens (user_id, created_at DESC);

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.api_tokens
  FOR EACH ROW EXECUTE FUNCTION core.audit_row();

ALTER TABLE app.api_tokens ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON app.api_tokens TO joybot_app;
GRANT UPDATE (revoked_at, revoked_by) ON app.api_tokens TO joybot_app;

-- Admins see every token (to revoke a leaked one); nobody else has any.
CREATE POLICY sel ON app.api_tokens FOR SELECT TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.principal_role() = 'admin');
-- Admins create tokens for themselves only.
CREATE POLICY ins ON app.api_tokens FOR INSERT TO joybot_app
  WITH CHECK (authz.principal_type() = 'employee' AND authz.principal_role() = 'admin' AND user_id = authz.principal_id());
CREATE POLICY upd ON app.api_tokens FOR UPDATE TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.principal_role() = 'admin')
  WITH CHECK (revoked_by = authz.principal_id());

/**
 * The MCP endpoint's sign-in: the token's owner when the token is live and the owner is still an
 * active admin (a demoted or deactivated admin's tokens stop working at once). Marks it used.
 */
CREATE FUNCTION authz.resolve_api_token(p_hash text) RETURNS TABLE (token_id uuid, user_id uuid, scope text, name text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE app.api_tokens t SET last_used_at = now()
   WHERE t.token_hash = p_hash AND t.revoked_at IS NULL AND t.expires_at > now()
     AND EXISTS (SELECT 1 FROM core.users u WHERE u.id = t.user_id AND u.active AND u.role = 'admin')
  RETURNING t.id, t.user_id, t.scope, t.name
$$;
REVOKE ALL ON FUNCTION authz.resolve_api_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.resolve_api_token(text) TO joybot_app;
