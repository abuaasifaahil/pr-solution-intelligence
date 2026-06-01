/**
 * M9.6b — SampleClassifier (heuristic baseline) unit tests.
 *
 * Covers all 6 heuristic branches + idempotency + per-source stats.
 * Pure, deterministic — no LLM, no DB, no network.
 */
import { describe, it, expect } from 'vitest';
import { SampleClassifier } from '../../src/lib/sample-classifier.js';
import type {
  AttachedSourceSnapshot,
  ProbingInput,
} from '../../src/agents/probing-agent.js';
import type {
  DataSourceKind,
  NormalizedArticle,
  DeclaredCapabilities,
} from '../../src/data-sources/adapter.js';

const OS_CAPS: DeclaredCapabilities = {
  hasReach: 'usually',
  hasArticleSentiment: 'usually',
  hasEntities: 'usually',
  hasThemes: 'usually',
  hasEngagement: 'usually',
  hasCountry: 'usually',
  hasAuthor: 'usually',
};

const CSV_CAPS: DeclaredCapabilities = {
  hasReach: 'rarely',
  hasArticleSentiment: 'rarely',
  hasEntities: 'rarely',
  hasThemes: 'never',
  hasEngagement: 'rarely',
  hasCountry: 'rarely',
  hasAuthor: 'usually',
};

interface MakeArticleOpts {
  id?: string;
  title?: string;
  content?: string | null;
  description?: string | null;
  publishedDate?: Date | null;
  language?: string;
  sourceName?: string | null;
  publisherDomain?: string | null;
  kind?: DataSourceKind;
}

function makeArticle(opts: MakeArticleOpts = {}): NormalizedArticle {
  return {
    sourceArticleId: opts.id ?? 'a',
    title: opts.title ?? 'A title',
    content: opts.content ?? null,
    description: opts.description ?? null,
    source: opts.sourceName ?? null,
    author: null,
    publishedDate: opts.publishedDate ?? null,
    url: null,
    publisherDomain: opts.publisherDomain ?? null,
    language: opts.language ?? 'en',
    country: null,
    reach: null,
    sources: opts.sourceName || opts.publisherDomain
      ? { domain: opts.publisherDomain ?? null, name: opts.sourceName ?? null }
      : null,
    rawData: {},
    sourceKind: opts.kind ?? 'csv_upload',
  };
}

function snapshot(
  articles: NormalizedArticle[],
  kind: DataSourceKind = 'csv_upload',
  id = 'src-1',
): AttachedSourceSnapshot {
  return {
    sourceId: id,
    kind,
    sampleArticles: articles,
    declaredCapabilities: kind === 'opensearch' ? OS_CAPS : CSV_CAPS,
  };
}

function input(snapshots: AttachedSourceSnapshot[], existing = {}): ProbingInput {
  return {
    userId: 'u',
    chatId: 'c',
    prompt: null,
    attachedSources: snapshots,
    existingChatParams: existing,
  };
}

describe('SampleClassifier — empty input', () => {
  it('zero attached sources → emptyResult with probes for every unset field', async () => {
    const c = new SampleClassifier();
    const r = await c.classifyAndProbe(input([]));
    expect(r.inferred).toEqual({});
    expect(r.perSourceStats).toEqual([]);
    // brand + competitors + dateRange + intention + enrichmentType.
    const fields = r.probes.map((p) => p.field).sort();
    expect(fields).toEqual(
      ['brand', 'competitors', 'dateRange', 'enrichmentType', 'intention'].sort(),
    );
    // All confidence values are zero (or unset).
    for (const k of Object.keys(r.confidence) as Array<keyof typeof r.confidence>) {
      expect(r.confidence[k]).toBe(0);
    }
  });

  it('attached source with zero sample articles → still empty path; perSourceStats logged', async () => {
    const c = new SampleClassifier();
    const r = await c.classifyAndProbe(
      input([snapshot([], 'opensearch', 'src-X')]),
    );
    expect(r.perSourceStats).toHaveLength(1);
    expect(r.perSourceStats[0]!.sampleSize).toBe(0);
    expect(r.perSourceStats[0]!.sourceId).toBe('src-X');
  });
});

