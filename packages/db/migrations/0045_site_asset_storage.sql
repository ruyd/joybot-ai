-- Website images in an S3-compatible bucket (Cloudflare R2 on the free-tier deploy, docs/deploy-free.md).
--
-- core.site_assets.storage: 'db' keeps the bytes in core.site_asset_data (as before; AWS and local
-- development); 's3' means the API put them in the bucket as `site/<id>`, served from the CDN, with no
-- row in core.site_asset_data. Images already in the database are moved by an editor from the
-- website's images (authz.site_asset_moved, after the API has uploaded the copy).

ALTER TABLE core.site_assets
  ADD COLUMN storage text NOT NULL DEFAULT 'db' CHECK (storage IN ('db', 's3'));

-- Called by the API once an image's bytes are in the bucket: marks it stored there and drops the copy
-- in the database. Editors only (the same as uploading).
CREATE FUNCTION authz.site_asset_moved(p_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT (authz.can_edit_website('create') OR authz.can_edit_website('update')) THEN
    RAISE EXCEPTION 'not allowed to move website images' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE core.site_assets SET storage = 's3' WHERE id = p_id AND storage = 'db';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'image not found or already moved' USING ERRCODE = 'no_data_found';
  END IF;
  DELETE FROM core.site_asset_data WHERE asset_id = p_id;
END $$;

REVOKE ALL ON FUNCTION authz.site_asset_moved(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.site_asset_moved(uuid) TO joybot_app;
