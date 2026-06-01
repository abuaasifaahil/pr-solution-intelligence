import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  cleanup,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import type { UserAgent } from '../../../lib/user-agents';

/**
 * M9.9 — NewUserAgentModal create + edit flows.
 *
 * @file test/components/settings/NewUserAgentModal.test.tsx
 */

const createUserAgent = vi.fn();
const updateUserAgent = vi.fn();

vi.mock('../../../lib/user-agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/user-agents')>();
  return { ...actual, createUserAgent, updateUserAgent };
});

const { NewUserAgentModal } = await import(
  '../../../components/settings/NewUserAgentModal'
);

const EXISTING: UserAgent = {
  id: 'ua-1', userId: 'u1', name: 'My Beverage Tracker',
  baseAgentKind: 'brand_sentinel',
  customization: {
    description: 'For SKU coverage',
    defaults: { brand: 'FreshSip', mediaTypes: ['online'] },
  },
  scope: 'user_private',
  createdAt: '2026-06-01T00:00:00Z',
};

beforeEach(() => {
  createUserAgent.mockReset();
  updateUserAgent.mockReset();
});
afterEach(() => cleanup());

describe('NewUserAgentModal', () => {
  it('blocks submit when name is missing', async () => {
    const onSaved = vi.fn();
    render(
      <NewUserAgentModal existing={null} onClose={() => undefined} onSaved={onSaved} />,
    );
    fireEvent.click(screen.getByTestId('ua-submit'));
    await waitFor(() =>
      expect(screen.getByText(/Name is required/i)).toBeTruthy(),
    );
    expect(createUserAgent).not.toHaveBeenCalled();
  });

  it('blocks submit when description is missing', async () => {
    render(
      <NewUserAgentModal
        existing={null}
        onClose={() => undefined}
        onSaved={() => undefined}
      />,
    );
    fireEvent.change(screen.getByTestId('ua-name-input'), {
      target: { value: 'My Pharma Watch' },
    });
    fireEvent.click(screen.getByTestId('ua-submit'));
    await waitFor(() =>
      expect(screen.getByText(/Description is required/i)).toBeTruthy(),
    );
    expect(createUserAgent).not.toHaveBeenCalled();
  });

  it('submits a create call with the full customization shape', async () => {
    createUserAgent.mockResolvedValue({ id: 'ua-new' });
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(
      <NewUserAgentModal existing={null} onClose={onClose} onSaved={onSaved} />,
    );

    fireEvent.change(screen.getByTestId('ua-name-input'), {
      target: { value: 'Pharma Watch' },
    });
    fireEvent.change(screen.getByTestId('ua-description-input'), {
      target: { value: 'Tuned for pharma keywords' },
    });
    fireEvent.change(screen.getByTestId('ua-brand-input'), {
      target: { value: 'Acme' },
    });
    fireEvent.click(screen.getByTestId('ua-base-crisis_watch'));
    fireEvent.click(screen.getByTestId('ua-media-online'));
    fireEvent.click(screen.getByTestId('ua-media-x_twitter'));

    fireEvent.click(screen.getByTestId('ua-submit'));

    await waitFor(() => expect(createUserAgent).toHaveBeenCalledTimes(1));
    const arg = createUserAgent.mock.calls[0]![0];
    expect(arg.name).toBe('Pharma Watch');
    expect(arg.baseAgentKind).toBe('crisis_watch');
    expect(arg.customization.description).toBe('Tuned for pharma keywords');
    expect(arg.customization.defaults.brand).toBe('Acme');
    expect(arg.customization.defaults.mediaTypes).toContain('online');
    expect(arg.customization.defaults.mediaTypes).toContain('x_twitter');
    expect(onSaved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('edit mode prefills fields from an existing agent', () => {
    render(
      <NewUserAgentModal existing={EXISTING} onClose={() => undefined} onSaved={() => undefined} />,
    );
    expect(
      (screen.getByTestId('ua-name-input') as HTMLInputElement).value,
    ).toBe('My Beverage Tracker');
    expect(
      (screen.getByTestId('ua-description-input') as HTMLTextAreaElement).value,
    ).toBe('For SKU coverage');
    expect((screen.getByTestId('ua-brand-input') as HTMLInputElement).value).toBe(
      'FreshSip',
    );
    expect(
      (screen.getByTestId('ua-base-brand_sentinel') as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('edit mode calls updateUserAgent (not createUserAgent)', async () => {
    updateUserAgent.mockResolvedValue(EXISTING);
    render(
      <NewUserAgentModal existing={EXISTING} onClose={() => undefined} onSaved={() => undefined} />,
    );
    fireEvent.change(screen.getByTestId('ua-description-input'), {
      target: { value: 'Updated description' },
    });
    fireEvent.click(screen.getByTestId('ua-submit'));
    await waitFor(() => expect(updateUserAgent).toHaveBeenCalledTimes(1));
    expect(updateUserAgent.mock.calls[0]![0]).toBe('ua-1');
    expect(createUserAgent).not.toHaveBeenCalled();
  });

  it('surfaces backend error messages', async () => {
    createUserAgent.mockRejectedValue(new Error('An agent named "X" already exists'));
    render(
      <NewUserAgentModal existing={null} onClose={() => undefined} onSaved={() => undefined} />,
    );
    fireEvent.change(screen.getByTestId('ua-name-input'), {
      target: { value: 'X' },
    });
    fireEvent.change(screen.getByTestId('ua-description-input'), {
      target: { value: 'X' },
    });
    fireEvent.click(screen.getByTestId('ua-submit'));
    await waitFor(() =>
      expect(screen.getByText(/already exists/i)).toBeTruthy(),
    );
  });
});