describe('SampleClassifier — brand inference', () => {
  it('strong signal (10 articles, all titled "FreshSip launches X") → brand inferred, no brand probe', async () => {
    const articles = Array.from({ length: 10 }, (_, i) =>
      makeArticle({ id: `a${i}`, title: `FreshSip launches widget ${i}` }),
    );
    const c = new SampleClassifier();
    const r = await c.classifyAndProbe(input([snapshot(articles)]));
    expect(r.inferred.brand).toBe('FreshSip');
    expect(r.confidence.brand).toBeGreaterThanOrEqual(0.9);
    expect(r.probes.find((p) => p.field === 'brand')).toBeUndefined();
  });

  it('weaker signal (3 mentions in 25 articles) → brand probe surfaces with chips', async () => {
    const articles = [
      ...Array.from({ length: 3 }, (_, i) =>
        makeArticle({ id: `f${i}`, title: `FreshSip news ${i}` }),
      ),
      ...Array.from({ length: 22 }, (_, i) =>
        makeArticle({
          id: `o${i}`,
          // Use a variety of recognizable entities so the classifier has
          // multiple candidates to chip up.
          title: `${i % 2 === 0 ? 'PepsiCo' : 'CocaCola'} statement ${i}`,
        }),
      ),
    ];
    const c = new SampleClassifier();
    const r = await c.classifyAndProbe(input([snapshot(articles)]));
    // FreshSip count = 3 out of 25 ⇒ confidence ≈ 0.12, well below 0.7
    const brandProbe = r.probes.find((p) => p.field === 'brand');
    expect(brandProbe).toBeDefined();
    expect(brandProbe!.chips.length).toBeGreaterThan(0);
    expect(brandProbe!.allowFreeText).toBe(true);
  });

  it('existingChatParams.brand="AlreadySet" → NO brand probe regardless of sample', async () => {
    const articles = Array.from({ length: 25 }, (_, i) =>
      makeArticle({ id: `a${i}`, title: `FreshSip ${i}` }),
    );
    const c = new SampleClassifier();
    const r = await c.classifyAndProbe(
      input([snapshot(articles)], { brand: 'AlreadySet' }),
    );
    expect(r.probes.find((p) => p.field === 'brand')).toBeUndefined();
    expect(r.confidence.brand).toBe(1.0);
  });

  it('stopword-heavy titles ("The Best New Story") → no brand candidates emerge', async () => {
    const articles = Array.from({ length: 10 }, (_, i) =>
      makeArticle({ id: `a${i}`, title: 'The Best New Story Today' }),
    );
    const c = new SampleClassifier();
    const r = await c.classifyAndProbe(input([snapshot(articles)]));
    expect(r.inferred.brand).toBeUndefined();
    // Brand probe surfaces with empty chips when no candidates emerge.
    const brandProbe = r.probes.find((p) => p.field === 'brand');
    expect(brandProbe).toBeDefined();
    expect(brandProbe!.chips).toEqual([]);
  });
});

