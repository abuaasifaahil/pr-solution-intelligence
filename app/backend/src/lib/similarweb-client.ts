/**
 * Thin SimilarWeb API client — Phase 3 M8.6.
 *
 * We hit the v1 traffic endpoint
 * (https://api.similarweb.com/v1/website/<domain>/traffic-and-engagement/overview)
 * with the user's API key. No SDK — direct fetch.
 *
 * Caller (SimilarWebAgent) controls batching. This module owns:
 *   - per-user API key resolution (M5 data_sources → env fallback)
 *   - single-domain fetch + deterministic field normalization to the
 *     `reach_cache` row shape (visits → monthly_visitors, log-scale score)
 *   - batch wrapper that fans out via Promise.allSettled with a small
 *     concurrency cap so a single 5xx domain can't poison the whole job
 *
 * The score formula treats monthly_visitors on a log10 scale and pins
 * ~100M+ visitors to 100 and ~100 visitors to 0 (a "name only" domain).
 *
 * @file backend/src/lib/similarweb-client.ts
 */
import { withUser } from './prisma-rls.js';
import { decrypt } from './encryption.js';

const SIMILARWEB_BASE = 'https://api.similarweb.com/v1/website';

export interface SimilarWebResult {
  domain: string;
  monthly_visitors: number | null;
  global_rank: number | null;
  category: string | null;
  /** 0–100 normalized score derived from monthly_visitors (null when no data). */
  score: number | null;
  /** Raw upstream payload (or `{ error: <message> }` for failed fetches). */
  raw: unknown;
}

/**
 * Get the SimilarWeb API key for a user.
 *
 * Resolution order:
 *   1. M5 `data_sources` row, sourceType='custom', displayName ILIKE '%SimilarWeb%'.
 *      The stored `apiKeyEncrypted` is AES-256-GCM (M5); decrypt with the
 *      shared key. If decrypt fails (rotated ENCRYPTION_KEY, malformed
 *      ciphertext), fall through silently to the env path so the agent
 *      degrades to "no fetch" rather than crashing the job.
 *   2. `SIMILARWEB_API_KEY` env var (deployment-wide fallback).
 *   3. null — caller treats this as "skip uncached fetch".
 */
export async function getSimilarWebKey(userId: string): Promise<string | null> {
  const ds = await withUser(userId, async (tx) =>
    tx.dataSource.findFirst({
      where: {
        sourceType: 'custom',
        displayName: { contains: 'SimilarWeb', mode: 'insensitive' },
      },
    }),
  );
  if (ds?.apiKeyEncrypted) {
    try {
      return decrypt(ds.apiKeyEncrypted);
    } catch {
      // Fall through to env if decryption fails (rotated key / tamper).
    }
  }
  return process.env.SIMILARWEB_API_KEY ?? null;
}

/**
 * Normalize a raw SimilarWeb response into the reach_cache row shape.
 * Returns null fields when SimilarWeb has no data for the domain.
 *
 * Score formula: log10(monthly_visitors) * 12.5 - 25, clamped to 0..100.
 * Anchors: 100 visitors → 0, 1M → 50, 100M → 75, 1B → 87.5. The "1M ≈ 50"
 * intuition keeps a long-tail tech blog ahead of a no-data domain while
 * leaving headroom for the genuinely big publishers.
 */
function normalize(domain: string, raw: unknown): SimilarWebResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const visits = typeof r.visits === 'number' ? r.visits : null;
  const monthly = visits != null ? Math.round(visits) : null;
  const rank = typeof r.global_rank === 'number' ? r.global_rank : null;
  const category = typeof r.category === 'string' ? r.category : null;

  let score: number | null = null;
  if (monthly != null && monthly > 0) {
    const logVisits = Math.log10(monthly);
    score = Math.max(0, Math.min(100, Math.round((logVisits - 2) * 12.5)));
  }

  return { domain, monthly_visitors: monthly, global_rank: rank, category, score, raw };
}

/**
 * Single domain fetch.
 *
 * - 200 → normalize and return
 * - 404 → SimilarWeb has no data for this domain. Treat as "fetched but null"
 *   so we still cache the negative result (is_valid=false downstream); the
 *   alternative would be re-fetching the same dead domain on every chat.
 * - any other non-ok → throw. Caller (`fetchSimilarWebBatch`) catches via
 *   Promise.allSettled so one bad domain doesn't poison the batch.
 */
export async function fetchSimilarWeb(
  domain: string,
  apiKey: string,
): Promise<SimilarWebResult> {
  const url =
    `${SIMILARWEB_BASE}/${encodeURIComponent(domain)}/traffic-and-engagement/overview` +
    `?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    if (res.status === 404) {
      return normalize(domain, {});
    }
    throw new Error(`SimilarWeb ${res.status} for ${domain}`);
  }
  const json = await res.json();
  return normalize(domain, json);
}

/**
 * Batch fetch — spec says 50/call but the v1 endpoint is per-domain. We
 * implement "batch" as Promise.allSettled across chunks of size `concurrency`.
 * Failures are swallowed into a null row (with the raw error message in
 * `raw.error`) so the upstream upsert can mark `is_valid=false` for the
 * domain without losing track of which domains were attempted.
 */
export async function fetchSimilarWebBatch(
  domains: string[],
  apiKey: string,
  concurrency = 5,
): Promise<SimilarWebResult[]> {
  const results: SimilarWebResult[] = [];
  for (let i = 0; i < domains.length; i += concurrency) {
    const slice = domains.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      slice.map((d) => fetchSimilarWeb(d, apiKey)),
    );
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j]!;
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        results.push({
          domain: slice[j]!,
          monthly_visitors: null,
          global_rank: null,
          category: null,
          score: null,
          raw: { error: (r.reason as Error).message },
        });
      }
    }
  }
  return results;
}
