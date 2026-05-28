-- Grant prsi_app the same privileges on any FUTURE tables created in this schema
-- so that M3+ tables don't silently fall through RLS. Without ALTER DEFAULT
-- PRIVILEGES every new migration that adds a table would need a manual GRANT
-- statement; this is easy to forget and produces obscure permission errors
-- inside withUser transactions.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO prsi_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO prsi_app;
