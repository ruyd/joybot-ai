-- Website setup (Marketing › Website › Site setup): how the public site looks and what its header holds.
--
-- One row: a tagline under the business name, an optional logo (an uploaded site image, shown instead
-- of the JoyBot mark), the accent color and the gradient's second color, the heading and body fonts
-- (names from a fixed list the API checks; the fonts are bundled with the web app, nothing loads from
-- third parties), extra header links (to pages, sections on a page such as "/#services", or elsewhere),
-- an optional header button, and whether the header shows "Customer login".
--
-- The defaults keep the site looking as it did. Editors are the 'website' resource (as for pages);
-- anyone reads it, since the public site needs it to draw itself.
--
-- Page modules (jsonb, validated by the API) gain section options shared by every module (an anchor
-- for "#links", a background, a small label, a heading and an intro) and four new types: hero, cards
-- (up to twelve, with icons), faq and cta. No data changes: existing modules stay valid.

CREATE TABLE core.site_settings (
  id                  int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  tagline             text CHECK (length(tagline) <= 60),
  logo_asset_id       uuid REFERENCES core.site_assets(id) ON DELETE SET NULL,
  accent              text NOT NULL DEFAULT '#0878ab' CHECK (accent ~ '^#[0-9a-f]{6}$'),
  accent_to           text NOT NULL DEFAULT '#34868f' CHECK (accent_to ~ '^#[0-9a-f]{6}$'),
  heading_font        text NOT NULL DEFAULT 'system' CHECK (heading_font ~ '^[a-z0-9-]{1,40}$'),
  body_font           text NOT NULL DEFAULT 'system' CHECK (body_font ~ '^[a-z0-9-]{1,40}$'),
  header_links        jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(header_links) = 'array' AND jsonb_array_length(header_links) <= 8),
  header_button_label text CHECK (length(header_button_label) <= 40),
  header_button_url   text CHECK (length(header_button_url) <= 500),
  show_customer_login boolean NOT NULL DEFAULT true,
  updated_by          uuid REFERENCES core.users(id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((header_button_label IS NULL) = (header_button_url IS NULL))
);
INSERT INTO core.site_settings (id) VALUES (1);

CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.site_settings FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core.site_settings FOR EACH ROW EXECUTE FUNCTION core.audit_row();

ALTER TABLE core.site_settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE ON core.site_settings TO joybot_app;

CREATE POLICY sel ON core.site_settings FOR SELECT TO joybot_app USING (true);
CREATE POLICY upd ON core.site_settings FOR UPDATE TO joybot_app
  USING (authz.can_edit_website('update')) WITH CHECK (authz.can_edit_website('update'));
