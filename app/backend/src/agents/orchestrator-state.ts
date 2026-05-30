export type ConversationState =
  | 'welcome'
  | 'awaiting_date'
  | 'awaiting_enrichment'
  | 'awaiting_brand'
  | 'awaiting_competitors'
  | 'awaiting_intention'
  | 'ready';

export const INITIAL_STATE: ConversationState = 'welcome';

export interface Chip {
  label: string;   // user-facing
  value: string;   // machine value
}

export interface DateRange {
  type: 'weekly' | '10days' | '20days' | 'custom';
  from?: string;
  to?: string;
}

export interface ChatContext {
  state?: ConversationState;
  dateRange?: DateRange;
  enrichment?: 'enrichment' | 'enrichment_plus_reach';
  brand?: string;
  competitors?: { preset?: 'top5' | 'top3' | 'top2' | 'other'; custom?: string[] };
  intention?: 'intention_based' | 'comment_based';
}

export interface AdvanceInput {
  choice?: string;
  freeText?: string;
}

export interface AdvanceResult {
  newState: ConversationState;
  contextPatch: Partial<ChatContext>;
  replyTemplate: string;     // prompt for the LLM phrasing pass
  chips: Chip[];
}

const DATE_CHIPS: Chip[] = [
  { label: 'Weekly', value: 'weekly' },
  { label: '10 Days', value: '10days' },
  { label: '20 Days', value: '20days' },
  { label: 'Custom', value: 'custom' },
];
const ENRICHMENT_CHIPS: Chip[] = [
  { label: 'Enrichment', value: 'enrichment' },
  { label: 'Enrichment + Reach', value: 'enrichment_plus_reach' },
];
const COMPETITOR_CHIPS: Chip[] = [
  { label: 'Top 5', value: 'top5' },
  { label: 'Top 3', value: 'top3' },
  { label: 'Top 2', value: 'top2' },
  { label: 'Other (custom)', value: 'other' },
];
const INTENTION_CHIPS: Chip[] = [
  { label: 'Intention-based', value: 'intention_based' },
  { label: 'Comment-based', value: 'comment_based' },
];

export type AgentType =
  | 'pr_impact'
  | 'media_monitoring'
  | 'media_measurement'
  | 'reputation_index'
  | 'crisis_management';

export const WELCOME_CHIPS_BY_AGENT: Record<AgentType, Chip[]> & Record<string, Chip[]> = {
  pr_impact: [
    { label: 'Analyze brand sentiment', value: 'analyze_sentiment' },
    { label: 'Monitor coverage', value: 'monitor_coverage' },
    { label: 'Generate PR report', value: 'generate_report' },
  ],
  media_monitoring: [
    { label: 'Track brand mentions', value: 'track_mentions' },
    { label: 'Monitor competitors', value: 'monitor_competitors' },
    { label: 'Set up alerts', value: 'setup_alerts' },
  ],
  media_measurement: [
    { label: 'Measure reach', value: 'measure_reach' },
    { label: 'Compare against industry', value: 'compare_industry' },
    { label: 'Engagement breakdown', value: 'engagement_breakdown' },
  ],
  reputation_index: [
    { label: 'Score brand reputation', value: 'score_reputation' },
    { label: 'Trend over time', value: 'trend_over_time' },
    { label: 'Compare to peers', value: 'compare_to_peers' },
  ],
  crisis_management: [
    { label: 'Detect anomalies', value: 'detect_anomalies' },
    { label: 'Triage emerging crisis', value: 'triage_crisis' },
    { label: 'Suggest response', value: 'suggest_response' },
  ],
};

export function isReady(state: ConversationState): boolean {
  return state === 'ready';
}

/**
 * Per-state chip values used by the LLM `parseChoice` extractor. Centralized
 * here (not duplicated in chat.service + orchestrator.agent) so the sync
 * state-advance path and the streaming-reason path agree on what counts as
 * a valid free-text-to-choice mapping. Free-text states (awaiting_brand)
 * are absent — those stay in freeText mode.
 */
export const CHIP_OPTIONS_BY_STATE: Partial<Record<ConversationState, string[]>> = {
  awaiting_date: ['weekly', '10days', '20days', 'custom'],
  awaiting_enrichment: ['enrichment', 'enrichment_plus_reach'],
  awaiting_competitors: ['top5', 'top3', 'top2', 'other'],
  awaiting_intention: ['intention_based', 'comment_based'],
};

