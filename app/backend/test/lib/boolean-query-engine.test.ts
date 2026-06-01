/**
 * M7.6 — boolean-query-engine pure-function tests.
 *
 * No DB, no LLM, no IO. Just inputs → output. Asserts the text shape, the
 * structured mirror, and a few escaping / defaulting corner cases.
 */
import { describe, it, expect } from 'vitest';
import { generateBooleanQuery } from '../../src/lib/boolean-query-engine.js';

describe('boolean-query-engine.generateBooleanQuery', () => {
  it('happy path — brand + 3 competitors + date range', () => {
    const out = generateBooleanQuery({
      brand: 'FreshSip',
      competitors: ['PepsiCo', 'Coca-Cola', 'Snapple'],
      dateStart: new Date('2026-05-01T00:00:00.000Z'),
      dateEnd: new Date('2026-05-20T00:00:00.000Z'),
    });

    expect(out.text).toContain('(title:"FreshSip" OR headline:"FreshSip" OR content:"FreshSip")');
    expect(out.text).toContain('content:"PepsiCo" OR description:"PepsiCo"');
    expect(out.text).toContain('content:"Coca-Cola" OR description:"Coca-Cola"');
    expect(out.text).toContain('date:[2026-05-01 TO 2026-05-20]');
    expect(out.text).toContain('language:"en"');
    expect(out.text.split(' AND ')).toHaveLength(4); // brand, comps, date, lang
  });

  it('no competitors → no competitor AND clause', () => {
    const out = generateBooleanQuery({
      brand: 'FreshSip',
      competitors: [],
      dateStart: new Date('2026-05-01T00:00:00.000Z'),
      dateEnd: new Date('2026-05-20T00:00:00.000Z'),
    });

    expect(out.text).not.toContain('description:');
    // brand + date + language
    expect(out.text.split(' AND ')).toHaveLength(3);
    expect(out.structured.competitors).toEqual([]);
  });

  it('competitors with whitespace-only entries are dropped', () => {
    const out = generateBooleanQuery({
      brand: 'FreshSip',
      competitors: ['PepsiCo', '   ', ''],
      dateStart: null,
      dateEnd: null,
    });
    expect(out.structured.competitors).toEqual(['PepsiCo']);
  });

  it('no dates → no date AND clause', () => {
    const out = generateBooleanQuery({
      brand: 'FreshSip',
      competitors: ['PepsiCo'],
      dateStart: null,
      dateEnd: null,
    });

    expect(out.text).not.toContain('date:[');
    expect(out.structured.dateRange).toBeNull();
  });

  it('partial dates (only start) → no date AND clause', () => {
    const out = generateBooleanQuery({
      brand: 'FreshSip',
      competitors: [],
      dateStart: new Date('2026-05-01T00:00:00.000Z'),
      dateEnd: null,
    });
    expect(out.text).not.toContain('date:[');
    expect(out.structured.dateRange).toBeNull();
  });

  it('brand with embedded double-quote → escaped', () => {
    const out = generateBooleanQuery({
      brand: 'Acme "Quoted" Co',
      competitors: [],
      dateStart: null,
      dateEnd: null,
    });
    expect(out.text).toContain('title:"Acme \\"Quoted\\" Co"');
    expect(out.structured.brand).toBe('Acme \\"Quoted\\" Co');
  });

  it('custom field overrides — brandFields + competitorFields', () => {
    const out = generateBooleanQuery({
      brand: 'FreshSip',
      competitors: ['PepsiCo'],
      dateStart: null,
      dateEnd: null,
      brandFields: ['title'],
      competitorFields: ['content'],
    });
    expect(out.text).toMatch(/^\(title:"FreshSip"\) AND \(content:"PepsiCo"\)/);
    expect(out.structured.brandFields).toEqual(['title']);
    expect(out.structured.competitorFields).toEqual(['content']);
  });

  it('language override is lowercased', () => {
    const out = generateBooleanQuery({
      brand: 'FreshSip',
      competitors: [],
      dateStart: null,
      dateEnd: null,
      language: 'EN-US',
    });
    expect(out.text).toContain('language:"en-us"');
    expect(out.structured.language).toBe('en-us');
  });

  it('structured mirror — fields and dateRange match text', () => {
    const out = generateBooleanQuery({
      brand: 'Acme',
      competitors: ['Beta', 'Gamma'],
      dateStart: new Date('2026-01-01T00:00:00.000Z'),
      dateEnd: new Date('2026-01-31T00:00:00.000Z'),
    });
    expect(out.structured).toEqual({
      brand: 'Acme',
      brandFields: ['title', 'headline', 'content'],
      competitors: ['Beta', 'Gamma'],
      competitorFields: ['content', 'description'],
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      language: 'en',
    });
  });

  it('throws when brand is empty or whitespace', () => {
    expect(() =>
      generateBooleanQuery({
        brand: '   ',
        competitors: [],
        dateStart: null,
        dateEnd: null,
      }),
    ).toThrow(/brand is required/);
  });
});
