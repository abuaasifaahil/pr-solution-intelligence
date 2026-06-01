import { describe, it, expect } from 'vitest';
import {
  CHIPS_FOR_STATE,
  INITIAL_STATE,
  WELCOME_CHIPS_BY_AGENT,
  advance,
  isReady,
  nextUnfilledState,
  type ChatParamsShape,
  type ConversationState,
} from '../../src/agents/orchestrator-state.js';

describe('orchestrator-state', () => {
  it('INITIAL_STATE is "welcome"', () => {
    expect(INITIAL_STATE).toBe<ConversationState>('welcome');
  });

  it('welcome transitions to awaiting_date on any non-empty input', () => {
    const r = advance('welcome', { freeText: 'Analyze brand sentiment' }, 'pr_impact');
    expect(r.newState).toBe('awaiting_date');
    expect(r.chips.map((c) => c.value)).toEqual(['weekly', '10days', '20days', 'custom']);
  });

  it('awaiting_date with valid choice stores dateRange and advances', () => {
    const r = advance('awaiting_date', { choice: 'weekly' }, 'pr_impact');
    expect(r.newState).toBe('awaiting_enrichment');
    expect(r.contextPatch.dateRange).toEqual({ type: 'weekly' });
  });

  it('awaiting_enrichment advances to awaiting_brand', () => {
    const r = advance('awaiting_enrichment', { choice: 'enrichment' }, 'pr_impact');
    expect(r.newState).toBe('awaiting_brand');
    expect(r.contextPatch.enrichment).toBe('enrichment');
  });

  it('awaiting_brand stores brand from free text and advances', () => {
    const r = advance('awaiting_brand', { freeText: 'FreshSip' }, 'pr_impact');
    expect(r.newState).toBe('awaiting_competitors');
    expect(r.contextPatch.brand).toBe('FreshSip');
  });

  it('awaiting_competitors with chip choice advances', () => {
    const r = advance('awaiting_competitors', { choice: 'top5' }, 'pr_impact');
    expect(r.newState).toBe('awaiting_intention');
    expect(r.contextPatch.competitors).toEqual({ preset: 'top5' });
  });

  it('awaiting_intention advances to ready', () => {
    const r = advance('awaiting_intention', { choice: 'intention_based' }, 'pr_impact');
    expect(r.newState).toBe('ready');
    expect(r.contextPatch.intention).toBe('intention_based');
  });

  it('ready stays in ready', () => {
    const r = advance('ready', { freeText: 'anything' }, 'pr_impact');
    expect(r.newState).toBe('ready');
  });

  it('isReady returns true only for "ready"', () => {
    expect(isReady('ready')).toBe(true);
    expect(isReady('awaiting_brand')).toBe(false);
  });

  it('exposes welcome chips per agent type', () => {
    expect(WELCOME_CHIPS_BY_AGENT.pr_impact).toBeDefined();
    expect(WELCOME_CHIPS_BY_AGENT.pr_impact[0]?.label).toBeTypeOf('string');
  });
});

// ─── M9.4 — auto-skip helpers ──────────────────────────────────────────────
describe('orchestrator-state — M9.4 auto-skip', () => {
  const empty: ChatParamsShape = {};

  it('nextUnfilledState(emptyParams) → "awaiting_date" (first wizard state)', () => {
    expect(nextUnfilledState(empty)).toBe<ConversationState>('awaiting_date');
  });

  it('nextUnfilledState({brand:"X"}) → still "awaiting_date" (date is checked first)', () => {
    // Filling brand only does not let us skip past date — the order in
    // `advance()` is date → enrichment → brand → competitors → intention,
    // and we honor that order in nextUnfilledState.
    expect(nextUnfilledState({ brand: 'FreshSip' })).toBe<ConversationState>(
      'awaiting_date',
    );
  });

  it('nextUnfilledState({dateStart,dateEnd}) → "awaiting_enrichment"', () => {
    expect(
      nextUnfilledState({
        dateStart: new Date('2026-04-01'),
        dateEnd: new Date('2026-05-01'),
      }),
    ).toBe<ConversationState>('awaiting_enrichment');
  });

  it('nextUnfilledState({dateStart,dateEnd,enrichmentType}) → "awaiting_brand"', () => {
    expect(
      nextUnfilledState({
        dateStart: new Date('2026-04-01'),
        dateEnd: new Date('2026-05-01'),
        enrichmentType: 'standard',
      }),
    ).toBe<ConversationState>('awaiting_brand');
  });

  it('mid-fill: dates + enrichment + brand set → next is "awaiting_competitors"', () => {
    expect(
      nextUnfilledState({
        dateStart: new Date('2026-04-01'),
        dateEnd: new Date('2026-05-01'),
        enrichmentType: 'standard',
        brand: 'FreshSip',
      }),
    ).toBe<ConversationState>('awaiting_competitors');
  });

  it('competitors as empty array counts as unfilled', () => {
    expect(
      nextUnfilledState({
        dateStart: new Date('2026-04-01'),
        dateEnd: new Date('2026-05-01'),
        enrichmentType: 'standard',
        brand: 'FreshSip',
        competitors: [],
      }),
    ).toBe<ConversationState>('awaiting_competitors');
  });

  it('competitors as non-array (JSON column) counts as unfilled', () => {
    expect(
      nextUnfilledState({
        dateStart: new Date('2026-04-01'),
        dateEnd: new Date('2026-05-01'),
        enrichmentType: 'standard',
        brand: 'FreshSip',
        competitors: { preset: 'top5' } as unknown, // not an array → unfilled
      }),
    ).toBe<ConversationState>('awaiting_competitors');
  });

  it('all slots filled → "ready"', () => {
    expect(
      nextUnfilledState({
        dateStart: new Date('2026-04-01'),
        dateEnd: new Date('2026-05-01'),
        enrichmentType: 'standard',
        brand: 'FreshSip',
        competitors: ['PepsiCo', 'Coca-Cola'],
        intention: 'intention_based',
      }),
    ).toBe<ConversationState>('ready');
  });

  it('half-filled date range (only dateStart) → "awaiting_date"', () => {
    expect(
      nextUnfilledState({
        dateStart: new Date('2026-04-01'),
        enrichmentType: 'standard',
        brand: 'X',
      }),
    ).toBe<ConversationState>('awaiting_date');
  });

  it('CHIPS_FOR_STATE: each state maps to the right chip set', () => {
    expect(CHIPS_FOR_STATE.awaiting_date.map((c) => c.value)).toEqual([
      'weekly',
      '10days',
      '20days',
      'custom',
    ]);
    expect(CHIPS_FOR_STATE.awaiting_enrichment.map((c) => c.value)).toEqual([
      'enrichment',
      'enrichment_plus_reach',
    ]);
    expect(CHIPS_FOR_STATE.awaiting_brand).toEqual([]); // free-text state
    expect(CHIPS_FOR_STATE.awaiting_competitors.map((c) => c.value)).toEqual([
      'top5',
      'top3',
      'top2',
      'other',
    ]);
    expect(CHIPS_FOR_STATE.awaiting_intention.map((c) => c.value)).toEqual([
      'intention_based',
      'comment_based',
    ]);
    expect(CHIPS_FOR_STATE.ready).toEqual([]);
  });
});

