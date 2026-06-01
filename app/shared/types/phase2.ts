/**
 * Phase 2 — Shared TypeScript types. Re-export the Prisma-generated row
 * types and the FlowState string-union for use across backend + frontend.
 *
 * @file shared/types/phase2.ts
 */
import type {
  Upload as PrismaUpload,
  Article as PrismaArticle,
  ChatParams as PrismaChatParams,
  BooleanQuery as PrismaBooleanQuery,
} from '@prisma/client';

import {
  FlowState,
  UploadStatus,
  DateRangeType,
  EnrichmentType,
  CompetitorSet,
  Intention,
} from '@prisma/client';

export type Upload = PrismaUpload;
export type Article = PrismaArticle;
export type ChatParams = PrismaChatParams;
export type BooleanQuery = PrismaBooleanQuery;

export { FlowState, UploadStatus, DateRangeType, EnrichmentType, CompetitorSet, Intention };

// Helper string-union derived from the Prisma enum — useful for frontend
// state-machine logic that doesn't want to import the Prisma client.
export type FlowStateLiteral =
  | 'init'
  | 'collect_dates'
  | 'collect_enrichment'
  | 'collect_brand'
  | 'collect_competitors'
  | 'collect_intention'
  | 'generate_query'
  | 'processing'
  | 'complete';
