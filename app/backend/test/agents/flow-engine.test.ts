/**
 * M7.5 — Pure-function unit tests for the ConversationalFlowEngine.
 *
 * No DB, no LLM, no Fastify: just the state-machine math.
 */
import { describe, it, expect } from 'vitest';
import {
  getNextFlowState,
  getPromptForState,
  type ChatParamsSnapshot,
  type FlowState,
} from '../../src/agents/flow-engine.js';

function snap(over: Partial<ChatParamsSnapshot> = {}): ChatParamsSnapshot {
  return {
    brand: null,
    dateStart: null,
    dateEnd: null,
    enrichmentType: null,
    competitors: [],
    intention: null,
    hasUpload: false,
    hasConfirmedQuery: false,
    isProcessingComplete: false,
    ...over,
  };
}

describe('flow-engine — getNextFlowState', () => {
  it('empty snapshot → collect_dates', () => {
    expect(getNextFlowState(snap())).toBe<FlowState>('collect_dates');
  });

  it('hasUpload=true (no manual dates) → skips to collect_enrichment', () => {
    // Skip rule per spec §5.2: file upload auto-populates dates.
    expect(getNextFlowState(snap({ hasUpload: true }))).toBe<FlowState>('collect_enrichment');
  });

  it('dateStart set → collect_enrichment', () => {
    expect(
      getNextFlowState(snap({ dateStart: new Date('2025-01-01') })),
    ).toBe<FlowState>('collect_enrichment');
  });

  it('enrichment chosen → collect_brand', () => {
    expect(
      getNextFlowState(snap({ hasUpload: true, enrichmentType: 'standard' })),
    ).toBe<FlowState>('collect_brand');
  });

  it('brand pre-populated in INIT (and other fields filled later) → skip COLLECT_BRAND', () => {
    // Skip rule per spec §5.2.
    const s = snap({
      hasUpload: true,
      enrichmentType: 'standard',
      brand: 'Acme',
    });
    expect(getNextFlowState(s)).toBe<FlowState>('collect_competitors');
  });

  it('competitors filled → collect_intention', () => {
    expect(
      getNextFlowState(
        snap({
          hasUpload: true,
          enrichmentType: 'standard',
          brand: 'Acme',
          competitors: ['Beta', 'Gamma'],
        }),
      ),
    ).toBe<FlowState>('collect_intention');
  });

  it('intention filled → generate_query', () => {
    expect(
      getNextFlowState(
        snap({
          hasUpload: true,
          enrichmentType: 'standard',
          brand: 'Acme',
          competitors: ['Beta'],
          intention: 'intention_based',
        }),
      ),
    ).toBe<FlowState>('generate_query');
  });

  it('query confirmed → processing', () => {
    expect(
      getNextFlowState(
        snap({
          hasUpload: true,
          enrichmentType: 'standard',
          brand: 'Acme',
          competitors: ['Beta'],
          intention: 'intention_based',
          hasConfirmedQuery: true,
        }),
      ),
    ).toBe<FlowState>('processing');
  });

  it('processing complete → complete', () => {
    expect(
      getNextFlowState(
        snap({
          hasUpload: true,
          enrichmentType: 'standard',
          brand: 'Acme',
          competitors: ['Beta'],
          intention: 'intention_based',
          hasConfirmedQuery: true,
          isProcessingComplete: true,
        }),
      ),
    ).toBe<FlowState>('complete');
  });

  it('competitors=non-array treated as empty → collect_competitors', () => {
    const s = snap({
      hasUpload: true,
      enrichmentType: 'standard',
      brand: 'Acme',
      competitors: null,
    });
    expect(getNextFlowState(s)).toBe<FlowState>('collect_competitors');
  });

  it('full happy path: each filled field advances one state', () => {
    // Start with date set, then walk through every field. Each step adds one
    // field and asserts the engine advances exactly one slot.
    let s = snap();
    expect(getNextFlowState(s)).toBe<FlowState>('collect_dates');

    s = snap({ dateStart: new Date(), dateEnd: new Date() });
    expect(getNextFlowState(s)).toBe<FlowState>('collect_enrichment');

    s = { ...s, enrichmentType: 'standard' };
    expect(getNextFlowState(s)).toBe<FlowState>('collect_brand');

    s = { ...s, brand: 'Acme' };
    expect(getNextFlowState(s)).toBe<FlowState>('collect_competitors');

    s = { ...s, competitors: ['B', 'C'] };
    expect(getNextFlowState(s)).toBe<FlowState>('collect_intention');

    s = { ...s, intention: 'comment_based' };
    expect(getNextFlowState(s)).toBe<FlowState>('generate_query');

    s = { ...s, hasConfirmedQuery: true };
    expect(getNextFlowState(s)).toBe<FlowState>('processing');

    s = { ...s, isProcessingComplete: true };
    expect(getNextFlowState(s)).toBe<FlowState>('complete');
  });
});

describe('flow-engine — getPromptForState', () => {
  const ALL_STATES: FlowState[] = [
    'init',
    'collect_dates',
    'collect_enrichment',
    'collect_brand',
    'collect_competitors',
    'collect_intention',
    'generate_query',
    'processing',
    'complete',
  ];

  it('all 9 states have prompt entries', () => {
    for (const s of ALL_STATES) {
      const out = getPromptForState(s, snap());
      expect(out.template).toBeTypeOf('string');
      expect(out.template.length).toBeGreaterThan(0);
      expect(Array.isArray(out.chips)).toBe(true);
    }
  });

  it('collect_dates chip values match Prisma DateRangeType enum (snake_case)', () => {
    const out = getPromptForState('collect_dates', snap());
    expect(out.chips.map((c) => c.value)).toEqual(['weekly', 'ten_days', 'twenty_days', 'custom']);
  });

  it('collect_enrichment chip values match Prisma EnrichmentType enum', () => {
    const out = getPromptForState('collect_enrichment', snap());
    expect(out.chips.map((c) => c.value)).toEqual(['standard', 'reach']);
  });

  it('collect_competitors chip values match Prisma CompetitorSet enum', () => {
    const out = getPromptForState('collect_competitors', snap());
    expect(out.chips.map((c) => c.value)).toEqual(['top5', 'top3', 'top2', 'custom']);
  });

  it('collect_intention chip values match Prisma Intention enum', () => {
    const out = getPromptForState('collect_intention', snap());
    expect(out.chips.map((c) => c.value)).toEqual(['intention_based', 'comment_based']);
  });

  it('free-text states have no chips (collect_brand, generate_query, processing, complete, init)', () => {
    for (const s of ['init', 'collect_brand', 'generate_query', 'processing', 'complete'] as FlowState[]) {
      expect(getPromptForState(s, snap()).chips).toEqual([]);
    }
  });
});
