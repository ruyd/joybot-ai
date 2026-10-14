-- Website analytics: visits to the public site, counted by the API without cookies and stored only as
-- daily totals (a few hundred small rows a day at most), never as one row per visit.
--
-- A visitor is told apart for one day by a hash of their address and browser with a salt that changes
-- daily. Both the hashes and the salts are deleted after a day, so a visitor can't be followed from
-- one day to the next and nothing identifies them. Days are the business's days (settings time zone).

CREATE TABLE core.site_visit_days (
  day      date PRIMARY KEY,
  views    int NOT NULL DEFAULT 0,
  visitors int NOT NULL DEFAULT 0
);

CREATE TABLE core.site_visit_pages (
  day   date NOT NULL,
  path  text NOT NULL CHECK (length(path) <= 200),
  views int NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path)
);

-- Where visits came from: another site's host, or a campaign's utm_source. Counted once per arrival.
CREATE TABLE core.site_visit_sources (
  day    date NOT NULL,
  source text NOT NULL CHECK (length(source) <= 100),
  visits int NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source)
);

-- The device and country of each new visitor of the day ('' when the country is unknown).
CREATE TABLE core.site_visit_devices (
  day      date NOT NULL,
  device   text NOT NULL CHECK (device IN ('desktop', 'mobile', 'tablet')),
  visitors int NOT NULL DEFAULT 0,
  PRIMARY KEY (day, device)
);

CREATE TABLE core.site_visit_countries (
  day      date NOT NULL,
  country  text NOT NULL CHECK (country ~ '^([A-Z]{2})?$'),
  visitors int NOT NULL DEFAULT 0,
  PRIMARY KEY (day, country)
);

-- Today's (and yesterday's) salts and visitor hashes: no grants, only authz.record_site_visits uses them.
CREATE TABLE core.site_visit_salts (
  day  date PRIMARY KEY,
  salt bytea NOT NULL
);

CREATE TABLE core.site_visitors_seen (
  day  date NOT NULL,
  hash bytea NOT NULL,
  PRIMARY KEY (day, hash)
);

ALTER TABLE core.site_visit_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.site_visit_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.site_visit_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.site_visit_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.site_visit_countries ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.site_visit_salts ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.site_visitors_seen ENABLE ROW LEVEL SECURITY;

-- Website readers see the totals; nobody writes them except through the function below.
GRANT SELECT ON core.site_visit_days, core.site_visit_pages, core.site_visit_sources, core.site_visit_devices, core.site_visit_countries TO joybot_app;
CREATE POLICY sel ON core.site_visit_days FOR SELECT TO joybot_app USING (authz.can_edit_website('read'));
CREATE POLICY sel ON core.site_visit_pages FOR SELECT TO joybot_app USING (authz.can_edit_website('read'));
CREATE POLICY sel ON core.site_visit_sources FOR SELECT TO joybot_app USING (authz.can_edit_website('read'));
CREATE POLICY sel ON core.site_visit_devices FOR SELECT TO joybot_app USING (authz.can_edit_website('read'));
CREATE POLICY sel ON core.site_visit_countries FOR SELECT TO joybot_app USING (authz.can_edit_website('read'));

/**
 * Adds a batch of page views (the API collects them for a minute) to the daily totals. Each event:
 * {at, ident, path, source?, device, country?}, where `ident` (address and browser) is only hashed.
 * Anyone can send views to the site's beacon, so this takes no principal; it can only add to counts.
 */
CREATE FUNCTION authz.record_site_visits(p_events jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  tz text := coalesce((SELECT s.default_time_zone FROM core.settings s WHERE s.id = 1), 'UTC');
  today date := (now() AT TIME ZONE tz)::date;
BEGIN
  IF jsonb_typeof(p_events) IS DISTINCT FROM 'array' OR jsonb_array_length(p_events) = 0 THEN RETURN; END IF;
  IF jsonb_array_length(p_events) > 20000 THEN RAISE EXCEPTION 'too many events' USING ERRCODE = '22023'; END IF;

  CREATE TEMP TABLE _visits ON COMMIT DROP AS
    SELECT ((e->>'at')::timestamptz AT TIME ZONE tz)::date AS day,
           coalesce(e->>'ident', '') AS ident,
           left(e->>'path', 200) AS path,
           left(nullif(e->>'source', ''), 100) AS source,
           CASE WHEN e->>'device' IN ('mobile', 'tablet') THEN e->>'device' ELSE 'desktop' END AS device,
           CASE WHEN e->>'country' ~ '^[A-Z]{2}$' THEN e->>'country' ELSE '' END AS country,
           ord
    FROM jsonb_array_elements(p_events) WITH ORDINALITY AS t(e, ord)
    WHERE e->>'path' LIKE '/%';
  -- Only today and yesterday (a batch can straddle midnight); older salts are gone.
  DELETE FROM _visits WHERE day NOT IN (today, today - 1);

  INSERT INTO core.site_visit_salts (day, salt)
    SELECT DISTINCT day, decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex') FROM _visits
    ON CONFLICT (day) DO NOTHING;

  -- Each visitor's first view of the day in this batch, and whether the day had seen them already.
  CREATE TEMP TABLE _new ON COMMIT DROP AS
    WITH firsts AS (
      SELECT DISTINCT ON (v.day, h.hash) v.day, h.hash, v.device, v.country
      FROM _visits v
      JOIN core.site_visit_salts s ON s.day = v.day
      CROSS JOIN LATERAL (SELECT sha256(s.salt || convert_to(v.ident, 'UTF8')) AS hash) h
      ORDER BY v.day, h.hash, v.ord
    ), inserted AS (
      INSERT INTO core.site_visitors_seen (day, hash) SELECT day, hash FROM firsts
      ON CONFLICT DO NOTHING RETURNING day, hash
    )
    SELECT f.day, f.device, f.country FROM firsts f JOIN inserted i USING (day, hash);

  INSERT INTO core.site_visit_days AS d (day, views, visitors)
    SELECT v.day, count(*), (SELECT count(*) FROM _new n WHERE n.day = v.day) FROM _visits v GROUP BY v.day
    ON CONFLICT (day) DO UPDATE SET views = d.views + EXCLUDED.views, visitors = d.visitors + EXCLUDED.visitors;
  INSERT INTO core.site_visit_pages AS p (day, path, views)
    SELECT day, path, count(*) FROM _visits GROUP BY day, path
    ON CONFLICT (day, path) DO UPDATE SET views = p.views + EXCLUDED.views;
  INSERT INTO core.site_visit_sources AS s (day, source, visits)
    SELECT day, source, count(*) FROM _visits WHERE source IS NOT NULL GROUP BY day, source
    ON CONFLICT (day, source) DO UPDATE SET visits = s.visits + EXCLUDED.visits;
  INSERT INTO core.site_visit_devices AS d (day, device, visitors)
    SELECT day, device, count(*) FROM _new GROUP BY day, device
    ON CONFLICT (day, device) DO UPDATE SET visitors = d.visitors + EXCLUDED.visitors;
  INSERT INTO core.site_visit_countries AS c (day, country, visitors)
    SELECT day, country, count(*) FROM _new GROUP BY day, country
    ON CONFLICT (day, country) DO UPDATE SET visitors = c.visitors + EXCLUDED.visitors;

  -- Forget visitors (and the salts that could link them) once their day is over.
  DELETE FROM core.site_visitors_seen WHERE day < today - 1;
  DELETE FROM core.site_visit_salts WHERE day < today - 1;
END
$$;
REVOKE ALL ON FUNCTION authz.record_site_visits(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.record_site_visits(jsonb) TO joybot_app;
