/**
 * Adapter registry — per ADR-0001 + ADR-0002.
 *
 * Construction of concrete adapter instances lives here so agent /
 * orchestrator code stays generic. M9.6a registers two adapters
 * (`csv_upload`, `opensearch`). Future milestones add more.
 *
 * Each call returns a NEW instance so per-fetch state (retries, latency,
 * meta) never bleeds across chats. Adapters do their own Zod validation
 * of the supplied config during construction; an invalid config throws
 * a clear error here.
 *
 * @file backend/src/data-sources/registry.ts
 */
import type { DataSourceAdapter, DataSourceKind } from './adapter.js';
import { CsvUploadAdapter } from './csv-upload/csv-upload.adapter.js';
import { OpenSearchAdapter } from './opensearch/opensearch.adapter.js';

export interface AdapterFactoryInput {
  kind: DataSourceKind;
  /** Per-kind config blob — Zod-validated by each adapter on construction. */
  config: unknown;
}

/**
 * Returns a NEW adapter instance per call. Adapters carry per-fetch
 * state (retries, latency, meta) that must not leak across chats.
 *
 * Throws when a `kind` is listed in `DataSourceKind` but doesn't have a
 * concrete adapter yet (crawler / rss / s3 / slack_archive / imap /
 * mcp_server / skill_provided). Each future milestone adds a case here.
 */
export function createAdapter(input: AdapterFactoryInput): DataSourceAdapter {
  switch (input.kind) {
    case 'csv_upload':
      return new CsvUploadAdapter(input.config);
    case 'opensearch':
      return new OpenSearchAdapter(input.config);
    case 'crawler':
    case 'rss':
    case 's3':
    case 'slack_archive':
    case 'imap':
    case 'mcp_server':
    case 'skill_provided':
      throw new Error(
        `DataSource adapter not implemented yet: ${input.kind}. ` +
          `Per ADR-0001, register an adapter in data-sources/registry.ts.`,
      );
    default: {
      // Exhaustiveness guard — TypeScript flags any new kind that
      // forgets to land a case above.
      const exhaustive: never = input.kind;
      throw new Error(`Unknown DataSourceKind: ${String(exhaustive)}`);
    }
  }
}

/**
 * Kinds the registry can construct today. Used by M9.7+ APIs that
 * surface "what kinds can the user attach?" without trying every kind.
 */
export function listImplementedKinds(): DataSourceKind[] {
  return ['csv_upload', 'opensearch'];
}
