/**
 * Phase 2 — Frontend source of truth for the conversational flow state
 * literal union + display labels.
 *
 * Promoted out of `components/chat/FlowDotIndicator.tsx` (M7.8 kept a local
 * copy) so future components — the chip flow prompt, the processing panel,
 * the breadcrumb, future agents in Phase 5.5 — share one canonical list.
 *
 * Mirrors `@prsi/shared/types/phase2#FlowStateLiteral`; kept local so the
 * frontend doesn't have to import Prisma indirectly through the shared
 * package's `@prisma/client` re-exports.
 *
 * @file lib/flow-states.ts
 */

export type FlowStateLiteral =
  | 'init'
  | 'collect_dates'
  | 'collect_enrichment'
  | 'collect_brand'
  | 'collect_competitors'
  | 'collect_intention'
  | 'generate_query'
  | 'processing'
  | 'complete';

/** Ordered list — order matches the dot indicator left → right. */
export const FLOW_STATES: readonly FlowStateLiteral[] = [
  'init',
  'collect_dates',
  'collect_enrichment',
  'collect_brand',
  'collect_competitors',
  'collect_intention',
  'generate_query',
  'processing',
  'complete',
] as const;

/** Short label per state — used by the dot indicator's title tooltips and
 *  the breadcrumb summary at the right edge of the indicator. */
export const STATE_LABELS: Record<FlowStateLiteral, string> = {
  init: 'Start',
  collect_dates: 'Dates',
  collect_enrichment: 'Enrichment',
  collect_brand: 'Brand',
  collect_competitors: 'Competitors',
  collect_intention: 'Intention',
  generate_query: 'Query',
  processing: 'Process',
  complete: 'Done',
};

/** Type guard — returns true for the 9 valid flow-state strings. Defensive
 *  for WS events whose payloads come over the wire as plain strings. */
export function isFlowState(s: string): s is FlowStateLiteral {
  return (FLOW_STATES as readonly string[]).includes(s);
}
