-- M9.4 (Phase 3.5): one-shot idempotency flag for the IntentExtractor hook
-- in OrchestratorAgent. Set the first time `extractIntent` runs against a
-- user's first chat message; checked before a subsequent run so a reconnect
-- or a re-edit doesn't re-trigger the LLM call. M9.7's manual re-trigger
-- endpoint will also stamp this column.
--
-- Nullable timestamp (not boolean) so we can show "extracted N seconds ago"
-- in M9.8's IntentExtractedCard and so admins can audit when extraction
-- happened per chat.

-- AlterTable
ALTER TABLE "chat_params"
    ADD COLUMN "intent_extracted_at" TIMESTAMPTZ;
