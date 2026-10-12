-- Native support tickets (replacing the Freshdesk integration).
--
-- A ticket belongs to a customer (the requester) and has a number (#1001, …), a subject, a status,
-- a priority and optionally an assigned employee. Its conversation is core.ticket_messages: replies
-- from the customer or staff, and internal notes that only staff who may read the customer's private
-- notes see. Customers open tickets in the portal (staff can open one on a customer's behalf),
-- reply, and mark them resolved; staff reply, add notes, assign, prioritize and change the status.
--
-- Status follows the conversation: a customer's message (re)opens the ticket ('open': waiting on
-- staff); a staff reply to an open ticket makes it 'pending' (waiting on the customer). 'resolved'
-- and 'closed' are set by people; resolved_at follows.
--
-- Access uses the existing 'tickets' resource, which gains create and update: customers (and org
-- admins) for themselves, staff in their usual scopes, admins for everyone. Org admins keep reading
-- their organization's tickets.

-- Freshdesk goes ----------------------------------------------------------------------------------

DROP FUNCTION authz.freshdesk_contacts(uuid);
DROP FUNCTION authz.cache_freshdesk_contacts(uuid, text[], text[]);
DROP FUNCTION authz.customer_for_freshdesk_contact(text);
DELETE FROM core.external_links WHERE source = 'freshdesk_contact';
ALTER TABLE core.settings DROP COLUMN freshdesk_domain, DROP COLUMN freshdesk_portal_url;

-- Permissions -------------------------------------------------------------------------------------

INSERT INTO core.role_permissions (role, resource, action, scope) VALUES
  ('admin', 'tickets', 'create', 'all_including_restricted'),
  ('admin', 'tickets', 'update', 'all_including_restricted'),
  ('staff', 'tickets', 'create', 'location'), ('staff', 'tickets', 'create', 'assigned'), ('staff', 'tickets', 'create', 'own'),
  ('staff', 'tickets', 'update', 'location'), ('staff', 'tickets', 'update', 'assigned'), ('staff', 'tickets', 'update', 'own'),
  ('org_admin', 'tickets', 'create', 'self'), ('org_admin', 'tickets', 'update', 'self'),
  ('customer', 'tickets', 'create', 'self'), ('customer', 'tickets', 'update', 'self')
ON CONFLICT DO NOTHING;

-- Tables ------------------------------------------------------------------------------------------

CREATE SEQUENCE core.ticket_number_seq START 1001;

CREATE TABLE core.tickets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number              int NOT NULL UNIQUE DEFAULT nextval('core.ticket_number_seq'),
  customer_id         uuid NOT NULL REFERENCES core.customers(id),
  subject             text NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 200),
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
  priority            text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  assigned_to         uuid REFERENCES core.users(id),
  created_by_customer uuid REFERENCES core.customers(id),
  created_by_user     uuid REFERENCES core.users(id),
  last_message_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((created_by_customer IS NULL) <> (created_by_user IS NULL))
);
ALTER SEQUENCE core.ticket_number_seq OWNED BY core.tickets.number;
CREATE INDEX tickets_customer ON core.tickets (customer_id, last_message_at DESC);
CREATE INDEX tickets_status ON core.tickets (status, last_message_at DESC);
CREATE INDEX tickets_assigned ON core.tickets (assigned_to, status) WHERE assigned_to IS NOT NULL;

CREATE TABLE core.ticket_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id        uuid NOT NULL REFERENCES core.tickets(id) ON DELETE CASCADE,
  body             text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 10000),
  author_customer  uuid REFERENCES core.customers(id),
  author_user      uuid REFERENCES core.users(id),
  -- Staff-only note (never shown to the customer).
  internal         boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((author_customer IS NULL) <> (author_user IS NULL)),
  CHECK (NOT internal OR author_user IS NOT NULL)
);
CREATE INDEX ticket_messages_ticket ON core.ticket_messages (ticket_id, created_at);

CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.tickets FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.tickets FOR EACH ROW EXECUTE FUNCTION core.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.ticket_messages FOR EACH ROW EXECUTE FUNCTION core.audit_row();

-- Rules -------------------------------------------------------------------------------------------

