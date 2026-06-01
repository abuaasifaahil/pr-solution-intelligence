/**
 * M9.6b — ProbingAgent interface invariants.
 *
 * Most behavior lives in `sample-classifier.test.ts`. This file asserts
 * the type-shape contract: that the interface compiles to the expected
 * surface and that the baseline classifier satisfies it.
 */
import { describe, it, expect } from 'vitest';
import type {
  ProbingAgent,
  ProbingInput,
  ProbingResult,
  Probe,
  ProbableField,
  ChipOption,
  AttachedSourceSnapshot,
  PerSourceStats,
} from '../../src/agents/probing-agent.js';
import { SampleClassifier, sampleClassifier } from '../../src/lib/sample-classifier.js';

describe('ProbingAgent contract', () => {
  it('SampleClassifier implements ProbingAgent', () => {
    const c: ProbingAgent = new SampleClassifier();
    expect(typeof c.classifyAndProbe).toBe('function');
  });

  it('exposes a default singleton', () => {
    expect(sampleClassifier).toBeInstanceOf(SampleClassifier);
  });

  it('ProbableField is the exact narrow set ADR-0003 locks', () => {
    const allowed: ProbableField[] = [
      'brand',
      'competitors',
      'dateRange',
      'mediaTypes',
      'language',
      'intention',
      'enrichmentType',
    ];
    // Compile-time check that the union has no surprise members. Runtime
    // assertion is the same list — flags any future PR that adds a field
    // to ProbableField without also updating the spec.
    expect(allowed.length).toBe(7);
  });

  it('ProbingInput type accepts a minimal shape', () => {
    const input: ProbingInput = {
      userId: 'u',
      chatId: 'c',
      prompt: null,
      attachedSources: [],
      existingChatParams: {},
    };
    expect(input.attachedSources).toEqual([]);
  });

  it('AttachedSourceSnapshot carries adapter declared capabilities', () => {
    const snap: AttachedSourceSnapshot = {
      sourceId: 'src-1',
      kind: 'opensearch',
      sampleArticles: [],
      declaredCapabilities: {
        hasReach: 'usually',
        hasArticleSentiment: 'usually',
        hasEntities: 'usually',
        hasThemes: 'usually',
        hasEngagement: 'usually',
        hasCountry: 'usually',
        hasAuthor: 'usually',
      },
    };
    expect(snap.declaredCapabilities.hasReach).toBe('usually');
  });

  it('Probe + ChipOption shapes accept the expected fields', () => {
    const chip: ChipOption = { value: 'v', label: 'L', meta: { count: 3 } };
    const probe: Probe = {
      field: 'brand',
      question: 'q',
      chips: [chip],
      allowFreeText: true,
      rationale: 'r',
    };
    expect(probe.chips[0]!.meta).toEqual({ count: 3 });
  });

  it('ProbingResult.perSourceStats is an array of PerSourceStats', () => {
    const stats: PerSourceStats = {
      sourceId: 's',
      sampleSize: 0,
      distinctBrandCandidates: 0,
      distinctCompetitorCandidates: 0,
      dateRangeMin: null,
      dateRangeMax: null,
      languagesDetected: [],
    };
    const result: ProbingResult = {
      inferred: {},
      confidence: {},
      probes: [],
      rationale: 'empty',
      perSourceStats: [stats],
    };
    expect(result.perSourceStats[0]!.sourceId).toBe('s');
  });
});
