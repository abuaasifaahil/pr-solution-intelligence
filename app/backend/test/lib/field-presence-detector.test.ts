/**
 * M9.4.5 — field-presence detector tests.
 *
 * Pure-function suite. Confirms sampling, threshold semantics, sample-
 * size cap, and per-field independence.
 */
import { describe, it, expect } from 'vitest';
import { detectFieldPresence } from '../../src/lib/field-presence-detector.js';
import type { NormalizedArticleFields } from '../../src/lib/opensearch-mapping.js';

/** Build a partial article. Anything not passed is left absent. */
function article(over: Partial<NormalizedArticleFields> = {}): Partial<NormalizedArticleFields> {
  return over;
}

describe('detectFieldPresence', () => {
  it('empty array → all hasX = false, all coverage = 0, sampleSize = 0', () => {
    const result = detectFieldPresence([]);
    expect(result.hasReach).toBe(false);
    expect(result.hasCountry).toBe(false);
    expect(result.hasPublisherDomain).toBe(false);
    expect(result.hasAuthor).toBe(false);
    expect(result.hasDescription).toBe(false);
    expect(result.coverage).toEqual({
      reach: 0,
      country: 0,
      publisherDomain: 0,
      author: 0,
      description: 0,
    });
    expect(result.sampleSize).toBe(0);
  });

  it('50 articles all with reach → hasReach = true, coverage.reach = 1.0', () => {
    const articles = Array.from({ length: 50 }, () => article({ reach: 1234.5 }));
    const result = detectFieldPresence(articles);
    expect(result.hasReach).toBe(true);
    expect(result.coverage.reach).toBe(1.0);
    expect(result.sampleSize).toBe(50);
  });

  it('50 articles, 39 with reach (78% — just under threshold) → hasReach = false', () => {
    const withReach = Array.from({ length: 39 }, () => article({ reach: 100 }));
    const without = Array.from({ length: 11 }, () => article());
    const result = detectFieldPresence([...withReach, ...without]);
    expect(result.coverage.reach).toBeCloseTo(0.78, 2);
    expect(result.hasReach).toBe(false);
  });

  it('50 articles, 40 with reach (80%) → hasReach = true', () => {
    const withReach = Array.from({ length: 40 }, () => article({ reach: 100 }));
    const without = Array.from({ length: 10 }, () => article());
    const result = detectFieldPresence([...withReach, ...without]);
    expect(result.coverage.reach).toBeCloseTo(0.8, 5);
    expect(result.hasReach).toBe(true);
  });

  it('sample size cap: 200 articles + sampleSize=50 → only first 50 sampled', () => {
    // First 50: all have reach. Next 150: none. Coverage MUST be 1.0
    // because we only sampled the first 50.
    const withReach = Array.from({ length: 50 }, () => article({ reach: 5 }));
    const without = Array.from({ length: 150 }, () => article());
    const result = detectFieldPresence([...withReach, ...without], { sampleSize: 50 });
    expect(result.sampleSize).toBe(50);
    expect(result.coverage.reach).toBe(1.0);
    expect(result.hasReach).toBe(true);
  });

  it('custom threshold 0.5 → 50% coverage passes', () => {
    const withReach = Array.from({ length: 25 }, () => article({ reach: 1 }));
    const without = Array.from({ length: 25 }, () => article());
    const result = detectFieldPresence([...withReach, ...without], { threshold: 0.5 });
    expect(result.coverage.reach).toBe(0.5);
    expect(result.hasReach).toBe(true);
  });

  it('mixed signals: hasReach=false but hasAuthor=true on the same sample', () => {
    // 50 articles: every article has an author; only 10 have reach.
    const mixed = Array.from({ length: 50 }, (_, i) => {
      const a: Partial<NormalizedArticleFields> = { author: `Author ${i}` };
      if (i < 10) a.reach = 99;
      return a;
    });
    const result = detectFieldPresence(mixed);
    expect(result.hasAuthor).toBe(true);
    expect(result.coverage.author).toBe(1.0);
    expect(result.hasReach).toBe(false);
    expect(result.coverage.reach).toBeCloseTo(0.2, 5);
  });

  it('ignores non-finite reach values (NaN/Infinity)', () => {
    const nans = Array.from({ length: 50 }, () => article({ reach: Number.NaN }));
    const result = detectFieldPresence(nans);
    expect(result.hasReach).toBe(false);
    expect(result.coverage.reach).toBe(0);

    const infs = Array.from({ length: 50 }, () => article({ reach: Infinity }));
    const r2 = detectFieldPresence(infs);
    expect(r2.hasReach).toBe(false);
  });

  it('treats empty-string fields as absent (country, author, etc.)', () => {
    const empties = Array.from({ length: 50 }, () =>
      article({ country: '', author: '', publisherDomain: '', description: '' }),
    );
    const result = detectFieldPresence(empties);
    expect(result.hasCountry).toBe(false);
    expect(result.hasAuthor).toBe(false);
    expect(result.hasPublisherDomain).toBe(false);
    expect(result.hasDescription).toBe(false);
    expect(result.coverage.country).toBe(0);
  });
});
