-- Admin › AI: which model answers chat, and whether the assistant is shown at all.
--
-- core.settings.assistant_customers / assistant_employees: the assistant (portal page, dock and chat
-- API) is on for that audience. Off hides it in the web app and refuses new questions.
--
-- core.ai_settings (one row, audited): the chat model's provider (NULL = the server's default,
-- MODEL_ENDPOINT / MODEL_NAME, or evidence-only answers without one), the model id, a base URL for
-- an own deployment, and for OpenRouter whether only providers that don't store prompts may serve it.
-- The provider's API key is encrypted by the API (SecretBox, like Resend's in core.email_secret) and
-- kept in core.ai_secret (not audited, no grants; reached only through the functions below). It is
-- never returned to the browser.

ALTER TABLE core.settings
  ADD COLUMN assistant_customers boolean NOT NULL DEFAULT true,
  ADD COLUMN assistant_employees boolean NOT NULL DEFAULT true;

CREATE TABLE core.ai_settings (
  id               int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  provider         text CHECK (provider IN ('openrouter', 'custom')),
  model            text CHECK (length(btrim(model)) BETWEEN 1 AND 200),
  base_url         text CHECK (length(base_url) <= 500 AND base_url ~ '^https?://[^\s]+$'),
  private_only     boolean NOT NULL DEFAULT true,
  api_key_last4    text CHECK (length(api_key_last4) <= 4),
  api_key_set_at   timestamptz,
  api_key_set_by   uuid REFERENCES core.users(id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_settings_model CHECK (provider IS NULL OR model IS NOT NULL),
  CONSTRAINT ai_settings_base_url CHECK (provider IS DISTINCT FROM 'custom' OR base_url IS NOT NULL)
);
INSERT INTO core.ai_settings (id) VALUES (1);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.ai_settings FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.ai_settings FOR EACH ROW EXECUTE FUNCTION core.audit_row();

CREATE TABLE core.ai_secret (
  id             int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  api_key_cipher text CHECK (length(api_key_cipher) <= 2000)
);
INSERT INTO core.ai_secret (id) VALUES (1);
ALTER TABLE core.ai_secret ENABLE ROW LEVEL SECURITY;

ALTER TABLE core.ai_settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE ON core.ai_settings TO joybot_app;
CREATE POLICY sel ON core.ai_settings FOR SELECT TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('settings', 'update'));
CREATE POLICY upd ON core.ai_settings FOR UPDATE TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('settings', 'update'))
  WITH CHECK (authz.principal_type() = 'employee' AND authz.can('settings', 'update'));

-- Admins set (or, with NULLs, remove) the encrypted key.
CREATE FUNCTION authz.set_ai_key(p_cipher text, p_last4 text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'employee' OR NOT authz.can('settings', 'update') THEN
    RAISE EXCEPTION 'not allowed to change AI settings' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (p_cipher IS NULL) <> (p_last4 IS NULL) THEN
    RAISE EXCEPTION 'a key and its last four characters go together' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE core.ai_secret SET api_key_cipher = p_cipher WHERE id = 1;
  UPDATE core.ai_settings
     SET api_key_last4 = p_last4,
         api_key_set_at = CASE WHEN p_cipher IS NULL THEN NULL ELSE now() END,
         api_key_set_by = CASE WHEN p_cipher IS NULL THEN NULL ELSE authz.principal_id() END
   WHERE id = 1;
END $$;

-- For chat (any principal's question) and the admin page's test: the provider and its encrypted key.
CREATE FUNCTION authz.ai_delivery()
RETURNS TABLE (provider text, model text, base_url text, private_only boolean, api_key_cipher text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.provider, a.model, a.base_url, a.private_only, s.api_key_cipher
    FROM core.ai_settings a, core.ai_secret s WHERE a.id = 1 AND s.id = 1
$$;

REVOKE ALL ON FUNCTION authz.set_ai_key(text, text), authz.ai_delivery() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.set_ai_key(text, text), authz.ai_delivery() TO joybot_app;
