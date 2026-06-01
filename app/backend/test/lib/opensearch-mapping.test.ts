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

  // ───── M9.4.5: nested sources.domain + canonical author + country/reach ─────

  it('reads _source.sources.domain (nested) for publisherDomain', () => {
    const out = mapHitToArticle({
      _id: 'os-nested-1',
      _source: {
        title: 'AMX UAT hit',
        sources: { domain: 'thewestendjournal.ca', name: 'The West End Journal' },
        // Intentionally NO top-level publisher_domain — only the nested obj.
        url: 'https://example.com/different-host/article',
      },
    });
    expect(out.publisherDomain).toBe('thewestendjournal.ca');
  });

  it('falls back to extractDomain(url) when sources.domain absent', () => {
    const out = mapHitToArticle({
      _id: 'os-nested-2',
      _source: {
        title: 't',
        url: 'https://www.example.co.uk/path/article',
        // No `sources`, no flat publisher_domain.
      },
    });
    expect(out.publisherDomain).toBe('example.co.uk');
  });

  it('publisherDomain is null when both nested sources.domain and URL are missing', () => {
    const out = mapHitToArticle({
      _id: 'os-nested-3',
      _source: { title: 't' },
    });
    expect(out.publisherDomain).toBeNull();
  });

  it('prefers authors_byline (string) over matched_authors[].name', () => {
    const out = mapHitToArticle({
      _id: 'os-author-1',
      _source: {
        title: 't',
        authors_byline: 'Jane Doe',
        matched_authors: [{ id: 'a1', name: 'Wrong Person' }],
      },
    });
    expect(out.author).toBe('Jane Doe');
  });

  it('uses matched_authors[0].name when authors_byline missing/empty', () => {
    const empty = mapHitToArticle({
      _id: 'os-author-2',
      _source: {
        title: 't',
        authors_byline: '   ',
        matched_authors: [{ id: 'a1', name: 'Sue Smith' }],
      },
    });
    expect(empty.author).toBe('Sue Smith');

    const missing = mapHitToArticle({
      _id: 'os-author-3',
      _source: {
        title: 't',
        matched_authors: [{ id: 'a2', name: 'Bob Lin' }],
      },
    });
    expect(missing.author).toBe('Bob Lin');
  });

  it('author is null when both authors_byline and matched_authors are missing', () => {
    const out = mapHitToArticle({ _id: 'os-author-4', _source: { title: 't' } });
    expect(out.author).toBeNull();
  });

  it('extracts country from top-level _source.country', () => {
    const out = mapHitToArticle({
      _id: 'os-country-1',
      _source: { title: 't', country: 'IN' },
    });
    expect(out.country).toBe('IN');

    const alias = mapHitToArticle({
      _id: 'os-country-2',
      _source: { title: 't', country_code: 'US' },
    });
    expect(alias.country).toBe('US');
  });

  it('extracts numeric _source.reach as a number', () => {
    const out = mapHitToArticle({
      _id: 'os-reach-1',
      _source: { title: 't', reach: 12345.7 },
    });
    expect(out.reach).toBe(12345.7);

    const intReach = mapHitToArticle({
      _id: 'os-reach-2',
      _source: { title: 't', reach: 1000 },
    });
    expect(intReach.reach).toBe(1000);
  });

  it('reach is null when field missing or non-numeric', () => {
    const missing = mapHitToArticle({ _id: 'r1', _source: { title: 't' } });
    expect(missing.reach).toBeNull();

    const notANumber = mapHitToArticle({
      _id: 'r2',
      _source: { title: 't', reach: 'not a number' },
    });
    expect(notANumber.reach).toBeNull();

    const nan = mapHitToArticle({
      _id: 'r3',
      _source: { title: 't', reach: Number.NaN },
    });
    expect(nan.reach).toBeNull();

    const obj = mapHitToArticle({
      _id: 'r4',
      _source: { title: 't', reach: { value: 5 } },
    });
    expect(obj.reach).toBeNull();
  });

  it('populates the sources convenience object {domain, name} from nested _source.sources', () => {
    const out = mapHitToArticle({
      _id: 'os-srcobj-1',
      _source: {
        title: 't',
        sources: { domain: 'x.com', name: 'X (Twitter)' },
      },
    });
    expect(out.sources).toEqual({ domain: 'x.com', name: 'X (Twitter)' });
  });

  it('sources convenience object falls back to flat publisher_domain + source', () => {
    const out = mapHitToArticle({
      _id: 'os-srcobj-2',
      _source: {
        title: 't',
        publisher_domain: 'fallback.com',
        source: 'Fallback Times',
      },
    });
    expect(out.sources).toEqual({ domain: 'fallback.com', name: 'Fallback Times' });
  });

  it('sources convenience object is null when no domain or name info available', () => {
    const out = mapHitToArticle({ _id: 'os-srcobj-3', _source: { title: 't' } });
    expect(out.sources).toBeNull();
  });
});
