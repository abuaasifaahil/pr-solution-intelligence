'use client';
import { apiFetch } from './api-client';

export type DataSourceType =
  | 'meltwater' | 'opoint' | 'webz' | 'twitter' | 'infovision' | 'custom';

export interface DataSource {
  id: string;
  userId: string;
  sourceType: DataSourceType;
  displayName: string;
  apiKeyEncrypted: '***encrypted***';
  endpointUrl: string | null;
  config: Record<string, unknown>;
  isActive: boolean;
  lastTestedAt: string | null;
  createdAt: string;
}

export interface DataSourceTestResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  message: string;
}

export async function listDataSources(): Promise<DataSource[]> {
  return apiFetch<{ dataSources: DataSource[] }>('/api/v1/data-sources')
    .then((d) => d.dataSources);
}

export async function createDataSource(input: {
  sourceType: DataSourceType;
  displayName: string;
  apiKey: string;
  endpointUrl?: string;
  /** Free-form bag — M9.9 uses this for the `{kind:'opensearch', ...}` blob. */
  config?: Record<string, unknown>;
}): Promise<DataSource> {
  return apiFetch<{ dataSource: DataSource }>('/api/v1/data-sources', {
    method: 'POST',
    body: JSON.stringify(input),
  }).then((d) => d.dataSource);
}

