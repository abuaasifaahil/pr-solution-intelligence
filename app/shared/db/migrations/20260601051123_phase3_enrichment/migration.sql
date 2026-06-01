-- CreateEnum
CREATE TYPE "EnrichmentJobType" AS ENUM ('standard', 'reach');

-- CreateEnum
CREATE TYPE "EnrichmentJobStatus" AS ENUM ('queued', 'processing', 'completed', 'failed', 'partial');

-- CreateEnum
CREATE TYPE "EnrichmentBatchStatus" AS ENUM ('pending', 'processing', 'completed', 'failed', 'retrying');

-- NOTE: Prisma's migrate-diff wanted to DROP "articles_raw_data_gin" because the
-- index was created via raw SQL in the Phase 2 migration and is not declared in
-- schema.prisma. We INTENTIONALLY keep that index (it's used for raw_data lookups)
-- so the auto-generated DROP statement has been removed.

-- CreateTable
CREATE TABLE "enrichments" (
    "id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "batch_id" UUID,
    "sentiment" JSONB NOT NULL,
    "themes" JSONB NOT NULL,
    "emotion" JSONB NOT NULL,
    "entities" JSONB NOT NULL,
    "signals" JSONB NOT NULL,
    "reach" JSONB,
    "social_engagement" JSONB,
    "model_used" VARCHAR(100) NOT NULL,
    "tokens_input" INTEGER NOT NULL,
    "tokens_output" INTEGER NOT NULL,
    "processing_ms" INTEGER NOT NULL,
    "is_valid" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrichments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrichment_jobs" (
    "id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "total_articles" INTEGER NOT NULL,
    "processed_count" INTEGER NOT NULL DEFAULT 0,
    "batch_count" INTEGER NOT NULL,
    "batches_completed" INTEGER NOT NULL DEFAULT 0,
    "model_used" VARCHAR(100) NOT NULL,
    "enrichment_type" "EnrichmentJobType" NOT NULL,
    "total_tokens_input" BIGINT NOT NULL DEFAULT 0,
    "total_tokens_output" BIGINT NOT NULL DEFAULT 0,
    "status" "EnrichmentJobStatus" NOT NULL DEFAULT 'queued',
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "error_log" JSONB NOT NULL DEFAULT '[]',
    "dashboard_json" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrichment_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrichment_batches" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "batch_number" INTEGER NOT NULL,
    "article_ids" UUID[],
    "estimated_tokens" INTEGER NOT NULL,
    "actual_tokens_in" INTEGER,
    "actual_tokens_out" INTEGER,
    "status" "EnrichmentBatchStatus" NOT NULL DEFAULT 'pending',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "processing_ms" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrichment_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reach_cache" (
    "id" UUID NOT NULL,
    "domain" VARCHAR(255) NOT NULL,
    "monthly_visitors" BIGINT,
    "global_rank" INTEGER,
    "category" VARCHAR(100),
    "score" INTEGER,
    "raw_response" JSONB NOT NULL DEFAULT '{}',
    "fetched_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ttl_hours" INTEGER NOT NULL DEFAULT 168,
    "is_valid" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "reach_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "enrichments_article_id_key" ON "enrichments"("article_id");

-- CreateIndex
CREATE INDEX "enrichments_chat_id_idx" ON "enrichments"("chat_id");

-- CreateIndex
CREATE INDEX "enrichments_user_id_idx" ON "enrichments"("user_id");

-- CreateIndex
CREATE INDEX "enrichment_jobs_chat_id_idx" ON "enrichment_jobs"("chat_id");

-- CreateIndex
CREATE INDEX "enrichment_jobs_user_id_idx" ON "enrichment_jobs"("user_id");

-- CreateIndex
CREATE INDEX "enrichment_jobs_status_idx" ON "enrichment_jobs"("status");

-- CreateIndex
CREATE INDEX "enrichment_batches_job_id_idx" ON "enrichment_batches"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "reach_cache_domain_key" ON "reach_cache"("domain");

-- CreateIndex
CREATE INDEX "reach_cache_fetched_at_idx" ON "reach_cache"("fetched_at");

-- AddForeignKey
ALTER TABLE "enrichments" ADD CONSTRAINT "enrichments_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichments" ADD CONSTRAINT "enrichments_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichments" ADD CONSTRAINT "enrichments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichments" ADD CONSTRAINT "enrichments_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "enrichment_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichment_jobs" ADD CONSTRAINT "enrichment_jobs_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichment_jobs" ADD CONSTRAINT "enrichment_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichment_batches" ADD CONSTRAINT "enrichment_batches_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "enrichment_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── RLS: enrichments ───────────────────────────────────────────────────
ALTER TABLE enrichments ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichments FORCE ROW LEVEL SECURITY;
CREATE POLICY enrichments_owner ON enrichments
  FOR ALL TO prsi_app
  USING (user_id = current_setting('app.user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.user_id', true)::uuid);

-- ─── RLS: enrichment_jobs ───────────────────────────────────────────────
ALTER TABLE enrichment_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY enrichment_jobs_owner ON enrichment_jobs
  FOR ALL TO prsi_app
  USING (user_id = current_setting('app.user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.user_id', true)::uuid);

-- ─── RLS: enrichment_batches ───────────────────────────────────────────
-- No user_id column; isolation flows through enrichment_jobs.user_id
ALTER TABLE enrichment_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY enrichment_batches_owner ON enrichment_batches
  FOR ALL TO prsi_app
  USING (
    job_id IN (
      SELECT id FROM enrichment_jobs WHERE user_id = current_setting('app.user_id', true)::uuid
    )
  )
  WITH CHECK (
    job_id IN (
      SELECT id FROM enrichment_jobs WHERE user_id = current_setting('app.user_id', true)::uuid
    )
  );

-- ─── reach_cache is INTENTIONALLY GLOBAL ───────────────────────────────
-- Per docs/phase3.md "Open items": domain reach metrics are public data,
-- shared across all users to maximize cache hit rate. NO RLS.
-- Just grant the app role normal access.

-- ─── GIN indexes on enrichments JSONB columns ─────────────────────────
CREATE INDEX enrichments_sentiment_gin ON enrichments USING GIN (sentiment);
CREATE INDEX enrichments_themes_gin    ON enrichments USING GIN (themes);
CREATE INDEX enrichments_entities_gin  ON enrichments USING GIN (entities);
CREATE INDEX enrichments_signals_gin   ON enrichments USING GIN (signals);

-- ─── Grants for the app role ──────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON enrichments, enrichment_jobs, enrichment_batches, reach_cache TO prsi_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO prsi_app;
