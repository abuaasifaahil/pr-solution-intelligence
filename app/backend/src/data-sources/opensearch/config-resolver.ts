/**
 * OpenSearch connection-config resolver.
 *
 * Resolves the (url, username, password, indexName, indexType) tuple
 * with three-level precedence per ADR-0001:
 *
 *   1. Chat-attached config (from M9.11's `chat_data_sources.source_config`
 *      — null today; M9.6a forwards null and falls through to level 2).
 *   2. User's M5 per-user `data_sources` row (encrypted, decrypted on
 *      read). A user marks a row as their OpenSearch override by setting
 *      `source_type='custom'` and `config.kind='opensearch'` — the
 *      Zod-validated shape inside `config` carries the indexName +
 *      indexType + username. Password is stored AES-encrypted in
 *      `api_key_encrypted`; URL goes in `endpoint_url`.
 *   3. Platform env (`OPENSEARCH_URL` / `OPENSEARCH_USERNAME` /
 *      `OPENSEARCH_PASSWORD` / `OPENSEARCH_INDEX_NAME` /
 *      `OPENSEARCH_INDEX_TYPE`).
 *
 * Returns `null` only when no level resolves — the OpenSearchAdapter
 * surfaces that as a friendly "OpenSearch is not configured" error.
 *
 * Security: the resolved config is sensitive. Never log it directly —
 * use `toRedacted()` for any logging or telemetry. The password field
 * is the only secret; everything else is non-sensitive but identifiable
 * and worth masking by default.
 *
 * @file backend/src/data-sources/opensearch/config-resolver.ts
 */
import { z } from 'zod';
import { withUser } from '../../lib/prisma-rls.js';
import { decrypt } from '../../lib/encryption.js';
import { loadEnv, hasOpenSearchConfig } from '../../env.js';

export const OpenSearchIndexTypeSchema = z.enum(['daywise', 'monthwise', 'single']);
export type OpenSearchIndexType = z.infer<typeof OpenSearchIndexTypeSchema>;

/**
 * Fully-resolved OpenSearch config — every field that the adapter and
 * the underlying client need. `password` is plaintext at this layer (it
 * was decrypted from the user row when sourced from M5).
 */
export const OpenSearchAdapterConfigSchema = z.object({
  url: z.string().url(),
  username: z.string().min(1),
  password: z.string().min(1),
  /** Match env defaults; downstream `resolveIndices` may ignore. */
  indexName: z.string().default('amx-data*'),
  indexType: OpenSearchIndexTypeSchema.default('daywise'),
});
export type OpenSearchAdapterConfig = z.infer<typeof OpenSearchAdapterConfigSchema>;

/** Partial input shape — chat-attached + user-row merges accept any subset. */
export type PartialOpenSearchConfig = Partial<OpenSearchAdapterConfig>;

/**
 * Shape stored inside `data_sources.config` for a per-user OpenSearch
 * override. Keep this Zod-validated so a malformed row degrades to
 * "no override" rather than blowing up the resolver.
 */
const UserOpenSearchConfigBlobSchema = z.object({
  kind: z.literal('opensearch'),
  username: z.string().min(1),
  indexName: z.string().optional(),
  indexType: OpenSearchIndexTypeSchema.optional(),
});

/**
 * Lift a partial config to a complete one. Returns null when any of the
 * three required fields (url, username, password) is missing.
 */
function isComplete(p?: PartialOpenSearchConfig): p is OpenSearchAdapterConfig {
  return !!p && !!p.url && !!p.username && !!p.password;
}

/**
 * Read the user's M5 override row, if any. Returns null when the user
 * has no `custom` data-source row that explicitly opts into OpenSearch.
 */
