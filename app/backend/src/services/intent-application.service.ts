/**
 * Translates an extracted Intent (M9.3) into chat_params updates (M7.5).
 *
 * Handles three wire-format mismatches between Intent and ChatParams:
 *   1. enrichmentType value-map:
 *      Intent.enrichmentType is 'enrichment' | 'enrichment_plus_reach'
 *      (BRD wording, what the LLM emits) while chat_params.enrichmentType
 *      is 'standard' | 'reach' (Phase 2 schema). We translate before
 *      writing.
 *   2. Date shape: Intent.dateStart/dateEnd are ISO strings; the chat_params
 *      service expects `Date | null`. We `new Date(iso)` before writing.
 *   3. Confidence filtering: each field is written ONLY when its confidence
 *      score meets `CONFIDENCE_THRESHOLD` (0.5). Below-threshold values are
 *      reported in `skippedDueToConfidence` so callers can log/observe.
 *
 * Null/empty values are skipped entirely (NOT counted as confidence skips)
 * because they represent "the user didn't mention this" rather than "the
 * LLM tried and we don't trust it".
 *
 * Returns the list of field keys actually written, for emission + logging.
 *
 * @file services/intent-application.service.ts
 */
import { patchParams, type PatchInput } from './chat-params.service.js';
import type { Intent, IntentFieldKey } from '../types/intent.js';

/** Single threshold per M9.4 spec — no per-field tuning. */
const CONFIDENCE_THRESHOLD = 0.5;

/**
 * BRD wording (what the LLM emits) → chat_params enum (what Phase 2 stored).
 * The IntentExtractor's prompt uses BRD-style values because they're more
 * human-readable; the DB enum stayed at the M7.5 names.
 */
const ENRICHMENT_TYPE_MAP: Record<
  'enrichment' | 'enrichment_plus_reach',
  'standard' | 'reach'
> = {
  enrichment: 'standard',
  enrichment_plus_reach: 'reach',
};

export interface ApplyIntentResult {
  /** Fields actually persisted via patchParams. */
  appliedFields: IntentFieldKey[];
  /** Fields the LLM tried to fill but whose confidence was below threshold. */
  skippedDueToConfidence: IntentFieldKey[];
}

/**
 * Apply non-null, sufficiently-confident Intent fields to chat_params.
 *
 * No-op for fields that are null/empty (user didn't mention) OR below
 * the confidence threshold (LLM wasn't sure). Caller (M9.4 orchestrator
 * hook) is responsible for chat ownership / RLS — `patchParams` wraps
 * the write in `withUser` so RLS is enforced at the row level.
 *
 * Skips calling `patchParams` entirely when there's nothing to write —
 * avoids emitting a spurious `flow:state-change` event on an empty patch.
 */
export async function applyIntentToChatParams(
  userId: string,
  chatId: string,
  intent: Intent,
): Promise<ApplyIntentResult> {
  const applied: IntentFieldKey[] = [];
  const skipped: IntentFieldKey[] = [];
  const patch: PatchInput = {};

  // brand
  if (intent.brand !== null) {
    if (intent.confidence.brand >= CONFIDENCE_THRESHOLD) {
      patch.brand = intent.brand;
      applied.push('brand');
    } else {
      skipped.push('brand');
    }
  }

  // dateRange — single confidence score gates both bounds. Only write when
  // BOTH start and end are present; a half-filled range is treated as "not
  // mentioned" so the wizard's date prompt still fires.
  if (intent.dateStart !== null && intent.dateEnd !== null) {
    if (intent.confidence.dateRange >= CONFIDENCE_THRESHOLD) {
      patch.dateStart = new Date(intent.dateStart);
      patch.dateEnd = new Date(intent.dateEnd);
      // The flow-engine's `getNextFlowState` checks dateStart; we also
      // stamp `dateRangeType: 'custom'` so downstream UI knows the dates
      // came from a user-specified range rather than an auto-detect.
      patch.dateRangeType = 'custom';
      applied.push('dateRange');
    } else {
      skipped.push('dateRange');
    }
  }

  // competitors — empty array = unfilled; populated = candidate. The
  // chat_params service stores competitors as a JSON array, plus a
  // separate `competitorSet` discriminator. We don't infer a preset
  // (top5/top3/top2) here because the user named specific competitors;
  // 'custom' is the right discriminator for a free-form list.
  if (intent.competitors.length > 0) {
    if (intent.confidence.competitors >= CONFIDENCE_THRESHOLD) {
      patch.competitors = intent.competitors;
      patch.competitorSet = 'custom';
      applied.push('competitors');
    } else {
      skipped.push('competitors');
    }
  }

  // intention
  if (intent.intention !== null) {
    if (intent.confidence.intention >= CONFIDENCE_THRESHOLD) {
      patch.intention = intent.intention;
      applied.push('intention');
    } else {
      skipped.push('intention');
    }
  }

  // enrichmentType — translate BRD wording to chat_params enum.
  if (intent.enrichmentType !== null) {
    if (intent.confidence.enrichmentType >= CONFIDENCE_THRESHOLD) {
      patch.enrichmentType = ENRICHMENT_TYPE_MAP[intent.enrichmentType];
      applied.push('enrichmentType');
    } else {
      skipped.push('enrichmentType');
    }
  }

  // mediaTypes
  if (intent.mediaTypes.length > 0) {
    if (intent.confidence.mediaTypes >= CONFIDENCE_THRESHOLD) {
      patch.mediaTypes = intent.mediaTypes;
      applied.push('mediaTypes');
    } else {
      skipped.push('mediaTypes');
    }
  }

  // dataSource — nullable on Intent. Empty/null is the default (csv_upload),
  // so a null value just means "user didn't say" and we leave the column
  // alone. Non-null + confident = write.
  if (intent.dataSource !== null) {
    if (intent.confidence.dataSource >= CONFIDENCE_THRESHOLD) {
      patch.dataSource = intent.dataSource;
      applied.push('dataSource');
    } else {
      skipped.push('dataSource');
    }
  }

  if (Object.keys(patch).length > 0) {
    await patchParams(userId, chatId, patch);
  }

  return { appliedFields: applied, skippedDueToConfidence: skipped };
}

/**
 * Stamp `chat_params.intent_extracted_at` so the M9.4 orchestrator hook
 * won't re-run extraction on a reconnect, replay, or follow-up message.
 *
 * Always called AFTER `applyIntentToChatParams` and AFTER the
 * `intent:extracted` event emission so that a partial failure of either
 * leaves the chat free to retry on the next user message.
 */
export async function markIntentExtracted(
  userId: string,
  chatId: string,
  at: Date = new Date(),
): Promise<void> {
  await patchParams(userId, chatId, { intentExtractedAt: at });
}
