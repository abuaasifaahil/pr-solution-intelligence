/**
 * M9.1.2 — MediaType enum + parser unit tests.
 *
 * Pure-function suite. Verifies CSV parsing tolerance for legacy labels
 * from the Python prod code, and exercises the `MEDIA_TYPE_INDICES` map
 * invariants downstream code depends on.
 */
import { describe, it, expect } from 'vitest';
import {
  parseMediaTypesFromCsv,
  MEDIA_TYPE_INDICES,
  ALL_MEDIA_TYPES,
  type MediaType,
} from '../../src/lib/media-types.js';

describe('parseMediaTypesFromCsv', () => {
  it('returns null for null', () => {
    expect(parseMediaTypesFromCsv(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseMediaTypesFromCsv('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseMediaTypesFromCsv('   ,  ,  ')).toBeNull();
  });

  it('parses a simple csv into MediaType[]', () => {
    const out = parseMediaTypesFromCsv('print,x_twitter');
    expect(out).not.toBeNull();
    expect(out).toHaveLength(2);
    expect(out).toContain<MediaType>('print');
    expect(out).toContain<MediaType>('x_twitter');
  });

  it('lowercases and trims tokens', () => {
    const out = parseMediaTypesFromCsv('  print , X_TWITTER ');
    expect(out).toHaveLength(2);
    expect(out).toContain<MediaType>('print');
    expect(out).toContain<MediaType>('x_twitter');
  });

  it('collapses legacy "x (twitter)", "twitter", and "x" aliases', () => {
    const out = parseMediaTypesFromCsv('x (twitter),twitter,x');
    expect(out).toEqual(['x_twitter']);
  });

  it('drops unknown tokens silently and keeps the rest', () => {
    const out = parseMediaTypesFromCsv('garbage,print,unknown');
    expect(out).toEqual(['print']);
  });

  it('dedupes repeated tokens', () => {
    const out = parseMediaTypesFromCsv('print,print,print');
    expect(out).toEqual(['print']);
  });

  it('returns null when every token is unknown', () => {
    expect(parseMediaTypesFromCsv('garbage,nope')).toBeNull();
  });
});

describe('MEDIA_TYPE_INDICES invariants', () => {
  it('online is intentionally empty (month-scoped — handled in indices.ts)', () => {
    expect(MEDIA_TYPE_INDICES.online).toEqual([]);
  });

  it('blogs / forums / reviews all map to amx-webz-social*', () => {
    expect(MEDIA_TYPE_INDICES.blogs).toEqual(['amx-webz-social*']);
    expect(MEDIA_TYPE_INDICES.forums).toEqual(['amx-webz-social*']);
    expect(MEDIA_TYPE_INDICES.reviews).toEqual(['amx-webz-social*']);
  });

  it('each of the 11 media types has an entry', () => {
    expect(ALL_MEDIA_TYPES).toHaveLength(11);
    for (const t of ALL_MEDIA_TYPES) {
      expect(MEDIA_TYPE_INDICES[t]).toBeDefined();
    }
  });

  it('per-channel patterns are wildcards', () => {
    expect(MEDIA_TYPE_INDICES.print).toEqual(['amx-print*']);
    expect(MEDIA_TYPE_INDICES.x_twitter).toEqual(['amx-twitter*']);
    expect(MEDIA_TYPE_INDICES.reddit).toEqual(['amx-reddit*']);
    expect(MEDIA_TYPE_INDICES.youtube).toEqual(['amx-youtube*']);
    expect(MEDIA_TYPE_INDICES.facebook).toEqual(['amx-facebook*']);
    expect(MEDIA_TYPE_INDICES.tiktok).toEqual(['amx-tiktok*']);
    expect(MEDIA_TYPE_INDICES.linkedin).toEqual(['amx-linkedin*']);
  });
});
