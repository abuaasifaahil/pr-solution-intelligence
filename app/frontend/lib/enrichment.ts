'use client';
import { apiFetch } from './api-client';

/**
 * Phase 3 — Frontend typed client for the enrichment REST endpoints (M8.7).
 *
 *   POST   /api/v1/chats/:id/enrich              manual trigger
 *   GET    /api/v1/chats/:id/enrich/status       job + batches + progress
 *   GET    /api/v1/chats/:id/enrich/result       paginated articles
 *   GET    /api/v1/chats/:id/enrich/json         full dashboard JSON
 *   GET    /api/v1/chats/:id/enrich/summary      aggregations
 *   POST   /api/v1/chats/:id/reach/fetch         re-trigger reach
 *   POST   /api/v1/chats/:id/enrich/retry        retry failed batches
 *
 * Mirrors `lib/uploads.ts` style — apiFetch unwraps the success envelope and
 * surfaces errors as `ApiError`.
 *
 * @file lib/enrichment.ts
 */

// ─── Domain types ──────────────────────────────────────────────────────────

export interface EnrichmentJob {
  id: string;
  chatId: string;
  totalArticles: number;
  processedCount: number;
  batchCount: number;
  batchesCompleted: number;
  modelUsed: string;
  enrichmentType: 'standard' | 'reach';
  /** Backend serialises BigInt → number through Prisma's default JSON path. */
  totalTokensInput: number;
  totalTokensOutput: number;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'partial';
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface EnrichmentBatchView {
  batchNumber: number;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'retrying';
  retryCount: number;
  estimatedTokens: number;
  actualTokensIn: number | null;
  actualTokensOut: number | null;
  processingMs: number | null;
  error: string | null;
}

export interface EnrichmentStatus {
  job: EnrichmentJob | null;
  batches: EnrichmentBatchView[];
  progress: { processed: number; total: number; percent: number };
  reachCoverage?: { resolved: number; total: number; percent: number };
}

export interface EnrichmentSummary {
  totalArticles: number;
  sentimentDistribution: { positive: number; neutral: number; negative: number };
  topThemes: Array<{ name: string; count: number; level: 'main' | 'secondary' | 'tertiary' }>;
  topEntities: Array<{ name: string; type: string; count: number }>;
  topSignals: Array<{ type: string; count: number }>;
  reachStats?: {
    totalDomains: number;
    resolved: number;
    avgScore: number;
    topDomains: Array<{ domain: string; monthly_visitors: number; score: number }>;
  };
}

/**
 * DashboardJson — Phase 4 input. Backend canonical type lives in
 * services/enrichment.service.ts; we duplicate the shape here for
 * compile-time safety on the frontend (we don't import server types
 * directly across the monorepo seam).
 */
export interface DashboardJson {
  chatId: string;
  jobId: string;
  generatedAt: string;
  analysisContext: {
    brand: string | null;
    competitors: string[];
    dateRange: { start: string; end: string } | null;
    enrichmentType: 'standard' | 'reach';
    modelUsed: string;
  };
  articles: Array<{
    id: string;
    title: string;
    content: string | null;
    description: string | null;
    url: string | null;
    publisherDomain: string | null;
    source: string | null;
    author: string | null;
    publishedDate: string | null;
    language: string;
    mediaType: string;
    location: string | null;
    thumbnailUrl: string | null;
    socialEngagement: unknown | null;
    /** Full enrichment dimension blob (sentiment + themes + emotion +
     *  entities + signals + optional reach). Shape varies per dimension
     *  — kept as `unknown` so callers narrow at the point of use. */
    enrichment: unknown | null;
  }>;
  stats: {
    totalArticles: number;
    enrichedCount: number;
    sentimentDistribution: { positive: number; neutral: number; negative: number };
  };
}

// ─── Result envelopes returned by /enrich/result and /enrich/json ──────────

export interface ListEnrichedArticlesResult {
  articles: Array<{
    id: string;
    title: string;
    content: string | null;
    description: string | null;
    source: string | null;
    author: string | null;
    publishedDate: string | null;
    publisherDomain: string | null;
    url: string | null;
    enrichment: unknown | null;
  }>;
  page: number;
  pageSize: number;
  total: number;
}

export interface DashboardJsonEnvelope {
  dashboard: DashboardJson;
  cached: boolean;
}

// ─── Trigger / mutation responses ──────────────────────────────────────────

export interface EnrichTriggerResponse {
  jobId: string | null;
  message: string;
  enrichmentType: string;
}

export interface ReachFetchResponse {
  jobId: string;
  domains: number;
}

export interface RetryFailedBatchesResponse {
  retriedBatches: number;
}

// ─── Client functions ──────────────────────────────────────────────────────

export async function enrichChat(
  chatId: string,
  enrichmentType?: 'standard' | 'reach',
): Promise<EnrichTriggerResponse> {
  const body = enrichmentType ? JSON.stringify({ enrichmentType }) : JSON.stringify({});
  return apiFetch<EnrichTriggerResponse>(
    `/api/v1/chats/${encodeURIComponent(chatId)}/enrich`,
    { method: 'POST', body },
  );
}

export async function getEnrichStatus(chatId: string): Promise<EnrichmentStatus> {
  return apiFetch<EnrichmentStatus>(
    `/api/v1/chats/${encodeURIComponent(chatId)}/enrich/status`,
  );
}

export async function getEnrichResult(
  chatId: string,
  page = 1,
  pageSize = 50,
): Promise<ListEnrichedArticlesResult> {
  return apiFetch<ListEnrichedArticlesResult>(
    `/api/v1/chats/${encodeURIComponent(chatId)}/enrich/result?page=${page}&pageSize=${pageSize}`,
  );
}

export async function getEnrichJson(chatId: string): Promise<DashboardJsonEnvelope> {
  return apiFetch<DashboardJsonEnvelope>(
    `/api/v1/chats/${encodeURIComponent(chatId)}/enrich/json`,
  );
}

export async function getEnrichSummary(chatId: string): Promise<EnrichmentSummary> {
  return apiFetch<EnrichmentSummary>(
    `/api/v1/chats/${encodeURIComponent(chatId)}/enrich/summary`,
  );
}

export async function triggerReachFetch(chatId: string): Promise<ReachFetchResponse> {
  return apiFetch<ReachFetchResponse>(
    `/api/v1/chats/${encodeURIComponent(chatId)}/reach/fetch`,
    { method: 'POST' },
  );
}

export async function retryFailedBatches(
  chatId: string,
): Promise<RetryFailedBatchesResponse> {
  return apiFetch<RetryFailedBatchesResponse>(
    `/api/v1/chats/${encodeURIComponent(chatId)}/enrich/retry`,
    { method: 'POST' },
  );
}
