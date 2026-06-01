import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  render,
  cleanup,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import type { DashboardJson, DashboardJsonEnvelope } from '../../lib/enrichment';

const getEnrichJson = vi.fn<[string], Promise<DashboardJsonEnvelope>>();
vi.mock('../../lib/enrichment', async () => {
  return {
    getEnrichJson,
  };
});

const { ChipUpArtifact } = await import(
  '../../components/chat/ChipUpArtifact'
);

afterEach(() => cleanup());

beforeEach(() => {
  getEnrichJson.mockReset();
});

function makeDashboard(): DashboardJson {
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

describe('ChipUpArtifact', () => {
  it('renders a collapsed chip with the article count', () => {
    render(
      <ChipUpArtifact
        chatId="c1"
        artifactId="art-12345678"
        articleCount={1234}
      />,
    );
    const chip = screen.getByTestId('chip-up-artifact');
    expect(chip.textContent).toContain('Enriched dataset');
    expect(chip.textContent).toContain('1,234');
  });

  it('clicks chip → expanded; calls getEnrichJson once on first expand', async () => {
    getEnrichJson.mockResolvedValue({ dashboard: makeDashboard(), cached: false });
    render(
      <ChipUpArtifact
        chatId="c1"
        artifactId="art-12345678"
        articleCount={1}
      />,
    );
    fireEvent.click(screen.getByTestId('chip-up-artifact'));
    expect(screen.getByTestId('chip-up-expanded')).toBeTruthy();
    await waitFor(() => expect(getEnrichJson).toHaveBeenCalledWith('c1'));
    expect(getEnrichJson).toHaveBeenCalledTimes(1);
  });

  it('clicks × in expanded → back to collapsed', async () => {
    getEnrichJson.mockResolvedValue({ dashboard: makeDashboard(), cached: false });
    render(
      <ChipUpArtifact
        chatId="c1"
        artifactId="art-12345678"
        articleCount={1}
      />,
    );
    fireEvent.click(screen.getByTestId('chip-up-artifact'));
    expect(screen.getByTestId('chip-up-expanded')).toBeTruthy();
    fireEvent.click(screen.getByTestId('chip-up-collapse-btn'));
    expect(screen.getByTestId('chip-up-artifact')).toBeTruthy();
    expect(screen.queryByTestId('chip-up-expanded')).toBeNull();
  });

  it('clicks ⤢ in expanded → fullscreen', async () => {
    getEnrichJson.mockResolvedValue({ dashboard: makeDashboard(), cached: false });
    render(
      <ChipUpArtifact
        chatId="c1"
        artifactId="art-12345678"
        articleCount={1}
      />,
    );
    fireEvent.click(screen.getByTestId('chip-up-artifact'));
    fireEvent.click(screen.getByTestId('chip-up-fullscreen-btn'));
    expect(screen.getByTestId('chip-up-fullscreen')).toBeTruthy();
  });

  it('lazy-loads dashboard JSON only once even across re-expansions', async () => {
    getEnrichJson.mockResolvedValue({ dashboard: makeDashboard(), cached: false });
    render(
      <ChipUpArtifact
        chatId="c1"
        artifactId="art-12345678"
        articleCount={1}
      />,
    );
    // Expand → collapse → expand again should still only fetch once.
    fireEvent.click(screen.getByTestId('chip-up-artifact'));
    await waitFor(() => expect(getEnrichJson).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('chip-up-collapse-btn'));
    fireEvent.click(screen.getByTestId('chip-up-artifact'));
    // Give the effect a tick — but no new request should fire.
    await Promise.resolve();
    expect(getEnrichJson).toHaveBeenCalledTimes(1);
  });

  it('surfaces an error when getEnrichJson rejects', async () => {
    getEnrichJson.mockRejectedValue(new Error('network down'));
    render(
      <ChipUpArtifact
        chatId="c1"
        artifactId="art-12345678"
        articleCount={1}
      />,
    );
    fireEvent.click(screen.getByTestId('chip-up-artifact'));
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain('network down');
    });
  });

  it('mounts already-expanded when window.location.hash matches artifactId (M8.10 deep-link)', async () => {
    // Simulate landing on a share link: …/chat/<id>#artifact=<artifactId>
    const originalHash = window.location.hash;
    window.location.hash = '#artifact=test-artifact-id';
    try {
      getEnrichJson.mockResolvedValue({ dashboard: makeDashboard(), cached: false });
      render(
        <ChipUpArtifact
          chatId="c1"
          artifactId="test-artifact-id"
          articleCount={1}
        />,
      );
      // Should NOT be collapsed; the expanded view is mounted directly.
      expect(screen.queryByTestId('chip-up-artifact')).toBeNull();
      expect(screen.getByTestId('chip-up-expanded')).toBeTruthy();
      // And the lazy load fires immediately on mount.
      await waitFor(() => expect(getEnrichJson).toHaveBeenCalledWith('c1'));
    } finally {
      window.location.hash = originalHash;
    }
  });
});
