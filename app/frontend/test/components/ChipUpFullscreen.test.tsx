import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import type { DashboardJson } from '../../lib/enrichment';

// ── Stub out the clipboard helper so we can assert the share path ─────
const copyToClipboard = vi.fn<[string], Promise<boolean>>(async () => true);
vi.mock('../../lib/clipboard', () => ({ copyToClipboard }));

const { ChipUpFullscreen } = await import(
  '../../components/chat/ChipUpFullscreen'
);

afterEach(() => cleanup());

beforeEach(() => {
  copyToClipboard.mockClear();
  copyToClipboard.mockResolvedValue(true);
});

function makeData(): DashboardJson {
  return {
    chatId: 'c1',
    jobId: 'j1',
    generatedAt: '2026-06-01T00:00:00Z',
    analysisContext: {
      brand: 'Acme',
      competitors: [],
      dateRange: null,
      enrichmentType: 'standard',
      modelUsed: 'gpt-4o-mini',
    },
    articles: [
      {
        id: 'a1',
        title: 'A1',
        content: null,
        description: null,
        url: null,
        publisherDomain: null,
        source: null,
        author: null,
        publishedDate: null,
        language: 'en',
        mediaType: 'web',
        location: null,
        thumbnailUrl: null,
        socialEngagement: null,
        enrichment: null,
      },
    ],
    stats: {
      totalArticles: 1,
      enrichedCount: 1,
      sentimentDistribution: { positive: 0, neutral: 1, negative: 0 },
    },
  };
}

describe('ChipUpFullscreen', () => {
  it('triggers onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(
      <ChipUpFullscreen
        chatId="c1"
        artifactId="art-12345678"
        data={makeData()}
        error={null}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('triggers onClose on backdrop click but not inner click', () => {
    const onClose = vi.fn();
    render(
      <ChipUpFullscreen
        chatId="c1"
        artifactId="art-12345678"
        data={makeData()}
        error={null}
        onClose={onClose}
      />,
    );
    const backdrop = screen.getByTestId('chip-up-fullscreen');
    // Click on the inner card (an article card) — must not close.
    fireEvent.click(screen.getByTestId('article-enrichment-card'));
    expect(onClose).not.toHaveBeenCalled();
    // Click on the backdrop itself — closes.
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Download button creates a Blob URL and triggers a click', () => {
    const createObjectURL = vi.fn<[Blob | MediaSource], string>(() => 'blob:mock-url');
    const revokeObjectURL = vi.fn<[string], void>();
    // jsdom does not implement these by default.
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    Object.defineProperty(URL, 'createObjectURL', {
      writable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      writable: true,
      value: revokeObjectURL,
    });

    render(
      <ChipUpFullscreen
        chatId="c1"
        artifactId="art-12345678"
        data={makeData()}
        error={null}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('chip-up-download-btn'));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);

    Object.defineProperty(URL, 'createObjectURL', {
      writable: true,
      value: originalCreate,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      writable: true,
      value: originalRevoke,
    });
  });

  it('Share button copies a URL and shows the "Copied" affordance', async () => {
    render(
      <ChipUpFullscreen
        chatId="c1"
        artifactId="art-12345678"
        data={makeData()}
        error={null}
        onClose={() => {}}
      />,
    );
    const shareBtn = screen.getByTestId('chip-up-share-btn');
    expect(shareBtn.textContent).toContain('Share link');
    fireEvent.click(shareBtn);
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledTimes(1));
    const url = copyToClipboard.mock.calls[0]?.[0] as string;
    expect(url).toContain('/chat/c1#artifact=art-12345678');
    await waitFor(() =>
      expect(screen.getByTestId('chip-up-share-btn').textContent).toContain(
        'Copied',
      ),
    );
  });

  it('Email button assigns location.href to a mailto URL', () => {
    const originalHref = window.location.href;
    // jsdom's `location` is a getter — re-define it for the test.
    const setHref = vi.fn<[string], void>();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: {
        ...window.location,
        origin: 'http://localhost',
        set href(v: string) {
          setHref(v);
        },
        get href() {
          return originalHref;
        },
      },
    });
    render(
      <ChipUpFullscreen
        chatId="c1"
        artifactId="art-12345678"
        data={makeData()}
        error={null}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('chip-up-email-btn'));
    expect(setHref).toHaveBeenCalledTimes(1);
    expect(setHref.mock.calls[0]?.[0]).toMatch(/^mailto:\?subject=/);
  });

  it('disables footer actions when data is null', () => {
    render(
      <ChipUpFullscreen
        chatId="c1"
        artifactId="art-12345678"
        data={null}
        error={null}
        onClose={() => {}}
      />,
    );
    expect(
      (screen.getByTestId('chip-up-download-btn') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId('chip-up-share-btn') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId('chip-up-email-btn') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
