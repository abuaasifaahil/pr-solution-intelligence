import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { FileDropZone } from '../../components/chat/FileDropZone';

afterEach(() => cleanup());

function makeFile(name: string, mime: string, sizeBytes: number): File {
  // jsdom respects the size set by passing in a Blob of the right length.
  const blob = new Blob([new Uint8Array(sizeBytes)], { type: mime });
  return new File([blob], name, { type: mime });
}

function dropFile(zone: HTMLElement, file: File): void {
  const dt = {
    files: [file],
    items: [],
    types: ['Files'],
  } as unknown as DataTransfer;
  fireEvent.drop(zone, { dataTransfer: dt });
}

describe('FileDropZone', () => {
  it('renders the default copy', () => {
    render(<FileDropZone onFile={() => undefined} />);
    expect(screen.getByText(/Drop your data file here/i)).toBeTruthy();
    expect(screen.getByText(/CSV or JSON/i)).toBeTruthy();
  });

  it('accepts a valid CSV → calls onFile, no error shown', () => {
    const onFile = vi.fn();
    render(<FileDropZone onFile={onFile} />);
    const zone = screen.getByRole('button', { name: /upload a csv or json file/i });
    const file = makeFile('news.csv', 'text/csv', 1024);
    dropFile(zone, file);
    expect(onFile).toHaveBeenCalledTimes(1);
    expect(onFile.mock.calls[0]![0]!.name).toBe('news.csv');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('accepts a JSON file by extension when the MIME is empty', () => {
    const onFile = vi.fn();
    render(<FileDropZone onFile={onFile} />);
    const zone = screen.getByRole('button');
    const file = makeFile('coverage.json', '', 2048);
    dropFile(zone, file);
    expect(onFile).toHaveBeenCalledTimes(1);
  });

  it('rejects a 60MB file with an error message', () => {
    const onFile = vi.fn();
    render(<FileDropZone onFile={onFile} />);
    const zone = screen.getByRole('button');
    const file = makeFile('big.csv', 'text/csv', 60 * 1024 * 1024);
    dropFile(zone, file);
    expect(onFile).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/too large/i);
  });

  it('rejects an unsupported file type', () => {
    const onFile = vi.fn();
    render(<FileDropZone onFile={onFile} />);
    const zone = screen.getByRole('button');
    const file = makeFile('malware.exe', 'application/octet-stream', 1024);
    dropFile(zone, file);
    expect(onFile).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/csv or json/i);
  });

  it('disabled prevents drop from invoking onFile', () => {
    const onFile = vi.fn();
    render(<FileDropZone onFile={onFile} disabled />);
    const zone = screen.getByRole('button');
    dropFile(zone, makeFile('news.csv', 'text/csv', 1024));
    expect(onFile).not.toHaveBeenCalled();
  });
});
