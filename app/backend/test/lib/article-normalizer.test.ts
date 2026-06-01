/**
 * M7.4 — ArticleNormalizer unit tests.
 *
 * Pure-function tests, no DB / no IO. Covers the column-alias matching
 * (case-insensitive, first-match-wins), domain extraction edge cases, and
 * the `normalize()` happy/missing-field paths.
 */
import { describe, it, expect } from 'vitest';
import {
  COLUMN_ALIASES,
  detectDateColumn,
  detectSchema,
  extractDomain,
  normalize,
  parsePublishedDate,
  pickField,
} from '../../src/lib/article-normalizer.js';

describe('pickField', () => {
  it('finds aliased columns case-insensitively', () => {
    expect(pickField({ HEADLINE: 'Big news' }, 'title')).toBe('Big news');
    expect(pickField({ Headline: 'Big news' }, 'title')).toBe('Big news');
    expect(pickField({ subject: 'Big news' }, 'title')).toBe('Big news');
  });

  it('returns the first matching alias (order matters)', () => {
    // `title` wins over `headline` per COLUMN_ALIASES order.
    const row = { title: 'A', headline: 'B' };
    expect(pickField(row, 'title')).toBe('A');
  });

  it('returns null when no alias matches', () => {
    expect(pickField({ unrelated: 'x' }, 'title')).toBeNull();
  });

  it('returns null on null / undefined / whitespace values', () => {
    expect(pickField({ title: null }, 'title')).toBeNull();
    expect(pickField({ title: undefined }, 'title')).toBeNull();
    expect(pickField({ title: '   ' }, 'title')).toBeNull();
    expect(pickField({ title: '' }, 'title')).toBeNull();
  });

  it('coerces non-string scalar values to a trimmed string', () => {
    expect(pickField({ source: 42 }, 'source')).toBe('42');
    expect(pickField({ language: 'EN ' }, 'language')).toBe('EN');
  });

  it('exposes COLUMN_ALIASES for analyst onboarding', () => {
    expect(COLUMN_ALIASES.title).toContain('headline');
    expect(COLUMN_ALIASES.publishedDate).toContain('published_date');
  });
});

describe('extractDomain', () => {
  it('strips leading www.', () => {
    expect(extractDomain('https://www.nytimes.com/article')).toBe('nytimes.com');
    expect(extractDomain('http://www.bbc.co.uk/news')).toBe('bbc.co.uk');
  });

  it('handles bare hostnames (no scheme)', () => {
    expect(extractDomain('reuters.com')).toBe('reuters.com');
    expect(extractDomain('www.example.org')).toBe('example.org');
  });

  it('returns null on garbage / unparseable input', () => {
    expect(extractDomain(null)).toBeNull();
    expect(extractDomain('')).toBeNull();
    expect(extractDomain('   ')).toBeNull();
    expect(extractDomain('not a url')).toBeNull();
  });

  it('preserves uncommon TLDs and subdomains', () => {
    expect(extractDomain('https://blog.example.io/post')).toBe('blog.example.io');
  });
});

describe('parsePublishedDate', () => {
  it('parses ISO strings', () => {
    const d = parsePublishedDate('2025-01-15T12:00:00Z');
    expect(d).toBeInstanceOf(Date);
    expect(d?.toISOString()).toBe('2025-01-15T12:00:00.000Z');
  });

  it('returns null on null / empty / garbage', () => {
    expect(parsePublishedDate(null)).toBeNull();
    expect(parsePublishedDate('')).toBeNull();
    expect(parsePublishedDate('not-a-date')).toBeNull();
  });
});

describe('normalize', () => {
  it('happy-path with all columns mapped', () => {
    const row = {
      headline: 'AMX raises $50M',
      body: 'Full article body here.',
      summary: 'Series B round',
      publisher: 'TechCrunch',
      byline: 'J. Reporter',
      published_date: '2025-03-10T09:00:00Z',
      url: 'https://www.techcrunch.com/2025/03/10/amx',
      language: 'EN',
    };
    const out = normalize(row);
    expect(out.title).toBe('AMX raises $50M');
    expect(out.content).toBe('Full article body here.');
    expect(out.description).toBe('Series B round');
    expect(out.source).toBe('TechCrunch');
    expect(out.author).toBe('J. Reporter');
    expect(out.publishedDate?.toISOString()).toBe('2025-03-10T09:00:00.000Z');
    expect(out.url).toBe('https://www.techcrunch.com/2025/03/10/amx');
    expect(out.publisherDomain).toBe('techcrunch.com');
    expect(out.language).toBe('en');
    expect(out.rawData).toEqual(row);
  });

  it('defaults title to "(untitled)" when missing', () => {
    const out = normalize({ body: 'orphan content' });
    expect(out.title).toBe('(untitled)');
    expect(out.content).toBe('orphan content');
    expect(out.description).toBeNull();
    expect(out.source).toBeNull();
    expect(out.author).toBeNull();
    expect(out.publishedDate).toBeNull();
    expect(out.url).toBeNull();
    expect(out.publisherDomain).toBeNull();
    expect(out.language).toBe('en');
  });

  it('publisherDomain falls back to source when URL is missing', () => {
    const out = normalize({ title: 'X', publisher: 'Reuters' });
    expect(out.url).toBeNull();
    expect(out.publisherDomain).toBe('Reuters');
  });

  it('caps language to 10 chars and lowercases', () => {
    const out = normalize({ title: 'X', locale: 'en-US-EXTENDED-LONG' });
    expect(out.language.length).toBeLessThanOrEqual(10);
    expect(out.language).toBe(out.language.toLowerCase());
  });
});

describe('detectDateColumn', () => {
  it('finds known aliases (case-insensitive, alias order priority)', () => {
    expect(detectDateColumn(['id', 'Published_Date', 'title'])).toBe('Published_Date');
    expect(detectDateColumn(['Timestamp'])).toBe('Timestamp');
    expect(detectDateColumn(['pub_date'])).toBe('pub_date');
  });

  it('returns null when no date alias is present', () => {
    expect(detectDateColumn(['id', 'title', 'foo'])).toBeNull();
    expect(detectDateColumn([])).toBeNull();
  });
});

describe('detectSchema', () => {
  it('returns a schema entry per column from the first row', () => {
    const schema = detectSchema([
      { id: '1', title: 'A', count: 5 },
      { id: '2', title: 'B', count: 6 },
    ]);
    expect(schema).toEqual([
      { name: 'id', type: 'string', sample: '1' },
      { name: 'title', type: 'string', sample: 'A' },
      { name: 'count', type: 'number', sample: 5 },
    ]);
  });

  it('returns [] on empty input', () => {
    expect(detectSchema([])).toEqual([]);
  });

  it('marks null samples as type "unknown"', () => {
    const schema = detectSchema([{ foo: null }]);
    expect(schema).toEqual([{ name: 'foo', type: 'unknown', sample: null }]);
  });
});
