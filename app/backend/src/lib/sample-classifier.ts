/**
 * Baseline sample-based classifier — implements the M9.6b `ProbingAgent`
 * contract using heuristics only. No LLM call, no live OpenSearch hit,
 * no storage write. Fast, deterministic, zero-cost.
 *
 * Phase 5 may later add an LLM-augmented variant (e.g. "ask GPT to
 * disambiguate when two entities tie for top mention count"); M9.6b ships
 * only the heuristic version.
 *
 * Six branches mirror ADR-0003 Decision 2:
 *
 *  1. Brand-candidate detection — count capitalized entity-like mentions
 *     across title + content[:500] + description. Rank by frequency, drop
 *     a hand-tuned stopword list. Top result becomes the inferred brand;
 *     confidence = (top_count / sample_size) capped at 0.95. When
 *     confidence < 0.7 we surface a probe with the top-5 candidates.
 *
 *  2. Competitor candidates — entities[1..6], excluding the inferred
 *     brand. Surfaced as a probe (confidence stays low — these are
 *     suggestions, not assertions).
 *
 *  3. Date-range inference — min/max `publishedDate` across the merged
 *     sample. Span ≤ 60 days ⇒ we infer the range with high confidence.
 *     Span > 60 days ⇒ low-confidence probe asking the user to narrow.
 *
 *  4. Language detection — majority vote across `article.language`. ≥70%
 *     majority ⇒ inferred. <70% ⇒ probe.
 *
 *  5. Media types — per-source-kind. CSV declines (data has no platform
 *     hint). OpenSearch reads `article.sources.name` and matches against
 *     the M7.6 platform-name patterns (e.g. "X (Twitter)" → `x_twitter`).
 *
 *  6. Intention + enrichmentType — NOT inferable from sample articles.
 *     The prober declines (confidence 0.0); these remain "must-ask"
 *     probes if not already filled in `existingChatParams`.
 *
 * Idempotency: every output is a pure function of the input. Re-running
 * with the same `ProbingInput` MUST yield byte-identical output. Phase 5
 * memory replay relies on this.
 *
 * @file backend/src/lib/sample-classifier.ts
 */
import type {
  ProbingAgent,
  ProbingInput,
  ProbingResult,
  ProbableField,
  Probe,
  PerSourceStats,
  AttachedSourceSnapshot,
} from '../agents/probing-agent.js';
import type { NormalizedArticle } from '../data-sources/adapter.js';
import type { ChatParams } from '@prsi/shared/db';
import type { MediaType } from './media-types.js';

/**
 * Hand-tuned stopword list. Capitalized words that look entity-like to
 * the tokenizer but never identify a brand. Kept short (~70 entries) so
 * extension is cheap. Add domain false-positives ("Press", "Release",
 * "News") that pollute press-clipping CSVs.
 */
const STOPWORDS = new Set([
  // Articles + determiners
  'The', 'A', 'An', 'And', 'But', 'Or', 'So', 'Yet', 'For', 'Nor',
  // Prepositions
  'In', 'On', 'At', 'By', 'To', 'Of', 'With', 'From', 'As', 'Up',
  // Adjectives that look proper-noun when title-cased
  'New', 'Old', 'This', 'That', 'These', 'Those',
  // Question words
  'What', 'Why', 'How', 'When', 'Where', 'Who', 'Which',
  // Pronouns
  'You', 'Your', 'Their', 'It', 'Its', 'They', 'We', 'Our', 'My',
  'His', 'Her', 'He', 'She',
  // Auxiliary verbs
  'Is', 'Are', 'Was', 'Were', 'Be', 'Been', 'Being',
  'Have', 'Has', 'Had', 'Do', 'Does', 'Did',
  'Will', 'Would', 'Could', 'Should', 'May', 'Might', 'Must',
  'Can', 'Shall',
  // PR-monitoring false-positives
  'Press', 'Release', 'News', 'Article', 'Report', 'Story',
  'Best', 'Top', 'Latest', 'Today', 'Yesterday',
]);

const MIN_BRAND_MENTIONS = 3;
const TOP_N_BRAND_CHIPS = 5;
const MAX_COMPETITOR_CHIPS = 6;
const SHORT_DATE_RANGE_DAYS = 60;
const MIN_LANGUAGE_MAJORITY = 0.7;
const BRAND_CONFIDENCE_PROBE_THRESHOLD = 0.7;
const INFERENCE_CONFIDENCE_FLOOR = 0.5;
const COMPETITOR_SUGGESTION_CONFIDENCE = 0.4;

