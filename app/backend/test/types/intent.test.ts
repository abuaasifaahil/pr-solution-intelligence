/**
 * M9.3 — IntentSchema + unfilledFields() invariants.
 *
 * Pure Zod / pure-function suite — no mocking required. Verifies the
 * schema rejects malformed shapes (non-ISO dates, out-of-range confidence,
 * unknown media types, oversized competitors arrays) and that the
 * `unfilledFields` helper treats null and low-confidence values
 * equivalently.
 */
import { describe, it, expect } from 'vitest';
import { IntentSchema, unfilledFields, type Intent } from '../../src/types/intent.js';

const FULL: Intent = {
  brand: 'FreshSip',
  dateStart: '2026-04-01',
  dateEnd: '2026-05-01',
  competitors: ['PepsiCo', 'Coca-Cola'],
  intention: 'intention_based',
  enrichmentType: 'enrichment_plus_reach',
  mediaTypes: ['x_twitter', 'linkedin'],
  dataSource: 'opensearch',
  confidence: {
    brand: 0.95,
    dateRange: 0.95,
    competitors: 0.9,
    intention: 0.9,
    enrichmentType: 0.9,
    mediaTypes: 0.95,
    dataSource: 0.95,
  },
};

const ALL_NULLS: Intent = {
  brand: null,
  dateStart: null,
  dateEnd: null,
  competitors: [],
  intention: null,
  enrichmentType: null,
  mediaTypes: [],
  dataSource: null,
  confidence: {
    brand: 0,
    dateRange: 0,
    competitors: 0,
    intention: 0,
    enrichmentType: 0,
    mediaTypes: 0,
    dataSource: 0,
  },
};

describe('IntentSchema', () => {
  it('accepts a fully populated valid object', () => {
    const parsed = IntentSchema.safeParse(FULL);
    expect(parsed.success).toBe(true);
  });

  it('rejects dateStart that is not an ISO calendar date', () => {
    const parsed = IntentSchema.safeParse({ ...FULL, dateStart: 'April 1' });
    expect(parsed.success).toBe(false);
  });

  it('rejects confidence.brand > 1.0', () => {
    const parsed = IntentSchema.safeParse({
      ...FULL,
      confidence: { ...FULL.confidence, brand: 1.5 },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects mediaTypes containing values outside the MediaType enum', () => {
    const parsed = IntentSchema.safeParse({
      ...FULL,
      mediaTypes: ['ticktock'],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects competitors arrays longer than 10', () => {
    const parsed = IntentSchema.safeParse({
      ...FULL,
      competitors: Array.from({ length: 11 }, (_v, i) => `c${i}`),
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts empty competitors + mediaTypes arrays', () => {
    const parsed = IntentSchema.safeParse({
      ...FULL,
      competitors: [],
      mediaTypes: [],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts all-null payload (no fields detected)', () => {
    const parsed = IntentSchema.safeParse(ALL_NULLS);
    expect(parsed.success).toBe(true);
  });
});

describe('unfilledFields()', () => {
  it('returns [] when every slot is populated above the threshold', () => {
    expect(unfilledFields(FULL, 0.5)).toEqual([]);
  });

  it('returns every non-dataSource slot when the LLM populated nothing', () => {
    expect(unfilledFields(ALL_NULLS, 0.5)).toEqual([
      'brand',
      'dateRange',
      'competitors',
      'intention',
      'enrichmentType',
      'mediaTypes',
    ]);
  });

  it('treats a value with confidence below threshold as unfilled', () => {
    const lowConfidenceBrand: Intent = {
      ...FULL,
      confidence: { ...FULL.confidence, brand: 0.3 },
    };
    expect(unfilledFields(lowConfidenceBrand, 0.5)).toContain('brand');
  });

  it('never lists `dataSource` regardless of value or confidence', () => {
    expect(unfilledFields(ALL_NULLS, 0.5)).not.toContain('dataSource');
    expect(unfilledFields(FULL, 0.5)).not.toContain('dataSource');
    const dataSourceNullLowConf: Intent = {
      ...FULL,
      dataSource: null,
      confidence: { ...FULL.confidence, dataSource: 0.0 },
    };
    expect(unfilledFields(dataSourceNullLowConf, 0.5)).not.toContain('dataSource');
  });

  it('marks dateRange unfilled when only one of start/end is null', () => {
    const halfDate: Intent = { ...FULL, dateEnd: null };
    expect(unfilledFields(halfDate, 0.5)).toContain('dateRange');
  });
});
