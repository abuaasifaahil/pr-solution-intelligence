'use client';
import { apiFetch } from './api-client';
import type { ChatParams } from './chat-params';

/**
 * M9.8 (Phase 3.5) — Frontend typed client for the probe endpoints
 * shipped by M9.7 / ADR-0003 Decision 2 (agent-as-prober).
 *
 *   GET  /api/v1/chats/:id/probe          — classify attached source(s)
 *                                            and return ProbingResult
 *   POST /api/v1/chats/:id/probe/resolve  — patch chat_params with the
 *                                            user's chip choices, re-run
 *                                            classifier, return remaining
 *                                            probes
 *
 * Wire shapes mirror `backend/src/agents/probing-agent.ts` and
 * `backend/src/routes/probe.routes.ts` — do NOT redefine fields here that
 * the backend already names. Drift between client + server here is a
 * lurking bug class.
 *
 * @file lib/probe.ts
 */

/** Same `ProbableField` enum the backend `Probe.field` carries. */
export type ProbableField =
  | 'brand'
  | 'competitors'
  | 'dateRange'
  | 'mediaTypes'
  | 'language'
  | 'intention'
  | 'enrichmentType';

export interface ChipOption {
  value: string;
  label: string;
  /** Non-rendered hints downstream consumers may use (e.g. mention
   *  frequency, locale code). Kept loose — UI doesn't introspect. */
  meta?: Record<string, unknown>;
}

export interface Probe {
  field: ProbableField;
  /** Human-readable probe text — surfaced as the chip-group's question. */
  question: string;
  /** Candidate values inferred from the sample. May be empty when the
   *  field has no candidates (free-text-only probes). */
  chips: ChipOption[];
  allowFreeText: boolean;
  rationale: string;
}

export interface PerSourceStats {
  sourceId: string;
  sampleSize: number;
  distinctBrandCandidates: number;
  distinctCompetitorCandidates: number;
  dateRangeMin: string | null;
  dateRangeMax: string | null;
  languagesDetected: string[];
}

export interface ProbingResult {
  /** Partial ChatParams the prober felt confident enough about to infer
   *  without asking. Same fields you'd PATCH onto chat_params. */
  inferred: Partial<ChatParams>;
  confidence: Partial<Record<ProbableField, number>>;
  probes: Probe[];
  /** Free-text explanation shown above the probes / chips. */
  rationale: string;
  perSourceStats: PerSourceStats[];
}

/** GET /api/v1/chats/:id/probe — re-runs the classifier against the
 *  current state. Idempotent: same input ⇒ same output. */
export async function getProbe(chatId: string): Promise<ProbingResult> {
  return apiFetch<ProbingResult>(
    `/api/v1/chats/${encodeURIComponent(chatId)}/probe`,
  );
}

/**
 * A single resolution payload. `value` is loose — the backend handler
 * validates per-field shape. We keep the discriminated union typed at
 * the consumer call site (see ProbingResultCard) so callers don't pass
 * a malformed shape.
 */
export interface ProbeResolution {
  field: ProbableField;
  value: string | string[] | { start: string; end: string };
}

export interface ResolveResponse {
  /** The chat_params row after the patch — full row, same shape as
   *  `lib/chat-params.ts#ChatParams`. */
  updatedParams: ChatParams;
  /** Next set of probes (lowest-confidence first). Empty array when
   *  every field is now filled. */
  remainingProbes: Probe[];
}

/** POST /api/v1/chats/:id/probe/resolve — applies one or more chip
 *  picks, returns the new params + re-computed probes. */
export async function resolveProbes(
  chatId: string,
  resolutions: ProbeResolution[],
): Promise<ResolveResponse> {
  return apiFetch<ResolveResponse>(
    `/api/v1/chats/${encodeURIComponent(chatId)}/probe/resolve`,
    {
      method: 'POST',
      body: JSON.stringify({ resolutions }),
    },
  );
}
