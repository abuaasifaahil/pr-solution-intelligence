import { URL } from 'node:url';
import { FIELD_ALIASES, type NormalizedFieldKey } from './field-aliases.js';

/**
 * Article normalizer — M7.4.
 *
 * Pure functions that map a CSV/JSON row with arbitrary column names into the
 * canonical `Article` shape we insert. Datasets in the wild use
 * `headline`/`title`/`subject` for the same field, `body`/`content`/`text`
 * interchangeably, etc. — keep the alias table editable so analysts can
 * onboard new schemas without code changes.
 *
 * No DB, no IO. Every helper is unit-testable in isolation; see
 * `test/lib/article-normalizer.test.ts`.
 *
 * M9.2: alias map moved to `lib/field-aliases.ts` (shared with the
 * OpenSearch path). The CSV path uses the same 8 fields that existed
 * before (no `publisherDomain` — CSV derives that from URL + source).
 */

/** Canonical Article shape we insert into the DB (excluding system fields). */
export interface NormalizedArticle {
  title: string;
  content: string | null;
  description: string | null;
  source: string | null;
  author: string | null;
  publishedDate: Date | null;
  url: string | null;
  publisherDomain: string | null;
  language: string;
  rawData: Record<string, unknown>;
}

/** CSV-relevant subset of the shared FIELD_ALIASES map. The CSV path does
 *  not consume a `publisherDomain` alias (it derives that from URL/source
 *  on its own), so we project the shared map down to the 8 keys the CSV
 *  normalizer needs.
 *
 *  Kept exported as `COLUMN_ALIASES` for backwards compatibility with
 *  callers and tests written before M9.2 lifted the map. */
type CsvAliasKey = Exclude<NormalizedFieldKey, 'publisherDomain'>;
export const COLUMN_ALIASES: Record<CsvAliasKey, readonly string[]> = {
  title: FIELD_ALIASES.title,
  content: FIELD_ALIASES.content,
  description: FIELD_ALIASES.description,
  source: FIELD_ALIASES.source,
  author: FIELD_ALIASES.author,
  publishedDate: FIELD_ALIASES.publishedDate,
  url: FIELD_ALIASES.url,
  language: FIELD_ALIASES.language,
} as const;

/**
 * Find the first column key in `row` that maps to `field` per COLUMN_ALIASES.
 * Case-insensitive match. Returns null when no alias is present or the value
 * is null/whitespace-only.
 */
export function pickField(
  row: Record<string, unknown>,
  field: keyof typeof COLUMN_ALIASES,
): string | null {
  // Build a lowercase-key → actual-key index for O(1) lookup per alias.
  const lower: Record<string, string> = {};
  for (const k of Object.keys(row)) {
    lower[k.toLowerCase()] = k;
  }
  for (const alias of COLUMN_ALIASES[field]) {
    const actual = lower[alias.toLowerCase()];
    if (actual == null) continue;
    const value = row[actual];
    if (value == null) continue;
    const str = String(value).trim();
    if (str === '') continue;
    return str;
  }
  return null;
}

/**
 * Extract hostname from a URL string. Strips leading "www.". Returns null on
 * parse failure. Used for Phase 3 reach lookups.
 */
export function extractDomain(url: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (trimmed === '') return null;
  try {
    const u = new URL(trimmed.startsWith('http') ? trimmed : 'https://' + trimmed);
    const host = u.hostname.replace(/^www\./, '');
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

/** Parse a date string into a Date. Returns null if unparseable. */
export function parsePublishedDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Map a row into a NormalizedArticle. Missing columns produce nulls; the
 * title is defaulted to `(untitled)` so we always satisfy the
 * Article.title NOT NULL constraint.
 */
export function normalize(row: Record<string, unknown>): NormalizedArticle {
  const title = pickField(row, 'title') ?? '(untitled)';
  const url = pickField(row, 'url');
  const source = pickField(row, 'source');
  return {
    title,
    content: pickField(row, 'content'),
    description: pickField(row, 'description'),
    source,
    author: pickField(row, 'author'),
    publishedDate: parsePublishedDate(pickField(row, 'publishedDate')),
    url,
    publisherDomain: extractDomain(url) ?? source ?? null,
    language: (pickField(row, 'language') ?? 'en').slice(0, 10).toLowerCase(),
    rawData: row,
  };
}

/**
 * Auto-detect which column in the schema is the date column. Used to
 * populate uploads.date_column + date_range_start/end.
 */
export function detectDateColumn(columns: string[]): string | null {
  const lower = columns.map((c) => c.toLowerCase());
  for (const alias of COLUMN_ALIASES.publishedDate) {
    const i = lower.indexOf(alias.toLowerCase());
    if (i >= 0) return columns[i] ?? null;
  }
  return null;
}

/** Detect schema: [{name, type, sample}] from the first row. */
export function detectSchema(
  rows: Record<string, unknown>[],
): Array<{ name: string; type: string; sample: unknown }> {
  if (rows.length === 0) return [];
  const first = rows[0];
  if (!first) return [];
  return Object.keys(first).map((name) => {
    const sample = first[name];
    const type = sample == null ? 'unknown' : typeof sample;
    return { name, type, sample };
  });
}
