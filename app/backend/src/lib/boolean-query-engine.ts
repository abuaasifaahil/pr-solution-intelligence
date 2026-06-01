/**
 * Phase 2 BooleanQueryEngine — M7.6.
 *
 * Pure-string Boolean query construction. No LLM, no DB, no IO. The engine
 * accepts a chat_params-shaped input and returns both a human-readable
 * query text (Lucene-ish field:value syntax) AND a structured JSON mirror
 * for downstream re-execution by the DataExtractAgent (M7.7).
 *
 * Output format (spec §5.3):
 *   ((title:"FreshSip" OR headline:"FreshSip" OR content:"FreshSip")
 *    AND (content:"PepsiCo" OR description:"PepsiCo" OR ...)
 *    AND date:[2026-05-01 TO 2026-05-20]
 *    AND language:"en")
 *
 * @file lib/boolean-query-engine.ts
 */

export interface BooleanQueryInput {
  brand: string;
  competitors: string[];
  dateStart: Date | null;
  dateEnd: Date | null;
  language?: string; // default 'en'
  brandFields?: string[]; // default ['title', 'headline', 'content']
  competitorFields?: string[]; // default ['content', 'description']
}

export interface BooleanQueryStructured {
  brand: string;
  brandFields: string[];
  competitors: string[];
  competitorFields: string[];
  dateRange: { start: string; end: string } | null; // ISO YYYY-MM-DD
  language: string;
}

export interface BooleanQueryOutput {
  text: string;
  structured: BooleanQueryStructured;
}

const DEFAULT_BRAND_FIELDS = ['title', 'headline', 'content'];
const DEFAULT_COMPETITOR_FIELDS = ['content', 'description'];

function escapeQueryValue(v: string): string {
  // Strip outer whitespace, escape embedded double-quotes for the
  // field:"value" syntax.
  return v.trim().replace(/"/g, '\\"');
}

function buildFieldClause(term: string, fields: string[]): string {
  const value = `"${escapeQueryValue(term)}"`;
  return fields.map((f) => `${f}:${value}`).join(' OR ');
}

function buildCompetitorClause(competitors: string[], fields: string[]): string {
  if (competitors.length === 0) return '';
  // Each competitor produces a field-OR clause; competitors are OR-joined.
  // Result: content:"X" OR description:"X" OR content:"Y" OR description:"Y"
  return competitors.map((c) => buildFieldClause(c, fields)).join(' OR ');
}

function formatDate(d: Date): string {
  // YYYY-MM-DD (UTC).
  return d.toISOString().slice(0, 10);
}

/**
 * Build a Boolean query from a params snapshot. Returns the human-readable
 * text and a structured JSON mirror. Throws if `brand` is missing/empty
 * (the conversational flow guarantees brand is set before generate runs).
 *
 * `dateRange` in `structured` is `null` if either bound is missing — and
 * the text output omits the `date:[…]` clause in that case.
 */
export function generateBooleanQuery(input: BooleanQueryInput): BooleanQueryOutput {
  const brandTrim = escapeQueryValue(input.brand);
  if (!brandTrim) throw new Error('brand is required');

  const brandFields = input.brandFields ?? DEFAULT_BRAND_FIELDS;
  const competitorFields = input.competitorFields ?? DEFAULT_COMPETITOR_FIELDS;
  const language = (input.language ?? 'en').toLowerCase();

  const brandClause = buildFieldClause(input.brand, brandFields);

  const cleanCompetitors = input.competitors.map((c) => c.trim()).filter(Boolean);
  const compClause = cleanCompetitors.length
    ? buildCompetitorClause(cleanCompetitors, competitorFields)
    : null;

  const parts: string[] = [`(${brandClause})`];
  if (compClause) parts.push(`(${compClause})`);

  let dateRangeStructured: { start: string; end: string } | null = null;
  if (input.dateStart && input.dateEnd) {
    const s = formatDate(input.dateStart);
    const e = formatDate(input.dateEnd);
    dateRangeStructured = { start: s, end: e };
    parts.push(`date:[${s} TO ${e}]`);
  }

  parts.push(`language:"${language}"`);

  const text = parts.join(' AND ');

  return {
    text,
    structured: {
      brand: brandTrim,
      brandFields,
      competitors: cleanCompetitors,
      competitorFields,
      dateRange: dateRangeStructured,
      language,
    },
  };
}
