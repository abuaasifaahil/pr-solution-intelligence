/**
 * ProbingAgent — interactive classifier-prober contract (ADR-0003 Decision 2).
 *
 * Today's agent classes are dispatch targets — they run AFTER chat_params
 * is fully filled by the wizard. Patterns 6+7 in ADR-0003 require agents
 * to also be CLASSIFIERS: read a sample of attached source data, declare
 * what they can infer (e.g. "I see 'FreshSip' mentioned in 18/25 titles"),
 * and PROBE the user for the gaps.
 *
 * M9.6b ships the interface + baseline implementation. Agent classes
 * may override classifyAndProbe() with domain-specific heuristics in
 * later milestones (PR Impact emphasizes brand-vs-competitor disambig;
 * Crisis Watch emphasizes sentiment baselines, etc.).
 *
 * Idempotent: re-running with the same input MUST yield the same probe
 * set. Phase 5's memory replay depends on this.
 *
 * @file backend/src/agents/probing-agent.ts
 */
import type { ChatParams } from '@prsi/shared/db';
import type {
  DataSourceKind,
  DeclaredCapabilities,
  NormalizedArticle,
} from '../data-sources/adapter.js';

/**
 * A single chip option surfaced under a probe question. `meta` carries
 * non-rendered hints downstream code may consume — e.g. the mention
 * frequency on a brand candidate, so a sorter can rank chips identically
 * across replays.
 */
export type ChipOption = {
  value: string;
  label: string;
  meta?: Record<string, unknown>;
};

/**
 * Snapshot of an attached source at the moment the prober runs. NOT a
 * live adapter — the orchestrator pulls ~25 rows via the adapter's
 * `sampleLimit` fetch mode and passes the snapshot here so the prober
 * stays decoupled from the fetch lifecycle.
 *
 * `sourceId` is the future M9.11 `chat_data_sources.id`. Today (M9.6b)
 * there is no such row yet, so callers synthesize a stable identifier
 * (e.g. `${chatId}:${kind}`) per attached source.
 */
export interface AttachedSourceSnapshot {
  sourceId: string;
  kind: DataSourceKind;
  /** Up to ~25 rows pulled via `FetchContext.sampleLimit`. */
  sampleArticles: NormalizedArticle[];
  declaredCapabilities: DeclaredCapabilities;
}

export interface ProbingInput {
  userId: string;
  chatId: string;
  /** null in patterns 6/7 "without prompt" cases */
  prompt: string | null;
  attachedSources: AttachedSourceSnapshot[];
  /** What the user has already filled (from wizard or intent extraction). */
  existingChatParams: Partial<ChatParams>;
}

/**
 * Field keys the prober can produce evidence for. Strict subset of
 * `chat_params` columns — the prober refuses to opine on fields like
 * `flowState`, `reachThreshold`, `hasUpload`, etc. that are operational
 * rather than user-intent.
 */
export type ProbableField =
  | 'brand'
  | 'competitors'
  | 'dateRange'
  | 'mediaTypes'
  | 'language'
  | 'intention'
  | 'enrichmentType';

export interface Probe {
  field: ProbableField;
  /** Human-readable probe text for the chip prompt. */
  question: string;
  /** Candidate values inferred from the sample. May be empty (free-text only). */
  chips: ChipOption[];
  /** Typically true for brand/competitors, false for enums. */
  allowFreeText: boolean;
  /** Why we're asking; shown beneath the chips. */
  rationale: string;
}

export interface PerSourceStats {
  sourceId: string;
  sampleSize: number;
  distinctBrandCandidates: number;
  distinctCompetitorCandidates: number;
  /** ISO YYYY-MM-DD or null when no published_date present. */
  dateRangeMin: string | null;
  dateRangeMax: string | null;
  languagesDetected: string[];
}

export interface ProbingResult {
  /** Inferred values for fields the prober felt confident about (>=0.5). */
  inferred: Partial<ChatParams>;
  /** Per-field confidence 0..1. Same pattern as IntentExtractor's confidence. */
  confidence: Partial<Record<ProbableField, number>>;
  /** Ordered list of probes to surface — lowest-confidence first. */
  probes: Probe[];
  /** Free-text explanation shown in the IntentExtractedCard / ProbingResultCard. */
  rationale: string;
  /** Per-source stats useful for debugging + transparency. */
  perSourceStats: PerSourceStats[];
}

/**
 * The prober contract. The baseline heuristic implementation lives in
 * `lib/sample-classifier.ts`. Future agent classes may register their
 * own override (PR Impact, Crisis Watch, …) — the contract is the same.
 *
 * Implementations MUST be idempotent: same input ⇒ byte-identical output.
 * Memory replay (Phase 5) depends on this invariant.
 */
export interface ProbingAgent {
  classifyAndProbe(input: ProbingInput): Promise<ProbingResult>;
}
