-- Settings › Stripe: the Stripe API key (best a restricted key) and the webhook signing secret can be
-- saved in the app instead of the environment or Secrets Manager. The API uses the key for invoice
-- checkout and the secret to verify webhooks; the worker uses the key for reconciling. Both are
-- encrypted by the app (SecretBox, SETTINGS_ENCRYPTION_KEY), kept in a table with no grants and no
-- audit, and reached only through the functions below. Admins see their last four characters.

CREATE TABLE core.stripe_secret (
  id                    int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  api_key_cipher        text CHECK (length(api_key_cipher) <= 2000),
  api_key_last4         text CHECK (length(api_key_last4) = 4),
  api_key_set_at        timestamptz,
  api_key_set_by        uuid REFERENCES core.users(id) ON DELETE SET NULL,
  webhook_secret_cipher text CHECK (length(webhook_secret_cipher) <= 2000),
  webhook_secret_last4  text CHECK (length(webhook_secret_last4) = 4),
  webhook_secret_set_at timestamptz,
  webhook_secret_set_by uuid REFERENCES core.users(id) ON DELETE SET NULL,
  CHECK ((api_key_cipher IS NULL) = (api_key_last4 IS NULL)),
  CHECK ((webhook_secret_cipher IS NULL) = (webhook_secret_last4 IS NULL))
);
INSERT INTO core.stripe_secret (id) VALUES (1);
ALTER TABLE core.stripe_secret ENABLE ROW LEVEL SECURITY;

-- Admins set (or, with NULLs, remove) the encrypted API key ('api_key') or webhook secret ('webhook_secret').
CREATE FUNCTION authz.set_stripe_secret(p_kind text, p_cipher text, p_last4 text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  who uuid := CASE WHEN p_cipher IS NULL THEN NULL ELSE authz.principal_id() END;
  at timestamptz := CASE WHEN p_cipher IS NULL THEN NULL ELSE now() END;
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'employee' OR NOT authz.can('settings', 'update') THEN
    RAISE EXCEPTION 'not allowed to change Stripe settings' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (p_cipher IS NULL) <> (p_last4 IS NULL) THEN
    RAISE EXCEPTION 'a secret and its last four characters go together' USING ERRCODE = 'check_violation';
  END IF;
  IF p_kind = 'api_key' THEN
    UPDATE core.stripe_secret SET api_key_cipher = p_cipher, api_key_last4 = p_last4, api_key_set_at = at, api_key_set_by = who WHERE id = 1;
  ELSIF p_kind = 'webhook_secret' THEN
    UPDATE core.stripe_secret
       SET webhook_secret_cipher = p_cipher, webhook_secret_last4 = p_last4, webhook_secret_set_at = at, webhook_secret_set_by = who
     WHERE id = 1;
  ELSE
    RAISE EXCEPTION 'unknown Stripe secret %', p_kind USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- For Settings › Stripe: which secrets are saved, their last four characters, and when and by whom.
CREATE FUNCTION authz.stripe_secret_info()
RETURNS TABLE (api_key_last4 text, api_key_set_at timestamptz, api_key_set_by_name text,
               webhook_secret_last4 text, webhook_secret_set_at timestamptz, webhook_secret_set_by_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'employee' OR NOT authz.can('settings', 'update') THEN
    RAISE EXCEPTION 'not allowed to see Stripe settings' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT s.api_key_last4, s.api_key_set_at, nullif(concat_ws(' ', a.first_name, a.last_name), ''),
           s.webhook_secret_last4, s.webhook_secret_set_at, nullif(concat_ws(' ', w.first_name, w.last_name), '')
      FROM core.stripe_secret s
      LEFT JOIN core.users a ON a.id = s.api_key_set_by
      LEFT JOIN core.users w ON w.id = s.webhook_secret_set_by
     WHERE s.id = 1;
END $$;

-- For invoice checkout (the API, any payer) and reconciling (the worker): the encrypted key.
CREATE FUNCTION authz.stripe_key_cipher() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT api_key_cipher FROM core.stripe_secret WHERE id = 1
$$;

-- For the webhook (no principal: Stripe calls it): the encrypted signing secret.
CREATE FUNCTION authz.stripe_webhook_cipher() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT webhook_secret_cipher FROM core.stripe_secret WHERE id = 1
$$;

REVOKE ALL ON FUNCTION authz.set_stripe_secret(text, text, text), authz.stripe_secret_info(), authz.stripe_key_cipher(), authz.stripe_webhook_cipher() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.set_stripe_secret(text, text, text), authz.stripe_secret_info(), authz.stripe_webhook_cipher() TO joybot_app;
GRANT EXECUTE ON FUNCTION authz.stripe_key_cipher() TO joybot_app, joybot_worker;

-- How often the worker reconciles with Stripe on its own, and how many days back it looks (both were
-- STRIPE_RECONCILE_INTERVAL_HOURS / STRIPE_RECONCILE_DAYS on the worker).
ALTER TABLE core.settings
  ADD COLUMN stripe_reconcile_interval_hours int NOT NULL DEFAULT 24 CHECK (stripe_reconcile_interval_hours BETWEEN 1 AND 168),
  ADD COLUMN stripe_reconcile_days int NOT NULL DEFAULT 3 CHECK (stripe_reconcile_days BETWEEN 1 AND 90);

CREATE FUNCTION authz.stripe_reconcile_settings() RETURNS TABLE (interval_hours int, days int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT stripe_reconcile_interval_hours, stripe_reconcile_days FROM core.settings WHERE id = 1
$$;
REVOKE ALL ON FUNCTION authz.stripe_reconcile_settings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.stripe_reconcile_settings() TO joybot_worker;
