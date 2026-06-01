/**
 * Scans an article batch and reports which signal fields are populated.
 * Used by DataExtractAgent (M9.5) to decide whether to probe the user
 * about upgrading to Enrichment + SimilarWeb when reach is absent.
 *
 * Sampling: examines the FIRST N articles only (default 50). If less
 * than 80% of those carry a non-null value for a field, we treat it as
 * "absent at scale" — sparse fields are reported as not-present.
 *
 * @file lib/field-presence-detector.ts
 */
import type { NormalizedArticleFields } from './opensearch-mapping.js';

export interface FieldPresence {
  hasReach: boolean;
  hasCountry: boolean;
  hasPublisherDomain: boolean;
  hasAuthor: boolean;
  hasDescription: boolean;
  /** Per-field coverage (0..1) across the sample. */
  coverage: {
    reach: number;
    country: number;
    publisherDomain: number;
    author: number;
    description: number;
  };
  /** How many articles were inspected. */
  sampleSize: number;
}

const DEFAULT_SAMPLE = 50;
const PRESENCE_THRESHOLD = 0.8;

export function detectFieldPresence(
  articles: ReadonlyArray<Partial<NormalizedArticleFields>>,
  options: { sampleSize?: number; threshold?: number } = {},
): FieldPresence {
  const sample = articles.slice(0, options.sampleSize ?? DEFAULT_SAMPLE);
  const threshold = options.threshold ?? PRESENCE_THRESHOLD;
  const total = sample.length;
  if (total === 0) {
    return {
      hasReach: false,
      hasCountry: false,
      hasPublisherDomain: false,
      hasAuthor: false,
      hasDescription: false,
      coverage: { reach: 0, country: 0, publisherDomain: 0, author: 0, description: 0 },
      sampleSize: 0,
    };
  }
  const reachCount = sample.filter(
    (a) => typeof a.reach === 'number' && Number.isFinite(a.reach),
  ).length;
  const countryCount = sample.filter(
    (a) => typeof a.country === 'string' && a.country.length > 0,
  ).length;
  const domainCount = sample.filter(
    (a) => typeof a.publisherDomain === 'string' && a.publisherDomain.length > 0,
  ).length;
  const authorCount = sample.filter(
    (a) => typeof a.author === 'string' && a.author.length > 0,
  ).length;
  const descCount = sample.filter(
    (a) => typeof a.description === 'string' && a.description.length > 0,
  ).length;

  const cov = {
    reach: reachCount / total,
    country: countryCount / total,
    publisherDomain: domainCount / total,
    author: authorCount / total,
    description: descCount / total,
  };
  return {
    hasReach: cov.reach >= threshold,
    hasCountry: cov.country >= threshold,
    hasPublisherDomain: cov.publisherDomain >= threshold,
    hasAuthor: cov.author >= threshold,
    hasDescription: cov.description >= threshold,
    coverage: cov,
    sampleSize: total,
  };
}
