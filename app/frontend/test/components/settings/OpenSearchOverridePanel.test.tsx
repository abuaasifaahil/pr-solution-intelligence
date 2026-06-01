import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  cleanup,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import type { DataSource } from '../../../lib/settings';
import type { OpenSearchProbeResult } from '../../../lib/opensearch-probe';

/**
 * M9.9 — OpenSearchOverridePanel.
 *
 * @file test/components/settings/OpenSearchOverridePanel.test.tsx
 */

const getOpenSearchOverride = vi.fn<[], Promise<DataSource | null>>();
const saveOpenSearchOverride = vi.fn();
const deleteOpenSearchOverride = vi.fn();
const probeOpenSearchConnection = vi.fn<
  [unknown],
  Promise<OpenSearchProbeResult>
>();

vi.mock('../../../lib/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/settings')>();
  return {
    ...actual,
    getOpenSearchOverride,
    saveOpenSearchOverride,
    deleteOpenSearchOverride,
  };
});
vi.mock('../../../lib/opensearch-probe', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../lib/opensearch-probe')
  >();
  return { ...actual, probeOpenSearchConnection };
});

const { OpenSearchOverridePanel } = await import(
  '../../../components/settings/OpenSearchOverridePanel'
);

const OVERRIDE_ROW: DataSource = {
  id: 'ds-1',
  userId: 'u1',
  sourceType: 'custom',
  displayName: 'OpenSearch override',
  apiKeyEncrypted: '***encrypted***',
  endpointUrl: 'https://os.example.com',
  config: {
    kind: 'opensearch',
    username: 'admin-uat',
    indexName: 'amx-data*',
    indexType: 'daywise',
  },
  isActive: true,
  lastTestedAt: null,
  createdAt: '2026-06-01T00:00:00Z',
};

