/**
 * Phase 3 — Zod schemas for the 6-dimension enrichment output.
 *
 * Mirrors the JSONB shape contracts in `app/shared/types/phase3.ts`. Used
 * by the EnrichmentAgent (M8.4) to validate the raw LLM response before
 * persisting to `enrichments.*` columns. No DB or LLM IO here — pure
 * contract layer.
 *
 * @file backend/src/lib/enrichment-schemas.ts
 */
import { z } from 'zod';

export const SentimentSchema = z.object({
  label: z.enum(['positive', 'neutral', 'negative']),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(500),
});

export const ThemeEntrySchema = z.object({
  level: z.enum(['main', 'secondary', 'tertiary']),
  name: z.string().min(1).max(120),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(500),
});
export const ThemesSchema = z.array(ThemeEntrySchema).min(1).max(5);

export const EmotionSchema = z.object({
  label: z.enum([
    'joy',
    'anger',
    'fear',
    'sadness',
    'surprise',
    'trust',
    'disgust',
    'neutral',
  ]),
  intensity: z.number().min(0).max(1),
});

export const EntityEntrySchema = z.object({
  type: z.enum([
    'person',
    'company',
    'organization',
    'brand',
    'competitor',
    'location',
    'product',
  ]),
  name: z.string().min(1).max(255),
  mentions: z.number().int().min(1),
});
export const EntitiesSchema = z.array(EntityEntrySchema).max(50);

export const SignalEntrySchema = z.object({
  type: z.enum(['emerging', 'declining', 'anomaly', 'crisis']),
  description: z.string().min(1).max(500),
  reason: z.string().min(1).max(500),
});
export const SignalsSchema = z.array(SignalEntrySchema).max(10);

export const SocialEngagementSchema = z
  .object({
    likes: z.number().int().nonnegative().optional(),
    comments: z.number().int().nonnegative().optional(),
    shares: z.number().int().nonnegative().optional(),
    impressions: z.number().int().nonnegative().optional(),
    engagement_rate: z.number().nonnegative().optional(),
    saves: z.number().int().nonnegative().optional(),
    reach: z.number().int().nonnegative().optional(),
  })
  .partial();

/**
 * Per-article enrichment payload from the LLM. `reach` is set later by the
 * SimilarWebAgent merge (M8.6), so it is intentionally not part of this
 * schema — the LLM never sets it.
 */
export const ArticleEnrichmentSchema = z.object({
  articleId: z.string().uuid(),
  sentiment: SentimentSchema,
  themes: ThemesSchema,
  emotion: EmotionSchema,
  entities: EntitiesSchema,
  signals: SignalsSchema,
  social_engagement: SocialEngagementSchema.optional(),
});
export type ArticleEnrichment = z.infer<typeof ArticleEnrichmentSchema>;

/**
 * Batch output schema — top-level object the LLM must produce, with a
 * non-empty `articles` array. The agent enforces 1:1 articleId mapping
 * after schema validation.
 */
export const EnrichmentBatchResponseSchema = z.object({
  articles: z.array(ArticleEnrichmentSchema).min(1),
});
export type EnrichmentBatchResponse = z.infer<typeof EnrichmentBatchResponseSchema>;
