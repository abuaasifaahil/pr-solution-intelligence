/**
 * DataSourceAdapter — uniform interface for fetching articles from any
 * source (CSV upload, OpenSearch, Crawl, RSS, S3, MCP server, ...). Per
 * ADR-0001 + ADR-0003.
 *
 * Adapters convert source-specific responses into the canonical
 * `NormalizedArticle` shape BEFORE returning. No per-adapter intermediate
 * leaks past this boundary (ADR-0003 Decision 3 — single normalization
 * point).
 *
 * Adapters yield article batches via async iterable so the caller (agent
 * lifecycle wrapper, future SourceOrchestrator) can:
 *   - bulk-insert each batch as it arrives (memory-bounded)
 *   - emit per-batch WS progress
 *   - cancel cleanly mid-iteration via AbortSignal
 *
 * Per-fetch side-channel metadata (total hits, retries used, latency,
 * indices queried) is exposed via `meta()` so callers can read it AFTER
 * iteration completes without polluting the per-batch payload.
 *
 * @file backend/src/data-sources/adapter.ts
 */
import type { Prisma } from '@prsi/shared/db';
import type { BooleanQueryStructured } from '../lib/boolean-query-engine.js';
import type { MediaType } from '../lib/media-types.js';

/**
 * Kind discriminator. Matches the future `data_source_kind` Postgres
 * ENUM (M9.11) one-to-one. Kinds beyond `csv_upload` and `opensearch`
 * are listed here so the registry's switch is exhaustive — calling
 * `createAdapter()` with an unimplemented kind throws a clear error.
 */
export type DataSourceKind =
  | 'csv_upload'
  | 'opensearch'
  // Not implemented in M9.6a. Adapters land in future milestones.
  | 'crawler'
  | 'rss'
  | 's3'
  | 'slack_archive'
  | 'imap'
  | 'mcp_server'
  | 'skill_provided';

/**
 * Canonical article shape every adapter MUST produce. Downstream code
 * (bulk-insert, presence detection, enrichment payload builder, Phase 4
 * dashboards) reads only these fields — no source-specific extensions.
 *
 * `rawData` preserves the original payload for debug / Phase 4 field
 * discovery. `sourceKind` is stamped by the adapter so callers can
 * attribute provenance when multiple sources merge (M9.11).
 *
 * Optional `sourceArticleIdNumeric` / OpenSearch `_id` and CSV row index
 * are exposed via `sourceArticleId` (string) so the caller's bulk-insert
 * service can keep its dedupe semantics intact.
 */
export interface NormalizedArticle {
  /** Stable identifier within the source. CSV: row index. OS: _id. */
  sourceArticleId: string;

  title: string;
  content: string | null;
  description: string | null;
  source: string | null;
  author: string | null;
  publishedDate: Date | null;
  url: string | null;
  publisherDomain: string | null;
  language: string;
  country: string | null;
  reach: number | null;

  /** Convenience: pre-extracted publisher info. CSV builds this from
   *  columns; OS reads nested `_source.sources.{domain,name}`. */
  sources: { domain: string | null; name: string | null } | null;

  /** Full raw payload preserved for debug / Phase 4 field discovery. */
  rawData: Prisma.InputJsonValue;

  /** Stamped by the adapter — never null. Used downstream when multiple
   *  sources are merged (M9.11). */
  sourceKind: DataSourceKind;
}

/**
 * Per-signal confidence the adapter declares for the source kind it
 * represents. Used by the orchestrator to plan enrichment + chip the
 * user on missing fields (M9.5.5 reach probe, future M9.11 consolidated
 * probe).
 *
 * 'always' — every article from this source carries the field.
 * 'usually'— the field is widely populated; expect ≥80% coverage.
 * 'rarely' — the field shows up sometimes; expect <50% coverage.
 * 'never'  — the source never produces this signal.
 */
export type CapabilityConfidence = 'always' | 'usually' | 'rarely' | 'never';

export interface DeclaredCapabilities {
  hasReach: CapabilityConfidence;
  hasArticleSentiment: CapabilityConfidence;
  hasEntities: CapabilityConfidence;
  hasThemes: CapabilityConfidence;
  hasEngagement: CapabilityConfidence;
  hasCountry: CapabilityConfidence;
  hasAuthor: CapabilityConfidence;
}

export interface FetchContext {
  userId: string;
  chatId: string;
  /** Source-specific config (encrypted creds, upload_id, query overrides).
   *  Each adapter validates this with its own Zod schema on construction. */
  config: unknown;
  /** Same structured query the M7.6 boolean engine produces. */
  structured: BooleanQueryStructured;
  /** Per-chat media-type subset (empty means "all"). */
  mediaTypes: MediaType[];
  /** Cancellation. Iteration MUST stop when the signal aborts. */
  signal?: AbortSignal;
}

export interface FetchProgress {
  /** 1-based page index within this fetch. */
  page: number;
  /** Articles yielded so far across all pages (inclusive of current batch). */
  cumulativeArticles: number;
  /** True for the terminal batch — no more pages will be yielded. */
  isLastPage: boolean;
}

export interface NormalizedArticleBatch {
  articles: NormalizedArticle[];
  progress: FetchProgress;
}

/**
 * Side-channel metadata callers can read AFTER fetch() iteration
 * completes. Adapters MUST update these counters as fetch() runs so a
 * caller reading meta() after iteration sees accurate values.
 */
export interface AdapterMeta {
  /** Total matches the source reported, or null when the source can't
   *  report (most non-OS sources). */
  totalHits: number | null;
  retriesUsed: number;
  latencyMsTotal: number;
  /** OS-specific. Empty for sources that don't query indices. */
  indicesQueried?: string[];
}

/**
 * The core adapter contract. Implementations live under
 * `src/data-sources/<kind>/` and are constructed via
 * `data-sources/registry.createAdapter()`.
 *
 * Lifecycle:
 *   1. Construct (validates config via per-adapter Zod schema)
 *   2. Caller reads `declaredCapabilities()` for planning
 *   3. Caller iterates `fetch(ctx)` — yields `NormalizedArticleBatch`s
 *   4. Caller reads `meta()` for side-channel totals
 *
 * Instances are short-lived: registry creates a NEW instance per call so
 * per-fetch state (retries, latency) never bleeds across chats.
 */
export interface DataSourceAdapter {
  readonly kind: DataSourceKind;

  declaredCapabilities(): DeclaredCapabilities;

  /**
   * Stream batches via async iterable so the agent can bulk-insert,
   * emit progress, and abort cleanly without buffering everything.
   *
   * Adapters MUST:
   *   - Honor `ctx.signal` — stop yielding as soon as it aborts.
   *   - Stamp `sourceKind` on every yielded NormalizedArticle.
   *   - Update `meta()` as iteration proceeds (totalHits known on first
   *     batch when possible; retriesUsed + latencyMsTotal known at the
   *     end).
   *   - NOT touch the `articles` table directly. Bulk-insert is a
   *     caller (agent / orchestrator) concern.
   *   - NOT emit WS events directly. WS event emission is a caller
   *     concern.
   */
  fetch(ctx: FetchContext): AsyncIterable<NormalizedArticleBatch>;

  /** Side-channel metadata. Plausible defaults before fetch(); accurate
   *  values after iteration completes. */
  meta(): AdapterMeta;
}
