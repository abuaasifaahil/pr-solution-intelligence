/**
 * M9.1 — OpenSearch hit-to-Article mapping tests.
 *
 * Pure-function suite. Exercises alias resolution, null/empty handling,
 * URL → domain fallback, language clamping, and `_source` preservation.
 */
import { describe, it, expect } from 'vitest';
import { mapHitToArticle } from '../../src/lib/opensearch-mapping.js';

describe('mapHitToArticle', () => {
  it('happy path — _source with all fields filled', () => {
    const hit = {
      _id: 'os-1',
      _source: {
        title: 'FreshSip launches in India',
        content: 'Body of the article ...',
        description: 'A short summary',
        source: 'TechCrunch',
        author: 'Jane Doe',
        published_date: '2026-04-15T08:00:00Z',
        url: 'https://techcrunch.com/2026/04/15/freshsip',
        publisher_domain: 'techcrunch.com',
        language: 'EN',
      },
    };
    const out = mapHitToArticle(hit);
    expect(out.title).toBe('FreshSip launches in India');
    expect(out.content).toBe('Body of the article ...');
    expect(out.description).toBe('A short summary');
    expect(out.source).toBe('TechCrunch');
    expect(out.author).toBe('Jane Doe');
    expect(out.publishedDate).toBeInstanceOf(Date);
    expect(out.publishedDate!.toISOString()).toBe('2026-04-15T08:00:00.000Z');
    expect(out.url).toBe('https://techcrunch.com/2026/04/15/freshsip');
    expect(out.publisherDomain).toBe('techcrunch.com');
    expect(out.language).toBe('en');
    expect(out.openSearchId).toBe('os-1');
  });

  it('alias handling — headline → title, body → content', () => {
    const out = mapHitToArticle({
      _id: 'os-2',
      _source: {
        headline: 'Aliased title',
        body: 'Aliased content',
        snippet: 'Aliased description',
      },
    });
    expect(out.title).toBe('Aliased title');
    expect(out.content).toBe('Aliased content');
    expect(out.description).toBe('Aliased description');
  });

  it('case-insensitive alias lookup', () => {
    const out = mapHitToArticle({
      _id: 'os-3',
      _source: { HEADLINE: 'Upper', BODY: 'Upper body' },
    });
    expect(out.title).toBe('Upper');
    expect(out.content).toBe('Upper body');
  });

  it('missing fields → null', () => {
    const out = mapHitToArticle({ _id: 'os-4', _source: { title: 'Only title' } });
    expect(out.content).toBeNull();
    expect(out.description).toBeNull();
    expect(out.source).toBeNull();
    expect(out.author).toBeNull();
    expect(out.publishedDate).toBeNull();
    expect(out.url).toBeNull();
    expect(out.publisherDomain).toBeNull();
  });

  it('empty-string fields → null', () => {
    const out = mapHitToArticle({
      _id: 'os-5',
      _source: { title: 'Real', content: '   ', description: '' },
    });
    expect(out.content).toBeNull();
    expect(out.description).toBeNull();
  });

  it('title fallback to "(untitled)" when no alias matches', () => {
    const out = mapHitToArticle({ _id: 'os-6', _source: { content: 'Body only' } });
    expect(out.title).toBe('(untitled)');
  });

  it('publisherDomain extracted from URL when not in _source', () => {
    const out = mapHitToArticle({
      _id: 'os-7',
      _source: {
        title: 't',
        url: 'https://www.example.com/path/article',
      },
    });
    expect(out.publisherDomain).toBe('example.com'); // www. stripped
  });

  it('publisherDomain null when URL is malformed and not in _source', () => {
    const out = mapHitToArticle({
      _id: 'os-8',
      _source: { title: 't', url: '   not a url   ' },
    });
    // The trim()'d "not a url" is non-empty, so it becomes the URL field; the
    // URL parser will accept "https://not a url" (whitespace) as invalid →
    // domain null. Either way, the test asserts no exception is thrown and
    // the value is null.
    expect(out.publisherDomain).toBeNull();
  });

  it('language is lowercased + clamped to 10 chars', () => {
    const out = mapHitToArticle({
      _id: 'os-9',
      _source: { title: 't', language: 'EN-US-extra-long-tag' },
    });
    expect(out.language).toBe('en-us-extr'); // 10 chars, lower
    expect(out.language.length).toBe(10);
  });

  it('language defaults to "en" when missing', () => {
    const out = mapHitToArticle({ _id: 'os-10', _source: { title: 't' } });
    expect(out.language).toBe('en');
  });

  it('rawData carries the full _source for downstream debugging', () => {
    const src = { title: 't', mystery_field: 'preserve me', n: 42 };
    const out = mapHitToArticle({ _id: 'os-11', _source: src });
    expect(out.rawData).toBe(src);
  });

  it('openSearchId from hit._id', () => {
    const out = mapHitToArticle({ _id: 'unique-hit-id', _source: { title: 't' } });
    expect(out.openSearchId).toBe('unique-hit-id');
  });

  it('publishedDate parses various formats', () => {
    const a = mapHitToArticle({
      _id: 'd1',
      _source: { title: 't', date: '2026-04-15' },
    });
    expect(a.publishedDate!.getUTCFullYear()).toBe(2026);

    const b = mapHitToArticle({
      _id: 'd2',
      _source: { title: 't', publishedAt: '2026-04-15T10:00:00.000Z' },
    });
    expect(b.publishedDate!.getUTCHours()).toBe(10);

    const c = mapHitToArticle({
      _id: 'd3',
      _source: { title: 't', published_date: 'not a date' },
    });
    expect(c.publishedDate).toBeNull();
  });
});
