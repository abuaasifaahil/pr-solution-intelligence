-- M9.5 (Phase 3.5): SearchAgent memory + Article dedup-on-rerun.
--
-- Hand-written per the M9.2 deviation #2 (no shadow DB on Render free
-- tier). Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT
-- EXISTS guard fresh-environment reruns, and the policy / FK / table
-- creation is wrapped via DROP-then-CREATE patterns matching the M9.2
-- migration style.

-- ─── articles.open_search_id + partial UNIQUE index ─────────────────────
-- The column is nullable because the existing CSV path leaves it NULL.
-- The unique index is partial (WHERE open_search_id IS NOT NULL) so the
-- thousands of CSV-uploaded rows with (chat_id, NULL) don't collide.
ALTER TABLE "articles"
  ADD COLUMN IF NOT EXISTS "open_search_id" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "article_chat_opensearch_unique"
  ON "articles"("chat_id", "open_search_id")
  WHERE "open_search_id" IS NOT NULL;

-- ─── search_history table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "search_history" (
  "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
  "chat_id"         UUID         NOT NULL,
  "query_hash"      VARCHAR(64)  NOT NULL,
  "article_ids"     TEXT[]       NOT NULL,
  "total_hits"      INTEGER      NOT NULL,
  "indices_queried" TEXT[]       NOT NULL,
  "coverage_reach"  DOUBLE PRECISION,
  "executed_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "search_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "search_history_chat_id_fkey"
    FOREIGN KEY ("chat_id")
    REFERENCES "chats"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "search_history_chat_id_query_hash_idx"
  ON "search_history"("chat_id", "query_hash");

CREATE INDEX IF NOT EXISTS "search_history_chat_id_executed_at_idx"
  ON "search_history"("chat_id", "executed_at" DESC);

-- ─── RLS: search_history (chat-scoped, matches boolean_queries pattern) ─
ALTER TABLE "search_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "search_history" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "search_history_owner" ON "search_history";
CREATE POLICY "search_history_owner" ON "search_history"
  FOR ALL TO prsi_app
  USING (
    "chat_id" IN (
      SELECT "id" FROM "chats" WHERE "user_id" = current_setting('app.user_id', true)::uuid
    )
  )
  WITH CHECK (
    "chat_id" IN (
      SELECT "id" FROM "chats" WHERE "user_id" = current_setting('app.user_id', true)::uuid
    )
  );

-- ─── Grants to the non-superuser app role ───────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON "search_history" TO prsi_app;
