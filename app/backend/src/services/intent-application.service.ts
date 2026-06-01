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
 * M9.6b — adds a feature-flagged supplement path. When
 * `ENABLE_SAMPLE_CLASSIFIER_SUPPLEMENT=true` AND the LLM left brand at
 * low confidence AND a data source is attached, we ask the heuristic
 * `SampleClassifier` for a sample-derived inference and apply it for
 * fields the LLM left null. Default OFF — production behavior unchanged.
 *
 * @file services/intent-application.service.ts
 */
import { patchParams, type PatchInput } from './chat-params.service.js';
import { withUser } from '../lib/prisma-rls.js';
import { sampleClassifier } from '../lib/sample-classifier.js';
import { createAdapter } from '../data-sources/registry.js';
import { resolveOpenSearchConfig } from '../data-sources/opensearch/config-resolver.js';
import type {
  AttachedSourceSnapshot,
  ProbingResult,
} from '../agents/probing-agent.js';
import type { NormalizedArticle } from '../data-sources/adapter.js';
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
  /** M9.6b — fields supplemented by the sample classifier (only when the
   *  feature flag is on and the gate conditions are met). Empty in
   *  production today. */
  supplementedFromSample?: IntentFieldKey[];
  /** M9.6b — probes emitted by the classifier that the orchestrator can
   *  forward to the UI in M9.7+. Present only when the supplement ran. */
  probes?: ProbingResult['probes'];
}

/** Below this LLM brand-confidence we consider triggering the sample
 *  classifier supplement (when the feature flag is on). 0.5 is the same
 *  threshold the unfilled-fields helper uses. */
const SUPPLEMENT_BRAND_CONFIDENCE_THRESHOLD = 0.5;
/** Inferred-field confidence floor for accepting a classifier inference
 *  when the LLM left the field null. Slightly above the apply threshold
 *  so we don't promote tenuous heuristic guesses into chat_params. */
const SUPPLEMENT_INFERRED_CONFIDENCE_FLOOR = 0.6;
/** Cap on sample size pulled from each adapter. Matches the ProbingAgent
 *  contract ("up to ~25 rows"). */
const SAMPLE_LIMIT = 25;

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

  // ── M9.6b — feature-flagged sample-classifier supplement ──────────────
  // Gate: env flag ON, LLM brand confidence < 0.5, AND a source is
  // attached for this chat. Default-off — production behavior unchanged.
  let supplementedFromSample: IntentFieldKey[] | undefined;
  let probes: ProbingResult['probes'] | undefined;
  if (
    process.env.ENABLE_SAMPLE_CLASSIFIER_SUPPLEMENT === 'true' &&
    intent.confidence.brand < SUPPLEMENT_BRAND_CONFIDENCE_THRESHOLD
  ) {
    const supp = await tryClassifierSupplement(userId, chatId, applied);
    if (supp) {
      supplementedFromSample = supp.supplemented;
      probes = supp.probes;
    }
  }

  return {
    appliedFields: applied,
    skippedDueToConfidence: skipped,
    ...(supplementedFromSample !== undefined ? { supplementedFromSample } : {}),
    ...(probes !== undefined ? { probes } : {}),
  };
}

/**
 * M9.6b — attempt the sample-classifier supplement. Returns null when no
 * source is attached (gate condition unmet). Returns the result and the
 * set of fields that were upgraded from "LLM didn't fill" to "classifier
 * inferred with confidence > 0.6".
 *
 * Errors are swallowed (logged in real callers) — a flaky classifier
 * supplement MUST NOT break the chat-creation flow.
 */
