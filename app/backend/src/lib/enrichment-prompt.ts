/**
 * Phase 3 — Enrichment prompt assembly.
 *
 * Builds the LLMMessage[] sequence for the EnrichmentAgent (M8.4): a strict
 * system prompt enumerating the 6-dimension output shape, a one-shot
 * positive+negative few-shot pair (sentiment variety), and a final user
 * batch with one block per article. Per-article content is truncated to
 * MAX_ARTICLE_CHARS (middle-strip) so a single oversized doc cannot blow
 * the batch token budget.
 *
 * Pure contract layer — no LLM IO, no DB. Consumed by the agent in M8.4.
 *
 * @file backend/src/lib/enrichment-prompt.ts
 */
import type { LLMMessage } from './llm-providers/types.js';

/**
 * Hard cap per article body. Longer content gets truncated from the
 * middle (head + tail kept) because most PR signal lives at both edges:
 * the lede sets the topic, the closing often contains forward-looking
 * quotes. Keeps batch token budget predictable.
 */
const MAX_ARTICLE_CHARS = 16_000;

export interface PromptArticle {
  id: string;
  title: string;
  content: string | null;
  description: string | null;
  source: string | null;
  author: string | null;
  url: string | null;
  publisherDomain: string | null;
  publishedDate: Date | null;
  language: string;
  /** Optional social engagement metrics — set when source is social media. */
  isSocial?: boolean;
  likes?: number;
  comments?: number;
  shares?: number;
  impressions?: number;
}

const SYSTEM_PROMPT = `You are an expert PR-intelligence analyst. For each article in the user batch, return a strict JSON object describing six enrichment dimensions: sentiment, themes (3 levels: main / secondary / tertiary), emotion, entities, signals, and (for social posts) engagement.

Output format — strict JSON object with key "articles" containing an array. Each element MUST follow this exact schema:

{
  "articleId": "<the id supplied for this article>",
  "sentiment": { "label": "positive" | "neutral" | "negative", "confidence": 0.0-1.0, "reason": "<one-sentence reason>" },
  "themes": [
    { "level": "main", "name": "<theme>", "confidence": 0.0-1.0, "reason": "..." },
    { "level": "secondary", "name": "<theme>", "confidence": 0.0-1.0, "reason": "..." },
    { "level": "tertiary", "name": "<theme>", "confidence": 0.0-1.0, "reason": "..." }
  ],
  "emotion": { "label": "joy" | "anger" | "fear" | "sadness" | "surprise" | "trust" | "disgust" | "neutral", "intensity": 0.0-1.0 },
  "entities": [
    { "type": "person" | "company" | "organization" | "brand" | "competitor" | "location" | "product", "name": "<entity>", "mentions": <integer>=1> }
  ],
  "signals": [
    { "type": "emerging" | "declining" | "anomaly" | "crisis", "description": "<short>", "reason": "<why>" }
  ]
}

CRITICAL: Output JSON only. No markdown fences. No prose preamble. No trailing commentary.`;

/**
 * Few-shot example demonstrating the exact output shape. One positive +
 * one negative for sentiment variety; kept short to preserve token budget.
 */
const FEW_SHOT_USER = `Articles:
[A:fewshot-1] "PepsiCo posts record quarterly earnings, driven by strong Latin American growth and new product launches."
Source: Reuters | Domain: reuters.com | Date: 2026-04-15 | Lang: en

[A:fewshot-2] "Coca-Cola supply chain disruption sparks investor concern as bottling partners report shortages across the EU."
Source: Bloomberg | Domain: bloomberg.com | Date: 2026-04-16 | Lang: en`;

