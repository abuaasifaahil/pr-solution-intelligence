/**
 * Deterministic SHA-256 of normalized search parameters — M9.5.
 *
 * Used as the memory key in `search_history.query_hash`. The same input
 * (regardless of array order or whitespace variations) MUST produce the
 * same hash so SearchAgent can short-circuit a re-execution of a chat
 * that was already fetched once.
 *
 * Determinism guarantees:
 *  - Competitors and mediaTypes are sorted alphabetically before hashing.
 *  - Brand strings are trim()+toLowerCase()'d (semantically the AMX
 *    cluster's `multi_match` treats brand case-insensitively).
 *  - `dateRange` is the structured `{start, end}` strings already emitted
 *    by the boolean-query engine — ISO `YYYY-MM-DD`. `null` and an
 *    absent date range collapse to the same canonical `null` key.
 *  - `language` is lowercased.
 *
 * `competitorFields` / `brandFields` from `BooleanQueryStructured` are
 * INTENTIONALLY excluded — they're cluster-mapping concerns, not user
 * intent. A re-fetch with the same brand/dates/competitors/mediaTypes
 * should hit the cache even if the cluster's index mapping evolves.
 *
 * @file lib/query-hash.ts
 */
import { createHash } from 'node:crypto';
import type { BooleanQueryStructured } from './boolean-query-engine.js';
import type { MediaType } from './media-types.js';

export interface QueryHashInput {
  /** Output of M7.6's `generateBooleanQuery()`. */
  structured: BooleanQueryStructured;
  /** From chat_params.mediaTypes. Empty array == "use platform default". */
  mediaTypes: MediaType[];
}

export function hashSearchQuery(input: QueryHashInput): string {
  const norm = {
    brand: input.structured.brand.trim().toLowerCase(),
    competitors: [...input.structured.competitors]
      .map((c) => c.trim().toLowerCase())
      .sort(),
    dateRange: input.structured.dateRange ?? null,
    mediaTypes: [...input.mediaTypes].sort(),
    language: input.structured.language.toLowerCase(),
  };
  const json = JSON.stringify(norm);
  return createHash('sha256').update(json).digest('hex');
}
