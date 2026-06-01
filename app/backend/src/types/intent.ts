/**
 * Structured intent extracted from a user's free-text first message.
 *
 * Every field is nullable — the LLM only sets a value when it's explicitly
 * present (or strongly implied) in the user's message. `confidence` gives
 * a per-field 0..1 score; M9.4 uses a threshold (default 0.5) to decide
 * whether to trust the extraction or re-prompt the user.
 *
 * Field shapes match `chat_params` columns exactly so M9.4 can call
 * `patchParams` with the extracted object minus nulls.
 *
 * @file types/intent.ts
 */
import { z } from 'zod';
import { MediaTypeSchema } from '../lib/media-types.js';
import { DataSourceSchema } from '../services/chat-params.service.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const IntentSchema = z.object({
  brand: z.string().min(1).max(200).nullable(),
  dateStart: z.string().regex(ISO_DATE).nullable(),
  dateEnd: z.string().regex(ISO_DATE).nullable(),
  // Bounded to 10 to keep token costs predictable. Hallucinated extras
  // get dropped at validate time. The prompt instructs the LLM to emit
  // `[]` (not omit) when no competitors are named — we don't `.default([])`
  // because that produces an optional input-type that confuses TS narrowing
  // through llm-gateway's generic `ZodSchema<T>`. The empty-array signal is
  // load-bearing for the M9.4 wizard-skip logic.
  competitors: z.array(z.string().min(1).max(200)).max(10),
  intention: z.enum(['intention_based', 'comment_based']).nullable(),
  enrichmentType: z.enum(['enrichment', 'enrichment_plus_reach']).nullable(),
  mediaTypes: z.array(MediaTypeSchema),
  dataSource: DataSourceSchema.nullable(),
  confidence: z.object({
    brand: z.number().min(0).max(1),
    dateRange: z.number().min(0).max(1),
    competitors: z.number().min(0).max(1),
    intention: z.number().min(0).max(1),
    enrichmentType: z.number().min(0).max(1),
    mediaTypes: z.number().min(0).max(1),
    dataSource: z.number().min(0).max(1),
  }),
});

export type Intent = z.infer<typeof IntentSchema>;

/** Per-field labels exposed to the IntentExtractedCard (M9.8). */
export type IntentFieldKey =
  | 'brand'
  | 'dateRange'
  | 'competitors'
  | 'intention'
  | 'enrichmentType'
  | 'mediaTypes'
  | 'dataSource';

/**
 * Returns the list of fields the LLM either left null OR rated below
 * the confidence threshold. M9.4 uses this to drive flow-state jumps
 * (skip slots that ARE filled-and-confident).
 *
 * `dateRange` is treated as a single slot — null if either bound is null.
 * `competitors` and `mediaTypes` count as unfilled when the array is empty
 * (their null-ish state).
 */
export function unfilledFields(intent: Intent, confidenceThreshold = 0.5): IntentFieldKey[] {
  const out: IntentFieldKey[] = [];
  if (intent.brand === null || intent.confidence.brand < confidenceThreshold) out.push('brand');
  if (
    intent.dateStart === null ||
    intent.dateEnd === null ||
    intent.confidence.dateRange < confidenceThreshold
  )
    out.push('dateRange');
  if (
    intent.competitors.length === 0 ||
    intent.confidence.competitors < confidenceThreshold
  )
    out.push('competitors');
  if (intent.intention === null || intent.confidence.intention < confidenceThreshold)
    out.push('intention');
  if (
    intent.enrichmentType === null ||
    intent.confidence.enrichmentType < confidenceThreshold
  )
    out.push('enrichmentType');
  if (intent.mediaTypes.length === 0 || intent.confidence.mediaTypes < confidenceThreshold)
    out.push('mediaTypes');
  // dataSource: omitted from unfilled because empty/null is a valid default.
  // M9.4 just persists whatever the LLM produced.
  return out;
}
