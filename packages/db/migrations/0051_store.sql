-- Store: products on the public website (services and digital products, no shipping), a cart, and
-- Stripe Checkout for signed-in customers. Paying creates a payment (Stripe sync) linked to the order
-- through its order_number metadata, as invoices are; the order's status follows its payments.
--
-- Access: products are part of the website (editors with 'website' rights; anyone sees active ones).
-- Orders follow the 'payments' resource like invoices: customers see their own, employees those of
-- customers in their payments read scope, and change their status with payments create scope.
-- Orders and their lines are only written through the functions below, never directly.

-- Store settings (Settings › Store) -------------------------------------------------------------

CREATE TABLE core.store_settings (
  id                    int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled               boolean NOT NULL DEFAULT false,
  -- Stripe Tax: Checkout works out and adds tax; prices are with or without it.
  automatic_tax         boolean NOT NULL DEFAULT false,
  prices_include_tax    boolean NOT NULL DEFAULT false,
  allow_promotion_codes boolean NOT NULL DEFAULT false,
  -- Checkout asks the buyer to accept the terms page (Stripe needs its URL in the account settings).
  require_terms         boolean NOT NULL DEFAULT false,
  notify_admins         boolean NOT NULL DEFAULT true,
  max_quantity          int NOT NULL DEFAULT 10 CHECK (max_quantity BETWEEN 1 AND 100),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
INSERT INTO core.store_settings (id) VALUES (1);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.store_settings FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.store_settings FOR EACH ROW EXECUTE FUNCTION core.audit_row();

-- Products ----------------------------------------------------------------------------------------

CREATE TABLE core.products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 60),
  name           text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  -- A line for product cards; the description (Markdown) is on the product's own page.
  summary        text CHECK (length(summary) <= 300),
  description    text CHECK (length(description) <= 10000),
  kind           text NOT NULL CHECK (kind IN ('service', 'digital')),
  price          numeric(12, 2) NOT NULL CHECK (price > 0),
  image_asset_id uuid REFERENCES core.site_assets(id) ON DELETE SET NULL,
  active         boolean NOT NULL DEFAULT false,
  sort_order     int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_listed ON core.products (sort_order, name) WHERE active;

-- What a buyer gets once paid (Markdown: a download link, access details, what happens next). Kept
-- apart from the product so the public never reads it; copied onto the order's lines when paid.
CREATE TABLE core.product_delivery (
  product_id uuid PRIMARY KEY REFERENCES core.products(id) ON DELETE CASCADE,
  content    text NOT NULL CHECK (length(content) <= 4000)
);

CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.products FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.products FOR EACH ROW EXECUTE FUNCTION core.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.product_delivery FOR EACH ROW EXECUTE FUNCTION core.audit_row();

-- Orders ------------------------------------------------------------------------------------------

CREATE SEQUENCE core.order_number_seq START 1;

CREATE TABLE core.orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number        text NOT NULL UNIQUE
                      DEFAULT 'ORD-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('core.order_number_seq')::text, 6, '0'),
  customer_id         uuid NOT NULL REFERENCES core.customers(id),
  currency            char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- pending: not paid yet. paid: to fulfil (services). fulfilled: done (digital ones on payment).
  -- cancelled: by staff, or replaced by a newer checkout. refunded: every payment refunded.
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'fulfilled', 'cancelled', 'refunded')),
  subtotal            numeric(12, 2) NOT NULL CHECK (subtotal >= 0),
  -- What the customer paid, net of refunds (with tax and discounts, as Stripe charged it).
  amount_paid         numeric(12, 2) NOT NULL DEFAULT 0,
  checkout_session_id text UNIQUE,
  paid_at             timestamptz,
  fulfilled_at        timestamptz,
  fulfilled_by        uuid REFERENCES core.users(id),
  cancelled_at        timestamptz,
  cancelled_by        uuid REFERENCES core.users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_customer ON core.orders (customer_id, created_at DESC);
CREATE INDEX orders_status ON core.orders (status, created_at DESC);

