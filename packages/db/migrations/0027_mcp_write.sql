-- MCP write tools (Phase 6, step 2). Tokens may now be 'read_write': they add tools that book and
-- reschedule appointments, manage to-dos and time off, draft invoices, and (after a confirmation)
-- cancel appointments, send or void invoices and record payments. Every write still runs as the
-- token's admin through the app's services, under RLS, recorded with via = 'mcp'.
--
-- Confirmations: an action that is hard to undo first returns a preview and a confirmation id; only a
-- second call with the same arguments and that id acts. Each confirmation is single-use, expires
-- after ten minutes and belongs to one token, one tool and one set of arguments (their sha256).

ALTER TABLE app.api_tokens DROP CONSTRAINT api_tokens_scope_check;
ALTER TABLE app.api_tokens ADD CONSTRAINT api_tokens_scope_check CHECK (scope IN ('read', 'read_write'));

CREATE TABLE app.mcp_confirmations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id   uuid NOT NULL REFERENCES app.api_tokens(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  tool       text NOT NULL,
  args_hash  text NOT NULL CHECK (args_hash ~ '^[0-9a-f]{64}$'),
  preview    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  used_at    timestamptz
);
CREATE INDEX mcp_confirmations_token ON app.mcp_confirmations (token_id, created_at DESC);

ALTER TABLE app.mcp_confirmations ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON app.mcp_confirmations TO joybot_app;
GRANT UPDATE (used_at) ON app.mcp_confirmations TO joybot_app;

-- Each employee's own confirmations only.
CREATE POLICY own ON app.mcp_confirmations TO joybot_app
  USING (authz.principal_type() = 'employee' AND user_id = authz.principal_id())
  WITH CHECK (authz.principal_type() = 'employee' AND user_id = authz.principal_id());

-- The audit view filters the change log by where changes came from (e.g. via = 'mcp').
CREATE INDEX change_log_via ON core.change_log (changed_via, changed_at DESC);
