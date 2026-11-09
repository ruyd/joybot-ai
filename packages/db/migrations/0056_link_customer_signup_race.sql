-- A login's first requests can arrive together and each link it. Under READ COMMITTED, a second
-- call could miss the first's customer in its "already linked?" check, then find that same customer
-- by email once the first committed, and send this login to staff review as
-- 'contact_linked_to_other_login' (a 403 and a stray review row).
-- Now calls for the same login wait for each other (a transaction lock on the login), and a match
-- that already belongs to this login counts as 'existing'. Otherwise unchanged from 0012.
CREATE OR REPLACE FUNCTION authz.link_customer_signup(p_sub text, p_email text, p_email_verified boolean,
                                                      p_phone text, p_phone_verified boolean)
RETURNS TABLE (outcome text, customer_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_email text := CASE WHEN p_email_verified THEN lower(nullif(trim(p_email), '')) END;
  v_phone text := CASE WHEN p_phone_verified THEN nullif(trim(p_phone), '') END;
  v_id uuid;
  v_candidate record;
BEGIN
  IF p_sub IS NULL OR (v_email IS NULL AND v_phone IS NULL) THEN
    RAISE EXCEPTION 'a verified email or phone is required' USING ERRCODE = 'check_violation';
  END IF;

  -- One link at a time per login; the next statement then sees what an earlier call committed.
  PERFORM pg_advisory_xact_lock(hashtext('authz.link_customer_signup'), hashtext(p_sub));

  SELECT c.id INTO v_id FROM core.customers c WHERE c.cognito_sub = p_sub;
  IF FOUND THEN
    RETURN QUERY SELECT 'existing'::text, v_id;
    RETURN;
  END IF;

  SELECT c.id, c.cognito_sub, c.status INTO v_candidate
    FROM core.customers c
   WHERE (v_email IS NOT NULL AND c.email = v_email) OR (v_phone IS NOT NULL AND c.phone = v_phone)
   ORDER BY (c.email = v_email) DESC NULLS LAST
   LIMIT 1;

  -- Linked to this same login in the meantime (e.g. by a call that held the lock first).
  IF FOUND AND v_candidate.cognito_sub = p_sub THEN
    RETURN QUERY SELECT 'existing'::text, v_candidate.id;
    RETURN;
  END IF;

  IF FOUND AND v_candidate.cognito_sub IS NULL AND v_candidate.status <> 'blocked'
     -- both verified contacts must not point at two different customers
     AND NOT EXISTS (SELECT 1 FROM core.customers o
                      WHERE o.id <> v_candidate.id
                        AND ((v_email IS NOT NULL AND o.email = v_email) OR (v_phone IS NOT NULL AND o.phone = v_phone))) THEN
    UPDATE core.customers
       SET cognito_sub = p_sub,
           email = coalesce(email, v_email),
           email_verified = email_verified OR (v_email IS NOT NULL AND coalesce(email, v_email) = v_email),
           phone = coalesce(phone, v_phone),
           phone_verified = phone_verified OR (v_phone IS NOT NULL AND coalesce(phone, v_phone) = v_phone),
           whatsapp_opt_in_at = CASE WHEN v_phone IS NOT NULL THEN coalesce(whatsapp_opt_in_at, now())
                                     ELSE whatsapp_opt_in_at END
     WHERE id = v_candidate.id;
    RETURN QUERY SELECT 'linked'::text, v_candidate.id;
    RETURN;
  END IF;

  IF FOUND THEN
    INSERT INTO app.link_review_queue (cognito_sub, contact_hash, candidate_customer_id, reason)
    VALUES (p_sub, encode(sha256(convert_to(coalesce(v_email, v_phone), 'UTF8')), 'hex'), v_candidate.id,
            CASE WHEN v_candidate.status = 'blocked' THEN 'candidate_blocked'
                 WHEN v_candidate.cognito_sub IS NOT NULL THEN 'contact_linked_to_other_login'
                 ELSE 'contacts_match_different_customers' END);
    RETURN QUERY SELECT 'review'::text, NULL::uuid;
    RETURN;
  END IF;

  INSERT INTO core.customers (cognito_sub, email, email_verified, phone, phone_verified, whatsapp_opt_in_at, source)
  VALUES (p_sub, v_email, v_email IS NOT NULL, v_phone, v_phone IS NOT NULL,
          CASE WHEN v_phone IS NOT NULL THEN now() END, 'self_signup')
  RETURNING id INTO v_id;
  RETURN QUERY SELECT 'created'::text, v_id;
END $$;
