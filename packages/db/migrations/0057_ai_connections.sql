-- Settings › AI, several connections at once: provider accounts (connections), the models they offer,
-- and one slot per capability (the General model, plus specialists such as text to speech) that all
-- work at the same time. Replaces the single row in core.ai_settings, which is copied over and no
-- longer read by the API.
--
-- core.ai_connections (audited): an account at a provider: its kind and address, whether it is
-- private (neither stores nor trains on prompts: customers' questions only ever go to private
-- connections), on or off, and a monthly spending cap in US dollars.
-- core.ai_connection_secrets: each connection's API key, encrypted by the API (SecretBox), with no
-- grants and no audit; reached only through the functions below. Never returned to the browser.
-- core.ai_models (audited): a model at a connection, what it does (its capability), labels (e.g. MoE)
-- and prices per million units (tokens, or characters for speech) to estimate costs.
-- core.ai_slots (audited): per capability, the active model, an optional backup, how its work is
-- delivered (direct now; a Postgres queue next, then Redis, SQS, Durable Objects) and on or off.
-- The General slot: no model = the server's default model (Auto); off = search only.
-- app.ai_calls: one row per call (connection, model, tokens or characters, cost, time, result), what
-- the caps count against. Written for any principal's question through authz.log_ai_call; read by admins.
--
-- All of it is for admins (the settings permission), like Settings › AI before.

CREATE TABLE core.ai_connections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  kind            text NOT NULL CHECK (kind IN ('openrouter', 'openai_compatible', 'ollama')),
  base_url        text CHECK (length(base_url) <= 500 AND base_url ~ '^https?://[^\s]+$'),
  private         boolean NOT NULL DEFAULT false,
  active          boolean NOT NULL DEFAULT true,
  monthly_cap_usd numeric(12, 2) CHECK (monthly_cap_usd >= 0),
  api_key_last4   text CHECK (length(api_key_last4) <= 4),
  api_key_set_at  timestamptz,
  api_key_set_by  uuid REFERENCES core.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- OpenRouter has a fixed address; the others need one.
  CONSTRAINT ai_connections_base_url CHECK (kind = 'openrouter' OR base_url IS NOT NULL)
);
CREATE UNIQUE INDEX ai_connections_name ON core.ai_connections (lower(name));
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.ai_connections FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.ai_connections FOR EACH ROW EXECUTE FUNCTION core.audit_row();

CREATE TABLE core.ai_connection_secrets (
  connection_id  uuid PRIMARY KEY REFERENCES core.ai_connections(id) ON DELETE CASCADE,
  api_key_cipher text NOT NULL CHECK (length(api_key_cipher) <= 2000)
);
ALTER TABLE core.ai_connection_secrets ENABLE ROW LEVEL SECURITY;

CREATE TABLE core.ai_models (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES core.ai_connections(id) ON DELETE CASCADE,
  model         text NOT NULL CHECK (length(btrim(model)) BETWEEN 1 AND 200),
  capability    text NOT NULL CHECK (capability IN (
    'general', 'embeddings', 'reranker', 'speech_to_text', 'text_to_speech', 'realtime_voice',
    'vision', 'image_generation', 'video_generation', 'avatar', 'moderation', 'document_parsing')),
  label         text CHECK (length(label) <= 100),
  tags          text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 10),
  -- US dollars per million input / output units (tokens; characters for text to speech).
  input_price   numeric(12, 4) CHECK (input_price >= 0),
  output_price  numeric(12, 4) CHECK (output_price >= 0),
  -- Per-capability options, e.g. {"voice": "nadine"} for text to speech.
  options       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(options) = 'object'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, model, capability)
);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.ai_models FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.ai_models FOR EACH ROW EXECUTE FUNCTION core.audit_row();

CREATE TABLE core.ai_slots (
  capability      text PRIMARY KEY CHECK (capability IN (
    'general', 'embeddings', 'reranker', 'speech_to_text', 'text_to_speech', 'realtime_voice',
    'vision', 'image_generation', 'video_generation', 'avatar', 'moderation', 'document_parsing')),
  model_id        uuid REFERENCES core.ai_models(id) ON DELETE SET NULL,
  backup_model_id uuid REFERENCES core.ai_models(id) ON DELETE SET NULL,
  transport       text NOT NULL DEFAULT 'postgres' CHECK (transport IN ('direct', 'postgres', 'redis', 'sqs', 'durable_objects')),
  active          boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_slots_backup CHECK (backup_model_id IS DISTINCT FROM model_id OR model_id IS NULL)
);
-- Interactive capabilities answer while the person waits, so they are called directly.
INSERT INTO core.ai_slots (capability, transport)
SELECT c, CASE WHEN c IN ('general', 'embeddings', 'reranker', 'speech_to_text', 'text_to_speech', 'realtime_voice', 'vision', 'moderation') THEN 'direct' ELSE 'postgres' END
  FROM unnest(ARRAY['general', 'embeddings', 'reranker', 'speech_to_text', 'text_to_speech', 'realtime_voice',
                    'vision', 'image_generation', 'video_generation', 'avatar', 'moderation', 'document_parsing']) AS c;
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.ai_slots FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.ai_slots FOR EACH ROW EXECUTE FUNCTION core.audit_row();

