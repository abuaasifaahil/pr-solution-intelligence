/**
 * M9.2 — field-aliases invariants.
 *
 * Pure-data tests. Confirms the single source of truth covers every
 * canonical field, that callers can rely on the case convention, and
 * that the M9.1.1/M9.1.2-flagged aliases (`pubDate`, `summary`, `snippet`)
 * remain present.
 */
import { describe, it, expect } from 'vitest';
import { FIELD_ALIASES, type NormalizedFieldKey } from '../../src/lib/field-aliases.js';

const CANONICAL_KEYS: NormalizedFieldKey[] = [
  'title',
  'content',
  'description',
  'source',
  'author',
  'publishedDate',
  'url',
  'publisherDomain',
  'language',
  'country',
];

describe('FIELD_ALIASES', () => {
  it('contains all 10 canonical keys', () => {
    for (const key of CANONICAL_KEYS) {
      expect(FIELD_ALIASES).toHaveProperty(key);
    }
    expect(Object.keys(FIELD_ALIASES).sort()).toEqual([...CANONICAL_KEYS].sort());
    expect(CANONICAL_KEYS.length).toBe(10);
  });

  it('every alias array contains at least one entry', () => {
    for (const key of CANONICAL_KEYS) {
      expect(FIELD_ALIASES[key].length).toBeGreaterThan(0);
    }
  });

  it('the canonical key itself is the first alias for each field', () => {
    // Convention: callers expect `pickField(row, key)` to prefer an
    // exact-name column when present, ahead of any aliases.
    expect(FIELD_ALIASES.title[0]).toBe('title');
    expect(FIELD_ALIASES.content[0]).toBe('content');
    expect(FIELD_ALIASES.description[0]).toBe('description');
    expect(FIELD_ALIASES.source[0]).toBe('source');
    expect(FIELD_ALIASES.author[0]).toBe('author');
    expect(FIELD_ALIASES.url[0]).toBe('url');
    expect(FIELD_ALIASES.language[0]).toBe('language');
  });

  it('publishedDate includes both `published_date` (CSV) and `pubDate` (AMX UAT cluster)', () => {
    // M9.1.1 confirmed `pubDate` is what the AMX UAT cluster ships; the
    // DSL builder uses that exact key, so the mapper MUST normalize it.
    expect(FIELD_ALIASES.publishedDate).toContain('published_date');
    expect(FIELD_ALIASES.publishedDate).toContain('pubDate');
  });

  it('description aliases include `summary` and `snippet`', () => {
    // M7.4 contract: search-index excerpts arrive as `summary`/`snippet`.
    expect(FIELD_ALIASES.description).toContain('summary');
    expect(FIELD_ALIASES.description).toContain('snippet');
  });

  it('title aliases include `headline` and `subject`', () => {
    expect(FIELD_ALIASES.title).toContain('headline');
    expect(FIELD_ALIASES.title).toContain('subject');
  });

  it('content aliases include the common `body`, `text`, `article` variants', () => {
    expect(FIELD_ALIASES.content).toContain('body');
    expect(FIELD_ALIASES.content).toContain('text');
    expect(FIELD_ALIASES.content).toContain('article');
  });

  it('publisherDomain aliases include `domain` and `host`', () => {
    expect(FIELD_ALIASES.publisherDomain).toContain('publisher_domain');
    expect(FIELD_ALIASES.publisherDomain).toContain('domain');
    expect(FIELD_ALIASES.publisherDomain).toContain('host');
  });

  it('aliases are lowercase except for documented camelCase variants', () => {
    // Lookups are case-insensitive at the caller, but the canonical map
    // should stay readable. We intentionally allow `publishedAt` and
    // `pubDate` (camelCase) because that's how the upstream sources ship
    // them; everything else stays lowercase / snake_case.
    const CAMEL_CASE_ALLOW = new Set(['publishedAt', 'pubDate']);
    for (const key of CANONICAL_KEYS) {
      for (const alias of FIELD_ALIASES[key]) {
        if (CAMEL_CASE_ALLOW.has(alias)) continue;
        expect(alias).toBe(alias.toLowerCase());
      }
    }
  });

  it('aliases within a field are unique (no duplicates)', () => {
    for (const key of CANONICAL_KEYS) {
      const lowered = FIELD_ALIASES[key].map((a) => a.toLowerCase());
      const unique = new Set(lowered);
      expect(unique.size).toBe(lowered.length);
    }
  });

  // ───── M9.4.5: country added ─────

  it('country key has 4 aliases including `country_code`', () => {
    expect(FIELD_ALIASES.country).toBeDefined();
    expect(FIELD_ALIASES.country.length).toBe(4);
    expect(FIELD_ALIASES.country).toContain('country');
    expect(FIELD_ALIASES.country).toContain('country_code');
    expect(FIELD_ALIASES.country).toContain('iso_country');
    expect(FIELD_ALIASES.country).toContain('geo_country');
  });
});
