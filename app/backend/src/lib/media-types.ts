/**
 * Media types — primary axis for index routing. Maps from a
 * user-friendly media label to the OpenSearch index name pattern(s)
 * that hold that media.
 *
 * The wire format (`x_twitter`, `blogs`) matches what the IntentExtractor
 * (M9.3) will produce. The Python prod code uses string-contains matching
 * on labels like "x (twitter)" — we normalize to enum values upfront so
 * downstream code can use exact comparison.
 *
 * @file lib/media-types.ts
 */
import { z } from 'zod';

export const MediaTypeSchema = z.enum([
  'print',
  'x_twitter',
  'reddit',
  'youtube',
  'blogs',
  'forums',
  'reviews',
  'facebook',
  'tiktok',
  'linkedin',
  'online',
]);
export type MediaType = z.infer<typeof MediaTypeSchema>;

export const ALL_MEDIA_TYPES: readonly MediaType[] = MediaTypeSchema.options;

/**
 * Per-media-type "standalone" index patterns that get added regardless of
 * daywise/monthwise INDEX_TYPE. `online` is intentionally empty here — its
 * indices are computed per-month in `getMonthwiseIndices()`.
 */
export const MEDIA_TYPE_INDICES: Record<MediaType, readonly string[]> = {
  print: ['amx-print*'],
  x_twitter: ['amx-twitter*'],
  reddit: ['amx-reddit*'],
  youtube: ['amx-youtube*'],
  blogs: ['amx-webz-social*'],
  forums: ['amx-webz-social*'],
  reviews: ['amx-webz-social*'],
  facebook: ['amx-facebook*'],
  tiktok: ['amx-tiktok*'],
  linkedin: ['amx-linkedin*'],
  online: [], // online has month-scoped patterns — see getMonthwiseIndices
};

/**
 * Parses an env CSV like "online,blogs,reviews" into a deduped MediaType[].
 * Unknown labels are silently dropped (and logged once in production).
 * Empty/whitespace input returns `null` (interpreted by callers as "all").
 */
export function parseMediaTypesFromCsv(csv: string | null | undefined): MediaType[] | null {
  if (!csv) return null;
  const tokens = csv.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) return null;
  // Tolerate legacy label aliases from the Python code (e.g. "x (twitter)").
  const ALIAS: Record<string, MediaType> = {
    'x (twitter)': 'x_twitter',
    'twitter': 'x_twitter',
    'x': 'x_twitter',
  };
  const out = new Set<MediaType>();
  for (const t of tokens) {
    const aliased = ALIAS[t];
    if (aliased) {
      out.add(aliased);
      continue;
    }
    const parsed = MediaTypeSchema.safeParse(t);
    if (parsed.success) out.add(parsed.data);
  }
  return out.size === 0 ? null : Array.from(out);
}
