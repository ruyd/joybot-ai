-- Website (Marketing › Website): the business's public site at the root of the web app, edited by staff.
--
-- A page has a slug, a title, an optional description for search engines, whether it shows in the
-- header and footer (ordered by sort_order), and a list of modules (jsonb, validated by the API):
--   columns — up to four columns of heading, Markdown text, an image and a link
--   html    — HTML, sanitized by the API on save (and again by the browser on display)
--   image   — an uploaded image with alt text, caption and size
--   video   — a YouTube or Vimeo link, embedded
-- One page is the home page (served at "/"); it is always published and cannot be deleted. Images
-- are uploaded into the database (no public buckets): metadata in core.site_assets (audited), bytes in
-- core.site_asset_data (not audited, so the change log never holds file contents).
--
-- Access uses the new 'website' resource: admins edit; staff by default do not (Admin › Access can
-- allow them). Anyone, signed in or not, reads published pages and images.

ALTER TABLE core.role_permissions DROP CONSTRAINT role_permissions_resource_check;
ALTER TABLE core.role_permissions ADD CONSTRAINT role_permissions_resource_check
  CHECK (resource IN ('customers', 'organizations', 'appointments', 'payments', 'services', 'locations',
                      'tickets', 'users', 'settings', 'audit', 'notes_internal', 'access', 'tasks', 'knowledge',
                      'schedules', 'website'));

INSERT INTO core.role_permissions (role, resource, action, scope) VALUES
  ('admin', 'website', 'read', 'all'), ('admin', 'website', 'create', 'all'),
  ('admin', 'website', 'update', 'all'), ('admin', 'website', 'delete', 'all');

CREATE TABLE core.site_pages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text NOT NULL UNIQUE
                 CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 60
                        AND slug NOT IN ('portal', 'staff', 'auth', 'api', 'assets', 'login')),
  title          text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  description    text CHECK (length(description) <= 300),
  is_home        boolean NOT NULL DEFAULT false,
  published      boolean NOT NULL DEFAULT false,
  show_in_header boolean NOT NULL DEFAULT false,
  show_in_footer boolean NOT NULL DEFAULT false,
  sort_order     int NOT NULL DEFAULT 0,
  modules        jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(modules) = 'array'),
  created_by     uuid REFERENCES core.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES core.users(id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_home OR published)
);
CREATE UNIQUE INDEX site_pages_one_home ON core.site_pages (is_home) WHERE is_home;

CREATE TABLE core.site_assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename     text NOT NULL CHECK (length(filename) BETWEEN 1 AND 200),
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  size_bytes   int NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_by   uuid REFERENCES core.users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX site_assets_created ON core.site_assets (created_at DESC);

CREATE TABLE core.site_asset_data (
  asset_id uuid PRIMARY KEY REFERENCES core.site_assets(id) ON DELETE CASCADE,
  bytes    bytea NOT NULL
);

CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.site_pages FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.site_pages FOR EACH ROW EXECUTE FUNCTION core.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.site_assets FOR EACH ROW EXECUTE FUNCTION core.audit_row();

-- RLS ---------------------------------------------------------------------------------------------

ALTER TABLE core.site_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.site_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.site_asset_data ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.site_pages TO joybot_app;
GRANT SELECT, INSERT, DELETE ON core.site_assets, core.site_asset_data TO joybot_app;

