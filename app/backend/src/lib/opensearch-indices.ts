/**
 * OpenSearch index resolver — M9.1.2.
 *
 * Mirrors the AlphaMetricX production logic. Three resolution modes:
 *
 * 1. No date range supplied → wildcard `amx-data-*` plus all media-type
 *    standalone indices (or only the requested subset).
 *
 * 2. INDEX_TYPE='daywise' with date range:
 *    - Always includes `amx-data-old-others*` (legacy archive).
 *    - If `(end - start).days > 27`: emit ONE index per MONTH in range
 *      using `amx-data-{YYYY-MM}*` pattern (note: trailing wildcard).
 *    - Else: emit ONE index per DAY using `amx-data-{YYYY-MM-DD}*`
 *      (note: trailing wildcard — every daily index in prod has a
 *      type-suffix beyond the date).
 *    - Plus the media-type standalone indices.
 *
 * 3. INDEX_TYPE='monthwise' with date range: completely different index
 *    family (firehose / opoint / twingly), keyed by media-type group.
 *    See `getMonthwiseIndices()`.
 *
 * Output is deduped (set-flatten) and returned sorted for deterministic
 * test assertions and easier log diffing.
 *
 * @file lib/opensearch-indices.ts
 */
import { loadEnv } from '../env.js';
import {
  ALL_MEDIA_TYPES,
  MEDIA_TYPE_INDICES,
  type MediaType,
} from './media-types.js';

/** UTC-only date math. Always returns the start-of-day instant. */
function utcStartOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Format a UTC date using a YYYY/MM/DD pattern. */
function formatPattern(d: Date, pattern: string): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return pattern
    .replace(/YYYY/g, String(y))
    .replace(/MM/g, m)
    .replace(/DD/g, day);
}

/** Count whole UTC days between two dates (inclusive of end). */
function dayDelta(start: Date, end: Date): number {
  const ms = utcStartOfDay(end).getTime() - utcStartOfDay(start).getTime();
  return Math.floor(ms / 86_400_000);
}

export interface ResolveIndicesInput {
  dateRange?: { start: Date; end: Date } | null;
  mediaTypes?: MediaType[] | null; // null = all
}

/**
 * Resolve indices to query. Returns a deduped + sorted list ready to pass
 * to `client.search({ index: list.join(',') })`.
 *
 * Behavior matches the prod Python code 1:1 except:
 * - We sort for determinism (Python returned `list(set(...))` which is unordered).
 * - We don't include `amx-data-*` as a fallback when the per-day list is computed.
 */
export function resolveIndices(input: ResolveIndicesInput = {}): string[] {
  const env = loadEnv();
  const { dateRange, mediaTypes } = input;

  // Resolve which media types to consider. `null` or `[]` = all 11.
  const types: MediaType[] =
    mediaTypes && mediaTypes.length > 0 ? mediaTypes : [...ALL_MEDIA_TYPES];

  const out = new Set<string>();

  if (env.OPENSEARCH_INDEX_TYPE === 'monthwise') {
    for (const ix of getMonthwiseIndices(dateRange ?? null, types)) out.add(ix);
  } else {
    // INDEX_TYPE ∈ {daywise, single} → daywise behavior (single hits same path
    // because the prod code only branches on `month` substring).
    for (const ix of getDaywiseIndices(dateRange ?? null, types)) out.add(ix);
  }

  // Standalone media-type indices (added in both modes — per prod code).
  for (const t of types) {
    for (const ix of MEDIA_TYPE_INDICES[t]) out.add(ix);
  }

  return Array.from(out).sort();
}

/** Internal: daywise pattern, matches `OpensearchConnection.get_opensearch_indexes`. */
function getDaywiseIndices(
  dateRange: { start: Date; end: Date } | null,
  _types: MediaType[], // unused here; standalone indices added by caller
): string[] {
  if (!dateRange) {
    return ['amx-data-*'];
  }
  const out: string[] = ['amx-data-old-others*'];
  const delta = dayDelta(dateRange.start, dateRange.end);
  if (delta > 27) {
    // Auto-switch to monthly granularity within daywise — matches prod.
    const cursor = new Date(
      Date.UTC(dateRange.start.getUTCFullYear(), dateRange.start.getUTCMonth(), 1),
    );
    const endMonth = Date.UTC(dateRange.end.getUTCFullYear(), dateRange.end.getUTCMonth(), 1);
    let safety = 0;
    while (cursor.getTime() <= endMonth && safety++ < 36) {
      out.push(`amx-data-${formatPattern(cursor, 'YYYY-MM')}*`);
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  } else {
    const cursor = utcStartOfDay(dateRange.start);
    const endDay = utcStartOfDay(dateRange.end).getTime();
    let safety = 0;
    while (cursor.getTime() <= endDay && safety++ < 90) {
      out.push(`amx-data-${formatPattern(cursor, 'YYYY-MM-DD')}*`);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  return out;
}

/** Internal: monthwise pattern, matches `OpensearchConnection.get_opensearch_indexes_monthwise`. */
function getMonthwiseIndices(
  dateRange: { start: Date; end: Date } | null,
  types: MediaType[],
): string[] {
  if (!dateRange) {
    return ['amx-data'];
  }
  const includesOnline = types.includes('online');
  const includesBlogish = types.some((t) => t === 'blogs' || t === 'forums' || t === 'reviews');

  const out: string[] = [];
  const cursor = new Date(
    Date.UTC(dateRange.start.getUTCFullYear(), dateRange.start.getUTCMonth(), 1),
  );
  const endMonth = Date.UTC(dateRange.end.getUTCFullYear(), dateRange.end.getUTCMonth(), 1);
  let safety = 0;

  while (cursor.getTime() <= endMonth && safety++ < 36) {
    const ym = formatPattern(cursor, 'YYYY-MM');
    if (includesOnline) {
      out.push(`amx-webz-firehose-${ym}*`);
      out.push(`amx-opoint-${ym}*`);
      out.push('amx-webz-firehose-*-others'); // NOT month-scoped
    }
    if (includesBlogish) {
      out.push(`amx-twingly-${ym}*`);
      out.push('amx-twingly-old-others*');
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}