/**
 * Tokenize for capitalized words / multi-word title-case sequences. Kept
 * deliberately simple — this is heuristics, not NER. We capture single
 * Title-Case words, hyphenated forms ("Coca-Cola"), and adjacent
 * Title-Case runs ("New York Times"). Stopwords get filtered AFTER token
 * extraction so a multi-word sequence isn't pruned just because its first
 * word is "The".
 */
function tokenize(text: string | null): string[] {
  if (!text) return [];
  // Pattern: a Title-Case head word (>=3 chars to drop "A", "An")
  // followed optionally by additional whitespace/hyphen-joined Title-Case
  // words. CamelCase + digits accepted to handle brands like "GitHub3D".
  const pattern = /\b[A-Z][A-Za-z0-9]+(?:[\s-]+[A-Z][A-Za-z0-9]+)*\b/g;
  const out: string[] = [];
  for (const m of text.matchAll(pattern)) {
    const w = m[0];
    if (w.length < 3) continue;
    if (STOPWORDS.has(w)) continue;
    // Multi-word runs ("The Best New Story Today") would otherwise slip
    // through as one big "entity" — split on whitespace/hyphen and drop
    // the run when every component is a stopword.
    if (/[\s-]/.test(w)) {
      const parts = w.split(/[\s-]+/);
      const allStop = parts.every((p) => STOPWORDS.has(p));
      if (allStop) continue;
    }
    out.push(w);
  }
  return out;
}

interface EntityCount {
  term: string;
  count: number;
}

/**
 * Count entity-like mentions across a merged article pool. Each occurrence
 * of a term within an article counts once per occurrence — repeated
 * mentions in one article inflate that term's count.
 *
 * Deterministic ordering: ties broken alphabetically so identical inputs
 * always produce identical outputs (Phase 5 memory-replay invariant).
 */
function countEntities(articles: NormalizedArticle[]): EntityCount[] {
  const counts = new Map<string, number>();
  for (const a of articles) {
    const tokens = [
      ...tokenize(a.title),
      ...tokenize(a.description),
      ...tokenize(a.content?.slice(0, 500) ?? null),
    ];
    for (const t of tokens) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  const entries: EntityCount[] = [];
  for (const [term, count] of counts) {
    if (count >= MIN_BRAND_MENTIONS) entries.push({ term, count });
  }
  entries.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.term.localeCompare(b.term);
  });
  return entries;
}

/** Min/max ISO YYYY-MM-DD across a sample, ignoring null dates. */
function dateBounds(
  articles: NormalizedArticle[],
): { min: string | null; max: string | null; spanDays: number | null } {
  let min: Date | null = null;
  let max: Date | null = null;
  for (const a of articles) {
    if (!a.publishedDate) continue;
    if (!min || a.publishedDate < min) min = a.publishedDate;
    if (!max || a.publishedDate > max) max = a.publishedDate;
  }
  if (!min || !max) return { min: null, max: null, spanDays: null };
  const spanDays = Math.floor((max.getTime() - min.getTime()) / 86_400_000);
  return {
    min: min.toISOString().slice(0, 10),
    max: max.toISOString().slice(0, 10),
    spanDays,
  };
}

