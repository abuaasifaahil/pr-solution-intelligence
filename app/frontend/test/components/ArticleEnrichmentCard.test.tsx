import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { ArticleEnrichmentCard } from '../../components/chat/ArticleEnrichmentCard';

afterEach(() => cleanup());

function makeArticle(overrides: Partial<{
  id: string;
  title: string;
  source: string | null;
  author: string | null;
  publishedDate: string | null;
  publisherDomain: string | null;
  thumbnailUrl: string | null;
  enrichment: unknown;
}> = {}): {
  id: string;
  title: string;
  source: string | null;
  author: string | null;
  publishedDate: string | null;
  publisherDomain: string | null;
  thumbnailUrl: string | null;
  enrichment: unknown;
} {
  return {
    id: 'a1',
    title: 'Acme launches new product',
    source: 'TechCrunch',
    author: 'Jane Doe',
    publishedDate: '2026-05-01T08:30:00Z',
    publisherDomain: 'techcrunch.com',
    thumbnailUrl: null,
    enrichment: {
      sentiment: { label: 'positive', score: 0.82 },
      themes: [
        { level: 'main', name: 'Product Launch' },
        { level: 'secondary', name: 'AI' },
      ],
      entities: [
        { name: 'Acme', type: 'Brand' },
        { name: 'Jane Doe', type: 'Person' },
      ],
      signals: [{ type: 'launch', description: 'New product' }],
      reach: { monthly_visitors: 12_500_000, score: 88 },
    },
    ...overrides,
  };
}

describe('ArticleEnrichmentCard', () => {
  it('renders title, source, author, and published date', () => {
    render(<ArticleEnrichmentCard article={makeArticle()} />);
    expect(screen.getByText('Acme launches new product')).toBeTruthy();
    // Header meta merges into one line.
    expect(
      screen.getByText(/TechCrunch · Jane Doe · 2026-05-01 · techcrunch.com/),
    ).toBeTruthy();
  });

  it('shows sentiment pill with correct class for positive', () => {
    render(<ArticleEnrichmentCard article={makeArticle()} />);
    const pill = screen.getByTestId('sentiment-pill');
    expect(pill.textContent).toBe('positive');
    expect(pill.className).toContain('bg-status-success-bg');
  });

  it('shows sentiment pill with correct class for negative', () => {
    render(
      <ArticleEnrichmentCard
        article={makeArticle({
          enrichment: { sentiment: { label: 'negative', score: -0.5 } },
        })}
      />,
    );
    const pill = screen.getByTestId('sentiment-pill');
    expect(pill.className).toContain('bg-status-error-bg');
  });

  it('lists multiple themes', () => {
    render(<ArticleEnrichmentCard article={makeArticle()} />);
    const themes = screen.getByTestId('themes-row');
    expect(themes.textContent).toContain('Product Launch');
    expect(themes.textContent).toContain('AI');
    expect(themes.textContent).toContain('main');
    expect(themes.textContent).toContain('secondary');
  });

  it('renders entities as chips', () => {
    render(<ArticleEnrichmentCard article={makeArticle()} />);
    const entities = screen.getByTestId('entities-row');
    expect(entities.textContent).toContain('Acme');
    expect(entities.textContent).toContain('(Brand)');
    expect(entities.textContent).toContain('Jane Doe');
    expect(entities.textContent).toContain('(Person)');
  });

  it('renders a signal chip with the bolt glyph', () => {
    render(<ArticleEnrichmentCard article={makeArticle()} />);
    const chip = screen.getByTestId('signal-chip');
    expect(chip.textContent).toContain('⚡');
    expect(chip.textContent).toContain('launch');
  });

  it('renders the reach row with monthly visitors and score', () => {
    render(<ArticleEnrichmentCard article={makeArticle()} />);
    const reach = screen.getByTestId('reach-row');
    expect(reach.textContent).toContain('12,500,000');
    expect(reach.textContent).toContain('score 88');
  });

  it('renders without crashing when enrichment is null', () => {
    render(
      <ArticleEnrichmentCard article={makeArticle({ enrichment: null })} />,
    );
    expect(screen.getByText('Acme launches new product')).toBeTruthy();
    expect(screen.queryByTestId('sentiment-pill')).toBeNull();
    expect(screen.queryByTestId('themes-row')).toBeNull();
    expect(screen.queryByTestId('entities-row')).toBeNull();
    expect(screen.queryByTestId('signal-chip')).toBeNull();
    expect(screen.queryByTestId('reach-row')).toBeNull();
  });

  it('renders a thumbnail image when provided', () => {
    const { container } = render(
      <ArticleEnrichmentCard
        article={makeArticle({ thumbnailUrl: 'https://cdn.example/x.jpg' })}
      />,
    );
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe('https://cdn.example/x.jpg');
  });
});
