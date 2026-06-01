/**
 * M8.3 — Zod schema tests for the 6-dimension enrichment payload.
 *
 * Pure schema tests, no IO. Happy + sad paths per dimension, plus the
 * composite `ArticleEnrichmentSchema` and batch wrapper. Asserts the hard
 * caps on themes (≤5) and entities (≤50).
 */
import { describe, it, expect } from 'vitest';
import {
  SentimentSchema,
  ThemeEntrySchema,
  ThemesSchema,
  EmotionSchema,
  EntityEntrySchema,
  EntitiesSchema,
  SignalEntrySchema,
  SignalsSchema,
  SocialEngagementSchema,
  ArticleEnrichmentSchema,
  EnrichmentBatchResponseSchema,
} from '../../src/lib/enrichment-schemas.js';

const UUID = '11111111-1111-1111-1111-111111111111';
const UUID2 = '22222222-2222-2222-2222-222222222222';
const UUID3 = '33333333-3333-3333-3333-333333333333';

function validArticle(id = UUID) {
  return {
    articleId: id,
    sentiment: { label: 'positive' as const, confidence: 0.9, reason: 'r' },
    themes: [
      { level: 'main' as const, name: 'Earnings', confidence: 0.9, reason: 'r' },
    ],
    emotion: { label: 'joy' as const, intensity: 0.5 },
    entities: [{ type: 'company' as const, name: 'PepsiCo', mentions: 2 }],
    signals: [
      { type: 'emerging' as const, description: 'desc', reason: 'r' },
    ],
  };
}

describe('SentimentSchema', () => {
  it('accepts a valid sentiment', () => {
    const r = SentimentSchema.safeParse({
      label: 'positive',
      confidence: 0.85,
      reason: 'tone is upbeat',
    });
    expect(r.success).toBe(true);
  });
  it('rejects an unknown label', () => {
    const r = SentimentSchema.safeParse({
      label: 'happy',
      confidence: 0.5,
      reason: 'x',
    });
    expect(r.success).toBe(false);
  });
  it('rejects confidence outside 0..1', () => {
    expect(
      SentimentSchema.safeParse({ label: 'neutral', confidence: 1.5, reason: 'x' })
        .success,
    ).toBe(false);
    expect(
      SentimentSchema.safeParse({ label: 'neutral', confidence: -0.1, reason: 'x' })
        .success,
    ).toBe(false);
  });
  it('rejects empty reason', () => {
    expect(
      SentimentSchema.safeParse({ label: 'neutral', confidence: 0.5, reason: '' })
        .success,
    ).toBe(false);
  });
  it('rejects missing field', () => {
    const r = SentimentSchema.safeParse({ label: 'neutral', confidence: 0.5 });
    expect(r.success).toBe(false);
  });
});

describe('ThemeEntrySchema / ThemesSchema', () => {
  it('accepts a valid theme entry', () => {
    expect(
      ThemeEntrySchema.safeParse({
        level: 'main',
        name: 'Earnings',
        confidence: 0.9,
        reason: 'r',
      }).success,
    ).toBe(true);
  });
  it('rejects an unknown level', () => {
    expect(
      ThemeEntrySchema.safeParse({
        level: 'top',
        name: 'Earnings',
        confidence: 0.9,
        reason: 'r',
      }).success,
    ).toBe(false);
  });
  it('rejects empty array (min 1)', () => {
    expect(ThemesSchema.safeParse([]).success).toBe(false);
  });
  it('rejects array with >5 entries', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      level: 'main' as const,
      name: `T${i}`,
      confidence: 0.5,
      reason: 'r',
    }));
    expect(ThemesSchema.safeParse(six).success).toBe(false);
  });
  it('accepts exactly 5 entries', () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      level: 'main' as const,
      name: `T${i}`,
      confidence: 0.5,
      reason: 'r',
    }));
    expect(ThemesSchema.safeParse(five).success).toBe(true);
  });
});

describe('EmotionSchema', () => {
  it('accepts each enum value', () => {
    for (const label of [
      'joy',
      'anger',
      'fear',
      'sadness',
      'surprise',
      'trust',
      'disgust',
      'neutral',
    ] as const) {
      expect(EmotionSchema.safeParse({ label, intensity: 0.3 }).success).toBe(true);
    }
  });
  it('rejects unknown label', () => {
    expect(EmotionSchema.safeParse({ label: 'excited', intensity: 0.3 }).success).toBe(
      false,
    );
  });
  it('rejects intensity outside 0..1', () => {
    expect(EmotionSchema.safeParse({ label: 'joy', intensity: 1.2 }).success).toBe(
      false,
    );
  });
  it('rejects missing intensity', () => {
    expect(EmotionSchema.safeParse({ label: 'joy' }).success).toBe(false);
  });
});