const FEW_SHOT_ASSISTANT = JSON.stringify(
  {
    articles: [
      {
        articleId: 'fewshot-1',
        sentiment: {
          label: 'positive',
          confidence: 0.92,
          reason: 'Record earnings and growth narrative dominate the headline.',
        },
        themes: [
          {
            level: 'main',
            name: 'Earnings & Financial Performance',
            confidence: 0.95,
            reason: 'Article opens with quarterly results.',
          },
          {
            level: 'secondary',
            name: 'Geographic Expansion',
            confidence: 0.78,
            reason: 'Latin American growth called out specifically.',
          },
          {
            level: 'tertiary',
            name: 'Product Strategy',
            confidence: 0.62,
            reason: 'Mentions new product launches.',
          },
        ],
        emotion: { label: 'joy', intensity: 0.7 },
        entities: [
          { type: 'company', name: 'PepsiCo', mentions: 1 },
          { type: 'location', name: 'Latin America', mentions: 1 },
        ],
        signals: [
          {
            type: 'emerging',
            description: 'Latin American market momentum',
            reason: 'Explicit call-out suggests it may continue.',
          },
        ],
      },
      {
        articleId: 'fewshot-2',
        sentiment: {
          label: 'negative',
          confidence: 0.88,
          reason: 'Supply chain disruption and investor concern are negative framing.',
        },
        themes: [
          {
            level: 'main',
            name: 'Supply Chain & Operations',
            confidence: 0.93,
            reason: 'Disruption is the central topic.',
          },
          {
            level: 'secondary',
            name: 'Investor Sentiment',
            confidence: 0.71,
            reason: 'Article mentions investor concern.',
          },
          {
            level: 'tertiary',
            name: 'Regional Distribution',
            confidence: 0.6,
            reason: 'EU bottling partners specifically affected.',
          },
        ],
        emotion: { label: 'fear', intensity: 0.65 },
        entities: [
          { type: 'company', name: 'Coca-Cola', mentions: 1 },
          { type: 'location', name: 'EU', mentions: 1 },
        ],
        signals: [
          {
            type: 'anomaly',
            description: 'Multi-region bottling shortage',
            reason: 'Atypical disruption pattern.',
          },
          {
            type: 'crisis',
            description: 'Investor confidence at risk',
            reason: 'Public concern from shareholder side.',
          },
        ],
      },
    ],
  },
  null,
  0,
);

/**
 * Truncate excessive content while preserving start + end (most signal
 * lives at both edges). Inserts a clear marker so the LLM does not treat
 * the truncation as a structural break.
 */
function truncate(text: string | null, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  const half = Math.floor(max / 2) - 20;
  return text.slice(0, half) + '\n[...truncated...]\n' + text.slice(text.length - half);
}

function formatArticle(a: PromptArticle): string {
  const body = a.content ?? a.description ?? '';
  const content = truncate(body, MAX_ARTICLE_CHARS);
  const date = a.publishedDate ? a.publishedDate.toISOString().slice(0, 10) : 'unknown';
  const lines = [
    `[A:${a.id}] "${a.title}"`,
    content,
    `Source: ${a.source ?? 'unknown'} | Domain: ${a.publisherDomain ?? 'unknown'} | Author: ${a.author ?? 'unknown'} | Date: ${date} | Lang: ${a.language}`,
  ];
  if (a.isSocial) {
    const social = [
      a.likes != null ? `likes=${a.likes}` : null,
      a.comments != null ? `comments=${a.comments}` : null,
      a.shares != null ? `shares=${a.shares}` : null,
      a.impressions != null ? `impressions=${a.impressions}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    if (social) lines.push(`Social: ${social}`);
  }
  if (a.url) lines.push(`URL: ${a.url}`);
  return lines.join('\n');
}

/** Build the full LLM message array for one batch of articles. */
export function buildEnrichmentMessages(articles: PromptArticle[]): LLMMessage[] {
  const body = articles.map(formatArticle).join('\n\n---\n\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: FEW_SHOT_USER },
    { role: 'assistant', content: FEW_SHOT_ASSISTANT },
    { role: 'user', content: `Articles:\n${body}` },
  ];
}

/**
 * Approximate token cost of the system + few-shot prefix. Used by the
 * EnrichmentAgent (M8.4) to subtract overhead from the model's input
 * window when sizing batches. If the prompt text drifts, the test in
 * `enrichment-prompt.test.ts` will fail and this constant should be
 * updated.
 */
export const FEW_SHOT_OVERHEAD_TOKENS = 900;

export { SYSTEM_PROMPT, FEW_SHOT_USER, FEW_SHOT_ASSISTANT, MAX_ARTICLE_CHARS };
