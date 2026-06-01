-- Hot-fix follow-up to M9.6c (20260601100000_phase35_user_agents_skills).
--
-- Original policy assumed the seed connection bypasses RLS (the migration
-- comment literally says "running as the prisma superuser, which bypasses
-- RLS"). That's false on Render's free Postgres: the seed uses the same
-- `prsi_app` role as the live app, which is bound by FORCE ROW LEVEL
-- SECURITY. Seed insertion of `scope='first_party'` rows failed with:
--
--   ERROR: new row violates row-level security policy for table
--          "composable_skills"
--
-- Fix: widen the write policy to allow `first_party` and `community`
-- inserts WHEN there is no per-request user context set (i.e.,
-- `current_setting('app.user_id', true)` returns NULL). The service layer
-- (composable-skill.service.ts) ALREADY rejects non-`user_private` writes
-- via Zod before reaching the DB, so this widening is defense-in-depth:
-- only paths that bypass the service AND lack `app.user_id` can use it —
-- in practice, only the seed and future Phase 6 admin migrations.
--
-- Hand-written DROP-THEN-CREATE so re-running on already-migrated DBs is
-- safe.

DROP POLICY IF EXISTS "composable_skills_write_own" ON "composable_skills";

CREATE POLICY "composable_skills_write_own" ON "composable_skills"
  FOR ALL TO prsi_app
  USING (
    -- Own user_private rows
    (
      "scope" = 'user_private'
      AND "user_id" = current_setting('app.user_id', true)::uuid
    )
    -- Workspace-scoped rows (writable only by future Phase 6 admin path)
    OR ("scope" = 'workspace' AND "user_id" IS NULL)
    -- Seed / admin: first_party + community rows when no user context
    OR (
      ("scope" = 'first_party' OR "scope" = 'community')
      AND current_setting('app.user_id', true) IS NULL
    )
  )
  WITH CHECK (
    (
      "scope" = 'user_private'
      AND "user_id" = current_setting('app.user_id', true)::uuid
    )
    OR ("scope" = 'workspace' AND "user_id" IS NULL)
    OR (
      ("scope" = 'first_party' OR "scope" = 'community')
      AND current_setting('app.user_id', true) IS NULL
    )
  );