// ─── M9.5.5 — reach upgrade probe state ───────────────────────────────────
describe('orchestrator-state — M9.5.5 reach upgrade probe', () => {
  it('CHIPS_FOR_STATE.awaiting_reach_upgrade_consent has the two probe chips', () => {
    const chips = CHIPS_FOR_STATE.awaiting_reach_upgrade_consent;
    expect(chips.map((c) => c.value)).toEqual([
      'upgrade_similarweb',
      'continue_without_reach',
    ]);
    expect(chips[0]!.label).toContain('SimilarWeb');
    expect(chips[1]!.label.toLowerCase()).toContain('continue');
  });

  it('CHIPS_FOR_STATE.enriching is empty (terminal hand-off state)', () => {
    expect(CHIPS_FOR_STATE.enriching).toEqual([]);
  });

  it('advance(probe, choice=upgrade_similarweb) → next="enriching", reply mentions SimilarWeb', () => {
    const r = advance(
      'awaiting_reach_upgrade_consent',
      { choice: 'upgrade_similarweb' },
      'pr_impact',
    );
    expect(r.newState).toBe<ConversationState>('enriching');
    expect(r.contextPatch.state).toBe('enriching');
    expect(r.chips).toEqual([]);
    expect(r.replyTemplate.toLowerCase()).toContain('similarweb');
  });

  it('advance(probe, choice=continue_without_reach) → next="enriching", reply mentions comment-based', () => {
    const r = advance(
      'awaiting_reach_upgrade_consent',
      { choice: 'continue_without_reach' },
      'pr_impact',
    );
    expect(r.newState).toBe<ConversationState>('enriching');
    expect(r.contextPatch.state).toBe('enriching');
    expect(r.chips).toEqual([]);
    expect(r.replyTemplate.toLowerCase()).toContain('comment-based');
  });

  it('advance(probe, choice=gibberish) → stays in probe state, chips re-issued', () => {
    const r = advance(
      'awaiting_reach_upgrade_consent',
      { choice: 'gibberish' },
      'pr_impact',
    );
    expect(r.newState).toBe<ConversationState>('awaiting_reach_upgrade_consent');
    // Stay-in-state: no state patch.
    expect(r.contextPatch.state).toBeUndefined();
    expect(r.chips.map((c) => c.value)).toEqual([
      'upgrade_similarweb',
      'continue_without_reach',
    ]);
  });

  it('advance(probe, freeText="hello") → stays in probe state', () => {
    const r = advance(
      'awaiting_reach_upgrade_consent',
      { freeText: 'hello' },
      'pr_impact',
    );
    expect(r.newState).toBe<ConversationState>('awaiting_reach_upgrade_consent');
  });

  it('advance(enriching, anything) → stays in enriching with no chips', () => {
    const r = advance('enriching', { freeText: 'when will it be done?' }, 'pr_impact');
    expect(r.newState).toBe<ConversationState>('enriching');
    expect(r.chips).toEqual([]);
  });

  it('nextUnfilledState never returns awaiting_reach_upgrade_consent or enriching', () => {
    // Even with every wizard slot filled, the function returns "ready"
    // (its terminal wizard state), not the post-fetch probe state.
    const allFilled = nextUnfilledState({
      dateStart: new Date('2026-04-01'),
      dateEnd: new Date('2026-05-01'),
      enrichmentType: 'standard',
      brand: 'FreshSip',
      competitors: ['PepsiCo', 'Coca-Cola'],
      intention: 'intention_based',
    });
    expect(allFilled).toBe<ConversationState>('ready');
    // And on an empty shape it falls back to 'awaiting_date' — never
    // the probe states.
    expect(nextUnfilledState({})).toBe<ConversationState>('awaiting_date');
  });
});
