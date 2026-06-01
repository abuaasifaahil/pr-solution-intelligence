/**
 * OpenSearch DSL builder — M9.1.
 *
 * Builds an OpenSearch query DSL from M7.6's `BooleanQueryStructured` shape.
 *
 * Field strategy:
 * - Fields list comes from env.OPENSEARCH_FIELDS_FOR_QUERY (csv, default
 *   `title,content,description,summary`).
 * - Brand: must match in any of those fields (multi_match `operator: and`,
 *   `type: best_fields`). Title gets a `^3` boost so brand-in-headline
 *   ranks higher.
 * - Competitors: emitted as `should` clauses (boost matches but don't
 *   exclude — we want broad comparison coverage, not a strict filter).
 *   Uses the structured `competitorFields` list directly.
 * - Date range: filter on `published_date` with `format: 'yyyy-MM-dd'`.
 *   Skipped when `dateRange` is null.
 * - Language: term filter on `language`.
 * - Sort: published_date desc, then `_id` desc as tiebreak (required for
 *   `search_after` pagination — without it, hits at the same timestamp
 *   would re-order between pages).
 *
 * Pure function. No IO. Configurable via env only — no per-call hooks
 * needed yet (M9.x can extend if a cluster uses a different date field).
 *
 * @file lib/opensearch-dsl.ts
 */
import { loadEnv } from '../env.js';
import type { BooleanQueryStructured } from './boolean-query-engine.js';

/** OpenSearch document field that carries the article publish timestamp. */
const DATE_FIELD = 'published_date';

/** Minimum DSL surface we emit. Pass directly to `client.search({ body })`. */
export interface OpenSearchDsl {
  query: unknown;
  sort: unknown[];
  size: number;
  _source: string[] | true;
  search_after?: unknown[];
}

/**
 * Build an OpenSearch DSL from a structured boolean query.
 *
 * `options.searchAfter` — pass the previous page's last `sort` array to
 * fetch the next page. When omitted, the first page is returned.
 */
export function buildOpenSearchDsl(
  structured: BooleanQueryStructured,
  options?: { searchAfter?: unknown[] },
): OpenSearchDsl {
  const env = loadEnv();
  const fields = env.OPENSEARCH_FIELDS_FOR_QUERY.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Boost title (^3) when present; other fields default weight 1.
  const boostedFields = fields.map((f) => (f === 'title' ? `${f}^3` : f));

  const must: unknown[] = [
    {
      multi_match: {
        query: structured.brand,
        fields: boostedFields,
        operator: 'and',
        type: 'best_fields',
      },
    },
  ];

  const should = structured.competitors.map((c) => ({
    multi_match: {
      query: c,
      fields: structured.competitorFields,
      operator: 'or',
      type: 'best_fields',
    },
  }));

  const filter: unknown[] = [];
  if (structured.dateRange) {
    filter.push({
      range: {
        [DATE_FIELD]: {
          gte: structured.dateRange.start,
          lte: structured.dateRange.end,
          format: 'yyyy-MM-dd',
        },
      },
    });
  }
  filter.push({ term: { language: structured.language } });

  const dsl: OpenSearchDsl = {
    query: {
      bool: {
        must,
        ...(should.length > 0 ? { should } : {}),
        filter,
      },
    },
    // _id tiebreak is required for stable `search_after` pagination.
    sort: [{ [DATE_FIELD]: 'desc' }, { _id: 'desc' }],
    size: env.OPENSEARCH_PAGE_SIZE,
    _source: true, // pull the full _source; mapping layer picks fields
  };

  if (options?.searchAfter && options.searchAfter.length > 0) {
    dsl.search_after = options.searchAfter;
  }

  return dsl;
}
