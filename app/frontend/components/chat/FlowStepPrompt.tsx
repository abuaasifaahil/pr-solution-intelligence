'use client';

import { useState, type JSX } from 'react';
import { ChatActionPrompt } from './ChatActionPrompt';
import { BrandInput } from './BrandInput';
import { CompetitorTags } from './CompetitorTags';
import { CustomDatePicker } from './CustomDatePicker';
import { ReachThresholdInput } from './ReachThresholdInput';
import type {
  ChatParams,
  CompetitorSet,
  CompetitorSuggestions,
} from '../../lib/chat-params';
import type { FlowStateLiteral } from '../../lib/flow-states';

/**
 * Per-state input chooser for the Phase 2 chip flow.
 *
 * Each render of FlowStepPrompt looks at `state` and shows the right input
 * component. Fixed-chip states reuse the M5 `ChatActionPrompt` (same look
 * as Phase 1 orchestrator); input-heavy states use the new BrandInput /
 * CompetitorTags / CustomDatePicker / ReachThresholdInput components.
 *
 * The component owns the small UX state needed inside a single step (e.g.
 * the "custom range" sub-mode for dates). Everything else — PATCHes, WS
 * subscriptions, generation triggers — is handled by `useChatSession`.
 *
 * @file components/chat/FlowStepPrompt.tsx
 */

interface Props {
  state: FlowStateLiteral;
  params: ChatParams | null;
  /** Loading flag for the brand-suggest call (set by useChatSession). */
  competitorsLoading?: boolean;
  competitorSuggestions: CompetitorSuggestions | null;

  // ── per-state action callbacks ────────────────────────────────────────
  onDatePreset: (preset: 'weekly' | 'ten_days' | 'twenty_days') => void;
  onCustomDate: (start: Date, end: Date) => void;
  onEnrichmentPick: (kind: 'standard' | 'reach', threshold?: number) => void;
  onBrandSubmit: (brand: string) => void;
  onCompetitorsSubmit: (competitors: string[], set: CompetitorSet) => void;
  onIntentionPick: (intention: 'intention_based' | 'comment_based') => void;
}

export function FlowStepPrompt(props: Props): JSX.Element | null {
  const { state } = props;

  switch (state) {
    case 'collect_dates':
      return <DateStep {...props} />;
    case 'collect_enrichment':
      return <EnrichmentStep {...props} />;
    case 'collect_brand':
      return (
        <BrandInput
          defaultValue={props.params?.brand ?? undefined}
          onSubmit={props.onBrandSubmit}
        />
      );
    case 'collect_competitors':
      return (
        <CompetitorTags
          brand={props.params?.brand ?? 'your brand'}
          suggestions={props.competitorSuggestions}
          loading={props.competitorsLoading}
          defaultCompetitors={props.params?.competitors ?? undefined}
          defaultSet={props.params?.competitorSet ?? undefined}
          onSubmit={props.onCompetitorsSubmit}
        />
      );
    case 'collect_intention':
      return (
        <ChatActionPrompt
          question="How should I analyze the coverage?"
          options={[
            {
              id: 'intention_based',
              label: 'Intention-based',
              hint: 'derive sentiment + intent from full text',
            },
            {
              id: 'comment_based',
              label: 'Comment-based',
              hint: 'lean on engagement signal',
            },
          ]}
          allowCustom={false}
          onSelect={({ id }) => {
            if (id === 'intention_based' || id === 'comment_based') {
              props.onIntentionPick(id);
            }
          }}
        />
      );
    default:
      return null;
  }
}

// ── collect_dates ─────────────────────────────────────────────────────────

function DateStep({
  params,
  onDatePreset,
  onCustomDate,
}: Props): JSX.Element {
  const [mode, setMode] = useState<'preset' | 'custom'>('preset');

  if (mode === 'custom') {
    return (
      <CustomDatePicker
        defaultStart={params?.dateStart ? new Date(params.dateStart) : null}
        defaultEnd={params?.dateEnd ? new Date(params.dateEnd) : null}
        onSubmit={onCustomDate}
        onCancel={() => setMode('preset')}
      />
    );
  }

  return (
    <ChatActionPrompt
      question="Which date range should I analyze?"
      allowCustom={false}
      options={[
        { id: 'weekly', label: 'Weekly', hint: 'last 7 days' },
        { id: 'ten_days', label: '10 Days', hint: 'last 10 days' },
        { id: 'twenty_days', label: '20 Days', hint: 'last 20 days' },
        { id: 'custom', label: 'Custom range', hint: 'pick exact start/end' },
      ]}
      onSelect={({ id }) => {
        if (id === 'custom') {
          setMode('custom');
          return;
        }
        if (id === 'weekly' || id === 'ten_days' || id === 'twenty_days') {
          onDatePreset(id);
        }
      }}
    />
  );
}

// ── collect_enrichment ─────────────────────────────────────────────────────

function EnrichmentStep({
  onEnrichmentPick,
}: Props): JSX.Element {
  const [mode, setMode] = useState<'pick' | 'reach-threshold'>('pick');

  if (mode === 'reach-threshold') {
    return (
      <ReachThresholdInput
        onSubmit={(t) => {
          onEnrichmentPick('reach', t);
          setMode('pick');
        }}
      />
    );
  }

  return (
    <ChatActionPrompt
      question="What level of enrichment do you need?"
      allowCustom={false}
      options={[
        {
          id: 'standard',
          label: 'Standard',
          hint: 'topics + sentiment + entities',
        },
        {
          id: 'reach',
          label: 'Reach',
          hint: 'standard + audience-reach filter',
        },
      ]}
      onSelect={({ id }) => {
        if (id === 'standard') {
          onEnrichmentPick('standard');
        } else if (id === 'reach') {
          setMode('reach-threshold');
        }
      }}
    />
  );
}
