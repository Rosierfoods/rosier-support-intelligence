-- Row-level security: organisation isolation.
--
-- The web app runs every request inside a transaction that does
--   SET LOCAL ROLE rsi_app;  SELECT set_config('app.org_id', '<org uuid>', true);
-- so all reads/writes from user requests are confined to the caller's organisation.
--
-- Trusted system code (migrations, login lookup, webhook routing, the background worker)
-- runs as the migration owner, which has an explicit "owner" policy.
-- Supabase's PostgREST roles (anon, authenticated) get no policies and no grants,
-- so the tables are not reachable through the Supabase auto-generated REST API.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rsi_app') THEN
    CREATE ROLE rsi_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- allow the connecting (owner) user to switch into rsi_app
DO $$
BEGIN
  EXECUTE format('GRANT rsi_app TO %I', current_user);
EXCEPTION WHEN others THEN
  RAISE NOTICE 'could not grant rsi_app to %: %', current_user, SQLERRM;
END $$;

GRANT USAGE ON SCHEMA public TO rsi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rsi_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rsi_app;

CREATE OR REPLACE FUNCTION rsi_current_org() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

DO $$
DECLARE t text;
BEGIN
  -- organisations: a user can see only their own org row
  ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
  ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
  EXECUTE 'CREATE POLICY org_isolation ON organizations TO rsi_app USING (id = rsi_current_org()) WITH CHECK (id = rsi_current_org())';
  EXECUTE format('CREATE POLICY owner_all ON organizations TO %I USING (true) WITH CHECK (true)', current_user);

  FOR t IN SELECT c.table_name FROM information_schema.columns c
           JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
           WHERE c.table_schema = current_schema() AND c.column_name = 'org_id' AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I TO rsi_app USING (org_id = rsi_current_org()) WITH CHECK (org_id = rsi_current_org())', t);
    EXECUTE format('CREATE POLICY owner_all ON %I TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;

-- Lock out Supabase API roles if they exist (no-op on plain Postgres)
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
    END IF;
  END LOOP;
END $$;
