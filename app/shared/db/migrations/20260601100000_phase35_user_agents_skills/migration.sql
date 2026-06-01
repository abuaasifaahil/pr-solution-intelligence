-- M9.6c (Phase 3.5): per-user agent + skill authoring tables.
--
-- Backs ADR-0003 Decision 4 ("per-user agent and skill ownership"). The
-- two new tables let analysts author private agents/skills inside their
-- profile; M9.7 will expose REST endpoints over them.
--
-- IMPORTANT NAMING DEVIATION FROM ADR:
--   ADR-0003 sketches the new skills table as `skills`, but a `skills`
--   table already exists from M5 (Phase 1 Settings — capability flags
--   like `sentiment_analysis`, `theme_classification`, …) and is used
--   by the live /api/v1/settings/skills endpoints + 5 skill.* tests
--   that must keep passing. To avoid breaking M5, this migration ships
--   the new ADR-0003 table as `composable_skills`. The Prisma model is
--   `ComposableSkill`. A future ADR (or Phase 5.5's M10.6) can rename
--   when the legacy M5 table is retired.
--
-- The `user_agents` table has no naming conflict and uses the ADR-spec
-- name directly.
--
-- Hand-written (no shadow DB on Render free tier — matches the M9.2 /
-- M9.5 pattern). Idempotent via IF NOT EXISTS / DROP-THEN-CREATE.

-- ─── ENUMS ─────────────────────────────────────────────────────────────
-- Wrap each CREATE TYPE in a DO block so re-running on an environment
-- where the enum already exists doesn't error.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SkillKind') THEN
    CREATE TYPE "SkillKind" AS ENUM (
      'analysis_skill',
      'source_skill',
      'enrichment_skill',
      'tool_skill',
      'alert_skill',
      'external_skill'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SkillScope') THEN
    CREATE TYPE "SkillScope" AS ENUM (
      'first_party',
      'workspace',
      'user_private',
      'community'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TrustLevel') THEN
    CREATE TYPE "TrustLevel" AS ENUM (
      'first_party',
      'verified',
      'community'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AgentKind') THEN
    CREATE TYPE "AgentKind" AS ENUM (
      'pr_impact',
      'brand_sentinel',
      'crisis_watch',
      'competitor_tracker'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AgentScope') THEN
    CREATE TYPE "AgentScope" AS ENUM (
      'user_private',
      'workspace_shared'
    );
  END IF;
END $$;

-- ─── composable_skills (ADR-0003 Decision 4 "skills" table) ────────────
CREATE TABLE IF NOT EXISTS "composable_skills" (
  "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
  "name"         TEXT         NOT NULL,
  "version"      TEXT         NOT NULL DEFAULT '1.0.0',
  "kind"         "SkillKind"  NOT NULL,
  "manifest"     JSONB        NOT NULL,
  "scope"        "SkillScope" NOT NULL,
  "user_id"      UUID,
  "workspace_id" UUID,
  "trust_level"  "TrustLevel" NOT NULL DEFAULT 'first_party',
  "enabled"      BOOLEAN      NOT NULL DEFAULT true,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "composable_skills_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "composable_skills_user_id_fkey"
    FOREIGN KEY ("user_id")
    REFERENCES "users"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "composable_skill_unique_per_scope"
  ON "composable_skills" ("scope", "user_id", "workspace_id", "name", "version");

CREATE INDEX IF NOT EXISTS "composable_skills_scope_enabled_idx"
  ON "composable_skills" ("scope", "enabled");

CREATE INDEX IF NOT EXISTS "composable_skills_user_id_enabled_idx"
  ON "composable_skills" ("user_id", "enabled");

-- ─── user_agents ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "user_agents" (
  "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
  "user_id"         UUID         NOT NULL,
  "name"            TEXT         NOT NULL,
  "base_agent_kind" "AgentKind"  NOT NULL,
  "customization"   JSONB        NOT NULL,
  "scope"           "AgentScope" NOT NULL DEFAULT 'user_private',
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "user_agents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_agents_user_id_fkey"
    FOREIGN KEY ("user_id")
    REFERENCES "users"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_agents_user_id_name_key"
  ON "user_agents" ("user_id", "name");

CREATE INDEX IF NOT EXISTS "user_agents_user_id_idx"
  ON "user_agents" ("user_id");

-- ─── RLS: composable_skills ────────────────────────────────────────────
-- Read policy: first-party rows visible to everyone, community rows
-- visible when enabled, user_private only to the owner. Workspace
-- visibility is deferred to Phase 6 when workspace_members exists.
--
-- Write policy: only own user_private rows. Workspace writes are blocked
-- in M9.6c (the policy admits scope='workspace' AND user_id IS NULL but
-- M9.7's service layer rejects scope='workspace' on create until the
-- Phase 6 admin path lands). First-party rows are written by the seed
-- function (running as the prisma superuser, which bypasses RLS).
ALTER TABLE "composable_skills" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "composable_skills" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "composable_skills_read" ON "composable_skills";
CREATE POLICY "composable_skills_read" ON "composable_skills"
  FOR SELECT TO prsi_app
  USING (
    "scope" = 'first_party'
    OR ("scope" = 'community' AND "enabled" = true)
    OR (
      "scope" = 'user_private'
      AND "user_id" = current_setting('app.user_id', true)::uuid
    )
  );

DROP POLICY IF EXISTS "composable_skills_write_own" ON "composable_skills";
CREATE POLICY "composable_skills_write_own" ON "composable_skills"
  FOR ALL TO prsi_app
  USING (
    (
      "scope" = 'user_private'
      AND "user_id" = current_setting('app.user_id', true)::uuid
    )
    OR ("scope" = 'workspace' AND "user_id" IS NULL)
  )
  WITH CHECK (
    (
      "scope" = 'user_private'
      AND "user_id" = current_setting('app.user_id', true)::uuid
    )
    OR ("scope" = 'workspace' AND "user_id" IS NULL)
  );

-- ─── RLS: user_agents (chat-table-style owner-only) ────────────────────
ALTER TABLE "user_agents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_agents" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_agents_per_user" ON "user_agents";
CREATE POLICY "user_agents_per_user" ON "user_agents"
  FOR ALL TO prsi_app
  USING (
    "user_id" = current_setting('app.user_id', true)::uuid
  )
  WITH CHECK (
    "user_id" = current_setting('app.user_id', true)::uuid
  );

-- ─── Grants to the non-superuser app role ──────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON "composable_skills" TO prsi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "user_agents" TO prsi_app;
