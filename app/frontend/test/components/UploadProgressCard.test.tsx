import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { UploadProgressCard } from '../../components/chat/UploadProgressCard';
import type { UploadStatus } from '../../lib/uploads';

afterEach(() => cleanup());

function makeUpload(overrides: Partial<UploadStatus> = {}): UploadStatus {
  return {
    id: 'u1',
    filename: 'news.csv',
    mimeType: 'text/csv',
    sizeBytes: 2048,
    rowCount: null,
    columnCount: null,
    schemaDetected: [],
    dateColumn: null,
    dateRangeStart: null,
    dateRangeEnd: null,
    status: 'uploading',
    errorMessage: null,
    parsedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('UploadProgressCard', () => {
  it('renders uploading state with a progress bar', () => {
    render(<UploadProgressCard upload={makeUpload({ status: 'uploading' })} progressPercent={42} />);
    expect(screen.getByText('news.csv')).toBeTruthy();
    expect(screen.getByText('uploading')).toBeTruthy();
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
  });

  it('renders parsing state with an indeterminate progress bar', () => {
    render(<UploadProgressCard upload={makeUpload({ status: 'parsing' })} />);
    expect(screen.getByText('parsing')).toBeTruthy();
    const bar = screen.getByRole('progressbar');
    // No valuenow when indeterminate.
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
  });

  it('renders ready state with the metadata grid (rows + columns + date range)', () => {
    render(
      <UploadProgressCard
        upload={makeUpload({
          status: 'ready',
          rowCount: 1234,
          columnCount: 5,
          dateRangeStart: '2026-01-01T00:00:00Z',
          dateRangeEnd: '2026-03-31T23:59:59Z',
          schemaDetected: [{ name: 'a', type: 'string', sample: 'x' }],
          parsedAt: '2026-04-01T00:00:00Z',
        })}
      />,
    );
    expect(screen.getByText('ready')).toBeTruthy();
    expect(screen.getByText(/Rows:/).textContent).toMatch(/1,234/);
    expect(screen.getByText(/Columns:/).textContent).toMatch(/5/);
    expect(screen.getByText(/Date range:/).textContent).toMatch(/2026-01-01.*2026-03-31/);
    // No progress bar in the ready state.
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('renders the error message in an alert when status is error', () => {
    render(
      <UploadProgressCard
        upload={makeUpload({ status: 'error', errorMessage: 'Empty CSV detected' })}
      />,
    );
    expect(screen.getByText('error')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/empty csv/i);
  });

  it('shows × button and fires onRemove when clicked', () => {
    const onRemove = vi.fn();
    render(
      <UploadProgressCard
        upload={makeUpload({ status: 'ready', rowCount: 1, columnCount: 1 })}
        onRemove={onRemove}
      />,
    );
    const btn = screen.getByRole('button', { name: /remove upload/i });
    fireEvent.click(btn);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('hides × button during parsing (can\'t cancel mid-parse)', () => {
    const onRemove = vi.fn();
    render(
      <UploadProgressCard upload={makeUpload({ status: 'parsing' })} onRemove={onRemove} />,
    );
    expect(screen.queryByRole('button', { name: /remove upload/i })).toBeNull();
  });
});