-- Customers change only a ticket's status (the API lets them resolve or close it; their messages
-- reopen it); subject, priority, assignee and requester are for staff. resolved_at follows status.
CREATE FUNCTION core.ticket_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.principal_type() = 'customer'
     AND (NEW.customer_id, NEW.subject, NEW.priority, NEW.assigned_to) IS DISTINCT FROM (OLD.customer_id, OLD.subject, OLD.priority, OLD.assigned_to) THEN
    RAISE EXCEPTION 'customers can only resolve or close their tickets' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IN ('resolved', 'closed') AND OLD.status NOT IN ('resolved', 'closed') THEN
    NEW.resolved_at := now();
  ELSIF NEW.status IN ('open', 'pending') THEN
    NEW.resolved_at := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ticket_guard BEFORE UPDATE ON core.tickets FOR EACH ROW EXECUTE FUNCTION core.ticket_guard();

-- A message moves the ticket along: customer → open (reopening it), staff reply to an open ticket →
-- pending. Internal notes change nothing but the activity time.
CREATE FUNCTION core.ticket_message_added() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE core.tickets SET
    last_message_at = NEW.created_at,
    status = CASE
               WHEN NEW.internal THEN status
               WHEN NEW.author_customer IS NOT NULL THEN 'open'
               WHEN status = 'open' THEN 'pending'
               ELSE status
             END
  WHERE id = NEW.ticket_id;
  RETURN NULL;
END $$;
CREATE TRIGGER ticket_message_added AFTER INSERT ON core.ticket_messages FOR EACH ROW EXECUTE FUNCTION core.ticket_message_added();

-- Customer merges move tickets to the surviving customer.
CREATE FUNCTION core.move_tickets_on_merge() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE core.tickets SET customer_id = NEW.merged_into WHERE customer_id = NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER move_tickets_on_merge AFTER UPDATE OF merged_into ON core.customers
  FOR EACH ROW WHEN (NEW.merged_into IS NOT NULL AND OLD.merged_into IS DISTINCT FROM NEW.merged_into)
  EXECUTE FUNCTION core.move_tickets_on_merge();

-- Access ------------------------------------------------------------------------------------------

ALTER TABLE core.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.ticket_messages ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON core.tickets TO joybot_app;
GRANT SELECT, INSERT ON core.ticket_messages TO joybot_app;
GRANT SELECT ON core.tickets, core.ticket_messages TO joybot_reader;
GRANT USAGE ON SEQUENCE core.ticket_number_seq TO joybot_app;

CREATE POLICY sel ON core.tickets FOR SELECT TO joybot_app, joybot_reader
  USING (authz.customer_in_scope(customer_id, 'tickets', 'read'));
CREATE POLICY ins ON core.tickets FOR INSERT TO joybot_app
  WITH CHECK (authz.customer_in_scope(customer_id, 'tickets', 'create')
              AND CASE authz.principal_type()
                    WHEN 'customer' THEN created_by_customer = authz.principal_id() AND assigned_to IS NULL
                    WHEN 'employee' THEN created_by_user = authz.principal_id()
                    ELSE false
                  END);
CREATE POLICY upd ON core.tickets FOR UPDATE TO joybot_app
  USING (authz.customer_in_scope(customer_id, 'tickets', 'update'))
  WITH CHECK (authz.customer_in_scope(customer_id, 'tickets', 'update'));

-- Messages: those of visible tickets; internal notes only for staff who may read the customer's
-- private notes. Writing needs tickets:update on the customer (internal notes: notes_internal:update),
-- as the principal themselves.
CREATE POLICY sel ON core.ticket_messages FOR SELECT TO joybot_app, joybot_reader
  USING (EXISTS (SELECT 1 FROM core.tickets t
                  WHERE t.id = ticket_id
                    AND (NOT internal OR (authz.principal_type() = 'employee' AND authz.customer_in_scope(t.customer_id, 'notes_internal', 'read')))));
CREATE POLICY ins ON core.ticket_messages FOR INSERT TO joybot_app
  WITH CHECK (EXISTS (SELECT 1 FROM core.tickets t
                       WHERE t.id = ticket_id
                         AND authz.customer_in_scope(t.customer_id, 'tickets', 'update')
                         AND (NOT internal OR authz.customer_in_scope(t.customer_id, 'notes_internal', 'update')))
              AND CASE authz.principal_type()
                    WHEN 'customer' THEN author_customer = authz.principal_id() AND NOT internal
                    WHEN 'employee' THEN author_user = authz.principal_id()
                    ELSE false
                  END);
