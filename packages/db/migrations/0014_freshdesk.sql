-- Freshdesk contact links (plan.md §4.5). Contact IDs found by verified email/phone are cached in
-- core.external_links. Customers cannot read that table directly, so access goes through these
-- functions, which apply the same "tickets" permission scopes as everything else.

/** Cached, non-excluded Freshdesk contact IDs of a customer the principal may read tickets for. */
CREATE FUNCTION authz.freshdesk_contacts(p_customer uuid)
RETURNS TABLE (external_id text, matched_by text, refreshed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT l.external_id, l.matched_by, l.refreshed_at
    FROM core.external_links l
   WHERE l.entity_type = 'customer' AND l.entity_id = p_customer AND l.source = 'freshdesk_contact'
     AND NOT l.excluded
     AND authz.customer_in_scope(p_customer, 'tickets', 'read')
$$;

/** Replaces the cached (non-excluded) contact links of a customer after a fresh lookup. */
CREATE FUNCTION authz.cache_freshdesk_contacts(p_customer uuid, p_ids text[], p_matched_by text[])
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT authz.customer_in_scope(p_customer, 'tickets', 'read') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM core.external_links
   WHERE entity_type = 'customer' AND entity_id = p_customer AND source = 'freshdesk_contact' AND NOT excluded;
  INSERT INTO core.external_links (entity_type, entity_id, source, external_id, matched_by, refreshed_at)
  SELECT 'customer', p_customer, 'freshdesk_contact', id, mb, now()
    FROM unnest(p_ids, p_matched_by) AS t(id, mb)
  ON CONFLICT (entity_type, entity_id, source, external_id) DO NOTHING;   -- keeps excluded rows excluded
END $$;

/** Which customer a Freshdesk contact belongs to — only if the principal may read their tickets. */
CREATE FUNCTION authz.customer_for_freshdesk_contact(p_contact text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT l.entity_id
    FROM core.external_links l
   WHERE l.entity_type = 'customer' AND l.source = 'freshdesk_contact' AND l.external_id = p_contact AND NOT l.excluded
     AND authz.customer_in_scope(l.entity_id, 'tickets', 'read')
   LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION authz.freshdesk_contacts(uuid), authz.cache_freshdesk_contacts(uuid, text[], text[]),
                          authz.customer_for_freshdesk_contact(text)
  TO joybot_app, joybot_reader;
