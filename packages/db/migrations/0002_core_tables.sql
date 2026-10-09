-- Core business tables (source of truth). See plan.md §4.1.

CREATE SEQUENCE core.customer_number_seq START 10001;
CREATE SEQUENCE core.org_number_seq START 1;
CREATE SEQUENCE core.employee_number_seq START 1;
CREATE SEQUENCE core.appointment_number_seq START 1;
CREATE SEQUENCE core.payment_number_seq START 1;

CREATE TABLE core.locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  address     jsonb,
  phone       text,
  time_zone   text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Employees
CREATE TABLE core.users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cognito_sub      text UNIQUE,
  employee_number  text NOT NULL UNIQUE
                   DEFAULT 'E-' || lpad(nextval('core.employee_number_seq')::text, 4, '0'),
  first_name       text NOT NULL,
  last_name        text NOT NULL,
  email            citext NOT NULL UNIQUE,
  phone            text,
  role             text NOT NULL CHECK (role IN ('admin', 'staff')),
  home_location_id uuid REFERENCES core.locations(id),
  time_zone        text,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.user_locations (
  user_id     uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES core.locations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, location_id)
);
CREATE INDEX ON core.user_locations (location_id);

-- General settings (single row)
CREATE TABLE core.settings (
  id                         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  business_name              text,
  default_time_zone          text NOT NULL,
  default_currency           char(3) NOT NULL CHECK (default_currency ~ '^[A-Z]{3}$'),
  default_locale             text NOT NULL DEFAULT 'en-US',
  chat_retention_days        int NOT NULL DEFAULT 365 CHECK (chat_retention_days > 0),
  whatsapp_enabled           boolean NOT NULL DEFAULT false,
  whatsapp_phone_number_id   text,
  whatsapp_display_number    text,
  whatsapp_otp_template      text,
  whatsapp_invite_template   text,
  whatsapp_template_language text NOT NULL DEFAULT 'en_US',
  freshdesk_domain           text,
  freshdesk_portal_url       text,
  stripe_enabled             boolean NOT NULL DEFAULT false,
  manual_payment_methods     text[] NOT NULL DEFAULT '{card_pos,bank_transfer,cash}',
  bank_transfer_due_days     int NOT NULL DEFAULT 5 CHECK (bank_transfer_due_days > 0),
  updated_by                 uuid REFERENCES core.users(id),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT whatsapp_enabled OR (whatsapp_phone_number_id IS NOT NULL AND whatsapp_otp_template IS NOT NULL)),
  CHECK (manual_payment_methods <@ ARRAY['card_pos', 'bank_transfer', 'cash', 'other'])
);

CREATE TABLE core.organizations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_number     text NOT NULL UNIQUE
                 DEFAULT 'O-' || lpad(nextval('core.org_number_seq')::text, 5, '0'),
  name           text NOT NULL,
  legal_name     text,
  tax_id         text,
  email          citext,
  phone          text,
  address        jsonb,
  restricted     boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  notes_internal text,
  created_by     uuid REFERENCES core.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organizations_name_trgm ON core.organizations USING gin (name gin_trgm_ops);
CREATE INDEX organizations_legal_name_trgm ON core.organizations USING gin (legal_name gin_trgm_ops);

-- Customers: one person per record, populated incrementally
CREATE TABLE core.customers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_number       text NOT NULL UNIQUE
                        DEFAULT 'C-' || nextval('core.customer_number_seq')::text,
  cognito_sub           text UNIQUE,
  organization_id       uuid REFERENCES core.organizations(id),
  org_role              text CHECK (org_role IN ('member', 'org_admin')),
  first_name            text,
  last_name             text,
  email                 citext,
  email_verified        boolean NOT NULL DEFAULT false,
  phone                 text CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),   -- E.164
  phone_verified        boolean NOT NULL DEFAULT false,
  whatsapp_opt_in_at    timestamptz,
  time_zone             text,
  preferred_location_id uuid REFERENCES core.locations(id),
  date_of_birth         date,
  address               jsonb,
  stripe_customer_id    text UNIQUE,
  restricted            boolean NOT NULL DEFAULT false,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'blocked')),
  source                text NOT NULL CHECK (source IN ('employee', 'self_signup')),
  profile_completed_at  timestamptz,
  preferred_employee_id uuid REFERENCES core.users(id),
  notes_internal        text,
  created_by            uuid REFERENCES core.users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL),
  CHECK ((organization_id IS NULL) = (org_role IS NULL)),
  CHECK (NOT email_verified OR email IS NOT NULL),
  CHECK (NOT phone_verified OR phone IS NOT NULL)
);
CREATE UNIQUE INDEX customers_email_unique ON core.customers (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX customers_phone_unique ON core.customers (phone) WHERE phone IS NOT NULL;
CREATE INDEX customers_org ON core.customers (organization_id, org_role);
CREATE INDEX customers_preferred_location ON core.customers (preferred_location_id);
CREATE INDEX customers_name_trgm ON core.customers
  USING gin ((coalesce(first_name, '') || ' ' || coalesce(last_name, '')) gin_trgm_ops);

-- Services: generic price list
CREATE TABLE core.services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,
  name             text NOT NULL,
  description      text,
  category         text,
  duration_minutes int CHECK (duration_minutes > 0),
  price            numeric(12, 2) NOT NULL CHECK (price >= 0),
  currency         char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.appointments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_number text NOT NULL UNIQUE
                     DEFAULT 'A-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('core.appointment_number_seq')::text, 6, '0'),
  customer_id        uuid NOT NULL REFERENCES core.customers(id),
  service_id         uuid NOT NULL REFERENCES core.services(id),
  employee_id        uuid REFERENCES core.users(id),
  location_id        uuid NOT NULL REFERENCES core.locations(id),
  scheduled_start    timestamptz NOT NULL,
  scheduled_end      timestamptz NOT NULL,
  status             text NOT NULL DEFAULT 'scheduled'
                     CHECK (status IN ('scheduled', 'confirmed', 'completed', 'cancelled', 'no_show')),
  price_quoted       numeric(12, 2) NOT NULL CHECK (price_quoted >= 0),
  currency           char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  notes_customer     text,
  notes_internal     text,
  created_by         uuid REFERENCES core.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (scheduled_end > scheduled_start)
);
CREATE INDEX appointments_customer ON core.appointments (customer_id, scheduled_start DESC);
CREATE INDEX appointments_employee ON core.appointments (employee_id, scheduled_start);
CREATE INDEX appointments_location ON core.appointments (location_id, scheduled_start);

