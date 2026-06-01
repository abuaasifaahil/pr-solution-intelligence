/**
 * Phase 3 — Shared TypeScript types. Re-export Prisma row types + enums
 * for use across backend + frontend.
 *
 * @file shared/types/phase3.ts
 */
import type {
  Enrichment as PrismaEnrichment,
  EnrichmentJob as PrismaEnrichmentJob,
  EnrichmentBatch as PrismaEnrichmentBatch,
  ReachCache as PrismaReachCache,
} from '@prisma/client';

import {
  EnrichmentJobType,
  EnrichmentJobStatus,
  EnrichmentBatchStatus,
} from '@prisma/client';

export type Enrichment = PrismaEnrichment;
export type EnrichmentJob = PrismaEnrichmentJob;
export type EnrichmentBatch = PrismaEnrichmentBatch;
export type ReachCache = PrismaReachCache;

export { EnrichmentJobType, EnrichmentJobStatus, EnrichmentBatchStatus };

// Helper string-unions for frontend (avoids importing Prisma client into the browser)
export type EnrichmentJobTypeLiteral = 'standard' | 'reach';
export type EnrichmentJobStatusLiteral =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'partial';
export type EnrichmentBatchStatusLiteral =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'retrying';

// ─── JSONB shape contracts ───────────────────────────────────────────────
// What the dimensions look like inside enrichments.*

export interface SentimentEnrichment {
  label: 'positive' | 'neutral' | 'negative';
  confidence: number; // 0.0–1.0
  reason: string;
}

export interface ThemeEntry {
  level: 'main' | 'secondary' | 'tertiary';
  name: string;
  confidence: number;
  reason: string;
}

export interface EmotionEnrichment {
  label:
    | 'joy'
    | 'anger'
    | 'fear'
    | 'sadness'
    | 'surprise'
    | 'trust'
    | 'disgust'
    | 'neutral';
  intensity: number; // 0.0–1.0
}

export interface EntityEntry {
  type:
    | 'person'
    | 'company'
    | 'organization'
    | 'brand'
    | 'competitor'
    | 'location'
    | 'product';
  name: string;
  mentions: number;
}

export interface SignalEntry {
  type: 'emerging' | 'declining' | 'anomaly' | 'crisis';
  description: string;
  reason: string;
}

export interface ReachEnrichment {
  domain: string;
  monthly_visitors: number;
  score: number; // 0–100
}

export interface SocialEngagement {
  likes?: number;
  comments?: number;
  shares?: number;
  impressions?: number;
  engagement_rate?: number;
  saves?: number;
  reach?: number;
}
