-- Knowledge for the assistant, and customer self-booking.
--
-- 1. Saved answers (core.answers): approved replies with example questions and optional actions
--    (book a service, read an article). Chat looks them up for every question and cites them.
-- 2. Articles (core.articles) written in JoyBot, split into sections (core.article_sections) that
--    chat searches by passage. Customers and staff read them on the Help pages.
--    Both have an audience: 'customer', 'employee' or 'all'. Editing needs the new 'knowledge'
--    permission (admin by default); everyone reads what is meant for them once active/published.
-- 3. Self-booking: customers request appointments through authz.request_appointment. Requests are
--    ordinary 'scheduled' appointments marked requested_by_customer; staff confirm or decline them
--    on the Review page (reviewed_at / reviewed_by).

-- Permissions -------------------------------------------------------------------------------------

ALTER TABLE core.role_permissions DROP CONSTRAINT role_permissions_resource_check;
ALTER TABLE core.role_permissions ADD CONSTRAINT role_permissions_resource_check
  CHECK (resource IN ('customers', 'organizations', 'appointments', 'payments', 'services', 'locations',
                      'tickets', 'users', 'settings', 'audit', 'notes_internal', 'access', 'tasks', 'knowledge'));

INSERT INTO core.role_permissions (role, resource, action, scope) VALUES
  ('admin', 'knowledge', 'read', 'all'), ('admin', 'knowledge', 'create', 'all'),
  ('admin', 'knowledge', 'update', 'all'), ('admin', 'knowledge', 'delete', 'all'),
  ('staff', 'knowledge', 'read', 'all'),
  ('org_admin', 'knowledge', 'read', 'all'),
  ('customer', 'knowledge', 'read', 'all');