CREATE FUNCTION authz.can_edit_website(p_action text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT authz.principal_type() = 'employee' AND authz.can('website', p_action)
$$;

-- Published pages for everyone (the public site needs no sign-in); drafts for editors.
CREATE POLICY sel ON core.site_pages FOR SELECT TO joybot_app
  USING (published OR authz.can_edit_website('read'));
CREATE POLICY ins ON core.site_pages FOR INSERT TO joybot_app WITH CHECK (authz.can_edit_website('create'));
CREATE POLICY upd ON core.site_pages FOR UPDATE TO joybot_app
  USING (authz.can_edit_website('update')) WITH CHECK (authz.can_edit_website('update'));
CREATE POLICY del ON core.site_pages FOR DELETE TO joybot_app USING (authz.can_edit_website('delete') AND NOT is_home);

-- Images are public by id (pages show them to anyone); uploading and deleting are for editors.
CREATE POLICY sel ON core.site_assets FOR SELECT TO joybot_app USING (true);
CREATE POLICY sel ON core.site_asset_data FOR SELECT TO joybot_app USING (true);
CREATE POLICY ins ON core.site_assets FOR INSERT TO joybot_app
  WITH CHECK (authz.can_edit_website('create') OR authz.can_edit_website('update'));
CREATE POLICY ins ON core.site_asset_data FOR INSERT TO joybot_app
  WITH CHECK (authz.can_edit_website('create') OR authz.can_edit_website('update'));
CREATE POLICY del ON core.site_assets FOR DELETE TO joybot_app USING (authz.can_edit_website('delete'));
CREATE POLICY del ON core.site_asset_data FOR DELETE TO joybot_app USING (authz.can_edit_website('delete'));

/** What the public site shows about the business (settings are otherwise for signed-in principals). */
CREATE FUNCTION authz.site_info() RETURNS TABLE (business_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.business_name FROM core.settings s WHERE s.id = 1
$$;
REVOKE ALL ON FUNCTION authz.site_info() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.site_info() TO joybot_app;

-- Standard pages ----------------------------------------------------------------------------------
-- A starting point to edit: home, about us and contact us in the header; contact, privacy policy and
-- terms in the footer. The privacy policy and terms are generic and should be reviewed before relying on them.

INSERT INTO core.site_pages (slug, title, description, is_home, published, show_in_header, show_in_footer, sort_order, modules) VALUES
('home', 'Home', 'Book appointments, pay and get answers online.', true, true, false, false, 0, $json$[
  {"id": "home-intro", "type": "html", "html": "<h1>Welcome</h1><p>We're glad you're here. Book an appointment in a few clicks, pay your invoices online, and ask our assistant anything, any time.</p><p><a href=\"/portal/book\">Book an appointment</a></p>"},
  {"id": "home-features", "type": "columns", "heading": "Everything in one place", "columns": [
    {"heading": "Book online", "text": "Pick a service, a location and a time that suits you. We'll confirm it and remind you.", "link_label": "Book now", "link_url": "/portal/book"},
    {"heading": "Pay easily", "text": "See your invoices and pay by card or bank transfer, whenever it suits you.", "link_label": "Your invoices", "link_url": "/portal/invoices"},
    {"heading": "Ask anything", "text": "Our assistant knows your appointments, payments and our services, and answers right away.", "link_label": "Ask now", "link_url": "/portal"}
  ]}
]$json$),
('about', 'About us', 'Who we are and how we work.', false, true, true, false, 10, $json$[
  {"id": "about-story", "type": "html", "html": "<h1>About us</h1><p>Tell your story here: how you started, what you do best and what your customers can expect from you.</p><h2>Our values</h2><ul><li>Care in everything we do</li><li>Clear prices, no surprises</li><li>Always easy to reach</li></ul>"},
  {"id": "about-team", "type": "columns", "heading": "Our team", "columns": [
    {"heading": "Experienced", "text": "Introduce your team and what they're great at."},
    {"heading": "Friendly", "text": "Share what makes a visit with you different."},
    {"heading": "Local", "text": "Tell people where to find you and what's nearby."}
  ]}
]$json$),
('contact', 'Contact us', 'How to reach us, where to find us and when we are open.', false, true, true, true, 20, $json$[
  {"id": "contact-intro", "type": "html", "html": "<h1>Contact us</h1><p>We'd love to hear from you. The quickest way to reach us is to sign in and ask our assistant, or to book an appointment online.</p>"},
  {"id": "contact-ways", "type": "columns", "columns": [
    {"heading": "Visit", "text": "Your street address\nCity, postcode"},
    {"heading": "Call", "text": "Your phone number\nMonday to Friday, 9am to 6pm"},
    {"heading": "Write", "text": "hello@example.com\nWe reply within one business day."}
  ]}
]$json$),
('privacy-policy', 'Privacy policy', 'How we collect, use and protect your personal information.', false, true, false, true, 30, $json$[
  {"id": "privacy-text", "type": "html", "html": "<h1>Privacy policy</h1><p>This policy explains what personal information we collect, why we collect it and how we protect it.</p><h2>What we collect</h2><p>Your name and contact details, your appointments and payments, and the messages you send us or our assistant.</p><h2>How we use it</h2><p>To provide our services: to book and remind you of appointments, to take payments, and to answer your questions. We don't sell your information.</p><h2>Who we share it with</h2><p>Only the providers that help us run our service, such as payment processing, email and messaging, under agreements that protect your information.</p><h2>How long we keep it</h2><p>As long as you're a customer, and afterwards only as long as the law requires.</p><h2>Your choices</h2><p>You can see and update your details in your account, and ask us to correct or delete your information.</p><h2>Contact</h2><p>Questions about your privacy? <a href=\"/contact\">Contact us</a>.</p>"}
]$json$),
('terms', 'Terms and conditions', 'The terms for using our website and services.', false, true, false, true, 40, $json$[
  {"id": "terms-text", "type": "html", "html": "<h1>Terms and conditions</h1><p>By using our website and booking our services you agree to these terms.</p><h2>Bookings</h2><p>Appointments you request are confirmed by us. Please let us know as early as possible if you need to cancel or reschedule.</p><h2>Payments</h2><p>Prices are shown before you book. Invoices are due by the date shown on them.</p><h2>Your account</h2><p>Keep your sign-in details to yourself and tell us if you think someone else has used your account.</p><h2>Changes</h2><p>We may update these terms; the current version is always on this page.</p><h2>Contact</h2><p>Questions about these terms? <a href=\"/contact\">Contact us</a>.</p>"}
]$json$);
