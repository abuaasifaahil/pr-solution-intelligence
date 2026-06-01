/**
 * Phase 2 ConversationalFlowEngine.
 *
 * 9-state pure function. Takes a chat_params snapshot, returns the next
 * state. Extends Phase 1's 6-state orchestrator (welcome → ... → ready)
 * by adding GENERATE_QUERY → PROCESSING → COMPLETE for the data-extract
 * lifecycle.
 *
 * Skip rules per spec §5.2:
 *   COLLECT_DATES skipped when file uploaded with auto-detected dates
 *   COLLECT_BRAND/COMPETITORS/INTENTION skipped if pre-populated in INIT
 *
 * @file agents/flow-engine.ts
 */
import type { FlowState as PrismaFlowState } from '@prsi/shared/db';

export type FlowState = PrismaFlowState;

export interface ChatParamsSnapshot {
  brand: string | null;
  dateStart: Date | null;
  dateEnd: Date | null;
  enrichmentType: string | null;
  competitors: unknown; // JSON array
  intention: string | null;
  hasUpload: boolean;
  hasConfirmedQuery: boolean;
  isProcessingComplete: boolean;
}

/** Pure: takes a params snapshot, returns the next state. */
export function getNextFlowState(p: ChatParamsSnapshot): FlowState {
  if (!p.dateStart && !p.hasUpload) return 'collect_dates';
  if (!p.enrichmentType) return 'collect_enrichment';
  if (!p.brand) return 'collect_brand';
  if (!Array.isArray(p.competitors) || p.competitors.length === 0) return 'collect_competitors';
  if (!p.intention) return 'collect_intention';
  if (!p.hasConfirmedQuery) return 'generate_query';
  if (!p.isProcessingComplete) return 'processing';
  return 'complete';
}

/** Returns the prompt the system should send for the given state.
 *  Each state produces { template, chips? } — chips wired into the
 *  existing ChatActionPrompt component (M5/PR#15-16). */
export interface StatePrompt {
  template: string;
  chips: Array<{ label: string; value: string }>;
}

export function getPromptForState(state: FlowState, _p: ChatParamsSnapshot): StatePrompt {
  switch (state) {
    case 'init':
      return { template: 'How can I help with your analysis today?', chips: [] };
    case 'collect_dates':
      return {
        template: 'Which date range should I analyze?',
        chips: [
          { label: 'Weekly', value: 'weekly' },
          { label: '10 Days', value: 'ten_days' },
          { label: '20 Days', value: 'twenty_days' },
          { label: 'Custom', value: 'custom' },
        ],
      };
    case 'collect_enrichment':
      return {
        template: 'Would you like standard enrichment, or also include reach metrics?',
        chips: [
          { label: 'Enrichment', value: 'standard' },
          { label: 'Enrichment + Reach', value: 'reach' },
        ],
      };
    case 'collect_brand':
      return { template: 'What brand would you like to analyze?', chips: [] };
    case 'collect_competitors':
      return {
        template: 'Pick a competitor set:',
        chips: [
          { label: 'Top 5', value: 'top5' },
          { label: 'Top 3', value: 'top3' },
          { label: 'Top 2', value: 'top2' },
          { label: 'Custom', value: 'custom' },
        ],
      };
    case 'collect_intention':
      return {
        template: 'Analyze by user intention or by comment content?',
        chips: [
          { label: 'Intention-based', value: 'intention_based' },
          { label: 'Comment-based', value: 'comment_based' },
        ],
      };
    case 'generate_query':
      return { template: 'Generating Boolean query — review and confirm.', chips: [] };
    case 'processing':
      return { template: 'Processing your data...', chips: [] };
    case 'complete':
      return { template: 'Data pipeline complete. Ready for enrichment.', chips: [] };
    default: {
      // Exhaustive guard
      const _x: never = state;
      throw new Error(`unknown flow state: ${String(_x)}`);
    }
  }
}