CREATE TABLE core.order_lines (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid NOT NULL REFERENCES core.orders(id) ON DELETE CASCADE,
  position   int NOT NULL,
  product_id uuid REFERENCES core.products(id) ON DELETE SET NULL,
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('service', 'digital')),
  unit_price numeric(12, 2) NOT NULL CHECK (unit_price > 0),
  quantity   int NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  -- The product's delivery, copied when the order is paid (NULL until then).
  delivery   text
);
CREATE INDEX order_lines_order ON core.order_lines (order_id, position);

CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.orders FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.orders FOR EACH ROW EXECUTE FUNCTION core.audit_row();

ALTER TABLE core.payments ADD COLUMN order_id uuid REFERENCES core.orders(id);
CREATE INDEX payments_order ON core.payments (order_id) WHERE order_id IS NOT NULL;

-- Status follows payments -------------------------------------------------------------------------

/**
 * Recomputes what was paid and the status: any money kept makes a pending (or cancelled, or
 * refunded) order paid, or fulfilled when it is all digital; every payment refunded makes it
 * refunded. On becoming paid the lines get their delivery and admins are notified.
 */
CREATE FUNCTION core.order_refresh(p_order uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  o core.orders;
  v_paid numeric(12, 2);
  v_refunded boolean;
  v_digital boolean;
  v_status text;
  v_admin uuid;
BEGIN
  SELECT * INTO o FROM core.orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT coalesce(sum(p.amount - p.amount_refunded) FILTER (WHERE p.status IN ('succeeded', 'partially_refunded')), 0),
         bool_or(p.status = 'refunded')
    INTO v_paid, v_refunded
    FROM core.payments p WHERE p.order_id = p_order;
  v_digital := NOT EXISTS (SELECT 1 FROM core.order_lines l WHERE l.order_id = p_order AND l.kind <> 'digital');

  v_status := CASE
    WHEN v_paid > 0 THEN CASE WHEN o.status = 'fulfilled' OR (o.status <> 'paid' AND v_digital) THEN 'fulfilled' ELSE 'paid' END
    WHEN coalesce(v_refunded, false) THEN 'refunded'
    WHEN o.status IN ('paid', 'fulfilled') THEN 'pending'
    ELSE o.status
  END;
  IF v_status = o.status AND v_paid = o.amount_paid THEN RETURN; END IF;

  UPDATE core.orders SET
    amount_paid = v_paid,
    status = v_status,
    paid_at = CASE WHEN v_paid > 0 THEN coalesce(paid_at, now()) ELSE paid_at END,
    fulfilled_at = CASE WHEN v_status = 'fulfilled' THEN coalesce(fulfilled_at, now()) ELSE fulfilled_at END
  WHERE id = p_order;

  -- Newly paid: hand over what was bought, and tell the admins.
  IF v_paid > 0 AND o.status NOT IN ('paid', 'fulfilled') THEN
    UPDATE core.order_lines l SET delivery = d.content
      FROM core.product_delivery d WHERE l.order_id = p_order AND d.product_id = l.product_id AND l.delivery IS NULL;
    IF (SELECT notify_admins FROM core.store_settings WHERE id = 1) THEN
      FOR v_admin IN SELECT u.id FROM core.users u WHERE u.role = 'admin' AND u.active LOOP
        PERFORM app.team_notify(v_admin,
          'New order ' || o.order_number || ': '
            || (SELECT string_agg(l.quantity || ' × ' || l.name, ', ' ORDER BY l.position) FROM core.order_lines l WHERE l.order_id = p_order)
            || ' (' || v_paid || ' ' || o.currency || ')',
          '/staff/orders?order=' || p_order);
      END LOOP;
    END IF;
  END IF;
END $$;

-- A payment counts toward an order of the same customer only; Stripe payments with a mismatched order
-- are kept, just not linked (the worker must not fail on them).
CREATE FUNCTION core.payment_order_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.order_id IS NULL THEN RETURN NEW; END IF;
  IF (SELECT customer_id FROM core.orders WHERE id = NEW.order_id) IS NOT DISTINCT FROM NEW.customer_id AND NEW.customer_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.source = 'stripe' THEN
    NEW.order_id := NULL;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the order is not an order of this customer' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER payment_order_check BEFORE INSERT OR UPDATE OF order_id, customer_id ON core.payments
  FOR EACH ROW EXECUTE FUNCTION core.payment_order_check();

CREATE FUNCTION core.payment_order_refresh() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.order_id IS NOT NULL THEN PERFORM core.order_refresh(OLD.order_id); END IF;
  IF TG_OP <> 'DELETE' AND NEW.order_id IS NOT NULL THEN PERFORM core.order_refresh(NEW.order_id); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER payment_order_refresh AFTER INSERT OR UPDATE OR DELETE ON core.payments
  FOR EACH ROW EXECUTE FUNCTION core.payment_order_refresh();

-- Writing orders ----------------------------------------------------------------------------------

/**
 * A signed-in customer's cart becomes a pending order: [{product_id, quantity}], prices from the
 * products (never the browser), in the business currency. Their older unpaid orders are cancelled,
 * so abandoned checkouts don't pile up (one paid later still counts: payments revive it).
 */
CREATE FUNCTION authz.create_order(p_items jsonb)
RETURNS TABLE (id uuid, order_number text, currency char(3), subtotal numeric)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_customer uuid := authz.principal_id();
  v_store core.store_settings;
  v_order uuid;
  v_count int;
BEGIN
  IF authz.principal_type() IS DISTINCT FROM 'customer' THEN
    RAISE EXCEPTION 'only customers place orders' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_store FROM core.store_settings s WHERE s.id = 1;
  IF NOT v_store.enabled THEN
    RAISE EXCEPTION 'the store is closed' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'an order has 1 to 20 products' USING ERRCODE = 'check_violation';
  END IF;

  CREATE TEMP TABLE _cart ON COMMIT DROP AS
    SELECT (e->>'product_id')::uuid AS product_id, (e->>'quantity')::int AS quantity, ord
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, ord);
  IF EXISTS (SELECT 1 FROM _cart c WHERE c.quantity IS NULL OR c.quantity < 1 OR c.quantity > v_store.max_quantity) THEN
    RAISE EXCEPTION 'quantities are 1 to %', v_store.max_quantity USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(DISTINCT c.product_id) FROM _cart c) <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'each product once' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO v_count FROM _cart c JOIN core.products p ON p.id = c.product_id AND p.active;
  IF v_count <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'a product is no longer available' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE core.orders o SET status = 'cancelled', cancelled_at = now()
   WHERE o.customer_id = v_customer AND o.status = 'pending';

  INSERT INTO core.orders (customer_id, currency, subtotal)
  SELECT v_customer, (SELECT s.default_currency FROM core.settings s WHERE s.id = 1),
         (SELECT sum(round(p.price * c.quantity, 2)) FROM _cart c JOIN core.products p ON p.id = c.product_id)
  RETURNING core.orders.id INTO v_order;
  INSERT INTO core.order_lines (order_id, position, product_id, name, kind, unit_price, quantity)
  SELECT v_order, c.ord, p.id, p.name, p.kind, p.price, c.quantity
    FROM _cart c JOIN core.products p ON p.id = c.product_id;

  RETURN QUERY SELECT o.id, o.order_number, o.currency, o.subtotal FROM core.orders o WHERE o.id = v_order;
