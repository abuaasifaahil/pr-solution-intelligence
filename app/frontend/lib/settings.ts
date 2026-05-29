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
}): Promise<DataSource> {
  return apiFetch<{ dataSource: DataSource }>('/api/v1/data-sources', {
    method: 'POST',
    body: JSON.stringify(input),
  }).then((d) => d.dataSource);
}

export async function updateDataSource(
  id: string,
  patch: { displayName?: string; apiKey?: string; endpointUrl?: string; isActive?: boolean },
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
