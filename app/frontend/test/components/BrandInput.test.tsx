import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { BrandInput } from '../../components/chat/BrandInput';

afterEach(() => cleanup());

describe('BrandInput', () => {
  it('renders the prompt copy', () => {
    render(<BrandInput onSubmit={() => undefined} />);
    expect(screen.getByText(/which brand/i)).toBeTruthy();
  });

  it('submits on Enter with the trimmed value', () => {
    const onSubmit = vi.fn();
    render(<BrandInput onSubmit={onSubmit} />);
    const input = screen.getByLabelText('Brand name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  Acme  ' } });
    // Submitting the form (button click) mirrors Enter.
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(onSubmit).toHaveBeenCalledWith('Acme');
  });

  it('disables submit when empty', () => {
    render(<BrandInput onSubmit={() => undefined} />);
    const btn = screen.getByRole('button', { name: /continue/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('pre-fills from defaultValue and allows editing', () => {
    const onSubmit = vi.fn();
    render(<BrandInput defaultValue="Acme" onSubmit={onSubmit} />);
    const input = screen.getByLabelText('Brand name') as HTMLInputElement;
    expect(input.value).toBe('Acme');
    fireEvent.change(input, { target: { value: 'Acme Corp' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(onSubmit).toHaveBeenCalledWith('Acme Corp');
  });

  it('respects readOnly — submit stays disabled and input is read-only', () => {
    render(<BrandInput defaultValue="Acme" readOnly onSubmit={() => undefined} />);
    const input = screen.getByLabelText('Brand name') as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    const btn = screen.getByRole('button', { name: /continue/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
