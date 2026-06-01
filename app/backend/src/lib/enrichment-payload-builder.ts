/**
 * Builds the per-article JSON payload that goes into the LLM enrichment
 * tagger's user message. Source-aware: the included fields depend on
 * (dataSource, enrichmentType, hasReach).
 *
 * Routing matrix (from M9.4.5 spec):
 *
 *   opensearch  + hasReach  + standard → include reach
 *   opensearch  + hasReach  + reach    → omit reach (SimilarWeb fills fresh)
 *   opensearch  + !hasReach + any      → omit reach; M9.5.5 probes user
 *   csv_upload  + hasReach  + standard → include reach
 *   csv_upload  + hasReach  + reach    → omit reach
 *   csv_upload  + !hasReach + any      → omit reach
 *
 * Pre-computed enrichment fields from the source (articleSentiment,
 * entities, pre_primary_theme, etc.) are INTENTIONALLY NOT INCLUDED —
 * we always re-tag with our LLM for consistency across data sources.
 *
 * @file lib/enrichment-payload-builder.ts
 */
import type { NormalizedArticleFields } from './opensearch-mapping.js';
import type { ChatDataSource } from '@prsi/shared/db';

export type EnrichmentType = 'standard' | 'reach';

export interface PayloadBuilderInput {
  articleId: string;
  article: NormalizedArticleFields;
  dataSource: ChatDataSource;
  enrichmentType: EnrichmentType;
  hasReach: boolean;
}

export interface ArticlePayload {
  articleId: string;
  title: string;
  content: string | null;
  sources: { domain: string | null; name: string | null } | null;
  pubDate: string | null; // ISO YYYY-MM-DDTHH:MM:SSZ
  language: string;
  country: string | null;
  reach?: number; // only included when hasReach && enrichmentType==='standard'
}

export function buildArticlePayload(input: PayloadBuilderInput): ArticlePayload {
  const { articleId, article, enrichmentType, hasReach } = input;
  const payload: ArticlePayload = {
    articleId,
    title: article.title,
    content: article.content,
    sources: article.sources,
    pubDate: article.publishedDate ? article.publishedDate.toISOString() : null,
    language: article.language,
    country: article.country,
  };
  if (hasReach && enrichmentType === 'standard' && typeof article.reach === 'number') {
    payload.reach = article.reach;
  }
  return payload;
}

/**
 * Convenience batch wrapper — apply the same routing to N articles.
 * All articles in a batch share the same (dataSource, enrichmentType,
 * hasReach) verdict (we make the presence call per-batch in M9.5).
 */
export function buildBatchPayload(
  articles: ReadonlyArray<{ id: string; data: NormalizedArticleFields }>,
  ctx: Omit<PayloadBuilderInput, 'articleId' | 'article'>,
): ArticlePayload[] {
  return articles.map(({ id, data }) =>
    buildArticlePayload({ articleId: id, article: data, ...ctx }),
  );
}
