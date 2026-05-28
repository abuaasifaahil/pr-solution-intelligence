-- Enable RLS on user-owned tables
ALTER TABLE users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE chats           ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_sources    ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_configs     ENABLE ROW LEVEL SECURITY;

-- Force RLS even for superusers — defense in depth.
ALTER TABLE users           FORCE ROW LEVEL SECURITY;
ALTER TABLE chats           FORCE ROW LEVEL SECURITY;
ALTER TABLE data_sources    FORCE ROW LEVEL SECURITY;
ALTER TABLE mcp_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE llm_configs     FORCE ROW LEVEL SECURITY;

-- users: a user can only SELECT / UPDATE their own row.
CREATE POLICY users_self_select ON users
  FOR SELECT
  USING (current_setting('app.user_id', true)::uuid = id);
CREATE POLICY users_self_update ON users
  FOR UPDATE
  USING (current_setting('app.user_id', true)::uuid = id);

-- chats: scoped by user_id.
CREATE POLICY chats_owner_all ON chats
  FOR ALL
  USING (current_setting('app.user_id', true)::uuid = user_id)
  WITH CHECK (current_setting('app.user_id', true)::uuid = user_id);

-- data_sources: scoped by user_id.
CREATE POLICY data_sources_owner_all ON data_sources
  FOR ALL
  USING (current_setting('app.user_id', true)::uuid = user_id)
  WITH CHECK (current_setting('app.user_id', true)::uuid = user_id);

-- mcp_connections: scoped by user_id.
CREATE POLICY mcp_connections_owner_all ON mcp_connections
  FOR ALL
  USING (current_setting('app.user_id', true)::uuid = user_id)
  WITH CHECK (current_setting('app.user_id', true)::uuid = user_id);

-- llm_configs: scoped by user_id.
CREATE POLICY llm_configs_owner_all ON llm_configs
  FOR ALL
  USING (current_setting('app.user_id', true)::uuid = user_id)
  WITH CHECK (current_setting('app.user_id', true)::uuid = user_id);

-- Note: INSERT and DELETE on users are admin-only — no policy means denied with FORCE RLS.
-- Migrations and seed scripts run as the prsi superuser which has BYPASSRLS implicitly,
-- so they can INSERT into users without policy.
