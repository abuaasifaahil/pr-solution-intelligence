import { describe, it, expect } from 'vitest';
import {
  INITIAL_STATE,
  WELCOME_CHIPS_BY_AGENT,
  advance,
  isReady,
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
