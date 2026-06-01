'use client';
import { apiFetch } from './api-client';
import type { FlowStateLiteral } from './flow-states';

/**
 * Phase 2 — Frontend typed client for chat_params + brand-suggest endpoints
 * (M7.5). Mirrors `lib/uploads.ts` / `lib/chats.ts` style — apiFetch unwraps
 * the success envelope and surfaces errors as `ApiError`.
 *
 *   GET   /api/v1/chats/:id/params                — lazy-create + read
 *   PATCH /api/v1/chats/:id/params                — partial update + auto-advance
 *   POST  /api/v1/chats/:id/params/brand-suggest  — LLM brand→competitors
 *
 * @file lib/chat-params.ts
 */

export type DateRangeType = 'weekly' | 'ten_days' | 'twenty_days' | 'custom' | 'auto_detected';
export type EnrichmentType = 'standard' | 'reach';
export type CompetitorSet = 'top5' | 'top3' | 'top2' | 'custom';
export type Intention = 'intention_based' | 'comment_based';

export interface ChatParams {
  id: string;
  chatId: string;
  userId: string;
  flowState: FlowStateLiteral;
  dateRangeType: DateRangeType | null;
  dateStart: string | null;
  dateEnd: string | null;
  enrichmentType: EnrichmentType | null;
  reachThreshold: number | null;
  brand: string | null;
  competitors: string[] | null;
  competitorSet: CompetitorSet | null;
  intention: Intention | null;
  hasUpload: boolean;
  uploadId: string | null;
  collectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatParamsPatch {
  dateRangeType?: DateRangeType;
  /** ISO 8601 datetime; null clears. */
  dateStart?: string | null;
  dateEnd?: string | null;
  enrichmentType?: EnrichmentType;
  reachThreshold?: number | null;
  brand?: string | null;
  competitors?: string[];
  competitorSet?: CompetitorSet;
  intention?: Intention;
  hasUpload?: boolean;
  uploadId?: string | null;
}

export interface CompetitorSuggestions {
  top5: string[];
  top3: string[];
  top2: string[];
}

/** Lazy-creates the chat_params row server-side on first GET. */
export async function getOrCreateParams(
  chatId: string,
): Promise<{ params: ChatParams; flowState: FlowStateLiteral }> {
  return apiFetch<{ params: ChatParams; flowState: FlowStateLiteral }>(
    `/api/v1/chats/${encodeURIComponent(chatId)}/params`,
  );
}

/** PATCH the chat_params row. Backend auto-recomputes flow_state and emits
 *  `flow:state-change` on the WS channel when the state advances. */
export async function patchChatParams(
  chatId: string,
  patch: ChatParamsPatch,
): Promise<{ params: ChatParams; nextPrompt: string | null }> {
  return apiFetch<{ params: ChatParams; nextPrompt: string | null }>(
    `/api/v1/chats/${encodeURIComponent(chatId)}/params`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch),
    },
  );
}

/** LLM-driven competitor suggestion. Returns three lists (top5/top3/top2)
 *  derived from the brand name. */
export async function suggestCompetitorsForBrand(
  chatId: string,
  brand: string,
): Promise<CompetitorSuggestions> {
  return apiFetch<{ competitors: CompetitorSuggestions }>(
    `/api/v1/chats/${encodeURIComponent(chatId)}/params/brand-suggest`,
    {
      method: 'POST',
      body: JSON.stringify({ brand }),
    },
  ).then((d) => d.competitors);
}
