/**
 * M9.1 — OpenSearch DSL builder unit tests.
 *
 * Pure-function suite. Asserts the shape of the bool query against
 * representative `BooleanQueryStructured` inputs.
 */
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  // Pin the DSL builder's env-driven knobs for deterministic assertions.
  process.env.OPENSEARCH_PAGE_SIZE ??= '500';
  process.env.OPENSEARCH_FIELDS_FOR_QUERY ??= 'title,content,description,summary';
});

const { buildOpenSearchDsl } = await import('../../src/lib/opensearch-dsl.js');
import type { BooleanQueryStructured } from '../../src/lib/boolean-query-engine.js';

function structured(over: Partial<BooleanQueryStructured> = {}): BooleanQueryStructured {
  return {
    brand: 'FreshSip',
    brandFields: ['title', 'headline', 'content'],
    competitors: [],
    competitorFields: ['content', 'description'],
    dateRange: null,
    language: 'en',
    ...over,
  };
}

interface MultiMatch {
  multi_match: { query: string; fields: string[]; operator: string; type: string };
}
interface BoolQuery {
  bool: { must: MultiMatch[]; should?: MultiMatch[]; filter: unknown[] };
}

describe('buildOpenSearchDsl', () => {
  it('brand-only structured → must: multi_match on title^3,content,description,summary', () => {
    const dsl = buildOpenSearchDsl(structured());
    const q = dsl.query as BoolQuery;
    expect(q.bool.must).toHaveLength(1);
    expect(q.bool.must[0]!.multi_match.query).toBe('FreshSip');
    expect(q.bool.must[0]!.multi_match.fields).toEqual([
      'title^3',
      'content',
      'description',
      'summary',
    ]);
    expect(q.bool.must[0]!.multi_match.operator).toBe('and');
    expect(q.bool.must[0]!.multi_match.type).toBe('best_fields');
    // Single competitor-less query has no `should`.
    expect(q.bool.should).toBeUndefined();
  });

  it('with competitors → should clauses use competitorFields', () => {
    const dsl = buildOpenSearchDsl(
      structured({
        competitors: ['PepsiCo', 'Coca-Cola'],
        competitorFields: ['content', 'description'],
      }),
    );
    const q = dsl.query as BoolQuery;
    expect(q.bool.should).toHaveLength(2);
    expect(q.bool.should![0]!.multi_match.query).toBe('PepsiCo');
    expect(q.bool.should![0]!.multi_match.fields).toEqual(['content', 'description']);
    expect(q.bool.should![1]!.multi_match.query).toBe('Coca-Cola');
  });

  it('with date range → filter.range.pubDate between start/end', () => {
    const dsl = buildOpenSearchDsl(
      structured({ dateRange: { start: '2026-04-01', end: '2026-05-01' } }),
    );
    const q = dsl.query as BoolQuery;
    const rangeFilter = q.bool.filter.find(
      (f): f is { range: { pubDate: { gte: string; lte: string; format: string } } } =>
        typeof f === 'object' && f !== null && 'range' in f,
    );
    expect(rangeFilter).toBeDefined();
    expect(rangeFilter!.range.pubDate).toEqual({
      gte: '2026-04-01',
      lte: '2026-05-01',
      format: 'yyyy-MM-dd',
    });
  });

  it('language filter is always present', () => {
    const dsl = buildOpenSearchDsl(structured({ language: 'fr' }));
    const q = dsl.query as BoolQuery;
    const langFilter = q.bool.filter.find(
      (f): f is { term: { language: string } } =>
        typeof f === 'object' && f !== null && 'term' in f,
    );
    expect(langFilter).toEqual({ term: { language: 'fr' } });
  });

  it('size matches env.OPENSEARCH_PAGE_SIZE', () => {
    const dsl = buildOpenSearchDsl(structured());
    expect(dsl.size).toBe(500);
  });

  it('sort includes _id tiebreak (required for search_after)', () => {
    const dsl = buildOpenSearchDsl(structured());
    expect(dsl.sort).toEqual([
      { pubDate: 'desc' },
      { _id: 'desc' },
    ]);
  });

  it('search_after option is forwarded when supplied', () => {
    const dsl = buildOpenSearchDsl(structured(), {
      searchAfter: ['2026-04-01', 'abc123'],
    });
    expect(dsl.search_after).toEqual(['2026-04-01', 'abc123']);
  });

  it('omits search_after when not supplied OR empty', () => {
    const a = buildOpenSearchDsl(structured());
    const b = buildOpenSearchDsl(structured(), { searchAfter: [] });
    expect(a.search_after).toBeUndefined();
    expect(b.search_after).toBeUndefined();
  });

  it('no dateRange → only language filter present', () => {
    const dsl = buildOpenSearchDsl(structured({ dateRange: null }));
    const q = dsl.query as BoolQuery;
    expect(q.bool.filter).toHaveLength(1);
    expect(q.bool.filter[0]).toEqual({ term: { language: 'en' } });
  });
});
