-- Revoking a Claude token deletes it (Settings › Claude access). The audit trigger already logs a
-- DELETE with the whole row and who did it, so the change log keeps "who deleted which token (its
-- name and prefix), and when it was last used". Admins may delete any token, like revoking.
GRANT DELETE ON app.api_tokens TO joybot_app;
CREATE POLICY del ON app.api_tokens FOR DELETE TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.principal_role() = 'admin');
