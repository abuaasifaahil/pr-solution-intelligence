/**
 * M9.4.5 — enrichment-payload-builder tests.
 *
 * Pure-function suite. Verifies the source-aware routing matrix: `reach`
 * is included only when (hasReach && enrichmentType === 'standard'),
 * and pre-computed enrichment fields are never forwarded.
 */
import { describe, it, expect } from 'vitest';
import {
  buildArticlePayload,
  buildBatchPayload,
  type ArticlePayload,
} from '../../src/lib/enrichment-payload-builder.js';
import type { NormalizedArticleFields } from '../../src/lib/opensearch-mapping.js';

/** Build a fully-formed normalized article with sensible defaults. */
function makeArticle(over: Partial<NormalizedArticleFields> = {}): NormalizedArticleFields {
  return {
    title: 'Sample title',
    content: 'Sample content body.',
    description: 'Sample description.',
    source: 'Sample Source',
    author: 'Jane Doe',
    publishedDate: new Date('2026-05-15T10:30:00.000Z'),
    url: 'https://example.com/article',
    publisherDomain: 'example.com',
    language: 'en',
    country: 'US',
    reach: 12345.7,
    sources: { domain: 'example.com', name: 'Sample Source' },
    ...over,
  };
}

describe('buildArticlePayload', () => {
  it('opensearch + hasReach + standard → INCLUDES reach', () => {
    const payload = buildArticlePayload({
      articleId: 'a1',
      article: makeArticle(),
      dataSource: 'opensearch',
      enrichmentType: 'standard',
      hasReach: true,
    });
    expect(payload.reach).toBe(12345.7);
    expect(Object.prototype.hasOwnProperty.call(payload, 'reach')).toBe(true);
  });

  it('opensearch + hasReach + reach → does NOT include reach (key absent)', () => {
    const payload = buildArticlePayload({
      articleId: 'a2',
      article: makeArticle(),
      dataSource: 'opensearch',
      enrichmentType: 'reach',
      hasReach: true,
    });
    expect(Object.prototype.hasOwnProperty.call(payload, 'reach')).toBe(false);
    expect(payload.reach).toBeUndefined();
  });

  it('opensearch + !hasReach + standard → no `reach` key', () => {
    const payload = buildArticlePayload({
      articleId: 'a3',
      article: makeArticle(),
      dataSource: 'opensearch',
      enrichmentType: 'standard',
      hasReach: false,
    });
    expect(Object.prototype.hasOwnProperty.call(payload, 'reach')).toBe(false);
  });

  it('opensearch + !hasReach + reach → no `reach` key', () => {
    const payload = buildArticlePayload({
      articleId: 'a3b',
      article: makeArticle(),
      dataSource: 'opensearch',
      enrichmentType: 'reach',
      hasReach: false,
    });
    expect(Object.prototype.hasOwnProperty.call(payload, 'reach')).toBe(false);
  });

  it('csv_upload + hasReach + standard → INCLUDES reach', () => {
    const payload = buildArticlePayload({
      articleId: 'csv1',
      article: makeArticle({ reach: 999 }),
      dataSource: 'csv_upload',
      enrichmentType: 'standard',
      hasReach: true,
    });
    expect(payload.reach).toBe(999);
  });

  it('csv_upload + hasReach + reach → no `reach` key', () => {
    const payload = buildArticlePayload({
      articleId: 'csv2',
      article: makeArticle({ reach: 999 }),
      dataSource: 'csv_upload',
      enrichmentType: 'reach',
      hasReach: true,
    });
    expect(Object.prototype.hasOwnProperty.call(payload, 'reach')).toBe(false);
  });

  it('payload always includes articleId, title, content, sources, pubDate, language, country', () => {
    const payload = buildArticlePayload({
      articleId: 'must-have',
      article: makeArticle(),
      dataSource: 'opensearch',
      enrichmentType: 'standard',
      hasReach: false,
    });
    expect(payload.articleId).toBe('must-have');
    expect(payload.title).toBe('Sample title');
    expect(payload.content).toBe('Sample content body.');
    expect(payload.sources).toEqual({ domain: 'example.com', name: 'Sample Source' });
    expect(payload.pubDate).toBe('2026-05-15T10:30:00.000Z');
    expect(payload.language).toBe('en');
    expect(payload.country).toBe('US');
  });

  it('pre-computed enrichment fields on `article` are NOT in the payload — shape is constrained', () => {
    // We attach extra keys (simulating someone over-extending the article
    // object). The payload type is constrained so they must not leak.
    const polluted = {
      ...makeArticle(),
      // These do not exist on NormalizedArticleFields, but the builder
      // explicitly picks fields, so they can't pass through anyway.
      articleSentiment: 'positive',
      entities: ['Acme'],
      pre_primary_theme: 'Tech',
    } as NormalizedArticleFields & Record<string, unknown>;

    const payload = buildArticlePayload({
      articleId: 'no-pollute',
      article: polluted,
      dataSource: 'opensearch',
      enrichmentType: 'standard',
      hasReach: false,
    });
    expect(Object.prototype.hasOwnProperty.call(payload, 'articleSentiment')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(payload, 'entities')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(payload, 'pre_primary_theme')).toBe(false);
    // Exact shape — only the documented keys appear.
    const allowedKeys = ['articleId', 'title', 'content', 'sources', 'pubDate', 'language', 'country'];
    expect(Object.keys(payload).sort()).toEqual([...allowedKeys].sort());
  });

  it('pubDate of null → payload.pubDate is null (not "null" string)', () => {
    const payload = buildArticlePayload({
      articleId: 'no-date',
      article: makeArticle({ publishedDate: null }),
      dataSource: 'opensearch',
      enrichmentType: 'standard',
      hasReach: false,
    });
    expect(payload.pubDate).toBeNull();
    expect(payload.pubDate).not.toBe('null');
  });

  it('empty-string title is preserved (worker validates upstream)', () => {
    const payload = buildArticlePayload({
      articleId: 'empty-title',
      article: makeArticle({ title: '' }),
      dataSource: 'opensearch',
      enrichmentType: 'standard',
      hasReach: false,
    });
    expect(payload.title).toBe('');
  });

  it('hasReach=true but article.reach is null → reach not included (defensive)', () => {
    const payload = buildArticlePayload({
      articleId: 'null-reach',
      article: makeArticle({ reach: null }),
      dataSource: 'opensearch',
      enrichmentType: 'standard',
      hasReach: true,
    });
    expect(Object.prototype.hasOwnProperty.call(payload, 'reach')).toBe(false);
  });
});