/** Majority-vote language detection. */
function languageDistribution(articles: NormalizedArticle[]): {
  top: { lang: string; share: number; count: number } | null;
  distinct: string[];
} {
  if (articles.length === 0) return { top: null, distinct: [] };
  const counts = new Map<string, number>();
  for (const a of articles) {
    const lang = a.language || 'en';
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  const distinct = sorted.map(([l]) => l);
  const [topLang, topCount] = sorted[0]!;
  return {
    top: { lang: topLang, share: topCount / articles.length, count: topCount },
    distinct,
  };
}

/**
 * Map an OpenSearch-style `sources.name` string onto a MediaType. Built
 * from the legacy Python aliases (`x (twitter)` → `x_twitter`) plus
 * obvious patterns. Case-insensitive. Returns null if the platform name
 * doesn't match any known mapping.
 */
function inferMediaTypeFromSourceName(name: string | null): MediaType | null {
  if (!name) return null;
  const n = name.toLowerCase();
  if (/twitter|^x$|^x[\s(]/.test(n)) return 'x_twitter';
  if (n.includes('linkedin')) return 'linkedin';
  if (n.includes('facebook')) return 'facebook';
  if (n.includes('tiktok')) return 'tiktok';
  if (n.includes('youtube')) return 'youtube';
  if (n.includes('reddit')) return 'reddit';
  if (/(^|\s)blog/.test(n)) return 'blogs';
  if (n.includes('forum')) return 'forums';
  if (n.includes('review')) return 'reviews';
  if (n.includes('print')) return 'print';
  return null;
}

function perSourceStat(
  snapshot: AttachedSourceSnapshot,
  entities: EntityCount[],
): PerSourceStats {
  const bounds = dateBounds(snapshot.sampleArticles);
  const dist = languageDistribution(snapshot.sampleArticles);
  return {
    sourceId: snapshot.sourceId,
    sampleSize: snapshot.sampleArticles.length,
    distinctBrandCandidates: entities.length,
    distinctCompetitorCandidates: Math.max(0, entities.length - 1),
    dateRangeMin: bounds.min,
    dateRangeMax: bounds.max,
    languagesDetected: dist.distinct,
  };
}

/** Format a free-text rationale shown in the ProbingResultCard. */
function buildRationale(
  sampleSize: number,
  entities: EntityCount[],
  inferredBrand: string | undefined,
): string {
  if (sampleSize === 0) {
    return 'No sample articles were available — every field needs your input.';
  }
  const parts = [`Read ${sampleSize} sample article${sampleSize === 1 ? '' : 's'}.`];
  if (inferredBrand) {
    const top = entities.find((e) => e.term === inferredBrand);
    parts.push(
      `Top entity: "${inferredBrand}"${top ? ` (${top.count} mentions)` : ''}.`,
    );
  } else if (entities.length === 0) {
    parts.push('No brand-like entities detected in titles / content.');
  } else {
    parts.push(`Found ${entities.length} candidate entities; ranking is too close to auto-pick.`);
  }
  return parts.join(' ');
}

export class SampleClassifier implements ProbingAgent {
  async classifyAndProbe(input: ProbingInput): Promise<ProbingResult> {
    const allArticles = input.attachedSources.flatMap((s) => s.sampleArticles);
    const inferred: Partial<ChatParams> = {};
    const confidence: Partial<Record<ProbableField, number>> = {};
    const probes: Probe[] = [];

    // ── Empty-input fast path ───────────────────────────────────────────
    if (allArticles.length === 0) {
      return this.emptyResult(input);
    }

    const entities = countEntities(allArticles);

    // ── 1. Brand inference ──────────────────────────────────────────────
    const topEntity = entities[0];
    const brandAlreadySet =
      input.existingChatParams.brand !== undefined &&
      input.existingChatParams.brand !== null;

    if (brandAlreadySet) {
      // User already filled brand — skip probe entirely, even if sample
      // has a stronger candidate. Respect prior input.
      confidence.brand = 1.0;
    } else if (topEntity) {
      const brandConfidence = Math.min(
        0.95,
        topEntity.count / Math.max(allArticles.length, 1),
      );
      confidence.brand = brandConfidence;
      if (brandConfidence >= INFERENCE_CONFIDENCE_FLOOR) {
        inferred.brand = topEntity.term;
      }
      if (brandConfidence < BRAND_CONFIDENCE_PROBE_THRESHOLD) {
        probes.push({
          field: 'brand',
          question: 'Which brand should we focus on?',
          chips: entities.slice(0, TOP_N_BRAND_CHIPS).map((e) => ({
            value: e.term,
            label: `${e.term} (${e.count} mention${e.count === 1 ? '' : 's'})`,
            meta: { count: e.count },
          })),
          allowFreeText: true,
          rationale: `Top candidate "${topEntity.term}" appears in ${topEntity.count}/${allArticles.length} samples.`,
        });
      }
    } else {
      // No brand candidates emerged at all (e.g. stopword-heavy titles)
      confidence.brand = 0;
      probes.push({
        field: 'brand',
        question: 'Which brand should we focus on?',
        chips: [],
        allowFreeText: true,
        rationale: 'No brand-like entities detected in the sample.',
      });
    }

    // ── 2. Competitor candidates ────────────────────────────────────────
    const existingCompetitors = Array.isArray(input.existingChatParams.competitors)
      ? (input.existingChatParams.competitors as unknown[])
      : [];
    if (existingCompetitors.length === 0) {
      const inferredBrandTerm = inferred.brand;
      const competitorCandidates = entities
        .slice(1, 1 + MAX_COMPETITOR_CHIPS)
        .filter((e) => e.term !== inferredBrandTerm);
      if (competitorCandidates.length > 0) {
        probes.push({
          field: 'competitors',
          question: 'Compare against any of these?',
          chips: competitorCandidates.map((e) => ({
            value: e.term,
            label: `${e.term} (${e.count})`,
            meta: { count: e.count },
          })),
          allowFreeText: true,
          rationale: `Other entities frequently co-occur with ${
            inferredBrandTerm ?? 'the topic'
          }.`,
        });
        confidence.competitors = COMPETITOR_SUGGESTION_CONFIDENCE;
      } else {
        confidence.competitors = 0;
      }
    } else {
      confidence.competitors = 1.0;
    }

    // ── 3. Date range inference ─────────────────────────────────────────
    const bounds = dateBounds(allArticles);
    const dateAlreadySet =
      input.existingChatParams.dateStart != null &&
      input.existingChatParams.dateEnd != null;
    if (dateAlreadySet) {
      confidence.dateRange = 1.0;
    } else if (bounds.min && bounds.max && bounds.spanDays !== null) {
      if (bounds.spanDays <= SHORT_DATE_RANGE_DAYS) {
        // Narrow span — infer directly. Confidence scales with sample
        // size relative to a saturation point of ~25 rows.
        const sampleCoverage = Math.min(1, allArticles.length / 25);
        const dateConfidence = Math.min(0.9, 0.5 + 0.4 * sampleCoverage);
        confidence.dateRange = dateConfidence;
        if (dateConfidence >= INFERENCE_CONFIDENCE_FLOOR) {
          inferred.dateStart = new Date(bounds.min);
          inferred.dateEnd = new Date(bounds.max);
        }
      } else {
        // Wide span — probe the user to narrow.
        confidence.dateRange = 0.3;
        probes.push({
          field: 'dateRange',
          question: 'Narrow the date range?',
          chips: [
            { value: 'last_7_days', label: 'Last 7 days' },
            { value: 'last_30_days', label: 'Last 30 days' },
            { value: 'last_90_days', label: 'Last 90 days' },
            { value: 'full_range', label: `Full range (${bounds.min} → ${bounds.max})` },
          ],
          allowFreeText: false,
          rationale: `The sample spans ${bounds.spanDays} days (${bounds.min} → ${bounds.max}). Narrow the range?`,
        });
      }
    } else {
      confidence.dateRange = 0;
    }

    // ── 4. Language inference ───────────────────────────────────────────
    const langDist = languageDistribution(allArticles);
    if (langDist.top) {
      if (langDist.top.share >= MIN_LANGUAGE_MAJORITY) {
        confidence.language = Math.min(0.95, langDist.top.share);
        // Language is not a chat_params column today — we record
        // confidence + rationale only. Future M9.x may add it.
      } else {
        confidence.language = 0.3;
        probes.push({
          field: 'language',
          question: 'Which language(s) should we cover?',
          chips: langDist.distinct.map((l) => ({
            value: l,
            label: l.toUpperCase(),
          })),
          allowFreeText: false,
          rationale: `Sample contains ${langDist.distinct.length} languages with no clear majority (top: ${langDist.top.lang} at ${Math.round(
            langDist.top.share * 100,
          )}%).`,
        });
      }
    }

    // ── 5. Media-type inference (OS-source patterns) ────────────────────
    const existingMediaTypes = Array.isArray(input.existingChatParams.mediaTypes)
      ? (input.existingChatParams.mediaTypes as unknown[])
      : [];
    if (existingMediaTypes.length === 0) {
      const mediaCounts = new Map<MediaType, number>();
      let inferredAnyMedia = false;
      for (const snapshot of input.attachedSources) {
        if (snapshot.kind !== 'opensearch') continue;
        for (const a of snapshot.sampleArticles) {
          const mt = inferMediaTypeFromSourceName(a.sources?.name ?? a.source);
          if (mt) {
            mediaCounts.set(mt, (mediaCounts.get(mt) ?? 0) + 1);
            inferredAnyMedia = true;
          }
        }
      }
      if (inferredAnyMedia) {
        const ranked: Array<[MediaType, number]> = [...mediaCounts.entries()].sort(
          (a, b) => {
            if (b[1] !== a[1]) return b[1] - a[1];
            return a[0].localeCompare(b[0]);
          },
        );
        confidence.mediaTypes = 0.6;
        probes.push({
          field: 'mediaTypes',
          question: 'Which media types should we include?',
          chips: ranked.map(([mt, count]) => ({
            value: mt,
            label: `${mt} (${count})`,
            meta: { count },
          })),
          allowFreeText: false,
          rationale: `Detected ${ranked.length} media type${
            ranked.length === 1 ? '' : 's'
          } in the OpenSearch sample.`,
        });
      } else {
        confidence.mediaTypes = 0;
      }
    } else {
      confidence.mediaTypes = 1.0;
    }

    // ── 6. Intention + enrichmentType — always probe if unset ───────────
    if (input.existingChatParams.intention == null) {
      confidence.intention = 0;
      probes.push({
        field: 'intention',
        question: 'Sentiment lens — intention or comment based?',
        chips: [
          { value: 'intention_based', label: 'Intention-based' },
          { value: 'comment_based', label: 'Comment-based' },
        ],
        allowFreeText: false,
        rationale: 'Not inferable from sample articles — needs your input.',
      });
    } else {
      confidence.intention = 1.0;
    }

    if (input.existingChatParams.enrichmentType == null) {
      confidence.enrichmentType = 0;
      probes.push({
        field: 'enrichmentType',
        question: 'Add SimilarWeb reach data?',
        chips: [
          { value: 'standard', label: 'Standard enrichment' },
          { value: 'reach', label: 'Enrichment + reach (SimilarWeb)' },
        ],
        allowFreeText: false,
        rationale: 'Not inferable from sample articles — needs your input.',
      });
    } else {
      confidence.enrichmentType = 1.0;
    }

    // ── Order probes lowest-confidence first ────────────────────────────
    probes.sort((a, b) => {
      const ca = confidence[a.field] ?? 0;
      const cb = confidence[b.field] ?? 0;
      return ca - cb;
    });

    const perSourceStats: PerSourceStats[] = input.attachedSources.map((s) =>
      perSourceStat(s, countEntities(s.sampleArticles)),
    );

    return {
      inferred,
      confidence,
      probes,
      rationale: buildRationale(allArticles.length, entities, inferred.brand ?? undefined),
      perSourceStats,
    };
  }

  /**
   * Empty-input result — surfaces probes for every field so the orchestrator
   * has SOMETHING to ask the user. Confidence is 0 everywhere.
   */
  private emptyResult(input: ProbingInput): ProbingResult {
    const probes: Probe[] = [];
    if (input.existingChatParams.brand == null) {
      probes.push({
        field: 'brand',
        question: 'Which brand should we focus on?',
        chips: [],
        allowFreeText: true,
        rationale: 'No sample articles available.',
      });
    }
    if (
      !Array.isArray(input.existingChatParams.competitors) ||
      (input.existingChatParams.competitors as unknown[]).length === 0
    ) {
      probes.push({
        field: 'competitors',
        question: 'Who should we compare against?',
        chips: [],
        allowFreeText: true,
        rationale: 'No sample articles available.',
      });
    }
    if (
      input.existingChatParams.dateStart == null ||
      input.existingChatParams.dateEnd == null
    ) {
      probes.push({
        field: 'dateRange',
        question: 'Which date range?',
        chips: [],
        allowFreeText: false,
        rationale: 'No sample articles available.',
      });
    }
    if (input.existingChatParams.intention == null) {
      probes.push({
        field: 'intention',
        question: 'Sentiment lens — intention or comment based?',
        chips: [
          { value: 'intention_based', label: 'Intention-based' },
          { value: 'comment_based', label: 'Comment-based' },
        ],
        allowFreeText: false,
        rationale: 'Not inferable without sample articles.',
      });
    }
    if (input.existingChatParams.enrichmentType == null) {
      probes.push({
        field: 'enrichmentType',
        question: 'Add SimilarWeb reach data?',
        chips: [
          { value: 'standard', label: 'Standard enrichment' },
          { value: 'reach', label: 'Enrichment + reach (SimilarWeb)' },
        ],
        allowFreeText: false,
        rationale: 'Not inferable without sample articles.',
      });
    }
    return {
      inferred: {},
      confidence: {
        brand: 0,
        competitors: 0,
        dateRange: 0,
        mediaTypes: 0,
        language: 0,
        intention: 0,
        enrichmentType: 0,
      },
      probes,
      rationale: 'No sample articles were available — every field needs your input.',
      perSourceStats: input.attachedSources.map((s) => ({
        sourceId: s.sourceId,
        sampleSize: 0,
        distinctBrandCandidates: 0,
        distinctCompetitorCandidates: 0,
        dateRangeMin: null,
        dateRangeMax: null,
        languagesDetected: [],
      })),
    };
  }
}

/** Default singleton — most callers want this. Tests can construct fresh
 *  instances for isolation. */
export const sampleClassifier = new SampleClassifier();