async function tryClassifierSupplement(
  userId: string,
  chatId: string,
  alreadyApplied: IntentFieldKey[],
): Promise<{ supplemented: IntentFieldKey[]; probes: ProbingResult['probes'] } | null> {
  try {
    const snapshots = await collectAdapterSamples(userId, chatId);
    if (snapshots.length === 0) return null; // No source attached — skip.

    // Read the current chat_params so the classifier respects user-set
    // fields (it won't probe for brand if the user already set it).
    const params = await withUser(userId, async (tx) =>
      tx.chatParams.findUnique({ where: { chatId } }),
    );
    if (!params) return null;

    const result = await sampleClassifier.classifyAndProbe({
      userId,
      chatId,
      prompt: null,
      attachedSources: snapshots,
      existingChatParams: params,
    });

    const supplementPatch: PatchInput = {};
    const supplemented: IntentFieldKey[] = [];

    // Apply ONLY to fields the LLM left null AND the classifier rated
    // above the supplement floor.
    if (
      !alreadyApplied.includes('brand') &&
      params.brand == null &&
      result.inferred.brand != null &&
      (result.confidence.brand ?? 0) >= SUPPLEMENT_INFERRED_CONFIDENCE_FLOOR
    ) {
      supplementPatch.brand = result.inferred.brand;
      supplemented.push('brand');
    }
    if (
      !alreadyApplied.includes('dateRange') &&
      params.dateStart == null &&
      params.dateEnd == null &&
      result.inferred.dateStart != null &&
      result.inferred.dateEnd != null &&
      (result.confidence.dateRange ?? 0) >= SUPPLEMENT_INFERRED_CONFIDENCE_FLOOR
    ) {
      supplementPatch.dateStart = result.inferred.dateStart;
      supplementPatch.dateEnd = result.inferred.dateEnd;
      supplementPatch.dateRangeType = 'auto_detected';
      supplemented.push('dateRange');
    }

    if (Object.keys(supplementPatch).length > 0) {
      await patchParams(userId, chatId, supplementPatch);
    }

    return { supplemented, probes: result.probes };
  } catch {
    // Best-effort. Never break chat creation.
    return null;
  }
}

/**
 * Build one `AttachedSourceSnapshot` per attached data source for the
 * chat. Today (pre-M9.11) there's at most ONE source per chat — encoded
 * in `chat_params.dataSource` + the optional upload. M9.11 will iterate
 * `chat_data_sources` instead.
 *
 * Returns an empty array when the resolved adapter can't produce a
 * sample (e.g. csv_upload without an uploaded file, or opensearch with
 * no resolvable config).
 */
async function collectAdapterSamples(
  userId: string,
  chatId: string,
): Promise<AttachedSourceSnapshot[]> {
  const params = await withUser(userId, async (tx) =>
    tx.chatParams.findUnique({ where: { chatId } }),
  );
  if (!params) return [];

  // Synthetic source id — M9.11 will replace this with the row id from
  // chat_data_sources. The classifier uses it only as an opaque tag.
  const sourceId = `${chatId}:${params.dataSource}`;

  // Build an "empty" structured query — sampling doesn't need the real
  // boolean query and the adapters that read it (OS) accept a noop one.
  const structured: import('../lib/boolean-query-engine.js').BooleanQueryStructured = {
    brand: '',
    brandFields: ['title'],
    competitors: [],
    competitorFields: ['content'],
    dateRange: null,
    language: 'en',
  };

  if (params.dataSource === 'csv_upload') {
    if (!params.uploadId) return [];
    const adapter = createAdapter({
      kind: 'csv_upload',
      config: { uploadId: params.uploadId },
    });
    const articles = await drainOneSampleBatch(adapter, {
      userId,
      chatId,
      config: { uploadId: params.uploadId },
      structured,
      mediaTypes: [],
      sampleLimit: SAMPLE_LIMIT,
    });
    return [
      {
        sourceId,
        kind: 'csv_upload',
        sampleArticles: articles,
        declaredCapabilities: adapter.declaredCapabilities(),
      },
    ];
  }

  if (params.dataSource === 'opensearch') {
    const osConfig = await resolveOpenSearchConfig(userId);
    if (!osConfig) return [];
    const adapter = createAdapter({ kind: 'opensearch', config: osConfig });
    const articles = await drainOneSampleBatch(adapter, {
      userId,
      chatId,
      config: osConfig,
      structured,
      mediaTypes: [],
      sampleLimit: SAMPLE_LIMIT,
    });
    return [
      {
        sourceId,
        kind: 'opensearch',
        sampleArticles: articles,
        declaredCapabilities: adapter.declaredCapabilities(),
      },
    ];
  }

  return [];
}

/**
 * Pull one sample batch out of an adapter's async iterable. Adapters in
 * sample mode yield a single batch then stop; we still drain defensively
 * in case a future adapter ignores the cap.
 */
async function drainOneSampleBatch(
  adapter: { fetch: (ctx: import('../data-sources/adapter.js').FetchContext) => AsyncIterable<{ articles: NormalizedArticle[] }> },
  ctx: import('../data-sources/adapter.js').FetchContext,
): Promise<NormalizedArticle[]> {
  const out: NormalizedArticle[] = [];
  for await (const batch of adapter.fetch(ctx)) {
    out.push(...batch.articles);
    if (out.length >= (ctx.sampleLimit ?? Number.MAX_SAFE_INTEGER)) break;
  }
  return out.slice(0, ctx.sampleLimit ?? out.length);
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