END $$;

-- The customer's pending order gets its Stripe Checkout Session.
CREATE FUNCTION authz.attach_order_checkout(p_order uuid, p_session text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE core.orders SET checkout_session_id = p_session
   WHERE id = p_order AND status = 'pending' AND customer_id = authz.principal_id() AND authz.principal_type() = 'customer';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not a pending order of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

/**
 * Staff move an order along: paid → fulfilled (done) and back, pending → cancelled. Whoever may bill
 * the customer (payments create scope) may.
 */
CREATE FUNCTION authz.set_order_status(p_order uuid, p_status text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  o core.orders;
BEGIN
  SELECT * INTO o FROM core.orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND OR authz.principal_type() IS DISTINCT FROM 'employee' OR NOT authz.customer_in_scope(o.customer_id, 'payments', 'create') THEN
    RAISE EXCEPTION 'not allowed to change this order' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (o.status, p_status) = ('paid', 'fulfilled') THEN
    UPDATE core.orders SET status = 'fulfilled', fulfilled_at = now(), fulfilled_by = authz.principal_id() WHERE id = p_order;
  ELSIF (o.status, p_status) = ('fulfilled', 'paid') THEN
    UPDATE core.orders SET status = 'paid', fulfilled_at = NULL, fulfilled_by = NULL WHERE id = p_order;
  ELSIF (o.status, p_status) = ('pending', 'cancelled') THEN
    UPDATE core.orders SET status = 'cancelled', cancelled_at = now(), cancelled_by = authz.principal_id() WHERE id = p_order;
  ELSE
    RAISE EXCEPTION 'an order that is % cannot become %', o.status, p_status USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- Customer merges move orders to the surviving customer.
CREATE FUNCTION core.move_orders_on_merge() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE core.orders SET customer_id = NEW.merged_into WHERE customer_id = NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER move_orders_on_merge AFTER UPDATE OF merged_into ON core.customers
  FOR EACH ROW WHEN (NEW.merged_into IS NOT NULL AND OLD.merged_into IS DISTINCT FROM NEW.merged_into)
  EXECUTE FUNCTION core.move_orders_on_merge();

-- Access ------------------------------------------------------------------------------------------

ALTER TABLE core.store_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.product_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.order_lines ENABLE ROW LEVEL SECURITY;

GRANT SELECT, UPDATE ON core.store_settings TO joybot_app;
GRANT SELECT ON core.store_settings TO joybot_reader;
-- Anyone (the public site) sees whether the store is open and how it checks out; admins change it.
CREATE POLICY sel ON core.store_settings FOR SELECT TO joybot_app, joybot_reader USING (true);
CREATE POLICY upd ON core.store_settings FOR UPDATE TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('settings', 'update'))
  WITH CHECK (authz.principal_type() = 'employee' AND authz.can('settings', 'update'));

GRANT SELECT, INSERT, UPDATE, DELETE ON core.products, core.product_delivery TO joybot_app;
GRANT SELECT ON core.products TO joybot_reader;
CREATE POLICY sel ON core.products FOR SELECT TO joybot_app, joybot_reader USING (active OR authz.can_edit_website('read'));
CREATE POLICY ins ON core.products FOR INSERT TO joybot_app WITH CHECK (authz.can_edit_website('create'));
CREATE POLICY upd ON core.products FOR UPDATE TO joybot_app USING (authz.can_edit_website('update')) WITH CHECK (authz.can_edit_website('update'));
CREATE POLICY del ON core.products FOR DELETE TO joybot_app USING (authz.can_edit_website('delete'));
CREATE POLICY sel ON core.product_delivery FOR SELECT TO joybot_app USING (authz.can_edit_website('read'));
CREATE POLICY ins ON core.product_delivery FOR INSERT TO joybot_app WITH CHECK (authz.can_edit_website('create') OR authz.can_edit_website('update'));
CREATE POLICY upd ON core.product_delivery FOR UPDATE TO joybot_app USING (authz.can_edit_website('update')) WITH CHECK (authz.can_edit_website('update'));
CREATE POLICY del ON core.product_delivery FOR DELETE TO joybot_app USING (authz.can_edit_website('update') OR authz.can_edit_website('delete'));

-- Orders: read only; written through the functions above.
GRANT SELECT ON core.orders, core.order_lines TO joybot_app, joybot_reader, joybot_worker;
CREATE POLICY sel ON core.orders FOR SELECT TO joybot_app, joybot_reader USING (authz.customer_in_scope(customer_id, 'payments', 'read'));
CREATE POLICY worker_all ON core.orders FOR SELECT TO joybot_worker USING (true);
CREATE POLICY sel ON core.order_lines FOR SELECT TO joybot_app, joybot_reader USING (EXISTS (SELECT 1 FROM core.orders o WHERE o.id = order_id));
CREATE POLICY worker_all ON core.order_lines FOR SELECT TO joybot_worker USING (true);

-- The public site shows prices in the business currency (settings are otherwise for signed-in principals).
CREATE FUNCTION authz.store_currency() RETURNS char(3)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT default_currency FROM core.settings WHERE id = 1
$$;
REVOKE ALL ON FUNCTION authz.store_currency() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.store_currency() TO joybot_app;

REVOKE ALL ON FUNCTION authz.create_order(jsonb), authz.attach_order_checkout(uuid, text), authz.set_order_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.create_order(jsonb), authz.attach_order_checkout(uuid, text), authz.set_order_status(uuid, text) TO joybot_app;
