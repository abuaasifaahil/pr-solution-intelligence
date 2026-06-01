/**
 * OpenSearch index resolver — M9.1.
 *
 * Resolves daily-partitioned OpenSearch indices.
 *
 * Given INDEX_NAME='amx-data*' + INDEX_TYPE='daywise' + PATTERN_OF_INDEX='YYYY-MM-DD'
 * + a date range, returns the SPECIFIC daily index names to query — much
 * faster than scanning the full wildcard.
 *
 * Example: dateRange = 2026-04-01 .. 2026-04-05 →
 *   ['amx-data-2026-04-01', 'amx-data-2026-04-02', 'amx-data-2026-04-03',
 *    'amx-data-2026-04-04', 'amx-data-2026-04-05']
 *
 * INDEX_NAME wildcards: a trailing `*` is stripped before appending the
 * date suffix ('amx-data*' → 'amx-data-YYYY-MM-DD'). If INDEX_TYPE !=
 * 'daywise' OR no dateRange is supplied, the raw INDEX_NAME (with its
 * wildcard intact) is returned as a one-element list so callers can pass
 * it directly to `client.search({ index })`.
 *
 * @file lib/opensearch-indices.ts
 */
import { loadEnv } from '../env.js';

function pad(n: number, len: number): string {
  return String(n).padStart(len, '0');
}

/** Format a UTC date through the pattern (YYYY/MM/DD tokens). */
function formatDate(d: Date, pattern: string): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return pattern
    .replace(/YYYY/g, String(y))
    .replace(/MM/g, pad(m, 2))
    .replace(/DD/g, pad(day, 2));
}

/**
 * Resolve indices to query for a given date range.
 *
 * - `null` range OR non-daywise INDEX_TYPE → `[INDEX_NAME]` (raw wildcard)
 * - daywise + range → one index per calendar day, inclusive of both ends
 * - safety cap: maximum 366 indices (one year). Beyond that, callers
 *   should query the wildcard instead. The cap is intentionally chosen
 *   to match the per-chat date-range limit enforced upstream.
 */
export function resolveIndices(
  dateRange: { start: Date; end: Date } | null,
): string[] {
  const env = loadEnv();
  if (!dateRange || env.OPENSEARCH_INDEX_TYPE !== 'daywise') {
    return [env.OPENSEARCH_INDEX_NAME];
  }
  // Strip a trailing wildcard so 'amx-data*' becomes 'amx-data', then we
  // append '-YYYY-MM-DD'. If the wildcard is mid-name (e.g. 'amx-*-data'),
  // we leave it literal — that's a pattern, not a daily template.
  const base = env.OPENSEARCH_INDEX_NAME.replace(/\*$/, '');
  const pattern = env.OPENSEARCH_PATTERN_OF_INDEX;

  const out: string[] = [];
  const cur = new Date(
    Date.UTC(
      dateRange.start.getUTCFullYear(),
      dateRange.start.getUTCMonth(),
      dateRange.start.getUTCDate(),
    ),
  );
  const endUtc = Date.UTC(
    dateRange.end.getUTCFullYear(),
    dateRange.end.getUTCMonth(),
    dateRange.end.getUTCDate(),
  );
  while (cur.getTime() <= endUtc) {
    out.push(`${base}-${formatDate(cur, pattern)}`);
    cur.setUTCDate(cur.getUTCDate() + 1);
    if (out.length > 366) break; // safety: cap at 1 year
  }
  return out;
}
