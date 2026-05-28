-- Create a non-superuser application role so RLS policies apply during app queries.
-- The prsi superuser always bypasses RLS; application queries must SET LOCAL ROLE
-- to prsi_app (which is not a superuser and has NOBYPASSRLS) so that RLS policies
-- are enforced. This is the standard Postgres RLS pattern for apps with a single
-- superuser connection.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'prsi_app') THEN
    CREATE ROLE prsi_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT CONNECT ON DATABASE prsi TO prsi_app;
GRANT USAGE ON SCHEMA public TO prsi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO prsi_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO prsi_app;
-- Allow the prsi superuser to SET ROLE to prsi_app within transactions.
GRANT prsi_app TO prsi;
