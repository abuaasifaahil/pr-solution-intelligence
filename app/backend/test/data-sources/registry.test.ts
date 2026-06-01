/**
 * M9.6a — Adapter registry unit tests.
 *
 * Verifies `createAdapter()`:
 *   - constructs the right concrete adapter for each implemented kind
 *   - returns a NEW instance per call (no singleton leak)
 *   - throws a clear error for unimplemented kinds
 *   - propagates per-adapter Zod validation errors
 */
import { describe, it, expect, vi } from 'vitest';

// The registry constructs adapters that touch env / Prisma — mock the
// minimum so the per-adapter Zod schema runs but no IO happens.
vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (_uid: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ dataSource: { findMany: vi.fn(async () => []) } }),
  ),
  asAdmin: vi.fn(),
}));

vi.mock('@prsi/shared/db', () => ({
  prisma: {
    $disconnect: vi.fn(),
  },
}));

const { createAdapter, listImplementedKinds } = await import(
  '../../src/data-sources/registry.js'
);
const { CsvUploadAdapter } = await import(
  '../../src/data-sources/csv-upload/csv-upload.adapter.js'
);
const { OpenSearchAdapter } = await import(
  '../../src/data-sources/opensearch/opensearch.adapter.js'
);

const VALID_OS_CONFIG = {
  url: 'https://os.example.com',
  username: 'u',
  password: 'p',
  indexName: 'amx-data*',
  indexType: 'daywise' as const,
};

const VALID_CSV_CONFIG = { uploadId: '00000000-0000-0000-0000-000000000001' };

describe('createAdapter', () => {
  it('csv_upload → CsvUploadAdapter instance', () => {
    const a = createAdapter({ kind: 'csv_upload', config: VALID_CSV_CONFIG });
    expect(a).toBeInstanceOf(CsvUploadAdapter);
    expect(a.kind).toBe('csv_upload');
  });

  it('opensearch → OpenSearchAdapter instance', () => {
    const a = createAdapter({ kind: 'opensearch', config: VALID_OS_CONFIG });
    expect(a).toBeInstanceOf(OpenSearchAdapter);
    expect(a.kind).toBe('opensearch');
  });

  it('returns a NEW instance per call (no singleton leak)', () => {
    const a1 = createAdapter({ kind: 'opensearch', config: VALID_OS_CONFIG });
    const a2 = createAdapter({ kind: 'opensearch', config: VALID_OS_CONFIG });
    expect(a1).not.toBe(a2);
  });

  it.each(['crawler', 'rss', 's3', 'slack_archive', 'imap', 'mcp_server', 'skill_provided'] as const)(
    '%s → throws "not implemented yet"',
    (kind) => {
      expect(() => createAdapter({ kind, config: {} })).toThrow(/not implemented yet/);
    },
  );

  it('invalid CSV config (no uploadId) → adapter rejects', () => {
    expect(() => createAdapter({ kind: 'csv_upload', config: {} })).toThrow(
      /CsvUploadAdapter config invalid/,
    );
  });

  it('invalid OpenSearch config (no url) → adapter rejects', () => {
    expect(() =>
      createAdapter({
        kind: 'opensearch',
        config: { username: 'u', password: 'p' },
      }),
    ).toThrow(/OpenSearchAdapter config invalid/);
  });
});

describe('listImplementedKinds', () => {
  it('returns the kinds the factory can construct', () => {
    const kinds = listImplementedKinds();
    expect(kinds).toEqual(['csv_upload', 'opensearch']);
  });
});
