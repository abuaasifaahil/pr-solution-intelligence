/**
 * M9.1 — OpenSearch index resolver unit tests.
 *
 * Pure-function suite. No IO. We exercise the daywise expansion, the
 * raw-wildcard fallback, and the 1-year safety cap.
 *
 * env vars are read at module load via `loadEnv()`. The required vars
 * (DB/Redis/JWT/Azure/ENCRYPTION_KEY) come from the dev `.env`; we only
 * pin OpenSearch tuning vars when we want to override the Zod defaults.
 */
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  // Keep the resolver on the daywise branch with deterministic values.
  process.env.OPENSEARCH_INDEX_NAME ??= 'amx-data*';
  process.env.OPENSEARCH_INDEX_TYPE ??= 'daywise';
  process.env.OPENSEARCH_PATTERN_OF_INDEX ??= 'YYYY-MM-DD';
});

const { resolveIndices } = await import('../../src/lib/opensearch-indices.js');

describe('resolveIndices', () => {
  it('null range → raw wildcard fallback', () => {
    expect(resolveIndices(null)).toEqual(['amx-data*']);
  });

  it('expands a 5-day inclusive range into daily indices', () => {
    const out = resolveIndices({
      start: new Date('2026-04-01T00:00:00.000Z'),
      end: new Date('2026-04-05T00:00:00.000Z'),
    });
    expect(out).toEqual([
      'amx-data-2026-04-01',
      'amx-data-2026-04-02',
      'amx-data-2026-04-03',
      'amx-data-2026-04-04',
      'amx-data-2026-04-05',
    ]);
  });

  it('single-day range returns exactly 1 index', () => {
    const out = resolveIndices({
      start: new Date('2026-04-15T00:00:00.000Z'),
      end: new Date('2026-04-15T00:00:00.000Z'),
    });
    expect(out).toEqual(['amx-data-2026-04-15']);
  });

  it('handles month boundary correctly', () => {
    const out = resolveIndices({
      start: new Date('2026-01-30T00:00:00.000Z'),
      end: new Date('2026-02-02T00:00:00.000Z'),
    });
    expect(out).toEqual([
      'amx-data-2026-01-30',
      'amx-data-2026-01-31',
      'amx-data-2026-02-01',
      'amx-data-2026-02-02',
    ]);
  });

  it('1-year cap kicks in for ranges > 366 days', () => {
    const out = resolveIndices({
      start: new Date('2024-01-01T00:00:00.000Z'),
      end: new Date('2026-12-31T00:00:00.000Z'), // ~3 years
    });
    // Cap fires once `out.length > 366` → produces 367 then breaks.
    expect(out.length).toBeLessThanOrEqual(367);
    expect(out[0]).toBe('amx-data-2024-01-01');
  });

  it('uses end-of-day inclusive comparison (range starts == ends OK)', () => {
    const same = new Date('2026-06-01T18:23:00.000Z');
    expect(resolveIndices({ start: same, end: same })).toEqual([
      'amx-data-2026-06-01',
    ]);
  });
});