-- Payments: Stripe-synced and manual in one table (plan.md §4.4)
CREATE TABLE core.payments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_number           text NOT NULL UNIQUE
                           DEFAULT 'P-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('core.payment_number_seq')::text, 6, '0'),
  source                   text NOT NULL CHECK (source IN ('stripe', 'manual')),
  customer_id              uuid REFERENCES core.customers(id),
  appointment_id           uuid REFERENCES core.appointments(id),
  location_id              uuid REFERENCES core.locations(id),
  amount                   numeric(12, 2) NOT NULL CHECK (amount > 0),
  amount_refunded          numeric(12, 2) NOT NULL DEFAULT 0,
  currency                 char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  method                   text NOT NULL
                           CHECK (method IN ('card_online', 'card_pos', 'bank_transfer', 'cash', 'wallet', 'other')),
  status                   text NOT NULL
                           CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'canceled',
                                             'voided', 'refunded', 'partially_refunded', 'disputed')),
  stripe_payment_intent_id text UNIQUE,
  stripe_charge_id         text UNIQUE,
  stripe_invoice_id        text,
  failure_reason           text,
  receipt_url              text,
  pos_terminal_id          text,
  pos_reference            text,
  bank_reference           text,
  expected_at              date,
  card_brand               text,
  card_last4               char(4) CHECK (card_last4 ~ '^[0-9]{4}$'),
  paid_at                  timestamptz,
  recorded_by              uuid REFERENCES core.users(id),
  void_reason              text,
  voided_by                uuid REFERENCES core.users(id),
  voided_at                timestamptz,
  possible_duplicate_of    uuid REFERENCES core.payments(id),
  notes_internal           text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_refunded >= 0 AND amount_refunded <= amount),
  CHECK (source <> 'manual' OR (recorded_by IS NOT NULL AND customer_id IS NOT NULL)),
  CHECK (source <> 'manual' OR method IN ('card_pos', 'bank_transfer', 'cash', 'other')),
  CHECK (source <> 'manual' OR method <> 'card_pos' OR pos_reference IS NOT NULL),
  CHECK (source <> 'manual' OR method <> 'bank_transfer' OR status IN ('pending', 'voided') OR bank_reference IS NOT NULL),
  CHECK (status <> 'voided' OR (void_reason IS NOT NULL AND voided_by IS NOT NULL AND voided_at IS NOT NULL)),
  CHECK (source <> 'stripe' OR stripe_payment_intent_id IS NOT NULL OR stripe_charge_id IS NOT NULL)
);
CREATE INDEX payments_customer ON core.payments (customer_id, paid_at DESC);
CREATE INDEX payments_appointment ON core.payments (appointment_id);
CREATE INDEX payments_pending ON core.payments (status) WHERE status = 'pending';
CREATE INDEX payments_source ON core.payments (source, created_at);
CREATE INDEX payments_duplicate_probe ON core.payments (customer_id, amount, paid_at);
CREATE UNIQUE INDEX payments_pos_reference_unique ON core.payments (coalesce(pos_terminal_id, ''), pos_reference)
  WHERE pos_reference IS NOT NULL;
CREATE UNIQUE INDEX payments_bank_reference_unique ON core.payments (bank_reference, customer_id)
  WHERE bank_reference IS NOT NULL;

-- Cached links to external systems (e.g. Freshdesk contact IDs found by email/phone)
CREATE TABLE core.external_links (
  entity_type  text NOT NULL CHECK (entity_type IN ('customer', 'organization')),
  entity_id    uuid NOT NULL,
  source       text NOT NULL,
  external_id  text NOT NULL,
  matched_by   text CHECK (matched_by IN ('email', 'phone', 'manual')),
  excluded     boolean NOT NULL DEFAULT false,   -- staff can exclude a wrong match
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id, source, external_id)
);

-- Triggers ------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['locations', 'users', 'settings', 'organizations', 'customers',
                           'services', 'appointments', 'payments'] LOOP
    EXECUTE format('CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.%I
                    FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at()', t);
  END LOOP;
END $$;

CREATE TRIGGER assert_tz BEFORE INSERT OR UPDATE ON core.settings
  FOR EACH ROW EXECUTE FUNCTION core.assert_time_zone('default_time_zone');
CREATE TRIGGER assert_tz BEFORE INSERT OR UPDATE ON core.locations
  FOR EACH ROW EXECUTE FUNCTION core.assert_time_zone('time_zone');
CREATE TRIGGER assert_tz BEFORE INSERT OR UPDATE ON core.users
  FOR EACH ROW EXECUTE FUNCTION core.assert_time_zone('time_zone');
CREATE TRIGGER assert_tz BEFORE INSERT OR UPDATE ON core.customers
  FOR EACH ROW EXECUTE FUNCTION core.assert_time_zone('time_zone');
