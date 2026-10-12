-- Website setup: the name the public site shows (header, footer, page titles). Blank means the
-- business name from the business settings, which needs the settings permission to change and is also
-- used in messages and by the assistant; this one is for website editors.

ALTER TABLE core.site_settings ADD COLUMN site_name text CHECK (length(btrim(site_name)) BETWEEN 1 AND 80);
