-- Settings › AI: the Postgres queue. A capability whose delivery is 'postgres' runs as a job here: the
-- API (or a feature) adds a row, NOTIFY wakes the worker, which claims it with FOR UPDATE SKIP LOCKED,
-- calls the slot's model (falling back to its backup) and stores the result. A claim is a lease: a job
-- whose worker died is claimed again once its lease runs out. Failures retry with backoff.
CREATE TABLE app.ai_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capability      text NOT NULL CHECK (capability IN (
    'embeddings', 'reranker', 'speech_to_text', 'vision', 'image_generation', 'video_generation', 'avatar',
    'moderation', 'document_parsing')),
  input           jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object' AND pg_column_size(input) <= 1000000),
  audience        text NOT NULL CHECK (audience IN ('employee', 'customer', 'admin')),
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  priority        smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN -10 AND 10),
  attempts        int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts    int NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  run_after       timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  locked_by       text CHECK (length(locked_by) <= 100),
  model_id        uuid REFERENCES core.ai_models(id) ON DELETE SET NULL,
  model           text CHECK (length(model) <= 200),
  connection_id   uuid REFERENCES core.ai_connections(id) ON DELETE SET NULL,
  result          jsonb,
  error           text CHECK (length(error) <= 300),
  cost_usd        numeric(14, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  ms              int CHECK (ms >= 0),
  requested_type  text NOT NULL CHECK (requested_type IN ('employee', 'customer', 'system')),
  requested_by    uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
-- What the worker picks next: the highest priority, then the oldest that is due.
CREATE INDEX ai_jobs_due ON app.ai_jobs (priority DESC, run_after) WHERE status = 'queued';
-- Leases that ran out (a worker died mid-job).
CREATE INDEX ai_jobs_leases ON app.ai_jobs (locked_until) WHERE status = 'running';
CREATE INDEX ai_jobs_recent ON app.ai_jobs (created_at DESC);

ALTER TABLE app.ai_jobs ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON app.ai_jobs TO joybot_app;
GRANT SELECT, UPDATE, DELETE ON app.ai_jobs TO joybot_worker;
-- Admins see every job; anyone else sees the jobs they asked for.
CREATE POLICY admin_or_own_read ON app.ai_jobs FOR SELECT TO joybot_app
  USING ((authz.principal_type() = 'employee' AND authz.can('settings', 'update'))
         OR (requested_type = authz.principal_type() AND requested_by = authz.principal_id()));
CREATE POLICY worker_all ON app.ai_jobs TO joybot_worker USING (true) WITH CHECK (true);

-- Adds a job for a capability set to the Postgres queue, as the current principal, and wakes the worker.
CREATE FUNCTION authz.enqueue_ai_job(p_capability text, p_input jsonb, p_priority smallint DEFAULT 0, p_max_attempts int DEFAULT 3)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_type text := authz.principal_type();
  v_slot core.ai_slots%ROWTYPE;
  v_id uuid;
BEGIN
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'no principal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_slot FROM core.ai_slots WHERE capability = p_capability;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown capability %', p_capability USING ERRCODE = 'check_violation';
  END IF;
  IF v_slot.transport <> 'postgres' THEN
    RAISE EXCEPTION '% is delivered %, not through the Postgres queue', p_capability, v_slot.transport USING ERRCODE = 'check_violation';
  END IF;
  IF NOT v_slot.active OR v_slot.model_id IS NULL THEN
    RAISE EXCEPTION '% is off or has no model', p_capability USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO app.ai_jobs (capability, input, audience, priority, max_attempts, requested_type, requested_by)
  VALUES (p_capability, p_input,
          CASE WHEN v_type = 'employee' AND authz.can('settings', 'update') THEN 'admin' ELSE v_type END,
          coalesce(p_priority, 0), coalesce(p_max_attempts, 3), v_type, authz.principal_id())
  RETURNING id INTO v_id;
  PERFORM pg_notify('ai_jobs', p_capability);
  RETURN v_id;
END $$;

-- Admins retry a failed or cancelled job, or cancel a queued one.
CREATE FUNCTION authz.ai_job_action(p_job uuid, p_action text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_status text;
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'employee' OR NOT authz.can('settings', 'update') THEN
    RAISE EXCEPTION 'not allowed to change AI jobs' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_action = 'retry' THEN
    UPDATE app.ai_jobs SET status = 'queued', attempts = 0, run_after = now(), error = NULL, result = NULL,
                           locked_until = NULL, locked_by = NULL, finished_at = NULL
     WHERE id = p_job AND status IN ('failed', 'cancelled') RETURNING status INTO v_status;
    IF FOUND THEN PERFORM pg_notify('ai_jobs', 'retry'); END IF;
  ELSIF p_action = 'cancel' THEN
    UPDATE app.ai_jobs SET status = 'cancelled', finished_at = now() WHERE id = p_job AND status = 'queued' RETURNING status INTO v_status;
  ELSE
    RAISE EXCEPTION 'unknown action %', p_action USING ERRCODE = 'check_violation';
  END IF;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'no such job in a state that allows %', p_action USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v_status;
END $$;

REVOKE ALL ON FUNCTION authz.enqueue_ai_job(text, jsonb, smallint, int), authz.ai_job_action(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.enqueue_ai_job(text, jsonb, smallint, int), authz.ai_job_action(uuid, text) TO joybot_app;

-- The worker reads a slot's models and keys and logs calls like the API does.
GRANT EXECUTE ON FUNCTION authz.ai_slot_delivery(text),
  authz.log_ai_call(uuid, uuid, text, text, text, text, int, int, numeric, int, boolean, text) TO joybot_worker;
