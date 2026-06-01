import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  render,
  cleanup,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import type { ProbingResult, ResolveResponse } from '../../lib/probe';

const getProbe = vi.fn<[string], Promise<ProbingResult>>();
const resolveProbes = vi.fn<
  [string, unknown],
  Promise<ResolveResponse>
>();

vi.mock('../../lib/probe', async () => {
  return {
    getProbe,
    resolveProbes,
  };
});

const { ProbingResultCard } = await import(
  '../../components/chat/ProbingResultCard'
);

afterEach(() => cleanup());
beforeEach(() => {
  getProbe.mockReset();
  resolveProbes.mockReset();
});

function makeResult(overrides: Partial<ProbingResult> = {}): ProbingResult {
  return {
    inferred: { brand: 'FreshSip' },
    confidence: { brand: 0.85 },
    probes: [
      {
        field: 'enrichmentType',
        question: 'Which enrichment level?',
        chips: [
          { value: 'enrichment', label: 'Enrichment' },
          { value: 'enrichment_plus_reach', label: 'Enrichment + reach' },
        ],
        allowFreeText: false,
        rationale: 'Pick a level to control reach fetch.',
      },
    ],
    rationale: 'Looks like FreshSip is the brand here.',
    perSourceStats: [],
    ...overrides,
  };
}

describe('ProbingResultCard', () => {
  it('renders the inferred fields + the probe question from the initial result', () => {
    render(
      <ProbingResultCard chatId="c1" initialResult={makeResult()} />,
    );
    expect(screen.getByTestId('probing-result-card')).toBeTruthy();
    expect(screen.getByTestId('inferred-brand').textContent).toContain('FreshSip');
    expect(screen.getByTestId('probe-section-enrichmentType')).toBeTruthy();
    expect(screen.getByText(/Which enrichment level/)).toBeTruthy();
  });

  it('does NOT call getProbe when initialResult is provided', () => {
    render(
      <ProbingResultCard chatId="c1" initialResult={makeResult()} />,
    );
    expect(getProbe).not.toHaveBeenCalled();
  });

  it('calls getProbe on mount when initialResult is undefined', async () => {
    getProbe.mockResolvedValue(makeResult());
    render(<ProbingResultCard chatId="c1" />);
    await waitFor(() => expect(getProbe).toHaveBeenCalledWith('c1'));
  });

  it('clicking a chip POSTs the resolution + re-renders with remainingProbes', async () => {
    resolveProbes.mockResolvedValue({
      updatedParams: {
        id: 'cp1', chatId: 'c1', userId: 'u1',
        flowState: 'collect_dates',
        dateRangeType: null, dateStart: null, dateEnd: null,
        enrichmentType: 'standard', reachThreshold: null,
        brand: 'FreshSip', competitors: null, competitorSet: null,
        intention: null, hasUpload: false, uploadId: null,
        collectedAt: null,
        createdAt: '2026-06-01T00:00:00Z',
        updatedAt: '2026-06-01T00:00:00Z',
      },
      remainingProbes: [],
    });
    render(
      <ProbingResultCard chatId="c1" initialResult={makeResult()} />,
    );
    fireEvent.click(screen.getByTestId('enrichmentType-chip-enrichment'));
    await waitFor(() =>
      expect(resolveProbes).toHaveBeenCalledWith('c1', [
        { field: 'enrichmentType', value: 'enrichment' },
      ]),
    );
  });

  it('Looks good — continue dismisses the card and fires onDone', () => {
    const onDone = vi.fn();
    render(
      <ProbingResultCard
        chatId="c1"
        initialResult={makeResult()}
        onDone={onDone}
      />,
    );
    fireEvent.click(screen.getByTestId('looks-good-btn'));
    expect(onDone).toHaveBeenCalled();
    expect(screen.queryByTestId('probing-result-card')).toBeNull();
  });

  it('Start over re-runs getProbe', async () => {
    getProbe.mockResolvedValue(makeResult());
    render(
      <ProbingResultCard chatId="c1" initialResult={makeResult()} />,
    );
    expect(getProbe).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('start-over-btn'));
    await waitFor(() => expect(getProbe).toHaveBeenCalledWith('c1'));
  });

  it('clicking edit on an inferred field opens the editor', () => {
    render(
      <ProbingResultCard chatId="c1" initialResult={makeResult()} />,
    );
    fireEvent.click(screen.getByTestId('edit-brand'));
    expect(screen.getByTestId('field-editor-brand')).toBeTruthy();
  });

  it('shows the rationale when present', () => {
    render(
      <ProbingResultCard chatId="c1" initialResult={makeResult()} />,
    );
    expect(screen.getByText(/Looks like FreshSip is the brand/)).toBeTruthy();
  });

  it('dismiss button hides the card', () => {
    const onDismiss = vi.fn();
    render(
      <ProbingResultCard
        chatId="c1"
        initialResult={makeResult()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByLabelText(/Dismiss/));
    expect(onDismiss).toHaveBeenCalled();
    expect(screen.queryByTestId('probing-result-card')).toBeNull();
  });

  it('surfaces an error when getProbe rejects (no initialResult)', async () => {
    getProbe.mockRejectedValue(new Error('classifier offline'));
    render(<ProbingResultCard chatId="c1" />);
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain('classifier offline');
    });
  });
});
