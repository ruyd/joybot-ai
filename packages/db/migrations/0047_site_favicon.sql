-- Website setup: the browser tab icon (favicon) for the public site. NULL uses the logo, and without a
-- logo the app's own icon.
ALTER TABLE core.site_settings
  ADD COLUMN favicon_asset_id uuid REFERENCES core.site_assets(id) ON DELETE SET NULL;