describe('SampleClassifier — competitor candidates', () => {
  it('FreshSip + PepsiCo co-mentions → competitor probe lists PepsiCo (excluding brand)', async () => {
    const articles = [
      ...Array.from({ length: 20 }, (_, i) =>
        makeArticle({
          id: `a${i}`,
          title: `FreshSip launches drink`,
          content: `PepsiCo response to FreshSip campaign in ${i}`,
        }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        makeArticle({
          id: `b${i}`,
          title: `Industry coverage`,
          content: `PepsiCo PepsiCo PepsiCo ${i}`,
        }),
      ),
    ];
    const c = new SampleClassifier();
    const r = await c.classifyAndProbe(input([snapshot(articles)]));
    const compProbe = r.probes.find((p) => p.field === 'competitors');
    expect(compProbe).toBeDefined();
    const values = compProbe!.chips.map((ch) => ch.value);
    expect(values).toContain('PepsiCo');
    expect(values).not.toContain('FreshSip'); // excluded when it's the inferred brand
  });

  it('existing competitors set → no competitor probe', async () => {
    const articles = Array.from({ length: 10 }, (_, i) =>
      makeArticle({ id: `a${i}`, title: `FreshSip PepsiCo CocaCola ${i}` }),
    );
    const c = new SampleClassifier();
    const r = await c.classifyAndProbe(
      input([snapshot(articles)], { competitors: ['Existing'] as never }),
    );
    expect(r.probes.find((p) => p.field === 'competitors')).toBeUndefined();
  });
});

describe('SampleClassifier — date range', () => {
  it('span > 60 days → date probe with narrow-the-range rationale', async () => {
    const articles = [
      makeArticle({
        id: 'old',
        title: 'FreshSip news 1',
        publishedDate: new Date('2024-11-01'),
      }),
      makeArticle({
        id: 'new',
        title: 'FreshSip news 2',
        publishedDate: new Date('2026-05-01'),
      }),
    ];
    const c = new SampleClassifier();
    const r = await c.classifyAndProbe(input([snapshot(articles)]));
    const dateProbe = r.probes.find((p) => p.field === 'dateRange');
    expect(dateProbe).toBeDefined();
    expect(dateProbe!.rationale).toMatch(/days/);
    expect(dateProbe!.chips.length).toBeGreaterThan(0);
    expect(r.inferred.dateStart).toBeUndefined();
  });

  it('span ≤ 60 days → date range inferred with confidence ≥ 0.5', async () => {
    const articles = Array.from({ length: 25 }, (_, i) =>
      makeArticle({
        id: `a${i}`,
        title: `FreshSip ${i}`,
        publishedDate: new Date(`2026-05-${(i % 28) + 1}`),
      }),
    );
    const c = new SampleClassifier();
    const r = await c.classifyAndProbe(input([snapshot(articles)]));
    expect(r.confidence.dateRange).toBeGreaterThanOrEqual(0.5);
    expect(r.inferred.dateStart).toBeInstanceOf(Date);
    expect(r.inferred.dateEnd).toBeInstanceOf(Date);
    expect(r.probes.find((p) => p.field === 'dateRange')).toBeUndefined();
  });

  it('existingChatParams date set → no date probe', async () => {
    const articles = [
      makeArticle({
        id: 'a',
        title: 'X',
        publishedDate: new Date('2024-11-01'),
      }),
      makeArticle({
        id: 'b',
        title: 'X',
        publishedDate: new Date('2026-05-01'),
      }),
    ];
    const c = new SampleClassifier();
    const r = await c.classifyAndProbe(
      input([snapshot(articles)], {
        dateStart: new Date('2026-04-01'),
        dateEnd: new Date('2026-04-30'),
      }),
    );
    expect(r.probes.find((p) => p.field === 'dateRange')).toBeUndefined();
    expect(r.confidence.dateRange).toBe(1.0);
  });
});

describe('SampleClassifier — language', () => {
  it('3 languages (en, fr, es), no majority → language probe surfaces', async () => {
    const langs = ['en', 'fr', 'es'];
    const articles = Array.from({ length: 9 }, (_, i) =>
      makeArticle({ id: `a${i}`, title: `Topic ${i}`, language: langs[i % 3] }),
    );
    const c = new SampleClassifier();
    const r = await c.classifyAndProbe(input([snapshot(articles)]));
    const langProbe = r.probes.find((p) => p.field === 'language');
    expect(langProbe).toBeDefined();
    expect(langProbe!.chips.length).toBe(3);
  });

  it('80% en majority → language inferred, no probe', async () => {
    const articles = [
      ...Array.from({ length: 8 }, (_, i) =>
        makeArticle({ id: `e${i}`, language: 'en' }),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makeArticle({ id: `f${i}`, language: 'fr' }),
      ),
    ];
    const c = new SampleClassifier();
    const r = await c.classifyAndProbe(input([snapshot(articles)]));
    expect(r.probes.find((p) => p.field === 'language')).toBeUndefined();
    expect(r.confidence.language).toBeGreaterThanOrEqual(0.7);
  });
});

describe('SampleClassifier — media types', () => {
  it('OpenSearch source with X (Twitter) source names → mediaTypes probe suggests x_twitter', async () => {
    const articles = Array.from({ length: 20 }, (_, i) =>
      makeArticle({
        id: `tw${i}`,
        title: `Tweet ${i}`,
        sourceName: 'X (Twitter)',
        kind: 'opensearch',
      }),
    );
    const c = new SampleClassifier();
    const r = await c.classifyAndProbe(
      input([snapshot(articles, 'opensearch')]),
    );
    const mtProbe = r.probes.find((p) => p.field === 'mediaTypes');
    expect(mtProbe).toBeDefined();
    expect(mtProbe!.chips.map((ch) => ch.value)).toContain('x_twitter');
  });

  it('CSV source → mediaTypes is NOT inferred (no platform hints in CSV)', async () => {
    const articles = Array.from({ length: 5 }, (_, i) =>
      makeArticle({ id: `c${i}`, sourceName: 'My Custom CSV', kind: 'csv_upload' }),
    );
    const c = new SampleClassifier();
    const r = await c.classifyAndProbe(input([snapshot(articles, 'csv_upload')]));
    expect(r.probes.find((p) => p.field === 'mediaTypes')).toBeUndefined();
    expect(r.confidence.mediaTypes ?? 0).toBe(0);
  });
});

describe('SampleClassifier — intention + enrichmentType', () => {
  it('intention and enrichmentType always probe when unset (never inferred)', async () => {
    const articles = Array.from({ length: 25 }, (_, i) =>
      makeArticle({ id: `a${i}`, title: `FreshSip ${i}` }),
    );
    const c = new SampleClassifier();
    const r = await c.classifyAndProbe(input([snapshot(articles)]));
    expect(r.probes.find((p) => p.field === 'intention')).toBeDefined();
    expect(r.probes.find((p) => p.field === 'enrichmentType')).toBeDefined();
    expect(r.confidence.intention).toBe(0);
    expect(r.confidence.enrichmentType).toBe(0);
  });

  it('preset intention → no intention probe', async () => {
    const articles = Array.from({ length: 25 }, (_, i) =>
      makeArticle({ id: `a${i}`, title: `FreshSip ${i}` }),
    );
    const c = new SampleClassifier();
    const r = await c.classifyAndProbe(
      input([snapshot(articles)], { intention: 'intention_based' as never }),
    );
    expect(r.probes.find((p) => p.field === 'intention')).toBeUndefined();
    expect(r.confidence.intention).toBe(1.0);
  });
});

describe('SampleClassifier — idempotency + perSourceStats', () => {
  it('same input twice → byte-identical output (idempotency)', async () => {
    const articles = Array.from({ length: 25 }, (_, i) =>
      makeArticle({
        id: `a${i}`,
        title: `FreshSip launches ${i}`,
        content: `PepsiCo response coverage ${i}`,
        publishedDate: new Date(`2026-05-${(i % 28) + 1}`),
      }),
    );
    const c = new SampleClassifier();
    const r1 = await c.classifyAndProbe(input([snapshot(articles)]));
    const r2 = await c.classifyAndProbe(input([snapshot(articles)]));
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('perSourceStats populated correctly across 2 attached sources', async () => {
    const osArticles = Array.from({ length: 10 }, (_, i) =>
      makeArticle({
        id: `os${i}`,
        title: `FreshSip news ${i}`,
        publishedDate: new Date(`2026-05-${(i % 28) + 1}`),
        language: 'en',
        kind: 'opensearch',
      }),
    );
    const csvArticles = Array.from({ length: 15 }, (_, i) =>
      makeArticle({
        id: `c${i}`,
        title: `FreshSip article ${i}`,
        publishedDate: new Date(`2026-04-${(i % 28) + 1}`),
        language: 'fr',
        kind: 'csv_upload',
      }),
    );
    const c = new SampleClassifier();
    const r = await c.classifyAndProbe(
      input([
        snapshot(osArticles, 'opensearch', 'src-os'),
        snapshot(csvArticles, 'csv_upload', 'src-csv'),
      ]),
    );
    expect(r.perSourceStats).toHaveLength(2);
    expect(r.perSourceStats[0]!.sourceId).toBe('src-os');
    expect(r.perSourceStats[0]!.sampleSize).toBe(10);
    expect(r.perSourceStats[0]!.languagesDetected).toContain('en');
    expect(r.perSourceStats[1]!.sourceId).toBe('src-csv');
    expect(r.perSourceStats[1]!.sampleSize).toBe(15);
    expect(r.perSourceStats[1]!.languagesDetected).toContain('fr');
  });
});

describe('SampleClassifier — probe ordering', () => {
  it('probes ordered lowest-confidence first', async () => {
    // 25 articles with strong brand signal so brand probe stays absent,
    // but intention + enrichmentType + competitors get probed at lower
    // confidence than the language path which majorities to en (no probe).
    const articles = Array.from({ length: 25 }, (_, i) =>
      makeArticle({
        id: `a${i}`,
        title: `FreshSip ${i}`,
        content: `PepsiCo CocaCola ${i}`,
        publishedDate: new Date(`2026-05-${(i % 28) + 1}`),
        language: 'en',
      }),
    );
    const c = new SampleClassifier();
    const r = await c.classifyAndProbe(input([snapshot(articles)]));
    // Build a sorted list of (field, confidence) — assert monotonically
    // non-decreasing.
    const confSeq = r.probes.map((p) => r.confidence[p.field] ?? 0);
    for (let i = 1; i < confSeq.length; i += 1) {
      expect(confSeq[i]!).toBeGreaterThanOrEqual(confSeq[i - 1]!);
    }
  });
});
