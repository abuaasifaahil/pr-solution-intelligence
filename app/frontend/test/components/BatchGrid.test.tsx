import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { BatchGrid } from '../../components/chat/BatchGrid';
import type { EnrichmentBatchView } from '../../lib/enrichment';

afterEach(() => cleanup());

function makeBatch(
  n: number,
  overrides: Partial<EnrichmentBatchView> = {},
): EnrichmentBatchView {
  return {
    batchNumber: n,
    status: 'pending',
    retryCount: 0,
    estimatedTokens: 0,
    actualTokensIn: null,
    actualTokensOut: null,
    processingMs: null,
    error: null,
    ...overrides,
  };
}

describe('BatchGrid', () => {
  it('renders one tile per batch', () => {
    const batches: EnrichmentBatchView[] = Array.from({ length: 12 }, (_, i) =>
      makeBatch(i + 1),
    );
    const { container } = render(<BatchGrid batches={batches} />);
    expect(container.querySelectorAll('[data-batch-number]')).toHaveLength(12);
  });

  it('exposes the per-batch status on each tile via data-status', () => {
    const batches: EnrichmentBatchView[] = [
      makeBatch(1, { status: 'completed' }),
      makeBatch(2, { status: 'processing' }),
      makeBatch(3, { status: 'failed' }),
      makeBatch(4, { status: 'retrying', retryCount: 1 }),
      makeBatch(5, { status: 'pending' }),
    ];
    const { container } = render(<BatchGrid batches={batches} />);
    expect(
      container.querySelector('[data-batch-number="1"]')?.getAttribute('data-status'),
    ).toBe('completed');
    expect(
      container.querySelector('[data-batch-number="2"]')?.getAttribute('data-status'),
    ).toBe('processing');
    expect(
      container.querySelector('[data-batch-number="3"]')?.getAttribute('data-status'),
    ).toBe('failed');
    expect(
      container.querySelector('[data-batch-number="4"]')?.getAttribute('data-status'),
    ).toBe('retrying');
    expect(
      container.querySelector('[data-batch-number="5"]')?.getAttribute('data-status'),
    ).toBe('pending');
  });

  it('shows the error in the title attribute on a failed tile', () => {
    const batches = [
      makeBatch(1, { status: 'failed', error: 'OpenAI 500' }),
    ];
    const { container } = render(<BatchGrid batches={batches} />);
    const tile = container.querySelector('[data-batch-number="1"]')!;
    expect(tile.getAttribute('title')).toContain('OpenAI 500');
  });

  it('shows duration in the title attribute on a completed tile', () => {
    const batches = [
      makeBatch(1, { status: 'completed', processingMs: 1234 }),
    ];
    const { container } = render(<BatchGrid batches={batches} />);
    const tile = container.querySelector('[data-batch-number="1"]')!;
    expect(tile.getAttribute('title')).toContain('1234ms');
  });

  it('renders the X / N completed counter', () => {
    const batches = [
      makeBatch(1, { status: 'completed' }),
      makeBatch(2, { status: 'completed' }),
      makeBatch(3, { status: 'processing' }),
    ];
    render(<BatchGrid batches={batches} />);
    expect(screen.getByText(/2 \/ 3 completed/)).toBeTruthy();
  });

  it('surfaces failed count in the header when any batch failed', () => {
    const batches = [
      makeBatch(1, { status: 'completed' }),
      makeBatch(2, { status: 'failed', error: 'x' }),
    ];
    render(<BatchGrid batches={batches} />);
    expect(screen.getByText(/1 failed/)).toBeTruthy();
  });
});
