import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { ChipUpExpanded } from '../../components/chat/ChipUpExpanded';
import type { DashboardJson } from '../../lib/enrichment';

afterEach(() => cleanup());

function makeArticle(i: number): DashboardJson['articles'][number] {
  return {
    id: `a${i}`,
    title: `Article ${i}`,
    content: null,
    description: null,
    url: null,
    publisherDomain: 'example.com',
    source: 'Example',
    author: null,
    publishedDate: '2026-05-01T00:00:00Z',
    language: 'en',
    mediaType: 'web',
    location: null,
    thumbnailUrl: null,
    socialEngagement: null,
    enrichment: {
      sentiment: { label: 'neutral', score: 0 },
      themes: [],
      entities: [],
      signals: [],
    },
  };
}

function makeData(articleCount: number): DashboardJson {
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
    articles: Array.from({ length: articleCount }, (_, i) => makeArticle(i + 1)),
    stats: {
      totalArticles: articleCount,
      enrichedCount: articleCount,
      sentimentDistribution: { positive: 0, neutral: articleCount, negative: 0 },
    },
  };
}

describe('ChipUpExpanded', () => {
  it('renders both tabs with role=tab', () => {
    render(
      <ChipUpExpanded
        chatId="c1"
        artifactId="art-123"
        data={makeData(3)}
        error={null}
        onCollapse={() => {}}
        onFullscreen={() => {}}
      />,
    );
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.textContent).toContain('Preview');
    expect(tabs[1]?.textContent).toContain('JSON Code');
    // Preview is selected by default.
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false');
  });

  it('switches tabs and swaps content', () => {
    render(
      <ChipUpExpanded
        chatId="c1"
        artifactId="art-123"
        data={makeData(2)}
        error={null}
        onCollapse={() => {}}
        onFullscreen={() => {}}
      />,
    );
    // Preview shows article cards.
    expect(screen.getAllByTestId('article-enrichment-card')).toHaveLength(2);
    expect(screen.queryByTestId('json-code-view')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /JSON Code/ }));
    expect(screen.queryAllByTestId('article-enrichment-card')).toHaveLength(0);
    expect(screen.getByTestId('json-code-view')).toBeTruthy();
  });

  it('shows the "Showing first 20" notice when articles > 20', () => {
    render(
      <ChipUpExpanded
        chatId="c1"
        artifactId="art-123"
        data={makeData(25)}
        error={null}
        onCollapse={() => {}}
        onFullscreen={() => {}}
      />,
    );
    // Only the first 20 cards render.
    expect(screen.getAllByTestId('article-enrichment-card')).toHaveLength(20);
    expect(screen.getByText(/Showing first 20 of 25 articles/)).toBeTruthy();
  });

  it('shows loading state when data is null and no error', () => {
    render(
      <ChipUpExpanded
        chatId="c1"
        artifactId="art-123"
        data={null}
        error={null}
        onCollapse={() => {}}
        onFullscreen={() => {}}
      />,
    );
    expect(screen.getByText(/Loading/)).toBeTruthy();
  });

  it('shows error state when error is set', () => {
    render(
      <ChipUpExpanded
        chatId="c1"
        artifactId="art-123"
        data={null}
        error="boom"
        onCollapse={() => {}}
        onFullscreen={() => {}}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('boom');
  });
});
