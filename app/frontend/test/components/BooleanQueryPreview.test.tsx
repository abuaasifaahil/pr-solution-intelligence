import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { BooleanQueryPreview } from '../../components/chat/BooleanQueryPreview';
import type { BooleanQuery } from '../../lib/boolean-query';

afterEach(() => cleanup());

const SAMPLE: BooleanQuery = {
  id: 'q1',
  text: '(title:"Acme" OR body:"Acme") AND date:[2026-01 TO 2026-03]',
  structured: null,
  version: 1,
  isConfirmed: false,
};

describe('BooleanQueryPreview', () => {
  it('renders the query text with span-based highlighting tokens', () => {
    render(
      <BooleanQueryPreview
        query={SAMPLE}
        onEdit={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    const pre = screen.getByTestId('boolean-query-pre');
    // The text appears (as a join of token spans).
    expect(pre.textContent).toBe(SAMPLE.text);
    // Spans for keywords + quoted strings present.
    const tokens = pre.querySelectorAll('span');
    const tokenTexts = Array.from(tokens).map((s) => s.textContent);
    expect(tokenTexts).toContain('AND');
    expect(tokenTexts).toContain('OR');
    expect(tokenTexts).toContain('"Acme"');
  });

  it('Edit button toggles a textarea', () => {
    render(
      <BooleanQueryPreview
        query={SAMPLE}
        onEdit={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    expect(screen.queryByLabelText('Edit Boolean query')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    const ta = screen.getByLabelText('Edit Boolean query') as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    expect(ta.value).toBe(SAMPLE.text);
  });

  it('Apply edit calls onEdit with the trimmed draft', () => {
    const onEdit = vi.fn();
    render(
      <BooleanQueryPreview
        query={SAMPLE}
        onEdit={onEdit}
        onConfirm={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    const ta = screen.getByLabelText('Edit Boolean query') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '  body:"New"  ' } });
    fireEvent.click(screen.getByRole('button', { name: /apply edit/i }));
    expect(onEdit).toHaveBeenCalledWith('body:"New"');
  });

  it('hides the action buttons and shows a Confirmed pill when isConfirmed', () => {
    render(
      <BooleanQueryPreview
        query={{ ...SAMPLE, isConfirmed: true, version: 3 }}
        onEdit={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    expect(screen.queryByRole('button', { name: /confirm & process/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();
    expect(screen.getByLabelText('Confirmed').textContent).toMatch(/v3/);
  });

  it('Confirm button is disabled while busy', () => {
    render(
      <BooleanQueryPreview
        query={SAMPLE}
        onEdit={() => undefined}
        onConfirm={() => undefined}
        busy
      />,
    );
    const btn = screen.getByRole('button', { name: /confirming/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('returns null when query prop is null', () => {
    const { container } = render(
      <BooleanQueryPreview
        query={null}
        onEdit={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