describe('buildBatchPayload', () => {
  it('50 articles, ctx applied uniformly → 50 payloads of consistent shape', () => {
    const articles = Array.from({ length: 50 }, (_, i) => ({
      id: `id-${i}`,
      data: makeArticle({ title: `Title ${i}` }),
    }));
    const payloads = buildBatchPayload(articles, {
      dataSource: 'opensearch',
      enrichmentType: 'standard',
      hasReach: true,
    });
    expect(payloads).toHaveLength(50);
    expect(payloads[0]!.articleId).toBe('id-0');
    expect(payloads[49]!.articleId).toBe('id-49');
    for (const p of payloads) {
      // reach included in all because hasReach=true + standard.
      expect(typeof p.reach).toBe('number');
      expect(p.title).toMatch(/^Title \d+$/);
      expect(p.language).toBe('en');
    }
  });

  it('batch wrapper respects enrichmentType=reach → omits reach for every payload', () => {
    const articles: { id: string; data: NormalizedArticleFields }[] = Array.from(
      { length: 5 },
      (_, i) => ({ id: `id-${i}`, data: makeArticle() }),
    );
    const payloads: ArticlePayload[] = buildBatchPayload(articles, {
      dataSource: 'opensearch',
      enrichmentType: 'reach',
      hasReach: true,
    });
    for (const p of payloads) {
      expect(Object.prototype.hasOwnProperty.call(p, 'reach')).toBe(false);
    }
  });

  it('empty input → empty output', () => {
    const payloads = buildBatchPayload([], {
      dataSource: 'csv_upload',
      enrichmentType: 'standard',
      hasReach: false,
    });
    expect(payloads).toEqual([]);
  });
});
