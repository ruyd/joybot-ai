-- Chat & platform tables (plan.md §4.6).

CREATE TABLE app.conversations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_type         text NOT NULL CHECK (principal_type IN ('employee', 'customer')),
  principal_id           uuid NOT NULL,
  title                  text,
  active_customer_id     uuid REFERENCES core.customers(id),
  active_organization_id uuid REFERENCES core.organizations(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_principal ON app.conversations (principal_type, principal_id, updated_at DESC);

CREATE TABLE app.messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES app.conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text NOT NULL,
  citations       jsonb NOT NULL DEFAULT '[]',
  tokens_in       int,
  tokens_out      int,
  latency_ms      int,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation ON app.messages (conversation_id, created_at);

CREATE TABLE app.retrieval_traces (
  id              bigserial PRIMARY KEY,
  message_id      uuid REFERENCES app.messages(id) ON DELETE SET NULL,
  principal_type  text NOT NULL,
  principal_id    uuid NOT NULL,
  customer_id     uuid,
  organization_id uuid,
  tool            text NOT NULL,
  params          jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL CHECK (status IN ('ok', 'empty', 'denied', 'error', 'timeout')),
  latency_ms      int,
  record_ids      text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retrieval_traces_customer ON app.retrieval_traces (customer_id, created_at DESC);

CREATE TABLE app.stripe_events (
  event_id     text PRIMARY KEY,
  type         text NOT NULL,
  livemode     boolean NOT NULL,
  created      timestamptz NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  status       text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  error        text
);
CREATE INDEX stripe_events_pending ON app.stripe_events (created) WHERE status = 'received';

CREATE TABLE app.invites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash      text NOT NULL UNIQUE,
  customer_id     uuid REFERENCES core.customers(id),
  organization_id uuid REFERENCES core.organizations(id),
  org_role        text CHECK (org_role IN ('member', 'org_admin')),
  channel         text NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  sent_to_hash    text NOT NULL,
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  created_by_type text NOT NULL CHECK (created_by_type IN ('employee', 'customer')),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.link_review_queue (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cognito_sub           text NOT NULL,
  contact_hash          text NOT NULL,
  candidate_customer_id uuid REFERENCES core.customers(id),
  reason                text NOT NULL,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'linked', 'rejected')),
  resolved_by           uuid REFERENCES core.users(id),
  resolved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.message_deliveries (
  id                  bigserial PRIMARY KEY,
  channel             text NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  template            text NOT NULL,
  to_hash             text NOT NULL,
  status              text NOT NULL,
  provider_message_id text,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.response_cache (
  key                  text PRIMARY KEY,
  tool                 text NOT NULL,
  principal_scope_hash text NOT NULL,
  payload              jsonb NOT NULL,
  expires_at           timestamptz NOT NULL
);

CREATE TRIGGER touch_updated_at BEFORE UPDATE ON app.conversations
  FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO joybot_app, joybot_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA app TO joybot_reader;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA app TO joybot_app, joybot_worker;

-- Conversations and messages belong to their principal.
ALTER TABLE app.conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY own ON app.conversations TO joybot_app, joybot_reader
  USING (principal_type = authz.principal_type() AND principal_id = authz.principal_id())
  WITH CHECK (principal_type = authz.principal_type() AND principal_id = authz.principal_id());
CREATE POLICY worker_all ON app.conversations TO joybot_worker USING (true) WITH CHECK (true);

ALTER TABLE app.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY own ON app.messages TO joybot_app, joybot_reader
  USING (EXISTS (SELECT 1 FROM app.conversations c WHERE c.id = conversation_id))
  WITH CHECK (EXISTS (SELECT 1 FROM app.conversations c WHERE c.id = conversation_id));
CREATE POLICY worker_all ON app.messages TO joybot_worker USING (true) WITH CHECK (true);
