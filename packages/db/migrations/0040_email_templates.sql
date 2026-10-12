-- Email templates, starting with sales calls (Marketing › Sales calls: Confirmation email and Thank you
-- email tabs).
--
-- core.email_templates: a subject and a plain-text body with {{placeholders}} (filled in by the API;
-- unknown placeholders are refused on save). Kinds:
--   sales_call_confirmation — the one email sent when a visitor books
--   sales_call_thank_you    — presets staff choose from to thank someone after a call, by hand
-- Those who may read the website see them; those who may update it edit, add and delete (thank-you
-- presets only; the confirmation always exists). The booking path reads the confirmation through
-- authz.email_template(), which needs no principal.
--
-- A thank-you is recorded on the call (thank_you_sent_at / _by), so the Past list shows it.

CREATE TABLE core.email_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('sales_call_confirmation', 'sales_call_thank_you')),
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  subject    text NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 200),
  body       text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 10000),
  sort_order int NOT NULL DEFAULT 0,
  updated_by uuid REFERENCES core.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, name)
);
CREATE UNIQUE INDEX email_templates_one_confirmation ON core.email_templates (kind) WHERE kind = 'sales_call_confirmation';

INSERT INTO core.email_templates (kind, name, subject, body, sort_order) VALUES
('sales_call_confirmation', 'Confirmation', '{{call_title}} with {{host_name}}: {{date}} at {{time}}',
$t$Hi {{first_name}},

Your {{duration}}-minute {{call_title}} with {{host_name}} is booked for {{date}} at {{time}} ({{time_zone}}).

{{meeting_details}}

Reply to this email if you need to change it.$t$, 0),
('sales_call_thank_you', 'Thanks for your time', 'Thanks for talking with us, {{first_name}}',
$t$Hi {{first_name}},

Thank you for taking the time to talk with us today. It was great to learn about your project.

We'll follow up shortly with next steps. In the meantime, just reply to this email with any questions.

Best,
{{host_name}}
{{site_name}}$t$, 10),
('sales_call_thank_you', 'Next steps', 'Next steps after our call',
$t$Hi {{first_name}},

Thanks again for the call on {{date}}. As promised, here are the next steps we discussed:

-
-

If anything comes up, reply to this email or book another call: {{booking_link}}

Best,
{{host_name}}$t$, 20),
('sales_call_thank_you', 'Sorry we missed you', 'Sorry we missed you, {{first_name}}',
$t$Hi {{first_name}},

We were looking forward to our {{call_title}} on {{date}} at {{time}}, but it looks like we couldn't connect.

No problem: pick a new time that suits you here: {{booking_link}}

Best,
{{host_name}}$t$, 30);

CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.email_templates FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.email_templates FOR EACH ROW EXECUTE FUNCTION core.audit_row();

ALTER TABLE core.email_templates ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.email_templates TO joybot_app;
CREATE POLICY sel ON core.email_templates FOR SELECT TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('website', 'read'));
CREATE POLICY ins ON core.email_templates FOR INSERT TO joybot_app
  WITH CHECK (authz.principal_type() = 'employee' AND authz.can('website', 'update') AND kind = 'sales_call_thank_you');
CREATE POLICY upd ON core.email_templates FOR UPDATE TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('website', 'update'))
  WITH CHECK (authz.principal_type() = 'employee' AND authz.can('website', 'update'));
CREATE POLICY del ON core.email_templates FOR DELETE TO joybot_app
  USING (authz.principal_type() = 'employee' AND authz.can('website', 'update') AND kind = 'sales_call_thank_you');

-- The template a kind sends (the first by order), for paths without a principal (booking).
CREATE FUNCTION authz.email_template(p_kind text) RETURNS TABLE (subject text, body text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT t.subject, t.body FROM core.email_templates t WHERE t.kind = p_kind ORDER BY t.sort_order, t.name LIMIT 1
$$;
REVOKE ALL ON FUNCTION authz.email_template(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.email_template(text) TO joybot_app;

ALTER TABLE core.appointments
  ADD COLUMN thank_you_sent_at timestamptz,
  ADD COLUMN thank_you_sent_by uuid REFERENCES core.users(id);
