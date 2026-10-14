-- Order confirmation emails: once an order is paid the API emails the customer (items, what was paid,
-- what they get, a link to the order). Orders become paid in the database (the worker applies Stripe's
-- payment), so the API sweeps for paid orders not yet confirmed and claims each one here before
-- sending: only one API instance sends it, and a failed send is retried a few times.

ALTER TABLE core.store_settings ADD COLUMN email_customers boolean NOT NULL DEFAULT true;

ALTER TABLE core.orders
  ADD COLUMN confirmation_sent_at  timestamptz,
  ADD COLUMN confirmation_attempts int NOT NULL DEFAULT 0;
CREATE INDEX orders_to_confirm ON core.orders (paid_at) WHERE confirmation_sent_at IS NULL AND paid_at IS NOT NULL;

/**
 * Claims up to p_limit paid orders to confirm (paid in the last two days, customer with a verified
 * email, emails on), marking them sent. The API reports a failed send with order_confirmation_failed.
 */
CREATE FUNCTION authz.claim_order_confirmations(p_limit int)
RETURNS TABLE (order_id uuid, order_number text, email text, first_name text, currency char(3), subtotal numeric, amount_paid numeric,
               business_name text, lines jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT coalesce((SELECT s.email_customers FROM core.store_settings s WHERE s.id = 1), false) THEN RETURN; END IF;
  RETURN QUERY
  WITH claimed AS (
    UPDATE core.orders o SET confirmation_sent_at = now(), confirmation_attempts = o.confirmation_attempts + 1
     WHERE o.id IN (
       SELECT x.id FROM core.orders x JOIN core.customers c ON c.id = x.customer_id
        WHERE x.confirmation_sent_at IS NULL AND x.paid_at > now() - interval '2 days' AND x.status IN ('paid', 'fulfilled')
          AND x.confirmation_attempts < 5 AND c.email IS NOT NULL AND c.email_verified
        ORDER BY x.paid_at
        LIMIT greatest(1, least(p_limit, 50))
        FOR UPDATE OF x SKIP LOCKED)
    RETURNING o.id, o.order_number, o.customer_id, o.currency, o.subtotal, o.amount_paid
  )
  SELECT cl.id, cl.order_number, c.email::text, c.first_name, cl.currency, cl.subtotal, cl.amount_paid,
         coalesce((SELECT nullif(ss.site_name, '') FROM core.site_settings ss WHERE ss.id = 1), (SELECT s.business_name FROM core.settings s WHERE s.id = 1)),
         (SELECT jsonb_agg(jsonb_build_object('name', l.name, 'quantity', l.quantity, 'amount', round(l.unit_price * l.quantity, 2), 'delivery', l.delivery) ORDER BY l.position)
            FROM core.order_lines l WHERE l.order_id = cl.id)
    FROM claimed cl JOIN core.customers c ON c.id = cl.customer_id;
END $$;

-- A send that failed: the order is picked up again (until it has been tried five times).
CREATE FUNCTION authz.order_confirmation_failed(p_order uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE core.orders SET confirmation_sent_at = NULL WHERE id = p_order
$$;

REVOKE ALL ON FUNCTION authz.claim_order_confirmations(int), authz.order_confirmation_failed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.claim_order_confirmations(int), authz.order_confirmation_failed(uuid) TO joybot_app;
