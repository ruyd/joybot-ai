-- The audit log is shown to admins (Admin › Audit log). Marking a Claude token as used (last_used_at,
-- set on every MCP request) is not a change anyone made: stop logging updates that only touch it, so
-- the log holds creating and revoking tokens. The token list still shows when each was last used.

DROP TRIGGER audit ON app.api_tokens;
CREATE TRIGGER audit AFTER INSERT OR DELETE ON app.api_tokens
  FOR EACH ROW EXECUTE FUNCTION core.audit_row();
CREATE TRIGGER audit_update AFTER UPDATE ON app.api_tokens
  FOR EACH ROW WHEN ((to_jsonb(OLD) - 'last_used_at') IS DISTINCT FROM (to_jsonb(NEW) - 'last_used_at'))
  EXECUTE FUNCTION core.audit_row();