// jsdom needs window.confirm stubbed because the panel uses it on Use-org-default.
const confirmStub = vi.fn(() => true);
beforeEach(() => {
  getOpenSearchOverride.mockReset();
  saveOpenSearchOverride.mockReset();
  deleteOpenSearchOverride.mockReset();
  probeOpenSearchConnection.mockReset();
  confirmStub.mockReset();
  confirmStub.mockReturnValue(true);
  vi.stubGlobal('confirm', confirmStub);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('OpenSearchOverridePanel', () => {
  it('shows org-default badge when no override exists', async () => {
    getOpenSearchOverride.mockResolvedValue(null);
    render(<OpenSearchOverridePanel />);
    await waitFor(() =>
      expect(screen.getByTestId('opensearch-status-org-default')).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: /Configure my own/i })).toBeTruthy();
  });

  it('shows override badge when an override exists', async () => {
    getOpenSearchOverride.mockResolvedValue(OVERRIDE_ROW);
    render(<OpenSearchOverridePanel />);
    await waitFor(() =>
      expect(screen.getByTestId('opensearch-status-override')).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: /Edit override/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Use org default/i })).toBeTruthy();
  });

  it('opens the editor and pre-fills override values', async () => {
    getOpenSearchOverride.mockResolvedValue(OVERRIDE_ROW);
    render(<OpenSearchOverridePanel />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Edit override/i })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Edit override/i }));
    expect((screen.getByTestId('os-url-input') as HTMLInputElement).value).toBe(
      'https://os.example.com',
    );
    expect(
      (screen.getByTestId('os-username-input') as HTMLInputElement).value,
    ).toBe('admin-uat');
    expect(
      (screen.getByTestId('os-index-name-input') as HTMLInputElement).value,
    ).toBe('amx-data*');
    expect(
      (screen.getByTestId('os-index-type-daywise') as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('blocks Test connection when url/username/password are empty', async () => {
    getOpenSearchOverride.mockResolvedValue(null);
    render(<OpenSearchOverridePanel />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Configure my own/i })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Configure my own/i }));
    fireEvent.click(screen.getByTestId('os-test-button'));
    await waitFor(() =>
      expect(
        screen.getByText(/URL, username, and password are required to test/i),
      ).toBeTruthy(),
    );
    expect(probeOpenSearchConnection).not.toHaveBeenCalled();
  });

  it('renders successful probe result with cluster metadata', async () => {
    getOpenSearchOverride.mockResolvedValue(null);
    probeOpenSearchConnection.mockResolvedValue({
      ok: true,
      latencyMs: 42,
      clusterStatus: 'yellow',
      clusterName: 'amx-opensearch-uat',
      numberOfNodes: 1,
    });
    render(<OpenSearchOverridePanel />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Configure my own/i })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Configure my own/i }));

    fireEvent.change(screen.getByTestId('os-url-input'), {
      target: { value: 'https://os.example.com' },
    });
    fireEvent.change(screen.getByTestId('os-username-input'), {
      target: { value: 'admin-uat' },
    });
    fireEvent.change(screen.getByTestId('os-password-input'), {
      target: { value: 'secret' },
    });

    fireEvent.click(screen.getByTestId('os-test-button'));
    await waitFor(() => expect(probeOpenSearchConnection).toHaveBeenCalled());
    const arg = probeOpenSearchConnection.mock.calls[0]![0] as {
      url: string; username: string; password: string;
    };
    expect(arg.url).toBe('https://os.example.com');
    expect(arg.username).toBe('admin-uat');
    expect(arg.password).toBe('secret');

    await waitFor(() => expect(screen.getByTestId('os-test-result')).toBeTruthy());
    expect(screen.getByTestId('os-test-result').textContent).toMatch(
      /Connected.*42 ms.*yellow.*amx-opensearch-uat.*1 node/,
    );
  });

  it('Save calls saveOpenSearchOverride with the form values', async () => {
    getOpenSearchOverride.mockResolvedValue(null);
    saveOpenSearchOverride.mockResolvedValue(OVERRIDE_ROW);
    render(<OpenSearchOverridePanel />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Configure my own/i })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Configure my own/i }));

    fireEvent.change(screen.getByTestId('os-url-input'), {
      target: { value: 'https://os.example.com' },
    });
    fireEvent.change(screen.getByTestId('os-username-input'), {
      target: { value: 'admin' },
    });
    fireEvent.change(screen.getByTestId('os-password-input'), {
      target: { value: 'pw' },
    });
    fireEvent.click(screen.getByTestId('os-index-type-monthwise'));

    // The post-save reload returns the now-existing row.
    getOpenSearchOverride.mockResolvedValueOnce(OVERRIDE_ROW);

    fireEvent.click(screen.getByTestId('os-save-button'));
    await waitFor(() => expect(saveOpenSearchOverride).toHaveBeenCalled());
    const arg = saveOpenSearchOverride.mock.calls[0]![0] as {
      url: string; username: string; password: string; indexType: string;
    };
    expect(arg.url).toBe('https://os.example.com');
    expect(arg.username).toBe('admin');
    expect(arg.password).toBe('pw');
    expect(arg.indexType).toBe('monthwise');
  });

  it('Use org default deletes the override after confirmation', async () => {
    getOpenSearchOverride.mockResolvedValue(OVERRIDE_ROW);
    deleteOpenSearchOverride.mockResolvedValue(true);
    render(<OpenSearchOverridePanel />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Use org default/i })).toBeTruthy(),
    );
    // The reload after delete returns null (override gone).
    getOpenSearchOverride.mockResolvedValueOnce(null);

    fireEvent.click(screen.getByRole('button', { name: /Use org default/i }));
    await waitFor(() => expect(deleteOpenSearchOverride).toHaveBeenCalled());
    expect(confirmStub).toHaveBeenCalled();
  });

  it('Use org default no-ops when user cancels the confirm', async () => {
    getOpenSearchOverride.mockResolvedValue(OVERRIDE_ROW);
    confirmStub.mockReturnValue(false);
    render(<OpenSearchOverridePanel />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Use org default/i })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Use org default/i }));
    expect(deleteOpenSearchOverride).not.toHaveBeenCalled();
  });

  it('surfaces probe failure messages', async () => {
    getOpenSearchOverride.mockResolvedValue(null);
    probeOpenSearchConnection.mockResolvedValue({
      ok: false,
      latencyMs: 0,
      error: 'getaddrinfo ENOTFOUND',
    });
    render(<OpenSearchOverridePanel />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Configure my own/i })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Configure my own/i }));

    fireEvent.change(screen.getByTestId('os-url-input'), {
      target: { value: 'https://nowhere.example' },
    });
    fireEvent.change(screen.getByTestId('os-username-input'), {
      target: { value: 'u' },
    });
    fireEvent.change(screen.getByTestId('os-password-input'), {
      target: { value: 'p' },
    });

    fireEvent.click(screen.getByTestId('os-test-button'));
    await waitFor(() =>
      expect(screen.getByTestId('os-test-result').textContent).toMatch(
        /Failed.*ENOTFOUND/,
      ),
    );
  });
});
