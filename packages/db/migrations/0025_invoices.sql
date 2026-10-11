-- Invoices: staff bill a customer (lines of services or anything else), send it, and the customer
-- pays in the portal by card (Stripe Checkout; the worker links the payment through its
-- invoice_number metadata) or by bank transfer (the invoice number as reference; staff record it
-- when it arrives). Payments carry invoice_id; an invoice's paid amount and status follow them.
--
-- Access follows the 'payments' resource: employees read invoices of customers in their payments
-- read scope and bill (create, edit, send, void) those in their payments create scope; customers see their own (and, as org admins, what payments allow) once
-- sent, never drafts.

CREATE SEQUENCE core.invoice_number_seq START 1;

ALTER TABLE core.settings
  ADD COLUMN invoice_due_days int NOT NULL DEFAULT 14 CHECK (invoice_due_days BETWEEN 0 AND 365),
  ADD COLUMN bank_transfer_instructions text CHECK (length(bank_transfer_instructions) <= 2000);

CREATE TABLE core.invoices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number text NOT NULL UNIQUE
                 DEFAULT 'INV-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('core.invoice_number_seq')::text, 6, '0'),
  customer_id    uuid NOT NULL REFERENCES core.customers(id),
  location_id    uuid REFERENCES core.locations(id),
  currency       char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'void')),
  total          numeric(12, 2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  amount_paid    numeric(12, 2) NOT NULL DEFAULT 0,
  due_on         date,
  notes          text CHECK (length(notes) <= 2000), -- shown to the customer
  created_by     uuid NOT NULL REFERENCES core.users(id),
  sent_at        timestamptz,
  paid_at        timestamptz,
  voided_at      timestamptz,
  voided_by      uuid REFERENCES core.users(id),
  void_reason    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'draft' OR sent_at IS NOT NULL),
  CHECK (status <> 'void' OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX invoices_customer ON core.invoices (customer_id, created_at DESC);
CREATE INDEX invoices_open ON core.invoices (status, due_on) WHERE status = 'sent';

CREATE TABLE core.invoice_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     uuid NOT NULL REFERENCES core.invoices(id) ON DELETE CASCADE,
  position       int NOT NULL DEFAULT 0,
  description    text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 300),
  quantity       numeric(10, 2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price     numeric(12, 2) NOT NULL CHECK (unit_price >= 0),
  service_id     uuid REFERENCES core.services(id),
  appointment_id uuid REFERENCES core.appointments(id)
);
CREATE INDEX invoice_lines_invoice ON core.invoice_lines (invoice_id, position);

ALTER TABLE core.payments ADD COLUMN invoice_id uuid REFERENCES core.invoices(id);
CREATE INDEX payments_invoice ON core.payments (invoice_id) WHERE invoice_id IS NOT NULL;

CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.invoices FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.invoices FOR EACH ROW EXECUTE FUNCTION core.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.invoice_lines FOR EACH ROW EXECUTE FUNCTION core.audit_row();

-- Totals and status -----------------------------------------------------------------------------

