-- Settings › Stripe: a test API key and test webhook signing secret beside the live ones, and a switch
-- between live and test mode. The mode decides which key the API (checkout) and the worker
-- (reconciling) use, and which webhook events are applied (the other mode's are acknowledged and
-- ignored, so test payments never mix with live ones).

ALTER TABLE core.settings ADD COLUMN stripe_test_mode boolean NOT NULL DEFAULT false;

ALTER TABLE core.stripe_secret
  ADD COLUMN test_api_key_cipher        text CHECK (length(test_api_key_cipher) <= 2000),
  ADD COLUMN test_api_key_last4         text CHECK (length(test_api_key_last4) = 4),
  ADD COLUMN test_api_key_set_at        timestamptz,
  ADD COLUMN test_api_key_set_by        uuid REFERENCES core.users(id) ON DELETE SET NULL,
  ADD COLUMN test_webhook_secret_cipher text CHECK (length(test_webhook_secret_cipher) <= 2000),
  ADD COLUMN test_webhook_secret_last4  text CHECK (length(test_webhook_secret_last4) = 4),
  ADD COLUMN test_webhook_secret_set_at timestamptz,
  ADD COLUMN test_webhook_secret_set_by uuid REFERENCES core.users(id) ON DELETE SET NULL,
  ADD CHECK ((test_api_key_cipher IS NULL) = (test_api_key_last4 IS NULL)),
  ADD CHECK ((test_webhook_secret_cipher IS NULL) = (test_webhook_secret_last4 IS NULL));

CREATE OR REPLACE FUNCTION authz.set_stripe_secret(p_kind text, p_cipher text, p_last4 text) RETURNS void
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
  ELSIF p_kind = 'test_api_key' THEN
    UPDATE core.stripe_secret
       SET test_api_key_cipher = p_cipher, test_api_key_last4 = p_last4, test_api_key_set_at = at, test_api_key_set_by = who
     WHERE id = 1;
  ELSIF p_kind = 'test_webhook_secret' THEN
    UPDATE core.stripe_secret
       SET test_webhook_secret_cipher = p_cipher, test_webhook_secret_last4 = p_last4, test_webhook_secret_set_at = at, test_webhook_secret_set_by = who
     WHERE id = 1;
  ELSE
    RAISE EXCEPTION 'unknown Stripe secret %', p_kind USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- For Settings › Stripe: one row per saved secret (kind, last four characters, when and by whom).
DROP FUNCTION authz.stripe_secret_info();
CREATE FUNCTION authz.stripe_secret_info()
RETURNS TABLE (kind text, last4 text, set_at timestamptz, set_by_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'employee' OR NOT authz.can('settings', 'update') THEN
    RAISE EXCEPTION 'not allowed to see Stripe settings' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT k.kind, k.last4, k.set_at, nullif(concat_ws(' ', u.first_name, u.last_name), '')
      FROM core.stripe_secret s
     CROSS JOIN LATERAL (VALUES
       ('api_key', s.api_key_last4, s.api_key_set_at, s.api_key_set_by),
       ('webhook_secret', s.webhook_secret_last4, s.webhook_secret_set_at, s.webhook_secret_set_by),
       ('test_api_key', s.test_api_key_last4, s.test_api_key_set_at, s.test_api_key_set_by),
       ('test_webhook_secret', s.test_webhook_secret_last4, s.test_webhook_secret_set_at, s.test_webhook_secret_set_by)
     ) AS k(kind, last4, set_at, set_by)
      LEFT JOIN core.users u ON u.id = k.set_by
     WHERE s.id = 1;
END $$;
REVOKE ALL ON FUNCTION authz.stripe_secret_info() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.stripe_secret_info() TO joybot_app;

-- The encrypted API key of the mode in use (checkout and reconciling).
CREATE OR REPLACE FUNCTION authz.stripe_key_cipher() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN (SELECT stripe_test_mode FROM core.settings WHERE id = 1) THEN test_api_key_cipher ELSE api_key_cipher END
    FROM core.stripe_secret WHERE id = 1
$$;

-- For the webhook (no principal): the mode in use and both encrypted signing secrets.
CREATE FUNCTION authz.stripe_webhook_secrets() RETURNS TABLE (test_mode boolean, live_cipher text, test_cipher text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT (SELECT stripe_test_mode FROM core.settings WHERE id = 1), webhook_secret_cipher, test_webhook_secret_cipher
    FROM core.stripe_secret WHERE id = 1
$$;
REVOKE ALL ON FUNCTION authz.stripe_webhook_secrets() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.stripe_webhook_secrets() TO joybot_app;
DROP FUNCTION authz.stripe_webhook_cipher();