describe('EntityEntrySchema / EntitiesSchema', () => {
  it('accepts a valid entity', () => {
    expect(
      EntityEntrySchema.safeParse({ type: 'company', name: 'X', mentions: 1 }).success,
    ).toBe(true);
  });
  it('rejects unknown type', () => {
    expect(
      EntityEntrySchema.safeParse({ type: 'thing', name: 'X', mentions: 1 }).success,
    ).toBe(false);
  });
  it('rejects mentions < 1', () => {
    expect(
      EntityEntrySchema.safeParse({ type: 'company', name: 'X', mentions: 0 }).success,
    ).toBe(false);
  });
  it('rejects non-integer mentions', () => {
    expect(
      EntityEntrySchema.safeParse({ type: 'company', name: 'X', mentions: 1.5 })
        .success,
    ).toBe(false);
  });
  it('rejects empty name', () => {
    expect(
      EntityEntrySchema.safeParse({ type: 'company', name: '', mentions: 1 }).success,
    ).toBe(false);
  });
  it('accepts empty entities array', () => {
    expect(EntitiesSchema.safeParse([]).success).toBe(true);
  });
  it('rejects array with >50 entries', () => {
    const fifty1 = Array.from({ length: 51 }, (_, i) => ({
      type: 'company' as const,
      name: `E${i}`,
      mentions: 1,
    }));
    expect(EntitiesSchema.safeParse(fifty1).success).toBe(false);
  });
});

describe('SignalEntrySchema / SignalsSchema', () => {
  it('accepts each signal type', () => {
    for (const type of ['emerging', 'declining', 'anomaly', 'crisis'] as const) {
      expect(
        SignalEntrySchema.safeParse({ type, description: 'd', reason: 'r' }).success,
      ).toBe(true);
    }
  });
  it('rejects unknown type', () => {
    expect(
      SignalEntrySchema.safeParse({ type: 'unknown', description: 'd', reason: 'r' })
        .success,
    ).toBe(false);
  });
  it('rejects empty description', () => {
    expect(
      SignalEntrySchema.safeParse({ type: 'crisis', description: '', reason: 'r' })
        .success,
    ).toBe(false);
  });
  it('rejects array with >10 entries', () => {
    const eleven = Array.from({ length: 11 }, () => ({
      type: 'emerging' as const,
      description: 'd',
      reason: 'r',
    }));
    expect(SignalsSchema.safeParse(eleven).success).toBe(false);
  });
});

describe('SocialEngagementSchema', () => {
  it('accepts a fully-populated payload', () => {
    expect(
      SocialEngagementSchema.safeParse({
        likes: 10,
        comments: 5,
        shares: 2,
        impressions: 1000,
        engagement_rate: 0.017,
        saves: 1,
        reach: 800,
      }).success,
    ).toBe(true);
  });
  it('accepts an empty object (all optional)', () => {
    expect(SocialEngagementSchema.safeParse({}).success).toBe(true);
  });
  it('accepts partial fields', () => {
    expect(SocialEngagementSchema.safeParse({ likes: 5 }).success).toBe(true);
  });
  it('rejects negative likes', () => {
    expect(SocialEngagementSchema.safeParse({ likes: -1 }).success).toBe(false);
  });
  it('rejects non-integer comments', () => {
    expect(SocialEngagementSchema.safeParse({ comments: 1.5 }).success).toBe(false);
  });
});

describe('ArticleEnrichmentSchema', () => {
  it('accepts a full valid payload', () => {
    const r = ArticleEnrichmentSchema.safeParse(validArticle());
    expect(r.success).toBe(true);
  });
  it('accepts payload with social_engagement', () => {
    const a = { ...validArticle(), social_engagement: { likes: 5 } };
    expect(ArticleEnrichmentSchema.safeParse(a).success).toBe(true);
  });
  it('rejects non-uuid articleId', () => {
    const a = { ...validArticle(), articleId: 'not-a-uuid' };
    expect(ArticleEnrichmentSchema.safeParse(a).success).toBe(false);
  });
  it('rejects missing sentiment', () => {
    const { sentiment: _omit, ...rest } = validArticle();
    expect(ArticleEnrichmentSchema.safeParse(rest).success).toBe(false);
  });
});

describe('EnrichmentBatchResponseSchema', () => {
  it('accepts an array of 3 articles', () => {
    const r = EnrichmentBatchResponseSchema.safeParse({
      articles: [validArticle(UUID), validArticle(UUID2), validArticle(UUID3)],
    });
    expect(r.success).toBe(true);
  });
  it('rejects empty articles array (min 1)', () => {
    expect(EnrichmentBatchResponseSchema.safeParse({ articles: [] }).success).toBe(
      false,
    );
  });
  it('rejects missing articles key', () => {
    expect(EnrichmentBatchResponseSchema.safeParse({}).success).toBe(false);
  });
  it('rejects array of invalid articles', () => {
    expect(
      EnrichmentBatchResponseSchema.safeParse({
        articles: [{ ...validArticle(), sentiment: { label: 'bogus' } }],
      }).success,
    ).toBe(false);
  });
});