-- Readable when meant for the principal's audience and live, or by anyone who edits knowledge.
CREATE FUNCTION authz.knowledge_visible(p_audience text, p_live boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN authz.principal_type() = 'employee' AND authz.can('knowledge', 'update') THEN true
    WHEN NOT p_live OR NOT authz.can('knowledge', 'read') THEN false
    WHEN authz.principal_type() = 'employee' THEN p_audience IN ('employee', 'all')
    WHEN authz.principal_type() = 'customer' THEN p_audience IN ('customer', 'all')
    ELSE false
  END
$$;
REVOKE ALL ON FUNCTION authz.knowledge_visible(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.knowledge_visible(text, boolean) TO joybot_app, joybot_reader;

-- Articles ----------------------------------------------------------------------------------------

CREATE TABLE core.articles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  title      text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  summary    text CHECK (length(summary) <= 500),
  body       text NOT NULL DEFAULT '' CHECK (length(body) <= 100000),
  audience   text NOT NULL DEFAULT 'all' CHECK (audience IN ('customer', 'employee', 'all')),
  published  boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES core.users(id),
  updated_by uuid REFERENCES core.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Passages for search, rewritten by the API whenever the article body changes.
CREATE TABLE core.article_sections (
  article_id uuid NOT NULL REFERENCES core.articles(id) ON DELETE CASCADE,
  position   int NOT NULL CHECK (position >= 0),
  heading    text,
  body       text NOT NULL,
  search     tsvector NOT NULL DEFAULT ''::tsvector,
  PRIMARY KEY (article_id, position)
);
CREATE INDEX article_sections_search ON core.article_sections USING gin (search);

CREATE FUNCTION core.article_section_search() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search := setweight(to_tsvector('english', coalesce((SELECT a.title FROM core.articles a WHERE a.id = NEW.article_id), '')), 'B')
             || setweight(to_tsvector('english', coalesce(NEW.heading, '')), 'A')
             || setweight(to_tsvector('english', NEW.body), 'C');
  RETURN NEW;
END $$;
CREATE TRIGGER search BEFORE INSERT OR UPDATE ON core.article_sections
  FOR EACH ROW EXECUTE FUNCTION core.article_section_search();

-- Saved answers -----------------------------------------------------------------------------------

CREATE TABLE core.answers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  questions  text[] NOT NULL DEFAULT '{}' CHECK (cardinality(questions) <= 30),
  body       text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
  -- [{ "type": "book", "service_id": uuid|null, "label"?: text } | { "type": "article", "article_id": uuid, "label"?: text }]
  actions    jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(actions) = 'array' AND jsonb_array_length(actions) <= 4),
  audience   text NOT NULL DEFAULT 'all' CHECK (audience IN ('customer', 'employee', 'all')),
  active     boolean NOT NULL DEFAULT true,
  search     tsvector NOT NULL DEFAULT ''::tsvector,
  questions_text text NOT NULL DEFAULT '',
  created_by uuid REFERENCES core.users(id),
  updated_by uuid REFERENCES core.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX answers_search ON core.answers USING gin (search);
CREATE INDEX answers_questions_trgm ON core.answers USING gin (questions_text gin_trgm_ops);

CREATE FUNCTION core.answer_search() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.questions_text := lower(array_to_string(NEW.questions, ' | '));
  -- Matched on what it answers (title, example questions), not on words that happen to be in the body.
  NEW.search := setweight(to_tsvector('english', NEW.title), 'A')
             || setweight(to_tsvector('english', NEW.questions_text), 'A');
  RETURN NEW;
END $$;
CREATE TRIGGER search BEFORE INSERT OR UPDATE ON core.answers
  FOR EACH ROW EXECUTE FUNCTION core.answer_search();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['articles', 'answers'] LOOP
    EXECUTE format('CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.%I
                    FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at()', t);
    EXECUTE format('CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.%I
                    FOR EACH ROW EXECUTE FUNCTION core.audit_row()', t);
  END LOOP;
END $$;

-- RLS ---------------------------------------------------------------------------------------------

ALTER TABLE core.articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.article_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.answers ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON core.articles, core.article_sections, core.answers TO joybot_app, joybot_reader;
GRANT INSERT, UPDATE, DELETE ON core.articles, core.article_sections, core.answers TO joybot_app;

CREATE POLICY sel ON core.articles FOR SELECT TO joybot_app, joybot_reader
  USING (authz.knowledge_visible(audience, published));
CREATE POLICY sel ON core.article_sections FOR SELECT TO joybot_app, joybot_reader
  USING (EXISTS (SELECT 1 FROM core.articles a WHERE a.id = article_id));
CREATE POLICY sel ON core.answers FOR SELECT TO joybot_app, joybot_reader
  USING (authz.knowledge_visible(audience, active));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['articles', 'answers'] LOOP
    EXECUTE format('CREATE POLICY ins ON core.%I FOR INSERT TO joybot_app
                    WITH CHECK (authz.principal_type() = ''employee'' AND authz.can(''knowledge'', ''create''))', t);
    EXECUTE format('CREATE POLICY upd ON core.%I FOR UPDATE TO joybot_app
                    USING (authz.principal_type() = ''employee'' AND authz.can(''knowledge'', ''update''))
                    WITH CHECK (authz.principal_type() = ''employee'' AND authz.can(''knowledge'', ''update''))', t);
    EXECUTE format('CREATE POLICY del ON core.%I FOR DELETE TO joybot_app
                    USING (authz.principal_type() = ''employee'' AND authz.can(''knowledge'', ''delete''))', t);
  END LOOP;
END $$;
-- Sections are rewritten with their article (create or update).
CREATE POLICY write ON core.article_sections FOR ALL TO joybot_app
  USING (authz.principal_type() = 'employee' AND (authz.can('knowledge', 'create') OR authz.can('knowledge', 'update')))
  WITH CHECK (authz.principal_type() = 'employee' AND (authz.can('knowledge', 'create') OR authz.can('knowledge', 'update')));

-- Chat: buttons offered with an answer (book, read an article), kept with the message.
ALTER TABLE app.messages ADD COLUMN actions jsonb NOT NULL DEFAULT '[]';

-- Self-booking ------------------------------------------------------------------------------------

ALTER TABLE core.appointments
  ADD COLUMN requested_by_customer boolean NOT NULL DEFAULT false,
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN reviewed_by uuid REFERENCES core.users(id),
  ADD CONSTRAINT appointments_review_check CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL));
CREATE INDEX appointments_requests_open ON core.appointments (scheduled_start)
  WHERE requested_by_customer AND reviewed_at IS NULL;

/**
 * A customer asks for an appointment for themselves: an active service with a set duration, at an
 * active location, from one hour to 180 days ahead, not overlapping their own active appointments,
 * and at most three requests waiting for review. Staff confirm or decline it on the Review page.
 */
CREATE FUNCTION authz.request_appointment(p_service uuid, p_location uuid, p_start timestamptz, p_notes text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_customer uuid := authz.principal_id();
  v_service  record;
  v_end      timestamptz;
  v_id       uuid;
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'customer'
     OR NOT EXISTS (SELECT 1 FROM core.customers WHERE id = v_customer AND status = 'active') THEN
    RAISE EXCEPTION 'only active customers request appointments' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT duration_minutes, price, currency INTO v_service FROM core.services WHERE id = p_service AND active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown service' USING ERRCODE = 'check_violation';
  END IF;
  IF v_service.duration_minutes IS NULL THEN
    RAISE EXCEPTION 'this service cannot be booked online' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.locations WHERE id = p_location AND active) THEN
    RAISE EXCEPTION 'unknown location' USING ERRCODE = 'check_violation';
  END IF;
  IF p_start < now() + interval '1 hour' OR p_start > now() + interval '180 days' THEN
    RAISE EXCEPTION 'choose a time between one hour and 180 days from now' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM core.appointments
       WHERE customer_id = v_customer AND requested_by_customer AND reviewed_at IS NULL
         AND status = 'scheduled' AND scheduled_start > now()) >= 3 THEN
    RAISE EXCEPTION 'you already have three requests waiting for confirmation' USING ERRCODE = 'check_violation';
  END IF;
  v_end := p_start + make_interval(mins => v_service.duration_minutes);
  IF EXISTS (SELECT 1 FROM core.appointments
              WHERE customer_id = v_customer AND status IN ('scheduled', 'confirmed')
                AND scheduled_start < v_end AND scheduled_end > p_start) THEN
    RAISE EXCEPTION 'you already have an appointment at that time' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO core.appointments (customer_id, service_id, location_id, scheduled_start, scheduled_end,
                                 price_quoted, currency, notes_customer, requested_by_customer)
  VALUES (v_customer, p_service, p_location, p_start, v_end, v_service.price, v_service.currency,
          nullif(btrim(p_notes), ''), true)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- The customer withdraws a request staff have not reviewed yet.
CREATE FUNCTION authz.withdraw_appointment_request(p_id uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH upd AS (
    UPDATE core.appointments SET status = 'cancelled'
     WHERE id = p_id AND authz.principal_type() = 'customer' AND customer_id = authz.principal_id()
       AND requested_by_customer AND reviewed_at IS NULL AND status = 'scheduled'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM upd)
$$;

REVOKE ALL ON FUNCTION authz.request_appointment(uuid, uuid, timestamptz, text), authz.withdraw_appointment_request(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.request_appointment(uuid, uuid, timestamptz, text), authz.withdraw_appointment_request(uuid) TO joybot_app;
