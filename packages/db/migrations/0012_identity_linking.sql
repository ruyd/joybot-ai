-- Linking Cognito identities to JoyBot records (plan.md §4.3). Called by the Cognito trigger
-- Lambdas (joybot_worker); the rules live here so they are tested with the rest of access control.

/**
 * Customer sign-up confirmed (customers user pool, PostConfirmation trigger).
 * Returns (outcome, customer_id): 'existing' | 'linked' | 'created' | 'review'.
 * Only *verified* contacts are used for matching; a contact that belongs to a customer already
 * linked to another login is never auto-linked — it goes to the review queue.
 */
CREATE FUNCTION authz.link_customer_signup(p_sub text, p_email text, p_email_verified boolean,
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

/**
 * Employee signed in (employees user pool, PostAuthentication trigger). Employees are created by
 * admins in JoyBot first; the first sign-in links the Cognito identity by email.
 * Returns the employee id, or NULL if there is no active, unlinked employee with that email.
 */
CREATE FUNCTION authz.link_employee_login(p_sub text, p_email text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT u.id INTO v_id FROM core.users u WHERE u.cognito_sub = p_sub AND u.active;
  IF FOUND THEN
    RETURN v_id;
  END IF;
  UPDATE core.users SET cognito_sub = p_sub
   WHERE email = lower(trim(p_email)) AND cognito_sub IS NULL AND active
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

/** DB bootstrap: first admin employee (idempotent). */
CREATE FUNCTION authz.ensure_admin(p_email text, p_first_name text, p_last_name text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM core.users WHERE email = lower(trim(p_email));
  IF FOUND THEN
    UPDATE core.users SET role = 'admin', active = true WHERE id = v_id;
    RETURN v_id;
  END IF;
  INSERT INTO core.users (first_name, last_name, email, role)
  VALUES (p_first_name, p_last_name, lower(trim(p_email)), 'admin')
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION authz.link_customer_signup(text, text, boolean, text, boolean),
                       authz.link_employee_login(text, text),
                       authz.ensure_admin(text, text, text) FROM PUBLIC, joybot_app, joybot_reader;
GRANT EXECUTE ON FUNCTION authz.link_customer_signup(text, text, boolean, text, boolean),
                          authz.link_employee_login(text, text) TO joybot_worker;