-- A slot's models must do what the slot does.
CREATE FUNCTION core.ai_slot_models_match() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM core.ai_models m WHERE m.id IN (NEW.model_id, NEW.backup_model_id) AND m.capability <> NEW.capability) THEN
    RAISE EXCEPTION 'a slot''s models must have its capability (%)', NEW.capability USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER models_match BEFORE INSERT OR UPDATE ON core.ai_slots FOR EACH ROW EXECUTE FUNCTION core.ai_slot_models_match();

CREATE TABLE app.ai_calls (
  id             bigserial PRIMARY KEY,
  connection_id  uuid REFERENCES core.ai_connections(id) ON DELETE SET NULL,
  model_id       uuid REFERENCES core.ai_models(id) ON DELETE SET NULL,
  capability     text NOT NULL,
  model          text NOT NULL,
  audience       text CHECK (audience IN ('employee', 'customer', 'admin')),
  step           text CHECK (length(step) <= 40),
  input_units    int CHECK (input_units >= 0),
  output_units   int CHECK (output_units >= 0),
  cost_usd       numeric(14, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  ms             int CHECK (ms >= 0),
  ok             boolean NOT NULL,
  error          text CHECK (length(error) <= 300),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_calls_connection_month ON app.ai_calls (connection_id, created_at);
CREATE INDEX ai_calls_recent ON app.ai_calls (created_at DESC);

-- Access: admins read and change connections, models and slots; the call log is read-only to them.
ALTER TABLE core.ai_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.ai_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.ai_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_calls ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.ai_connections, core.ai_models TO joybot_app;
GRANT SELECT, UPDATE ON core.ai_slots TO joybot_app;
GRANT SELECT ON app.ai_calls TO joybot_app;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['core.ai_connections', 'core.ai_models', 'core.ai_slots'] LOOP
    EXECUTE format($p$CREATE POLICY admin_all ON %s FOR ALL TO joybot_app
      USING (authz.principal_type() = 'employee' AND authz.can('settings', 'update'))
      WITH CHECK (authz.principal_type() = 'employee' AND authz.can('settings', 'update'))$p$, t);
  END LOOP;
END $$;
CREATE POLICY admin_read ON app.ai_calls FOR SELECT TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('settings', 'update'));

-- Admins set (or, with NULLs, remove) a connection's encrypted key.
CREATE FUNCTION authz.set_ai_connection_key(p_connection uuid, p_cipher text, p_last4 text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'employee' OR NOT authz.can('settings', 'update') THEN
    RAISE EXCEPTION 'not allowed to change AI settings' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (p_cipher IS NULL) <> (p_last4 IS NULL) THEN
    RAISE EXCEPTION 'a key and its last four characters go together' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.ai_connections WHERE id = p_connection) THEN
    RAISE EXCEPTION 'no such connection' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_cipher IS NULL THEN
    DELETE FROM core.ai_connection_secrets WHERE connection_id = p_connection;
  ELSE
    INSERT INTO core.ai_connection_secrets (connection_id, api_key_cipher) VALUES (p_connection, p_cipher)
      ON CONFLICT (connection_id) DO UPDATE SET api_key_cipher = EXCLUDED.api_key_cipher;
  END IF;
  UPDATE core.ai_connections
     SET api_key_last4 = p_last4,
         api_key_set_at = CASE WHEN p_cipher IS NULL THEN NULL ELSE now() END,
         api_key_set_by = CASE WHEN p_cipher IS NULL THEN NULL ELSE authz.principal_id() END
   WHERE id = p_connection;
END $$;

-- This month's spending per connection (UTC calendar month).
CREATE FUNCTION authz.ai_month_spend() RETURNS TABLE (connection_id uuid, spent_usd numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.connection_id, sum(c.cost_usd)
    FROM app.ai_calls c
   WHERE c.connection_id IS NOT NULL AND c.created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
   GROUP BY c.connection_id
$$;

-- For chat (any principal's question) and the admin page's tests: what a slot uses now, its active model
-- first, then the backup, each with its connection, encrypted key and whether it is over its cap.
CREATE FUNCTION authz.ai_slot_delivery(p_capability text)
RETURNS TABLE (slot_active boolean, transport text, role text, model_id uuid, model text, options jsonb,
               input_price numeric, output_price numeric, connection_id uuid, connection_name text, kind text,
               base_url text, private boolean, connection_active boolean, over_cap boolean, api_key_cipher text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.active, s.transport, r.role, m.id, m.model, m.options, m.input_price, m.output_price,
         c.id, c.name, c.kind, c.base_url, c.private, c.active,
         c.monthly_cap_usd IS NOT NULL AND coalesce(sp.spent_usd, 0) >= c.monthly_cap_usd,
         k.api_key_cipher
    FROM core.ai_slots s
    LEFT JOIN LATERAL (VALUES ('primary', s.model_id, 1), ('backup', s.backup_model_id, 2)) AS r(role, id, ord) ON r.id IS NOT NULL
    LEFT JOIN core.ai_models m ON m.id = r.id
    LEFT JOIN core.ai_connections c ON c.id = m.connection_id
    LEFT JOIN core.ai_connection_secrets k ON k.connection_id = c.id
    LEFT JOIN authz.ai_month_spend() sp ON sp.connection_id = c.id
   WHERE s.capability = p_capability
   ORDER BY r.ord NULLS LAST
$$;

-- Admins' Test button: one model with its connection and key, whichever slot uses it.
CREATE FUNCTION authz.ai_model_delivery(p_model uuid)
RETURNS TABLE (model_id uuid, model text, capability text, options jsonb, input_price numeric, output_price numeric,
               connection_id uuid, connection_name text, kind text, base_url text, private boolean, api_key_cipher text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'employee' OR NOT authz.can('settings', 'update') THEN
    RAISE EXCEPTION 'not allowed to test AI models' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT m.id, m.model, m.capability, m.options, m.input_price, m.output_price, c.id, c.name, c.kind, c.base_url, c.private, k.api_key_cipher
    FROM core.ai_models m
    JOIN core.ai_connections c ON c.id = m.connection_id
    LEFT JOIN core.ai_connection_secrets k ON k.connection_id = c.id
   WHERE m.id = p_model;
END $$;
REVOKE ALL ON FUNCTION authz.ai_model_delivery(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.ai_model_delivery(uuid) TO joybot_app;

-- Any principal's call is logged (no prompt or reply text, just what it cost and how it went).
CREATE FUNCTION authz.log_ai_call(p_connection uuid, p_model_id uuid, p_capability text, p_model text, p_audience text,
                                  p_step text, p_input int, p_output int, p_cost numeric, p_ms int, p_ok boolean, p_error text)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  INSERT INTO app.ai_calls (connection_id, model_id, capability, model, audience, step, input_units, output_units, cost_usd, ms, ok, error)
  VALUES (p_connection, p_model_id, p_capability, left(p_model, 200), p_audience, left(p_step, 40), p_input, p_output,
          greatest(coalesce(p_cost, 0), 0), p_ms, p_ok, left(p_error, 300))
$$;

REVOKE ALL ON FUNCTION authz.set_ai_connection_key(uuid, text, text), authz.ai_month_spend(), authz.ai_slot_delivery(text),
  authz.log_ai_call(uuid, uuid, text, text, text, text, int, int, numeric, int, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.set_ai_connection_key(uuid, text, text), authz.ai_month_spend(), authz.ai_slot_delivery(text),
  authz.log_ai_call(uuid, uuid, text, text, text, text, int, int, numeric, int, boolean, text) TO joybot_app;

-- Carry over today's setting: a saved provider becomes a connection and the General slot's model;
-- "No model — search only" turns the General slot off; Auto leaves it empty.
DO $$
DECLARE
  s record;
  v_connection uuid;
  v_model uuid;
BEGIN
  SELECT a.*, k.api_key_cipher INTO s FROM core.ai_settings a, core.ai_secret k WHERE a.id = 1 AND k.id = 1;
  IF s.provider = 'none' THEN
    UPDATE core.ai_slots SET active = false WHERE capability = 'general';
  ELSIF s.provider IN ('openrouter', 'custom') AND s.model IS NOT NULL THEN
    INSERT INTO core.ai_connections (name, kind, base_url, private, api_key_last4, api_key_set_at, api_key_set_by)
    VALUES (CASE s.provider WHEN 'openrouter' THEN 'OpenRouter' ELSE 'Own deployment' END,
            CASE s.provider WHEN 'openrouter' THEN 'openrouter' ELSE 'openai_compatible' END,
            CASE s.provider WHEN 'custom' THEN s.base_url END,
            -- OpenRouter's "only providers that don't store prompts" was enforced per request; an own
            -- deployment was trusted with customer records before, so it stays private.
            CASE s.provider WHEN 'openrouter' THEN s.private_only ELSE true END,
            s.api_key_last4, s.api_key_set_at, s.api_key_set_by)
    RETURNING id INTO v_connection;
    IF s.api_key_cipher IS NOT NULL THEN
      INSERT INTO core.ai_connection_secrets (connection_id, api_key_cipher) VALUES (v_connection, s.api_key_cipher);
    END IF;
    INSERT INTO core.ai_models (connection_id, model, capability, tags) VALUES (v_connection, s.model, 'general', ARRAY['MoE'])
    RETURNING id INTO v_model;
    UPDATE core.ai_slots SET model_id = v_model WHERE capability = 'general';
  END IF;
END $$;
