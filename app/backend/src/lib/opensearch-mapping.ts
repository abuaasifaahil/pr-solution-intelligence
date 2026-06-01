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
 * M9.4.5 — fixes two bugs discovered during live AMX UAT introspection:
 *   1. publisherDomain is NESTED at `_source.sources.domain` on the
 *      cluster, NOT at any top-level alias — the mapper now reads that
 *      explicit path before falling back to the flat alias lookup +
 *      URL parsing.
 *   2. Author has two shapes — prefer `authors_byline` (string) over
 *      `matched_authors[].name` (array). Doc below.
 *
 * Also adds `country`, `reach` (numeric, OS pre-computes float), and a
 * `sources` convenience object {domain, name} consumed by the M9.4.5
 * enrichment-payload-builder.
 *
 * @file lib/opensearch-mapping.ts
 */
import type { Prisma } from '@prsi/shared/db';
import { FIELD_ALIASES, type NormalizedFieldKey } from './field-aliases.js';

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
  /** M9.4.5 — ISO country code (e.g. `US`, `IN`). null when missing. */
  country: string | null;
  /** M9.4.5 — pre-computed reach (float). null when missing/non-numeric. */
  reach: number | null;
  /** M9.4.5 — pre-extracted `{domain, name}` convenience for payload builder. */
  sources: { domain: string | null; name: string | null } | null;
}

/**
 * Per-field alias map. First match wins. Lookup is case-insensitive — the
 * cluster's actual key may be `Headline` or `HEADLINE`.
 *
 * M9.2: backed by `lib/field-aliases.FIELD_ALIASES` — the single source of
 * truth shared with the CSV path. `pubDate` is included for AMX UAT
 * cluster compatibility (the DSL builder uses that exact key).
 *
 * Only the keys that this mapper resolves via the *flat* top-level alias
 * pattern appear here. Nested paths (`sources.domain`, `sources.name`,
 * `authors_byline`/`matched_authors`) are handled explicitly below.
 */
const ALIASES: Record<NormalizedFieldKey, readonly string[]> = FIELD_ALIASES;

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
 * Read the nested `_source.sources` object. The AMX UAT cluster ships
 * publisher data as `{ domain, name }` here, not at any flat alias. We
 * tolerate `_source.sources` being absent, null, an array, or a stray
 * primitive — only a plain object contributes.
 *
 * Returns null when `_source.sources` is not a usable object.
 */
function readNestedSources(
  src: Record<string, unknown>,
): { domain: string | null; name: string | null } | null {
  // Case-insensitive: some clusters could use `Sources`.
  const key = Object.keys(src).find((k) => k.toLowerCase() === 'sources');
  if (key === undefined) return null;
  const raw = src[key];
  if (raw == null || Array.isArray(raw) || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const pick = (cands: string[]): string | null => {
    for (const candidate of cands) {
      const k = Object.keys(obj).find((x) => x.toLowerCase() === candidate);
      if (k === undefined) continue;
      const v = obj[k];
      if (v == null) continue;
      const s = String(v).trim();
      if (s.length > 0) return s;
    }
    return null;
  };
  return {
    domain: pick(['domain', 'host', 'publisher_domain']),
    name: pick(['name', 'publisher', 'source']),
  };
}

/**
 * Pick the canonical author string. Precedence:
 *   1. `authors_byline` — a flat string, the cluster's display-facing field.
 *   2. `matched_authors[0].name` — array of `{id, name}`, only when (1) is
 *      missing/empty/whitespace.
 *   3. Flat alias lookup (`author`, `byline`, `writer`) — preserves the
 *      pre-M9.4.5 behavior for non-AMX clusters and tests.
 */
function pickAuthor(src: Record<string, unknown>): string | null {
  const lowerToActual = Object.keys(src).reduce<Record<string, string>>((acc, k) => {
    acc[k.toLowerCase()] = k;
    return acc;
  }, {});

  // 1. authors_byline (string)
  const bylineKey = lowerToActual['authors_byline'];
  if (bylineKey !== undefined) {
    const v = src[bylineKey];
    if (v != null) {
      const s = String(v).trim();
      if (s.length > 0) return s;
    }
  }

  // 2. matched_authors[0].name (array)
  const matchedKey = lowerToActual['matched_authors'];
  if (matchedKey !== undefined) {
    const arr = src[matchedKey];
    if (Array.isArray(arr) && arr.length > 0) {
      const first = arr[0];
      if (first != null && typeof first === 'object') {
        const obj = first as Record<string, unknown>;
        const nameKey = Object.keys(obj).find((k) => k.toLowerCase() === 'name');
        if (nameKey !== undefined) {
          const v = obj[nameKey];
          if (v != null) {
            const s = String(v).trim();
            if (s.length > 0) return s;
          }
        }
      }
    }
  }

  // 3. Flat alias fallback (preserves pre-M9.4.5 tests).
  return pickAlias(src, ALIASES.author);
}

/**
 * Read `_source.reach` as a finite number. The AMX UAT cluster ships
 * this as `float`. We accept strings that parse cleanly (defensive —
 * some upstream loaders stringify everything). Returns null on absent,
 * non-numeric, NaN, or infinite values.
 */
function pickReach(src: Record<string, unknown>): number | null {
  const reachKey = Object.keys(src).find((k) => k.toLowerCase() === 'reach');
  if (reachKey === undefined) return null;
  const v = src[reachKey];
  if (v == null) return null;
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed.length === 0) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
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

  // M9.4.5: nested `sources.domain` takes precedence over the flat
  // alias lookup; URL parsing remains the last-resort fallback.
  const nestedSources = readNestedSources(src);
  const publisherDomain =
    nestedSources?.domain ?? pickAlias(src, ALIASES.publisherDomain) ?? extractDomain(url);

  // M9.4.5: convenience object for the payload builder. Falls back to
  // flat `publisher_domain` + `source` aliases when the nested
  // `_source.sources` object is absent (other indices / older docs).
  const flatDomainFallback = pickAlias(src, ALIASES.publisherDomain);
  const flatSourceNameFallback = pickAlias(src, ALIASES.source);
  const sources: { domain: string | null; name: string | null } | null = nestedSources
    ? nestedSources
    : flatDomainFallback != null || flatSourceNameFallback != null
      ? { domain: flatDomainFallback, name: flatSourceNameFallback }
      : null;

  return {
    title,
    content: pickAlias(src, ALIASES.content),
    description: pickAlias(src, ALIASES.description),
    source: pickAlias(src, ALIASES.source),
    author: pickAuthor(src),
    publishedDate: parseDate(pickAlias(src, ALIASES.publishedDate)),
    url,
    publisherDomain,
    // Schema caps language at 10 chars; lowercase to match CSV path.
    language: rawLanguage.slice(0, 10).toLowerCase(),
    country: pickAlias(src, ALIASES.country),
    reach: pickReach(src),
    sources,
    rawData: src as unknown as Prisma.InputJsonValue,
    openSearchId: hit._id,
  };
}
