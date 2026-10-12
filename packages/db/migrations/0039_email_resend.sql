-- Email through Resend (Admin › Email).
--
-- core.email_settings (one row, audited): the last four characters of Resend's API key and when it
-- was set, and the sender (from address and name). Resend sends the app's email whenever a
-- key and a from address are saved; removing either goes back to the default sender.
-- The key itself is encrypted by the API (AES-256-GCM with SETTINGS_ENCRYPTION_KEY) and kept in
-- core.email_secret (not audited, so the change log never holds it; no grants: only the functions
-- below reach it). It is never returned to the browser. Admins read and change the settings
-- ('settings' update). When Resend is off or has no key, email goes out as before (logged in
-- development, SES otherwise).

CREATE TABLE core.email_settings (
  id                int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  resend_key_last4  text CHECK (length(resend_key_last4) <= 4),
  resend_key_set_at timestamptz,
  resend_key_set_by uuid REFERENCES core.users(id),
  from_name         text CHECK (length(btrim(from_name)) BETWEEN 1 AND 80),
  from_email        citext CHECK (length(from_email) <= 254 AND from_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
INSERT INTO core.email_settings (id) VALUES (1);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.email_settings FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.email_settings FOR EACH ROW EXECUTE FUNCTION core.audit_row();

CREATE TABLE core.email_secret (
  id                int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  resend_key_cipher text CHECK (length(resend_key_cipher) <= 2000)
);
INSERT INTO core.email_secret (id) VALUES (1);
ALTER TABLE core.email_secret ENABLE ROW LEVEL SECURITY;

ALTER TABLE core.email_settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE ON core.email_settings TO joybot_app;
-- Read as well as changed by those who may update settings (staff read settings for business info).
CREATE POLICY sel ON core.email_settings FOR SELECT TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('settings', 'update'));
CREATE POLICY upd ON core.email_settings FOR UPDATE TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('settings', 'update'))
  WITH CHECK (authz.principal_type() = 'employee' AND authz.can('settings', 'update'));

-- Admins set (or, with NULLs, remove) the encrypted key.
CREATE FUNCTION authz.set_resend_key(p_cipher text, p_last4 text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'employee' OR NOT authz.can('settings', 'update') THEN
    RAISE EXCEPTION 'not allowed to change email settings' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (p_cipher IS NULL) <> (p_last4 IS NULL) THEN
    RAISE EXCEPTION 'a key and its last four characters go together' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE core.email_secret SET resend_key_cipher = p_cipher WHERE id = 1;
  UPDATE core.email_settings
     SET resend_key_last4 = p_last4,
         resend_key_set_at = CASE WHEN p_cipher IS NULL THEN NULL ELSE now() END,
         resend_key_set_by = CASE WHEN p_cipher IS NULL THEN NULL ELSE authz.principal_id() END
   WHERE id = 1;
END $$;

-- For sending, and for the admin page's calls to Resend: the encrypted key and the sender.
CREATE FUNCTION authz.email_delivery()
RETURNS TABLE (resend_key_cipher text, from_name text, from_email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.resend_key_cipher, e.from_name, e.from_email::text
    FROM core.email_settings e, core.email_secret s WHERE e.id = 1 AND s.id = 1
$$;

REVOKE ALL ON FUNCTION authz.set_resend_key(text, text), authz.email_delivery() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.set_resend_key(text, text), authz.email_delivery() TO joybot_app;
