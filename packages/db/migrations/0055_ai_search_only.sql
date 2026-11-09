-- Settings › AI: "No model — search only" (provider 'none'). Chat lists the records it finds, with
-- links, and sends nothing to a model, even when the server has a default model (MODEL_ENDPOINT).
ALTER TABLE core.ai_settings DROP CONSTRAINT ai_settings_provider_check;
ALTER TABLE core.ai_settings ADD CONSTRAINT ai_settings_provider_check CHECK (provider IN ('openrouter', 'custom', 'none'));

ALTER TABLE core.ai_settings DROP CONSTRAINT ai_settings_model;
ALTER TABLE core.ai_settings ADD CONSTRAINT ai_settings_model CHECK (provider IS NULL OR provider = 'none' OR model IS NOT NULL);