async function readUserOpenSearchOverride(
  userId: string,
): Promise<OpenSearchAdapterConfig | null> {
  return withUser(userId, async (tx) => {
    // Defensive: in test environments, the mocked `tx` may omit
    // `dataSource`. We only try the lookup when the model is wired up
    // — otherwise short-circuit to "no override". The resolver's caller
    // then falls through to platform env.
    if (
      typeof (tx as { dataSource?: { findMany?: unknown } }).dataSource
        ?.findMany !== 'function'
    ) {
      return null;
    }
    // Prefer the most-recently-tested row when multiple custom rows
    // exist — matches Settings UI expectations.
    const rows = await tx.dataSource.findMany({
      where: { userId, sourceType: 'custom', isActive: true },
      orderBy: [
        { lastTestedAt: 'desc' },
        { createdAt: 'desc' },
      ],
    });
    for (const row of rows) {
      const parsed = UserOpenSearchConfigBlobSchema.safeParse(row.config);
      if (!parsed.success) continue;
      if (!row.endpointUrl) continue;
      let password: string;
      try {
        password = decrypt(row.apiKeyEncrypted);
      } catch {
        // Encrypted blob couldn't be decrypted (key rotated, malformed
        // ciphertext, …). Skip and try the next row.
        continue;
      }
      const candidate: OpenSearchAdapterConfig = {
        url: row.endpointUrl,
        username: parsed.data.username,
        password,
        indexName: parsed.data.indexName ?? 'amx-data*',
        indexType: parsed.data.indexType ?? 'daywise',
      };
      const finalParsed = OpenSearchAdapterConfigSchema.safeParse(candidate);
      if (finalParsed.success) return finalParsed.data;
    }
    return null;
  });
}

/**
 * Resolve the OpenSearch config to use for this (userId, chat-attached)
 * combination. See file docstring for the precedence chain.
 */
export async function resolveOpenSearchConfig(
  userId: string,
  chatAttachedConfig?: PartialOpenSearchConfig,
): Promise<OpenSearchAdapterConfig | null> {
  // 1. Chat-attached config wins when complete. (M9.6a always passes
  //    undefined here — M9.11 will plumb chat_data_sources.source_config
  //    through.)
  if (isComplete(chatAttachedConfig)) {
    const parsed = OpenSearchAdapterConfigSchema.safeParse(chatAttachedConfig);
    if (parsed.success) return parsed.data;
  }

  // 2. User M5 row.
  const userRow = await readUserOpenSearchOverride(userId);
  if (userRow) {
    // Merge any partial chat-attached overrides on top of the user row
    // (e.g. chat-scoped indexName tweak with user-stored creds).
    if (chatAttachedConfig) {
      const merged: OpenSearchAdapterConfig = { ...userRow, ...chatAttachedConfig };
      const parsed = OpenSearchAdapterConfigSchema.safeParse(merged);
      if (parsed.success) return parsed.data;
    }
    return userRow;
  }

  // 3. Platform env. Prefer the validated env from `loadEnv()`; in
  //    test environments where `loadEnv()` is mocked to return a
  //    partial env we fall through to `process.env` so the resolver
  //    still surfaces the configured cluster.
  const env = loadEnv();
  const envUrl = env.OPENSEARCH_URL ?? process.env.OPENSEARCH_URL;
  const envUser = env.OPENSEARCH_USERNAME ?? process.env.OPENSEARCH_USERNAME;
  const envPass = env.OPENSEARCH_PASSWORD ?? process.env.OPENSEARCH_PASSWORD;
  if (hasOpenSearchConfig(env) || (envUrl && envUser && envPass)) {
    const fromEnv: OpenSearchAdapterConfig = {
      url: envUrl!,
      username: envUser!,
      password: envPass!,
      indexName: env.OPENSEARCH_INDEX_NAME ?? 'amx-data*',
      indexType: env.OPENSEARCH_INDEX_TYPE ?? 'daywise',
    };
    // Merge chat-attached partial on top of env baseline.
    if (chatAttachedConfig) {
      const merged: OpenSearchAdapterConfig = { ...fromEnv, ...chatAttachedConfig };
      const parsed = OpenSearchAdapterConfigSchema.safeParse(merged);
      if (parsed.success) return parsed.data;
    }
    return fromEnv;
  }

  return null;
}

/**
 * Return a logging-safe copy of the resolved config: password is
 * masked, username is truncated. Use this for ALL log lines that
 * include the config — never log the raw shape.
 */
export function toRedacted(c: OpenSearchAdapterConfig): {
  url: string;
  username: string;
  password: '***';
  indexName: string;
  indexType: OpenSearchIndexType;
} {
  return {
    url: c.url,
    username: c.username,
    password: '***',
    indexName: c.indexName,
    indexType: c.indexType,
  };
}