export async function updateDataSource(
  id: string,
  patch: {
    displayName?: string;
    apiKey?: string;
    endpointUrl?: string;
    isActive?: boolean;
    config?: Record<string, unknown>;
  },
): Promise<DataSource> {
  return apiFetch<{ dataSource: DataSource }>(`/api/v1/data-sources/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }).then((d) => d.dataSource);
}

export async function deleteDataSource(id: string): Promise<void> {
  await apiFetch(`/api/v1/data-sources/${id}`, { method: 'DELETE' });
}

export async function testDataSource(id: string): Promise<DataSourceTestResult> {
  return apiFetch<DataSourceTestResult>(`/api/v1/data-sources/${id}/test`, {
    method: 'POST',
  });
}

// ─── M9.9 OpenSearch per-user override ─────────────────────────────────
// Per the config-resolver chain (ADR-0001), a user "overrides" OpenSearch
// by storing a row in `data_sources` with sourceType='custom' and a
// config blob `{kind: 'opensearch', username, indexName?, indexType?}`.
// The URL goes in `endpointUrl` and the password is encrypted as the
// `apiKey`. These wrappers keep the wire shape consistent with the
// backend's `readUserOpenSearchOverride` reader so a UI save round-trips
// cleanly to the resolver.

export type OpenSearchIndexType = 'daywise' | 'monthwise' | 'single';

export interface OpenSearchOverrideConfig {
  kind: 'opensearch';
  username: string;
  indexName?: string;
  indexType?: OpenSearchIndexType;
}

export interface OpenSearchOverrideInput {
  displayName?: string;
  url: string;
  username: string;
  password: string;
  indexName?: string;
  indexType?: OpenSearchIndexType;
}

/**
 * Returns the currently-active OpenSearch override row for this user,
 * or null if they don't have one. We identify it as a `custom` row
 * whose `config.kind === 'opensearch'` — that matches the resolver in
 * `backend/src/data-sources/opensearch/config-resolver.ts`.
 */
export async function getOpenSearchOverride(): Promise<DataSource | null> {
  const rows = await listDataSources();
  const match = rows.find(
    (r) =>
      r.sourceType === 'custom' &&
      typeof r.config === 'object' &&
      r.config !== null &&
      (r.config as { kind?: unknown }).kind === 'opensearch',
  );
  return match ?? null;
}

/**
 * Create or update the per-user OpenSearch override. If a row already
 * exists, PATCH it; otherwise POST a new one. The backend re-encrypts
 * the password (AES-256-GCM) under `ENCRYPTION_KEY` per M5.
 */
export async function saveOpenSearchOverride(
  input: OpenSearchOverrideInput,
): Promise<DataSource> {
  const existing = await getOpenSearchOverride();
  const config: OpenSearchOverrideConfig = {
    kind: 'opensearch',
    username: input.username,
    ...(input.indexName ? { indexName: input.indexName } : {}),
    ...(input.indexType ? { indexType: input.indexType } : {}),
  };
  if (existing) {
    return updateDataSource(existing.id, {
      displayName: input.displayName ?? existing.displayName,
      apiKey: input.password,
      endpointUrl: input.url,
      config: config as unknown as Record<string, unknown>,
    });
  }
  return createDataSource({
    sourceType: 'custom',
    displayName: input.displayName ?? 'OpenSearch override',
    apiKey: input.password,
    endpointUrl: input.url,
    config: config as unknown as Record<string, unknown>,
  });
}

/**
 * Remove the user's OpenSearch override (returns true if one existed
 * and was deleted). UI calls this when the user clicks "Use org
 * default" to fall back to the platform env config.
 */
export async function deleteOpenSearchOverride(): Promise<boolean> {
  const existing = await getOpenSearchOverride();
  if (!existing) return false;
  await deleteDataSource(existing.id);
  return true;
}

// ─── MCP ───────────────────────────────────────────────────────────────

export type MCPStatus = 'active' | 'inactive' | 'error';

export interface MCPConnection {
  id: string;
  userId: string;
  sourceName: string;
  serverUrl: string;
  tokenEncrypted: '***encrypted***';
  status: MCPStatus;
  lastVerifiedAt: string | null;
  availableTools: unknown[];
  createdAt: string;
}

export interface MCPVerifyResult {
  status: MCPStatus;
  latencyMs: number;
  httpStatus?: number;
  message: string;
  availableTools: unknown[];
}

export async function listMCP(): Promise<MCPConnection[]> {
  return apiFetch<{ connections: MCPConnection[] }>('/api/v1/mcp')
    .then((d) => d.connections);
}
export async function createMCP(input: {
  sourceName: string; serverUrl: string; token: string;
}): Promise<MCPConnection> {
  return apiFetch<{ connection: MCPConnection }>('/api/v1/mcp', {
    method: 'POST', body: JSON.stringify(input),
  }).then((d) => d.connection);
}
export async function updateMCP(
  id: string, patch: { sourceName?: string; serverUrl?: string; token?: string },
): Promise<MCPConnection> {
  return apiFetch<{ connection: MCPConnection }>(`/api/v1/mcp/${id}`, {
    method: 'PATCH', body: JSON.stringify(patch),
  }).then((d) => d.connection);
}
export async function deleteMCP(id: string): Promise<void> {
  await apiFetch(`/api/v1/mcp/${id}`, { method: 'DELETE' });
}
export async function verifyMCP(id: string): Promise<MCPVerifyResult> {
  return apiFetch<MCPVerifyResult>(`/api/v1/mcp/${id}/verify`, { method: 'POST' });
}

// ─── Model config ──────────────────────────────────────────────────────

export type LLMProvider = 'claude' | 'gpt' | 'ollama' | 'perplexity';

export interface ModelConfig {
  id: string;
  userId: string;
  provider: LLMProvider;
  modelName: string;
  apiKeyEncrypted: '***encrypted***' | null;
  maxTokens: number;
  temperature: number;
  isDefault: boolean;
  createdAt: string;
}

export async function getModelConfig(): Promise<ModelConfig | null> {
  return apiFetch<{ config: ModelConfig | null }>('/api/v1/settings/model').then((d) => d.config);
}

export async function saveModelConfig(input: {
  provider: LLMProvider;
  modelName: string;
  apiKey?: string;
  maxTokens: number;
  temperature: number;
}): Promise<ModelConfig> {
  return apiFetch<{ config: ModelConfig }>('/api/v1/settings/model', {
    method: 'POST', body: JSON.stringify(input),
  }).then((d) => d.config);
}

// ─── Skills ────────────────────────────────────────────────────────────

export interface SkillView {
  skillId: string;
  name: string;
  description: string;
  type: string;
  isDefault: boolean;
  isEnabled: boolean;
}

export async function listSkills(): Promise<SkillView[]> {
  return apiFetch<{ skills: SkillView[] }>('/api/v1/settings/skills')
    .then((d) => d.skills);
}
export async function createSkill(input: {
  name: string; description: string; type: string;
}): Promise<SkillView> {
  return apiFetch<{ skill: SkillView }>('/api/v1/settings/skills', {
    method: 'POST', body: JSON.stringify(input),
  }).then((d) => d.skill);
}
export async function toggleSkill(skillId: string, isEnabled: boolean): Promise<SkillView> {
  return apiFetch<{ skill: SkillView }>(`/api/v1/settings/skills/${skillId}`, {
    method: 'PATCH', body: JSON.stringify({ isEnabled }),
  }).then((d) => d.skill);
}
