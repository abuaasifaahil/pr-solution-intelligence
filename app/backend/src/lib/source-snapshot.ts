/**
 * Source-snapshot helper — builds `AttachedSourceSnapshot[]` for a chat
 * by resolving its attached data sources, constructing adapters via
 * `createAdapter()`, and pulling a sample fetch (sampleLimit=25).
 *
 * Extracted from `services/intent-application.service.ts` in M9.7 so
 * BOTH the (still-flag-gated) sample-classifier supplement path AND the
 * new `GET /api/v1/chats/:id/probe` endpoint share one implementation.
 *
 * Today (M9.7): the chat has at most ONE source via `chat_params.dataSource`.
 * After M9.11: enumerate `chat_data_sources` rows here for true
 * multi-source. The interface STAYS the same — callers always receive
 * an array.
 *
 * @file backend/src/lib/source-snapshot.ts
 */
import { withUser } from './prisma-rls.js';
import { createAdapter } from '../data-sources/registry.js';
import { resolveOpenSearchConfig } from '../data-sources/opensearch/config-resolver.js';
import type { AttachedSourceSnapshot } from '../agents/probing-agent.js';
import type {
  FetchContext,
  NormalizedArticle,
} from '../data-sources/adapter.js';
import type { BooleanQueryStructured } from './boolean-query-engine.js';

/** Cap on sample size pulled from each adapter. Matches the ProbingAgent
 *  contract ("up to ~25 rows"). */
export const SAMPLE_LIMIT = 25;

/**
 * Build one `AttachedSourceSnapshot` per attached data source for the
 * chat. Today (pre-M9.11) there's at most ONE source per chat — encoded
 * in `chat_params.dataSource` + the optional upload. M9.11 will iterate
 * `chat_data_sources` rows instead.
 *
 * Returns an empty array when:
 *   - the chat has no `chat_params` row (chat doesn't exist for this user)
 *   - the resolved adapter can't produce a sample (csv_upload without
 *     an uploaded file, opensearch with no resolvable config)
 *
 * Errors thrown by the adapter (e.g. corrupt CSV, OpenSearch timeout)
 * propagate up — the caller decides whether to swallow them (the
 * supplement path does) or surface them (the probe endpoint does).
 */
export async function collectAdapterSamples(
  userId: string,
  chatId: string,
): Promise<AttachedSourceSnapshot[]> {
  const params = await withUser(userId, async (tx) =>
    tx.chatParams.findUnique({ where: { chatId } }),
  );
  if (!params) return [];

  // Synthetic source id — M9.11 will replace this with the row id from
  // chat_data_sources. The classifier uses it only as an opaque tag.
  const sourceId = `${chatId}:${params.dataSource}`;

  // Build an "empty" structured query — sampling doesn't need the real
  // boolean query and the adapters that read it (OS) accept a noop one.
  const structured: BooleanQueryStructured = {
    brand: '',
    brandFields: ['title'],
    competitors: [],
    competitorFields: ['content'],
    dateRange: null,
    language: 'en',
  };

  if (params.dataSource === 'csv_upload') {
    if (!params.uploadId) return [];
    const adapter = createAdapter({
      kind: 'csv_upload',
      config: { uploadId: params.uploadId },
    });
    const articles = await drainOneSampleBatch(adapter, {
      userId,
      chatId,
      config: { uploadId: params.uploadId },
      structured,
      mediaTypes: [],
      sampleLimit: SAMPLE_LIMIT,
    });
    return [
      {
        sourceId,
        kind: 'csv_upload',
        sampleArticles: articles,
        declaredCapabilities: adapter.declaredCapabilities(),
      },
    ];
  }

  if (params.dataSource === 'opensearch') {
    const osConfig = await resolveOpenSearchConfig(userId);
    if (!osConfig) return [];
    const adapter = createAdapter({ kind: 'opensearch', config: osConfig });
    const articles = await drainOneSampleBatch(adapter, {
      userId,
      chatId,
      config: osConfig,
      structured,
      mediaTypes: [],
      sampleLimit: SAMPLE_LIMIT,
    });
    return [
      {
        sourceId,
        kind: 'opensearch',
        sampleArticles: articles,
        declaredCapabilities: adapter.declaredCapabilities(),
      },
    ];
  }

  return [];
}

/**
 * Pull one sample batch out of an adapter's async iterable. Adapters in
 * sample mode yield a single batch then stop; we still drain defensively
 * in case a future adapter ignores the cap.
 */
async function drainOneSampleBatch(
  adapter: {
    fetch: (ctx: FetchContext) => AsyncIterable<{ articles: NormalizedArticle[] }>;
  },
  ctx: FetchContext,
): Promise<NormalizedArticle[]> {
  const out: NormalizedArticle[] = [];
  for await (const batch of adapter.fetch(ctx)) {
    out.push(...batch.articles);
    if (out.length >= (ctx.sampleLimit ?? Number.MAX_SAFE_INTEGER)) break;
  }
  return out.slice(0, ctx.sampleLimit ?? out.length);
}
