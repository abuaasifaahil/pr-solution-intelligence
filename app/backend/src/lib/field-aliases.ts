/**
 * Canonical field-name aliases for article normalization. Shared by both
 * the CSV ingestion path (article-normalizer.ts) and the OpenSearch
 * ingestion path (opensearch-mapping.ts).
 *
 * M9.1.2 flagged that the two paths previously duplicated this map;
 * extracted in M9.2 to prevent drift.
 *
 * Convention: first alias wins. Lookup is case-insensitive at the caller
 * level — this map stores the lowercase canonical alias names.
 *
 * @file lib/field-aliases.ts
 */

export type NormalizedFieldKey =
  | 'title'
  | 'content'
  | 'description'
  | 'source'
  | 'author'
  | 'publishedDate'
  | 'url'
  | 'publisherDomain'
  | 'language'
  | 'country';

export const FIELD_ALIASES: Record<NormalizedFieldKey, readonly string[]> = {
  title: ['title', 'headline', 'subject'],
  content: ['content', 'body', 'text', 'article'],
  description: ['description', 'summary', 'snippet', 'abstract'],
  source: ['source', 'publisher', 'publication', 'outlet'],
  author: ['author', 'byline', 'writer'],
  // `pubDate` was added in M9.2 — confirmed via M9.1.1 that the AMX UAT
  // cluster ships hits with that exact key. The DSL builder already uses
  // `pubDate` literally for range filters; this entry keeps the mapper
  // consistent with what the cluster returns.
  publishedDate: [
    'published_date',
    'publishedAt',
    'published',
    'date',
    'pub_date',
    'timestamp',
    'pubDate',
  ],
  url: ['url', 'link', 'href', 'permalink'],
  // NOTE: the AMX UAT OpenSearch cluster nests the publisher domain at
  // `sources.domain` (an object), NOT at any top-level alias. This map
  // intentionally stays flat — the nested path is handled explicitly in
  // `opensearch-mapping.ts` BEFORE this top-level alias lookup runs.
  publisherDomain: ['publisher_domain', 'domain', 'host'],
  language: ['language', 'lang', 'locale'],
  // M9.4.5 — many clusters carry an ISO-2 country code on each hit. We
  // pass it through unchanged; downstream consumers (LLM tagger,
  // dashboards) interpret it.
  country: ['country', 'country_code', 'iso_country', 'geo_country'],
} as const;
