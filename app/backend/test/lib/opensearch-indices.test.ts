/**
 * M9.1.2 — OpenSearch index resolver unit tests.
 *
 * Pure-function suite. Mirrors the AMX production logic:
 *  - daywise (with auto-switch to monthly at >27d) + standalone media indices
 *  - monthwise (firehose/opoint/twingly family) + standalone media indices
 *  - no-date fallback
 *
 * env.OPENSEARCH_INDEX_TYPE is mutated per-test via vi.resetModules so each
 * resolveIndices import sees the value it expects.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const ORIG_INDEX_TYPE = process.env.OPENSEARCH_INDEX_TYPE;

beforeEach(() => {
  vi.resetModules();
});

afterAll(() => {
  if (ORIG_INDEX_TYPE === undefined) {
    delete process.env.OPENSEARCH_INDEX_TYPE;
  } else {
    process.env.OPENSEARCH_INDEX_TYPE = ORIG_INDEX_TYPE;
  }
});

async function loadResolver(indexType: 'daywise' | 'monthwise' | 'single') {
  process.env.OPENSEARCH_INDEX_TYPE = indexType;
  vi.resetModules();
  return await import('../../src/lib/opensearch-indices.js');
}

describe('resolveIndices — daywise mode', () => {
  it('no date range, no media types → wildcard + all standalone media indices', async () => {
    const { resolveIndices } = await loadResolver('daywise');
    const out = resolveIndices({});
    // Sorted. `online` contributes nothing standalone.
    expect(out).toEqual([
      'amx-data-*',
      'amx-facebook*',
      'amx-linkedin*',
      'amx-print*',
      'amx-reddit*',
      'amx-tiktok*',
      'amx-twitter*',
      'amx-webz-social*',
      'amx-youtube*',
    ]);
  });

  it('no date range, only ["print"] → wildcard + amx-print*', async () => {
    const { resolveIndices } = await loadResolver('daywise');
    const out = resolveIndices({ mediaTypes: ['print'] });
    expect(out).toEqual(['amx-data-*', 'amx-print*']);
  });

  it('5-day range, default media → old-others + 5 daily indices (trailing wildcard) + 8 media', async () => {
    const { resolveIndices } = await loadResolver('daywise');
    const out = resolveIndices({
      dateRange: {
        start: new Date('2026-04-01T00:00:00.000Z'),
        end: new Date('2026-04-05T00:00:00.000Z'),
      },
    });
    expect(out).toContain('amx-data-old-others*');
    expect(out).toContain('amx-data-2026-04-01*');
    expect(out).toContain('amx-data-2026-04-02*');
    expect(out).toContain('amx-data-2026-04-03*');
    expect(out).toContain('amx-data-2026-04-04*');
    expect(out).toContain('amx-data-2026-04-05*');
    // 8 standalone media-type indices (print, x_twitter, reddit, youtube,
    // facebook, tiktok, linkedin, webz-social — `online` contributes none).
    expect(out).toContain('amx-print*');
    expect(out).toContain('amx-twitter*');
    expect(out).toContain('amx-reddit*');
    expect(out).toContain('amx-youtube*');
    expect(out).toContain('amx-facebook*');
    expect(out).toContain('amx-tiktok*');
    expect(out).toContain('amx-linkedin*');
    expect(out).toContain('amx-webz-social*');
    // Total = 1 old-others + 5 daily + 8 media = 14
    expect(out).toHaveLength(14);
  });

  it('30-day range → auto-switches to monthly aggregates (no daily indices)', async () => {
    const { resolveIndices } = await loadResolver('daywise');
    const out = resolveIndices({
      dateRange: {
        start: new Date('2026-04-01T00:00:00.000Z'),
        end: new Date('2026-05-01T00:00:00.000Z'), // 30 days inclusive => delta=30 > 27
      },
    });
    expect(out).toContain('amx-data-old-others*');
    expect(out).toContain('amx-data-2026-04*');
    expect(out).toContain('amx-data-2026-05*');
    // NO daily indices
    expect(out.some((s) => /amx-data-\d{4}-\d{2}-\d{2}\*/.test(s))).toBe(false);
  });

  it('1-day range + only ["x_twitter"] → daily index + old-others + amx-twitter*', async () => {
    const { resolveIndices } = await loadResolver('daywise');
    const out = resolveIndices({
      dateRange: {
        start: new Date('2026-04-01T00:00:00.000Z'),
        end: new Date('2026-04-01T00:00:00.000Z'),
      },
      mediaTypes: ['x_twitter'],
    });
    expect(out).toEqual(['amx-data-2026-04-01*', 'amx-data-old-others*', 'amx-twitter*']);
  });

  it('empty mediaTypes [] is treated like null (= all)', async () => {
    const { resolveIndices } = await loadResolver('daywise');
    const a = resolveIndices({ mediaTypes: [] });
    const b = resolveIndices({ mediaTypes: null });
    expect(a).toEqual(b);
  });

  it('safety cap: 100-day range produces ≤36 month indices', async () => {
    const { resolveIndices } = await loadResolver('daywise');
    const out = resolveIndices({
      dateRange: {
        start: new Date('2024-01-01T00:00:00.000Z'),
        end: new Date('2027-12-31T00:00:00.000Z'),
      },
    });
    const monthlies = out.filter((s) => /^amx-data-\d{4}-\d{2}\*$/.test(s));
    expect(monthlies.length).toBeLessThanOrEqual(36);
  });

  it('100-day range → 4 monthly indices', async () => {
    const { resolveIndices } = await loadResolver('daywise');
    const out = resolveIndices({
      dateRange: {
        start: new Date('2026-01-01T00:00:00.000Z'),
        end: new Date('2026-04-10T00:00:00.000Z'), // 100 days, spans Jan/Feb/Mar/Apr
      },
    });
    const monthlies = out.filter((s) => /^amx-data-\d{4}-\d{2}\*$/.test(s));
    expect(monthlies).toEqual([
      'amx-data-2026-01*',
      'amx-data-2026-02*',
      'amx-data-2026-03*',
      'amx-data-2026-04*',
    ]);
  });
});