/** Recomputes total (from lines), amount paid (from payments) and paid/sent status. */
CREATE FUNCTION core.invoice_refresh(p_invoice uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE core.invoices i SET
    total = t.total,
    amount_paid = t.paid,
    status = CASE WHEN i.status IN ('sent', 'paid')
                  THEN CASE WHEN t.total > 0 AND t.paid >= t.total THEN 'paid' ELSE 'sent' END
                  ELSE i.status END,
    paid_at = CASE WHEN i.status IN ('sent', 'paid') AND t.total > 0 AND t.paid >= t.total THEN coalesce(i.paid_at, now()) ELSE NULL END
  FROM (
    SELECT coalesce((SELECT sum(round(l.quantity * l.unit_price, 2)) FROM core.invoice_lines l WHERE l.invoice_id = p_invoice), 0) AS total,
           coalesce((SELECT sum(p.amount - p.amount_refunded) FROM core.payments p
                      WHERE p.invoice_id = p_invoice AND p.status IN ('succeeded', 'partially_refunded')), 0) AS paid
  ) t
  WHERE i.id = p_invoice
    AND (i.total, i.amount_paid, i.status) IS DISTINCT FROM (t.total, t.paid,
         CASE WHEN i.status IN ('sent', 'paid') THEN CASE WHEN t.total > 0 AND t.paid >= t.total THEN 'paid' ELSE 'sent' END ELSE i.status END)
$$;

-- Lines change only while the invoice is a draft (or go with their invoice when it is deleted).
CREATE FUNCTION core.invoice_lines_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_invoice uuid := coalesce(NEW.invoice_id, OLD.invoice_id);
  v_status text := (SELECT status FROM core.invoices WHERE id = v_invoice);
BEGIN
  IF v_status IS NULL THEN RETURN NULL; END IF; -- the invoice itself was deleted
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'only draft invoices can change their lines' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM core.invoice_refresh(v_invoice);
  RETURN NULL;
END $$;
CREATE TRIGGER invoice_totals AFTER INSERT OR UPDATE OR DELETE ON core.invoice_lines
  FOR EACH ROW EXECUTE FUNCTION core.invoice_lines_changed();

-- A payment counts toward an invoice of the same customer only. Stripe payments with a mismatched
-- invoice are kept, just not linked (the worker must not fail on them).
CREATE FUNCTION core.payment_invoice_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_customer uuid;
BEGIN
  IF NEW.invoice_id IS NULL THEN RETURN NEW; END IF;
  SELECT customer_id INTO v_customer FROM core.invoices WHERE id = NEW.invoice_id AND status IN ('sent', 'paid');
  IF v_customer IS NOT NULL AND v_customer = NEW.customer_id THEN RETURN NEW; END IF;
  IF NEW.source = 'stripe' THEN
    NEW.invoice_id := NULL;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the invoice is not an open invoice of this customer' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER payment_invoice_check BEFORE INSERT OR UPDATE OF invoice_id, customer_id ON core.payments
  FOR EACH ROW EXECUTE FUNCTION core.payment_invoice_check();

CREATE FUNCTION core.payment_invoice_refresh() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.invoice_id IS NOT NULL THEN PERFORM core.invoice_refresh(OLD.invoice_id); END IF;
  IF TG_OP <> 'DELETE' AND NEW.invoice_id IS NOT NULL THEN PERFORM core.invoice_refresh(NEW.invoice_id); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER payment_invoice_refresh AFTER INSERT OR UPDATE OR DELETE ON core.payments
  FOR EACH ROW EXECUTE FUNCTION core.payment_invoice_refresh();

-- Access ----------------------------------------------------------------------------------------

ALTER TABLE core.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.invoice_lines ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.invoices, core.invoice_lines TO joybot_app;
GRANT SELECT ON core.invoices, core.invoice_lines TO joybot_reader, joybot_worker;
GRANT USAGE ON SEQUENCE core.invoice_number_seq TO joybot_app;

CREATE POLICY sel ON core.invoices FOR SELECT TO joybot_app, joybot_reader
  USING (authz.customer_in_scope(customer_id, 'payments', 'read')
         AND (authz.principal_type() = 'employee' OR status <> 'draft'));
CREATE POLICY ins ON core.invoices FOR INSERT TO joybot_app
  WITH CHECK (authz.principal_type() = 'employee' AND created_by = authz.principal_id() AND status = 'draft'
              AND authz.customer_in_scope(customer_id, 'payments', 'create'));
-- Whoever may bill the customer (payments:create) edits, sends and voids their invoices; payments
-- 'update' is narrower for staff (their own manual entries) and does not fit invoices.
CREATE POLICY upd ON core.invoices FOR UPDATE TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.customer_in_scope(customer_id, 'payments', 'create'))
  WITH CHECK (authz.principal_type() = 'employee' AND authz.customer_in_scope(customer_id, 'payments', 'create'));
-- Only drafts are deleted (sent invoices are voided instead).
CREATE POLICY del ON core.invoices FOR DELETE TO joybot_app
  USING (status = 'draft' AND authz.principal_type() = 'employee' AND authz.customer_in_scope(customer_id, 'payments', 'create'));
CREATE POLICY worker_all ON core.invoices FOR SELECT TO joybot_worker USING (true);

CREATE POLICY sel ON core.invoice_lines FOR SELECT TO joybot_app, joybot_reader
  USING (EXISTS (SELECT 1 FROM core.invoices i WHERE i.id = invoice_id));
CREATE POLICY ins ON core.invoice_lines FOR INSERT TO joybot_app
  WITH CHECK (authz.principal_type() = 'employee' AND EXISTS (SELECT 1 FROM core.invoices i WHERE i.id = invoice_id));
CREATE POLICY upd ON core.invoice_lines FOR UPDATE TO joybot_app
  USING (authz.principal_type() = 'employee' AND EXISTS (SELECT 1 FROM core.invoices i WHERE i.id = invoice_id))
  WITH CHECK (authz.principal_type() = 'employee' AND EXISTS (SELECT 1 FROM core.invoices i WHERE i.id = invoice_id));
CREATE POLICY del ON core.invoice_lines FOR DELETE TO joybot_app
  USING (authz.principal_type() = 'employee' AND EXISTS (SELECT 1 FROM core.invoices i WHERE i.id = invoice_id));
CREATE POLICY worker_all ON core.invoice_lines FOR SELECT TO joybot_worker USING (true);

-- Customer merges move invoices to the surviving customer.
CREATE FUNCTION core.move_invoices_on_merge() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE core.invoices SET customer_id = NEW.merged_into WHERE customer_id = NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER move_invoices_on_merge AFTER UPDATE OF merged_into ON core.customers
  FOR EACH ROW WHEN (NEW.merged_into IS NOT NULL AND OLD.merged_into IS DISTINCT FROM NEW.merged_into)
  EXECUTE FUNCTION core.move_invoices_on_merge();
