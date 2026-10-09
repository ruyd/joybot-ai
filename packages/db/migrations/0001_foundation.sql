-- Extensions, schemas and database roles.
-- Login + passwords for the app roles are set outside migrations (bootstrap step / Secrets Manager).

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'joybot_app') THEN
    CREATE ROLE joybot_app NOLOGIN;      -- API: back-office + chat writes, subject to RLS
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'joybot_reader') THEN
    CREATE ROLE joybot_reader NOLOGIN;   -- chat retrieval tools: SELECT only, subject to RLS
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'joybot_worker') THEN
    CREATE ROLE joybot_worker NOLOGIN;   -- worker / Cognito triggers / Stripe sync: system principal
  END IF;
END $$;

CREATE SCHEMA core;   -- business data (source of truth)
CREATE SCHEMA app;    -- chat & platform data
CREATE SCHEMA authz;  -- access-control functions used by RLS policies

GRANT USAGE ON SCHEMA core, app, authz TO joybot_app, joybot_reader, joybot_worker;

-- Shared helpers ----------------------------------------------------------

CREATE FUNCTION core.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Validates IANA time zone names on any column passed as trigger argument.
CREATE FUNCTION core.assert_time_zone() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  col text;
  tz  text;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    tz := to_jsonb(NEW) ->> col;
    IF tz IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = tz) THEN
      RAISE EXCEPTION 'invalid time zone "%" in %.%', tz, TG_TABLE_NAME, col
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