describe('resolveIndices — monthwise mode', () => {
  it('2-month range, only ["online"] → firehose + opoint + others (no twingly)', async () => {
    const { resolveIndices } = await loadResolver('monthwise');
    const out = resolveIndices({
      dateRange: {
        start: new Date('2026-04-01T00:00:00.000Z'),
        end: new Date('2026-05-01T00:00:00.000Z'),
      },
      mediaTypes: ['online'],
    });
    expect(out).toContain('amx-webz-firehose-2026-04*');
    expect(out).toContain('amx-opoint-2026-04*');
    expect(out).toContain('amx-webz-firehose-2026-05*');
    expect(out).toContain('amx-opoint-2026-05*');
    expect(out).toContain('amx-webz-firehose-*-others');
    // No twingly indices, no standalone media indices (online has none)
    expect(out.some((s) => s.startsWith('amx-twingly'))).toBe(false);
  });

  it('2-month range, ["blogs","x_twitter"] → twingly + standalone media, no firehose/opoint', async () => {
    const { resolveIndices } = await loadResolver('monthwise');
    const out = resolveIndices({
      dateRange: {
        start: new Date('2026-04-01T00:00:00.000Z'),
        end: new Date('2026-05-01T00:00:00.000Z'),
      },
      mediaTypes: ['blogs', 'x_twitter'],
    });
    expect(out).toContain('amx-twingly-2026-04*');
    expect(out).toContain('amx-twingly-2026-05*');
    expect(out).toContain('amx-twingly-old-others*');
    expect(out).toContain('amx-webz-social*');
    expect(out).toContain('amx-twitter*');
    expect(out.some((s) => s.startsWith('amx-webz-firehose'))).toBe(false);
    expect(out.some((s) => s.startsWith('amx-opoint'))).toBe(false);
  });
});

describe('resolveIndices — invariants', () => {
  it('output is sorted', async () => {
    const { resolveIndices } = await loadResolver('daywise');
    const out = resolveIndices({
      dateRange: {
        start: new Date('2026-04-01T00:00:00.000Z'),
        end: new Date('2026-04-03T00:00:00.000Z'),
      },
    });
    const sorted = [...out].sort();
    expect(out).toEqual(sorted);
  });

  it('output is deduped: blogs+forums both contribute amx-webz-social* only once', async () => {
    const { resolveIndices } = await loadResolver('daywise');
    const out = resolveIndices({ mediaTypes: ['blogs', 'forums', 'reviews'] });
    const occurrences = out.filter((s) => s === 'amx-webz-social*').length;
    expect(occurrences).toBe(1);
  });

  it('single INDEX_TYPE behaves like daywise', async () => {
    const { resolveIndices } = await loadResolver('single');
    const out = resolveIndices({
      dateRange: {
        start: new Date('2026-04-01T00:00:00.000Z'),
        end: new Date('2026-04-01T00:00:00.000Z'),
      },
      mediaTypes: ['print'],
    });
    expect(out).toContain('amx-data-2026-04-01*');
    expect(out).toContain('amx-data-old-others*');
    expect(out).toContain('amx-print*');
  });
});
