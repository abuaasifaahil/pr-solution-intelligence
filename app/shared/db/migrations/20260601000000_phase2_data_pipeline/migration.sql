-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('uploading', 'parsing', 'ready', 'error');

-- CreateEnum
CREATE TYPE "FlowState" AS ENUM ('init', 'collect_dates', 'collect_enrichment', 'collect_brand', 'collect_competitors', 'collect_intention', 'generate_query', 'processing', 'complete');

-- CreateEnum
CREATE TYPE "DateRangeType" AS ENUM ('weekly', 'ten_days', 'twenty_days', 'custom', 'auto_detected');

-- CreateEnum
CREATE TYPE "EnrichmentType" AS ENUM ('standard', 'reach');

-- CreateEnum
CREATE TYPE "CompetitorSet" AS ENUM ('top5', 'top3', 'top2', 'custom');

-- CreateEnum
CREATE TYPE "Intention" AS ENUM ('intention_based', 'comment_based');

-- CreateTable
CREATE TABLE "uploads" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(50) NOT NULL,
    "file_path" VARCHAR(500) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "row_count" INTEGER,
    "column_count" INTEGER,
    "schema_detected" JSONB NOT NULL DEFAULT '[]',
    "date_column" VARCHAR(100),
    "date_range_start" DATE,
    "date_range_end" DATE,
    "status" "UploadStatus" NOT NULL DEFAULT 'uploading',
    "error_message" TEXT,
    "parsed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "articles" (
    "id" UUID NOT NULL,
    "upload_id" UUID,
    "chat_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT,
    "description" TEXT,
    "source" VARCHAR(255),
    "author" VARCHAR(255),
    "published_date" DATE,
    "url" TEXT,
    "publisher_domain" VARCHAR(255),
    "language" VARCHAR(10) NOT NULL DEFAULT 'en',
    "raw_data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_params" (
    "id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "flow_state" "FlowState" NOT NULL DEFAULT 'init',
    "date_range_type" "DateRangeType",
    "date_start" DATE,
    "date_end" DATE,
    "enrichment_type" "EnrichmentType",
    "reach_threshold" INTEGER,
    "brand" VARCHAR(255),
    "competitors" JSONB NOT NULL DEFAULT '[]',
    "competitor_set" "CompetitorSet",
    "intention" "Intention",
    "has_upload" BOOLEAN NOT NULL DEFAULT false,
    "upload_id" UUID,
    "collected_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "chat_params_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "boolean_queries" (
    "id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "chat_params_id" UUID NOT NULL,
    "query_text" TEXT NOT NULL,
    "query_structured" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "confirmed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "boolean_queries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "uploads_user_id_chat_id_idx" ON "uploads"("user_id", "chat_id");

-- CreateIndex
CREATE INDEX "uploads_status_idx" ON "uploads"("status");

-- CreateIndex
CREATE INDEX "uploads_created_at_idx" ON "uploads"("created_at");

-- CreateIndex
CREATE INDEX "articles_chat_id_idx" ON "articles"("chat_id");

-- CreateIndex
CREATE INDEX "articles_user_id_idx" ON "articles"("user_id");

-- CreateIndex
CREATE INDEX "articles_upload_id_idx" ON "articles"("upload_id");

-- CreateIndex
CREATE INDEX "articles_published_date_idx" ON "articles"("published_date");

-- CreateIndex
CREATE INDEX "articles_publisher_domain_idx" ON "articles"("publisher_domain");

-- CreateIndex
CREATE UNIQUE INDEX "chat_params_chat_id_key" ON "chat_params"("chat_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_params_upload_id_key" ON "chat_params"("upload_id");

-- CreateIndex
CREATE INDEX "boolean_queries_chat_id_idx" ON "boolean_queries"("chat_id");

-- AddForeignKey
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "articles" ADD CONSTRAINT "articles_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "uploads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "articles" ADD CONSTRAINT "articles_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "articles" ADD CONSTRAINT "articles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_params" ADD CONSTRAINT "chat_params_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_params" ADD CONSTRAINT "chat_params_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_params" ADD CONSTRAINT "chat_params_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "uploads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "boolean_queries" ADD CONSTRAINT "boolean_queries_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "boolean_queries" ADD CONSTRAINT "boolean_queries_chat_params_id_fkey" FOREIGN KEY ("chat_params_id") REFERENCES "chat_params"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── RLS: uploads ───────────────────────────────────────────────────────
ALTER TABLE uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE uploads FORCE ROW LEVEL SECURITY;
CREATE POLICY uploads_owner ON uploads
  FOR ALL TO prsi_app
  USING (user_id = current_setting('app.user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.user_id', true)::uuid);

-- ─── RLS: articles ──────────────────────────────────────────────────────
ALTER TABLE articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE articles FORCE ROW LEVEL SECURITY;
CREATE POLICY articles_owner ON articles
  FOR ALL TO prsi_app
  USING (user_id = current_setting('app.user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.user_id', true)::uuid);

-- ─── RLS: chat_params ───────────────────────────────────────────────────
ALTER TABLE chat_params ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_params FORCE ROW LEVEL SECURITY;
CREATE POLICY chat_params_owner ON chat_params
  FOR ALL TO prsi_app
  USING (user_id = current_setting('app.user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.user_id', true)::uuid);

-- ─── RLS: boolean_queries ───────────────────────────────────────────────
-- boolean_queries has no user_id column; isolation via chat_id → chats.user_id
ALTER TABLE boolean_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE boolean_queries FORCE ROW LEVEL SECURITY;
CREATE POLICY boolean_queries_owner ON boolean_queries
  FOR ALL TO prsi_app
  USING (
    chat_id IN (
      SELECT id FROM chats WHERE user_id = current_setting('app.user_id', true)::uuid
    )
  )
  WITH CHECK (
    chat_id IN (
      SELECT id FROM chats WHERE user_id = current_setting('app.user_id', true)::uuid
    )
  );

-- ─── Bulk-insert perf: GIN index on raw_data ──────────────────────────
CREATE INDEX articles_raw_data_gin ON articles USING GIN (raw_data);

-- ─── Grant table access to non-superuser role used by the app ─────────
-- (ALTER DEFAULT PRIVILEGES from the 20260529024956_add_default_privileges
-- migration already covers future tables, but we restate these grants here
-- so this migration is self-contained and idempotent in fresh environments
-- where someone applies migrations out of the documented order.)
GRANT SELECT, INSERT, UPDATE, DELETE ON uploads, articles, chat_params, boolean_queries TO prsi_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO prsi_app;
