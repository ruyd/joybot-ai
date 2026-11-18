-- Settings › AI: two Redis deliveries beside the Postgres queue. 'bullmq' (a BullMQ queue: retries with
-- backoff, priorities) replaces the placeholder 'redis', and 'redis_streams' adds a Redis Stream read by
-- a consumer group. Jobs stay rows in app.ai_jobs whatever carries them: Redis only holds job ids, so
-- inputs, results and access stay in Postgres under RLS.
ALTER TABLE core.ai_slots DROP CONSTRAINT ai_slots_transport_check;
UPDATE core.ai_slots SET transport = 'bullmq' WHERE transport = 'redis';
ALTER TABLE core.ai_slots ADD CONSTRAINT ai_slots_transport_check
  CHECK (transport IN ('direct', 'postgres', 'bullmq', 'redis_streams', 'sqs', 'durable_objects'));

ALTER TABLE app.ai_jobs
  ADD COLUMN transport     text NOT NULL DEFAULT 'postgres' CHECK (transport IN ('postgres', 'bullmq', 'redis_streams')),
  -- When the job's id was handed to Redis; NULL means not yet (or lost), and the worker hands it over again.
  ADD COLUMN dispatched_at timestamptz;
CREATE INDEX ai_jobs_redis_due ON app.ai_jobs (run_after) WHERE status = 'queued' AND transport <> 'postgres';

-- As in 0059, now for any queued delivery: the job remembers how it travels.
CREATE OR REPLACE FUNCTION authz.enqueue_ai_job(p_capability text, p_input jsonb, p_priority smallint DEFAULT 0, p_max_attempts int DEFAULT 3)
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
  IF v_slot.transport NOT IN ('postgres', 'bullmq', 'redis_streams') THEN
    RAISE EXCEPTION '% is delivered %, not through a queue', p_capability, v_slot.transport USING ERRCODE = 'check_violation';
  END IF;
  IF NOT v_slot.active OR v_slot.model_id IS NULL THEN
    RAISE EXCEPTION '% is off or has no model', p_capability USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO app.ai_jobs (capability, input, audience, priority, max_attempts, requested_type, requested_by, transport)
  VALUES (p_capability, p_input,
          CASE WHEN v_type = 'employee' AND authz.can('settings', 'update') THEN 'admin' ELSE v_type END,
          coalesce(p_priority, 0), coalesce(p_max_attempts, 3), v_type, authz.principal_id(), v_slot.transport)
  RETURNING id INTO v_id;
  IF v_slot.transport = 'postgres' THEN
    PERFORM pg_notify('ai_jobs', p_capability);
  END IF;
  RETURN v_id;
END $$;

-- Retrying hands the job to its delivery again (dispatched_at cleared).
CREATE OR REPLACE FUNCTION authz.ai_job_action(p_job uuid, p_action text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_status text;
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'employee' OR NOT authz.can('settings', 'update') THEN
    RAISE EXCEPTION 'not allowed to change AI jobs' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_action = 'retry' THEN
    UPDATE app.ai_jobs SET status = 'queued', attempts = 0, run_after = now(), error = NULL, result = NULL,
                           locked_until = NULL, locked_by = NULL, finished_at = NULL, dispatched_at = NULL
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

-- The API marks a job it handed to Redis (its requester, or an admin); the worker's sweep skips it then.
CREATE FUNCTION authz.ai_job_dispatched(p_job uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE app.ai_jobs SET dispatched_at = now()
   WHERE id = p_job AND transport <> 'postgres' AND status = 'queued'
     AND ((requested_type = authz.principal_type() AND requested_by = authz.principal_id())
          OR (authz.principal_type() = 'employee' AND authz.can('settings', 'update')))
$$;
REVOKE ALL ON FUNCTION authz.ai_job_dispatched(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.ai_job_dispatched(uuid) TO joybot_app;