export function advance(
  state: ConversationState,
  input: AdvanceInput,
  _agentType: string,
): AdvanceResult {
  const userInput = input.choice ?? input.freeText ?? '';
  if (!userInput) {
    // Empty input: do not advance.
    return {
      newState: state,
      contextPatch: {},
      replyTemplate: 'Please reply or pick an option to continue.',
      chips: [],
    };
  }

  switch (state) {
    case 'welcome':
      return {
        newState: 'awaiting_date',
        contextPatch: { state: 'awaiting_date' },
        replyTemplate:
          'Acknowledge the user wants to start, and ask which date range to analyze. ' +
          'Keep it to two short sentences.',
        chips: DATE_CHIPS,
      };

    case 'awaiting_date': {
      const dateType = (input.choice ?? '') as DateRange['type'];
      const valid = ['weekly', '10days', '20days', 'custom'].includes(dateType);
      if (!valid) {
        return {
          newState: 'awaiting_date',
          contextPatch: {},
          replyTemplate: 'Politely ask the user to pick one of the date-range chips.',
          chips: DATE_CHIPS,
        };
      }
      return {
        newState: 'awaiting_enrichment',
        contextPatch: { state: 'awaiting_enrichment', dateRange: { type: dateType } },
        replyTemplate:
          `Acknowledge the ${dateType} date range and ask whether to run plain enrichment or ` +
          `enrichment + reach metrics. Two sentences.`,
        chips: ENRICHMENT_CHIPS,
      };
    }

    case 'awaiting_enrichment': {
      const v = input.choice as ChatContext['enrichment'];
      if (v !== 'enrichment' && v !== 'enrichment_plus_reach') {
        return {
          newState: 'awaiting_enrichment',
          contextPatch: {},
          replyTemplate: 'Politely ask the user to pick one of the enrichment chips.',
          chips: ENRICHMENT_CHIPS,
        };
      }
      return {
        newState: 'awaiting_brand',
        contextPatch: { state: 'awaiting_brand', enrichment: v },
        replyTemplate:
          'Acknowledge the enrichment choice and ask the user to type the brand name they want to analyze.',
        chips: [],
      };
    }

    case 'awaiting_brand': {
      // Sanitize: strip control chars + newlines, cap at 80 chars so a user
      // can't smuggle prompt-injection content into the LLM reply template.
      // The unsanitized brand is still stored in contextPatch.brand for later
      // use; only the LLM-facing template uses the sanitized form.
      const rawBrand = (input.freeText ?? '').trim();
      if (!rawBrand) {
        return {
          newState: 'awaiting_brand',
          contextPatch: {},
          replyTemplate: 'Politely ask the user to type the brand name.',
          chips: [],
        };
      }
      // eslint-disable-next-line no-control-regex
      const safeBrand = rawBrand.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 80);
      return {
        newState: 'awaiting_competitors',
        contextPatch: { state: 'awaiting_competitors', brand: rawBrand },
        replyTemplate:
          `Acknowledge "${safeBrand}" and ask which competitor preset to compare against. ` +
          `Two sentences.`,
        chips: COMPETITOR_CHIPS,
      };
    }

    case 'awaiting_competitors': {
      const preset = input.choice as 'top5' | 'top3' | 'top2' | 'other' | undefined;
      if (!preset || !['top5', 'top3', 'top2', 'other'].includes(preset)) {
        return {
          newState: 'awaiting_competitors',
          contextPatch: {},
          replyTemplate: 'Politely ask the user to pick one of the competitor chips.',
          chips: COMPETITOR_CHIPS,
        };
      }
      return {
        newState: 'awaiting_intention',
        contextPatch: { state: 'awaiting_intention', competitors: { preset } },
        replyTemplate:
          'Acknowledge the competitor preset and ask whether to analyze by intention or by comments.',
        chips: INTENTION_CHIPS,
      };
    }

    case 'awaiting_intention': {
      const v = input.choice as ChatContext['intention'];
      if (v !== 'intention_based' && v !== 'comment_based') {
        return {
          newState: 'awaiting_intention',
          contextPatch: {},
          replyTemplate: 'Politely ask the user to pick one of the intention chips.',
          chips: INTENTION_CHIPS,
        };
      }
      return {
        newState: 'ready',
        contextPatch: { state: 'ready', intention: v },
        replyTemplate:
          'Confirm that all parameters are captured. Briefly summarize the brand, date range, ' +
          'enrichment, competitors, and intention. End with: "Phase 2 plugs in real PR analysis. ' +
          'For now, click New Chat to start over."',
        chips: [],
      };
    }

    case 'ready':
      return {
        newState: 'ready',
        contextPatch: {},
        replyTemplate:
          'All parameters were already captured. Politely remind the user that real analysis ' +
          'arrives in Phase 2 and they can click New Chat to start a new flow.',
        chips: [],
      };

    default: {
      // Exhaustive guard — TypeScript will error if a ConversationState is unhandled above.
      const _exhaustive: never = state;
      throw new Error(`Unhandled state: ${String(_exhaustive)}`);
    }
  }
}
