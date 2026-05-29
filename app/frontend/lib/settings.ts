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
