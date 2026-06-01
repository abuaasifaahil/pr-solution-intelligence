/**
 * OpenSearch hit → Article mapper — M9.1.
 *
 * Maps an OpenSearch `_source` object to the canonical Article schema
 * used by Phase 2's `articles` table. Per-field alias maps handle
 * clusters that use different names for the same concept (body/text/
 * content, headline/title/subject, etc.).
 *
 * Convention mirrors the CSV column normalizer in `article-normalizer.ts`:
 * case-insensitive lookup, first match wins, empty/whitespace values
 * treated as null. Domain falls back to URL parsing when not provided.
 *
 * The full `_source` is preserved in `rawData` so downstream debugging
 * and Phase 4+ field-discovery don't lose data we didn't model yet.
 *
 * @file lib/opensearch-mapping.ts
 */
import type { Prisma } from '@prsi/shared/db';

/** Canonical Article fields we extract from each hit (excluding system cols). */
export interface NormalizedArticleFields {
  title: string;
  content: string | null;
  description: string | null;
  source: string | null;
  author: string | null;
  publishedDate: Date | null;
  url: string | null;
  publisherDomain: string | null;
  language: string;
}

/**
 * Per-field alias map. First match wins. Lookup is case-insensitive — the
 * cluster's actual key may be `Headline` or `HEADLINE`.
 *
 * Note: kept in sync with `article-normalizer.COLUMN_ALIASES` so the two
 * data-source paths normalize the same way. Additionally has
 * `publisherDomain` (CSV path computes it from URL).
 */
const ALIASES: Record<keyof NormalizedArticleFields, readonly string[]> = {
  title:           ['title', 'headline', 'subject'],
  content:         ['content', 'body', 'text', 'article'],
  description:     ['description', 'summary', 'snippet', 'abstract'],
  source:          ['source', 'publisher', 'publication', 'outlet'],
  author:          ['author', 'byline', 'writer'],
  publishedDate:   ['published_date', 'publishedAt', 'published', 'date', 'pub_date', 'timestamp'],
  url:             ['url', 'link', 'href', 'permalink'],
  publisherDomain: ['publisher_domain', 'domain', 'host'],
  language:        ['language', 'lang', 'locale'],
};

/**
 * Find the first alias present in `source`. Case-insensitive. Returns null
 * when no alias matches or the value is null/whitespace-only.
 */
function pickAlias(
  source: Record<string, unknown>,
  aliases: readonly string[],
): string | null {
  // Build a case-insensitive key lookup once per call.
  const lowerToActual = Object.keys(source).reduce<Record<string, string>>((acc, k) => {
    acc[k.toLowerCase()] = k;
    return acc;
  }, {});
  for (const alias of aliases) {
    const actual = lowerToActual[alias.toLowerCase()];
    if (actual === undefined) continue;
    const v = source[actual];
    if (v == null) continue;
    const s = String(v).trim();
    if (s.length > 0) return s;
  }
  return null;
}

/** Extract hostname (sans `www.`) from a URL string. Returns null on parse failure. */
function extractDomain(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : 'https://' + url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Parse an ISO/RFC string into a Date. Returns null when invalid. */
function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Convert one OpenSearch hit to the Article-row shape ready for bulk
 * insert. The full `_source` is preserved on `rawData`, and `_id` on
 * `openSearchId` so we can dedupe / re-fetch later if needed.
 */
export function mapHitToArticle(hit: {
  _id: string;
  _source: Record<string, unknown>;
}): NormalizedArticleFields & {
  rawData: Prisma.InputJsonValue;
  openSearchId: string;
} {
  const src = hit._source;
  const title = pickAlias(src, ALIASES.title) ?? '(untitled)';
  const url = pickAlias(src, ALIASES.url);
  const rawLanguage = pickAlias(src, ALIASES.language) ?? 'en';
  return {
    title,
    content: pickAlias(src, ALIASES.content),
    description: pickAlias(src, ALIASES.description),
    source: pickAlias(src, ALIASES.source),
    author: pickAlias(src, ALIASES.author),
    publishedDate: parseDate(pickAlias(src, ALIASES.publishedDate)),
    url,
    publisherDomain: pickAlias(src, ALIASES.publisherDomain) ?? extractDomain(url),
    // Schema caps language at 10 chars; lowercase to match CSV path.
    language: rawLanguage.slice(0, 10).toLowerCase(),
    rawData: src as unknown as Prisma.InputJsonValue,
    openSearchId: hit._id,
  };
}
